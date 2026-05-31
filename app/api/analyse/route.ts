/**
 * app/api/analyse/route.ts
 *
 * POST /api/analyse
 *
 * Phase 3 of the N of 1 build. Accepts a pathology PDF + practitioner
 * metadata + clinical notes (multipart/form-data), calls Claude Opus 4.7
 * with strict tool-use schema enforcement, and returns the validated
 * structured output along with an audit metadata block.
 *
 * Out of scope for this phase: frontend, Shopify integration, document
 * generation. The caller is responsible for any UI or downstream
 * persistence.
 *
 * --- Request ---
 *
 * Content-Type: multipart/form-data
 *
 *   pdf:             File (application/pdf, ≤10MB) — required
 *   metadata:        string (JSON-encoded RequestMetadata) — required
 *   clinical_notes:  string (≤10,000 chars) — optional
 *
 * --- Response ---
 *
 *   200 OK
 *     {
 *       ok: true,
 *       output: ClaudeOutput,
 *       audit: AuditBlock,
 *       usage: {...},
 *       stop_reason: "tool_use",
 *       granule_verification: {
 *         computed_total_granules,
 *         computed_total_pod_weight_mg,
 *         pod_budget_used,
 *         computed_per_ingredient: [...],   // route-authoritative per-ingredient granules
 *         claude_granule_discrepancy_count, // diagnostic only
 *       }
 *     }
 *
 *   `output.output_type` is either "formulation" or "refusal" — refusal is
 *   a legitimate first-class output, not an error.
 *
 *   400 Bad Request — malformed multipart, missing fields, invalid metadata,
 *   PDF too large, PDF wrong MIME type, patient under 18.
 *
 *   500 Internal Server Error — server misconfiguration (e.g. missing
 *   ANTHROPIC_API_KEY).
 *
 *   502 Bad Gateway — upstream Claude error, schema-violating output, or
 *   structural granule failure (unit mismatch, missing library data, pod
 *   over-budget). Per-ingredient granule mismatches between Claude's
 *   self-reported granules and the route's recompute are NOT 502 failures
 *   as of v0.4.4 — the route's recompute is authoritative.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  callClaudeForAnalysis,
  ClaudeOutputShapeError,
  ClaudeUpstreamError,
} from '@/lib/claude-client';
import {
  assembleFullSystemPrompt,
  buildAuditBlock,
  buildUserPrompt,
} from '@/lib/build-prompt';
import {
  ClinicalNotesSchema,
  MAX_PDF_BYTES,
  RequestMetadataSchema,
} from '@/lib/request-schema';

import { promises as fs } from 'fs';
import path from 'path';
import { verifyGranuleCounts, type LibraryFileForGranules } from '@/lib/granule-calc';
import { computeAuditReference } from '@/lib/audit-ref';
import { appendAuditLog } from '@/lib/audit-log';
import { generateCitations } from '@/lib/generate-citations';
import { saveSubmission } from '@/lib/submissions';

// Force the Node.js runtime — we use Buffer, crypto, and the Anthropic SDK,
// none of which run in the Edge runtime.
export const runtime = 'nodejs';

// Don't cache this route — every analysis is unique.
export const dynamic = 'force-dynamic';

// Hard cap on request handler duration. PDF + Claude round-trip is typically
// 30–90s; we give plenty of headroom.
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// Helpers
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
    {
      ok: false,
      error: {
        code: 'claude_upstream_error',
        message: err.message,
        status: err.status,
      },
    },
    { status: 502 },
  );
}

function shapeError(err: ClaudeOutputShapeError) {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: 'claude_output_shape_error',
        message: err.message,
        zod_issues: err.zodIssues,
        detail: err.raw,
      },
    },
    { status: 502 },
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  // 1. Server config check — fail fast if the API key is missing.
  if (!process.env.ANTHROPIC_API_KEY) {
    return serverConfigError(
      'ANTHROPIC_API_KEY is not set. Configure it in .env.local.',
    );
  }

  // 2. Parse multipart form.
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return badRequest('Could not parse multipart/form-data body.', String(err));
  }

  const pdfField = form.get('pdf');
  const metadataField = form.get('metadata');
  const notesField = form.get('clinical_notes');

  if (!(pdfField instanceof File)) {
    return badRequest('Field "pdf" is required and must be a File.');
  }
  if (typeof metadataField !== 'string') {
    return badRequest('Field "metadata" is required and must be a JSON string.');
  }

  // 3. Validate the PDF.
  if (pdfField.size === 0) {
    return badRequest('Uploaded PDF is empty.');
  }
  if (pdfField.size > MAX_PDF_BYTES) {
    return badRequest(
      `PDF exceeds maximum size of ${MAX_PDF_BYTES} bytes (got ${pdfField.size}).`,
    );
  }
  // Browsers and curl both report application/pdf; reject anything else to
  // avoid wasting an Anthropic call on a JPEG or DOCX.
  if (pdfField.type && pdfField.type !== 'application/pdf') {
    return badRequest(
      `Expected pdf MIME type "application/pdf" but got "${pdfField.type}".`,
    );
  }

  // 4. Validate metadata JSON.
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

  // 5. Validate clinical notes (if provided).
  const notesParsed = ClinicalNotesSchema.safeParse(
    typeof notesField === 'string' ? notesField : '',
  );
  if (!notesParsed.success) {
    return badRequest('Clinical notes failed schema validation.', notesParsed.error.issues);
  }
  const clinicalNotes = notesParsed.data;

  // 6. Read the PDF into memory; compute hash and base64 for the audit block
  // and for the Anthropic message.
  const pdfBytes = new Uint8Array(await pdfField.arrayBuffer());
  const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

  // 7. Assemble system + user prompts.
  let systemPrompt: import('@/lib/build-prompt').SystemPromptBlocks;
  try {
    systemPrompt = await assembleFullSystemPrompt();
  } catch (err) {
    return serverConfigError(
      `Could not load system prompt or library: ${(err as Error).message}`,
    );
  }
  const userPrompt = buildUserPrompt(metadata, clinicalNotes);

  // 8. Build the audit block now (so we have it even if the Claude call fails
  // — it's still useful for failure-mode logging).
  const audit = buildAuditBlock({
    metadata,
    pdfBytes,
    model: 'claude-opus-4-7',
  });

  // 9. Call Claude with strict tool-use schema enforcement.
  try {
    const result = await callClaudeForAnalysis({
      systemPrompt,
      pdfBase64,
      userPrompt,
    });

    // Load the library JSON for deterministic granule computation.
    // Re-reads the file already used by assembleFullSystemPrompt; this is
    // inexpensive (~50KB) and keeps the diff isolated to this route.
    const libraryPath = path.join(
      process.cwd(),
      'data',
      'library-built',
      'ingredients-library.json',
    );
    let library: LibraryFileForGranules;
    try {
      const raw = await fs.readFile(libraryPath, 'utf-8');
      library = JSON.parse(raw) as LibraryFileForGranules;
    } catch (err) {
      return serverConfigError(
        `Could not load library for granule verification: ${(err as Error).message}`,
      );
    }

    // v0.4.4 — the route owns granule arithmetic. verifyGranuleCounts
    // computes per-ingredient granules deterministically and surfaces
    // structural issues only (unit mismatch, missing library data, pod
    // over-budget). Per-ingredient discrepancies between Claude's
    // self-reported granules and the recompute are NOT failures — the
    // recompute is authoritative.
    // Refusal outputs short-circuit to ok=true inside verifyGranuleCounts.
    const verification = verifyGranuleCounts({
      output: result.output,
      library,
    });
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
            message:
              'Granule verification failed on a structural issue (unit mismatch, ' +
              'missing library data, or pod over-budget). See issues array.',
            issues: verification.issues,
            computed_total_granules: verification.computed_total_granules,
            pod_overage: verification.pod_overage,
          },
        },
        { status: 502 },
      );
    }

    // Second pass: generate citations. Runs after granule verification — failure never blocks response.
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
    if (err instanceof ClaudeUpstreamError) {
      return upstreamError(err);
    }
    if (err instanceof ClaudeOutputShapeError) {
      return shapeError(err);
    }
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: 'unexpected_validation_error',
            message: 'A schema validation error escaped the typed paths.',
            zod_issues: err.issues,
          },
        },
        { status: 502 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'unhandled',
          message: `Unhandled error: ${(err as Error).message}`,
        },
      },
      { status: 500 },
    );
  }
}

// Reject other methods cleanly.
export async function GET() {
  return NextResponse.json(
    { ok: false, error: { code: 'method_not_allowed', message: 'POST only.' } },
    { status: 405 },
  );
}
