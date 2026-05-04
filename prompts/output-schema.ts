// N of 1 output schema — Phase 2 (Rev 2). Zod schema for Claude's structured JSON output.
// Version: 0.2.0
// This schema is what Claude is required to produce. Validation happens server-side.
// Any change here must be paired with a prompt_version bump.
//
// Design philosophy:
// - Structural fields (output_type, audit_metadata, refusal shape) are STRICT.
// - Clinical content fields adopt the natural shape Claude produces, with the
//   addition of a few enum/array fields the downstream document generators need.
// - .passthrough() is used on flexibly-structured objects to accept thoughtful
//   variations without rejecting them.

import { z } from "zod";

// ---------- shared sub-schemas ----------

const PriorityEnum = z.enum(["HIGH", "WATCH", "NOTE"]);
const ReviewPriorityEnum = z.enum([
  "HIGH",
  "MODERATE",
  "STANDARD",
]);
const SeverityEnum = z.enum([
  "critical",
  "high",
  "moderate",
  "low",
  "low_in_this_context",
  "monitor",
  "informational",
  "applied",
  "not_applicable",
]);

const HedgedClinicalText = z.string().min(1).max(8000);

// ---------- ingredient & formulation sub-schemas ----------

const ProposedIngredient = z.object({
  tsi_code: z.string().regex(/^[A-Z]\d{9}$/, {
    message: "tsi_code must match Library format (one uppercase letter + 9 digits)",
  }),
  common_name: z.string(),
  proposed_dose: z.number().positive(),
  dose_unit: z.string(),                              // mg, mcg, IU, g
  rationale_for_practitioner: HedgedClinicalText,
  evidence_pointer: z.string(),                       // citation hint, not full citations
  practitioner_cautions: z.string(),
  target_biomarker_findings: z.array(z.string()).default([]),  // marker names addressed
  practitioner_review_priority: ReviewPriorityEnum.default("STANDARD"),
}).passthrough();

const DoseAdjustment = z.object({
  adjustment_type: z.string(),                        // free text — Claude's natural phrasing
  description: HedgedClinicalText,
  affected_tsi_codes: z.array(z.string()).default([]),  // optional — empty if global
}).passthrough();

const StandaloneRecommendation = z.object({
  recommendation: z.string(),
  in_library: z.literal(false),
  note_for_practitioner: HedgedClinicalText,
}).passthrough();

const ContraindicationFlag = z.object({
  flag: z.string(),
  severity: SeverityEnum,
  description: HedgedClinicalText,
  affected_tsi_codes: z.array(z.string()).optional(),
}).passthrough();

const BiomarkerFinding = z.object({
  biomarker: z.string(),
  result: z.string(),
  laboratory_reference_range: z.string(),
  interpretation: HedgedClinicalText,
  possible_contributors_per_published_literature: HedgedClinicalText.optional(),
  relevance_to_formulation: HedgedClinicalText.optional(),
}).passthrough();

const DietLifestyleConsideration = z.object({
  category: z.string(),
  consideration_for_practitioner_discussion: HedgedClinicalText,
  rationale: z.string(),
}).passthrough();

const ExecutiveSummary = z.object({
  headline: HedgedClinicalText,
  primary_findings: z.array(HedgedClinicalText),
  areas_within_reference: z.array(z.string()),
  framing_for_practitioner: HedgedClinicalText,
}).passthrough();

const FormulationLogic = z.object({
  overall_strategy: HedgedClinicalText,
  what_was_intentionally_excluded_and_why: z.array(
    z.object({
      excluded: z.string(),
      reason: HedgedClinicalText,
    }).passthrough()
  ),
  what_was_intentionally_included_and_why: z.array(z.string()),
}).passthrough();

const MonitoringConsiderations = z.object({
  summary: HedgedClinicalText,
  markers_for_practitioner_consideration_at_follow_up: z.array(z.string()),
  framing: z.string().optional(),
}).passthrough();

const CriticalReviewRequired = z.object({
  trigger: z.string(),
  description: HedgedClinicalText,
  secondary_flags: z.array(z.string()).optional(),
}).passthrough();

// ---------- compliance & audit ----------

const ComplianceSelfCheck = z.object({
  // Claude may report banned-term checks as a single flag OR as several granular flags.
  no_banned_terms: z.boolean().optional(),
  no_banned_diagnostic_language: z.boolean().optional(),
  no_banned_causal_language: z.boolean().optional(),
  no_banned_recommendation_language: z.boolean().optional(),
  no_banned_therapeutic_claims: z.boolean().optional(),
  no_restricted_representations: z.boolean().optional(),

  third_person_framing_throughout: z.boolean().optional(),
  third_person_framing: z.boolean().optional(),
  third_person_framing_used: z.boolean().optional(),
  third_person_throughout: z.boolean().optional(),

  all_recommendations_show_working: z.boolean().optional(),
  all_clinical_statements_hedged: z.boolean().optional(),

  practitioner_scope_filter_applied: z.boolean(),     // required
  practitioner_scope_filter_note: z.string().optional(),

  standard_contraindication_checks_run: z.boolean().optional(),
  all_standard_contraindication_checks_run: z.boolean().optional(),

  all_recommended_ingredients_in_supplied_library: z.boolean().optional(),
  all_ingredients_in_supplied_library: z.boolean().optional(),
  all_ingredients_from_supplied_library: z.boolean().optional(),

  no_commercial_framing: z.boolean(),                 // required
  all_required_schema_fields_populated: z.boolean().optional(),
  notes: z.string().optional(),
}).passthrough();

const AuditMetadata = z.object({
  prompt_version: z.string(),
  library_revision: z.union([
    z.number().int(),
    z.string().regex(/^not_/, {
      message: "Non-numeric library_revision must start with 'not_' (e.g. 'not_referenced_due_to_refusal')",
    }),
  ]),
  submission_id: z.string(),
  test_type: z.string().optional(),
  practitioner_id_hash: z.string(),
  escalation_flags_raised: z.array(z.string()),
  contraindications_flagged: z.number().int().nonnegative(),
  practitioner_scope_filter_applied: z.boolean(),
  s4_ingredients_excluded_count: z.number().int().nonnegative(),
}).passthrough();

// ---------- formulation output ----------

const FormulationOutput = z.object({
  output_type: z.literal("formulation"),
  submission_metadata: z.object({
    submission_id: z.string(),
    patient_pseudonymous_id: z.string(),
    patient_age: z.number().int().positive().optional(),
    patient_sex: z.string().optional(),
    test_type: z.string(),
    lab_id: z.string(),
    collection_date: z.string(),
    practitioner_id_hash: z.string(),
  }).passthrough(),
  executive_summary: ExecutiveSummary,
  biomarker_analysis: z.array(BiomarkerFinding),
  diet_lifestyle_considerations: z.array(DietLifestyleConsideration),
  formulation_logic: FormulationLogic,
  proposed_formulation: z.array(ProposedIngredient),
  dose_adjustments: z.array(DoseAdjustment),
  standalone_recommendations: z.array(StandaloneRecommendation),
  contraindication_flags: z.array(ContraindicationFlag),
  monitoring_considerations: MonitoringConsiderations,
  areas_of_strength: z.array(HedgedClinicalText),
  critical_review_required: CriticalReviewRequired.nullable(),
  escalation_recommended: z.boolean().optional(),
  compliance_self_check: ComplianceSelfCheck,
  audit_metadata: AuditMetadata,
}).passthrough();

// ---------- refusal output ----------

const RefusalOutput = z.object({
  output_type: z.literal("refusal"),
  submission_metadata: z.object({
    submission_id: z.string(),
    patient_pseudonymous_id: z.string(),
    test_type: z.string().optional(),
    practitioner_id_hash: z.string(),
  }).passthrough(),
  refusal_trigger: z.string(),
  refusal_explanation: HedgedClinicalText,
  escalation_recommended: z.literal(true),
  compliance_self_check: ComplianceSelfCheck,
  audit_metadata: AuditMetadata,
}).passthrough();

// ---------- the union ----------

export const ClaudeOutputSchema = z.discriminatedUnion("output_type", [
  FormulationOutput,
  RefusalOutput,
]);

export type ClaudeOutput = z.infer<typeof ClaudeOutputSchema>;
export type FormulationOutputType = z.infer<typeof FormulationOutput>;
export type RefusalOutputType = z.infer<typeof RefusalOutput>;