/**
 * scripts/generate-docs/types.ts
 *
 * Type definitions for the JSON output produced by /api/analyse.
 * These mirror the live output shape (output-schema v0.4.4) but are
 * deliberately permissive (most fields optional) so the generators can
 * cope with both formulation and refusal outputs, and with future
 * schema bumps that add fields without breaking generation.
 *
 * Source of truth: prompts/output-schema.ts. If that file is updated,
 * cross-check these interfaces.
 */

// ---------------------------------------------------------------------------
// Top-level output shape
// ---------------------------------------------------------------------------

export interface AnalysisOutput {
  output_type: 'formulation' | 'refusal';
  submission_metadata?: SubmissionMetadata;
  panel_classes?: string[];
  executive_summary?: ExecutiveSummary;
  biomarker_analysis?: BiomarkerFinding[];
  diet_lifestyle_considerations?: DietLifestyleConsideration[];
  recognised_patterns?: RecognisedPattern[];
  formulation_logic?: FormulationLogic;
  granule_budget_allocation_plan?: AllocationPlanEntry[];
  binding_exclusions_applied?: BindingExclusion[];
  proposed_formulation?: ProposedIngredient[];
  total_granules?: number;
  dose_adjustments?: DoseAdjustment[];
  standalone_recommendations?: StandaloneRecommendation[];
  excluded_from_pod?: ExcludedFromPod[];
  contraindication_flags?: ContraindicationFlag[];
  monitoring_considerations?: MonitoringConsiderations;
  areas_of_strength?: AreaOfStrength[];
  critical_review_required?: CriticalReviewFlag | null;
  refusal_trigger?: string;
  refusal_explanation?: string;
  escalation_recommended?: boolean;
  compliance_self_check?: ComplianceSelfCheck;
  audit_metadata?: AuditMetadata;
  // v0.4.7: top-level references, populated after formulation arithmetic is finalised.
  references?: Array<{ ingredient_name?: string; citation?: string }>;
  // The route adds this top-level field after deterministic recompute.
  granule_verification?: GranuleVerification;
}

// ---------------------------------------------------------------------------
// Sub-shapes
// ---------------------------------------------------------------------------

export interface SubmissionMetadata {
  submission_id?: string;
  test_type?: string;
  test_lab_id?: string;
  test_collection_date?: string;
  patient_pseudonym?: string;
  patient_age_years?: number;
  patient_sex_assigned_at_birth?: string;
  practitioner_id?: string;
  practitioner_type?: string;
  practitioner_name?: string;
}

export interface ExecutiveSummary {
  headline?: string;
  priority_findings?: PriorityFinding[];
  narrative?: string;
}

export interface PriorityFinding {
  priority?: 'HIGH' | 'WATCH' | 'NOTE' | string;
  finding?: string;
  result_vs_reference?: string;
  for_practitioner_consideration?: string;
}

export interface BiomarkerFinding {
  biomarker?: string;
  result?: string | number;
  reference?: string;
  status?: string;          // e.g. "H", "L", "Within range"
  pattern_note?: string;    // hedged practitioner-facing
  category?: string;
  pattern_uncertain?: boolean;
}

export interface DietLifestyleConsideration {
  topic?: string;
  consideration?: string;
}

export interface RecognisedPattern {
  pattern_name?: string;
  supporting_findings?: string[] | string;
  notes?: string;
}

export interface FormulationLogic {
  overall_strategy?: string;
  therapeutic_targets?: TherapeuticTarget[];
  synergy_notes?: string;
  exclusions_from_pod_summary?: string;
}

export interface TherapeuticTarget {
  target?: string;
  candidate_ingredients?: string;
  rationale?: string;
}

export interface AllocationPlanEntry {
  category?: string;
  granules_allocated?: number;
  priority?: 'primary' | 'secondary' | 'supportive' | string;
  findings_addressed?: string[];
  rationale?: string;
}

export interface BindingExclusion {
  ingredient?: string;
  finding_trigger?: string;
  practitioner_note?: string;
}

export interface ProposedIngredient {
  ingredient_name?: string;
  tsi_code?: string;
  common_name?: string;
  category?: string;
  proposed_dose?: number;
  dose_unit?: string;
  elemental_dose?: number;
  elemental_unit?: string;
  elemental_substance?: string;
  granules?: number;
  original_target_dose?: number;
  rationale_for_practitioner?: string;
  target_biomarkers?: string[] | string;
  evidence_pointer?: string;
}

export interface DoseAdjustment {
  ingredient?: string;
  adjustment?: string;
  reason?: string;
  note?: string;
}

export interface StandaloneRecommendation {
  recommendation?: string;
  in_library?: boolean;
  note_for_practitioner?: string;
}

export interface ExcludedFromPod {
  ingredient_name?: string;
  tsi_code?: string;
  original_target_dose?: number;
  dose_unit?: string;
  granules_required?: number;
  reason_excluded?: string;
  standalone_recommendation?: string;
}

export interface ContraindicationFlag {
  ingredient?: string;
  interaction_or_contraindication?: string;
  trigger?: string;
  mechanism?: string;
  required_practitioner_action?: string;
}

export interface MonitoringConsiderations {
  priority_markers?: MonitoringMarker[];
  general_notes?: string;
}

export interface MonitoringMarker {
  marker?: string;
  consideration?: string;
}

export interface AreaOfStrength {
  marker?: string;
  result?: string;
  practitioner_note?: string;
}

export interface CriticalReviewFlag {
  trigger?: string;
  explanation?: string;
}

export interface ComplianceSelfCheck {
  practitioner_scope_filter_applied?: boolean;
  no_commercial_framing?: boolean;
  no_banned_terms?: boolean;
  notes?: string;
}

export interface AuditMetadata {
  submission_id?: string;
  generated_at_iso?: string;
  test_type?: string;
  test_lab_id?: string;
  practitioner_id?: string;
  practitioner_type?: string;
  pdf_sha256?: string;
  pdf_size_bytes?: number;
  skill_version?: string;
  system_prompt_version?: string;
  output_schema_version?: string;
  library_revision?: number | string;
  library_revision_date?: string;
  model?: string;
  draft_statement?: string;
  prompt_version?: string;
  panel_classes?: string[];
  practitioner_id_hash?: string;
  escalation_flags_raised?: string[];
  contraindications_flagged?: number;
  binding_exclusions_count?: number;
  recognised_patterns_count?: number;
  practitioner_scope_filter_applied?: boolean;
  s4_ingredients_excluded_count?: number;
}

export interface GranuleVerification {
  ok?: boolean;
  computed_total?: number;
  pod_budget_used_pct?: number;
  pod_weight_mg?: number;
  computed_per_ingredient?: ComputedIngredient[];
}

export interface ComputedIngredient {
  tsi_code?: string;
  ingredient_name?: string;
  proposed_dose?: number;
  dose_unit?: string;
  granules_computed?: number;
  granules_reported?: number;
  weight_mg?: number;
}


// ---------------------------------------------------------------------------
// Route-side audit block (mirrors AuditBlock from lib/build-prompt.ts)
// Written by the route, not Claude. Contains fields Claude doesn't have access
// to: timestamps, file hashes, model identifiers, prompt manifest versions.
// ---------------------------------------------------------------------------

export interface RouteAuditBlock {
  submission_id?: string;
  generated_at_iso?: string;
  test_type?: string;
  test_lab_id?: string;
  practitioner_id?: string;
  practitioner_type?: string;
  pdf_sha256?: string;
  pdf_size_bytes?: number;
  skill_version?: string;
  system_prompt_version?: string;
  output_schema_version?: string;
  library_revision?: number | string;
  library_revision_date?: string;
  model?: string;
  draft_statement?: string;
}

// ---------------------------------------------------------------------------
// Granule verification block (mirrors verifyGranuleCounts output)
// Written by the route after deterministic recompute.
// ---------------------------------------------------------------------------

export interface RouteGranuleVerification {
  computed_total_granules?: number;
  computed_total_pod_weight_mg?: number;
  pod_budget_used?: number;
  computed_per_ingredient?: ComputedIngredient[];
  claude_granule_discrepancy_count?: number;
}

// ---------------------------------------------------------------------------
// Wrapper shape for live-test-output.json (post-2026-05-13)
// Live-test now writes the full response, not just Claude's output.
// ---------------------------------------------------------------------------

export interface LiveTestOutputFile {
  output: AnalysisOutput;
  audit?: RouteAuditBlock;
  granule_verification?: RouteGranuleVerification;
  usage?: Record<string, unknown>;
  stop_reason?: string;
}
