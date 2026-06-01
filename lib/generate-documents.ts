/**
 * lib/generate-documents.ts
 *
 * Programmatic wrapper around the document generators. Called from the API
 * routes after successful formulation analysis to produce and persist the
 * practitioner-facing docx and xlsx.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';

import {
  generateHealthAnalysis,
} from '@/scripts/generate-docs/health-analysis';
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

  const [healthAnalysis, formulationSchedule] = await Promise.all([
    generateHealthAnalysis({
      output: analysisOutput,
      tsiResolver,
      routeAudit,
      requestMetadata,
    }),
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
