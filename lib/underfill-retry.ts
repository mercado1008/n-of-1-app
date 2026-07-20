/**
 * lib/underfill-retry.ts
 *
 * Deterministic backstop for the pod-underfill failure mode documented in
 * SUB-2026-796 (2026-07-19): a multi-pattern / clinical-note-activated panel
 * came back at 281/720 granules (39%), well under the 600-granule floor,
 * with a compliance_self_check.notes that rationalised the shortfall instead
 * of adding ingredients — the exact behaviour system-prompt.md's "HARD STOP"
 * rule already bans in prose. Prompt-only reinforcement had already been
 * tried across v0.6.2–v0.6.4 and still failed on this case, so this module
 * adds a route-level retry: if the route's own deterministic granule count
 * comes back under the floor for a panel the floor applies to, fire exactly
 * one corrective retry call before returning to the practitioner.
 */

import type { ClaudeOutput } from '@/prompts/output-schema';
import type { GranuleVerificationResult } from './granule-calc';

export const UNDERFILL_FLOOR_GRANULES = 600;

type FormulationOutput = ClaudeOutput & { output_type: 'formulation' };

/**
 * Mirrors system-prompt.md's own trigger for the 600-granule floor: 2+
 * recognised patterns, OR 1+ pattern with clinical-note-activated axes
 * (clinical notes independently count toward the "≥2-pattern" obligation
 * per the six-step procedure, Step 1).
 */
export function multiPatternFloorApplies(
  output: ClaudeOutput,
  clinicalNotes: string,
): boolean {
  if (output.output_type !== 'formulation') return false;
  const patternCount = Array.isArray(output.recognised_patterns)
    ? output.recognised_patterns.length
    : 0;
  const hasNotes = clinicalNotes.trim().length > 0;
  return patternCount >= 2 || (patternCount >= 1 && hasNotes);
}

export function isUnderfilled(verification: GranuleVerificationResult): boolean {
  return verification.computed_total_granules < UNDERFILL_FLOOR_GRANULES;
}

/**
 * Builds the corrective text appended to the original user prompt for the
 * single retry attempt. Quotes the model's own shortfall and per-category
 * plan-vs-delivered gap back at it — concrete numbers, not another abstract
 * reminder, since the abstract reminder already exists in the system prompt
 * and didn't prevent this failure mode.
 */
export function buildUnderfillRetryAddendum(args: {
  output: FormulationOutput;
  verification: GranuleVerificationResult;
}): string {
  const { output, verification } = args;

  const deliveredByCategory = new Map<string, number>();
  for (const ing of output.proposed_formulation) {
    const computed = verification.computed_per_ingredient.find(
      (c) => c.tsi_code === ing.tsi_code,
    );
    const prev = deliveredByCategory.get(ing.category) ?? 0;
    deliveredByCategory.set(ing.category, prev + (computed?.computed_granules ?? 0));
  }

  const plan = Array.isArray(output.granule_budget_allocation_plan)
    ? output.granule_budget_allocation_plan
    : [];

  const categoryLines = plan.map((p) => {
    const delivered = deliveredByCategory.get(p.category) ?? 0;
    return `- ${p.category} (${p.priority}): planned ${p.granules_allocated} granules, actually delivered ${delivered} granules`;
  });

  const podPct = Math.round(verification.pod_budget_used * 1000) / 10;

  return [
    '',
    '## RETRY — underfill correction required',
    '',
    `Your previous attempt at this same submission produced a formulation totalling only ` +
      `${verification.computed_total_granules} granules (${podPct}% of the 720-granule pod), ` +
      `below the mandatory ${UNDERFILL_FLOOR_GRANULES}-granule floor for a multi-pattern / ` +
      `clinical-note-activated panel. Per the six-step procedure, this is a formulation error, ` +
      `not an acceptable clinical judgement call — a self-check that acknowledges a sub-600 ` +
      `fill and writes a justification for it is explicitly a failed output.`,
    '',
    'Your previous per-category plan vs. what was actually delivered:',
    ...(categoryLines.length > 0 ? categoryLines : ['(no allocation plan recorded)']),
    '',
    'Redo the full formulation from scratch — do not simply append to the previous attempt. In particular:',
    '1. Complete the Step 4 layer pass through at least 2 full cycles across all active areas before finalising. A single thin pass through each axis is not sufficient.',
    '2. Conservative or moderate individual dosing is not a reason to include fewer ingredients. If clinical caution argues for lower per-ingredient doses, add MORE Library candidates at moderate/conservative doses to reach the floor — breadth compensates for conservative depth.',
    '3. "Biomarkers are within reference range" is not a valid reason to underfill — the 600-granule floor is triggered by recognised-pattern count and clinical-note-activated axes, not by biomarker abnormality severity.',
    '4. Before closing `proposed_formulation`, compute your running granule estimate. If it is below 660, you are not done — continue the layer pass.',
    '5. Reach a final granule estimate in the 660–690 range, per the standard procedure.',
  ].join('\n');
}
