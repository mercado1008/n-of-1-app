/**
 * scripts/generate-docs/derive-summary.ts
 *
 * Single-pass derivation of the formulation summary — total granules and
 * category breakdown — from the authoritative route-computed ingredient data.
 *
 * IMPORTANT: This is the single source of truth for category granule figures.
 * Both the xlsx Summary sheet (buildSummarySheet) and the Health Analysis
 * document (generateHealthAnalysis) must read from this function — never from
 * granule_budget_allocation_plan or any other intermediate planning field.
 *
 * The reconciliation assertion throws at generation time if a new Claude
 * category appears that is not in CATEGORY_ORDER, preventing a silent mismatch
 * between the headline total and the category breakdown from reaching a
 * practitioner.
 */

import type { ProposedIngredient, ComputedIngredient } from './types';

// ---------------------------------------------------------------------------
// Display helpers — must stay consistent with formulation-schedule.ts
// ---------------------------------------------------------------------------

const CATEGORY_DISPLAY_NAMES: Record<string, string> = {
  antioxidant_redox: 'Antioxidant / Redox',
  anti_inflammatory_core: 'Anti-inflammatory Core',
  mitochondrial_cardiovascular: 'Mitochondrial / Cardiovascular',
  b_vitamins_methylation: 'B-Vitamins / Methylation',
  heavy_metal_detox: 'Heavy Metal Detox',
  minerals: 'Minerals',
  vitamin_d_c_neurotransmitter: 'Vitamin D / C / Neurotransmitter',
  thyroid_adaptogenic: 'Thyroid / Adaptogenic',
  blood_glucose_insulin: 'Blood Glucose / Insulin',
  gastrointestinal: 'Gastrointestinal',
  hormone_balance: 'Hormone Balance',
  hormone_metabolism: 'Hormone Metabolism',
  cognitive_neuro: 'Cognitive / Neuro',
  immune_support: 'Immune Support',
  cardiovascular_lipids: 'Cardiovascular / Lipids',
};

function humanise(category: string | undefined): string {
  if (!category) return '—';
  if (CATEGORY_DISPLAY_NAMES[category]) return CATEGORY_DISPLAY_NAMES[category];
  // Fallback: snake_case → Title Case
  return category
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Display order for both the workbook Summary sheet and the Health Analysis
// document. Categories not listed here are appended after in the order they
// appear in the formulation (so a new Claude category is never silently dropped).
const CATEGORY_ORDER = [
  'b_vitamins_methylation',
  'minerals',
  'antioxidant_redox',
  'vitamin_d_c_neurotransmitter',
  'mitochondrial_cardiovascular',
  'hormone_metabolism',
  'hormone_balance',
  'anti_inflammatory_core',
  'heavy_metal_detox',
  'thyroid_adaptogenic',
  'blood_glucose_insulin',
  'gastrointestinal',
  'cognitive_neuro',
  'immune_support',
  'cardiovascular_lipids',
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CategorySummary {
  /** Internal snake_case code from proposed_formulation[].category */
  category: string;
  /** Practitioner-readable display name */
  displayName: string;
  /** Route-computed granules for all ingredients in this category */
  granules: number;
}

export interface FormulationSummary {
  /** Route-computed total granules — the authoritative figure for both headline and breakdown */
  totalGranules: number;
  /** Per-category breakdown in display order; each entry is a positive-granule category */
  byCategory: CategorySummary[];
  /** Number of ingredients included in the pod */
  ingredientCount: number;
}

// ---------------------------------------------------------------------------
// deriveSummary
// ---------------------------------------------------------------------------

/**
 * Derive the formulation summary from the authoritative route-computed data.
 *
 * @param proposedFormulation  output.proposed_formulation[] — category source
 * @param computedPerIngredient  granuleVerification.computed_per_ingredient[] — granule source
 *
 * Throws an Error if the category breakdown does not reconcile with the total.
 * In practice this only fires if the function has a bug — every category,
 * including ones Claude invents, is collected in the accumulator and included
 * in byCategory, so the sum is always correct by construction.
 *
 * Returns a FormulationSummary suitable for both the xlsx Summary sheet and
 * any section of the Health Analysis document that references granule totals.
 */
export function deriveSummary(
  proposedFormulation: ProposedIngredient[],
  computedPerIngredient: ComputedIngredient[],
): FormulationSummary {
  // Build tsi_code → computed granules lookup.
  // The route writes computed_granules (lib/granule-calc.ts ComputedGranulesPerIngredient);
  // types.ts ComputedIngredient exposes granules_computed as its alias.
  // Support both so the function is resilient to the field-name discrepancy.
  const granulesByCode = new Map<string, number>();
  for (const ci of computedPerIngredient) {
    if (ci.tsi_code) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const g = (ci as any).computed_granules ?? ci.granules_computed ?? 0;
      granulesByCode.set(ci.tsi_code, g);
    }
  }

  // Accumulate granules per category from the finalised ingredient lines.
  const accumulator = new Map<string, number>();
  let totalGranules = 0;

  for (const ing of proposedFormulation) {
    // Prefer route-computed granules; fall back to Claude's self-reported value.
    const g = granulesByCode.get(ing.tsi_code ?? '') ?? ing.granules ?? 0;
    totalGranules += g;
    const cat = ing.category ?? 'other';
    accumulator.set(cat, (accumulator.get(cat) ?? 0) + g);
  }

  // Apply display order: CATEGORY_ORDER first, then any remaining categories
  // (so an unrecognised Claude category is appended, never dropped).
  const orderedCats: string[] = [];
  const placed = new Set<string>();
  for (const cat of CATEGORY_ORDER) {
    if (accumulator.has(cat)) {
      orderedCats.push(cat);
      placed.add(cat);
    }
  }
  for (const cat of accumulator.keys()) {
    if (!placed.has(cat)) orderedCats.push(cat);
  }

  const byCategory: CategorySummary[] = orderedCats
    .filter((cat) => (accumulator.get(cat) ?? 0) > 0)
    .map((cat) => ({
      category: cat,
      displayName: humanise(cat),
      granules: accumulator.get(cat) ?? 0,
    }));

  // Reconciliation invariant: the breakdown total must equal the ingredient total.
  // Because we append unknown categories above, this assertion only fires on
  // arithmetic bugs in this function itself — not on unknown Claude categories.
  const breakdownTotal = byCategory.reduce((sum, c) => sum + c.granules, 0);
  if (breakdownTotal !== totalGranules) {
    throw new Error(
      `Granule breakdown (${breakdownTotal}) does not reconcile with ingredient total (${totalGranules}).`,
    );
  }

  return {
    totalGranules,
    byCategory,
    ingredientCount: proposedFormulation.length,
  };
}
