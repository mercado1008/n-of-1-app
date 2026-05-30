/**
 * lib/request-schema.ts
 *
 * Validates the JSON metadata field that arrives alongside the PDF in the
 * multipart/form-data request to /api/analyse.
 *
 * The PDF itself is validated separately (size, MIME type) in the route.
 */
import { z } from 'zod';
export const PractitionerType = z.enum([
  // AHPRA-registered
  'gp',
  'chinese_medicine',
  'nurse_practitioner',
  // Unregistered (National Code of Conduct)
  'naturopath',
  'nutritionist',
  'herbalist',
]);
export type PractitionerType = z.infer<typeof PractitionerType>;
export const SupportedTestType = z.enum([
  'NutriSTAT',
  'EndoSCAN',
  'myDNA_Longevity',
  'Organic_Acids',
  'Comprehensive_Stool_Analysis',
  'Advanced_Thyroid',
  'Cardiovascular_Risk',
  'Food_Intolerance',
]);
export type SupportedTestType = z.infer<typeof SupportedTestType>;

// Panel-class taxonomy. The system prompt routes interpretation by class
// (FBP-class has its own pattern catalogue, binding exclusions, allocation
// strategy; other classes are forward-compatibility placeholders). The
// request MUST supply `panel_classes` or Claude will refuse with
// `panel_class_not_specified`. The current prompt revision (v0.3.5)
// supports only FBP; non-FBP submissions are refused with
// `panel_class_not_yet_supported` until those modules are added.
export const PanelClass = z.enum([
  'FBP',  // Functional Biomarker Panel — NutriSTAT, Organic Acids, Cardiovascular Comprehensive, etc.
  'HMP',  // Hormone Metabolism Panel — EndoSCAN, neurotransmitters
  'GP',   // Genomic Panel — myDNA, MTHFR
  'MP',   // Microbiome Panel — Advanced Microbiome Mapping, Calprotectin
  'TP',   // Toxicant Panel — ALL-Tox, mycotoxins
  'RIP',  // Reactive / Immune Panel — IgG/IgA, autoimmune, cytokine
]);
export type PanelClass = z.infer<typeof PanelClass>;

export const RequestMetadataSchema = z.object({
  // Practitioner
  practitioner_id: z.string().min(1),
  practitioner_type: PractitionerType,
  practitioner_name: z.string().min(1).optional(),
  // Patient (pseudonymised — no PII at the AI layer)
  patient_pseudonym: z.string().min(1),
  patient_age_years: z
    .number()
    .int()
    .min(18, 'Patient must be 18 or over — minors are out of scope')
    .max(120),
  patient_sex_assigned_at_birth: z.enum(['female', 'male', 'intersex', 'unspecified']),
  // Test
  test_type: SupportedTestType,
  test_lab_id: z.string().min(1),
  test_collection_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  // Panel class — must be supplied per system-prompt spec
  panel_classes: z.array(PanelClass).min(1, 'At least one panel class is required'),
  // Submission
  submission_id: z.string().min(1),
});
export type RequestMetadata = z.infer<typeof RequestMetadataSchema>;
export const ClinicalNotesSchema = z
  .string()
  .max(10_000, 'Clinical notes capped at 10,000 characters')
  .default('');
// PDF size cap — pathology PDFs are typically 200KB–2MB. Bumped to 25MB to
// accommodate scanned/image-heavy reports.
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
