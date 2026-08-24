/**
 * N of 1 — Product Translation Engine
 * ------------------------------------
 * Takes the ARTG-listed products a practitioner currently uses and produces an
 * equivalent pod formulation from the Rev15 library.
 *
 * This is the practitioner-onboarding path, distinct from the pathology-driven
 * formulation path. Input is a set of commercial products and their daily unit
 * counts; output is a granule schedule, a substitution report, and a list of
 * actives that must be sourced separately.
 *
 * Reuses the moiety registry, ARTG candidate data and normalised actives built
 * for the justification engine. The comparison machinery is identical; only the
 * terminal step differs.
 */

import type { MoietyId, MoietyRegistry } from './moiety';
import type { CommercialMedicine, NormalisedActive } from './justification-engine';
import {
  assessJustification,
  DEFAULT_CONFIG,
  type DraftFormulation,
  type JustificationAssessment,
  type EngineConfig,
  type PatientDeliveryProfile,
  type DoseForm,
} from './justification-engine';
import type { ClassSubstituteSpec } from './class-substitute-map';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface SelectedProduct {
  product: CommercialMedicine;
  /** Daily dosage units the practitioner currently prescribes. */
  unitsPerDay: number;
}

/** Rev15 fields needed to translate a moiety into granules. */
export interface LibraryGranuleSpec {
  tsiCode: string;
  moietyId: MoietyId;
  displayName: string;
  /** Dose of the moiety delivered per 3mm mini-tablet. */
  dosePerGranule: number;
  unit: 'mg' | 'mcg';
  /** Upper daily dose the library permits for this ingredient, where defined. */
  maxDailyDose: number | null;
}

export interface TranslationConfig {
  /** Total mini-tablets a single pod holds. */
  podCapacity: number;
  /**
   * Per-active granule ceiling above which the active is routed to
   * purchase-separately rather than consuming most of the pod.
   */
  maxGranulesPerActive: number;
  /** Units that cannot be delivered in granule form at all. */
  nonGranulableUnits: string[];
}

export const DEFAULT_TRANSLATION_CONFIG: TranslationConfig = {
  podCapacity: 720,
  maxGranulesPerActive: 240,
  nonGranulableUnits: ['CFU'],
};

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface AggregatedTarget {
  moietyId: MoietyId;
  displayName: string;
  totalDose: number;
  unit: string;
  /** Every product contributing to this moiety, with its share. */
  contributions: Array<{
    artgId: string;
    productName: string;
    unitsPerDay: number;
    dosePerUnit: number;
    subtotal: number;
  }>;
  /** True where more than one selected product contributes to this moiety. */
  stacked: boolean;
}

/**
 * Sums each moiety across all selected products. Overlap is the common case —
 * a multivitamin, a B-complex and a mineral product will all contribute B6 —
 * and the aggregate is frequently higher than the practitioner realises,
 * because no single label shows it.
 */
export function aggregateTargets(
  selected: SelectedProduct[],
  registry: MoietyRegistry
): AggregatedTarget[] {
  const byMoiety = new Map<string, AggregatedTarget>();

  for (const { product, unitsPerDay } of selected) {
    for (const active of product.activesPerUnit) {
      const moietyId = active.libraryId
        ? (active.libraryId as MoietyId)
        : registry.fromArtg(active.moiety);
      if (!moietyId) continue; // unresolved actives are reported separately

      const subtotal = active.amount * unitsPerDay;
      const existing = byMoiety.get(moietyId);

      if (existing) {
        existing.totalDose += subtotal;
        existing.contributions.push({
          artgId: product.artgId,
          productName: product.productName,
          unitsPerDay,
          dosePerUnit: active.amount,
          subtotal,
        });
        existing.stacked = true;
      } else {
        byMoiety.set(moietyId, {
          moietyId,
          displayName: registry.get(moietyId).canonicalName,
          totalDose: subtotal,
          unit: active.unit,
          contributions: [
            {
              artgId: product.artgId,
              productName: product.productName,
              unitsPerDay,
              dosePerUnit: active.amount,
              subtotal,
            },
          ],
          stacked: false,
        });
      }
    }
  }

  return [...byMoiety.values()].sort((a, b) => b.totalDose - a.totalDose);
}

// ---------------------------------------------------------------------------
// Substitution tiers
// ---------------------------------------------------------------------------

export type SubstitutionTier =
  /** Same moiety available in the library. Direct translation. */
  | 'DIRECT'
  /** Same moiety, different salt or ester in the library. Dose recalculated on
   *  the active-moiety basis; the delivered moiety amount is unchanged. */
  | 'FORM_SUBSTITUTION'
  /** No library entry for this moiety; a same-class alternative is available.
   *  Never applied automatically — requires practitioner confirmation. */
  | 'CLASS_SUBSTITUTION'
  /** Deliverable in principle but not in granule form — route to separate purchase. */
  | 'PURCHASE_SEPARATELY'
  /** No library equivalent and no acceptable substitute. */
  | 'UNAVAILABLE';

export interface TranslatedActive {
  target: AggregatedTarget;
  tier: SubstitutionTier;
  /** Library ingredient selected, where one was. */
  library: LibraryGranuleSpec | null;
  granules: number | null;
  /** Populated for CLASS_SUBSTITUTION — must be confirmed before use. */
  proposedAlternatives?: LibraryGranuleSpec[];
  /** Why this active landed where it did. Shown to the practitioner. */
  note: string;
  /** True where the aggregated dose exceeds the library's permitted daily maximum. */
  exceedsLibraryMax: boolean;
}

function granulesFor(target: AggregatedTarget, spec: LibraryGranuleSpec): number {
  if (spec.dosePerGranule <= 0) return 0;
  return Math.ceil(target.totalDose / spec.dosePerGranule);
}

export function translateActive(
  target: AggregatedTarget,
  library: Map<string, LibraryGranuleSpec>,
  classAlternatives: Map<string, LibraryGranuleSpec[]>,
  config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG
): TranslatedActive {
  if (config.nonGranulableUnits.includes(target.unit)) {
    return {
      target,
      tier: 'PURCHASE_SEPARATELY',
      library: null,
      granules: null,
      note: `${target.unit} quantities cannot be delivered in granule form.`,
      exceedsLibraryMax: false,
    };
  }

  const direct = library.get(target.moietyId);

  if (direct) {
    const granules = granulesFor(target, direct);
    const exceedsLibraryMax =
      direct.maxDailyDose !== null && target.totalDose > direct.maxDailyDose;

    if (granules > config.maxGranulesPerActive) {
      return {
        target,
        tier: 'PURCHASE_SEPARATELY',
        library: direct,
        granules,
        note:
          `Requires ${granules} granules (ceiling ${config.maxGranulesPerActive}). ` +
          `Dose is too large to granulate economically — source separately.`,
        exceedsLibraryMax,
      };
    }

    return {
      target,
      tier: 'DIRECT',
      library: direct,
      granules,
      note: `${granules} granules at ${direct.dosePerGranule}${direct.unit} each.`,
      exceedsLibraryMax,
    };
  }

  const alternatives = classAlternatives.get(target.moietyId) ?? [];
  if (alternatives.length > 0) {
    return {
      target,
      tier: 'CLASS_SUBSTITUTION',
      library: null,
      granules: null,
      proposedAlternatives: alternatives,
      note:
        `No library entry for ${target.displayName}. ` +
        `${alternatives.length} same-class alternative(s) proposed — requires confirmation.`,
      exceedsLibraryMax: false,
    };
  }

  return {
    target,
    tier: 'UNAVAILABLE',
    library: null,
    granules: null,
    note: `No library equivalent or acceptable substitute for ${target.displayName}.`,
    exceedsLibraryMax: false,
  };
}

// ---------------------------------------------------------------------------
// Pod fill
// ---------------------------------------------------------------------------

export interface PodFillResult {
  totalGranules: number;
  capacity: number;
  utilisationFraction: number;
  fits: boolean;
  /** Where it does not fit, the actives ranked by granule consumption. */
  largestConsumers: Array<{ displayName: string; granules: number }>;
}

export function computePodFill(
  translated: TranslatedActive[],
  config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG
): PodFillResult {
  const inPod = translated.filter(
    (t) => (t.tier === 'DIRECT' || t.tier === 'FORM_SUBSTITUTION') && t.granules !== null
  );
  const totalGranules = inPod.reduce((sum, t) => sum + (t.granules ?? 0), 0);

  return {
    totalGranules,
    capacity: config.podCapacity,
    utilisationFraction: Number((totalGranules / config.podCapacity).toFixed(4)),
    fits: totalGranules <= config.podCapacity,
    largestConsumers: inPod
      .map((t) => ({ displayName: t.target.displayName, granules: t.granules ?? 0 }))
      .sort((a, b) => b.granules - a.granules)
      .slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Justification wiring
// ---------------------------------------------------------------------------

/**
 * Context required to run the justification engine on the translated formula.
 * Passed as an optional argument to `translateProducts`; when absent the
 * assessment is skipped and `TranslationResult.justificationAssessment` is
 * undefined.
 */
export interface JustificationInput {
  draftId: string;
  patientRef: string;
  practitionerId: string;
  /** Dose form to evaluate commercial alternatives against. */
  requiredDoseForm: DoseForm;
  /** ARTG candidate pool — the same array loaded from candidates.json. */
  candidates: CommercialMedicine[];
  /** Override for the default engine config; defaults to DEFAULT_CONFIG. */
  engineConfig?: EngineConfig;
  /**
   * Patient delivery profile for DELIVERY_SYSTEM evaluation.
   * Pass null to skip the pill-burden / swallowing check.
   */
  deliveryProfile?: PatientDeliveryProfile | null;
}

// ---------------------------------------------------------------------------
// Class substitute result
// ---------------------------------------------------------------------------

/**
 * A proposed N of 1 library substitute for an ARTG ingredient that could not
 * be matched to any registry moiety during ingest.
 *
 * Distinct from ClassAlternatives (which handle in-registry moieties with no
 * direct library entry). These are for ingredients with no registry entry at
 * all — the substitute is a therapeutically related but chemically distinct
 * moiety. ALWAYS requires practitioner confirmation.
 *
 * The library's recommended dose is applied, not the commercial product dose:
 * units and forms are not directly comparable across the substitution.
 */
export interface ClassSubstituteResult {
  /** ARTG ingredient name as it appeared on the commercial product label. */
  artgIngredientName: string;
  /** ARTG product(s) this ingredient came from. */
  sources: Array<{ artgId: string; productName: string }>;
  /** TSI code of the proposed N of 1 substitute. */
  substituteLibraryId: string;
  /** Display name of the proposed substitute. */
  substituteDisplayName: string;
  /** Unit of the substitute moiety. */
  unit: 'mg' | 'mcg';
  /** Daily dose recommended by the library monograph (in `unit`). */
  recommendedDose: number;
  /** Granules needed to deliver recommendedDose at library dosePerGranule. */
  recommendedGranules: number;
  /** Clinical rationale for this substitution. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface TranslationResult {
  selected: Array<{ artgId: string; productName: string; unitsPerDay: number }>;
  targets: AggregatedTarget[];
  translated: TranslatedActive[];
  podFill: PodFillResult;
  purchaseSeparately: TranslatedActive[];
  requiresConfirmation: TranslatedActive[];
  unavailable: TranslatedActive[];
  /** Moieties whose aggregated dose exceeds the library's permitted maximum. */
  doseWarnings: TranslatedActive[];
  /** Actives on the source products that could not be resolved to a moiety. */
  unresolvedSourceActives: Array<{ artgId: string; ingredientName: string }>;
  /**
   * Proposed class substitutes for unresolved ARTG ingredients that have a
   * therapeutically related moiety in the N of 1 library.
   * These are NOT in the pod — each requires practitioner confirmation.
   * Present only when a classSubstituteMap was supplied to translateProducts.
   */
  classSubstitutes: ClassSubstituteResult[];
  /**
   * Justification assessment on the in-pod (DIRECT + FORM_SUBSTITUTION) actives.
   * Present only when a JustificationInput was supplied to translateProducts.
   */
  justificationAssessment?: JustificationAssessment;
  translatedAt: string;
}

export function translateProducts(
  selected: SelectedProduct[],
  registry: MoietyRegistry,
  library: Map<string, LibraryGranuleSpec>,
  classAlternatives: Map<string, LibraryGranuleSpec[]>,
  config: TranslationConfig = DEFAULT_TRANSLATION_CONFIG,
  justificationInput?: JustificationInput,
  classSubstituteMap?: ReadonlyMap<string, ClassSubstituteSpec>
): TranslationResult {
  const targets = aggregateTargets(selected, registry);
  const translated = targets.map((t) =>
    translateActive(t, library, classAlternatives, config)
  );

  const unresolvedSourceActives: Array<{ artgId: string; ingredientName: string }> = [];
  for (const { product } of selected) {
    for (const name of product.unmatchedActiveNames ?? []) {
      unresolvedSourceActives.push({ artgId: product.artgId, ingredientName: name });
    }
  }

  // ── Class substitute resolution ────────────────────────────────────────────
  // For each unresolved ARTG ingredient, check the class substitute map. If a
  // substitute is found, compute recommended granules from the library entry.
  // Group by substitute libraryId so the same substitute from multiple products
  // shows as one entry (deduped by ingredient name + substitute).
  const classSubstitutes: ClassSubstituteResult[] = [];
  if (classSubstituteMap && classSubstituteMap.size > 0) {
    // Collect: for each unresolved name, which products contributed it?
    const byName = new Map<string, Array<{ artgId: string; productName: string }>>();
    for (const { artgId, ingredientName } of unresolvedSourceActives) {
      const norm = ingredientName.toLowerCase().trim();
      if (!byName.has(norm)) byName.set(norm, []);
      const sources = byName.get(norm)!;
      const product = selected.find((s) => s.product.artgId === artgId);
      const productName = product?.product.productName ?? artgId;
      if (!sources.some((s) => s.artgId === artgId)) {
        sources.push({ artgId, productName });
      }
    }

    // Resolve each unique unresolved name against the substitute map
    // Dedup by (ingredientName, substituteLibraryId) — same pair from multiple
    // products produces one ClassSubstituteResult (sources list combined above).
    const seen = new Set<string>();
    for (const [norm, sources] of byName.entries()) {
      const spec = classSubstituteMap.get(norm);
      if (!spec) continue;
      const dedupeKey = `${norm}|${spec.libraryId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const librarySpec = library.get(spec.libraryId);
      if (!librarySpec) continue; // library entry not found — skip silently

      const recommendedGranules = librarySpec.dosePerGranule > 0
        ? Math.ceil(spec.recommendedDose / librarySpec.dosePerGranule)
        : 0;

      classSubstitutes.push({
        artgIngredientName: sources[0]
          ? unresolvedSourceActives.find((u) =>
              u.ingredientName.toLowerCase().trim() === norm
            )?.ingredientName ?? norm
          : norm,
        sources,
        substituteLibraryId: spec.libraryId,
        substituteDisplayName: librarySpec.displayName,
        unit: librarySpec.unit,
        recommendedDose: spec.recommendedDose,
        recommendedGranules,
        rationale: spec.rationale,
      });
    }
  }

  // ── Justification assessment ───────────────────────────────────────────────
  // Build a DraftFormulation from in-pod (DIRECT + FORM_SUBSTITUTION) actives
  // and run the justification engine if the caller supplied candidates.
  let justificationAssessment: JustificationAssessment | undefined;
  if (justificationInput) {
    const inPodTranslated = translated.filter(
      (t) => (t.tier === 'DIRECT' || t.tier === 'FORM_SUBSTITUTION') && t.granules !== null,
    );

    const targetActives: NormalisedActive[] = inPodTranslated
      .map((t) => ({
        libraryId: t.target.moietyId as string,
        moiety: t.target.displayName,
        amount: t.target.totalDose,
        // In-pod actives are always granulable (CFU goes to PURCHASE_SEPARATELY);
        // cast is safe within the mg | mcg | g | IU domain.
        unit: t.target.unit as NormalisedActive['unit'],
      }));

    const draft: DraftFormulation = {
      draftId: justificationInput.draftId,
      patientRef: justificationInput.patientRef,
      practitionerId: justificationInput.practitionerId,
      requiredDoseForm: justificationInput.requiredDoseForm,
      targetActives,
      exclusions: [],
    };

    justificationAssessment = assessJustification(
      draft,
      justificationInput.candidates,
      justificationInput.engineConfig ?? DEFAULT_CONFIG,
      justificationInput.deliveryProfile ?? null,
    );
  }

  return {
    selected: selected.map((s) => ({
      artgId: s.product.artgId,
      productName: s.product.productName,
      unitsPerDay: s.unitsPerDay,
    })),
    targets,
    translated,
    podFill: computePodFill(translated, config),
    purchaseSeparately: translated.filter((t) => t.tier === 'PURCHASE_SEPARATELY'),
    requiresConfirmation: translated.filter((t) => t.tier === 'CLASS_SUBSTITUTION'),
    unavailable: translated.filter((t) => t.tier === 'UNAVAILABLE'),
    doseWarnings: translated.filter((t) => t.exceedsLibraryMax),
    unresolvedSourceActives,
    classSubstitutes,
    justificationAssessment,
    translatedAt: new Date().toISOString(),
  };
}
