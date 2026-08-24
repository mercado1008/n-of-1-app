/**
 * Delivery System Evaluator — Vitest fixtures
 *
 * Six-active panel: Mg 500 mg, Zn 15 mg, Se 200 mcg, D3 25 mcg,
 * Folate 800 mcg, B6 50 mg.
 *
 * Fixture 1 — THREE commercial products, high pill burden, TABLET:
 *   Product A (ARTG-2001): Mg 150 mg + Zn 15 mg + Se 100 mcg per tab
 *   Product B (ARTG-2002): D3 25 mcg + Folate 400 mcg per tab
 *   Product C (ARTG-2003): B6 50 mg per tab
 *
 *   Greedy covering set: B (covers D3, Folate), A (covers Mg, Zn, Se), C (covers B6)
 *     → 3 products > maxConcurrentProducts (2) → COMBINATION_REQUIRED fires
 *
 *   Per-moiety pill burden:
 *     Product B: max(ceil(25/25), ceil(800/400)) = max(1, 2) = 2
 *     Product A: max(ceil(500/150), ceil(15/15), ceil(200/100)) = max(4, 1, 2) = 4
 *     Product C: ceil(50/50) = 1
 *     Total = 2 + 4 + 1 = 7 > commercialPillBurdenThreshold (6) → PILL_BURDEN fires
 *
 *   Both COMBINATION_REQUIRED and DELIVERY_SYSTEM are carrying codes.
 *   Expected status: JUSTIFIED.
 *
 * Fixture 2 — TWO commercial products, exact-match single-unit dosing, CAPSULE required:
 *   Product D (ARTG-2004): Mg 500 mg + Zn 15 mg per TABLET
 *   Product E (ARTG-2005): Se 200 mcg + D3 25 mcg + Folate 800 mcg + B6 50 mg per TABLET
 *
 *   Greedy covering set: D (covers Mg, Zn), E (covers Se, D3, Folate, B6)
 *     → 2 products ≤ maxConcurrentProducts (2) → COMBINATION_REQUIRED silent
 *
 *   Per-moiety pill burden: max(1,1)=1 + max(1,1,1,1)=1 = 2 < threshold 6 → PILL_BURDEN silent
 *
 *   requiredDoseForm = CAPSULE, all candidates = TABLET → DOSE_FORM fires.
 *   DOSE_FORM is corroborating-only → no carrying code → status = REVIEW_REQUIRED.
 */

import { describe, it, expect } from 'vitest';
import {
  assessJustification,
  computeCoveringSet,
  DEFAULT_CONFIG,
  type DraftFormulation,
  type CommercialMedicine,
  type NormalisedActive,
  type EngineConfig,
} from '../justification-engine';
import {
  evaluateDeliverySystem,
  type PatientDeliveryProfile,
} from '../delivery-system-evaluator';

// ---------------------------------------------------------------------------
// Moiety name constants — must match between targetActives and activesPerUnit
// ---------------------------------------------------------------------------

const MG_MOIETY     = 'Magnesium (elemental)';
const ZN_MOIETY     = 'Zinc (elemental)';
const SE_MOIETY     = 'Selenium (elemental)';
const D3_MOIETY     = 'Cholecalciferol';
const FOLATE_MOIETY = 'Folate (as methylfolate)';
const B6_MOIETY     = 'Pyridoxal-5-phosphate';

const SNAPSHOT = '2026-08-12';

// ---------------------------------------------------------------------------
// Shared target actives — 6-active panel used by both fixtures
// ---------------------------------------------------------------------------

const SIX_ACTIVES: NormalisedActive[] = [
  { libraryId: 'W040002000', moiety: MG_MOIETY,     amount: 500,  unit: 'mg'  },
  { libraryId: 'W040008000', moiety: ZN_MOIETY,     amount: 15,   unit: 'mg'  },
  { libraryId: 'W040009000', moiety: SE_MOIETY,     amount: 200,  unit: 'mcg' },
  { libraryId: 'W030005000', moiety: D3_MOIETY,     amount: 25,   unit: 'mcg' },
  { libraryId: 'W020007000', moiety: FOLATE_MOIETY, amount: 800,  unit: 'mcg' },
  { libraryId: 'W020003000', moiety: B6_MOIETY,     amount: 50,   unit: 'mg'  },
];

function makeDraft(
  requiredDoseForm: DraftFormulation['requiredDoseForm'] = 'TABLET',
): DraftFormulation {
  return {
    draftId: 'draft-test-002',
    patientRef: 'PT-2026-TEST',
    practitionerId: 'prac-hash-abc',
    requiredDoseForm,
    targetActives: SIX_ACTIVES,
    exclusions: [],
  };
}

// ---------------------------------------------------------------------------
// Fixture 1 candidates — three TABLET products, high pill burden
// ---------------------------------------------------------------------------

/**
 * ARTG-2001: multi-mineral tablet covering Mg / Zn / Se.
 * Per-moiety ceiling: ceil(500/150)=4, ceil(15/15)=1, ceil(200/100)=2 → max = 4.
 */
const PRODUCT_A: CommercialMedicine = {
  artgId: 'ARTG-2001',
  productName: 'MultiMin Mg/Zn/Se 150 Tablet',
  sponsor: 'Example Pharma Pty Ltd',
  doseForm: 'TABLET',
  activesPerUnit: [
    { libraryId: 'W040002000', moiety: MG_MOIETY, amount: 150,  unit: 'mg'  },
    { libraryId: 'W040008000', moiety: ZN_MOIETY, amount: 15,   unit: 'mg'  },
    { libraryId: 'W040009000', moiety: SE_MOIETY, amount: 100,  unit: 'mcg' },
  ],
  maxUnitsPerDay: 8,
  excipients: ['microcrystalline cellulose', 'magnesium stearate'],
  snapshotDate: SNAPSHOT,
};

/**
 * ARTG-2002: D3 + Folate tablet.
 * Per-moiety ceiling: ceil(25/25)=1, ceil(800/400)=2 → max = 2.
 */
const PRODUCT_B: CommercialMedicine = {
  artgId: 'ARTG-2002',
  productName: 'VitaD Folate 400 Tablet',
  sponsor: 'Example Pharma Pty Ltd',
  doseForm: 'TABLET',
  activesPerUnit: [
    { libraryId: 'W030005000', moiety: D3_MOIETY,     amount: 25,  unit: 'mcg' },
    { libraryId: 'W020007000', moiety: FOLATE_MOIETY, amount: 400, unit: 'mcg' },
  ],
  maxUnitsPerDay: 4,
  excipients: ['lactose monohydrate', 'colloidal anhydrous silica'],
  snapshotDate: SNAPSHOT,
};

/**
 * ARTG-2003: B6 (P-5-P) tablet.
 * Per-moiety ceiling: ceil(50/50)=1.
 */
const PRODUCT_C: CommercialMedicine = {
  artgId: 'ARTG-2003',
  productName: 'B6 Active 50 Tablet',
  sponsor: 'Example Pharma Pty Ltd',
  doseForm: 'TABLET',
  activesPerUnit: [
    { libraryId: 'W020003000', moiety: B6_MOIETY, amount: 50, unit: 'mg' },
  ],
  maxUnitsPerDay: 4,
  excipients: ['microcrystalline cellulose'],
  snapshotDate: SNAPSHOT,
};

const THREE_PRODUCTS: CommercialMedicine[] = [PRODUCT_A, PRODUCT_B, PRODUCT_C];

// ---------------------------------------------------------------------------
// Fixture 2 candidates — two TABLET products, exact single-unit dosing
// ---------------------------------------------------------------------------

/**
 * ARTG-2004: exact Mg + Zn TABLET.
 * Per-moiety ceiling: ceil(500/500)=1, ceil(15/15)=1 → max = 1.
 */
const PRODUCT_D: CommercialMedicine = {
  artgId: 'ARTG-2004',
  productName: 'MagZinc Complete Tablet',
  sponsor: 'Example Pharma Pty Ltd',
  doseForm: 'TABLET',
  activesPerUnit: [
    { libraryId: 'W040002000', moiety: MG_MOIETY, amount: 500, unit: 'mg'  },
    { libraryId: 'W040008000', moiety: ZN_MOIETY, amount: 15,  unit: 'mg'  },
  ],
  maxUnitsPerDay: 2,
  excipients: ['microcrystalline cellulose', 'magnesium stearate'],
  snapshotDate: SNAPSHOT,
};

/**
 * ARTG-2005: exact Se + D3 + Folate + B6 TABLET.
 * Per-moiety ceiling: ceil(200/200)=1, ceil(25/25)=1, ceil(800/800)=1, ceil(50/50)=1 → max = 1.
 */
const PRODUCT_E: CommercialMedicine = {
  artgId: 'ARTG-2005',
  productName: 'MultiVit Antioxidant Complex Tablet',
  sponsor: 'Example Pharma Pty Ltd',
  doseForm: 'TABLET',
  activesPerUnit: [
    { libraryId: 'W040009000', moiety: SE_MOIETY,     amount: 200, unit: 'mcg' },
    { libraryId: 'W030005000', moiety: D3_MOIETY,     amount: 25,  unit: 'mcg' },
    { libraryId: 'W020007000', moiety: FOLATE_MOIETY, amount: 800, unit: 'mcg' },
    { libraryId: 'W020003000', moiety: B6_MOIETY,     amount: 50,  unit: 'mg'  },
  ],
  maxUnitsPerDay: 2,
  excipients: ['lactose monohydrate', 'colloidal anhydrous silica'],
  snapshotDate: SNAPSHOT,
};

const TWO_PRODUCTS: CommercialMedicine[] = [PRODUCT_D, PRODUCT_E];

// ---------------------------------------------------------------------------
// Fixture 1: Three products, PILL_BURDEN + COMBINATION_REQUIRED → JUSTIFIED
// ---------------------------------------------------------------------------

describe('Fixture 1 — PILL_BURDEN + COMBINATION_REQUIRED, status JUSTIFIED', () => {
  // requiredDoseForm = TABLET, all candidates = TABLET → DOSE_FORM silent.
  const draft  = makeDraft('TABLET');
  const result = assessJustification(draft, THREE_PRODUCTS, DEFAULT_CONFIG, null);

  it('returns JUSTIFIED status', () => {
    expect(result.status).toBe('JUSTIFIED');
  });

  it('includes DELIVERY_SYSTEM in reasons', () => {
    expect(result.reasons.map((r) => r.code)).toContain('DELIVERY_SYSTEM');
  });

  it('includes COMBINATION_REQUIRED in reasons', () => {
    expect(result.reasons.map((r) => r.code)).toContain('COMBINATION_REQUIRED');
  });

  it('does not include DOSE_FORM (requiredDoseForm = TABLET, all candidates TABLET)', () => {
    expect(result.reasons.map((r) => r.code)).not.toContain('DOSE_FORM');
  });

  it('DELIVERY_SYSTEM carries PILL_BURDEN ground with total = 7', () => {
    const dsReason = result.reasons.find((r) => r.code === 'DELIVERY_SYSTEM')!;
    expect(dsReason).toBeDefined();
    const detail = dsReason.evidence['detail'] as Record<string, Record<string, unknown>>;
    const pb = detail['PILL_BURDEN'];
    expect(pb).toBeDefined();
    // Covering set: B (max=2) + A (max=4) + C (max=1) = 7.
    expect(pb['commercialUnitsPerDay']).toBe(7);
    expect(pb['threshold']).toBe(DEFAULT_CONFIG.commercialPillBurdenThreshold);
  });

  it('COMBINATION_REQUIRED evidence records 3 products and max=2', () => {
    const crReason = result.reasons.find((r) => r.code === 'COMBINATION_REQUIRED')!;
    expect(crReason).toBeDefined();
    expect(crReason.evidence['minimumCommercialProductsRequired']).toBe(3);
    expect(crReason.evidence['maxConcurrentProducts']).toBe(DEFAULT_CONFIG.maxConcurrentProducts);
  });

  it('DELIVERY_SYSTEM does not carry PATIENT_FACTOR (no profile provided)', () => {
    const dsReason = result.reasons.find((r) => r.code === 'DELIVERY_SYSTEM')!;
    const detail = dsReason.evidence['detail'] as Record<string, unknown>;
    expect(detail['PATIENT_FACTOR']).toBeUndefined();
  });

  it('determinedBy is SYSTEM on all reasons', () => {
    for (const r of result.reasons) {
      expect(r.determinedBy).toBe('SYSTEM');
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture 2: Two products, exact dosing, CAPSULE required → REVIEW_REQUIRED
// ---------------------------------------------------------------------------

describe('Fixture 2 — DOSE_FORM only, status REVIEW_REQUIRED', () => {
  // requiredDoseForm = CAPSULE, all candidates = TABLET → DOSE_FORM fires.
  // Pill burden = 1 + 1 = 2 < 6 → PILL_BURDEN silent.
  // 2 products ≤ maxConcurrentProducts (2) → COMBINATION_REQUIRED silent.
  const draft  = makeDraft('CAPSULE');
  const result = assessJustification(draft, TWO_PRODUCTS, DEFAULT_CONFIG, null);

  it('returns REVIEW_REQUIRED (DOSE_FORM is corroborating-only)', () => {
    expect(result.status).toBe('REVIEW_REQUIRED');
  });

  it('includes DOSE_FORM in reasons', () => {
    expect(result.reasons.map((r) => r.code)).toContain('DOSE_FORM');
  });

  it('does not include DELIVERY_SYSTEM (burden 2 < 6, no profile)', () => {
    expect(result.reasons.map((r) => r.code)).not.toContain('DELIVERY_SYSTEM');
  });

  it('does not include COMBINATION_REQUIRED (2 products ≤ maxConcurrentProducts 2)', () => {
    expect(result.reasons.map((r) => r.code)).not.toContain('COMBINATION_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// Unit tests for evaluateDeliverySystem directly
// ---------------------------------------------------------------------------

describe('evaluateDeliverySystem — unit tests', () => {
  /**
   * highBurdenCovering: 3-product covering set, total = 7 units > 6 threshold.
   * (Product B + A + C from Fixture 1.)
   */
  const highBurdenCovering = computeCoveringSet(SIX_ACTIVES, THREE_PRODUCTS);

  /**
   * lowBurdenCovering: 2-product covering set, total = 2 units < 6 threshold.
   * (Product D + E from Fixture 2.)
   */
  const lowBurdenCovering = computeCoveringSet(SIX_ACTIVES, TWO_PRODUCTS);

  it('returns null when burden is low and profile is null', () => {
    expect(evaluateDeliverySystem(lowBurdenCovering, null, DEFAULT_CONFIG)).toBeNull();
  });

  it('fires when swallowingDifficulty is true even with low burden', () => {
    const profile: PatientDeliveryProfile = {
      patientRef: 'PT-2026-TEST',
      swallowingDifficulty: true,
      priorNonAdherence: false,
      dexterityImpairment: false,
      recordedBy: 'prac-hash-abc',
      recordedAt: '2026-08-12T09:00:00Z',
    };
    const reason = evaluateDeliverySystem(lowBurdenCovering, profile, DEFAULT_CONFIG);
    expect(reason).not.toBeNull();
    expect(reason!.code).toBe('DELIVERY_SYSTEM');
    const detail = reason!.evidence['detail'] as Record<string, Record<string, unknown>>;
    expect(detail['PATIENT_FACTOR']['factors']).toContain('DOCUMENTED_SWALLOWING_DIFFICULTY');
  });

  it('fires PILL_BURDEN with no profile when total ≥ commercialPillBurdenThreshold', () => {
    const reason = evaluateDeliverySystem(highBurdenCovering, null, DEFAULT_CONFIG);
    expect(reason).not.toBeNull();
    expect(reason!.code).toBe('DELIVERY_SYSTEM');
    const detail = reason!.evidence['detail'] as Record<string, unknown>;
    expect(detail['PILL_BURDEN']).toBeDefined();
  });

  it('includes both grounds in detail when both fire', () => {
    const profile: PatientDeliveryProfile = {
      patientRef: 'PT-2026-TEST',
      swallowingDifficulty: false,
      priorNonAdherence: true,
      dexterityImpairment: false,
      recordedBy: 'prac-hash-abc',
      recordedAt: '2026-08-12T09:00:00Z',
    };
    const reason = evaluateDeliverySystem(highBurdenCovering, profile, DEFAULT_CONFIG);
    const detail = reason!.evidence['detail'] as Record<string, unknown>;
    expect(detail['PILL_BURDEN']).toBeDefined();
    expect(detail['PATIENT_FACTOR']).toBeDefined();
  });

  it('respects a custom commercialPillBurdenThreshold', () => {
    // lowBurdenCovering total = 2 units; threshold set to 2 → fires (2 ≥ 2).
    const strictConfig: EngineConfig = { ...DEFAULT_CONFIG, commercialPillBurdenThreshold: 2 };
    const reason = evaluateDeliverySystem(lowBurdenCovering, null, strictConfig);
    expect(reason).not.toBeNull();
    expect(reason!.code).toBe('DELIVERY_SYSTEM');
  });
});
