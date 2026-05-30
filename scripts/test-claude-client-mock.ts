/**
 * scripts/test-claude-client-mock.ts
 *
 * Smoke test for /api/analyse internals. Injects a fake Anthropic client
 * that returns a canned tool_use response, and verifies that:
 *
 *   1. The tool input_schema compiles cleanly from the Zod wrapper schema.
 *   2. A well-formed formulation output passes wrapper + inner Zod validation.
 *   3. A well-formed refusal output passes validation.
 *   4. A malformed TSI code (wrong format) is rejected by the regex check.
 *   5. A response missing the required `result` envelope is rejected.
 *   6. A response with no tool_use block raises ClaudeOutputShapeError.
 *   7. A response with the wrong tool name is rejected.
 *   8. The .passthrough() semantic is preserved — extra fields don't fail.
 *   9. The library_revision sentinel ("not_referenced_due_to_refusal") is accepted on refusal.
 *  10-12. v0.3.0 — category enum, original_target_dose, excluded_from_pod.
 *  13-15. v0.4.0 — granules per ingredient, total_granules.
 *  16-18. v0.4.1 — panel_classes, recognised_patterns, granule_budget_allocation_plan,
 *                  binding_exclusions_applied.
 *
 * Run with:  npx tsx scripts/test-claude-client-mock.ts
 *
 * Exit code is 0 on success, non-zero on the first failure.
 */
import {
  callClaudeForAnalysis,
  ClaudeOutputShapeError,
} from '../lib/claude-client';
// ---------------------------------------------------------------------------
// Fake Anthropic client
// ---------------------------------------------------------------------------
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
type TextBlock = { type: 'text'; text: string };
type ContentBlock = ToolUseBlock | TextBlock;
interface FakeMessageResponse {
  content: ContentBlock[];
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}
function makeFakeClient(response: FakeMessageResponse) {
  // The real client now uses messages.stream(...).finalMessage(). We mock both
  // shapes (.create for backward-compat, .stream returning an object whose
  // .finalMessage resolves to the canned response).
  const fakeStream = {
    finalMessage: async () => response,
  };
  return {
    messages: {
      create: async () => response,
      stream: () => fakeStream,
    },
  } as unknown as Parameters<typeof callClaudeForAnalysis>[0]['client'];
}
// ---------------------------------------------------------------------------
// Sample valid outputs (shaped to the v0.4.1 schema)
// ---------------------------------------------------------------------------
const VALID_FORMULATION = {
  output_type: 'formulation',
  submission_metadata: {
    submission_id: 'SUB-2026-001',
    patient_pseudonymous_id: 'PT-A1B2C3',
    patient_age: 42,
    patient_sex: 'female',
    test_type: 'NutriSTAT',
    lab_id: 'LAB-12345',
    collection_date: '2026-04-15',
    practitioner_id_hash: 'sha256:abc123',
  },
  // v0.4.1 — required panel_classes echo
  panel_classes: ['FBP'],
  executive_summary: {
    headline:
      'The patient presents with sub-optimal vitamin D status and mildly elevated homocysteine, with otherwise unremarkable findings across the panel. The proposed formulation focuses on methylation support and vitamin D repletion for practitioner consideration.',
    primary_findings: [
      'Vitamin D 25-OH below the laboratory reference range',
      'Homocysteine slightly above the upper reference limit',
    ],
    areas_within_reference: ['Iron studies', 'Thyroid panel', 'Lipid panel'],
    framing_for_practitioner:
      'Findings are presented as evidence for practitioner consideration. The reviewing practitioner is the prescribing clinician of record.',
  },
  biomarker_analysis: [
    {
      biomarker: 'Vitamin D 25-OH',
      result: '52 nmol/L',
      laboratory_reference_range: '75-200 nmol/L',
      interpretation:
        'The patient\'s 25-OH vitamin D is below the laboratory reference range, which the practitioner may wish to consider in the context of the patient\'s overall presentation.',
    },
  ],
  diet_lifestyle_considerations: [
    {
      category: 'Sun exposure',
      consideration_for_practitioner_discussion:
        'The practitioner may wish to discuss the patient\'s typical sun exposure patterns as part of the broader review of the patient\'s vitamin D status.',
      rationale: 'Vitamin D 25-OH is below the laboratory reference range.',
    },
  ],
  // v0.4.1 — recognised patterns. Empty array is valid; a minimal panel may
  // not surface a recognisable pattern. For this fixture we include one entry
  // to exercise the round-trip.
  recognised_patterns: [
    {
      pattern_name: 'vitamin-d-insufficient-with-mild-methylation-load',
      supporting_findings: ['Vitamin D 25-OH 52 nmol/L', 'Homocysteine 11.2 umol/L'],
      rationale:
        'A pattern consistent with sub-optimal 25-OH vitamin D and modest methylation load — for practitioner consideration.',
    },
  ],
  formulation_logic: {
    overall_strategy:
      'The proposed formulation prioritises vitamin D repletion and methylation support, consistent with the patient\'s biomarker findings. All ingredients are drawn from the supplied Library and dosed within Library maxima.',
    what_was_intentionally_excluded_and_why: [
      {
        excluded: 'Iron',
        reason:
          'The patient\'s iron studies are within the laboratory reference range; there is no biomarker basis for inclusion.',
      },
    ],
    what_was_intentionally_included_and_why: [
      'Vitamin D3 — to address the sub-optimal 25-OH result',
      'Activated B-complex — for methylation support given elevated homocysteine',
    ],
  },
  // v0.4.1 — granule budget allocation plan. Sum of granules_allocated must be ≤ 700.
  // For this minimal fixture we allocate to two axes summing to 4 granules.
  granule_budget_allocation_plan: [
    {
      category: 'vitamin_d_c_neurotransmitter',
      granules_allocated: 2,
      priority: 'primary',
      findings_addressed: ['Vitamin D 25-OH 52 nmol/L'],
      rationale: 'Repletion-dose vitamin D3, taking the per-granule loading into account.',
    },
  ],
  // v0.4.1 — binding exclusions applied (empty for this minimal case).
  binding_exclusions_applied: [],
  proposed_formulation: [
    {
      tsi_code: 'V000000123',
      common_name: 'Vitamin D3 (cholecalciferol)',
      proposed_dose: 25,
      dose_unit: 'mcg',
      rationale_for_practitioner:
        'The patient\'s 25-OH vitamin D is below the laboratory reference range. Standard repletion logic applies; the practitioner may wish to titrate based on patient response and follow-up testing.',
      evidence_pointer: 'Endocrine Society guideline 2011; NHMRC 2024 update',
      practitioner_cautions: 'Monitor 25-OH status at 3-month follow-up.',
      target_biomarker_findings: ['Vitamin D 25-OH'],
      practitioner_review_priority: 'STANDARD',
      // v0.3.0 additions:
      category: 'vitamin_d_c_neurotransmitter',
      // original_target_dose intentionally omitted — not a dose-reduction case
      // v0.4.0 addition:
      granules: 2,  // ceil(25 / 12.5) — using a hypothetical D3 with 12.5 mcg/granule
    },
  ],
  // v0.4.0 — sum of granules across proposed_formulation
  total_granules: 2,
  dose_adjustments: [],
  standalone_recommendations: [],
  excluded_from_pod: [],  // v0.3.0 — empty for this minimal fixture
  contraindication_flags: [],
  monitoring_considerations: {
    summary:
      'Follow-up testing of vitamin D status and homocysteine at 12 weeks is recommended for practitioner consideration.',
    markers_for_practitioner_consideration_at_follow_up: [
      'Vitamin D 25-OH',
      'Homocysteine',
    ],
  },
  areas_of_strength: [
    'Iron studies are within the laboratory reference range — no intervention indicated.',
  ],
  critical_review_required: null,
  compliance_self_check: {
    no_banned_terms: true,
    third_person_framing: true,
    practitioner_scope_filter_applied: true,
    no_commercial_framing: true,
  },
  audit_metadata: {
    prompt_version: '0.3.2',
    library_revision: 15,
    submission_id: 'SUB-2026-001',
    test_type: 'NutriSTAT',
    practitioner_id_hash: 'sha256:abc123',
    escalation_flags_raised: [],
    contraindications_flagged: 0,
    practitioner_scope_filter_applied: true,
    s4_ingredients_excluded_count: 0,
    // v0.4.1 audit additions:
    panel_classes: ['FBP'],
    binding_exclusions_count: 0,
    recognised_patterns_count: 1,
  },
};

const VALID_REFUSAL = {
  output_type: 'refusal',
  submission_metadata: {
    submission_id: 'SUB-2026-002',
    patient_pseudonymous_id: 'PT-MINOR-01',
    test_type: 'NutriSTAT',
    practitioner_id_hash: 'sha256:def456',
  },
  // v0.4.1 — panel_classes echoed even on refusal
  panel_classes: ['FBP'],
  refusal_trigger: 'minor_patient',
  refusal_explanation:
    'Submission metadata indicates the patient is under 18 years of age. The N of 1 skill scope is restricted to adult patients (18+). This submission requires escalation to human review.',
  escalation_recommended: true,
  compliance_self_check: {
    practitioner_scope_filter_applied: false,
    practitioner_scope_filter_note: 'Filter not applied — refusal at pre-flight stage.',
    no_commercial_framing: true,
  },
  audit_metadata: {
    prompt_version: '0.3.2',
    library_revision: 'not_referenced_due_to_refusal',
    submission_id: 'SUB-2026-002',
    practitioner_id_hash: 'sha256:def456',
    escalation_flags_raised: ['minor_patient'],
    contraindications_flagged: 0,
    practitioner_scope_filter_applied: false,
    s4_ingredients_excluded_count: 0,
    // v0.4.1:
    panel_classes: ['FBP'],
    binding_exclusions_count: 0,
    recognised_patterns_count: 0,
  },
};

// v0.4.1 — refusal for an unsupported panel class. The panel_classes array
// can contain any of FBP/HMP/GP/MP/TP/RIP — non-FBP triggers this refusal.
const VALID_REFUSAL_PANEL_CLASS = {
  ...VALID_REFUSAL,
  submission_metadata: {
    ...VALID_REFUSAL.submission_metadata,
    submission_id: 'SUB-2026-003',
    test_type: 'myDNA Longevity',
  },
  panel_classes: ['GP'],
  refusal_trigger: 'panel_class_not_yet_supported',
  refusal_explanation:
    'Submission contains panel class GP (genomic). The current revision supports FBP-class panels only. Multi-class and non-FBP support arrives in a future revision.',
  audit_metadata: {
    ...VALID_REFUSAL.audit_metadata,
    submission_id: 'SUB-2026-003',
    panel_classes: ['GP'],
    escalation_flags_raised: ['panel_class_not_yet_supported'],
  },
};

// Malformed: TSI code does not match the ^[A-Z]\d{9}$ regex.
const INVALID_TSI_CODE = {
  ...VALID_FORMULATION,
  proposed_formulation: [
    {
      ...VALID_FORMULATION.proposed_formulation[0],
      tsi_code: 'TSI-VITD-001', // wrong format — should be one letter + 9 digits
    },
  ],
};

// .passthrough() test: extra unknown field on the formulation output.
const FORMULATION_WITH_EXTRA_FIELD = {
  ...VALID_FORMULATION,
  unexpected_extra_field: 'should be passed through, not rejected',
};

// v0.3.0 + v0.4.x — formulation with a dose-reduced ingredient and excluded_from_pod items.
// Mirrors the shape of the Neal Mercado reference prescription where NAC was
// reduced from 600 mg target to 400 mg in pod, and L-Arginine was excluded
// entirely because 1750 mg would have used 350 granules.
const FORMULATION_WITH_V030_FIELDS = {
  ...VALID_FORMULATION,
  proposed_formulation: [
    {
      tsi_code: 'W140010000',
      common_name: 'N-Acetyl Cysteine (NAC)',
      proposed_dose: 400,
      dose_unit: 'mg',
      rationale_for_practitioner:
        'NAC organic acid is near the lower limit of the laboratory reference range. The proposed dose was reduced from the lab target of 600 mg to 400 mg to fit within the 700-granule pod budget; the reduced dose remains therapeutically meaningful.',
      evidence_pointer: 'Lord & Bralley, Laboratory Evaluations for Integrative Medicine',
      practitioner_cautions: 'Take with food to minimise gastrointestinal upset.',
      target_biomarker_findings: ['NAC organic acid'],
      practitioner_review_priority: 'STANDARD',
      // v0.3.0:
      category: 'antioxidant_redox',
      original_target_dose: 600,  // dose-reduced case
      // v0.4.0:
      granules: 80,  // ceil(400 / 5) — NAC 5 mg/granule
    },
  ],
  // v0.4.0 — total adjusted to match the single ingredient
  total_granules: 80,
  // v0.4.1 — allocation plan must include the categories used in proposed_formulation
  granule_budget_allocation_plan: [
    {
      category: 'antioxidant_redox',
      granules_allocated: 80,
      priority: 'primary',
      findings_addressed: ['NAC organic acid 0.02 mmol/molCr (lower reference limit)'],
      rationale:
        'Anti-oxidant axis prioritised given near-floor NAC organic acid; budget reduced to fit pod.',
    },
  ],
  excluded_from_pod: [
    {
      ingredient_name: 'L-Arginine',
      original_target_dose: 1750,
      dose_unit: 'mg',
      granules_required: 350,
      reason_excluded: 'exceeds_granule_budget',
      standalone_recommendation:
        'Practitioner consideration: L-Arginine 1750 mg standalone (powder or capsule, evening with meal) — the patient\'s plasma arginine is at the lower end of the reference range. Could not fit within the 700-granule pod budget.',
    },
    {
      ingredient_name: 'Omega-3 Fish Oil (EPA/DHA)',
      reason_excluded: 'not_in_library',
      standalone_recommendation:
        'Practitioner consideration: high-dose fish oil 2-3 g combined EPA+DHA daily. The patient\'s Omega-3 Index is below the optimal threshold. Not available in the Nof1 ingredient Library.',
    },
  ],
};

// v0.3.0 — invalid category. Should be rejected by the enum.
const INVALID_CATEGORY = {
  ...VALID_FORMULATION,
  proposed_formulation: [
    {
      ...VALID_FORMULATION.proposed_formulation[0],
      category: 'made_up_category',  // not in TherapeuticCategoryEnum
    },
  ],
};

// v0.3.0 — missing category. Should be rejected because category is required.
const MISSING_CATEGORY = {
  ...VALID_FORMULATION,
  proposed_formulation: [
    (() => {
      // Strip category from a copy of the ingredient.
      const { category, ...rest } = VALID_FORMULATION.proposed_formulation[0] as Record<string, unknown> & {
        category: string;
      };
      return rest;
    })(),
  ],
};

// v0.4.0 — missing granules. Should be rejected because granules is required.
const MISSING_GRANULES = {
  ...VALID_FORMULATION,
  proposed_formulation: [
    (() => {
      const { granules, ...rest } = VALID_FORMULATION.proposed_formulation[0] as Record<string, unknown> & {
        granules: number;
      };
      return rest;
    })(),
  ],
};

// v0.4.1 — formulation with a binding exclusion applied (selenium near upper limit).
const FORMULATION_WITH_BINDING_EXCLUSION = {
  ...VALID_FORMULATION,
  binding_exclusions_applied: [
    {
      ingredient_name: 'Selenium (any form)',
      panel_finding_that_triggered:
        'Red-cell selenium 498.9 ug/L (99.8% of upper reference limit 500 ug/L)',
      practitioner_note:
        'Per binding-exclusion rule: red-cell selenium at or above 90% of upper reference. Selenium is not included in the formulation. The practitioner may wish to confirm dietary selenium status given proximity to upper limit.',
    },
  ],
  audit_metadata: {
    ...VALID_FORMULATION.audit_metadata,
    binding_exclusions_count: 1,
  },
};

// v0.4.1 — invalid panel_classes value. Should be rejected by the enum.
const INVALID_PANEL_CLASS = {
  ...VALID_FORMULATION,
  panel_classes: ['XYZ'],  // not in PanelClassEnum
};

// v0.4.1 — missing granule_budget_allocation_plan (required, min 1).
const MISSING_ALLOCATION_PLAN = {
  ...VALID_FORMULATION,
  granule_budget_allocation_plan: [],  // empty array — should be rejected by min(1)
};

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

interface Test {
  name: string;
  run: () => Promise<void>;
}

const tests: Test[] = [
  {
    name: 'parses a valid formulation tool_use response',
    run: async () => {
      const result = await callClaudeForAnalysis({
        systemPrompt: 'system',
        pdfBase64: 'AAAA',
        userPrompt: 'user',
        client: makeFakeClient({
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 200 },
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'submit_analysis', input: { result: VALID_FORMULATION } },
          ],
        }),
      });
      if (result.output.output_type !== 'formulation') {
        throw new Error(`Expected formulation, got ${result.output.output_type}`);
      }
      if (result.output.proposed_formulation[0].tsi_code !== 'V000000123') {
        throw new Error('TSI code did not round-trip');
      }
    },
  },
  {
    name: 'parses a valid refusal tool_use response',
    run: async () => {
      const result = await callClaudeForAnalysis({
        systemPrompt: 'system',
        pdfBase64: 'AAAA',
        userPrompt: 'user',
        client: makeFakeClient({
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'submit_analysis', input: { result: VALID_REFUSAL } },
          ],
        }),
      });
      if (result.output.output_type !== 'refusal') {
        throw new Error(`Expected refusal, got ${result.output.output_type}`);
      }
      if (result.output.refusal_trigger !== 'minor_patient') {
        throw new Error('refusal_trigger did not round-trip');
      }
    },
  },
  {
    name: 'accepts the not_* library_revision sentinel on refusal',
    run: async () => {
      const result = await callClaudeForAnalysis({
        systemPrompt: 'system',
        pdfBase64: 'AAAA',
        userPrompt: 'user',
        client: makeFakeClient({
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'submit_analysis', input: { result: VALID_REFUSAL } },
          ],
        }),
      });
      if (result.output.audit_metadata.library_revision !== 'not_referenced_due_to_refusal') {
        throw new Error('library_revision sentinel did not round-trip');
      }
    },
  },
  {
    name: 'rejects malformed TSI code (regex violation)',
    run: async () => {
      try {
        await callClaudeForAnalysis({
          systemPrompt: 'system',
          pdfBase64: 'AAAA',
          userPrompt: 'user',
          client: makeFakeClient({
            stop_reason: 'tool_use',
            usage: { input_tokens: 100, output_tokens: 200 },
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'submit_analysis', input: { result: INVALID_TSI_CODE } },
            ],
          }),
        });
        throw new Error('Expected ClaudeOutputShapeError but call succeeded');
      } catch (err) {
        if (!(err instanceof ClaudeOutputShapeError)) {
          throw new Error(
            `Expected ClaudeOutputShapeError, got ${(err as Error).constructor.name}: ${(err as Error).message}`,
          );
        }
        const hasTsiIssue = err.zodIssues?.some((i) =>
          i.path.join('.').includes('tsi_code'),
        );
        if (!hasTsiIssue) {
          throw new Error('Expected a Zod issue on tsi_code');
        }
      }
    },
  },
  {
    name: '.passthrough() preserves extra unknown fields',
    run: async () => {
      const result = await callClaudeForAnalysis({
        systemPrompt: 'system',
        pdfBase64: 'AAAA',
        userPrompt: 'user',
        client: makeFakeClient({
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 200 },
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'submit_analysis', input: { result: FORMULATION_WITH_EXTRA_FIELD } },
          ],
        }),
      });
      const passed = (result.output as unknown as { unexpected_extra_field?: string })
        .unexpected_extra_field;
      if (passed !== 'should be passed through, not rejected') {
        throw new Error(
          `Expected unknown field to pass through, got ${JSON.stringify(passed)}`,
        );
      }
    },
  },
  {
    name: 'raises ClaudeOutputShapeError when no tool_use block is present',
    run: async () => {
      try {
        await callClaudeForAnalysis({
          systemPrompt: 'system',
          pdfBase64: 'AAAA',
          userPrompt: 'user',
          client: makeFakeClient({
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 50 },
            content: [{ type: 'text', text: 'I refuse to call the tool.' }],
          }),
        });
        throw new Error('Expected ClaudeOutputShapeError but call succeeded');
      } catch (err) {
        if (!(err instanceof ClaudeOutputShapeError)) {
          throw new Error(
            `Expected ClaudeOutputShapeError, got ${(err as Error).constructor.name}`,
          );
        }
      }
    },
  },
  {
    name: 'raises ClaudeOutputShapeError when wrong tool name is used',
    run: async () => {
      try {
        await callClaudeForAnalysis({
          systemPrompt: 'system',
          pdfBase64: 'AAAA',
          userPrompt: 'user',
          client: makeFakeClient({
            stop_reason: 'tool_use',
            usage: { input_tokens: 100, output_tokens: 50 },
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'wrong_tool', input: { result: VALID_FORMULATION } },
            ],
          }),
        });
        throw new Error('Expected ClaudeOutputShapeError but call succeeded');
      } catch (err) {
        if (!(err instanceof ClaudeOutputShapeError)) {
          throw new Error(
            `Expected ClaudeOutputShapeError, got ${(err as Error).constructor.name}`,
          );
        }
      }
    },
  },
  {
    name: 'rejects an unwrapped tool input (missing `result` envelope)',
    run: async () => {
      try {
        await callClaudeForAnalysis({
          systemPrompt: 'system',
          pdfBase64: 'AAAA',
          userPrompt: 'user',
          client: makeFakeClient({
            stop_reason: 'tool_use',
            usage: { input_tokens: 100, output_tokens: 200 },
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'submit_analysis', input: VALID_FORMULATION },
            ],
          }),
        });
        throw new Error('Expected ClaudeOutputShapeError but call succeeded');
      } catch (err) {
        if (!(err instanceof ClaudeOutputShapeError)) {
          throw new Error(
            `Expected ClaudeOutputShapeError, got ${(err as Error).constructor.name}`,
          );
        }
      }
    },
  },
  // v0.3.0 tests
  {
    name: 'v0.3.0: parses a formulation with original_target_dose and excluded_from_pod',
    run: async () => {
      const result = await callClaudeForAnalysis({
        systemPrompt: 'system',
        pdfBase64: 'AAAA',
        userPrompt: 'user',
        client: makeFakeClient({
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 200 },
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'submit_analysis', input: { result: FORMULATION_WITH_V030_FIELDS } },
          ],
        }),
      });
      if (result.output.output_type !== 'formulation') {
        throw new Error('Expected formulation');
      }
      const ingredient = result.output.proposed_formulation[0];
      if (ingredient.category !== 'antioxidant_redox') {
        throw new Error(`category did not round-trip, got ${ingredient.category}`);
      }
      if (ingredient.original_target_dose !== 600) {
        throw new Error(`original_target_dose did not round-trip, got ${ingredient.original_target_dose}`);
      }
      if (result.output.excluded_from_pod.length !== 2) {
        throw new Error(`expected 2 excluded items, got ${result.output.excluded_from_pod.length}`);
      }
      const arginine = result.output.excluded_from_pod[0];
      if (arginine.reason_excluded !== 'exceeds_granule_budget') {
        throw new Error(`reason_excluded did not round-trip`);
      }
      const omega = result.output.excluded_from_pod[1];
      if (omega.reason_excluded !== 'not_in_library') {
        throw new Error(`second reason_excluded did not round-trip`);
      }
    },
  },
  {
    name: 'v0.3.0: rejects invalid category enum value',
    run: async () => {
      try {
        await callClaudeForAnalysis({
          systemPrompt: 'system',
          pdfBase64: 'AAAA',
          userPrompt: 'user',
          client: makeFakeClient({
            stop_reason: 'tool_use',
            usage: { input_tokens: 100, output_tokens: 200 },
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'submit_analysis', input: { result: INVALID_CATEGORY } },
            ],
          }),
        });
        throw new Error('Expected ClaudeOutputShapeError but call succeeded');
      } catch (err) {
        if (!(err instanceof ClaudeOutputShapeError)) {
          throw new Error(
            `Expected ClaudeOutputShapeError, got ${(err as Error).constructor.name}: ${(err as Error).message}`,
          );
        }
        const hasCategoryIssue = err.zodIssues?.some((i) =>
          i.path.join('.').includes('category'),
        );
        if (!hasCategoryIssue) {
          throw new Error('Expected a Zod issue on category');
        }
      }
    },
  },
  {
    name: 'v0.3.0: rejects missing category (required field)',
    run: async () => {
      try {
        await callClaudeForAnalysis({
          systemPrompt: 'system',
          pdfBase64: 'AAAA',
          userPrompt: 'user',
          client: makeFakeClient({
            stop_reason: 'tool_use',
            usage: { input_tokens: 100, output_tokens: 200 },
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'submit_analysis', input: { result: MISSING_CATEGORY } },
            ],
          }),
        });
        throw new Error('Expected ClaudeOutputShapeError but call succeeded');
      } catch (err) {
        if (!(err instanceof ClaudeOutputShapeError)) {
          throw new Error(
            `Expected ClaudeOutputShapeError, got ${(err as Error).constructor.name}`,
          );
        }
      }
    },
  },
  {
    name: 'v0.3.0: excluded_from_pod defaults to empty array when omitted',
    run: async () => {
      const result = await callClaudeForAnalysis({
        systemPrompt: 'system',
        pdfBase64: 'AAAA',
        userPrompt: 'user',
        client: makeFakeClient({
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 200 },
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'submit_analysis', input: { result: VALID_FORMULATION } },
          ],
        }),
      });
      if (result.output.output_type !== 'formulation') {
        throw new Error('Expected formulation');
      }
      if (!Array.isArray(result.output.excluded_from_pod)) {
        throw new Error('excluded_from_pod should be an array');
      }
      if (result.output.excluded_from_pod.length !== 0) {
        throw new Error('excluded_from_pod should be empty for VALID_FORMULATION');
      }
    },
  },
  // v0.4.0 tests — granules per ingredient and total_granules
  {
    name: 'v0.4.0: granules and total_granules round-trip on a valid formulation',
    run: async () => {
      const result = await callClaudeForAnalysis({
        systemPrompt: 'system',
        pdfBase64: 'AAAA',
        userPrompt: 'user',
        client: makeFakeClient({
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 200 },
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'submit_analysis', input: { result: VALID_FORMULATION } },
          ],
        }),
      });
      if (result.output.output_type !== 'formulation') {
        throw new Error('Expected formulation');
      }
      const ingredient = result.output.proposed_formulation[0];
      if ((ingredient as { granules: number }).granules !== 2) {
        throw new Error(`granules did not round-trip, got ${(ingredient as { granules: number }).granules}`);
      }
      if (result.output.total_granules !== 2) {
        throw new Error(`total_granules did not round-trip, got ${result.output.total_granules}`);
      }
    },
  },
  {
    name: 'v0.4.4: accepts missing granules (now optional, route computes)',
    run: async () => {
      // v0.4.4: `granules` per ingredient is optional. The route computes
      // it deterministically from proposed_dose. Schema must accept omission.
      const result = await callClaudeForAnalysis({
        systemPrompt: 'system',
        pdfBase64: 'AAAA',
        userPrompt: 'user',
        client: makeFakeClient({
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 200 },
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'submit_analysis', input: { result: MISSING_GRANULES } },
          ],
        }),
      });
      if (result.output.output_type !== 'formulation') {
        throw new Error('Expected formulation');
      }
      const ingredient = result.output.proposed_formulation[0];
      const granules = (ingredient as { granules?: number }).granules;
      if (granules !== undefined) {
        throw new Error(`Expected granules to be undefined when omitted, got ${granules}`);
      }
    },
  },
  // v0.4.1 tests — panel_classes, recognised_patterns, granule_budget_allocation_plan,
  //                binding_exclusions_applied
  {
    name: 'v0.4.1: panel_classes and audit_metadata.panel_classes round-trip on formulation',
    run: async () => {
      const result = await callClaudeForAnalysis({
        systemPrompt: 'system',
        pdfBase64: 'AAAA',
        userPrompt: 'user',
        client: makeFakeClient({
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 200 },
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'submit_analysis', input: { result: VALID_FORMULATION } },
          ],
        }),
      });
      if (result.output.output_type !== 'formulation') {
        throw new Error('Expected formulation');
      }
      const pcs = (result.output as { panel_classes: string[] }).panel_classes;
      if (!Array.isArray(pcs) || pcs[0] !== 'FBP') {
        throw new Error(`panel_classes did not round-trip, got ${JSON.stringify(pcs)}`);
      }
      const auditPcs = result.output.audit_metadata.panel_classes;
      if (!Array.isArray(auditPcs) || auditPcs[0] !== 'FBP') {
        throw new Error(`audit_metadata.panel_classes did not round-trip`);
      }
    },
  },
  {
    name: 'v0.4.1: panel_class_not_yet_supported refusal round-trips',
    run: async () => {
      const result = await callClaudeForAnalysis({
        systemPrompt: 'system',
        pdfBase64: 'AAAA',
        userPrompt: 'user',
        client: makeFakeClient({
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'submit_analysis', input: { result: VALID_REFUSAL_PANEL_CLASS } },
          ],
        }),
      });
      if (result.output.output_type !== 'refusal') {
        throw new Error(`Expected refusal, got ${result.output.output_type}`);
      }
      if (result.output.refusal_trigger !== 'panel_class_not_yet_supported') {
        throw new Error(`refusal_trigger did not round-trip, got ${result.output.refusal_trigger}`);
      }
      const pcs = (result.output as { panel_classes: string[] }).panel_classes;
      if (pcs[0] !== 'GP') {
        throw new Error(`panel_classes did not round-trip on refusal, got ${JSON.stringify(pcs)}`);
      }
    },
  },
  {
    name: 'v0.4.1: rejects invalid panel_classes enum value',
    run: async () => {
      try {
        await callClaudeForAnalysis({
          systemPrompt: 'system',
          pdfBase64: 'AAAA',
          userPrompt: 'user',
          client: makeFakeClient({
            stop_reason: 'tool_use',
            usage: { input_tokens: 100, output_tokens: 200 },
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'submit_analysis', input: { result: INVALID_PANEL_CLASS } },
            ],
          }),
        });
        throw new Error('Expected ClaudeOutputShapeError but call succeeded');
      } catch (err) {
        if (!(err instanceof ClaudeOutputShapeError)) {
          throw new Error(
            `Expected ClaudeOutputShapeError, got ${(err as Error).constructor.name}`,
          );
        }
        const hasPanelClassIssue = err.zodIssues?.some((i) =>
          i.path.join('.').includes('panel_classes'),
        );
        if (!hasPanelClassIssue) {
          throw new Error('Expected a Zod issue on panel_classes');
        }
      }
    },
  },
  {
    name: 'v0.4.1: recognised_patterns round-trip on formulation',
    run: async () => {
      const result = await callClaudeForAnalysis({
        systemPrompt: 'system',
        pdfBase64: 'AAAA',
        userPrompt: 'user',
        client: makeFakeClient({
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 200 },
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'submit_analysis', input: { result: VALID_FORMULATION } },
          ],
        }),
      });
      if (result.output.output_type !== 'formulation') {
        throw new Error('Expected formulation');
      }
      const patterns = (result.output as { recognised_patterns: { pattern_name: string }[] })
        .recognised_patterns;
      if (!Array.isArray(patterns) || patterns.length !== 1) {
        throw new Error(`Expected 1 recognised pattern, got ${patterns?.length}`);
      }
      if (patterns[0].pattern_name !== 'vitamin-d-insufficient-with-mild-methylation-load') {
        throw new Error('pattern_name did not round-trip');
      }
    },
  },
  {
    name: 'v0.4.1: granule_budget_allocation_plan round-trips on formulation',
    run: async () => {
      const result = await callClaudeForAnalysis({
        systemPrompt: 'system',
        pdfBase64: 'AAAA',
        userPrompt: 'user',
        client: makeFakeClient({
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 200 },
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'submit_analysis', input: { result: VALID_FORMULATION } },
          ],
        }),
      });
      if (result.output.output_type !== 'formulation') {
        throw new Error('Expected formulation');
      }
      const plan = (result.output as {
        granule_budget_allocation_plan: { category: string; granules_allocated: number }[];
      }).granule_budget_allocation_plan;
      if (!Array.isArray(plan) || plan.length !== 1) {
        throw new Error(`Expected 1 allocation entry, got ${plan?.length}`);
      }
      if (plan[0].category !== 'vitamin_d_c_neurotransmitter') {
        throw new Error('allocation category did not round-trip');
      }
      if (plan[0].granules_allocated !== 2) {
        throw new Error('allocation granules did not round-trip');
      }
    },
  },
  {
    name: 'v0.4.1: rejects empty granule_budget_allocation_plan (min 1 required)',
    run: async () => {
      try {
        await callClaudeForAnalysis({
          systemPrompt: 'system',
          pdfBase64: 'AAAA',
          userPrompt: 'user',
          client: makeFakeClient({
            stop_reason: 'tool_use',
            usage: { input_tokens: 100, output_tokens: 200 },
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'submit_analysis', input: { result: MISSING_ALLOCATION_PLAN } },
            ],
          }),
        });
        throw new Error('Expected ClaudeOutputShapeError but call succeeded');
      } catch (err) {
        if (!(err instanceof ClaudeOutputShapeError)) {
          throw new Error(
            `Expected ClaudeOutputShapeError, got ${(err as Error).constructor.name}`,
          );
        }
        const hasPlanIssue = err.zodIssues?.some((i) =>
          i.path.join('.').includes('granule_budget_allocation_plan'),
        );
        if (!hasPlanIssue) {
          throw new Error('Expected a Zod issue on granule_budget_allocation_plan');
        }
      }
    },
  },
  {
    name: 'v0.4.1: binding_exclusions_applied round-trips on formulation',
    run: async () => {
      const result = await callClaudeForAnalysis({
        systemPrompt: 'system',
        pdfBase64: 'AAAA',
        userPrompt: 'user',
        client: makeFakeClient({
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 200 },
          content: [
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'submit_analysis',
              input: { result: FORMULATION_WITH_BINDING_EXCLUSION },
            },
          ],
        }),
      });
      if (result.output.output_type !== 'formulation') {
        throw new Error('Expected formulation');
      }
      const exclusions = (result.output as {
        binding_exclusions_applied: { ingredient_name: string }[];
      }).binding_exclusions_applied;
      if (!Array.isArray(exclusions) || exclusions.length !== 1) {
        throw new Error(`Expected 1 binding exclusion, got ${exclusions?.length}`);
      }
      if (exclusions[0].ingredient_name !== 'Selenium (any form)') {
        throw new Error('binding exclusion ingredient_name did not round-trip');
      }
      if (result.output.audit_metadata.binding_exclusions_count !== 1) {
        throw new Error('binding_exclusions_count did not round-trip');
      }
    },
  },
];

async function main() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`PASS  ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL  ${t.name}`);
      console.error(`      ${(err as Error).message}`);
    }
  }
  console.log('');
  console.log(`${tests.length - failed}/${tests.length} tests passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
