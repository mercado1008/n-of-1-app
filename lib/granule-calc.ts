/**
 * lib/granule-calc.ts
 *
 * Deterministic helpers for computing granule counts from proposed doses.
 *
 * As of v0.4.4 / prompt v0.3.5 the route OWNS granule arithmetic. Claude
 * proposes `proposed_dose`; this module computes `granules` per ingredient
 * deterministically and returns them in the response. The schema makes
 * Claude's `granules` field optional — if present, we log discrepancies
 * but do not fail the request on that basis.
 *
 * The only hard failures this module surfaces are:
 *   - Unit mismatch: Claude proposed in a unit that doesn't match the
 *     library's `dose_per_granule_unit`. Strict equality required.
 *   - Pod overage: computed total > 710 granules.
 *   - Library lookup miss: TSI code not present in supplied Library.
 *   - Bad library data: dose_per_granule missing or non-positive.
 */

import type { ClaudeOutput } from '@/prompts/output-schema';

// Library entry shape we care about. Kept loose because the library is
// loaded as JSON and validated by the build script, not by this module.
export interface LibraryIngredientForGranules {
  tsi_code: string;
  common_name?: string;
  dose_per_granule?: number;
  dose_per_granule_unit?: string;
  granule_weight_mg?: number;
}

// Type of the loaded library (subset we touch).
export interface LibraryFileForGranules {
  metadata: { library_revision: number };
  ingredients: LibraryIngredientForGranules[];
}

// ---------------------------------------------------------------------------
// Core math
// ---------------------------------------------------------------------------

/**
 * Compute granules required to deliver a proposed dose of an ingredient.
 *
 * Returns null on any error (missing library data, unit mismatch, etc.) —
 * caller decides how to handle.
 */
export function computeGranulesForDose(args: {
  proposedDose: number;
  proposedUnit: string;
  libraryIngredient: LibraryIngredientForGranules;
}): { granules: number } | { error: string } {
  const { proposedDose, proposedUnit, libraryIngredient: lib } = args;

  if (!Number.isFinite(proposedDose) || proposedDose <= 0) {
    return { error: `proposed_dose must be a positive finite number, got ${proposedDose}` };
  }
  if (lib.dose_per_granule === undefined || lib.dose_per_granule === null) {
    return { error: `library entry ${lib.tsi_code} has no dose_per_granule data` };
  }
  if (lib.dose_per_granule <= 0) {
    return { error: `library entry ${lib.tsi_code} has invalid dose_per_granule (${lib.dose_per_granule})` };
  }
  if (!lib.dose_per_granule_unit) {
    return { error: `library entry ${lib.tsi_code} has no dose_per_granule_unit` };
  }
  if (proposedUnit.trim().toLowerCase() !== lib.dose_per_granule_unit.trim().toLowerCase()) {
    return {
      error:
        `unit mismatch for ${lib.tsi_code}: ` +
        `proposed in "${proposedUnit}" but library expects "${lib.dose_per_granule_unit}"`,
    };
  }

  // ceil because you cannot dispense a fractional granule.
  const granules = Math.ceil(proposedDose / lib.dose_per_granule);
  return { granules };
}

// ---------------------------------------------------------------------------
// Verification — compute authoritative granules and check pod budget
// ---------------------------------------------------------------------------

export interface GranuleVerificationIssue {
  tsi_code: string;
  common_name?: string;
  reason: string;
}

export interface ComputedGranulesPerIngredient {
  tsi_code: string;
  common_name?: string;
  proposed_dose: number;
  dose_unit: string;
  computed_granules: number;
  /** Claude's self-reported granules, if populated. For diagnostics only. */
  claude_reported_granules?: number;
  /** True if claude_reported_granules disagrees with computed_granules. */
  discrepancy?: boolean;
}

export interface GranuleVerificationResult {
  ok: boolean;
  issues: GranuleVerificationIssue[];
  /** Per-ingredient computed granules — authoritative. */
  computed_per_ingredient: ComputedGranulesPerIngredient[];
  computed_total_granules: number;
  computed_total_pod_weight_mg: number;
  pod_budget_used: number;        // computed_total_granules / 710
  pod_overage: boolean;            // computed_total_granules > 710
  /** Number of ingredients where Claude's reported granules disagreed with the recompute. */
  claude_granule_discrepancy_count: number;
}

/**
 * Compute granules deterministically from each ingredient's proposed_dose,
 * sum them, check the pod budget, and surface any unit-mismatch or
 * library-lookup failures.
 *
 * As of v0.4.4 we no longer fail on per-ingredient discrepancies between
 * Claude's `granules` and our recompute — the route owns the maths. Only
 * unit mismatches, missing library data, and pod overage are hard failures.
 */
export function verifyGranuleCounts(args: {
  output: ClaudeOutput;
  library: LibraryFileForGranules;
}): GranuleVerificationResult {
  const issues: GranuleVerificationIssue[] = [];
  const computedPerIngredient: ComputedGranulesPerIngredient[] = [];
  let computedTotalGranules = 0;
  let computedTotalPodWeightMg = 0;
  let claudeDiscrepancyCount = 0;

  // Refusal outputs have no formulation to verify. Return empty/ok.
  if (args.output.output_type === 'refusal') {
    return {
      ok: true,
      issues: [],
      computed_per_ingredient: [],
      computed_total_granules: 0,
      computed_total_pod_weight_mg: 0,
      pod_budget_used: 0,
      pod_overage: false,
      claude_granule_discrepancy_count: 0,
    };
  }

  const libByTsi = new Map<string, LibraryIngredientForGranules>();
  for (const ing of args.library.ingredients) {
    libByTsi.set(ing.tsi_code, ing);
  }

  for (const ing of args.output.proposed_formulation) {
    const lib = libByTsi.get(ing.tsi_code);
    if (!lib) {
      issues.push({
        tsi_code: ing.tsi_code,
        common_name: ing.common_name,
        reason: 'TSI code not found in supplied Library',
      });
      continue;
    }

    const result = computeGranulesForDose({
      proposedDose: ing.proposed_dose,
      proposedUnit: ing.dose_unit,
      libraryIngredient: lib,
    });
    if ('error' in result) {
      issues.push({
        tsi_code: ing.tsi_code,
        common_name: ing.common_name,
        reason: result.error,
      });
      continue;
    }

    const computedGranules = result.granules;
    const claudeGranules = (ing as { granules?: number }).granules;
    const discrepancy =
      claudeGranules !== undefined && claudeGranules !== computedGranules;
    if (discrepancy) {
      claudeDiscrepancyCount += 1;
    }

    computedPerIngredient.push({
      tsi_code: ing.tsi_code,
      common_name: ing.common_name,
      proposed_dose: ing.proposed_dose,
      dose_unit: ing.dose_unit,
      computed_granules: computedGranules,
      claude_reported_granules: claudeGranules,
      discrepancy,
    });

    computedTotalGranules += computedGranules;
    if (lib.granule_weight_mg !== undefined) {
      computedTotalPodWeightMg += computedGranules * lib.granule_weight_mg;
    }
  }

  const podOverage = computedTotalGranules > 710;
  if (podOverage) {
    issues.push({
      tsi_code: '(total)',
      reason: `pod overage: computed total ${computedTotalGranules} exceeds 710-granule budget`,
    });
  }

  return {
    ok: issues.length === 0,
    issues,
    computed_per_ingredient: computedPerIngredient,
    computed_total_granules: computedTotalGranules,
    computed_total_pod_weight_mg: computedTotalPodWeightMg,
    pod_budget_used: computedTotalGranules / 710,
    pod_overage: podOverage,
    claude_granule_discrepancy_count: claudeDiscrepancyCount,
  };
}
