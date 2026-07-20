/**
 * scripts/live-test-questionnaire.ts
 *
 * Live-fire test for /api/analyse-questionnaire (SPP — Symptom Presentation
 * Panel). Reads a metadata JSON file and a questionnaire-answers JSON file
 * from disk, POSTs them as a JSON body to a running dev server, and prints
 * structured diagnostics. Output written to live-test-output-questionnaire.json.
 *
 * Prerequisites:
 *   - `npm run dev` is running in another terminal
 *   - .env.local has a valid ANTHROPIC_API_KEY
 *   - You have a metadata JSON file and a questionnaire-answers JSON file
 *     (see test-fixtures/sample-metadata-spp-mild.json and
 *     test-fixtures/sample-questionnaire-spp-mild.json for the shape)
 *
 * Usage:
 *   npx tsx scripts/live-test-questionnaire.ts <metadata-path> <questionnaire-path> [notes-path]
 *
 * Example:
 *   npx tsx scripts/live-test-questionnaire.ts \
 *     ./test-fixtures/sample-metadata-spp-mild.json \
 *     ./test-fixtures/sample-questionnaire-spp-mild.json
 *
 * Optional env vars:
 *   ANALYSE_QUESTIONNAIRE_URL — defaults to http://localhost:3000/api/analyse-questionnaire
 *
 * Exit code:
 *   0 — request succeeded (200 with ok:true)
 *   1 — request failed (any non-2xx, or ok:false in body)
 *   2 — script-level error (file not found, invalid args, etc.)
 */
import { readFile, writeFile } from 'node:fs/promises';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setGlobalDispatcher, Agent } = require('undici') as typeof import('undici');
setGlobalDispatcher(new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 }));

const ANALYSE_URL = process.env.ANALYSE_QUESTIONNAIRE_URL ?? 'http://localhost:3000/api/analyse-questionnaire';

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
  retry_info?: Record<string, unknown>;
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
  const recognisedPatterns = (r.recognised_patterns as Array<Record<string, unknown>> | undefined) ?? [];
  const excludedFromPod = (r.excluded_from_pod as Array<Record<string, unknown>> | undefined) ?? [];
  const standalones = (r.standalone_recommendations as Array<Record<string, unknown>> | undefined) ?? [];
  const auditMeta = r.audit_metadata as Record<string, unknown> | undefined;

  const computedByTsi = new Map<string, number>();
  if (granuleVerification?.computed_per_ingredient) {
    for (const c of granuleVerification.computed_per_ingredient) {
      computedByTsi.set(c.tsi_code, c.computed_granules);
    }
  }

  console.log('--- Formulation summary ---');
  console.log(`Headline:       ${exec?.headline ?? '(none)'}`);
  console.log('');
  console.log(`Panel classes: ${JSON.stringify(r.panel_classes)}`);
  console.log(`Escalation flags: ${JSON.stringify(auditMeta?.escalation_flags_raised)}`);
  console.log(`Critical review: ${r.critical_review_required ? 'YES' : 'no'}`);
  console.log('');
  console.log(`Patterns: ${recognisedPatterns.length}`);
  for (const p of recognisedPatterns) {
    console.log(`  - ${p.pattern_name}`);
  }
  console.log('');
  console.log(`Ingredients in pod: ${proposed.length}`);
  for (const p of proposed) {
    const tsi = p.tsi_code as string;
    const computed = computedByTsi.get(tsi);
    const granulesShown = computed !== undefined ? `${computed} gr (route)` : '? gr';
    console.log(`  - ${tsi} ${p.common_name} [${p.category}]: ${p.proposed_dose}${p.dose_unit} = ${granulesShown}`);
  }
  if (granuleVerification) {
    console.log(`  Total granules (route): ${granuleVerification.computed_total_granules} / 720`);
    console.log(`  Pod fill: ${(granuleVerification.pod_budget_used * 100).toFixed(1)}%`);
    console.log(`  Pod weight: ${granuleVerification.computed_total_pod_weight_mg.toFixed(0)} mg`);
  }
  console.log('');
  console.log(`Binding exclusions applied: ${((r.binding_exclusions_applied as unknown[]) ?? []).length}`);
  console.log(`Excluded from pod: ${excludedFromPod.length}`);
  for (const e of excludedFromPod) {
    console.log(`  - ${e.ingredient_name} [${e.reason_excluded}]`);
  }
  console.log('');
  console.log(`Standalone recommendations: ${standalones.length}`);
  for (const s of standalones) {
    console.log(`  - ${s.recommendation}`);
  }
  console.log('');
  console.log(`Contraindication flags: ${flags.length}`);
}

function summariseRefusal(output: ApiSuccessResponse['output']) {
  const r = output as Record<string, unknown>;
  console.log('--- Refusal summary ---');
  console.log(`Trigger:        ${r.refusal_trigger}`);
  console.log(`Explanation:    ${r.refusal_explanation}`);
}

async function main() {
  const [, , metadataPath, questionnairePath, notesPath] = process.argv;
  if (!metadataPath || !questionnairePath) {
    die(2, 'usage: tsx scripts/live-test-questionnaire.ts <metadata-path> <questionnaire-path> [notes-path]');
  }

  let metadataRaw: string;
  let questionnaireRaw: string;
  let notesText = '';

  try {
    metadataRaw = await readFile(metadataPath, 'utf8');
  } catch (err) {
    die(2, `Could not read metadata at ${metadataPath}: ${(err as Error).message}`);
  }
  try {
    questionnaireRaw = await readFile(questionnairePath, 'utf8');
  } catch (err) {
    die(2, `Could not read questionnaire at ${questionnairePath}: ${(err as Error).message}`);
  }
  if (notesPath) {
    try {
      notesText = await readFile(notesPath, 'utf8');
    } catch (err) {
      die(2, `Could not read notes at ${notesPath}: ${(err as Error).message}`);
    }
  }

  let metadata: unknown;
  let questionnaire: unknown;
  try {
    metadata = JSON.parse(metadataRaw);
  } catch (err) {
    die(2, `Metadata is not valid JSON: ${(err as Error).message}`);
  }
  try {
    questionnaire = JSON.parse(questionnaireRaw);
  } catch (err) {
    die(2, `Questionnaire is not valid JSON: ${(err as Error).message}`);
  }

  const body = { metadata, clinical_notes: notesText, questionnaire };

  console.log(`POST ${ANALYSE_URL}`);
  console.log(`Metadata:     ${metadataPath}`);
  console.log(`Questionnaire: ${questionnairePath}`);
  console.log(`Notes:        ${notesPath ?? '(none)'}`);
  console.log('');
  console.log('Calling Claude — this typically takes 30–90 seconds...');
  console.log('');

  const startMs = Date.now();
  let resp: Response;
  try {
    resp = await fetch(ANALYSE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    die(1, `fetch failed: ${(err as Error).message}`);
  }

  const elapsedMs = Date.now() - startMs;
  console.log(`HTTP ${resp.status} ${resp.statusText} (${elapsedMs}ms)`);

  let respBody: ApiResponse;
  try {
    respBody = (await resp.json()) as ApiResponse;
  } catch (err) {
    die(1, `Response body was not valid JSON: ${(err as Error).message}`);
  }

  if (!respBody.ok) {
    console.log('');
    console.log('--- Error response ---');
    console.log(`Code:    ${respBody.error.code}`);
    console.log(`Message: ${respBody.error.message}`);
    if (respBody.error.code === 'granule_verification_failed') {
      console.log(`Computed total: ${respBody.error.computed_total_granules ?? '?'} / 720`);
      if (respBody.error.pod_overage) console.log('Pod overage: YES');
      for (const issue of respBody.error.issues ?? []) {
        console.log(`  - ${issue.tsi_code}: ${issue.reason}`);
      }
    }
    if (respBody.error.zod_issues) {
      console.log('');
      console.log('Zod issues:');
      console.log(pretty(respBody.error.zod_issues));
    }
    if (respBody.error.detail !== undefined) {
      await writeFile('./live-test-error-detail-questionnaire.json', pretty(respBody.error.detail));
      console.log('Detail written to: ./live-test-error-detail-questionnaire.json');
    }
    process.exit(1);
  }

  console.log('');
  console.log(`Output type:  ${respBody.output.output_type}`);
  console.log(`Stop reason:  ${respBody.stop_reason}`);
  console.log(`Tokens (in/out): ${respBody.usage.input_tokens} / ${respBody.usage.output_tokens}`);
  if (respBody.usage.cache_read_input_tokens) {
    console.log(`Cache read: ${respBody.usage.cache_read_input_tokens}`);
  }
  if (respBody.retry_info) {
    console.log(`Underfill retry: ${JSON.stringify(respBody.retry_info)}`);
  }
  console.log('');

  if (respBody.output.output_type === 'formulation') {
    summariseFormulation(respBody.output, respBody.granule_verification);
  } else {
    summariseRefusal(respBody.output);
  }

  console.log('');
  console.log('--- Audit block ---');
  console.log(pretty(respBody.audit));
  console.log('');

  const outputPath = './live-test-output-questionnaire.json';
  await writeFile(
    outputPath,
    pretty({
      output: respBody.output,
      audit: respBody.audit,
      granule_verification: respBody.granule_verification,
      usage: respBody.usage,
      stop_reason: respBody.stop_reason,
      retry_info: respBody.retry_info,
    }),
  );
  console.log(`Full response written to: ${outputPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(2);
});
