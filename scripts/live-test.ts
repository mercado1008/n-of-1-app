/**
 * scripts/live-test.ts
 *
 * Live-fire test for /api/analyse. Reads a PDF and a metadata JSON file
 * from disk, POSTs them to a running dev server, and prints the result
 * with structured diagnostics.
 *
 * Prerequisites:
 *   - `npm run dev` is running in another terminal
 *   - .env.local has a valid ANTHROPIC_API_KEY
 *   - You have a real pathology PDF and a metadata JSON file
 *
 * Usage:
 *   npx tsx scripts/live-test.ts <pdf-path> <metadata-path> [notes-path]
 *
 * Example:
 *   npx tsx scripts/live-test.ts \
 *     ./test-fixtures/sample-nutristat.pdf \
 *     ./test-fixtures/sample-metadata.json \
 *     ./test-fixtures/sample-notes.txt
 *
 * Optional env vars:
 *   ANALYSE_URL   — defaults to http://localhost:3000/api/analyse
 *
 * Exit code:
 *   0 — request succeeded (200 with ok:true)
 *   1 — request failed (any non-2xx, or ok:false in body)
 *   2 — script-level error (file not found, invalid args, etc.)
 */
import { readFile } from 'node:fs/promises';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setGlobalDispatcher, Agent } = require('undici') as typeof import('undici');
setGlobalDispatcher(new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 }));
import { basename } from 'node:path';
const ANALYSE_URL = process.env.ANALYSE_URL ?? 'http://localhost:3000/api/analyse';
interface ApiSuccessResponse {
  ok: true;
  output: {
    output_type: 'formulation' | 'refusal';
    [k: string]: unknown;
  };
  audit: Record<string, unknown>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  stop_reason: string | null;
  // v0.4.0+ — granule verification block from the route. Absent for refusal
  // outputs (the route still returns it, but with zeroed totals).
  // v0.4.4 added computed_per_ingredient + claude_granule_discrepancy_count.
  granule_verification?: {
    computed_total_granules: number;
    computed_total_pod_weight_mg: number;
    pod_budget_used: number;
    computed_per_ingredient?: Array<{
      tsi_code: string;
      common_name?: string;
      proposed_dose: number;
      dose_unit: string;
      computed_granules: number;
      claude_reported_granules?: number;
      discrepancy?: boolean;
    }>;
    claude_granule_discrepancy_count?: number;
  };
}
interface ApiErrorResponse {
  ok: false;
  error: {
    code: string;
    message: string;
    detail?: unknown;
    zod_issues?: unknown[];
    status?: number;
    // v0.4.0+ — granule_verification_failed error includes these
    issues?: Array<{ tsi_code: string; common_name?: string; reason: string }>;
    computed_total_granules?: number;
    pod_overage?: boolean;
  };
}
type ApiResponse = ApiSuccessResponse | ApiErrorResponse;
function die(code: number, msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(code);
}
function pretty(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}
function summariseFormulation(
  output: ApiSuccessResponse['output'],
  granuleVerification?: ApiSuccessResponse['granule_verification'],
) {
  const r = output as Record<string, unknown>;
  const proposed = (r.proposed_formulation as Array<Record<string, unknown>> | undefined) ?? [];
  const flags = (r.contraindication_flags as unknown[] | undefined) ?? [];
  const exec = r.executive_summary as Record<string, unknown> | undefined;
  const audit = r.audit_metadata as Record<string, unknown> | undefined;

  // v0.4.1 — new top-level fields
  const panelClasses = (r.panel_classes as string[] | undefined) ?? [];
  const recognisedPatterns =
    (r.recognised_patterns as Array<Record<string, unknown>> | undefined) ?? [];
  const allocationPlan =
    (r.granule_budget_allocation_plan as Array<Record<string, unknown>> | undefined) ?? [];
  const bindingExclusions =
    (r.binding_exclusions_applied as Array<Record<string, unknown>> | undefined) ?? [];
  const excludedFromPod =
    (r.excluded_from_pod as Array<Record<string, unknown>> | undefined) ?? [];
  const standalones =
    (r.standalone_recommendations as Array<Record<string, unknown>> | undefined) ?? [];
  const totalGranules = r.total_granules as number | undefined;

  // v0.4.4 — build a lookup from tsi_code -> computed_granules so we can
  // print the route's authoritative per-ingredient granule count even when
  // Claude omits its own `granules` field (which is now optional).
  const computedByTsi = new Map<string, number>();
  if (granuleVerification?.computed_per_ingredient) {
    for (const c of granuleVerification.computed_per_ingredient) {
      computedByTsi.set(c.tsi_code, c.computed_granules);
    }
  }

  console.log('--- Formulation summary ---');
  console.log(`Headline:           ${exec?.headline ?? '(none)'}`);
  console.log(`Panel classes:      ${JSON.stringify(panelClasses)}`);
  console.log('');

  // v0.4.1 — recognised patterns
  console.log(`Recognised patterns: ${recognisedPatterns.length}`);
  for (const p of recognisedPatterns) {
    const supporting = Array.isArray(p.supporting_findings)
      ? (p.supporting_findings as string[]).join(', ')
      : '';
    console.log(`  - ${p.pattern_name}`);
    if (supporting) console.log(`      supporting: ${supporting}`);
  }
  console.log('');

  // v0.4.1 — granule budget allocation plan
  console.log(`Granule budget allocation plan: ${allocationPlan.length} axes`);
  let planTotal = 0;
  for (const a of allocationPlan) {
    const granules = (a.granules_allocated as number) ?? 0;
    planTotal += granules;
    const findings = Array.isArray(a.findings_addressed)
      ? (a.findings_addressed as string[]).slice(0, 2).join(', ')
      : '';
    console.log(
      `  - ${a.category} [${a.priority}]: ${granules} granules (${findings}${
        Array.isArray(a.findings_addressed) && (a.findings_addressed as string[]).length > 2
          ? `, +${(a.findings_addressed as string[]).length - 2} more`
          : ''
      })`,
    );
  }
  console.log(`  Plan total: ${planTotal} / 710 granules`);
  console.log('');

  // Proposed formulation with granule counts (route-authoritative)
  console.log(`Ingredients in pod: ${proposed.length}`);
  let routeComputedTotal = 0;
  for (const p of proposed) {
    const reduced =
      p.original_target_dose !== undefined
        ? ` [reduced from ${p.original_target_dose}${p.dose_unit}]`
        : '';
    const cat = p.category ? `, ${p.category}` : '';
    const tsi = p.tsi_code as string;
    // Prefer the route's computed value; fall back to Claude's if route data missing
    const computed = computedByTsi.get(tsi);
    const claudeGranules = p.granules as number | undefined;
    const granulesShown =
      computed !== undefined
        ? `${computed} gr (route)`
        : claudeGranules !== undefined
          ? `${claudeGranules} gr (claude)`
          : '? gr';
    if (computed !== undefined) routeComputedTotal += computed;
    const elem =
      p.elemental_dose !== undefined
        ? ` (= ${p.elemental_dose}${p.elemental_unit ?? ''} ${p.elemental_substance ?? ''})`
        : '';
    console.log(
      `  - ${tsi} ${p.common_name}: ${p.proposed_dose}${p.dose_unit}${elem} = ${granulesShown}${cat}${reduced}`,
    );
  }
  if (granuleVerification) {
    console.log(`  Total granules (route): ${granuleVerification.computed_total_granules} / 700`);
    if (totalGranules !== undefined && totalGranules !== granuleVerification.computed_total_granules) {
      console.log(
        `  (Claude reported ${totalGranules}; route is authoritative)`,
      );
    }
  } else if (totalGranules !== undefined) {
    console.log(`  Total granules (Claude): ${totalGranules} / 700`);
  }
  console.log('');

  // v0.4.1 — binding exclusions applied
  console.log(`Binding exclusions applied: ${bindingExclusions.length}`);
  for (const b of bindingExclusions) {
    console.log(`  - ${b.ingredient_name}`);
    console.log(`      trigger: ${b.panel_finding_that_triggered}`);
  }
  console.log('');

  // Excluded from pod (existing v0.3.0 field, still worth showing)
  console.log(`Excluded from pod: ${excludedFromPod.length}`);
  for (const e of excludedFromPod) {
    const dose =
      e.original_target_dose !== undefined ? ` (target ${e.original_target_dose}${e.dose_unit ?? ''})` : '';
    const granules =
      e.granules_required !== undefined ? `, would have used ${e.granules_required} gr` : '';
    console.log(`  - ${e.ingredient_name}${dose}${granules} [${e.reason_excluded}]`);
  }
  console.log('');

  // Standalone recommendations (not in Library)
  console.log(`Standalone recommendations (not in Library): ${standalones.length}`);
  for (const s of standalones) {
    console.log(`  - ${s.recommendation}`);
  }
  console.log('');

  console.log(`Contraindication flags: ${flags.length}`);
  console.log(`Critical review:    ${r.critical_review_required ? 'YES' : 'no'}`);
  console.log(`Library revision:   ${audit?.library_revision}`);
  console.log(`Escalation flags:   ${JSON.stringify(audit?.escalation_flags_raised ?? [])}`);
  console.log(`s4 excluded count:  ${audit?.s4_ingredients_excluded_count}`);
  console.log(`Binding excl count: ${audit?.binding_exclusions_count}`);
  console.log(`Patterns count:     ${audit?.recognised_patterns_count}`);
}
function summariseRefusal(output: ApiSuccessResponse['output']) {
  const r = output as Record<string, unknown>;
  const panelClasses = (r.panel_classes as string[] | undefined) ?? [];
  console.log('--- Refusal summary ---');
  console.log(`Panel classes:      ${JSON.stringify(panelClasses)}`);
  console.log(`Trigger:            ${r.refusal_trigger}`);
  console.log(`Explanation:        ${r.refusal_explanation}`);
  console.log(`Escalation:         ${r.escalation_recommended}`);
}
function summariseGranuleVerification(
  v: NonNullable<ApiSuccessResponse['granule_verification']>,
) {
  console.log('--- Granule verification (deterministic recompute) ---');
  console.log(`Computed total:     ${v.computed_total_granules} / 710 granules`);
  console.log(`Pod budget used:    ${(v.pod_budget_used * 100).toFixed(1)}%`);
  console.log(`Pod weight:         ${v.computed_total_pod_weight_mg.toFixed(0)} mg`);
  if (v.claude_granule_discrepancy_count !== undefined && v.claude_granule_discrepancy_count > 0) {
    console.log(
      `Claude/route disagreed on ${v.claude_granule_discrepancy_count} ingredient(s) — diagnostic only, route value used.`,
    );
  }
}
async function main() {
  const [, , pdfPath, metadataPath, notesPath] = process.argv;
  if (!pdfPath || !metadataPath) {
    die(2, 'usage: tsx scripts/live-test.ts <pdf-path> <metadata-path> [notes-path]');
  }
  let pdfBytes: Buffer;
  let metadataRaw: string;
  let notesText = '';
  try {
    pdfBytes = await readFile(pdfPath);
  } catch (err) {
    die(2, `Could not read PDF at ${pdfPath}: ${(err as Error).message}`);
  }
  try {
    metadataRaw = await readFile(metadataPath, 'utf8');
  } catch (err) {
    die(2, `Could not read metadata at ${metadataPath}: ${(err as Error).message}`);
  }
  if (notesPath) {
    try {
      notesText = await readFile(notesPath, 'utf8');
    } catch (err) {
      die(2, `Could not read notes at ${notesPath}: ${(err as Error).message}`);
    }
  }
  // Validate metadata is JSON before sending — fail fast.
  try {
    JSON.parse(metadataRaw);
  } catch (err) {
    die(2, `Metadata is not valid JSON: ${(err as Error).message}`);
  }
  const form = new FormData();
  form.append(
    'pdf',
    new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' }),
    basename(pdfPath),
  );
  form.append('metadata', metadataRaw);
  if (notesText) form.append('clinical_notes', notesText);
  console.log(`POST ${ANALYSE_URL}`);
  console.log(`PDF:        ${pdfPath} (${pdfBytes.byteLength} bytes)`);
  console.log(`Metadata:   ${metadataPath}`);
  console.log(`Notes:      ${notesPath ?? '(none)'}`);
  console.log('');
  console.log('Calling Claude — this typically takes 30–90 seconds...');
  console.log('');
  const startMs = Date.now();
  let resp: Response;
  try {
    resp = await fetch(ANALYSE_URL, { method: 'POST', body: form });
  } catch (err) {
    die(1, `fetch failed: ${(err as Error).message}`);
  }
  const elapsedMs = Date.now() - startMs;
  console.log(`HTTP ${resp.status} ${resp.statusText} (${elapsedMs}ms)`);
  let body: ApiResponse;
  try {
    body = (await resp.json()) as ApiResponse;
  } catch (err) {
    die(1, `Response body was not valid JSON: ${(err as Error).message}`);
  }
  if (!body.ok) {
    console.log('');
    console.log('--- Error response ---');
    console.log(`Code:               ${body.error.code}`);
    console.log(`Message:            ${body.error.message}`);

    // v0.4.0+ — granule_verification_failed has structured issue list
    if (body.error.code === 'granule_verification_failed') {
      console.log('');
      console.log('--- Granule verification issues ---');
      if (body.error.computed_total_granules !== undefined) {
        console.log(`Computed total:     ${body.error.computed_total_granules} / 710 granules`);
      }
      if (body.error.pod_overage) {
        console.log(`Pod overage:        YES (exceeds 700-granule budget)`);
      }
      if (body.error.issues && body.error.issues.length > 0) {
        console.log('');
        console.log(`Issues (${body.error.issues.length}):`);
        for (const issue of body.error.issues) {
          const name = issue.common_name ? ` ${issue.common_name}` : '';
          console.log(`  - ${issue.tsi_code}${name}: ${issue.reason}`);
        }
      }
    }

    if (body.error.zod_issues) {
      console.log('');
      console.log('Zod issues:');
      console.log(pretty(body.error.zod_issues));
    }
    if (body.error.detail !== undefined) {
      const fs = await import('node:fs/promises');
      await fs.writeFile('./live-test-error-detail.json', pretty(body.error.detail));
      console.log('');
      console.log('Detail (full body) written to: ./live-test-error-detail.json');
      console.log('Detail (preview, first 2000 chars):');
      const preview = pretty(body.error.detail).slice(0, 2000);
      console.log(preview);
      if (pretty(body.error.detail).length > 2000) {
        console.log('... (truncated — see ./live-test-error-detail.json for full content)');
      }
    }
    process.exit(1);
  }
  console.log('');
  console.log(`Output type:        ${body.output.output_type}`);
  console.log(`Stop reason:        ${body.stop_reason}`);
  console.log(
    `Tokens (in/out):    ${body.usage.input_tokens} / ${body.usage.output_tokens}`,
  );
  if (body.usage.cache_read_input_tokens) {
    console.log(`Cache read tokens:  ${body.usage.cache_read_input_tokens}`);
  }
  console.log('');
  if (body.output.output_type === 'formulation') {
    summariseFormulation(body.output, body.granule_verification);
  } else {
    summariseRefusal(body.output);
  }
  console.log('');
  if (body.granule_verification) {
    summariseGranuleVerification(body.granule_verification);
    console.log('');
  }
  console.log('--- Audit block ---');
  console.log(pretty(body.audit));
  console.log('');
  // Write the full response (output + audit + granule_verification + usage)
  // so downstream consumers (e.g. docx generator) have everything available.
  // The Claude output is still the dominant field; route-side metadata is
  // siblings under the response root.
  console.log('Full response JSON written to: ./live-test-output.json');
  await import('node:fs/promises').then((fs) =>
    fs.writeFile(
      './live-test-output.json',
      pretty({
        output: body.output,
        audit: body.audit,
        granule_verification: body.granule_verification,
        usage: body.usage,
        stop_reason: body.stop_reason,
      }),
    ),
  );
  process.exit(0);
}
main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(2);
});
