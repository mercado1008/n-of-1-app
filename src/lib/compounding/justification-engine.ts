/**
 * N of 1 — Compounding Justification Engine
 * ------------------------------------------
 * Purpose: determine, from data the platform already holds, whether a drafted
 * formulation is justified for compounding under Pharmacy Board of Australia
 * "Guidelines on compounding of medicines" (in effect 1 Oct 2024), guideline
 * 1.1.1 — specifically the prohibition at 1.1.1(b) on compounding a close
 * formulation of an available and suitable commercial medicine.
 *
 * DESIGN INTENT
 * The four justification reasons are a fixed, closed set. They are NOT free
 * text and they are NOT selected by the practitioner from a dropdown of
 * plausible-sounding options. Each is *computed* from the reference ARTG data
 * and the drafted formulation, and each carries a machine-generated evidence
 * payload showing the arithmetic. The practitioner confirms; they do not author.
 *
 * This gives near-zero prompting friction (the reason is pre-computed and
 * pre-filled) while keeping every justification factually true and independently
 * verifiable from the stored evidence. A computed justification with the
 * underlying numbers attached is materially stronger evidence than a selected
 * one, because it cannot be characterised as boilerplate.
 *
 * Where none of the four reasons computes as true, the engine returns
 * REVIEW_REQUIRED rather than attaching a reason. That is the case where the
 * draft genuinely is a close formulation of an available commercial medicine —
 * i.e. the case the compounding pharmacist must catch before dispensing,
 * because the pharmacist carries the professional liability for the decision.
 */

import {
  type PatientDeliveryProfile,
  evaluateDeliverySystem,
} from './delivery-system-evaluator';

// Re-export so callers only need one import for the full assessment API.
export type { PatientDeliveryProfile };
export { evaluateDeliverySystem };

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type DoseForm =
  | 'CAPSULE'
  | 'TABLET'
  | 'POWDER'
  | 'ORAL_LIQUID'
  | 'SACHET'
  | 'SOFT_CAPSULE'
  | 'CREAM'
  | 'OTHER';

/** An active, normalised to its active moiety (elemental / dry-equivalent). */
export interface NormalisedActive {
  /** N of 1 library ingredient ID (Rev15). Null if the active has no library match. */
  libraryId: string | null;
  /** Canonical active-moiety name, e.g. "Magnesium (elemental)". */
  moiety: string;
  /** Dose per daily unit of the moiety. */
  amount: number;
  unit: 'mg' | 'mcg' | 'g' | 'IU' | 'CFU';
  /** True where the source specifies a proprietary/branded raw material. */
  proprietaryMaterial?: string | null;
}

/** A commercial medicine (ARTG entry) considered as an alternative to compounding. */
export interface CommercialMedicine {
  artgId: string;
  productName: string;
  sponsor: string;
  doseForm: DoseForm;
  /** Actives per single dosage unit, normalised to active moiety. */
  activesPerUnit: NormalisedActive[];
  /** Max units per day per the ARTG entry / label directions, where known. */
  maxUnitsPerDay: number | null;
  /** Excipient names as listed on the ARTG public summary (quantities are not published). */
  excipients: string[];
  /** Date the ARTG snapshot was taken. Justifications are evaluated against a snapshot. */
  snapshotDate: string;
  /**
   * ARTG ingredient names from this product that could not be mapped to any registry
   * moiety during ingest. These ingredients are absent from `activesPerUnit`, so the
   * engine cannot see them — commercial coverage for this product is understated.
   *
   * When a covering-set product has unmatched actives, COMBINATION_REQUIRED and
   * PILL_BURDEN counts may be overstated (the product covers more than the engine
   * knows). The assessment surfaces this via `dataQualityNotes`.
   *
   * Optional — absent on candidate objects created before this field was added, or
   * where the ingest confirmed all ingredients were matched.
   */
  unmatchedActiveCount?: number;
  unmatchedActiveNames?: string[];
}

/** The formulation drafted by the N of 1 engine for a specific patient. */
export interface DraftFormulation {
  draftId: string;
  patientRef: string;
  practitionerId: string;
  requiredDoseForm: DoseForm;
  /** Target actives per day, normalised to active moiety. */
  targetActives: NormalisedActive[];
  /** Moieties or materials the practitioner has excluded for this patient. */
  exclusions: Exclusion[];
}

export interface Exclusion {
  /** Either a library ingredient ID, an excipient name, or a free moiety name. */
  target: string;
  kind: 'ACTIVE' | 'EXCIPIENT';
}

// ---------------------------------------------------------------------------
// Justification reasons — fixed, closed set
// ---------------------------------------------------------------------------

export type JustificationCode =
  | 'DOSE_FORM'
  | 'DOSE_OUTSIDE_AVAILABLE_STRENGTHS'
  | 'COMBINATION_REQUIRED'
  | 'INGREDIENT_EXCLUSION'
  | 'DELIVERY_SYSTEM';

export const JUSTIFICATION_LABELS: Record<JustificationCode, string> = {
  DOSE_FORM:
    'Required dose form is not available in a suitable commercial medicine',
  DOSE_OUTSIDE_AVAILABLE_STRENGTHS:
    'Required dose cannot be achieved from available commercial strengths',
  COMBINATION_REQUIRED:
    'Required actives cannot be delivered by a single suitable commercial medicine',
  INGREDIENT_EXCLUSION:
    'Every otherwise-suitable commercial medicine contains an excluded ingredient',
  DELIVERY_SYSTEM:
    'Patient cannot practicably use the delivery system of available commercial medicines',
};

/** Maps each reason to the guideline provision it answers. */
export const GUIDELINE_REF: Record<JustificationCode, string> = {
  DOSE_FORM: 'PBA Guidelines 1.1.1(b) — dose forms available are unsuitable',
  DOSE_OUTSIDE_AVAILABLE_STRENGTHS: 'PBA Guidelines 1.1.1(b)',
  COMBINATION_REQUIRED:
    'PBA Guidelines 1.1.1(a) — no suitable commercial medicine or combination',
  INGREDIENT_EXCLUSION:
    'PBA Guidelines 1.1.1(b) — commercial medicine unsuitable (excipient/active intolerance)',
  DELIVERY_SYSTEM:
    'PBA Guidelines 1.1.1(b) — commercial medicine unsuitable (delivery system or pill burden)',
};

export interface JustificationReason {
  code: JustificationCode;
  label: string;
  guidelineRef: string;
  /** Machine-generated. Shows the arithmetic behind the determination. */
  evidence: Record<string, unknown>;
  determinedBy: 'SYSTEM';
}

export type JustificationStatus = 'JUSTIFIED' | 'REVIEW_REQUIRED';

/**
 * A data quality note on the assessment — surfaced when the engine detects that
 * covering-set products have unmatched actives, which biases COMBINATION_REQUIRED
 * and PILL_BURDEN in the JUSTIFIED direction. Does not change status; callers
 * must decide whether to hold or proceed based on alias coverage.
 */
export interface DataQualityNote {
  kind: 'PARTIAL_MATCH_PRODUCT';
  artgId: string;
  productName: string;
  /** ARTG ingredient names dropped during ingest because no registry moiety matched. */
  unmatchedActiveNames: string[];
  /**
   * Direction of bias: the product covers MORE actives than the engine can see.
   * COMBINATION_REQUIRED (more products selected) and PILL_BURDEN may be overstated.
   * The assessment may be more JUSTIFIED than it truly is.
   */
  note: string;
}

export interface JustificationAssessment {
  draftId: string;
  status: JustificationStatus;
  reasons: JustificationReason[];
  /** Closest commercial medicine by active-moiety overlap, for the 1.1.1(b) test. */
  closestCommercial: SimilarityResult | null;
  /** ARTG snapshot the assessment was evaluated against. Immutable once stored. */
  snapshotDate: string;
  evaluatedAt: string;
  /**
   * Data quality notes about covering-set products with unmatched actives.
   * Non-empty when any product selected into the greedy covering set has actives
   * the engine could not map to a registry moiety. The assessment result stands,
   * but the counts are understated on the commercial side.
   */
  dataQualityNotes: DataQualityNote[];
}

export interface EngineConfig {
  /**
   * A commercial strength is treated as able to meet the target if the closest
   * achievable whole-unit dose is within this fraction of target.
   */
  doseToleranceFraction: number;
  /** Above this Jaccard overlap on active moieties, treat as a close formulation. */
  closeFormulationThreshold: number;
  /** Max commercial products a patient can reasonably be asked to take concurrently. */
  maxConcurrentProducts: number;
  /**
   * Total commercial discrete doses per day (across all covering-set products)
   * at or above which the delivery system is considered unsuitable
   * (DELIVERY_SYSTEM / PILL_BURDEN trigger). Counts the actual units needed to
   * meet the target dose via per-moiety arithmetic; missing activesPerUnit data
   * is not used here — see computePillBurden in delivery-system-evaluator.ts.
   *
   * Threshold agreed with compounding partner, August 2026. Not a default.
   */
  commercialPillBurdenThreshold: number;
}

export const DEFAULT_CONFIG: EngineConfig = {
  doseToleranceFraction: 0.2,
  closeFormulationThreshold: 0.8,
  maxConcurrentProducts: 2,
  // Threshold agreed with compounding partner, August 2026. Not a default.
  commercialPillBurdenThreshold: 6,
};

// ---------------------------------------------------------------------------
// Unit normalisation
// ---------------------------------------------------------------------------

const MASS_TO_MG: Partial<Record<NormalisedActive['unit'], number>> = {
  g: 1000,
  mg: 1,
  mcg: 0.001,
};

/** Returns amount in mg, or null where the unit is not mass-based (IU, CFU). */
function toMg(a: NormalisedActive): number | null {
  const factor = MASS_TO_MG[a.unit];
  return factor === undefined ? null : a.amount * factor;
}

/** Two actives are comparable only where moiety and unit class agree. */
function comparable(a: NormalisedActive, b: NormalisedActive): boolean {
  if (a.moiety !== b.moiety) return false;
  const aMass = MASS_TO_MG[a.unit] !== undefined;
  const bMass = MASS_TO_MG[b.unit] !== undefined;
  if (aMass !== bMass) return false;
  if (!aMass) return a.unit === b.unit;
  return true;
}

function amountIn(a: NormalisedActive): number {
  return toMg(a) ?? a.amount;
}

// ---------------------------------------------------------------------------
// Covering-set computation (shared between COMBINATION_REQUIRED and DELIVERY_SYSTEM)
// ---------------------------------------------------------------------------

/** One product in the greedy minimum covering set. */
export interface CoveringEntry {
  artgId: string;
  productName: string;
  /** Moiety names from targetActives this product covers. */
  covers: string[];
  /** Label max units per day; null when not published on the ARTG entry. */
  maxUnitsPerDay: number | null;
}

export interface CoveringSetResult {
  /** Greedy minimum set cover of targetActives over the candidate pool. */
  coveringSet: CoveringEntry[];
  /** Moiety names not covered by any candidate. */
  uncoverable: string[];
  /**
   * Full ARTG candidate pool passed into computeCoveringSet. Carried here so
   * TITRATION_GRANULARITY can scan every commercial product to find the true
   * smallest available increment — not just the ones selected into the covering
   * set, which may be a strict greedy subset with larger per-unit strengths.
   * Also used as the artgId lookup source for covering-set products that need
   * fields (activesPerUnit, doseForm) absent from the lightweight CoveringEntry.
   */
  allCandidates: CommercialMedicine[];
  /**
   * Target actives from the draft formulation. Carried here so evaluators that
   * need per-moiety arithmetic (PILL_BURDEN, TITRATION_GRANULARITY) do not
   * require a separate draft parameter alongside the bundle.
   */
  targetActives: NormalisedActive[];
}

/**
 * Greedy set cover of targetActives over the candidate pool.
 * O(n·m) where n = candidates, m = uncovered moieties; N is small in practice
 * (tens of candidates) so greedy is fine, and its suboptimality is conservative:
 * it can only over-estimate the product count.
 *
 * Exported so assessJustification can compute it once and share the result with
 * both evaluateCombinationRequired and evaluateDeliverySystem.
 */
export function computeCoveringSet(
  targetActives: NormalisedActive[],
  candidates: CommercialMedicine[],
): CoveringSetResult {
  const uncovered = new Set(targetActives.map((a) => a.moiety));
  const coveringSet: CoveringEntry[] = [];
  const pool = [...candidates];

  while (uncovered.size > 0) {
    let best: CommercialMedicine | null = null;
    let bestCovers: string[] = [];

    for (const c of pool) {
      const covers = c.activesPerUnit
        .map((a) => a.moiety)
        .filter((m) => uncovered.has(m));
      if (covers.length > bestCovers.length) {
        best = c;
        bestCovers = covers;
      }
    }

    if (!best || bestCovers.length === 0) break; // remainder is uncoverable
    coveringSet.push({
      artgId: best.artgId,
      productName: best.productName,
      covers: bestCovers,
      maxUnitsPerDay: best.maxUnitsPerDay,
    });
    bestCovers.forEach((m) => uncovered.delete(m));
    pool.splice(pool.indexOf(best), 1);
  }

  return { coveringSet, uncoverable: [...uncovered], allCandidates: candidates, targetActives };
}

// ---------------------------------------------------------------------------
// Reason evaluators
// ---------------------------------------------------------------------------

/**
 * DOSE_FORM — true where no candidate commercial medicine is available in the
 * dose form the patient requires.
 */
export function evaluateDoseForm(
  draft: DraftFormulation,
  candidates: CommercialMedicine[]
): JustificationReason | null {
  const matching = candidates.filter((c) => c.doseForm === draft.requiredDoseForm);
  if (matching.length > 0) return null;

  return {
    code: 'DOSE_FORM',
    label: JUSTIFICATION_LABELS.DOSE_FORM,
    guidelineRef: GUIDELINE_REF.DOSE_FORM,
    determinedBy: 'SYSTEM',
    evidence: {
      requiredDoseForm: draft.requiredDoseForm,
      availableDoseForms: [...new Set(candidates.map((c) => c.doseForm))],
      candidatesConsidered: candidates.map((c) => c.artgId),
    },
  };
}

/**
 * DOSE_OUTSIDE_AVAILABLE_STRENGTHS — true where, for at least one target active,
 * no whole-unit multiple of any commercial strength lands within tolerance of
 * the target dose (respecting the label's max units per day where published).
 */
export function evaluateDoseOutsideStrengths(
  draft: DraftFormulation,
  candidates: CommercialMedicine[],
  config: EngineConfig = DEFAULT_CONFIG
): JustificationReason | null {
  const failures: Array<Record<string, unknown>> = [];

  for (const target of draft.targetActives) {
    const targetAmt = amountIn(target);
    let bestDeviation = Infinity;
    let bestDescription: Record<string, unknown> | null = null;
    let anyCandidateCarries = false;

    for (const c of candidates) {
      const active = c.activesPerUnit.find((a) => comparable(a, target));
      if (!active) continue;
      anyCandidateCarries = true;

      const perUnit = amountIn(active);
      if (perUnit <= 0) continue;

      const cap = c.maxUnitsPerDay ?? 6;
      // Whole units only — a patient cannot take a fraction of a tablet reliably,
      // and splitting a commercial product is itself a modification (guideline 5.3).
      for (let units = 1; units <= cap; units++) {
        const achievable = perUnit * units;
        const deviation = Math.abs(achievable - targetAmt) / targetAmt;
        if (deviation < bestDeviation) {
          bestDeviation = deviation;
          bestDescription = {
            artgId: c.artgId,
            productName: c.productName,
            strengthPerUnit: perUnit,
            units,
            achievableDose: achievable,
          };
        }
      }
    }

    if (!anyCandidateCarries) {
      // Handled by COMBINATION_REQUIRED, not here.
      continue;
    }

    if (bestDeviation > config.doseToleranceFraction) {
      failures.push({
        moiety: target.moiety,
        targetDose: targetAmt,
        unit: MASS_TO_MG[target.unit] !== undefined ? 'mg' : target.unit,
        nearestAchievable: bestDescription,
        deviationFraction: Number(bestDeviation.toFixed(4)),
        toleranceFraction: config.doseToleranceFraction,
      });
    }
  }

  if (failures.length === 0) return null;

  return {
    code: 'DOSE_OUTSIDE_AVAILABLE_STRENGTHS',
    label: JUSTIFICATION_LABELS.DOSE_OUTSIDE_AVAILABLE_STRENGTHS,
    guidelineRef: GUIDELINE_REF.DOSE_OUTSIDE_AVAILABLE_STRENGTHS,
    determinedBy: 'SYSTEM',
    evidence: { activesOutsideAvailableStrengths: failures },
  };
}

/**
 * COMBINATION_REQUIRED — true where covering all target actives would require
 * more concurrent commercial products than is reasonable, or where some target
 * active is not carried by any candidate at all.
 *
 * Accepts a pre-computed CoveringSetResult from computeCoveringSet() so the
 * set is not recomputed when evaluateDeliverySystem also needs it. Pass the
 * result from assessJustification, which calls computeCoveringSet once.
 */
export function evaluateCombinationRequired(
  draft: DraftFormulation,
  coveringResult: CoveringSetResult,
  config: EngineConfig = DEFAULT_CONFIG
): JustificationReason | null {
  const { coveringSet, uncoverable } = coveringResult;
  const productCount = coveringSet.length;

  if (productCount <= config.maxConcurrentProducts && uncoverable.length === 0) {
    return null;
  }

  return {
    code: 'COMBINATION_REQUIRED',
    label: JUSTIFICATION_LABELS.COMBINATION_REQUIRED,
    guidelineRef: GUIDELINE_REF.COMBINATION_REQUIRED,
    determinedBy: 'SYSTEM',
    evidence: {
      targetActiveCount: draft.targetActives.length,
      minimumCommercialProductsRequired: productCount,
      maxConcurrentProducts: config.maxConcurrentProducts,
      coveringSet,
      activesNotAvailableInAnyCommercialMedicine: uncoverable,
    },
  };
}

/**
 * INGREDIENT_EXCLUSION — true where every candidate that would otherwise be
 * suitable contains an ingredient excluded for this patient.
 */
export function evaluateIngredientExclusion(
  draft: DraftFormulation,
  candidates: CommercialMedicine[]
): JustificationReason | null {
  if (draft.exclusions.length === 0 || candidates.length === 0) return null;

  const norm = (s: string) => s.trim().toLowerCase();
  const excludedActives = new Set(
    draft.exclusions.filter((e) => e.kind === 'ACTIVE').map((e) => norm(e.target))
  );
  const excludedExcipients = new Set(
    draft.exclusions.filter((e) => e.kind === 'EXCIPIENT').map((e) => norm(e.target))
  );

  const conflicts: Array<Record<string, unknown>> = [];

  for (const c of candidates) {
    const hitActives = c.activesPerUnit
      .filter(
        (a) =>
          excludedActives.has(norm(a.moiety)) ||
          (a.libraryId !== null && excludedActives.has(norm(a.libraryId)))
      )
      .map((a) => a.moiety);
    const hitExcipients = c.excipients.filter((e) => excludedExcipients.has(norm(e)));

    if (hitActives.length === 0 && hitExcipients.length === 0) {
      // At least one candidate is clean — exclusion does not justify compounding.
      return null;
    }
    conflicts.push({
      artgId: c.artgId,
      productName: c.productName,
      excludedActivesPresent: hitActives,
      excludedExcipientsPresent: hitExcipients,
    });
  }

  return {
    code: 'INGREDIENT_EXCLUSION',
    label: JUSTIFICATION_LABELS.INGREDIENT_EXCLUSION,
    guidelineRef: GUIDELINE_REF.INGREDIENT_EXCLUSION,
    determinedBy: 'SYSTEM',
    evidence: {
      exclusions: draft.exclusions,
      allCandidatesConflict: true,
      conflicts,
      note:
        'ARTG public summaries list excipient names without quantities; excipient ' +
        'screening is limited to disclosed names.',
    },
  };
}

// ---------------------------------------------------------------------------
// Close-formulation similarity (guideline 1.1.1(b))
// ---------------------------------------------------------------------------

export interface SimilarityResult {
  artgId: string;
  productName: string;
  sponsor: string;
  /** Jaccard overlap on active moieties. */
  moietyOverlap: number;
  /** Fraction of shared moieties whose dose falls within tolerance. */
  doseAgreement: number;
  isCloseFormulation: boolean;
}

export function findClosestCommercial(
  draft: DraftFormulation,
  candidates: CommercialMedicine[],
  config: EngineConfig = DEFAULT_CONFIG
): SimilarityResult | null {
  let best: SimilarityResult | null = null;

  for (const c of candidates) {
    const targetMoieties = new Set(draft.targetActives.map((a) => a.moiety));
    const commercialMoieties = new Set(c.activesPerUnit.map((a) => a.moiety));
    const shared = [...targetMoieties].filter((m) => commercialMoieties.has(m));
    const union = new Set([...targetMoieties, ...commercialMoieties]);
    const moietyOverlap = union.size === 0 ? 0 : shared.length / union.size;

    let agreeing = 0;
    for (const m of shared) {
      const t = draft.targetActives.find((a) => a.moiety === m)!;
      const cActive = c.activesPerUnit.find((a) => a.moiety === m)!;
      if (!comparable(t, cActive)) continue;
      const tAmt = amountIn(t);
      const maxUnits = c.maxUnitsPerDay ?? 6;
      const perUnit = amountIn(cActive);
      let closest = Infinity;
      for (let u = 1; u <= maxUnits; u++) {
        closest = Math.min(closest, Math.abs(perUnit * u - tAmt) / tAmt);
      }
      if (closest <= config.doseToleranceFraction) agreeing++;
    }
    const doseAgreement = shared.length === 0 ? 0 : agreeing / shared.length;

    const result: SimilarityResult = {
      artgId: c.artgId,
      productName: c.productName,
      sponsor: c.sponsor,
      moietyOverlap: Number(moietyOverlap.toFixed(4)),
      doseAgreement: Number(doseAgreement.toFixed(4)),
      isCloseFormulation:
        moietyOverlap >= config.closeFormulationThreshold && doseAgreement >= 0.8,
    };

    if (!best || result.moietyOverlap > best.moietyOverlap) best = result;
  }

  return best;
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

/**
 * Codes that are sufficient on their own to set status = JUSTIFIED.
 *
 * DOSE_FORM is corroborating-only: it strengthens the compounding record but
 * cannot alone override the pharmacist's obligation to verify commercial
 * availability, because dose-form arguments are sometimes rebuttable (e.g. a
 * capsule is available in a closely related product). Every other code requires
 * a quantitative arithmetic check that is independently verifiable.
 */
export const CARRYING_CODES = new Set<JustificationCode>([
  'DOSE_OUTSIDE_AVAILABLE_STRENGTHS',
  'COMBINATION_REQUIRED',
  'INGREDIENT_EXCLUSION',
  'DELIVERY_SYSTEM',
]);

/**
 * Runs all five evaluators. Returns JUSTIFIED where at least one carrying-code
 * reason fires, or REVIEW_REQUIRED otherwise.
 *
 * REVIEW_REQUIRED is not an error state and must not be auto-resolved. It means
 * the draft is likely deliverable by available commercial medicines, and the
 * decision to proceed belongs to the compounding pharmacist who carries the
 * professional liability for it.
 *
 * @param patientProfile  Loaded by patientRef before calling. Pass null when
 *                        not yet recorded; the DELIVERY_SYSTEM evaluator will
 *                        still fire on pill-burden alone if warranted.
 */
export function assessJustification(
  draft: DraftFormulation,
  candidates: CommercialMedicine[],
  config: EngineConfig = DEFAULT_CONFIG,
  patientProfile: PatientDeliveryProfile | null = null,
): JustificationAssessment {
  // Compute the covering set once; share it between the two evaluators that need it.
  const coveringResult = computeCoveringSet(draft.targetActives, candidates);

  const reasons = [
    evaluateDoseForm(draft, candidates),
    evaluateDoseOutsideStrengths(draft, candidates, config),
    evaluateCombinationRequired(draft, coveringResult, config),
    evaluateIngredientExclusion(draft, candidates),
    evaluateDeliverySystem(coveringResult, patientProfile, config),
  ].filter((r): r is JustificationReason => r !== null);

  // Detect partial-match products in the covering set.
  // A product with unmatchedActiveCount > 0 has actives the engine could not see.
  // This means the engine may have selected MORE products than necessary (the real
  // product covers more actives), biasing COMBINATION_REQUIRED and PILL_BURDEN toward
  // JUSTIFIED. Surface as data quality notes; do not suppress the assessment result.
  const candidateIndex = new Map(candidates.map((c) => [c.artgId, c]));
  const dataQualityNotes: DataQualityNote[] = [];
  for (const entry of coveringResult.coveringSet) {
    const candidate = candidateIndex.get(entry.artgId);
    if (candidate && (candidate.unmatchedActiveCount ?? 0) > 0) {
      dataQualityNotes.push({
        kind: 'PARTIAL_MATCH_PRODUCT',
        artgId: entry.artgId,
        productName: entry.productName,
        unmatchedActiveNames: candidate.unmatchedActiveNames ?? [],
        note:
          `${candidate.unmatchedActiveCount} unmatched ingredient(s) were dropped during ` +
          `ARTG ingest — the engine cannot see these moieties. This product may cover more ` +
          `target actives than the engine accounts for. COMBINATION_REQUIRED product counts ` +
          `and PILL_BURDEN may be overstated. Resolve the missing aliases and re-ingest.`,
      });
    }
  }

  const snapshotDate =
    candidates.length > 0
      ? candidates.map((c) => c.snapshotDate).sort().slice(-1)[0]
      : new Date().toISOString().slice(0, 10);

  return {
    draftId: draft.draftId,
    status: reasons.some((r) => CARRYING_CODES.has(r.code)) ? 'JUSTIFIED' : 'REVIEW_REQUIRED',
    reasons,
    closestCommercial: findClosestCommercial(draft, candidates, config),
    snapshotDate,
    evaluatedAt: new Date().toISOString(),
    dataQualityNotes,
  };
}
