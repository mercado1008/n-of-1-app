/**
 * lib/claude-client.ts
 *
 * Wraps the Anthropic SDK call for /api/analyse.
 *
 * The single responsibility of this module is: given a system prompt, a PDF,
 * a metadata + clinical-notes user message, and the Zod output schema,
 * call Claude Opus 4.7 with forced tool use and return the parsed-and-
 * validated structured output.
 *
 * Schema enforcement strategy (Phase 3, Option A):
 *
 *   1. Forced tool use — `tool_choice: { type: 'tool', name: 'submit_analysis' }`
 *      forces Claude to call the tool exactly once. There is no free-text
 *      response path.
 *
 *   2. Schema-as-hint — the JSON Schema is sent as `input_schema` on the tool
 *      definition. Without `strict: true`, this is a hint, not a grammar
 *      constraint. Phase 2 verified that Claude follows this hint reliably
 *      (8/8 TSI codes valid, refusal logic clean).
 *
 *   3. Full Zod post-validation — every response is validated against the
 *      complete `ClaudeOutputSchema` including `.passthrough()` semantics,
 *      regex patterns, length bounds, the `not_*` library_revision sentinel,
 *      and the discriminated-union arm.
 *
 * We deliberately do NOT use `strict: true` because the November-2025
 * structured-outputs feature is incompatible with the v0.2.0 schema:
 *   - strict requires `additionalProperties: false`, but we use `.passthrough()`
 *     to accept thoughtful field variations from Claude;
 *   - strict does not support `minLength`/`maxLength`/`minimum`/`maximum`/`pattern`,
 *     all of which the v0.2.0 schema uses (HedgedClinicalText, TSI regex, etc.);
 *   - strict has known 500-error issues with deeply nested schemas of this size
 *     (anthropics/anthropic-sdk-typescript#885).
 *
 * If we ever want grammar-constrained shape enforcement, we'd need a parallel
 * "strict-compatible" schema with the above features stripped — see the Phase 3
 * completion doc for the tradeoff analysis.
 *
 * Wire-format defensive normalisation (added v0.4.1 era):
 *
 *   For long structured outputs (~30k+ output tokens), Claude's tool_use can
 *   exhibit two intermittent failure modes that compound:
 *     (a) `result` is delivered as a JSON-stringified object rather than a
 *         parsed object — Zod sees a string where it expects an object.
 *     (b) The string contains JSON-invalid trailing commas after the last
 *         property of an object or last item of an array — JSON.parse throws.
 *
 *   We handle both transparently in normaliseToolInput() before validation.
 *   If parsing still fails after the trailing-comma cleanup, we leave the
 *   input as-is and let Zod report a diagnostic shape error to the caller.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import {
  ClaudeOutputSchema,
  ClaudeToolInputSchema,
  type ClaudeOutput,
} from '@/prompts/output-schema';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODEL = 'claude-opus-4-7';
const TOOL_NAME = 'submit_analysis';
const MAX_TOKENS = 32768;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ClaudeUpstreamError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ClaudeUpstreamError';
  }
}

export class ClaudeOutputShapeError extends Error {
  constructor(
    message: string,
    public readonly raw: unknown,
    public readonly zodIssues?: z.ZodIssue[],
  ) {
    super(message);
    this.name = 'ClaudeOutputShapeError';
  }
}

// ---------------------------------------------------------------------------
// Tool schema (compiled once at module load)
// ---------------------------------------------------------------------------

type ToolInputSchema = Anthropic.Messages.Tool.InputSchema;

/**
 * Convert the Zod wrapper schema to a JSON Schema suitable for Anthropic's
 * tool `input_schema`. Anthropic rejects `anyOf`/`oneOf`/`allOf` at the top
 * level; the wrapper exists to satisfy this constraint by placing the
 * discriminated union under a single `result` property.
 */
function buildToolInputSchema(): ToolInputSchema {
  // Zod v4 has built-in JSON Schema generation via z.toJSONSchema(). The
  // output is a draft-2020-12 schema with `type: "object"` at the root and
  // the discriminated union nested under `properties.result` as `oneOf` —
  // exactly the shape Anthropic's tool input_schema requires.
  const schema = z.toJSONSchema(ClaudeToolInputSchema) as Record<string, unknown>;

  if (schema.type !== 'object') {
    throw new Error(
      `Expected top-level JSON schema type "object" but got "${String(schema.type)}". ` +
        'The Anthropic tool input_schema must be an object schema and must not use ' +
        'anyOf/oneOf/allOf at the top level. Got keys: ' +
        Object.keys(schema).join(', '),
    );
  }
  return schema as ToolInputSchema;
}

const TOOL_INPUT_SCHEMA = buildToolInputSchema();

// ---------------------------------------------------------------------------
// Defensive tool-input normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise the raw `input` from a tool_use block before validation.
 *
 * Handles two intermittent failure modes seen on long outputs:
 *   1. `result` arrives as a JSON-encoded string rather than an object.
 *   2. The encoded string contains JSON-invalid trailing commas.
 *
 * Returns the input unchanged unless one of those conditions applies.
 * If parsing still fails after a single trailing-comma cleanup, returns
 * the input unchanged — Zod will then raise a clear validation error.
 *
 * The trailing-comma cleanup is intentionally narrow: it strips commas
 * that directly precede `}` or `]` (with optional whitespace). It does
 * NOT attempt to repair other JSON syntax issues; that would warrant a
 * proper repair library like `jsonrepair`.
 */
function normaliseToolInput(rawInput: unknown): unknown {
  if (
    !rawInput ||
    typeof rawInput !== 'object' ||
    !('result' in rawInput) ||
    typeof (rawInput as { result: unknown }).result !== 'string'
  ) {
    return rawInput;
  }

  const resultString = (rawInput as { result: string }).result;

  const tryParse = (s: string): unknown | null => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  let parsedResult = tryParse(resultString);
  if (parsedResult === null) {
    // Strip trailing commas before } or ] (with optional whitespace) and retry.
    const cleaned = resultString.replace(/,(\s*[}\]])/g, '$1');
    parsedResult = tryParse(cleaned);
  }

  if (parsedResult === null) {
    // Both attempts failed. Return original; Zod will report a clear error
    // (the caller sees `result` typed as string when an object is expected).
    return rawInput;
  }

  return { ...(rawInput as Record<string, unknown>), result: parsedResult };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AnalyseClaudeArgs {
  systemPrompt: string;
  /** Base64-encoded PDF bytes. */
  pdfBase64: string;
  /** Free-text user prompt: practitioner metadata block + clinical notes. */
  userPrompt: string;
  /** Optional override for testing (e.g. injected mock client). */
  client?: Anthropic;
}

export interface AnalyseClaudeArgsFromText {
  systemPrompt: string;
  /**
   * Full user prompt including inline biomarker data (HL7 path).
   * No PDF document is attached — all test data is embedded as text.
   */
  userPrompt: string;
  /** Optional override for testing. */
  client?: Anthropic;
}

export interface AnalyseClaudeResult {
  output: ClaudeOutput;
  /** Anthropic usage block — useful for cost tracking and audit. */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  /** stop_reason from the API. Should be "tool_use" on success. */
  stop_reason: string | null;
  /** Raw tool input as returned by the model, before Zod validation. */
  rawToolInput: unknown;
}

// ---------------------------------------------------------------------------
// Shared internal call handler
// ---------------------------------------------------------------------------

type MessageContent = Anthropic.Messages.ContentBlockParam[];

async function executeClaudeCall(
  client: Anthropic,
  systemPrompt: string,
  content: MessageContent,
): Promise<AnalyseClaudeResult> {
  let response;
  try {
    // We stream rather than using messages.create directly because the SDK
    // refuses non-streaming calls whose estimated runtime exceeds 10 minutes
    // (e.g. large PDFs + high MAX_TOKENS). Streaming has no such restriction.
    // We call .finalMessage() to assemble the streamed deltas into the same
    // shape messages.create returns — content blocks, stop_reason, usage.
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      tools: [
        {
          name: TOOL_NAME,
          description:
            'Submit the structured N of 1 precision formulation analysis. ' +
            'You MUST call this tool exactly once. The tool input has a ' +
            'single property `result` which is a discriminated union on ' +
            '`output_type`: use "formulation" for a valid analysis or ' +
            '"refusal" when any precondition is not met (unsafe input, out of ' +
            'scope, unreadable data, contradictory data, minor patient).',
          input_schema: TOOL_INPUT_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{ role: 'user', content }],
    });
    response = await stream.finalMessage();
  } catch (err) {
    const status = (err as { status?: number })?.status;
    throw new ClaudeUpstreamError(
      `Anthropic API call failed${status ? ` (HTTP ${status})` : ''}: ${(err as Error).message}`,
      status,
      err,
    );
  }

  // Find the tool_use block. Under tool_choice: tool there should be exactly
  // one, but we defend against unexpected shapes.
  const toolUseBlock = response.content.find((b) => b.type === 'tool_use');
  if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
    throw new ClaudeOutputShapeError(
      `Expected a tool_use block but got stop_reason="${response.stop_reason}". ` +
        'This usually indicates max_tokens truncation or an upstream API change.',
      response,
    );
  }

  if (toolUseBlock.name !== TOOL_NAME) {
    throw new ClaudeOutputShapeError(
      `Expected tool "${TOOL_NAME}" but got "${toolUseBlock.name}".`,
      toolUseBlock,
    );
  }

  // Defensive: normalise tool input shape before validation. Handles the
  // intermittent "result delivered as JSON string with trailing commas"
  // failure mode seen on long outputs. See normaliseToolInput() docblock.
  const normalisedInput = normaliseToolInput(toolUseBlock.input);

  // Validate against the wrapper schema. Without strict mode, this is the
  // ONLY enforcement layer — every shape, regex, length bound, and bounds
  // check happens here. Failures are typed as ClaudeOutputShapeError with
  // the full Zod issue list attached for diagnosis.
  const parsed = ClaudeToolInputSchema.safeParse(normalisedInput);
  if (!parsed.success) {
    throw new ClaudeOutputShapeError(
      'Claude tool input failed Zod validation against ClaudeToolInputSchema. ' +
        'See zodIssues for the specific field(s) that failed.',
      normalisedInput,
      parsed.error.issues,
    );
  }

  // Defence-in-depth: revalidate the unwrapped output against the public
  // ClaudeOutputSchema. This is a no-op if the wrapper succeeded but guards
  // against future schema drift between the wrapper and the inner union.
  const innerParsed = ClaudeOutputSchema.safeParse(parsed.data.result);
  if (!innerParsed.success) {
    throw new ClaudeOutputShapeError(
      'Inner ClaudeOutput failed validation after wrapper unwrap.',
      parsed.data.result,
      innerParsed.error.issues,
    );
  }

  return {
    output: innerParsed.data,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? null,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? null,
    },
    stop_reason: response.stop_reason,
    rawToolInput: toolUseBlock.input,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Call Claude with a PDF document attached. Used by /api/analyse.
 * Errors are typed: ClaudeUpstreamError for API failures,
 * ClaudeOutputShapeError for any response that fails our validation.
 */
export async function callClaudeForAnalysis(
  args: AnalyseClaudeArgs,
): Promise<AnalyseClaudeResult> {
  const client = args.client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return executeClaudeCall(client, args.systemPrompt, [
    {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: args.pdfBase64,
      },
    },
    { type: 'text', text: args.userPrompt },
  ]);
}

/**
 * Call Claude with inline text content only (no PDF). Used by /api/analyse-hl7
 * where the biomarker data is pre-extracted from HL7 and embedded in the prompt.
 */
export async function callClaudeForAnalysisFromText(
  args: AnalyseClaudeArgsFromText,
): Promise<AnalyseClaudeResult> {
  const client = args.client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return executeClaudeCall(client, args.systemPrompt, [
    { type: 'text', text: args.userPrompt },
  ]);
}
