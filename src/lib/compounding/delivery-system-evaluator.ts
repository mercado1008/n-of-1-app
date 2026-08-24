/**
 * N of 1 — DELIVERY_SYSTEM justification evaluator
 * -------------------------------------------------
 * The pod format (3mm mini-tablets, one per active, up to 720 units per pod) is
 * not used by any ARTG-listed product. That makes "this dose form is
 * unavailable commercially" trivially true for every formulation — which is
 * precisely why it cannot carry a justification on its own.
 *
 * Guideline 1.1.1(b) asks a comparative, patient-specific question: is the
 * compounded medicine a close formulation of an available commercial medicine
 * AND unlikely to produce a different therapeutic outcome. A format difference
 * answers the second limb only where something about this patient or this
 * formulation makes the format consequential.
 *
 * This evaluator fires on three grounds, each either computed or drawn from a
 * patient attribute recorded once at intake:
 *
 *   PILL_BURDEN            — computed from the commercial covering set
 *   TITRATION_GRANULARITY  — computed from target doses vs commercial strengths
 *   PATIENT_FACTOR         — recorded at intake, applies to all that patient's
 *                            formulations thereafter
 *
 * No per-formulation prompting is required. Where none of the three applies,
 * the evaluator returns null and the format difference is recorded as
 * corroborating context on the assessment, not as a standalone justification.
 *
 * Deliberately absent: any claim of superior therapeutic outcome relative to
 * capsules, tablets or powders. That is an efficacy claim requiring comparative
 * evidence, and it is not one the platform holds data to support.
 *
 * PUBLIC SIGNATURE: evaluateDeliverySystem(coveringResult, profile, config)
 *
 * The caller (assessJustification) computes the covering set once and passes the
 * CoveringSetResult bundle here. The bundle carries allCandidates and
 * targetActives, so none of the private helpers need the draft or the full
 * candidate list as separate parameters.
 */

import type {
  CoveringSetResult,
  DoseForm,
  EngineConfig,
  JustificationReason,
} from './justification-engine';
import { DEFAULT_CONFIG } from './justification-engine';

// ---------------------------------------------------------------------------
// Patient delivery profile — captured once at intake
// ---------------------------------------------------------------------------

/**
 * Recorded at patient onboarding, not per formulation. Every field is a factual
 * observation the practitioner can attest to, not an inference.
 */
export interface PatientDeliveryProfile {
  patientRef: string;
  /** Documented difficulty swallowing intact solid dose forms. */
  swallowingDifficulty: boolean;
  /** Documented history of non-adherence attributed to regimen complexity or pill burden. */
  priorNonAdherence: boolean;
  /** Impairment affecting handling of multiple containers or blister packs. */
  dexterityImpairment: boolean;
  recordedBy: string;
  recordedAt: string;
}

export const NO_DELIVERY_PROFILE: Omit<
  PatientDeliveryProfile,
  'patientRef' | 'recordedBy' | 'recordedAt'
> = {
  swallowingDifficulty: false,
  priorNonAdherence: false,
  dexterityImpairment: false,
};

// ---------------------------------------------------------------------------
// Grounds
// ---------------------------------------------------------------------------

export type DeliveryGround =
  | 'PILL_BURDEN'
  | 'TITRATION_GRANULARITY'
  | 'PATIENT_FACTOR';

interface GroundResult {
  ground: DeliveryGround;
  evidence: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Private helpers — each reads exclusively from the CoveringSetResult bundle
// ---------------------------------------------------------------------------

/**
 * Total daily commercial dosage units required to deliver the target actives,
 * derived from the covering set. Counts the maximum units of each product
 * needed by any single active it carries (per-moiety arithmetic).
 *
 * Reads targetActives and the full CommercialMedicine objects from the bundle.
 * CoveringEntry does not carry activesPerUnit, so each entry is resolved via
 * allCandidates by artgId.
 */
function computePillBurden(
  result: CoveringSetResult,
  config: EngineConfig,
): GroundResult | null {
  let totalUnits = 0;
  const perProduct: Array<Record<string, unknown>> = [];

  for (const entry of result.coveringSet) {
    // CoveringEntry is lightweight — resolve the full record to access activesPerUnit.
    const product = result.allCandidates.find((c) => c.artgId === entry.artgId);
    if (!product) continue;

    let unitsForProduct = 0;
    for (const target of result.targetActives) {
      const active = product.activesPerUnit.find((a) => a.moiety === target.moiety);
      if (!active || active.amount <= 0) continue;
      const needed = Math.ceil(target.amount / active.amount);
      unitsForProduct = Math.max(unitsForProduct, needed);
    }
    if (unitsForProduct === 0) continue;
    totalUnits += unitsForProduct;
    perProduct.push({
      artgId: product.artgId,
      productName: product.productName,
      doseForm: product.doseForm,
      unitsPerDay: unitsForProduct,
    });
  }

  if (totalUnits < config.commercialPillBurdenThreshold) return null;

  return {
    ground: 'PILL_BURDEN',
    evidence: {
      commercialUnitsPerDay: totalUnits,
      commercialProductCount: perProduct.length,
      breakdown: perProduct,
      compoundedUnitsPerDay: 1,
      compoundedDoseForm: 'POD',
      threshold: config.commercialPillBurdenThreshold,
    },
  };
}

/**
 * Fires where the target dose for at least one active cannot be reached in
 * whole commercial units, but is reachable in the pod because each active is
 * dosed in discrete mini-tablets.
 *
 * Scans the FULL candidate pool (allCandidates), not just the covering set.
 * The greedy covering set is a subset; the smallest commercial increment may
 * come from a product not selected for coverage, and using the covering set
 * alone would over-report the deviation and cause TITRATION_GRANULARITY to
 * fire on doses that are actually achievable commercially.
 */
function computeTitrationGranularity(
  result: CoveringSetResult,
  config: EngineConfig,
): GroundResult | null {
  const affected: Array<Record<string, unknown>> = [];

  for (const target of result.targetActives) {
    let smallestCommercialStep = Infinity;
    let stepSource: string | null = null;

    for (const c of result.allCandidates) {
      const active = c.activesPerUnit.find((a) => a.moiety === target.moiety);
      if (!active || active.amount <= 0) continue;
      if (active.amount < smallestCommercialStep) {
        smallestCommercialStep = active.amount;
        stepSource = `${c.productName} (${c.artgId})`;
      }
    }

    if (!Number.isFinite(smallestCommercialStep)) continue;

    // Achievable only as whole multiples of the smallest commercial strength.
    const remainder = target.amount % smallestCommercialStep;
    const deviation =
      Math.min(remainder, smallestCommercialStep - remainder) / target.amount;

    if (deviation > config.doseToleranceFraction) {
      affected.push({
        moiety: target.moiety,
        targetDose: target.amount,
        smallestCommercialIncrement: smallestCommercialStep,
        incrementSource: stepSource,
        deviationFraction: Number(deviation.toFixed(4)),
      });
    }
  }

  if (affected.length === 0) return null;

  return {
    ground: 'TITRATION_GRANULARITY',
    evidence: {
      activesRequiringSubCommercialIncrements: affected,
      note:
        'Pod format doses each active as discrete mini-tablets, permitting ' +
        'increments finer than the smallest available commercial unit.',
    },
  };
}

/**
 * Fires when the patient has at least one recorded delivery-system constraint.
 *
 * commercialDoseFormsAvailable is populated from allCandidates by artgId
 * lookup because CoveringEntry does not carry the doseForm field.
 */
function computePatientFactor(
  profile: PatientDeliveryProfile | null,
  result: CoveringSetResult,
): GroundResult | null {
  if (!profile) return null;

  const factors: string[] = [];
  if (profile.swallowingDifficulty) factors.push('DOCUMENTED_SWALLOWING_DIFFICULTY');
  if (profile.priorNonAdherence)    factors.push('DOCUMENTED_PRIOR_NON_ADHERENCE');
  if (profile.dexterityImpairment)  factors.push('DOCUMENTED_DEXTERITY_IMPAIRMENT');

  if (factors.length === 0) return null;

  // CoveringEntry does not carry doseForm; resolve via allCandidates by artgId.
  const commercialForms = [
    ...new Set(
      result.coveringSet
        .map((e) => result.allCandidates.find((c) => c.artgId === e.artgId)?.doseForm)
        .filter((f): f is DoseForm => f !== undefined),
    ),
  ];

  return {
    ground: 'PATIENT_FACTOR',
    evidence: {
      factors,
      recordedBy: profile.recordedBy,
      recordedAt: profile.recordedAt,
      commercialDoseFormsAvailable: commercialForms,
      note: 'Patient attributes recorded at intake; not asserted per formulation.',
    },
  };
}

// ---------------------------------------------------------------------------
// Evaluator — public surface
// ---------------------------------------------------------------------------

/**
 * DELIVERY_SYSTEM — returns a JustificationReason if the patient cannot
 * practicably use the delivery system of the available commercial medicines.
 *
 * Accepts the pre-computed CoveringSetResult from assessJustification. The
 * bundle already carries allCandidates and targetActives, so the draft and
 * the full candidate list are not needed as separate parameters.
 *
 * All three grounds are evaluated independently; all that fire are included
 * in the evidence so the assessment record is complete.
 */
export function evaluateDeliverySystem(
  coveringResult: CoveringSetResult,
  profile: PatientDeliveryProfile | null,
  config: EngineConfig = DEFAULT_CONFIG,
): JustificationReason | null {
  const grounds = [
    computePillBurden(coveringResult, config),
    computeTitrationGranularity(coveringResult, config),
    computePatientFactor(profile, coveringResult),
  ].filter((g): g is GroundResult => g !== null);

  if (grounds.length === 0) return null;

  return {
    code: 'DELIVERY_SYSTEM',
    label:
      'Pod delivery format is materially consequential for this patient or formulation',
    guidelineRef:
      'PBA Guidelines 1.1.1(b) — commercial dose forms unsuitable; different therapeutic outcome',
    determinedBy: 'SYSTEM',
    evidence: {
      grounds: grounds.map((g) => g.ground),
      detail: Object.fromEntries(grounds.map((g) => [g.ground, g.evidence])),
      formatNote:
        'No ARTG-listed product uses the 3mm mini-tablet pod format. Format ' +
        'novelty alone is recorded as context and does not constitute this reason.',
    },
  };
}
