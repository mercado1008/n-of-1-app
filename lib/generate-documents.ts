/**
 * lib/generate-documents.ts
 *
 * Programmatic wrapper around the document generators. Called from the API
 * routes after successful formulation analysis to produce and persist the
 * practitioner-facing PDF and xlsx.
 *
 * Health Analysis is generated as a branded PDF via Puppeteer (Stage 5).
 * Formulation Schedule is generated as an xlsx via ExcelJS.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';

import {
  buildHealthAnalysisHtml,
} from '@/scripts/generate-docs/health-analysis-html';
import {
  generateHealthAnalysisPdf,
} from '@/scripts/generate-docs/health-analysis-pdf';
import {
  generateFormulationSchedule,
} from '@/scripts/generate-docs/formulation-schedule';
import type { AnalysisOutput } from '@/scripts/generate-docs/types';
import type { AuditBlock } from './build-prompt';
import type { RequestMetadata } from './request-schema';

interface LibraryIngredient {
  tsi_code: string;
  common_name?: string;
  tga_approved_name?: string;
  active_ingredient?: string;
}

function buildTsiResolver(ingredients: LibraryIngredient[]) {
  const map = new Map<string, string>();
  for (const i of ingredients) {
    map.set(i.tsi_code, i.common_name ?? i.tga_approved_name ?? i.active_ingredient ?? i.tsi_code);
  }
  return (code: string) => map.get(code) ?? code;
}

/**
 * Load the logo file as base64 for embedding in the HTML string.
 * Tries the design-handoff asset first, then the brand asset.
 * Returns undefined if neither is found (the HTML generator will use a
 * text fallback for the cover band).
 */
async function loadLogoBase64(): Promise<{ base64: string; mimeType: string } | undefined> {
  const candidates = [
    { p: path.join(process.cwd(), 'design_handoff_health_analysis', 'assets', 'logo.png'), mime: 'image/png' },
    { p: path.join(process.cwd(), 'assets', 'brand', 'nof1_logo_header.jpg'), mime: 'image/jpeg' },
  ];
  for (const { p, mime } of candidates) {
    try {
      const raw = await readFile(p);
      return { base64: raw.toString('base64'), mimeType: mime };
    } catch { /* try next */ }
  }
  return undefined;
}

export async function generateDocuments(opts: {
  output: Record<string, unknown>;
  routeAudit: AuditBlock;
  metadata: RequestMetadata;
  granuleVerification: {
    computed_total_granules: number;
    computed_total_pod_weight_mg: number;
    pod_budget_used: number;
    computed_per_ingredient: unknown[];
    claude_granule_discrepancy_count: number;
  };
}): Promise<{ healthAnalysis: Buffer; formulationSchedule: Buffer }> {
  const { output, routeAudit, metadata, granuleVerification } = opts;

  const libraryPath = path.join(process.cwd(), 'data', 'library-built', 'ingredients-library.json');
  const libRaw = await readFile(libraryPath, 'utf-8');
  const lib = JSON.parse(libRaw) as { ingredients: LibraryIngredient[] };
  const tsiResolver = buildTsiResolver(lib.ingredients);

  const analysisOutput = output as unknown as AnalysisOutput;

  const requestMetadata = {
    submission_id: metadata.submission_id,
    practitioner_id: metadata.practitioner_id,
    practitioner_type: metadata.practitioner_type,
    practitioner_name: metadata.practitioner_name,
    patient_pseudonym: metadata.patient_pseudonym,
    patient_age_years: metadata.patient_age_years,
    patient_sex_assigned_at_birth: metadata.patient_sex_assigned_at_birth,
    test_type: metadata.test_type,
    test_lab_id: metadata.test_lab_id,
    test_collection_date: metadata.test_collection_date,
    panel_classes: metadata.panel_classes,
  };

  // Load logo once; shared between the HTML builder and any future use.
  const logo = await loadLogoBase64();

  // Build Health Analysis PDF — HTML string first, then Puppeteer render.
  const html = buildHealthAnalysisHtml({
    output: analysisOutput,
    routeAudit,
    requestMetadata,
    tsiResolver,
    logoBase64: logo?.base64,
    logoMimeType: logo?.mimeType,
  });

  const [healthAnalysis, formulationSchedule] = await Promise.all([
    generateHealthAnalysisPdf({ html }).then((buf) => buf as unknown as Buffer),
    generateFormulationSchedule({
      output: analysisOutput,
      tsiResolver,
      routeAudit,
      granuleVerification: granuleVerification as Parameters<typeof generateFormulationSchedule>[0]['granuleVerification'],
    }),
  ]);

  return {
    healthAnalysis: healthAnalysis as unknown as Buffer,
    formulationSchedule: formulationSchedule as unknown as Buffer,
  };
}
