/**
 * scripts/live-test-hl7.ts
 *
 * Live-fire test for /api/analyse-hl7. Reads an HL7 file and a metadata JSON
 * file from disk, POSTs them to a running dev server, and prints structured
 * diagnostics. Output written to live-test-output-hl7.json.
 *
 * Prerequisites:
 *   - `npm run dev` is running in another terminal
 *   - .env.local has a valid ANTHROPIC_API_KEY
 *   - You have an HL7 v2.3.1 ORU^R01 file and a metadata JSON file
 *
 * Usage:
 *   npx tsx scripts/live-test-hl7.ts <hl7-path> <metadata-path> [notes-path]
 *
 * Example:
 *   npx tsx scripts/live-test-hl7.ts \
 *     ./test-fixtures/sample-oat-p000065.hl7 \
 *     ./test-fixtures/sample-metadata-oat-p000065.json
 *
 * Optional env vars:
 *   ANALYSE_HL7_URL — defaults to http://localhost:3000/api/analyse-hl7
 *
 * Exit code:
 *   0 — request succeeded (200 with ok:true)
 *   1 — request failed (any non-2xx, or ok:false in body)
 *   2 — script-level error (file not found, invalid args, etc.)
 */
import { readFile, writeFile } from 'node:fs/promises';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setGlobalDispatcher, Agent } = require('undici') as typeof import('undici');
// Raise undici's default 300s headersTimeout so slow Claude runs don't disconnect.
setGlobalDispatcher(new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 }));

const ANALYSE_URL = process.env.ANALYSE_HL7_URL ?? 'http://localhost:3000/api/analyse-hl7';

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

  const computedByTsi = new Map<string, number>();
  if (granuleVerification?.computed_per_ingredient) {
    for (const c of granuleVerification.computed_per_ingredient) {
      computedByTsi.set(c.tsi_code, c.computed_granules);
    }
  }

  console.log('--- Formulation summary ---');
  console.log(`Headline:       ${exec?.headline ?? '(none)'}`);
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
    console.log(`  - ${tsi} ${p.common_name}: ${p.proposed_dose}${p.dose_unit} = ${granulesShown}`);
  }
  if (granuleVerification) {
    console.log(`  Total granules (route): ${granuleVerification.computed_total_granules} / 710`);
    console.log(`  Pod fill: ${(granuleVerification.pod_budget_used * 100).toFixed(1)}%`);
    console.log(`  Pod weight: ${granuleVerification.computed_total_pod_weight_mg.toFixed(0)} mg`);
  }
  console.log('');
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
  console.log(`Critical review: ${r.critical_review_required ? 'YES' : 'no'}`);
}

function summariseRefusal(output: ApiSuccessResponse['output']) {
  const r = output as Record<string, unknown>;
  console.log('--- Refusal summary ---');
  console.log(`Trigger:        ${r.refusal_trigger}`);
  console.log(`Explanation:    ${r.refusal_explanation}`);
}

async function main() {
  const [, , hl7Path, metadataPath, notesPath] = process.argv;
  if (!hl7Path || !metadataPath) {
    die(2, 'usage: tsx scripts/live-test-hl7.ts <hl7-path> <metadata-path> [notes-path]');
  }

  let hl7Text: string;
  let metadataRaw: string;
  let notesText = '';

  try {
    hl7Text = await readFile(hl7Path, 'utf8');
  } catch (err) {
    die(2, `Could not read HL7 file at ${hl7Path}: ${(err as Error).message}`);
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

  try {
    JSON.parse(metadataRaw);
  } catch (err) {
    die(2, `Metadata is not valid JSON: ${(err as Error).message}`);
  }

  const form = new FormData();
  form.append('hl7', hl7Text);
  form.append('metadata', metadataRaw);
  if (notesText) form.append('clinical_notes', notesText);

  console.log(`POST ${ANALYSE_URL}`);
  console.log(`HL7:        ${hl7Path} (${hl7Text.length} chars)`);
  console.log(`Metadata:   ${metadataPath}`);
  console.log(`Notes:      ${notesPath ?? '(none)'}`);
  console.log('');
  console.log('Calling Claude — this typically takes 30–90 seconds...');
  console.log('');

  const startMs = Date.now();
  let resp: Response;
  try {
    // Node's built-in fetch uses undici with a 300s headersTimeout by default.
    // Claude + large HL7 prompts can exceed that. Override via a custom dispatcher.
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
    console.log(`Code:    ${body.error.code}`);
    console.log(`Message: ${body.error.message}`);
    if (body.error.code === 'granule_verification_failed') {
      console.log(`Computed total: ${body.error.computed_total_granules ?? '?'} / 700`);
      if (body.error.pod_overage) console.log('Pod overage: YES');
      for (const issue of body.error.issues ?? []) {
        console.log(`  - ${issue.tsi_code}: ${issue.reason}`);
      }
    }
    if (body.error.zod_issues) {
      console.log('');
      console.log('Zod issues:');
      console.log(pretty(body.error.zod_issues));
    }
    if (body.error.detail !== undefined) {
      await writeFile('./live-test-error-detail-hl7.json', pretty(body.error.detail));
      console.log('Detail written to: ./live-test-error-detail-hl7.json');
    }
    process.exit(1);
  }

  console.log('');
  console.log(`Output type:  ${body.output.output_type}`);
  console.log(`Stop reason:  ${body.stop_reason}`);
  console.log(`Tokens (in/out): ${body.usage.input_tokens} / ${body.usage.output_tokens}`);
  if (body.usage.cache_read_input_tokens) {
    console.log(`Cache read: ${body.usage.cache_read_input_tokens}`);
  }
  console.log('');

  if (body.output.output_type === 'formulation') {
    summariseFormulation(body.output, body.granule_verification);
  } else {
    summariseRefusal(body.output);
  }

  console.log('');
  console.log('--- Audit block ---');
  console.log(pretty(body.audit));
  console.log('');

  const outputPath = './live-test-output-hl7.json';
  await writeFile(
    outputPath,
    pretty({
      output: body.output,
      audit: body.audit,
      granule_verification: body.granule_verification,
      usage: body.usage,
      stop_reason: body.stop_reason,
    }),
  );
  console.log(`Full response written to: ${outputPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(2);
});
