/**
 * N of 1 — Moiety registry
 * -------------------------
 * Maps every Rev15 library ingredient (by TSI code) to its canonical active
 * moiety: the chemical entity and amount-per-granule that the justification
 * engine uses for ARTG comparison.
 *
 * WHY THIS EXISTS
 * The library stores two (sometimes three) chemical representations per
 * ingredient. Which representation is the active moiety depends on the
 * ingredient category:
 *
 *   Mineral (15 entries)
 *     Line 1 = salt (physical granule content)
 *     Line 2 = elemental equivalent ← MOIETY (what ARTG products list)
 *     MoietyBasis: ELEMENTAL
 *
 *   Herb (51 entries)
 *     Line 1 = extract (the granule content) ← MOIETY
 *     Line 2 = dry herb equivalent (TGA labelling requirement, not a moiety)
 *     Line 3 (if present) = standardised marker (available via .marker field)
 *     MoietyBasis: DRY_EQUIVALENT  ← name reflects what line 2 holds, not the moiety
 *
 *   All others (41 entries)
 *     Line 2 present, mass unit, dose > equiv_line_2:
 *       Line 1 is the salt; line 2 is the free base / active ← MOIETY
 *     Line 2 present, mass unit, dose < equiv_line_2:
 *       Line 1 IS the active; line 2 is a heavier commercial salt form ← MOIETY
 *     Line 2 present, non-mass unit (IU, PU, mcg RE):
 *       Line 1 is the primary form; line 2 is an alternate-unit expression
 *       Moiety = line 1 at its primary unit. IU must not reach the engine.
 *     No equiv_line_2 (26 entries):
 *       Moiety = line 1 (dose_per_granule is the active directly)
 *     MoietyBasis: AS_STATED
 *
 * AMBIGUOUS CASE
 * W140006000 MyHMB (HMB): category Synthetic, line 2 = "equivalent calcium (Ca)".
 * The pharmacological moiety is HMB, not calcium. This entry matches the
 * mineral line-2 pattern but the category is wrong; a MOIETY_AMBIGUOUS flag is
 * emitted by the adapter when this TSI code is used. The registry records
 * dose_per_granule as the moiety amount (the HMB-Ca salt mass).
 *
 * ARTG ALIASES
 * artgAliases is sparse: populated later from the ARTG export. Until then,
 * the commercial-product matching in the engine relies on the practitioner or
 * the ARTG ingest worker supplying moiety names that match this registry.
 */

import type { LibraryIngredient } from './adapters/library-ingredient';
import libraryData from '@/data/library-built/ingredients-library.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * How the moiety amount is derived from the library row.
 * The name reflects the role of line 2, not the moiety itself.
 */
export type MoietyBasis =
  | 'ELEMENTAL'      // Mineral: moiety is line-2 elemental equivalent
  | 'DRY_EQUIVALENT' // Herb: line 2 is dry-herb (TGA); moiety is line-1 extract
  | 'AS_STATED'      // Others: moiety is whichever line holds the active
  | 'MARKER';        // Standardised-marker alternative (line-3 constituent)

/** Which line of label_expression the moiety amount comes from. */
export type MoietySource = 'LINE_1' | 'LINE_2' | 'LINE_3';

export interface MoietyMarker {
  /** Standardised constituent name, e.g. "ginsenosides". */
  name: string;
  amountPerGranule: number;
  unit: string;
}

export interface MoietyDefinition {
  tsiCode: string;
  /** Canonical moiety name for cross-product matching against ARTG entries. */
  moietyName: string;
  basis: MoietyBasis;
  /** Which label_expression line the moiety amount was read from. */
  moietySource: MoietySource;
  /** Active moiety amount per granule (after conversion if required). */
  moietyAmountPerGranule: number;
  /** Unit for moietyAmountPerGranule. Never IU/PU/mcg RE — always a mass unit. */
  moietyUnit: string;
  /**
   * For standardised herbal extracts: the line-3 marker constituent.
   * Absent for non-standardised herbals and all non-herbal entries.
   */
  marker?: MoietyMarker;
  /**
   * Alternative moiety names used in ARTG product listings.
   * Sparse until the ARTG export is ingested.
   */
  artgAliases: string[];
  /**
   * True when the moiety derivation is ambiguous or unusual.
   * The formulation adapter emits a ConversionWarning for flagged entries.
   * Currently set only for W140006000 (MyHMB / HMB), where line 2 is
   * elemental calcium but the pharmacological moiety is HMB.
   */
  ambiguous: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Non-mass units that appear in equiv_line_2. */
const NON_MASS_EQUIV2_UNITS = new Set(['IU', 'PU', 'mcg RE']);

/** Pattern matching "equivalent <element> (<symbol>)" — the mineral label form. */
const MINERAL_EQUIV_RE = /^equivalent\s+(\w+)\s+\([A-Z][a-z]?\)\s*$/i;

function labelLine(ingredient: LibraryIngredient, lineIndex: number): string {
  return (ingredient.label_expression ?? '').split('\n')[lineIndex]?.trim() ?? '';
}

/**
 * Strip the "equivalent " prefix from a label line, capitalize the first letter,
 * and return the remaining text.  Used to build moiety names from line 2.
 */
function stripEquivalent(line: string): string {
  const stripped = line.replace(/^equivalent\s+/i, '').trim();
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

// ---------------------------------------------------------------------------
// Registry builder
// ---------------------------------------------------------------------------

function buildRegistry(): Map<string, MoietyDefinition> {
  const map = new Map<string, MoietyDefinition>();

  for (const raw of (libraryData as { ingredients: LibraryIngredient[] }).ingredients) {
    const ing = raw as LibraryIngredient;
    const line2 = labelLine(ing, 1);
    const hasEquiv2 = ing.equivalent_line_2_quantity !== undefined;
    const equiv2IsNonMass = hasEquiv2 && NON_MASS_EQUIV2_UNITS.has(ing.equivalent_line_2_unit ?? '');
    const equiv2IsMineralLike = hasEquiv2 && MINERAL_EQUIV_RE.test(line2);

    let def: MoietyDefinition;

    // ── Mineral ────────────────────────────────────────────────────────────
    if (ing.category === 'Mineral') {
      const elementMatch = line2.match(/^equivalent\s+(\w+)/i);
      const element = elementMatch ? elementMatch[1] : ing.common_name;
      const moietyName =
        element.charAt(0).toUpperCase() + element.slice(1).toLowerCase() + ' (elemental)';

      def = {
        tsiCode: ing.tsi_code,
        moietyName,
        basis: 'ELEMENTAL',
        moietySource: 'LINE_2',
        moietyAmountPerGranule: ing.equivalent_line_2_quantity!,
        moietyUnit: ing.equivalent_line_2_unit!,
        artgAliases: [],
        ambiguous: false,
      };

    // ── Herb ───────────────────────────────────────────────────────────────
    } else if (ing.category === 'Herb') {
      const marker: MoietyMarker | undefined =
        ing.equivalent_line_3_quantity !== undefined
          ? {
              name: stripEquivalent(labelLine(ing, 2)),
              amountPerGranule: ing.equivalent_line_3_quantity,
              unit: ing.equivalent_line_3_unit ?? ing.dose_per_granule_unit,
            }
          : undefined;

      def = {
        tsiCode: ing.tsi_code,
        moietyName: ing.common_name,
        basis: 'DRY_EQUIVALENT',
        moietySource: 'LINE_1',
        moietyAmountPerGranule: ing.dose_per_granule,
        moietyUnit: ing.dose_per_granule_unit,
        marker,
        artgAliases: [],
        ambiguous: false,
      };

    // ── All others ─────────────────────────────────────────────────────────
    } else {

      // No equiv_line_2: the active IS the dose_per_granule substance.
      if (!hasEquiv2) {
        def = {
          tsiCode: ing.tsi_code,
          moietyName: ing.common_name,
          basis: 'AS_STATED',
          moietySource: 'LINE_1',
          moietyAmountPerGranule: ing.dose_per_granule,
          moietyUnit: ing.dose_per_granule_unit,
          artgAliases: [],
          ambiguous: false,
        };

      // Non-mass equiv_line_2 (IU, PU, mcg RE): line 1 is the canonical form.
      // IU/PU representation is for labelling only; the engine works in mass units.
      } else if (equiv2IsNonMass) {
        def = {
          tsiCode: ing.tsi_code,
          moietyName: ing.common_name,
          basis: 'AS_STATED',
          moietySource: 'LINE_1',
          moietyAmountPerGranule: ing.dose_per_granule,
          moietyUnit: ing.dose_per_granule_unit,
          artgAliases: [],
          ambiguous: false,
        };

      // Mineral-like equiv_line_2 (element symbol in parens) but wrong category.
      // Currently: W140006000 MyHMB (the equiv is elemental Ca, not HMB).
      // Record the dose_per_granule (HMB-Ca salt) as the moiety amount and flag.
      } else if (equiv2IsMineralLike) {
        def = {
          tsiCode: ing.tsi_code,
          moietyName: ing.common_name,
          basis: 'AS_STATED',
          moietySource: 'LINE_1',
          moietyAmountPerGranule: ing.dose_per_granule,
          moietyUnit: ing.dose_per_granule_unit,
          artgAliases: [],
          ambiguous: true,
        };

      // Mass equiv_line_2 in the same mass-unit class:
      //   dose_per_granule > equiv_line_2_quantity → line 1 is salt, line 2 is active
      //   dose_per_granule < equiv_line_2_quantity → line 1 is active, line 2 is salt
      // Comparison is safe because dose_per_granule_unit and equiv_line_2_unit
      // are the same mass class for all entries in Rev15 that reach this branch.
      } else {
        const doseIsSalt = ing.dose_per_granule > ing.equivalent_line_2_quantity!;

        if (doseIsSalt) {
          // Line 2 is the free base / active moiety.
          def = {
            tsiCode: ing.tsi_code,
            moietyName: stripEquivalent(line2),
            basis: 'AS_STATED',
            moietySource: 'LINE_2',
            moietyAmountPerGranule: ing.equivalent_line_2_quantity!,
            moietyUnit: ing.equivalent_line_2_unit!,
            artgAliases: [],
            ambiguous: false,
          };
        } else {
          // Line 1 is the active; line 2 is the commercial salt form.
          def = {
            tsiCode: ing.tsi_code,
            moietyName: ing.common_name,
            basis: 'AS_STATED',
            moietySource: 'LINE_1',
            moietyAmountPerGranule: ing.dose_per_granule,
            moietyUnit: ing.dose_per_granule_unit,
            artgAliases: [],
            ambiguous: false,
          };
        }
      }
    }

    map.set(ing.tsi_code, def);
  }

  return map;
}

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

/** Map from TSI code → MoietyDefinition, built once at module load time. */
export const moietyRegistry: ReadonlyMap<string, MoietyDefinition> = buildRegistry();

/** Convenience accessor. Returns undefined for unknown TSI codes. */
export function getMoietyDefinition(tsiCode: string): MoietyDefinition | undefined {
  return moietyRegistry.get(tsiCode);
}
