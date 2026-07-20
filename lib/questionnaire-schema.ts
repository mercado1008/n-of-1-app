/**
 * lib/questionnaire-schema.ts
 *
 * Validates the JSON body of /api/analyse-questionnaire — the SPP
 * (Symptom Presentation Panel) input path. No pathology test is attached;
 * the practitioner-submitted symptom questionnaire is the sole clinical
 * input. See prompts/system-prompt.md's "SPP-class panel interpretation"
 * and "Symptom matrix — input stream 2" sections for how these answers are
 * used in clinical reasoning.
 *
 * Category names must match prompts/system-prompt.md's symptom-to-axis
 * mapping table exactly (Claude's lookup is by name match) — any drift here
 * introduces silent mapping failures at the prompt layer, not a schema error.
 */
import { z } from 'zod';

export const SymptomCategory = z.enum([
  'Metabolic Syndrome',
  'Hypometabolism',
  'Low Cortisol / Adrenal Fatigue',
  'High Cortisol / Adrenal Stress',
  'Estrogen & Progesterone Deficiency',
  'Estrogen Dominance / Progesterone Deficiency',
  'Low Androgens',
  'High Androgens',
  'Digestive / GI',
  'Immune / Inflammation',
  'Neurological / Cognitive / Brain',
  'Sleep / Mood / Anxiety',
  'Musculoskeletal / Joint / Pain',
  'Detox / Skin',
  'Cardiovascular / Cardiometabolic',
]);
export type SymptomCategory = z.infer<typeof SymptomCategory>;

export const Severity = z.enum(['none', 'mild', 'moderate', 'severe']);
export type Severity = z.infer<typeof Severity>;

export const SymptomCategoriesSchema = z.record(SymptomCategory, Severity);
export type SymptomCategories = z.infer<typeof SymptomCategoriesSchema>;

// Direct yes/no screening for the hard- and soft-escalation triggers that
// normally rely on lab or genomic data (eGFR, ALT/AST, etc.) which simply
// don't exist on a questionnaire-only submission. See the "SPP-class panel
// interpretation" section of the system prompt for how each field maps onto
// an existing refusal/escalation trigger.
export const SafetyScreeningSchema = z.object({
  pregnant_or_breastfeeding: z.boolean(),
  active_malignancy_or_oncology_treatment: z.boolean(),
  end_stage_organ_failure_or_dialysis: z.boolean(),
  active_eating_disorder: z.boolean(),
  active_suicidal_ideation_or_recent_attempt: z.boolean(),
  known_kidney_disease: z.boolean(),
  known_liver_disease: z.boolean(),
  current_medications: z.string().max(2000).default(''),
});
export type SafetyScreening = z.infer<typeof SafetyScreeningSchema>;

export const QuestionnaireAnswersSchema = z.object({
  symptom_categories: SymptomCategoriesSchema,
  safety_screening: SafetyScreeningSchema,
});
export type QuestionnaireAnswers = z.infer<typeof QuestionnaireAnswersSchema>;

/**
 * A questionnaire with every category rated "none" and no clinical notes is
 * schema-valid but clinically empty. Checked at the route (not as a Zod
 * .refine on this schema) because clinical_notes is a sibling field on the
 * request body, validated separately by the shared ClinicalNotesSchema —
 * same architecture as the PDF and HL7 routes.
 */
export function hasAnyClinicalContent(
  answers: QuestionnaireAnswers,
  clinicalNotes: string,
): boolean {
  const hasSymptomData = Object.values(answers.symptom_categories).some(
    (severity) => severity !== 'none',
  );
  return hasSymptomData || clinicalNotes.trim().length > 0;
}
