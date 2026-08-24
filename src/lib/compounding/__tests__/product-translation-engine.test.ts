/**
 * Product Translation Engine — unit tests
 *
 * Three fixtures:
 *   1. B6 stacking: three products all contributing Vitamin B6, asserting
 *      stacked=true, subtotal arithmetic, contributions count, and granule total.
 *   2. Over-capacity: four actives each within the per-active ceiling but whose
 *      combined count exceeds the pod capacity, asserting podFill.fits=false.
 *   3. CFU: a probiotic product with CFU units routes to PURCHASE_SEPARATELY.
 *
 * Tests use mock registry and library data so they are independent of library
 * version changes and don't load the real ingredients JSON.
 */

import { describe, it, expect } from 'vitest';
import {
  translateProducts,
  aggregateTargets,
  DEFAULT_TRANSLATION_CONFIG,
  type SelectedProduct,
  type LibraryGranuleSpec,
  type TranslationConfig,
} from '../product-translation-engine';
import type { MoietyRegistry, MoietyId } from '../moiety';
import type { CommercialMedicine, DoseForm } from '../justification-engine';

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

/** Builds a minimal MoietyRegistry stub from a name map. */
function makeRegistry(names: Record<string, string> = {}): MoietyRegistry {
  return {
    get: (id: MoietyId) => ({ canonicalName: names[id] ?? String(id) }),
    fromArtg: () => null,
  };
}

function makeLibrary(
  entries: Array<{ id: string; dosePerGranule: number; unit: 'mg' | 'mcg'; maxDailyDose?: number | null; displayName?: string }>
): Map<string, LibraryGranuleSpec> {
  const map = new Map<string, LibraryGranuleSpec>();
  for (const e of entries) {
    map.set(e.id, {
      tsiCode: e.id,
      moietyId: e.id as MoietyId,
      displayName: e.displayName ?? e.id,
      dosePerGranule: e.dosePerGranule,
      unit: e.unit,
      maxDailyDose: e.maxDailyDose ?? null,
    });
  }
  return map;
}

function makeProduct(
  artgId: string,
  name: string,
  actives: Array<{ libraryId: string; moiety: string; amount: number; unit: 'mg' | 'mcg' | 'CFU' }>,
  doseForm: DoseForm = 'CAPSULE',
): CommercialMedicine {
  return {
    artgId,
    productName: name,
    sponsor: 'TestCo',
    doseForm,
    snapshotDate: '2026-08-12',
    maxUnitsPerDay: null,
    excipients: [],
    activesPerUnit: actives.map((a) => ({
      libraryId: a.libraryId,
      moiety: a.moiety,
      amount: a.amount,
      unit: a.unit as CommercialMedicine['activesPerUnit'][0]['unit'],
    })),
  };
}

// ---------------------------------------------------------------------------
// Fixture 1: B6 stacking across three products
// ---------------------------------------------------------------------------

describe('Product Translation Engine — B6 stacking', () => {
  const B6_ID = 'W030012000';
  const REGISTRY = makeRegistry({ [B6_ID]: 'Vitamin B6 (P5P)' });
  const LIBRARY = makeLibrary([
    { id: B6_ID, dosePerGranule: 5, unit: 'mg', maxDailyDose: 50, displayName: 'Vitamin B6 (P5P)' },
  ]);

  // Three products all contributing B6:
  //   Multi B:      25 mg × 1 unit/day → subtotal 25
  //   B Complex:    10 mg × 2 units/day → subtotal 20
  //   Stress B:      5 mg × 3 units/day → subtotal 15
  //   ─────────────────────────────────────────────
  //   Total B6:    60 mg  → ceil(60 / 5) = 12 granules
  const SELECTED: SelectedProduct[] = [
    { product: makeProduct('001', 'Multi B',   [{ libraryId: B6_ID, moiety: 'Vitamin B6 (P5P)', amount: 25, unit: 'mg' }]), unitsPerDay: 1 },
    { product: makeProduct('002', 'B Complex', [{ libraryId: B6_ID, moiety: 'Vitamin B6 (P5P)', amount: 10, unit: 'mg' }]), unitsPerDay: 2 },
    { product: makeProduct('003', 'Stress B',  [{ libraryId: B6_ID, moiety: 'Vitamin B6 (P5P)', amount:  5, unit: 'mg' }]), unitsPerDay: 3 },
  ];

  it('produces a single aggregated target for B6', () => {
    const targets = aggregateTargets(SELECTED, REGISTRY);
    expect(targets).toHaveLength(1);
    expect(targets[0].moietyId).toBe(B6_ID);
    expect(targets[0].displayName).toBe('Vitamin B6 (P5P)');
  });

  it('marks stacked=true when three products contribute the same moiety', () => {
    const targets = aggregateTargets(SELECTED, REGISTRY);
    expect(targets[0].stacked).toBe(true);
  });

  it('sums the subtotals correctly: 25 + 20 + 15 = 60 mg', () => {
    const targets = aggregateTargets(SELECTED, REGISTRY);
    const b6 = targets[0];
    expect(b6.totalDose).toBe(60);

    // Each contribution's subtotal = amount × unitsPerDay
    const sortedContribs = [...b6.contributions].sort((a, b) => a.artgId.localeCompare(b.artgId));
    expect(sortedContribs[0]).toMatchObject({ artgId: '001', dosePerUnit: 25, unitsPerDay: 1, subtotal: 25 });
    expect(sortedContribs[1]).toMatchObject({ artgId: '002', dosePerUnit: 10, unitsPerDay: 2, subtotal: 20 });
    expect(sortedContribs[2]).toMatchObject({ artgId: '003', dosePerUnit:  5, unitsPerDay: 3, subtotal: 15 });
  });

  it('lists all three contributing products', () => {
    const targets = aggregateTargets(SELECTED, REGISTRY);
    expect(targets[0].contributions).toHaveLength(3);
    const ids = targets[0].contributions.map((c) => c.artgId).sort();
    expect(ids).toEqual(['001', '002', '003']);
  });

  it('computes 12 granules at 5 mg/granule for 60 mg total', () => {
    const result = translateProducts(SELECTED, REGISTRY, LIBRARY, new Map());
    const b6 = result.translated[0];
    expect(b6.tier).toBe('DIRECT');
    expect(b6.granules).toBe(12); // ceil(60 / 5)
  });

  it('fires exceedsLibraryMax when totalDose (60) exceeds maxDailyDose (50)', () => {
    const result = translateProducts(SELECTED, REGISTRY, LIBRARY, new Map());
    const b6 = result.translated[0];
    expect(b6.exceedsLibraryMax).toBe(true);
    expect(result.doseWarnings).toHaveLength(1);
    expect(result.doseWarnings[0].target.moietyId).toBe(B6_ID);
  });

  it('does NOT flag exceedsLibraryMax when maxDailyDose is null', () => {
    const unlimitedLib = makeLibrary([
      { id: B6_ID, dosePerGranule: 5, unit: 'mg', maxDailyDose: null },
    ]);
    const result = translateProducts(SELECTED, REGISTRY, unlimitedLib, new Map());
    expect(result.translated[0].exceedsLibraryMax).toBe(false);
    expect(result.doseWarnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fixture 2: Over-capacity
// ---------------------------------------------------------------------------

describe('Product Translation Engine — over-capacity pod', () => {
  // Four distinct actives, each 200 granules (< 240 per-active ceiling).
  // Total: 800 > 720 → podFill.fits = false.
  const IDS = ['W001000000', 'W002000000', 'W003000000', 'W004000000'];

  const REGISTRY = makeRegistry(Object.fromEntries(IDS.map((id, i) => [id, `Active ${i + 1}`])));
  const LIBRARY = makeLibrary(IDS.map((id, i) => ({
    id,
    dosePerGranule: 1,   // 1 mg per granule
    unit: 'mg' as const,
    maxDailyDose: null,
    displayName: `Active ${i + 1}`,
  })));

  // One product per moiety, each at 200 mg/unit, 1 unit/day → 200 granules each
  const SELECTED: SelectedProduct[] = IDS.map((id, i) => ({
    product: makeProduct(
      `P${i + 1}`,
      `Product ${i + 1}`,
      [{ libraryId: id, moiety: `Active ${i + 1}`, amount: 200, unit: 'mg' }],
    ),
    unitsPerDay: 1,
  }));

  it('fits=false when total granules (800) exceeds pod capacity (720)', () => {
    const result = translateProducts(SELECTED, REGISTRY, LIBRARY, new Map());
    expect(result.podFill.fits).toBe(false);
  });

  it('reports totalGranules as 800', () => {
    const result = translateProducts(SELECTED, REGISTRY, LIBRARY, new Map());
    expect(result.podFill.totalGranules).toBe(800);
  });

  it('utilisationFraction is 800/720 ≈ 1.1111', () => {
    const result = translateProducts(SELECTED, REGISTRY, LIBRARY, new Map());
    expect(result.podFill.utilisationFraction).toBeGreaterThan(1);
  });

  it('all four actives translate as DIRECT (each within per-active ceiling of 240)', () => {
    const result = translateProducts(SELECTED, REGISTRY, LIBRARY, new Map());
    for (const t of result.translated) {
      expect(t.tier).toBe('DIRECT');
      expect(t.granules).toBe(200);
    }
  });

  it('routes to PURCHASE_SEPARATELY when a single active exceeds maxGranulesPerActive', () => {
    // Override: one active at 300 granules (> ceiling 240) → PURCHASE_SEPARATELY
    const highDoseSelected: SelectedProduct[] = [
      {
        product: makeProduct('HP1', 'High Dose', [{ libraryId: IDS[0], moiety: 'Active 1', amount: 300, unit: 'mg' }]),
        unitsPerDay: 1,
      },
    ];
    const result = translateProducts(highDoseSelected, REGISTRY, LIBRARY, new Map());
    expect(result.purchaseSeparately).toHaveLength(1);
    expect(result.purchaseSeparately[0].tier).toBe('PURCHASE_SEPARATELY');
    expect(result.purchaseSeparately[0].granules).toBe(300);
  });

  it('custom config: reduced capacity of 100 makes 200-granule single active over-capacity', () => {
    const tightConfig: TranslationConfig = { ...DEFAULT_TRANSLATION_CONFIG, podCapacity: 100 };
    const singleSelected: SelectedProduct[] = [
      {
        product: makeProduct('P1', 'Product 1', [{ libraryId: IDS[0], moiety: 'Active 1', amount: 200, unit: 'mg' }]),
        unitsPerDay: 1,
      },
    ];
    // 200 granules with 240 per-active ceiling: not rerouted, but pod overflows
    const result = translateProducts(singleSelected, REGISTRY, LIBRARY, new Map(), tightConfig);
    expect(result.podFill.fits).toBe(false);
    expect(result.podFill.totalGranules).toBe(200);
    expect(result.podFill.capacity).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Fixture 3: CFU → PURCHASE_SEPARATELY
// ---------------------------------------------------------------------------

describe('Product Translation Engine — CFU routes to PURCHASE_SEPARATELY', () => {
  const CFU_ID = 'W099001000';
  const REGISTRY = makeRegistry({ [CFU_ID]: 'Lactobacillus acidophilus' });

  // No library entry for the CFU moiety — the unit check fires first in translateActive
  const EMPTY_LIBRARY = new Map<string, LibraryGranuleSpec>();

  const CFU_PRODUCT = makeProduct(
    '100009',
    'Probiotic 50B',
    [{ libraryId: CFU_ID, moiety: 'Lactobacillus acidophilus', amount: 25_000_000_000, unit: 'CFU' }],
    'CAPSULE',
  );

  const SELECTED: SelectedProduct[] = [{ product: CFU_PRODUCT, unitsPerDay: 1 }];

  it('tier is PURCHASE_SEPARATELY', () => {
    const result = translateProducts(SELECTED, REGISTRY, EMPTY_LIBRARY, new Map());
    expect(result.purchaseSeparately).toHaveLength(1);
    expect(result.purchaseSeparately[0].tier).toBe('PURCHASE_SEPARATELY');
  });

  it('note mentions CFU', () => {
    const result = translateProducts(SELECTED, REGISTRY, EMPTY_LIBRARY, new Map());
    expect(result.purchaseSeparately[0].note).toMatch(/CFU/);
  });

  it('granules is null for CFU active', () => {
    const result = translateProducts(SELECTED, REGISTRY, EMPTY_LIBRARY, new Map());
    expect(result.purchaseSeparately[0].granules).toBeNull();
  });

  it('pod contains zero granules', () => {
    const result = translateProducts(SELECTED, REGISTRY, EMPTY_LIBRARY, new Map());
    expect(result.podFill.totalGranules).toBe(0);
    expect(result.podFill.fits).toBe(true);
  });

  it('single-active aggregated target has stacked=false', () => {
    const result = translateProducts(SELECTED, REGISTRY, EMPTY_LIBRARY, new Map());
    expect(result.targets[0].stacked).toBe(false);
    expect(result.targets[0].contributions).toHaveLength(1);
  });

  it('CFU unit check fires even when library has an entry for the moiety', () => {
    // Give the CFU moiety a library entry — the unit check must still win
    const cfuLibrary = makeLibrary([
      { id: CFU_ID, dosePerGranule: 1, unit: 'mg', displayName: 'Lactobacillus acidophilus' },
    ]);
    const result = translateProducts(SELECTED, REGISTRY, cfuLibrary, new Map());
    expect(result.purchaseSeparately[0].tier).toBe('PURCHASE_SEPARATELY');
    // library entry not selected because non-granulable check fires first
    expect(result.purchaseSeparately[0].library).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fixture 4: unresolved source actives from unmatchedActiveNames
// ---------------------------------------------------------------------------

describe('Product Translation Engine — unresolvedSourceActives', () => {
  const D3_ID = 'W030005000';
  const REGISTRY = makeRegistry({ [D3_ID]: 'Vitamin D3' });
  const LIBRARY = makeLibrary([
    { id: D3_ID, dosePerGranule: 0.025, unit: 'mcg', displayName: 'Vitamin D3' },
  ]);

  it('surfaces unmatched ARTG actives from unmatchedActiveNames', () => {
    const partialProduct: CommercialMedicine = {
      artgId: '100056',
      productName: 'Omega3 + D3',
      sponsor: 'Nordic Naturals',
      doseForm: 'SOFT_CAPSULE',
      snapshotDate: '2026-08-12',
      maxUnitsPerDay: null,
      excipients: [],
      activesPerUnit: [
        { libraryId: D3_ID, moiety: 'Vitamin D3', amount: 25, unit: 'mcg' },
      ],
      unmatchedActiveCount: 2,
      unmatchedActiveNames: ['eicosapentaenoic acid', 'docosahexaenoic acid'],
    };

    const result = translateProducts(
      [{ product: partialProduct, unitsPerDay: 1 }],
      REGISTRY,
      LIBRARY,
      new Map(),
    );

    expect(result.unresolvedSourceActives).toHaveLength(2);
    expect(result.unresolvedSourceActives.map((u) => u.ingredientName)).toEqual(
      expect.arrayContaining(['eicosapentaenoic acid', 'docosahexaenoic acid']),
    );
    expect(result.unresolvedSourceActives[0].artgId).toBe('100056');
  });
});

// ---------------------------------------------------------------------------
// Fixture 5: UNAVAILABLE tier — no library entry, no class alternatives
// ---------------------------------------------------------------------------

describe('Product Translation Engine — UNAVAILABLE tier', () => {
  const EXOTIC_ID = 'W000000001';
  const REGISTRY = makeRegistry({ [EXOTIC_ID]: 'Exotic Compound X' });
  const EMPTY_LIBRARY = new Map<string, LibraryGranuleSpec>();

  it('tier is UNAVAILABLE when neither library nor classAlternatives has the moiety', () => {
    const product = makeProduct('EX1', 'Exotic Supp', [
      { libraryId: EXOTIC_ID, moiety: 'Exotic Compound X', amount: 100, unit: 'mg' },
    ]);
    const result = translateProducts([{ product, unitsPerDay: 1 }], REGISTRY, EMPTY_LIBRARY, new Map());
    expect(result.unavailable).toHaveLength(1);
    expect(result.unavailable[0].tier).toBe('UNAVAILABLE');
  });

  it('tier is CLASS_SUBSTITUTION when classAlternatives has an entry', () => {
    const ALT_ID = 'W000000002';
    const altSpec: LibraryGranuleSpec = {
      tsiCode: ALT_ID,
      moietyId: ALT_ID as MoietyId,
      displayName: 'Alternative Compound Y',
      dosePerGranule: 10,
      unit: 'mg',
      maxDailyDose: null,
    };
    const classAlts = new Map<string, LibraryGranuleSpec[]>([[EXOTIC_ID, [altSpec]]]);
    const product = makeProduct('EX1', 'Exotic Supp', [
      { libraryId: EXOTIC_ID, moiety: 'Exotic Compound X', amount: 100, unit: 'mg' },
    ]);
    const result = translateProducts([{ product, unitsPerDay: 1 }], REGISTRY, EMPTY_LIBRARY, classAlts);
    expect(result.requiresConfirmation).toHaveLength(1);
    expect(result.requiresConfirmation[0].tier).toBe('CLASS_SUBSTITUTION');
    expect(result.requiresConfirmation[0].proposedAlternatives).toHaveLength(1);
    // granules is null — CLASS_SUBSTITUTION never auto-applies
    expect(result.requiresConfirmation[0].granules).toBeNull();
  });
});
