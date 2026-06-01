/**
 * app/api/analyse-hl7/route.ts
 *
 * POST /api/analyse-hl7
 *
 * HL7 input variant of /api/analyse. Accepts a raw HL7 v2.3.1 ORU^R01
 * message (as a text field) and the same practitioner metadata JSON as the
 * PDF path. The HL7 message is parsed into structured BiomarkerFinding[]
 * which are embedded directly in the user prompt — no PDF document is
 * attached to the Anthropic message.
 *
 * The response shape is identical to /api/analyse:
 *   { ok, output, audit, usage, stop_reason, granule_verification }
 *
 * The audit block carries input_source: 'hl7' and pdf_sha256 contains the
 * SHA-256 of the HL7 message bytes (same field, different source material).
 *
 * --- Request ---
 *
 *   Content-Type: multipart/form-data
 *
 *   hl7:             string — raw HL7 v2.3.1 message text — required
 *   metadata:        string (JSON-encoded RequestMetadata) — required
 *   clinical_notes:  string (≤10,000 chars) — optional
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  callClaudeForAnalysisFromText,
  ClaudeOutputShapeError,
  ClaudeUpstreamError,
} from '@/lib/claude-client';
import {
  assembleFullSystemPrompt,
  buildAuditBlock,
  buildHL7UserPrompt,
} from '@/lib/build-prompt';
import {
  ClinicalNotesSchema,
  RequestMetadataSchema,
} from '@/lib/request-schema';
import { adaptHL7Message } from '@/lib/hl7-adapter';
import { promises as fs } from 'fs';
import path from 'path';
import { verifyGranuleCounts, type LibraryFileForGranules } from '@/lib/granule-calc';
import { computeAuditReference } from '@/lib/audit-ref';
import { appendAuditLog } from '@/lib/audit-log';
import { generateCitations } from '@/lib/generate-citations';
import { saveSubmission, saveDocuments } from '@/lib/submissions';
import { generateDocuments } from '@/lib/generate-documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 600;

// ---------------------------------------------------------------------------
// Helpers (identical to /api/analyse)
// ---------------------------------------------------------------------------

function badRequest(message: string, detail?: unknown) {
  return NextResponse.json(
    { ok: false, error: { code: 'bad_request', message, detail } },
    { status: 400 },
  );
}

function serverConfigError(message: string) {
  return NextResponse.json(
    { ok: false, error: { code: 'server_misconfigured', message } },
    { status: 500 },
  );
}

function upstreamError(err: ClaudeUpstreamError) {
  return NextResponse.json(
    { ok: false, error: { code: 'claude_upstream_error', message: err.message, status: err.status } },
    { status: 502 },
  );
}

function shapeError(err: ClaudeOutputShapeError) {
  return NextResponse.json(
    { ok: false, error: { code: 'claude_output_shape_error', message: err.message, zod_issues: err.zodIssues, detail: err.raw } },
    { status: 502 },
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return serverConfigError('ANTHROPIC_API_KEY is not set. Configure it in .env.local.');
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return badRequest('Could not parse multipart/form-data body.', String(err));
  }

  const hl7Field = form.get('hl7');
  const metadataField = form.get('metadata');
  const notesField = form.get('clinical_notes');

  if (typeof hl7Field !== 'string' || hl7Field.trim().length === 0) {
    return badRequest('Field "hl7" is required and must be a non-empty string.');
  }
  if (typeof metadataField !== 'string') {
    return badRequest('Field "metadata" is required and must be a JSON string.');
  }

  // Validate metadata JSON.
  let metadataJson: unknown;
  try {
    metadataJson = JSON.parse(metadataField);
  } catch (err) {
    return badRequest('Field "metadata" is not valid JSON.', String(err));
  }
  const metadataParsed = RequestMetadataSchema.safeParse(metadataJson);
  if (!metadataParsed.success) {
    return badRequest('Metadata failed schema validation.', metadataParsed.error.issues);
  }
  const metadata = metadataParsed.data;

  // Validate clinical notes.
  const notesParsed = ClinicalNotesSchema.safeParse(
    typeof notesField === 'string' ? notesField : '',
  );
  if (!notesParsed.success) {
    return badRequest('Clinical notes failed schema validation.', notesParsed.error.issues);
  }
  const clinicalNotes = notesParsed.data;

  // Parse the HL7 message.
  let parsed;
  try {
    parsed = adaptHL7Message(hl7Field);
  } catch (err) {
    return badRequest(`HL7 parse failed: ${(err as Error).message}`);
  }

  if (parsed.numeric_findings.length === 0) {
    return badRequest('HL7 message contains no numeric OBX findings (NM type). Cannot generate a formulation from an empty result set.');
  }

  // Build audit block using the SHA-256 of the raw HL7 bytes.
  const hl7Bytes = new TextEncoder().encode(hl7Field);
  const audit = buildAuditBlock({
    metadata,
    pdfBytes: hl7Bytes,
    model: 'claude-opus-4-7',
    inputSource: 'hl7',
  });

  // Assemble prompts.
  let systemPrompt: import('@/lib/build-prompt').SystemPromptBlocks;
  try {
    systemPrompt = await assembleFullSystemPrompt();
  } catch (err) {
    return serverConfigError(`Could not load system prompt or library: ${(err as Error).message}`);
  }
  const userPrompt = buildHL7UserPrompt(metadata, parsed, clinicalNotes);

  // Call Claude (text-only, no PDF attachment).
  try {
    const result = await callClaudeForAnalysisFromText({ systemPrompt, userPrompt });

    // Load library for deterministic granule computation.
    const libraryPath = path.join(process.cwd(), 'data', 'library-built', 'ingredients-library.json');
    let library: LibraryFileForGranules;
    try {
      const raw = await fs.readFile(libraryPath, 'utf-8');
      library = JSON.parse(raw) as LibraryFileForGranules;
    } catch (err) {
      return serverConfigError(`Could not load library for granule verification: ${(err as Error).message}`);
    }

    const verification = verifyGranuleCounts({ output: result.output, library });
    if (!verification.ok) {
      try {
        await appendAuditLog({
          audit_reference: computeAuditReference(audit),
          audit,
          outcome: {
            output_type: result.output.output_type,
            granules_computed: verification.computed_total_granules,
            pod_budget_used: verification.pod_budget_used,
            ingredient_count: result.output.output_type === 'formulation' ? result.output.proposed_formulation.length : undefined,
            stop_reason: result.stop_reason,
          },
          usage: result.usage,
        });
      } catch (logErr) {
        console.error('[audit-log] Failed to write audit log entry:', logErr);
      }
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: 'granule_verification_failed',
            message: 'Granule verification failed on a structural issue (unit mismatch, missing library data, or pod over-budget). See issues array.',
            issues: verification.issues,
            computed_total_granules: verification.computed_total_granules,
            pod_overage: verification.pod_overage,
          },
        },
        { status: 502 },
      );
    }

    // Second pass: generate citations for each formulation ingredient.
    // Runs after granule verification succeeds — citation failure never blocks the response.
    let outputWithCitations = result.output;
    if (result.output.output_type === 'formulation') {
      try {
        const ingredients = result.output.proposed_formulation.map((ing) => ({
          ingredient_name: ing.common_name ?? ing.tsi_code ?? '',
          clinical_context: (ing.target_biomarker_findings ?? []).slice(0, 3).join(', ')
            || (typeof ing.rationale_for_practitioner === 'string'
              ? ing.rationale_for_practitioner.slice(0, 200)
              : ''),
        }));
        const citations = await generateCitations(ingredients);
        if (citations.length > 0) {
          outputWithCitations = { ...result.output, references: citations };
        }
      } catch (citErr) {
        console.error('[citations] Failed to generate citations:', citErr);
      }
    }

    try {
      await appendAuditLog({
        audit_reference: computeAuditReference(audit),
        audit,
        outcome: {
          output_type: result.output.output_type,
          granules_computed: verification.computed_total_granules,
          pod_budget_used: verification.pod_budget_used,
          ingredient_count: result.output.output_type === 'formulation' ? result.output.proposed_formulation.length : undefined,
          stop_reason: result.stop_reason,
        },
        usage: result.usage,
      });
    } catch (logErr) {
      console.error('[audit-log] Failed to write audit log entry:', logErr);
    }

    const responseBody = {
      ok: true as const,
      output: outputWithCitations as Record<string, unknown>,
      audit,
      usage: result.usage,
      stop_reason: result.stop_reason,
      granule_verification: {
        computed_total_granules: verification.computed_total_granules,
        computed_total_pod_weight_mg: verification.computed_total_pod_weight_mg,
        pod_budget_used: verification.pod_budget_used,
        computed_per_ingredient: verification.computed_per_ingredient,
        claude_granule_discrepancy_count: verification.claude_granule_discrepancy_count,
      },
    };

    try {
      await saveSubmission(metadata, responseBody);
    } catch (saveErr) {
      console.error('[submissions] Failed to save submission:', saveErr);
    }

    if (result.output.output_type === 'formulation') {
      try {
        const docs = await generateDocuments({
          output: outputWithCitations as Record<string, unknown>,
          routeAudit: audit,
          metadata,
          granuleVerification: {
            computed_total_granules: verification.computed_total_granules,
            computed_total_pod_weight_mg: verification.computed_total_pod_weight_mg,
            pod_budget_used: verification.pod_budget_used,
            computed_per_ingredient: verification.computed_per_ingredient,
            claude_granule_discrepancy_count: verification.claude_granule_discrepancy_count,
          },
        });
        await saveDocuments(metadata.submission_id, docs.healthAnalysis, docs.formulationSchedule);
      } catch (docErr) {
        console.error('[documents] Failed to generate or save documents:', docErr);
      }
    }

    return NextResponse.json(
      {
        ok: true,
        output: outputWithCitations,
        audit,
        usage: result.usage,
        stop_reason: result.stop_reason,
        granule_verification: {
          computed_total_granules: verification.computed_total_granules,
          computed_total_pod_weight_mg: verification.computed_total_pod_weight_mg,
          pod_budget_used: verification.pod_budget_used,
          computed_per_ingredient: verification.computed_per_ingredient,
          claude_granule_discrepancy_count: verification.claude_granule_discrepancy_count,
        },
      },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof ClaudeUpstreamError) return upstreamError(err);
    if (err instanceof ClaudeOutputShapeError) return shapeError(err);
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { ok: false, error: { code: 'unexpected_validation_error', message: 'A schema validation error escaped the typed paths.', zod_issues: err.issues } },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { ok: false, error: { code: 'unhandled', message: `Unhandled error: ${(err as Error).message}` } },
      { status: 500 },
    );
  }
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: { code: 'method_not_allowed', message: 'POST only.' } },
    { status: 405 },
  );
}
