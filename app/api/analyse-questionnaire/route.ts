/**
 * app/api/analyse-questionnaire/route.ts
 *
 * POST /api/analyse-questionnaire
 *
 * SPP (Symptom Presentation Panel) input path. No pathology test is
 * attached — the practitioner-submitted symptom questionnaire is the sole
 * clinical input. Unlike /api/analyse and /api/analyse-hl7 there is no file
 * involved, so the request body is plain JSON rather than multipart/form-data.
 *
 * From granule verification onward this route's pipeline is identical to
 * /api/analyse-hl7 — verification, the underfill-retry backstop, citations,
 * audit log, persistence, and document generation are all input-format-
 * agnostic and reused unchanged.
 *
 * The response shape is identical to the other two routes:
 *   { ok, output, audit, usage, stop_reason, granule_verification, retry_info? }
 *
 * The audit block carries input_source: 'questionnaire' and pdf_sha256
 * contains the SHA-256 of the canonicalised questionnaire-answers JSON
 * (same field, different source material).
 *
 * --- Request ---
 *
 *   Content-Type: application/json
 *
 *   {
 *     metadata: RequestMetadata,       // panel_classes MUST be exactly ["SPP"]
 *     clinical_notes?: string,         // ≤10,000 chars
 *     questionnaire: QuestionnaireAnswers
 *   }
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
  buildQuestionnaireUserPrompt,
} from '@/lib/build-prompt';
import {
  ClinicalNotesSchema,
  RequestMetadataSchema,
} from '@/lib/request-schema';
import {
  QuestionnaireAnswersSchema,
  hasAnyClinicalContent,
} from '@/lib/questionnaire-schema';
import { promises as fs } from 'fs';
import path from 'path';
import { verifyGranuleCounts, type LibraryFileForGranules } from '@/lib/granule-calc';
import { computeAuditReference } from '@/lib/audit-ref';
import { appendAuditLog } from '@/lib/audit-log';
import { generateCitations } from '@/lib/generate-citations';
import { saveSubmission, saveDocuments } from '@/lib/submissions';
import { generateDocuments } from '@/lib/generate-documents';
import {
  multiPatternFloorApplies,
  isUnderfilled,
  buildUnderfillRetryAddendum,
} from '@/lib/underfill-retry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// Helpers (identical to the other two routes)
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

  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return badRequest('Could not parse JSON body.', String(err));
  }
  if (typeof body !== 'object' || body === null) {
    return badRequest('Request body must be a JSON object.');
  }
  const { metadata: metadataJson, clinical_notes: notesField, questionnaire: questionnaireJson } =
    body as Record<string, unknown>;

  const metadataParsed = RequestMetadataSchema.safeParse(metadataJson);
  if (!metadataParsed.success) {
    return badRequest('Metadata failed schema validation.', metadataParsed.error.issues);
  }
  const metadata = metadataParsed.data;

  if (metadata.panel_classes.length !== 1 || metadata.panel_classes[0] !== 'SPP') {
    return badRequest('This route only accepts panel_classes: ["SPP"] (Symptom Presentation Panel).', {
      received: metadata.panel_classes,
    });
  }

  const notesParsed = ClinicalNotesSchema.safeParse(
    typeof notesField === 'string' ? notesField : '',
  );
  if (!notesParsed.success) {
    return badRequest('Clinical notes failed schema validation.', notesParsed.error.issues);
  }
  const clinicalNotes = notesParsed.data;

  const questionnaireParsed = QuestionnaireAnswersSchema.safeParse(questionnaireJson);
  if (!questionnaireParsed.success) {
    return badRequest('Questionnaire failed schema validation.', questionnaireParsed.error.issues);
  }
  const questionnaire = questionnaireParsed.data;

  if (!hasAnyClinicalContent(questionnaire, clinicalNotes)) {
    return badRequest('Questionnaire has no clinical content — every symptom category is "none" and clinical notes are empty. Rate at least one category or add clinical notes.');
  }

  // Build audit block using the SHA-256 of the canonicalised questionnaire JSON.
  const questionnaireBytes = new TextEncoder().encode(JSON.stringify(questionnaire));
  const audit = buildAuditBlock({
    metadata,
    pdfBytes: questionnaireBytes,
    model: 'claude-opus-4-7',
    inputSource: 'questionnaire',
  });

  // Assemble prompts.
  let systemPrompt: import('@/lib/build-prompt').SystemPromptBlocks;
  try {
    systemPrompt = await assembleFullSystemPrompt();
  } catch (err) {
    return serverConfigError(`Could not load system prompt or library: ${(err as Error).message}`);
  }
  const userPrompt = buildQuestionnaireUserPrompt(metadata, questionnaire, clinicalNotes);

  // Call Claude (text-only, no document attachment).
  try {
    let result = await callClaudeForAnalysisFromText({ systemPrompt, userPrompt });

    // Load library for deterministic granule computation.
    const libraryPath = path.join(process.cwd(), 'data', 'library-built', 'ingredients-library.json');
    let library: LibraryFileForGranules;
    try {
      const raw = await fs.readFile(libraryPath, 'utf-8');
      library = JSON.parse(raw) as LibraryFileForGranules;
    } catch (err) {
      return serverConfigError(`Could not load library for granule verification: ${(err as Error).message}`);
    }

    let verification = verifyGranuleCounts({ output: result.output, library });
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

    // Underfill retry backstop (see lib/underfill-retry.ts). Mirrors the
    // PDF and HL7 routes — see there for full rationale.
    let totalUsage = { ...result.usage };
    let underfillRetryAttempted = false;
    let underfillRetryOutcome: 'succeeded' | 'still_underfilled' | 'retry_failed' | undefined;
    let preRetryGranules: number | undefined;

    if (
      result.output.output_type === 'formulation' &&
      multiPatternFloorApplies(result.output, clinicalNotes) &&
      isUnderfilled(verification)
    ) {
      underfillRetryAttempted = true;
      preRetryGranules = verification.computed_total_granules;
      try {
        const retryAddendum = buildUnderfillRetryAddendum({
          output: result.output,
          verification,
        });
        const retryResult = await callClaudeForAnalysisFromText({
          systemPrompt,
          userPrompt: userPrompt + '\n' + retryAddendum,
        });
        const retryVerification = verifyGranuleCounts({ output: retryResult.output, library });

        totalUsage = {
          input_tokens: totalUsage.input_tokens + retryResult.usage.input_tokens,
          output_tokens: totalUsage.output_tokens + retryResult.usage.output_tokens,
          cache_creation_input_tokens:
            (totalUsage.cache_creation_input_tokens ?? 0) + (retryResult.usage.cache_creation_input_tokens ?? 0),
          cache_read_input_tokens:
            (totalUsage.cache_read_input_tokens ?? 0) + (retryResult.usage.cache_read_input_tokens ?? 0),
        };

        if (retryVerification.ok) {
          result = retryResult;
          verification = retryVerification;
          underfillRetryOutcome = isUnderfilled(retryVerification) ? 'still_underfilled' : 'succeeded';
        } else {
          console.error('[underfill-retry] Retry produced a structurally invalid result, keeping original:', retryVerification.issues);
          underfillRetryOutcome = 'retry_failed';
        }
      } catch (retryErr) {
        console.error('[underfill-retry] Retry call failed:', retryErr);
        underfillRetryOutcome = 'retry_failed';
      }
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
          underfill_retry_attempted: underfillRetryAttempted || undefined,
          underfill_retry_outcome: underfillRetryOutcome,
          pre_retry_granules_computed: preRetryGranules,
        },
        usage: totalUsage,
      });
    } catch (logErr) {
      console.error('[audit-log] Failed to write audit log entry:', logErr);
    }

    const responseBody = {
      ok: true as const,
      output: outputWithCitations as Record<string, unknown>,
      audit,
      usage: totalUsage,
      stop_reason: result.stop_reason,
      granule_verification: {
        computed_total_granules: verification.computed_total_granules,
        computed_total_pod_weight_mg: verification.computed_total_pod_weight_mg,
        pod_budget_used: verification.pod_budget_used,
        computed_per_ingredient: verification.computed_per_ingredient,
        claude_granule_discrepancy_count: verification.claude_granule_discrepancy_count,
      },
      ...(underfillRetryAttempted
        ? {
            retry_info: {
              underfill_retry_attempted: true,
              underfill_retry_outcome: underfillRetryOutcome,
              pre_retry_granules_computed: preRetryGranules,
            },
          }
        : {}),
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

    return NextResponse.json(responseBody, { status: 200 });
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
