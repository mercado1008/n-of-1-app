/**
 * scripts/generate-docs/index.ts
 *
 * Orchestrator for document generation from an /api/analyse JSON output.
 *
 * Usage:
 *   npx tsx scripts/generate-docs/index.ts [path-to-output.json] [output-dir]
 *
 * Defaults:
 *   input  = ./live-test-output.json
 *   output = ./generated-docs/
 *
 * Produces:
 *   - Nof1_HealthAnalysis_{submission_id}_DRAFT.docx   (practitioner-facing analysis)
 *   - Nof1_FormulationSchedule_{submission_id}_DRAFT.xlsx (practitioner + dispensary)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { generateHealthAnalysis, type GenerateHealthAnalysisOptions } from './health-analysis';
import { generateFormulationSchedule } from './formulation-schedule';
import type { AnalysisOutput, LiveTestOutputFile } from './types';

interface LibraryIngredient {
  tsi_code: string;
  common_name?: string;
  tga_approved_name?: string;
  active_ingredient?: string;
}
interface LibraryFile {
  metadata?: Record<string, unknown>;
  ingredients: LibraryIngredient[];
}

/**
 * Load the ingredients Library and return a resolver function that maps
 * tsi_code → display-friendly ingredient name. Used to keep internal codes
 * out of practitioner-facing documents (docx) and to surface ingredient
 * names in the xlsx contraindication/dose-adjustment sheets.
 *
 * Display preference order: common_name → tga_approved_name → active_ingredient.
 * Returns undefined for unknown codes (caller should render '—').
 */
async function buildTsiResolver(): Promise<((code: string) => string | undefined) | undefined> {
  const libraryPath = path.resolve(
    process.cwd(),
    'data',
    'library-built',
    'ingredients-library.json',
  );
  try {
    const raw = await readFile(libraryPath, 'utf8');
    const lib = JSON.parse(raw) as LibraryFile;
    const map = new Map<string, string>();
    for (const ing of lib.ingredients ?? []) {
      const name =
        (ing.common_name && ing.common_name !== '-' ? ing.common_name : undefined) ??
        (ing.tga_approved_name && ing.tga_approved_name !== '-' ? ing.tga_approved_name : undefined) ??
        ing.active_ingredient;
      if (ing.tsi_code && name) map.set(ing.tsi_code, name);
    }
    console.log(`Loaded ingredient Library: ${map.size} ingredient name mappings`);
    return (code: string) => map.get(code);
  } catch (err) {
    console.log(`(Could not load Library at ${libraryPath} — contraindication ingredients will show as "—")`);
    return undefined;
  }
}

async function main(): Promise<void> {
  const inputArg = process.argv[2] ?? 'live-test-output.json';
  const outputDirArg = process.argv[3] ?? 'generated-docs';
  const requestMetadataArg = process.argv[4] ?? 'test-fixtures/sample-metadata-oat.json';

  const inputPath = path.resolve(process.cwd(), inputArg);
  const outputDir = path.resolve(process.cwd(), outputDirArg);
  const requestMetadataPath = path.resolve(process.cwd(), requestMetadataArg);

  console.log(`Reading output: ${inputPath}`);
  const raw = await readFile(inputPath, 'utf8');
  const parsed = JSON.parse(raw);

  // Live-test post-2026-05-13 writes the full response (output + audit +
  // granule_verification + usage). Older files have just the Claude output
  // at the root. Detect and unwrap accordingly.
  const isWrapped = parsed && typeof parsed === 'object' && 'output' in parsed && parsed.output && typeof parsed.output === 'object';
  const wrapper: LiveTestOutputFile = isWrapped
    ? (parsed as LiveTestOutputFile)
    : { output: parsed as AnalysisOutput };
  const output = wrapper.output;
  if (!isWrapped) {
    console.log('(Legacy live-test-output.json shape detected — audit footer will show — for route-side fields. Re-fire to populate.)');
  }

  let requestMetadata: Record<string, unknown> | undefined;
  try {
    const reqRaw = await readFile(requestMetadataPath, 'utf8');
    requestMetadata = JSON.parse(reqRaw);
    console.log(`Reading request metadata: ${requestMetadataPath}`);
  } catch {
    console.log(`(No request metadata at ${requestMetadataPath} — patient fields may show as —)`);
  }

  await mkdir(outputDir, { recursive: true });

  const submissionId =
    (requestMetadata?.submission_id as string | undefined) ??
    output.audit_metadata?.submission_id ??
    output.submission_metadata?.submission_id ??
    'unknown-submission';

  // Build the TSI → ingredient-name resolver once, used by both generators.
  const tsiResolver = await buildTsiResolver();

  // --- Health Analysis docx ---
  const docxFilename = `Nof1_HealthAnalysis_${submissionId}_DRAFT.docx`;
  const docxPath = path.join(outputDir, docxFilename);

  console.log(`Generating Health Analysis...`);
  const docxBuffer = await generateHealthAnalysis({
    output,
    requestMetadata: requestMetadata as GenerateHealthAnalysisOptions['requestMetadata'],
    routeAudit: wrapper.audit,
    granuleVerification: wrapper.granule_verification,
    tsiResolver,
  });
  await writeFile(docxPath, docxBuffer);
  console.log(`  → ${docxPath} (${(docxBuffer.length / 1024).toFixed(1)} KB)`);

  // --- Recommended Formulation Schedule xlsx ---
  const xlsxFilename = `Nof1_FormulationSchedule_${submissionId}_DRAFT.xlsx`;
  const xlsxPath = path.join(outputDir, xlsxFilename);

  console.log(`Generating Recommended Formulation Schedule...`);
  const xlsxBuffer = await generateFormulationSchedule({
    output,
    granuleVerification: wrapper.granule_verification,
    routeAudit: wrapper.audit,
    tsiResolver,
  });
  await writeFile(xlsxPath, xlsxBuffer);
  console.log(`  → ${xlsxPath} (${(xlsxBuffer.length / 1024).toFixed(1)} KB)`);

  console.log('');
  console.log('Document generation complete.');
}

main().catch((err) => {
  console.error('Generation failed:');
  console.error(err);
  process.exit(1);
});
