/**
 * lib/build-prompt.ts
 *
 * Helpers for assembling the user-message text and the audit metadata
 * that accompanies every /api/analyse response.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type Anthropic from '@anthropic-ai/sdk';
import promptVersion from '@/prompts/prompt-version.json';
import type { RequestMetadata } from './request-schema';
import type { ParsedHL7Message } from './hl7-adapter';
import type { QuestionnaireAnswers } from './questionnaire-schema';

/** Cached system prompt blocks — same across all requests until the process restarts. */
export type SystemPromptBlocks = Anthropic.Messages.TextBlockParam[];

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

/** Shared task instructions appended to every user prompt regardless of input format. */
function taskSection(metadata: RequestMetadata): string[] {
  return [
    '## Task',
    '',
    'Apply the N of 1 clinical decision support workflow:',
    '1. Run the compliance pre-flight (out-of-scope, minor, unreadable, contradictory).',
    '2. If any precondition fails, call the `submit_analysis` tool with `{ result: { output_type: "refusal", ... } }`.',
    '3. Otherwise, generate the draft Health Analysis and Recommended Formulation Schedule and call `submit_analysis` with `{ result: { output_type: "formulation", ... } }`.',
    '',
    `Filter all recommendations to the practitioner type (${metadata.practitioner_type}). Cap doses to the Library and total granules to 700. Show the working for every recommendation.`,
  ];
}

/** Shared submission metadata block. */
function metadataSection(metadata: RequestMetadata): string[] {
  return [
    '## Submission metadata',
    '',
    `- Submission ID: ${metadata.submission_id}`,
    `- Practitioner ID: ${metadata.practitioner_id}`,
    `- Practitioner type: ${metadata.practitioner_type}`,
    metadata.practitioner_name
      ? `- Practitioner name: ${metadata.practitioner_name}`
      : '- Practitioner name: (not provided)',
    `- Patient pseudonym: ${metadata.patient_pseudonym}`,
    `- Patient age (years): ${metadata.patient_age_years}`,
    `- Patient sex assigned at birth: ${metadata.patient_sex_assigned_at_birth}`,
    `- Test type: ${metadata.test_type}`,
    `- Test lab ID: ${metadata.test_lab_id}`,
    `- Test collection date: ${metadata.test_collection_date}`,
    `- Panel classes: ${JSON.stringify(metadata.panel_classes)}`,
  ];
}

/**
 * Assemble the natural-language prompt that follows the PDF in the user
 * message for the /api/analyse (PDF) path.
 */
export function buildUserPrompt(
  metadata: RequestMetadata,
  clinicalNotes: string,
): string {
  return [
    'A practitioner has submitted a functional pathology test report (attached as a PDF in this same message) for N of 1 precision formulation analysis.',
    '',
    ...metadataSection(metadata),
    '',
    '## Practitioner clinical notes',
    '',
    clinicalNotes.trim().length > 0 ? clinicalNotes.trim() : '(none provided)',
    '',
    ...taskSection(metadata),
  ].join('\n');
}

/**
 * Assemble the user prompt for the /api/analyse-hl7 (HL7) path.
 * Biomarker data is provided as structured tables inline; no PDF is attached.
 */
export function buildHL7UserPrompt(
  metadata: RequestMetadata,
  parsed: ParsedHL7Message,
  clinicalNotes: string,
): string {
  // Numeric findings table
  const numericTable: string[] = [
    '| Name | Value | Unit | Ref Range | Flag |',
    '|------|-------|------|-----------|------|',
    ...parsed.numeric_findings.map(f =>
      `| ${f.name} | ${f.value} | ${f.unit} | ${f.reference_range} | ${f.abnormal_flag} |`
    ),
  ];

  // FT narrative comments are lab-generated boilerplate (test introductions,
  // domain explanations) — not patient-specific findings. Excluded to keep
  // the prompt within a manageable token budget. The numeric OBX findings
  // carry all the patient-specific data Claude needs.

  return [
    'A practitioner has submitted a functional pathology test report (structured data extracted from HL7 v2.3.1 ORU^R01 message) for N of 1 precision formulation analysis.',
    '',
    ...metadataSection(metadata),
    `- HL7 order ID: ${parsed.order_id}`,
    `- Collection datetime: ${parsed.collection_datetime}`,
    '',
    '## Biomarker findings (pre-extracted from HL7 — treat as equivalent to a pathology PDF)',
    '',
    `Total numeric markers: ${parsed.numeric_findings.length}`,
    '',
    ...numericTable,
    '',
    '## Practitioner clinical notes',
    '',
    clinicalNotes.trim().length > 0 ? clinicalNotes.trim() : '(none provided)',
    '',
    ...taskSection(metadata),
  ].join('\n');
}

/**
 * Assemble the user prompt for the /api/analyse-questionnaire (SPP) path.
 * No pathology test is attached — the practitioner-submitted symptom
 * questionnaire is the sole clinical input. Renders the category severities
 * as a Form-B-style markdown table (the same shape the prompt already
 * interprets when reading a symptom matrix off a lab PDF) so the existing
 * axis-activation and binding-exclusion logic in the "Symptom matrix" and
 * "SPP-class panel interpretation" sections applies unchanged.
 */
export function buildQuestionnaireUserPrompt(
  metadata: RequestMetadata,
  questionnaire: QuestionnaireAnswers,
  clinicalNotes: string,
): string {
  const ratedCategories = Object.entries(questionnaire.symptom_categories).filter(
    ([, severity]) => severity !== 'none',
  );

  const symptomTable =
    ratedCategories.length > 0
      ? [
          '| Symptom category | Severity |',
          '|---|---|',
          ...ratedCategories.map(
            ([category, severity]) => `| ${category} | ${severity.toUpperCase()} |`,
          ),
        ]
      : ['No symptom categories rated MODERATE or higher — see clinical notes for the presenting concern.'];

  const s = questionnaire.safety_screening;
  const safetyFlags: string[] = [];
  if (s.pregnant_or_breastfeeding) safetyFlags.push('- Pregnant or breastfeeding: yes');
  if (s.active_malignancy_or_oncology_treatment) safetyFlags.push('- Active malignancy or oncology treatment: yes');
  if (s.end_stage_organ_failure_or_dialysis) safetyFlags.push('- End-stage organ failure or on dialysis: yes');
  if (s.active_eating_disorder) safetyFlags.push('- Active eating disorder: yes');
  if (s.active_suicidal_ideation_or_recent_attempt) safetyFlags.push('- Active suicidal ideation or recent suicide attempt: yes');
  if (s.known_kidney_disease) safetyFlags.push('- Known kidney disease (severity not lab-confirmed — no panel attached): yes');
  if (s.known_liver_disease) safetyFlags.push('- Known liver disease (severity not lab-confirmed — no panel attached): yes');
  const safetyBlock =
    safetyFlags.length > 0
      ? safetyFlags.join('\n')
      : 'No safety-screening concerns flagged by the practitioner.';
  const medicationsLine = s.current_medications.trim().length > 0
    ? `Current medications: ${s.current_medications.trim()}`
    : 'Current medications: none reported.';

  return [
    'A practitioner has submitted a symptom questionnaire for N of 1 precision formulation analysis. No pathology test is attached — this is an SPP (Symptom Presentation Panel) submission. There is no biomarker or genomic data; the symptom ratings and safety-screening answers below are the sole clinical input.',
    '',
    ...metadataSection(metadata),
    '',
    '## Symptom matrix — practitioner-submitted directly (no pathology report; this is the sole clinical input, not supplementary)',
    '',
    ...symptomTable,
    '',
    '## Safety screening',
    '',
    safetyBlock,
    medicationsLine,
    '',
    '## Practitioner clinical notes',
    '',
    clinicalNotes.trim().length > 0 ? clinicalNotes.trim() : '(none provided)',
    '',
    ...taskSection(metadata),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Library context
// ---------------------------------------------------------------------------

interface LibraryFile {
  metadata: { library_revision: number; library_revision_date: string; ingredient_count: number };
  ingredients: unknown[];
}

let cachedLibraryBlock: string | null = null;

/**
 * Read the built ingredients library and format it as a system-prompt
 * suffix. Cached after first read; the route is stateless across requests
 * but the Node process keeps this in memory.
 */
export async function getLibraryContextBlock(): Promise<string> {
  if (cachedLibraryBlock) return cachedLibraryBlock;

  const libraryPath = path.join(
    process.cwd(),
    'data',
    'library-built',
    'ingredients-library.json',
  );
  const raw = await readFile(libraryPath, 'utf8');
  const lib = JSON.parse(raw) as LibraryFile;

  cachedLibraryBlock = [
    '## Nof1 Ingredients Library',
    '',
    `Library revision: ${lib.metadata.library_revision} (${lib.metadata.library_revision_date})`,
    `Ingredient count: ${lib.metadata.ingredient_count}`,
    '',
    'Recommendations MUST use TSI codes from this library. Do not invent codes.',
    '',
    '### Code disambiguation — commonly confused adjacent codes',
    '',
    'The following adjacent W030 codes have very different dose_per_granule values.',
    'Verify the code and ingredient name match before use:',
    '',
    '- W030020000 = R,S-alpha lipoic acid (ALA), 5 mg/granule',
    '- W030021000 = Coenzyme Q10 (CoQ10), 1 mg/granule  ← NOT Vitamin E',
    '- W030022000 = Vitamin E (d-alpha tocopheryl acid succinate), 4.992 mg/granule  ← NOT CoQ10',
    '',
    'CoQ10 is W030021000. Vitamin E is W030022000. These are different ingredients.',
    '',
    '```json',
    JSON.stringify(lib.ingredients, null, 2),
    '```',
  ].join('\n');

  return cachedLibraryBlock;
}

// ---------------------------------------------------------------------------
// System prompt assembly
// ---------------------------------------------------------------------------

let cachedSystemPrompt: string | null = null;

export async function getSystemPrompt(): Promise<string> {
  if (cachedSystemPrompt) return cachedSystemPrompt;
  const promptPath = path.join(process.cwd(), 'prompts', 'system-prompt.md');
  cachedSystemPrompt = await readFile(promptPath, 'utf8');
  return cachedSystemPrompt;
}

/**
 * Assemble the system prompt as two separately-cached content blocks.
 *
 * The Anthropic prompt cache has a 5-minute TTL. Placing cache_control on
 * each block tells the API to cache them independently so the large library
 * JSON (≈158k tokens) and the clinical reasoning prompt (≈17k tokens) are
 * served from cache on every call after the first within a session.
 *
 * Cache read cost: $1.50/MTok vs $15/MTok for uncached input — roughly
 * $2.37 saved per call on the 175k-token cacheable portion.
 */
export async function assembleFullSystemPrompt(): Promise<SystemPromptBlocks> {
  const [base, library] = await Promise.all([getSystemPrompt(), getLibraryContextBlock()]);
  return [
    {
      type: 'text',
      text: base,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: library,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

// ---------------------------------------------------------------------------
// Audit block
// ---------------------------------------------------------------------------

export interface AuditBlock {
  submission_id: string;
  generated_at_iso: string;
  test_type: string;
  test_lab_id: string;
  practitioner_id: string;
  practitioner_type: string;
  /**
   * SHA-256 of the source input — a PDF, HL7 message text, or (for
   * questionnaire-only submissions) the canonicalised questionnaire-answers
   * JSON. Use `input_source` to determine which. Named pdf_sha256 for
   * historic compat.
   */
  pdf_sha256: string;
  pdf_size_bytes: number;
  /** Identifies whether the source input was a PDF, an HL7 message, or a questionnaire. Defaults to 'pdf'. */
  input_source?: 'pdf' | 'hl7' | 'questionnaire';
  skill_version: string;
  system_prompt_version: string;
  output_schema_version: string;
  library_revision: number;
  library_revision_date: string;
  model: string;
  draft_statement: string;
}

export function buildAuditBlock(input: {
  metadata: RequestMetadata;
  /**
   * Source bytes: PDF bytes for /api/analyse, HL7 text bytes for
   * /api/analyse-hl7, or canonicalised questionnaire-answers JSON bytes for
   * /api/analyse-questionnaire.
   */
  pdfBytes: Uint8Array;
  model: string;
  inputSource?: 'pdf' | 'hl7' | 'questionnaire';
}): AuditBlock {
  const hash = createHash('sha256').update(input.pdfBytes).digest('hex');
  return {
    submission_id: input.metadata.submission_id,
    generated_at_iso: new Date().toISOString(),
    test_type: input.metadata.test_type,
    test_lab_id: input.metadata.test_lab_id,
    practitioner_id: input.metadata.practitioner_id,
    practitioner_type: input.metadata.practitioner_type,
    pdf_sha256: hash,
    pdf_size_bytes: input.pdfBytes.byteLength,
    input_source: input.inputSource ?? 'pdf',
    skill_version: promptVersion.skill_version,
    system_prompt_version: promptVersion.system_prompt_version,
    output_schema_version: promptVersion.output_schema_version,
    library_revision: promptVersion.library_revision,
    library_revision_date: promptVersion.library_revision_date,
    model: input.model,
    draft_statement:
      'This output is a draft pending practitioner review. The reviewing practitioner is the prescribing clinician of record.',
  };
}
