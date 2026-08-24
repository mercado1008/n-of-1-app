/**
 * Justification engine — dataQualityNotes unit tests.
 *
 * Verifies that `assessJustification` surfaces a PARTIAL_MATCH_PRODUCT note
 * when a product selected into the greedy covering set has unmatched actives
 * (i.e. `unmatchedActiveCount > 0`).
 *
 * The fixture uses a minimal candidate pool that forces the partial-match
 * product into the covering set by making it the only product that covers the
 * target active. This is the canonical way to guarantee the greedy algorithm
 * selects a specific product without relying on pool ordering.
 */

import { describe, it, expect } from 'vitest';
import {
  assessJustification,
  DEFAULT_CONFIG,
  type CommercialMedicine,
  type DraftFormulation,
} from '../justification-engine';

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

const SNAPSHOT = '2026-08-12';

/** A Vitamin D3 target at 25 mcg/day. */
const D3_TARGET: DraftFormulation['targetActives'][0] = {
  libraryId: 'W030005000',
  moiety: 'Vitamin D3',
  amount: 25,
  unit: 'mcg',
};

/**
 * ARTG 100056 — Omega3 + D3 (Soft capsule).
 * Has Vitamin D3 matched, EPA + DHA unmatched (no registry moiety for fish-oil
 * fatty acids in the library). This is the canonical partial-match test product.
 */
const PARTIAL_MATCH_PRODUCT: CommercialMedicine = {
  artgId: '100056',
  productName: 'Omega3 + D3',
  sponsor: 'Nordic Naturals',
  doseForm: 'SOFT_CAPSULE',
  snapshotDate: SNAPSHOT,
  maxUnitsPerDay: null,
  excipients: [],
  activesPerUnit: [
    { libraryId: 'W030005000', moiety: 'Vitamin D3', amount: 25, unit: 'mcg' },
    // EPA and DHA are intentionally absent — they were not matched during ingest
  ],
  unmatchedActiveCount: 2,
  unmatchedActiveNames: ['eicosapentaenoic acid', 'docosahexaenoic acid'],
};

/**
 * ARTG 100002 — Vitamin D3 1000IU (Tablet).
 * Fully matched product — no unmatched actives. Present in the multi-product
 * tests to verify notes only fire when the partial-match product lands in
 * the covering set.
 */
const CLEAN_D3_PRODUCT: CommercialMedicine = {
  artgId: '100002',
  productName: 'Vitamin D3 1000IU',
  sponsor: 'Blackmores',
  doseForm: 'TABLET',
  snapshotDate: SNAPSHOT,
  maxUnitsPerDay: null,
  excipients: [],
  activesPerUnit: [
    { libraryId: 'W030005000', moiety: 'Vitamin D3', amount: 25, unit: 'mcg' },
  ],
  unmatchedActiveCount: 0,
  unmatchedActiveNames: [],
};

function makeDraft(overrides: Partial<DraftFormulation> = {}): DraftFormulation {
  return {
    draftId: 'TEST-DQ-001',
    patientRef: 'P-TEST',
    practitionerId: 'PR-TEST',
    requiredDoseForm: 'SOFT_CAPSULE',
    targetActives: [D3_TARGET],
    exclusions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('assessJustification — dataQualityNotes', () => {
  it('emits one PARTIAL_MATCH_PRODUCT note when the only covering product has unmatched actives', () => {
    const draft = makeDraft();
    // Pool contains ONLY the partial-match product → greedy algorithm must select it
    const candidates: CommercialMedicine[] = [PARTIAL_MATCH_PRODUCT];

    const result = assessJustification(draft, candidates, DEFAULT_CONFIG, null);

    expect(result.dataQualityNotes).toHaveLength(1);
    const note = result.dataQualityNotes[0];

    expect(note.kind).toBe('PARTIAL_MATCH_PRODUCT');
    expect(note.artgId).toBe('100056');
    expect(note.productName).toBe('Omega3 + D3');
    expect(note.unmatchedActiveNames).toEqual(
      expect.arrayContaining(['eicosapentaenoic acid', 'docosahexaenoic acid']),
    );
    expect(note.unmatchedActiveNames).toHaveLength(2);
    // Note must mention bias direction
    expect(note.note).toMatch(/COMBINATION_REQUIRED/);
  });

  it('does NOT emit a note when the covering product has zero unmatched actives', () => {
    const draft = makeDraft({ requiredDoseForm: 'TABLET' });
    // Only the clean (fully-matched) D3 tablet in the pool
    const candidates: CommercialMedicine[] = [CLEAN_D3_PRODUCT];

    const result = assessJustification(draft, candidates, DEFAULT_CONFIG, null);

    expect(result.dataQualityNotes).toHaveLength(0);
  });

  it('does NOT emit a note when the clean product covers the target (partial-match product bypassed by greedy algorithm)', () => {
    const draft = makeDraft({ requiredDoseForm: 'TABLET' });
    // Clean D3 tablet is TABLET, partial-match is SOFT_CAPSULE.
    // Draft requires TABLET → DOSE_FORM fires for soft-cap → both D3 products are
    // actually in the pool but the clean tablet is preferred by the greedy algorithm
    // because it matches the dose-form filter first.
    // This test asserts that notes do not fire when the partial-match product
    // is NOT selected into the covering set.
    const candidates: CommercialMedicine[] = [CLEAN_D3_PRODUCT, PARTIAL_MATCH_PRODUCT];

    const result = assessJustification(draft, candidates, DEFAULT_CONFIG, null);

    // CLEAN_D3_PRODUCT covers D3 at TABLET → greedy picks it → no note
    expect(result.dataQualityNotes).toHaveLength(0);
  });

  it('note content: `unmatchedActiveCount` field matches names array length', () => {
    // Regression guard: if someone sets unmatchedActiveCount to a different value
    // from unmatchedActiveNames.length, the note should still reflect names length.
    const skewedProduct: CommercialMedicine = {
      ...PARTIAL_MATCH_PRODUCT,
      unmatchedActiveCount: 99,            // intentionally wrong
      unmatchedActiveNames: ['eicosapentaenoic acid'],  // 1 name, not 99
    };
    const draft = makeDraft();

    const result = assessJustification(draft, [skewedProduct], DEFAULT_CONFIG, null);

    expect(result.dataQualityNotes).toHaveLength(1);
    // The engine uses unmatchedActiveNames (the source of truth)
    expect(result.dataQualityNotes[0].unmatchedActiveNames).toHaveLength(1);
  });

  it('does NOT emit a note when pool is empty (no candidates at all)', () => {
    const draft = makeDraft();
    const result = assessJustification(draft, [], DEFAULT_CONFIG, null);

    // COMBINATION_REQUIRED fires (no commercial product exists), but no
    // partial-match product was ever in the covering set → no data quality note.
    expect(result.dataQualityNotes).toHaveLength(0);
    expect(result.status).toBe('JUSTIFIED');
  });

  it('emits a note for each partial-match product selected into the covering set', () => {
    // Two actives: Vitamin D3 + Coenzyme Q10. Each covered by a different partial-match product.
    const partialCoQ10: CommercialMedicine = {
      artgId: '100099',
      productName: 'CoQ10 Complex',
      sponsor: 'TestCo',
      doseForm: 'SOFT_CAPSULE',
      snapshotDate: SNAPSHOT,
      maxUnitsPerDay: null,
      excipients: [],
      activesPerUnit: [
        { libraryId: 'W030021000', moiety: 'Coenzyme Q10', amount: 100, unit: 'mg' },
      ],
      unmatchedActiveCount: 1,
      unmatchedActiveNames: ['tocotrienol complex'],
    };
    const draft: DraftFormulation = {
      draftId: 'TEST-DQ-002',
      patientRef: 'P-TEST',
      practitionerId: 'PR-TEST',
      requiredDoseForm: 'SOFT_CAPSULE',
      targetActives: [
        D3_TARGET,
        { libraryId: 'W030021000', moiety: 'Coenzyme Q10', amount: 100, unit: 'mg' },
      ],
      exclusions: [],
    };
    // Neither product covers both actives → greedy selects both
    const candidates: CommercialMedicine[] = [PARTIAL_MATCH_PRODUCT, partialCoQ10];

    const result = assessJustification(draft, candidates, DEFAULT_CONFIG, null);

    // COMBINATION_REQUIRED fires (2 products needed), AND both have unmatched actives
    const noteIds = result.dataQualityNotes.map(n => n.artgId).sort();
    expect(noteIds).toEqual(['100056', '100099'].sort());
    expect(result.dataQualityNotes).toHaveLength(2);
  });
});
