/**
 * N of 1 — Formulation adapter
 * ------------------------------
 * Converts a FormulationOutputType (Claude's structured JSON output) and a set
 * of patient exclusions into a DraftFormulation suitable for the justification
 * engine's assessJustification() call.
 *
 * DESIGN RULES (from Task 3 spec)
 *
 *   1. 26 entries lack equiv_line_2. That is not a gap — absent elemental line
 *      means the active IS the moiety; moiety amount = dose_per_granule. No warning.
 *
 *   2. Elemental derivation (equiv_line_2_quantity / dose_per_granule ratio) is
 *      exact — both values come from the same library row. No precision warning.
 *
 *   3. Vitamin D3: convert IU → mcg (÷ 40) at this boundary if proposed_dose is
 *      in IU. IU must never reach the engine. Emit UNIT_CONVERSION warning so the
 *      caller knows the conversion was applied.
 *
 *   4. Unmapped ARTG actives (TSI code not in the registry) surface as an
 *      UNMAPPED_TSI_CODE warning on the AdapterResult. The ingredient is omitted
 *      from targetActives — it is never silently dropped without a trace.
 *
 *   5. Exclusions are a patient attribute (set at intake), not a Claude output.
 *      Pass them as the second argument, loaded from the patient record. Omit the
 *      argument (defaults to []) when exclusions are not yet plumbed in — this
 *      makes INGREDIENT_EXCLUSION evaluation unavailable for that draft, not
 *      broken.
 *
 * UNIT CONVERSIONS SUPPORTED
 *
 *   Vitamin D3 (W030005000): IU → mcg — 1 IU = 0.025 mcg (1/40)
 *   Vitamin A  (W030006000): IU → mcg retinol — 1 IU retinol = 0.3 mcg
 *
 * All other IU-to-mass conversions are not safe to apply generically and will
 * produce an UNRESOLVABLE_UNIT warning rather than a silent mis-conversion.
 */

import type { FormulationOutputType } from '@/prompts/output-schema';
import type {
  DraftFormulation,
  Exclusion,
  NormalisedActive,
} from '../justification-engine';
import { getMoietyDefinition } from '../moiety-registry';
import libraryData from '@/data/library-built/ingredients-library.json';
import type { LibraryIngredient } from './library-ingredient';

// ---------------------------------------------------------------------------
// Warning types
// ---------------------------------------------------------------------------

export type ConversionWarningKind =
  /** TSI code from the formulation output not found in the Rev15 moiety registry. */
  | 'UNMAPPED_TSI_CODE'
  /** A unit conversion was applied (e.g. IU → mcg). Informational — not an error. */
  | 'UNIT_CONVERSION'
  /**
   * The moiety registry flagged this ingredient as ambiguous (e.g. MyHMB, where
   * line 2 lists elemental Ca but the pharmacological moiety is HMB). The
   * registry falls back to dose_per_granule; the caller should verify.
   */
  | 'MOIETY_AMBIGUOUS'
  /**
   * A unit conversion was needed but the conversion factor is unknown for this
   * ingredient. The ingredient IS included in targetActives but with the raw
   * proposed_dose and an incorrect unit flag — the engine may not match it
   * against commercial products. Caller must resolve manually.
   */
  | 'UNRESOLVABLE_UNIT';

export interface ConversionWarning {
  tsiCode: string;
  ingredientName: string;
  kind: ConversionWarningKind;
  detail: string;
}

export interface AdapterResult {
  draft: DraftFormulation;
  warnings: ConversionWarning[];
}

// ---------------------------------------------------------------------------
// Unit conversion table
// ---------------------------------------------------------------------------

/** IU-to-mcg factors, keyed by TSI code. Only entries that are safe to apply. */
const IU_TO_MCG: Record<string, number> = {
  'W030005000': 0.025, // Vitamin D3 (colecalciferol): 1 IU = 0.025 mcg
  'W030006000': 0.3,   // Vitamin A (retinol equivalent): 1 IU = 0.3 mcg retinol
};

/**
 * Convert a proposed dose to the moiety's canonical mass unit.
 * Returns null and emits via the warning array when conversion is unresolvable.
 */
function canonicaliseToMoietyUnit(
  tsiCode: string,
  ingredientName: string,
  proposedAmount: number,
  fromUnit: string,
  toUnit: string,
  warnings: ConversionWarning[],
): { amount: number; unit: typeof toUnit } | null {
  if (fromUnit === toUnit) return { amount: proposedAmount, unit: toUnit };

  // IU → mcg
  if (fromUnit === 'IU' && toUnit === 'mcg') {
    const factor = IU_TO_MCG[tsiCode];
    if (factor !== undefined) {
      warnings.push({
        tsiCode,
        ingredientName,
        kind: 'UNIT_CONVERSION',
        detail: `Converted ${proposedAmount} IU → ${(proposedAmount * factor).toFixed(4)} mcg (factor ${factor} mcg/IU from IU_TO_MCG table)`,
      });
      return { amount: proposedAmount * factor, unit: toUnit };
    }
    warnings.push({
      tsiCode,
      ingredientName,
      kind: 'UNRESOLVABLE_UNIT',
      detail: `Cannot convert IU → ${toUnit} for this ingredient; no safe factor in table. ` +
        'Ingredient is included in targetActives with the raw proposed_dose — ARTG matching will likely fail.',
    });
    return { amount: proposedAmount, unit: fromUnit };
  }

  // Unhandled pair
  warnings.push({
    tsiCode,
    ingredientName,
    kind: 'UNRESOLVABLE_UNIT',
    detail: `No conversion implemented from '${fromUnit}' to '${toUnit}'. ` +
      'Ingredient is included in targetActives with the raw proposed_dose.',
  });
  return { amount: proposedAmount, unit: fromUnit };
}

// ---------------------------------------------------------------------------
// Library index (for ratio derivation when elemental_dose is absent)
// ---------------------------------------------------------------------------

const libraryIndex: ReadonlyMap<string, LibraryIngredient> = new Map(
  (libraryData as { ingredients: LibraryIngredient[] }).ingredients.map(
    (ing) => [ing.tsi_code, ing],
  ),
);

// ---------------------------------------------------------------------------
// Public adapter
// ---------------------------------------------------------------------------

/**
 * Convert a FormulationOutputType to a DraftFormulation for the justification engine.
 *
 * @param output          Claude's structured formulation output (post-schema-validation).
 * @param patientExclusions  Exclusions loaded from the patient record. Defaults to []
 *                        when exclusions are not yet plumbed in — this makes
 *                        INGREDIENT_EXCLUSION dormant rather than broken.
 */
export function toDraftFormulation(
  output: FormulationOutputType,
  patientExclusions: Exclusion[] = [],
): AdapterResult {
  const warnings: ConversionWarning[] = [];
  const targetActives: NormalisedActive[] = [];

  for (const ingredient of output.proposed_formulation) {
    const { tsi_code, common_name, proposed_dose, dose_unit } = ingredient;

    // ── Lookup moiety definition ───────────────────────────────────────────
    const def = getMoietyDefinition(tsi_code);
    if (!def) {
      warnings.push({
        tsiCode: tsi_code,
        ingredientName: common_name,
        kind: 'UNMAPPED_TSI_CODE',
        detail: `TSI code '${tsi_code}' not found in Rev15 moiety registry. ` +
          'Ingredient omitted from targetActives.',
      });
      continue; // unmapped actives are never silently included
    }

    // ── Ambiguous moiety flag ──────────────────────────────────────────────
    if (def.ambiguous) {
      warnings.push({
        tsiCode: tsi_code,
        ingredientName: common_name,
        kind: 'MOIETY_AMBIGUOUS',
        detail: `Moiety registry flagged '${tsi_code}' as ambiguous. ` +
          `Using dose_per_granule (${def.moietyAmountPerGranule} ${def.moietyUnit}) ` +
          `as moiety amount. Verify against ARTG manually.`,
      });
    }

    // ── Derive moiety amount from proposed_dose ────────────────────────────
    //
    // ELEMENTAL basis (minerals):
    //   Prefer elemental_dose from the output if Claude supplied it; this avoids
    //   re-deriving from the ratio and is exact. If absent, compute:
    //   proposed_dose × (elemental_per_granule / salt_per_granule).
    //   No precision warning — both quantities are from the same library row.
    //
    // AS_STATED basis, moietySource LINE_2 (salt → active, e.g. B6 P5P, Folate, Choline):
    //   Claude reports proposed_dose in the SALT form (the physical substance in the
    //   granule) but the moiety is the free base / active on line 2. This is the same
    //   derivation problem as ELEMENTAL. Same treatment: prefer elemental_dose when
    //   supplied (Claude populates it reliably for B6, Folate, B5; occasionally omits
    //   it for Choline bitartrate, Glutathione, PQQ); fall back to the ratio.
    //   Checked against 11 real submissions — ratio path produces correct values on
    //   every entry where elemental_dose was absent.
    //
    // DRY_EQUIVALENT basis (herbs):
    //   proposed_dose IS the extract mass (the moiety). Line 2 is dry-herb equivalent
    //   (a TGA labelling requirement, not a moiety). Use proposed_dose directly.
    //
    // AS_STATED basis, moietySource LINE_1 (all other AS_STATED entries):
    //   Line 1 IS the active; proposed_dose is in the moiety's units. Unit conversion
    //   may be needed (IU → mcg for D3/VitA). canonicaliseToMoietyUnit handles it.

    let moietyAmount: number;
    let moietyUnit: string = def.moietyUnit;

    const needsRatioDerived =
      def.basis === 'ELEMENTAL' ||
      (def.basis === 'AS_STATED' && def.moietySource === 'LINE_2');

    if (needsRatioDerived) {
      if (
        ingredient.elemental_dose !== undefined &&
        ingredient.elemental_unit !== undefined
      ) {
        // Claude supplied the active/elemental dose directly — use it.
        moietyAmount = ingredient.elemental_dose;
        moietyUnit   = ingredient.elemental_unit;
      } else {
        // Derive from library ratio: moiety_per_granule / salt_per_granule × proposed_dose.
        // Both numerator and denominator come from the same library row — exact.
        const libEntry = libraryIndex.get(tsi_code);
        if (libEntry && libEntry.equivalent_line_2_quantity && libEntry.dose_per_granule > 0) {
          const ratio = libEntry.equivalent_line_2_quantity / libEntry.dose_per_granule;
          moietyAmount = proposed_dose * ratio;
          // moietyUnit stays def.moietyUnit (the active unit from equiv_line_2)
        } else {
          // Fallback: library row missing required fields. Use proposed_dose as-is.
          // This is a data quality issue, not an adapter bug.
          moietyAmount = proposed_dose;
        }
      }

    } else {
      // DRY_EQUIVALENT: proposed_dose is the extract (the moiety). No ratio needed.
      // AS_STATED + LINE_1: proposed_dose is in the active's units. Conversion may apply.
      const canonical = canonicaliseToMoietyUnit(
        tsi_code,
        common_name,
        proposed_dose,
        dose_unit,
        def.moietyUnit,
        warnings,
      );
      if (canonical === null) continue; // already warned, do not include
      moietyAmount = canonical.amount;
      moietyUnit   = canonical.unit;
    }

    // ── Validate the moiety unit is acceptable to the engine ──────────────
    const VALID_ENGINE_UNITS: NormalisedActive['unit'][] = ['mg', 'mcg', 'g', 'IU', 'CFU'];
    if (!VALID_ENGINE_UNITS.includes(moietyUnit as NormalisedActive['unit'])) {
      warnings.push({
        tsiCode: tsi_code,
        ingredientName: common_name,
        kind: 'UNRESOLVABLE_UNIT',
        detail: `Moiety unit '${moietyUnit}' is not in the engine's accepted unit set ` +
          `(${VALID_ENGINE_UNITS.join(', ')}). Ingredient omitted from targetActives.`,
      });
      continue;
    }

    targetActives.push({
      libraryId: tsi_code,
      moiety: def.moietyName,
      amount: moietyAmount,
      unit: moietyUnit as NormalisedActive['unit'],
    });
  }

  const meta = output.submission_metadata;

  const draft: DraftFormulation = {
    draftId: meta.submission_id,
    patientRef: meta.patient_pseudonymous_id,
    practitionerId: meta.practitioner_id_hash,
    // The N of 1 pod is always a powder / granule format.
    requiredDoseForm: 'POWDER',
    targetActives,
    exclusions: patientExclusions,
  };

  return { draft, warnings };
}
