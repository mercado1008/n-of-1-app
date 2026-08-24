#!/usr/bin/env npx tsx
/**
 * scripts/backtest-justification.ts
 *
 * Run the compounding justification engine against a batch of draft
 * formulations and report aggregate statistics.
 *
 * Usage:
 *   npx tsx scripts/backtest-justification.ts [candidates.json]
 *
 * Arguments:
 *   candidates.json  Path to a JSON file containing an array of
 *                    CommercialMedicine objects (ARTG export format).
 *                    When provided, every draft is assessed against this
 *                    shared pool.  When omitted, the script stubs from
 *                    the test fixtures until the real ARTG export lands.
 *
 * Output:
 *   - % JUSTIFIED vs REVIEW_REQUIRED
 *   - Which justification codes appear in JUSTIFIED results (and how often)
 *   - DELIVERY_SYSTEM breakdown: PILL_BURDEN / TITRATION_GRANULARITY / PATIENT_FACTOR
 *   - Histogram of commercial units/day across all PILL_BURDEN assessments
 *
 * Cost: zero — no Claude calls.  Reads from local JSON only.
 *
 * Stub mode:
 *   Each stub case carries its own curated candidate pool.  In real mode, a
 *   single shared pool is used for every draft.  This mirrors production: the
 *   ARTG export is one pool; the backtest iterates drafts against it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assessJustification,
  DEFAULT_CONFIG,
  type JustificationAssessment,
  type DraftFormulation,
  type CommercialMedicine,
  type NormalisedActive,
} from '../src/lib/compounding/justification-engine';

// ---------------------------------------------------------------------------
// BacktestCase — one draft with its associated candidate pool
// ---------------------------------------------------------------------------

interface BacktestCase {
  draft: DraftFormulation;
  /** Candidates relevant to this draft. One shared pool in real mode. */
  candidates: CommercialMedicine[];
}

// ---------------------------------------------------------------------------
// ARTG candidate source
// ---------------------------------------------------------------------------

function loadCandidates(filePath: string): CommercialMedicine[] {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  if (Array.isArray(raw)) return raw as CommercialMedicine[];
  if (Array.isArray(raw.candidates)) return raw.candidates as CommercialMedicine[];
  throw new Error(
    `candidates.json must contain a top-level array or { candidates: [...] } — got ${typeof raw}`,
  );
}

// ---------------------------------------------------------------------------
// Stub data (used when no candidates.json is supplied)
// ---------------------------------------------------------------------------

/**
 * Six-active panel: Mg 500 mg, Zn 15 mg, Se 200 mcg, D3 25 mcg,
 * Folate 800 mcg, B6 50 mg.
 */
function sixActives(): NormalisedActive[] {
  return [
    { libraryId: 'W040002000', moiety: 'Magnesium (elemental)',  amount: 500,  unit: 'mg'  },
    { libraryId: 'W040008000', moiety: 'Zinc (elemental)',        amount: 15,   unit: 'mg'  },
    { libraryId: 'W040009000', moiety: 'Selenium (elemental)',    amount: 200,  unit: 'mcg' },
    { libraryId: 'W030005000', moiety: 'Cholecalciferol',          amount: 25,   unit: 'mcg' },
    { libraryId: 'W020007000', moiety: 'Folate (as methylfolate)', amount: 800,  unit: 'mcg' },
    { libraryId: 'W020003000', moiety: 'Pyridoxal-5-phosphate',   amount: 50,   unit: 'mg'  },
  ];
}

/**
 * Three TABLET products — high pill burden (7 units across 3 products).
 *
 *   Product A: Mg 150 mg + Zn 15 mg + Se 100 mcg/tab
 *     per-moiety max: max(ceil(500/150)=4, ceil(15/15)=1, ceil(200/100)=2) = 4
 *   Product B: D3 25 mcg + Folate 400 mcg/tab
 *     per-moiety max: max(ceil(25/25)=1, ceil(800/400)=2) = 2
 *   Product C: B6 50 mg/tab
 *     per-moiety max: ceil(50/50) = 1
 *   Total: 4 + 2 + 1 = 7 > commercialPillBurdenThreshold (6)
 *
 * Covering set: A (Mg/Zn/Se), B (D3/Folate), C (B6) — 3 products.
 */
function threeProducts(): CommercialMedicine[] {
  const SNAPSHOT = '2026-08-12';
  return [
    {
      artgId: 'ARTG-2001',
      productName: 'MultiMin Mg/Zn/Se 150 Tablet',
      sponsor: 'Example Pharma Pty Ltd',
      doseForm: 'TABLET',
      activesPerUnit: [
        { libraryId: 'W040002000', moiety: 'Magnesium (elemental)',  amount: 150, unit: 'mg'  },
        { libraryId: 'W040008000', moiety: 'Zinc (elemental)',        amount: 15,  unit: 'mg'  },
        { libraryId: 'W040009000', moiety: 'Selenium (elemental)',    amount: 100, unit: 'mcg' },
      ],
      maxUnitsPerDay: 8,
      excipients: ['microcrystalline cellulose', 'magnesium stearate'],
      snapshotDate: SNAPSHOT,
    },
    {
      artgId: 'ARTG-2002',
      productName: 'VitaD Folate 400 Tablet',
      sponsor: 'Example Pharma Pty Ltd',
      doseForm: 'TABLET',
      activesPerUnit: [
        { libraryId: 'W030005000', moiety: 'Cholecalciferol',          amount: 25,  unit: 'mcg' },
        { libraryId: 'W020007000', moiety: 'Folate (as methylfolate)', amount: 400, unit: 'mcg' },
      ],
      maxUnitsPerDay: 4,
      excipients: ['lactose monohydrate', 'colloidal anhydrous silica'],
      snapshotDate: SNAPSHOT,
    },
    {
      artgId: 'ARTG-2003',
      productName: 'B6 Active 50 Tablet',
      sponsor: 'Example Pharma Pty Ltd',
      doseForm: 'TABLET',
      activesPerUnit: [
        { libraryId: 'W020003000', moiety: 'Pyridoxal-5-phosphate', amount: 50, unit: 'mg' },
      ],
      maxUnitsPerDay: 4,
      excipients: ['microcrystalline cellulose'],
      snapshotDate: SNAPSHOT,
    },
  ] as CommercialMedicine[];
}

/**
 * Two TABLET products — exact single-unit dosing, low pill burden (2 units).
 *
 *   Product D: Mg 500 mg + Zn 15 mg/tab  → max 1 unit
 *   Product E: Se 200 mcg + D3 25 mcg + Folate 800 mcg + B6 50 mg/tab → max 1 unit
 *   Total: 1 + 1 = 2 < commercialPillBurdenThreshold (6)
 *
 * Covering set: D + E — 2 products (≤ maxConcurrentProducts 2).
 */
function twoProducts(): CommercialMedicine[] {
  const SNAPSHOT = '2026-08-12';
  return [
    {
      artgId: 'ARTG-2004',
      productName: 'MagZinc Complete Tablet',
      sponsor: 'Example Pharma Pty Ltd',
      doseForm: 'TABLET',
      activesPerUnit: [
        { libraryId: 'W040002000', moiety: 'Magnesium (elemental)', amount: 500, unit: 'mg' },
        { libraryId: 'W040008000', moiety: 'Zinc (elemental)',       amount: 15,  unit: 'mg' },
      ],
      maxUnitsPerDay: 2,
      excipients: ['microcrystalline cellulose', 'magnesium stearate'],
      snapshotDate: SNAPSHOT,
    },
    {
      artgId: 'ARTG-2005',
      productName: 'MultiVit Antioxidant Complex Tablet',
      sponsor: 'Example Pharma Pty Ltd',
      doseForm: 'TABLET',
      activesPerUnit: [
        { libraryId: 'W040009000', moiety: 'Selenium (elemental)',    amount: 200, unit: 'mcg' },
        { libraryId: 'W030005000', moiety: 'Cholecalciferol',          amount: 25,  unit: 'mcg' },
        { libraryId: 'W020007000', moiety: 'Folate (as methylfolate)', amount: 800, unit: 'mcg' },
        { libraryId: 'W020003000', moiety: 'Pyridoxal-5-phosphate',   amount: 50,  unit: 'mg'  },
      ],
      maxUnitsPerDay: 2,
      excipients: ['lactose monohydrate', 'colloidal anhydrous silica'],
      snapshotDate: SNAPSHOT,
    },
  ] as CommercialMedicine[];
}

/**
 * Stub cases with curated per-case candidate pools.
 *
 * Case 1: TABLET required, 3-product covering set
 *         → PILL_BURDEN fires (7 > 6) + COMBINATION_REQUIRED fires (3 > 2) → JUSTIFIED
 * Case 2: CAPSULE required, 2-product exact-match covering set
 *         → DOSE_FORM fires only (corroborating) → REVIEW_REQUIRED
 */
function stubCases(): BacktestCase[] {
  const actives = sixActives();
  return [
    {
      draft: {
        draftId: 'stub-draft-001',
        patientRef: 'PT-BACKTEST-001',
        practitionerId: 'prac-hash-stub',
        requiredDoseForm: 'TABLET',
        targetActives: actives,
        exclusions: [],
      },
      candidates: threeProducts(),
    },
    {
      draft: {
        draftId: 'stub-draft-002',
        patientRef: 'PT-BACKTEST-002',
        practitionerId: 'prac-hash-stub',
        requiredDoseForm: 'CAPSULE',
        targetActives: actives,
        exclusions: [],
      },
      candidates: twoProducts(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Report helpers
// ---------------------------------------------------------------------------

function tally<K extends string>(keys: K[], items: K[]): Record<K, number> {
  const counts = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const item of items) {
    if (item in counts) counts[item]++;
  }
  return counts;
}

function histogramLine(value: number, maxValue: number, barWidth = 20): string {
  const filled = maxValue > 0 ? Math.round((value / maxValue) * barWidth) : 0;
  return '█'.repeat(filled) + '░'.repeat(barWidth - filled);
}

function pct(n: number, total: number): string {
  return total === 0 ? '—' : `${((n / total) * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const candidatePath = process.argv[2];

  let cases: BacktestCase[];

  if (candidatePath) {
    // Real mode: one shared pool for all drafts.
    const sharedCandidates = loadCandidates(resolve(process.cwd(), candidatePath));
    // When real candidates are loaded, stub drafts are run against the real pool.
    const drafts = stubCases().map((c) => c.draft);
    cases = drafts.map((draft) => ({ draft, candidates: sharedCandidates }));
    console.log('');
    console.log('  NOTE: Stub drafts used with real candidate pool.');
    console.log('        In production, load real draft formulations here too.');
  } else {
    cases = stubCases();
  }

  const assessments: JustificationAssessment[] = cases.map(({ draft, candidates }) =>
    assessJustification(draft, candidates, DEFAULT_CONFIG, null),
  );

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  N of 1 Compounding Justification — Backtest Report');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`  Candidates: ${candidatePath ? `from ${candidatePath}` : 'stub data (curated per case)'}`);
  console.log(`  Drafts:     ${assessments.length}${candidatePath ? '' : ' (stub)'}`);
  console.log('');

  // ── Overall status split ─────────────────────────────────────────────────
  const justified      = assessments.filter((a) => a.status === 'JUSTIFIED');
  const reviewRequired = assessments.filter((a) => a.status === 'REVIEW_REQUIRED');
  const total = assessments.length;

  console.log('  ┌─ Status breakdown ────────────────────────────────────────┐');
  console.log(`  │  JUSTIFIED:       ${justified.length.toString().padStart(4)}  (${pct(justified.length, total).padStart(6)})                       │`);
  console.log(`  │  REVIEW_REQUIRED: ${reviewRequired.length.toString().padStart(4)}  (${pct(reviewRequired.length, total).padStart(6)})                       │`);
  console.log(`  │  Total:           ${total.toString().padStart(4)}                                  │`);
  console.log('  └───────────────────────────────────────────────────────────┘');
  console.log('');

  // ── Reason code frequency in JUSTIFIED assessments ───────────────────────
  const ALL_CODES = [
    'DOSE_FORM',
    'DOSE_OUTSIDE_AVAILABLE_STRENGTHS',
    'COMBINATION_REQUIRED',
    'INGREDIENT_EXCLUSION',
    'DELIVERY_SYSTEM',
  ] as const;

  const justifiedCodes = justified.flatMap((a) => a.reasons.map((r) => r.code));
  const codeCounts = tally([...ALL_CODES], justifiedCodes);
  const maxCodeCount = Math.max(1, ...Object.values(codeCounts));

  console.log('  ┌─ Justification codes (JUSTIFIED assessments) ─────────────┐');
  for (const code of ALL_CODES) {
    const n = codeCounts[code];
    const bar = histogramLine(n, maxCodeCount, 16);
    console.log(`  │  ${code.padEnd(34)} ${n.toString().padStart(3)}  ${bar}  │`);
  }
  console.log('  └───────────────────────────────────────────────────────────┘');
  console.log('');

  // ── DELIVERY_SYSTEM ground breakdown ─────────────────────────────────────
  const dsReasons = justified
    .flatMap((a) => a.reasons)
    .filter((r) => r.code === 'DELIVERY_SYSTEM');

  const dsGrounds = dsReasons.flatMap((r) => {
    const detail = r.evidence['detail'] as Record<string, unknown> | undefined;
    return detail ? Object.keys(detail) : [];
  });

  const DS_GROUNDS = ['PILL_BURDEN', 'TITRATION_GRANULARITY', 'PATIENT_FACTOR'] as const;
  const groundCounts = tally([...DS_GROUNDS], dsGrounds);
  const maxGroundCount = Math.max(1, ...Object.values(groundCounts));

  console.log('  ┌─ DELIVERY_SYSTEM ground breakdown ────────────────────────┐');
  for (const ground of DS_GROUNDS) {
    const n = groundCounts[ground];
    const bar = histogramLine(n, maxGroundCount, 16);
    console.log(`  │  ${ground.padEnd(26)} ${n.toString().padStart(3)}  ${bar}          │`);
  }
  console.log('  └───────────────────────────────────────────────────────────┘');
  console.log('');

  // ── Commercial units/day histogram (PILL_BURDEN assessments) ─────────────
  const pillBurdenData: number[] = dsReasons.flatMap((r) => {
    const detail = r.evidence['detail'] as Record<string, unknown> | undefined;
    if (!detail?.['PILL_BURDEN']) return [];
    const pb = detail['PILL_BURDEN'] as Record<string, unknown>;
    const units = pb['commercialUnitsPerDay'];
    return typeof units === 'number' ? [units] : [];
  });

  if (pillBurdenData.length > 0) {
    const minUnits = Math.min(...pillBurdenData);
    const maxUnits = Math.max(...pillBurdenData);
    const BIN_WIDTH = 2;
    const minBin = Math.floor(minUnits / BIN_WIDTH) * BIN_WIDTH;
    const maxBin = Math.ceil(maxUnits / BIN_WIDTH) * BIN_WIDTH;
    const bins: Map<number, number> = new Map();
    for (let b = minBin; b <= maxBin; b += BIN_WIDTH) bins.set(b, 0);
    for (const u of pillBurdenData) {
      const b = Math.floor(u / BIN_WIDTH) * BIN_WIDTH;
      bins.set(b, (bins.get(b) ?? 0) + 1);
    }
    const maxBinCount = Math.max(1, ...bins.values());

    console.log('  ┌─ Commercial units/day histogram (PILL_BURDEN only) ────────┐');
    for (const [b, count] of bins) {
      const label = `${b}–${b + BIN_WIDTH - 1}`.padEnd(6);
      const bar = histogramLine(count, maxBinCount, 16);
      console.log(`  │  ${label}  ${count.toString().padStart(3)}  ${bar}            │`);
    }
    console.log(`  │  threshold: ${DEFAULT_CONFIG.commercialPillBurdenThreshold} units/day                              │`);
    console.log('  └───────────────────────────────────────────────────────────┘');
    console.log('');
  }

  // ── Per-draft detail ──────────────────────────────────────────────────────
  console.log('  ┌─ Per-draft detail ─────────────────────────────────────────┐');
  for (const assessment of assessments) {
    const codes = assessment.reasons.map((r) => r.code).join(', ') || '(none)';
    const statusPad = assessment.status === 'JUSTIFIED' ? 'JUSTIFIED      ' : 'REVIEW_REQUIRED';
    console.log(`  │  ${assessment.draftId.padEnd(22)}  ${statusPad}  ${codes}`);
  }
  console.log('  └───────────────────────────────────────────────────────────┘');
  console.log('');
}

main();
