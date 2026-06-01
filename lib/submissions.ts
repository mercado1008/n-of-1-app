/**
 * lib/submissions.ts
 *
 * File-based persistence for formulation submissions.
 * Each submission is stored as two JSON files under data/submissions/{id}/:
 *   request.json  — the RequestMetadata sent by the practitioner
 *   response.json — the full API response (output, audit, granule_verification, usage)
 *
 * This is dev-only file persistence. No database, no auth.
 */

import { mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import type { RequestMetadata } from './request-schema';
import type { AuditBlock } from './build-prompt';

const SUBMISSIONS_DIR = path.join(process.cwd(), 'data', 'submissions');

export interface SubmissionResponse {
  ok: true;
  output: Record<string, unknown>;
  audit: AuditBlock;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  stop_reason: string | null;
  granule_verification: {
    computed_total_granules: number;
    computed_total_pod_weight_mg: number;
    pod_budget_used: number;
    computed_per_ingredient: unknown[];
    claude_granule_discrepancy_count: number;
  };
}

export interface SubmissionSummary {
  id: string;
  patient_pseudonym: string;
  test_type: string;
  panel_classes: string[];
  collection_date: string;
  submitted_at: string;
  output_type: string;
  pod_fill_pct: number;
  granules: number;
  pattern_count: number;
  ingredient_count: number;
}

export const DOCUMENT_NAMES = {
  healthAnalysis: 'health-analysis.docx',
  formulationSchedule: 'formulation-schedule.xlsx',
} as const;

export async function saveDocuments(
  submissionId: string,
  healthAnalysis: Buffer,
  formulationSchedule: Buffer,
): Promise<void> {
  const dir = path.join(SUBMISSIONS_DIR, submissionId);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(path.join(dir, DOCUMENT_NAMES.healthAnalysis), healthAnalysis),
    writeFile(path.join(dir, DOCUMENT_NAMES.formulationSchedule), formulationSchedule),
  ]);
}

export async function hasDocuments(submissionId: string): Promise<boolean> {
  try {
    const dir = path.join(SUBMISSIONS_DIR, submissionId);
    await Promise.all([
      access(path.join(dir, DOCUMENT_NAMES.healthAnalysis)),
      access(path.join(dir, DOCUMENT_NAMES.formulationSchedule)),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function getDocumentPath(
  submissionId: string,
  type: keyof typeof DOCUMENT_NAMES,
): Promise<string> {
  return path.join(SUBMISSIONS_DIR, submissionId, DOCUMENT_NAMES[type]);
}

export async function saveSubmission(
  metadata: RequestMetadata,
  response: SubmissionResponse,
): Promise<void> {
  const dir = path.join(SUBMISSIONS_DIR, metadata.submission_id);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(path.join(dir, 'request.json'), JSON.stringify(metadata, null, 2), 'utf-8'),
    writeFile(path.join(dir, 'response.json'), JSON.stringify(response, null, 2), 'utf-8'),
  ]);
}

export async function getSubmission(id: string): Promise<{
  request: RequestMetadata;
  response: SubmissionResponse;
} | null> {
  try {
    const dir = path.join(SUBMISSIONS_DIR, id);
    const [reqRaw, resRaw] = await Promise.all([
      readFile(path.join(dir, 'request.json'), 'utf-8'),
      readFile(path.join(dir, 'response.json'), 'utf-8'),
    ]);
    return {
      request: JSON.parse(reqRaw) as RequestMetadata,
      response: JSON.parse(resRaw) as SubmissionResponse,
    };
  } catch {
    return null;
  }
}

export async function listSubmissions(): Promise<SubmissionSummary[]> {
  try {
    const entries = await readdir(SUBMISSIONS_DIR, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);

    const summaries = await Promise.all(
      dirs.map(async (id): Promise<SubmissionSummary | null> => {
        try {
          const sub = await getSubmission(id);
          if (!sub) return null;
          const { request, response } = sub;
          const output = response.output;
          const outputType = (output.output_type as string) ?? 'unknown';
          const gv = response.granule_verification;
          return {
            id,
            patient_pseudonym: request.patient_pseudonym,
            test_type: request.test_type,
            panel_classes: request.panel_classes,
            collection_date: request.test_collection_date,
            submitted_at: response.audit.generated_at_iso,
            output_type: outputType,
            pod_fill_pct: Math.round(gv.pod_budget_used * 1000) / 10,
            granules: gv.computed_total_granules,
            pattern_count: Array.isArray(output.recognised_patterns)
              ? (output.recognised_patterns as unknown[]).length
              : 0,
            ingredient_count:
              outputType === 'formulation' && Array.isArray(output.proposed_formulation)
                ? (output.proposed_formulation as unknown[]).length
                : 0,
          };
        } catch {
          return null;
        }
      }),
    );

    return summaries
      .filter((s): s is SubmissionSummary => s !== null)
      .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
  } catch {
    return [];
  }
}
