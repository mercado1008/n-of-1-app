/**
 * scripts/validate-output.ts
 *
 * Validates live-fire output against the appropriate schema.
 *
 * Usage:
 *   npx tsx scripts/validate-output.ts
 *     → validates live-test-output.json (or live-test-output-hl7.json if that
 *       is newer) against ClaudeOutputSchema
 *
 *   npx tsx scripts/validate-output.ts --health-analysis <file.json>
 *     → validates a pre-shaped HealthAnalysis JSON against the document
 *       renderer's schema (src/lib/health-analysis-schema.ts)
 *
 *   npx tsx scripts/validate-output.ts <path/to/output.json>
 *     → validates the given file against ClaudeOutputSchema
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ClaudeOutputSchema } from '../prompts/output-schema';
import { HealthAnalysis } from '../src/lib/health-analysis-schema';
import { deriveSummary } from './generate-docs/derive-summary';

const root = resolve(__dirname, '..');

// ── Argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);

let mode: 'claude' | 'health-analysis' = 'claude';
let explicitPath: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--health-analysis') {
    mode = 'health-analysis';
    explicitPath = args[i + 1];
    i++;
  } else {
    explicitPath = args[i];
  }
}

// ── File resolution ──────────────────────────────────────────────────────────

function resolveClaudeOutputFile(): string {
  if (explicitPath) {
    const p = resolve(root, explicitPath);
    if (!existsSync(p)) {
      console.error(`File not found: ${p}`);
      process.exit(1);
    }
    return p;
  }

  // Default: pick the most recently modified live-test-output*.json in root
  const candidates = [
    'live-test-output.json',
    'live-test-output-hl7.json',
    'live-test-output-questionnaire.json',
  ]
    .map((name) => resolve(root, name))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  if (candidates.length === 0) {
    console.error(
      'No live-test-output*.json found in project root. Run a live-fire first.\n' +
        '  PDF:  npx tsx scripts/live-test.ts <pdf> <metadata.json>\n' +
        '  HL7:  npx tsx scripts/live-test-hl7.ts <hl7> <metadata.json>'
    );
    process.exit(1);
  }

  return candidates[0];
}

function resolveHealthAnalysisFile(): string {
  if (!explicitPath) {
    console.error(
      'Provide a path to a HealthAnalysis JSON:\n' +
        '  npx tsx scripts/validate-output.ts --health-analysis <file.json>'
    );
    process.exit(1);
  }
  const p = resolve(root, explicitPath);
  if (!existsSync(p)) {
    console.error(`File not found: ${p}`);
    process.exit(1);
  }
  return p;
}

// ── Validation helpers ───────────────────────────────────────────────────────

function readJson(filePath: string): unknown {
  const raw = readFileSync(filePath, 'utf8');
  if (!raw.trim()) {
    console.error(`File is empty: ${filePath}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to parse JSON: ${(err as Error).message}`);
    process.exit(1);
  }
}

function printZodErrors(issues: Array<{ path: Array<string | number>; message: string; code: string }>): void {
  for (const issue of issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    console.error(`  path:   ${path}`);
    console.error(`  reason: ${issue.message}`);
    console.error(`  code:   ${issue.code}`);
    console.error('');
  }
}

// ── Mode: validate Claude output ─────────────────────────────────────────────

function validateClaudeOutput(): void {
  const filePath = resolveClaudeOutputFile();
  console.log(`\nValidating Claude output: ${filePath}\n`);

  const envelope = readJson(filePath) as Record<string, unknown>;

  // Live-test scripts wrap Claude's output in { output, audit, granule_verification, ... }
  // Unwrap if present; otherwise assume the file IS the output object.
  const raw: unknown =
    envelope && typeof envelope === 'object' && 'output' in envelope
      ? envelope.output
      : envelope;

  const result = ClaudeOutputSchema.safeParse(raw);

  if (result.success) {
    const out = result.data;
    const submissionId =
      out.output_type === 'formulation'
        ? out.submission_metadata?.submission_id ?? '—'
        : out.submission_metadata?.submission_id ?? '—';
    console.log(`✓  VALID — ClaudeOutputSchema`);
    console.log(`   output_type : ${out.output_type}`);
    console.log(`   submission  : ${submissionId}`);
    if (out.output_type === 'formulation') {
      const panelClasses = out.panel_classes?.join(', ') ?? '—';
      const patternCount = out.recognised_patterns?.length ?? '—';
      const ingredientCount = out.proposed_formulation?.length ?? '—';
      console.log(`   panel_class : ${panelClasses}`);
      console.log(`   patterns    : ${patternCount}`);
      console.log(`   ingredients : ${ingredientCount}`);

      // Granule reconciliation check — verify deriveSummary is internally
      // consistent. Only runs when route-computed per-ingredient data is present
      // (post-2026-05-13 live-fire format).
      const gv = (envelope as Record<string, unknown>).granule_verification as
        | { computed_per_ingredient?: unknown[]; computed_total_granules?: number }
        | undefined;
      if (out.proposed_formulation && gv?.computed_per_ingredient?.length) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const summary = deriveSummary(out.proposed_formulation as any[], gv.computed_per_ingredient as any[]);
          const breakdownTotal = summary.byCategory.reduce((s, c) => s + c.granules, 0);

          if (breakdownTotal !== summary.totalGranules) {
            console.error(
              `\n✗  Granule reconciliation FAILED: breakdown (${breakdownTotal}) ≠ total (${summary.totalGranules})\n`,
            );
            process.exit(1);
          }

          if (gv.computed_total_granules != null && summary.totalGranules !== gv.computed_total_granules) {
            console.error(
              `\n✗  Granule reconciliation FAILED: deriveSummary total (${summary.totalGranules}) ≠ ` +
                `route total (${gv.computed_total_granules})\n`,
            );
            process.exit(1);
          }

          console.log(`   granules    : ${summary.totalGranules} (${summary.byCategory.length} categories — reconciled ✓)`);
        } catch (err) {
          console.error(`\n✗  Granule reconciliation FAILED: ${(err as Error).message}\n`);
          process.exit(1);
        }
      }
    }
    console.log('');
    process.exit(0);
  }

  console.error(`✗  INVALID — ClaudeOutputSchema\n`);
  printZodErrors(result.error.issues as Array<{ path: Array<string | number>; message: string; code: string }>);
  process.exit(1);
}

// ── Mode: validate HealthAnalysis document data ───────────────────────────────

function validateHealthAnalysis(): void {
  const filePath = resolveHealthAnalysisFile();
  console.log(`\nValidating HealthAnalysis document: ${filePath}\n`);

  const raw = readJson(filePath);
  const result = HealthAnalysis.safeParse(raw);

  if (result.success) {
    const doc = result.data;
    console.log(`✓  VALID — HealthAnalysis schema`);
    console.log(`   submission  : ${doc.submissionId}`);
    console.log(`   status      : ${doc.status}`);
    console.log(`   findings    : ${doc.findings.length}`);
    console.log(`   patterns    : ${doc.clinicalPatterns.length}`);
    console.log(`   ingredients : ${doc.formulationStrategy.included.length}`);
    console.log(`   references  : ${doc.references.length}`);
    console.log('');
    process.exit(0);
  }

  console.error(`✗  INVALID — HealthAnalysis schema\n`);
  printZodErrors(result.error.issues as Array<{ path: Array<string | number>; message: string; code: string }>);
  process.exit(1);
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

if (mode === 'health-analysis') {
  validateHealthAnalysis();
} else {
  validateClaudeOutput();
}
