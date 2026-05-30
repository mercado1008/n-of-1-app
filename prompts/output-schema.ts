// N of 1 output schema — Phase 4 (v0.4.7). Zod schema for Claude's structured JSON output.
// Version: 0.4.7
// Compatible system prompt: 0.3.5+
// Compatible library revision: 15+
//
// This schema is what Claude is required to produce. Validation happens server-side.
// Any change here must be paired with a prompt_version bump.
//
// Design philosophy:
// - Structural fields (output_type, audit_metadata, refusal shape) are STRICT.
// - Clinical content fields adopt the natural shape Claude produces, with the
//   addition of a few enum/array fields the downstream document generators need.
// - .passthrough() is used on flexibly-structured objects to accept thoughtful
//   variations without rejecting them.
//
// CHANGELOG v0.4.3 → v0.4.4 (Phase 4):
// - CHANGE: `granules` per ingredient is now OPTIONAL (was required in v0.4.0
//   onward). Symmetrical with `total_granules` going optional in v0.4.3.
//   Live-fire showed Claude unreliable at granule arithmetic across many
//   ingredients (over-counting on integer divisions, under-counting on
//   borderline ceiling cases) — neither prompt-strengthening alone could fix.
//
//   The route now owns ALL granule arithmetic. Claude proposes
//   `proposed_dose` (the clinical decision); the route computes
//   `ceil(proposed_dose / dose_per_granule)` deterministically and surfaces
//   the result in the response's `granule_verification` block. If Claude
//   populates `granules` and it disagrees with the recompute, the route
//   logs the discrepancy but does NOT fail the request.
//
//   Net effect: Claude focuses on dose selection and clinical reasoning;
//   integer arithmetic — which is fast and trivial in code, slow and
//   error-prone in a generation loop — is no longer Claude's problem.
//
// CHANGELOG v0.4.2 → v0.4.3 (Phase 4):
// - CHANGE: `total_granules` on FormulationOutput is now OPTIONAL (was
//   required). The route already recomputes the total deterministically from
//   per-ingredient `granules` values; requiring Claude to also populate
//   `total_granules` created a redundant source of truth where Claude's
//   arithmetic mistakes could fail otherwise-valid formulations. The route
//   now treats Claude's `total_granules` as advisory only — its own computed
//   sum is authoritative and is what's surfaced in granule_verification.
//   Per-ingredient `granules` remains required and strict (off-by-one mismatches
//   still fail the request); only the redundant top-level total relaxes.
//
// CHANGELOG v0.4.1 → v0.4.2 (Phase 4):
// - ADD: `elemental_dose`, `elemental_unit`, `elemental_substance` (all
//   optional) on each ProposedIngredient. For salt-form ingredients
//   (zinc citrate, magnesium glycinate, potassium iodide, calcium folinate,
//   chromium picolinate, selenium selenomethionine, etc.) the `proposed_dose`
//   is mass of the salt itself (matching `dose_per_granule_unit` from the
//   Library) and `elemental_dose` carries the clinically familiar elemental
//   equivalent. Practitioners think in elemental doses; granule maths happen
//   in salt mass. Both representations are now first-class outputs.
//   Always optional — non-salt-form ingredients (turmeric, vitamin C as
//   ascorbic acid, ashwagandha) omit these fields entirely.
//
// CHANGELOG v0.4.0 → v0.4.1 (Phase 4):
// - ADD: `panel_classes` (required, array of enum) on FormulationOutput AND
//   RefusalOutput. Echoes the panel_classes the request was tagged with. The
//   route uses this to validate that the prompt-class architecture stayed
//   consistent end-to-end.
// - ADD: `recognised_patterns` (required, array, may be empty) on
//   FormulationOutput. Each entry: { pattern_name, supporting_findings,
//   rationale }. Pattern_name is free text per locked decision (allows the
//   pattern vocabulary to evolve without an enum bump).
// - ADD: `granule_budget_allocation_plan` (required, non-empty array) on
//   FormulationOutput. Each entry: { category, granules_allocated, priority,
//   findings_addressed, rationale }. Sum of granules_allocated must be ≤ 700.
//   The route additionally checks that every category appearing in
//   proposed_formulation appears in this plan.
// - ADD: `binding_exclusions_applied` (required, array, may be empty) on
//   FormulationOutput. Captures binding-exclusion rules that fired (selenium
//   near upper limit, copper when Cu:Zn elevated, etc.). The practitioner-
//   facing document surfaces these so silent omission can't happen.
// - ADD: New refusal triggers `panel_class_not_yet_supported` and
//   `panel_class_not_specified` are valid `refusal_trigger` strings (the field
//   is free-string; this comment documents the new accepted values).
// - ADD: `panel_classes`, `binding_exclusions_count`, `recognised_patterns_count`
//   on AuditMetadata.
//
// CHANGELOG v0.3.0 → v0.4.0 (Phase 4):
// - ADD: `granules` (required, integer) on each ProposedIngredient. Claude
//   must compute this as ceil(proposed_dose / library.dose_per_granule) and
//   the route cross-checks it against a deterministic recompute.
// - ADD: `total_granules` (required, integer) on FormulationOutput. The sum
//   of `granules` across `proposed_formulation`. Cross-checked at the route.
//
// CHANGELOG v0.2.0 → v0.3.0 (Phase 4):
// - ADD: `category` (required) on each ProposedIngredient. Locked enum of 14 +
//   'other'. Drives doc-generation category bands (Anti-Inflammatory Core,
//   Thyroid & Adaptogens, etc.).
// - ADD: `original_target_dose` (optional) on each ProposedIngredient. Set only
//   when the prescribed dose is below the lab/clinical target due to pod budget
//   or per-ingredient max. Drives the "Dose Reduced" status string in the doc.
// - ADD: `excluded_from_pod` (top-level array, defaults to []) on
//   FormulationOutput. Captures ingredients that were targeted but excluded
//   for granule-budget, library, or prioritisation reasons, with their
//   standalone recommendation.

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

// v0.4.1 — panel-class enum. Locked at the six classes defined in the system
// prompt's "Panel classes — what you support" section. Currently only FBP is
// fully supported; other classes trigger a refusal at the prompt level. The
// enum is locked because downstream routing will switch on these values.
const PanelClassEnum = z.enum([
  "FBP",  // Functional biomarker panel — NutriSTAT, Cardiovascular, etc.
  "HMP",  // Hormone metabolism panel — EndoSCAN, neurotransmitters
  "GP",   // Genomic panel — myDNA, MTHFR
  "MP",   // Microbiome panel — Advanced Microbiome Mapping, Calprotectin
  "TP",   // Toxicant panel — ALL-Tox, mycotoxins
  "RIP",  // Reactive / immune panel — IgG/IgA, autoimmune, cytokine
]);

// v0.4.1 — priority for granule budget allocation. Locked.
const AllocationPriorityEnum = z.enum([
  "primary",      // driven by the most prominent finding(s)
  "secondary",    // driven by mid-priority findings
  "supportive",   // driven by lower-priority findings or general support
]);

// v0.3.0 — therapeutic-category enum. Locked deliberately:
// Claude must pick one (no free text) so doc category bands stay stable.
// Derived from the actual NutriSTAT panel structure (Metabolic Health,
// Thyroid + Hormones, Mineral/Metals, Essential Fatty Acids, Amino Acids,
// Organic Acids dysbiosis/neurotransmitter/oxalates) and validated against
// the Neal Mercado reference prescription.
const TherapeuticCategoryEnum = z.enum([
  "anti_inflammatory_core",         // hsCRP, AA/EPA ratio, NF-kB modulators
  "thyroid_adaptogenic",            // TSH/FT3/RT3, adrenal/HPA, ashwagandha/rhodiola
  "blood_glucose_insulin",          // fasting glucose, insulin sensitivity, berberine/inositol
  "antioxidant_redox",              // narrower than v0.2.0 — endogenous redox support, GSH cycling
  "heavy_metal_detox",              // Al/Pb/Hg/etc. — chelation-adjacent (NAC/ALA/quercetin)
  "mitochondrial_cardiovascular",   // lipid panel, CoQ10, fibrinogen, mitochondrial OAs
  "b_vitamins_methylation",         // B6/B12/folate, homocysteine, MMA, methylation cofactors
  "vitamin_d_c_neurotransmitter",   // 25-OH D, ascorbic acid, neurotransmitter OAs (5-HTP, etc.)
  "minerals",                       // red-cell minerals other than iron (Zn/Mg/Cu/Cr/Mn/Mo/Se/I/V/Co)
  "iron_metabolism",                // iron studies — distinct interpretation logic
  "amino_acid_protein",             // plasma amino acids (arginine, taurine, glycine, BCAAs, etc.)
  "fatty_acid_omega",               // EFA panel — Omega-3 Index, GLA, delta-6/delta-5 desaturase
  "gastrointestinal",               // dysbiosis OAs + general GI support (single bucket for v0.3.0)
  "hormone_metabolism",             // sex hormones, SHBG, oestrogen detox (DIM, Ca-D-glucarate)
  "other",                          // escape valve — Claude picks this if no other fits
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

  // v0.3.0 additions:
  category: TherapeuticCategoryEnum,
  original_target_dose: z.number().positive().optional(),  // populated only when proposed_dose < target

  // v0.4.0 / v0.4.4: granules is computed deterministically by the route
  // from proposed_dose / dose_per_granule. Claude MAY populate it as a
  // sanity check, but the route's value is authoritative. Optional.
  granules: z.number().int().positive().optional(),

  // v0.4.2 additions: elemental dose for salt-form ingredients.
  // All three are optional and travel together — populate all or none.
  // Salt-form ingredients (zinc citrate, magnesium glycinate, potassium
  // iodide, calcium folinate, chromium picolinate, selenomethionine, etc.)
  // SHOULD populate these so the practitioner-facing document can show
  // the elemental dose alongside the mass-of-salt that proposed_dose
  // represents. Non-salt-form ingredients (turmeric, ashwagandha,
  // ascorbic acid, etc.) omit these fields entirely.
  //
  // The Library hint: when an ingredient has equivalent_line_2_quantity
  // populated, it is a salt form and elemental_dose should be populated.
  elemental_dose: z.number().positive().optional(),
  elemental_unit: z.string().optional(),
  elemental_substance: z.string().optional(),  // e.g. "zinc", "selenium", "iodine", "chromium", "magnesium"
}).passthrough();

const DoseAdjustment = z.object({
  adjustment_type: z.string(),                        // free text — Claude's natural phrasing
  description: HedgedClinicalText,
  affected_tsi_codes: z.array(z.string()).default([]),  // optional — empty if global
}).passthrough();

const StandaloneRecommendation = z.object({
  recommendation: z.string(),
  // v0.4.5 — relaxed from z.literal(false) to z.boolean(). The prompt enforces
  // the clinical-routing policy (Library items should normally go to
  // excluded_from_pod, not here). Schema is the structural floor; clinical
  // routing is the prompt-side policy.
  in_library: z.boolean(),
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

// v0.3.0 — items that were considered for inclusion but didn't make it into the pod.
// Distinct from `standalone_recommendations` because those are explicitly NOT in the
// Library (in_library: false). Excluded items may be in the Library but couldn't fit
// for granule-budget reasons, were capped at the in-pod max so need additional dosing
// outside the pod, or were deprioritised vs more impactful interventions.
const ExcludedFromPod = z.object({
  ingredient_name: z.string().min(1),
  tsi_code: z.string().regex(/^[A-Z]\d{9}$/).optional(),  // only if the ingredient is in the Library
  original_target_dose: z.number().positive().optional(),
  dose_unit: z.string().optional(),
  granules_required: z.number().int().positive().optional(),  // for granule-budget exclusions
  reason_excluded: z.enum([
    "exceeds_granule_budget",        // would have used too many granules
    "not_in_library",                // not in the Nof1 ingredient Library
    "capped_at_max_in_pod_only",     // pod gives the max; standalone needed for the rest
    "deprioritised",                 // lower-priority intervention; granule budget tight
  ]),
  standalone_recommendation: HedgedClinicalText,
}).passthrough();

// v0.4.1 — panel patterns Claude recognised in the test results. Free-text
// `pattern_name` (not enum) so the pattern vocabulary can evolve without a
// schema bump as new test types are added. The system prompt lists the
// canonical NutriSTAT patterns; Claude can use those names verbatim or
// describe a co-occurring/uncertain pattern in its own words.
const RecognisedPattern = z.object({
  pattern_name: z.string().min(1),
  supporting_findings: z.array(z.string()).min(1),  // biomarker names + values
  rationale: HedgedClinicalText,
}).passthrough();

// v0.4.1 — granule-budget allocation plan. The strategic decomposition the
// formulation executes against. Sum of granules_allocated must be ≤ 700; the
// route validates this. Every `category` appearing in proposed_formulation
// must appear in this plan; the route validates this too.
const GranuleBudgetAllocation = z.object({
  category: TherapeuticCategoryEnum,
  granules_allocated: z.number().int().nonnegative(),  // 0 allowed for placeholder/excluded axes
  priority: AllocationPriorityEnum,
  findings_addressed: z.array(z.string()).min(1),
  rationale: HedgedClinicalText,
}).passthrough();

// v0.4.1 — binding-exclusion application record. Surfaced so the practitioner
// can see what was deliberately not included and why.
const BindingExclusionApplied = z.object({
  ingredient_name: z.string().min(1),
  panel_finding_that_triggered: z.string().min(1),  // e.g. "red-cell selenium 498.9 ug/L (98% of upper reference 500)"
  practitioner_note: HedgedClinicalText,
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

  // v0.4.1 additions — optional; Claude may report on these if relevant.
  binding_exclusions_applied_correctly: z.boolean().optional(),
  recognised_patterns_documented: z.boolean().optional(),
  granule_budget_allocation_plan_consistent: z.boolean().optional(),

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

  // v0.4.1 additions:
  panel_classes: z.array(PanelClassEnum),                    // echoes the panel_classes from request
  binding_exclusions_count: z.number().int().nonnegative(),  // number of binding exclusions applied
  recognised_patterns_count: z.number().int().nonnegative(), // number of recognised panel patterns
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

  // v0.4.1 — echoed from request, must match audit_metadata.panel_classes
  panel_classes: z.array(PanelClassEnum).min(1),

  executive_summary: ExecutiveSummary,
  biomarker_analysis: z.array(BiomarkerFinding),
  diet_lifestyle_considerations: z.array(DietLifestyleConsideration),

  // v0.4.1 — recognised patterns (may be empty if no pattern was recognisable;
  // the prompt encourages a pattern_uncertain note rather than forcing one).
  recognised_patterns: z.array(RecognisedPattern),

  formulation_logic: FormulationLogic,

  // v0.4.1 — strategic granule-budget allocation, populated BEFORE
  // proposed_formulation. Non-empty: a formulation always has at least one
  // therapeutic axis. The route validates sum ≤ 700 and category-coverage.
  granule_budget_allocation_plan: z.array(GranuleBudgetAllocation).min(1),

  // v0.4.1 — binding exclusions that fired (may be empty array).
  binding_exclusions_applied: z.array(BindingExclusionApplied).default([]),

  proposed_formulation: z.array(ProposedIngredient),
  // v0.4.3: was required (z.number().int().nonnegative()) in v0.4.0–v0.4.2.
  // Now optional and advisory only. The route always recomputes the
  // authoritative total from per-ingredient `granules` and surfaces it in
  // the granule_verification block. If Claude populates this field and it
  // disagrees with the recompute, the route logs the discrepancy but does
  // not fail the request on that basis alone.
  total_granules: z.number().int().nonnegative().optional(),
  dose_adjustments: z.array(DoseAdjustment),
  standalone_recommendations: z.array(StandaloneRecommendation),
  excluded_from_pod: z.array(ExcludedFromPod).default([]),  // v0.3.0
  contraindication_flags: z.array(ContraindicationFlag),
  monitoring_considerations: MonitoringConsiderations,
  areas_of_strength: z.array(HedgedClinicalText),
  critical_review_required: CriticalReviewRequired.nullable(),
  escalation_recommended: z.boolean().optional(),
  compliance_self_check: ComplianceSelfCheck,
  audit_metadata: AuditMetadata,

  // v0.4.7: top-level references array. Populated as a final step AFTER the
  // formulation is complete and granule arithmetic has been self-checked.
  // Each entry cites one ingredient and one key study. Separated from
  // per-ingredient fields to prevent citation generation from interfering
  // with granule arithmetic.
  references: z.array(
    z.object({
      ingredient_name: z.string(),
      citation: z.string(),
    }).passthrough()
  ).optional(),
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

  // v0.4.1 — echoed from request even on refusal, so the route can audit
  // that the panel-class architecture stayed consistent. May be empty array
  // if the refusal was specifically because panel_classes was missing.
  panel_classes: z.array(PanelClassEnum),

  // refusal_trigger is free string; canonical values include:
  //   "panel_class_not_yet_supported"  (v0.4.1)
  //   "panel_class_not_specified"      (v0.4.1)
  //   patient-related (under_18, pregnant_or_lactating, active_malignancy, ...)
  //   test-related (test_pdf_unreadable, test_too_old, ...)
  //   submission-related (self_prescription, fabricated_submission, ...)
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
export type TherapeuticCategory = z.infer<typeof TherapeuticCategoryEnum>;
export type PanelClass = z.infer<typeof PanelClassEnum>;
export type AllocationPriority = z.infer<typeof AllocationPriorityEnum>;
export type RecognisedPatternType = z.infer<typeof RecognisedPattern>;
export type GranuleBudgetAllocationType = z.infer<typeof GranuleBudgetAllocation>;
export type BindingExclusionAppliedType = z.infer<typeof BindingExclusionApplied>;

// Re-export the enums for use by the doc-generation code (category-band ordering, labels).
export { TherapeuticCategoryEnum, PanelClassEnum, AllocationPriorityEnum };

// ---------- Phase 3 / v0.3.0 addition: tool-input wrapper ----------
//
// Anthropic's tool input_schema rejects anyOf/oneOf/allOf at the top level,
// and a Zod discriminated union compiles to anyOf at the root. We wrap the
// union in an object with a single `result` property to satisfy the API.
//
// The /api/analyse route unwraps `result` before returning to callers, so
// this wrapper is internal to the Claude client and never leaks to consumers.

export const ClaudeToolInputSchema = z.object({
  result: ClaudeOutputSchema,
});

export type ClaudeToolInput = z.infer<typeof ClaudeToolInputSchema>;
