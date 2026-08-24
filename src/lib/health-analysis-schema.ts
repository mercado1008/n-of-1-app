/**
 * src/lib/health-analysis-schema.ts
 *
 * Zod schema for the Health Analysis document data contract.
 * This is the shape that feeds the React document renderer
 * (app/reports/[submissionId]/health-analysis/page.tsx — step 4).
 * It is NOT the Claude output schema (prompts/output-schema.ts) — that
 * validates what the AI returns. This validates what the renderer receives
 * after the Claude output has been mapped into a display-ready structure.
 *
 * Source of truth: design_handoff_health_analysis/README.md "Data Contract"
 *
 * Design notes:
 *   - Section numerals are DERIVED at render time, not stored here.
 *   - Counts in prose ("The following 31 findings...") are derived from
 *     array.length at render time. Do not add count fields.
 *   - The `Finding` schema uses generic field names that cover both genomic
 *     panels (gene name + rsID + direction) and biomarker panels (biomarker
 *     name + value label + direction). `gene` holds the biomarker or gene
 *     name; `rsid` is absent for non-genomic findings.
 *   - `status` drives the draft notice band: 'draft' → show band, 'approved'
 *     → hide it. Gate areasOfStrength and references on array non-emptiness.
 */
import { z } from 'zod';

// ── Finding direction ────────────────────────────────────────────────────────
// Drives status-pill colour in section 02.
//   slow / wildType / mixed / contextual → surface.pill bg, olive text
//   fast / upregulated                   → surface.goldPale bg, brand.goldDeep text
// For biomarker findings: use 'slow' for below-reference, 'fast' for
// above-reference, 'contextual' for within-range-but-clinically-significant.
export const StatusDirection = z.enum([
  'slow',
  'fast',
  'intermediate',
  'mixed',
  'wildType',
  'contextual',
]);
export type StatusDirection = z.infer<typeof StatusDirection>;

// ── Sub-schemas ──────────────────────────────────────────────────────────────

export const Finding = z.object({
  gene: z.string(),                       // gene name ("MTHFR C677T") or biomarker ("hsCRP")
  rsid: z.string().optional(),            // "rs1801133" — genomic panels only
  genotypeLabel: z.string(),              // "AG heterozygous — slow" or "6.88 mg/L (elevated)"
  direction: StatusDirection,             // drives pill colour
  interpretation: z.string(),
  contributors: z.string(),
  formulationRelevance: z.string(),
});
export type Finding = z.infer<typeof Finding>;

export const ClinicalPattern = z.object({
  name: z.string(),                       // e.g. "Methylation-cycle impaired"
  supportingSnps: z.array(z.string()),    // e.g. ["MTHFR C677T (rs1801133)", "MTRR A66G"]
});
export type ClinicalPattern = z.infer<typeof ClinicalPattern>;

export const LifestyleConsideration = z.object({
  topic: z.string(),                      // rendered in olive Jost, 150px column
  consideration: z.string(),             // main paragraph
  rationale: z.string(),                 // inline uppercase-labelled line
});
export type LifestyleConsideration = z.infer<typeof LifestyleConsideration>;

export const IngredientLine = z.object({
  name: z.string(),
  dose: z.string().optional(),           // "547 mcg" — omit for excluded items
  rationale: z.string(),
});
export type IngredientLine = z.infer<typeof IngredientLine>;

export const ExclusionLine = z.object({
  name: z.string(),
  code: z.string().optional(),           // TSI / W code, e.g. "W030006000"
  reason: z.string(),
});
export type ExclusionLine = z.infer<typeof ExclusionLine>;

export const Contraindication = z.object({
  // 'monitor' → brand.goldDeep text; 'informational'/'lowInContext' → ink.label
  severity: z.enum(['informational', 'monitor', 'lowInContext', 'high']),
  flag: z.string(),
  description: z.string(),
  ingredients: z.array(z.string()),
});
export type Contraindication = z.infer<typeof Contraindication>;

export const BindingExclusion = z.object({
  ingredient: z.string(),
  reason: z.string(),
});
export type BindingExclusion = z.infer<typeof BindingExclusion>;

export const MonitoringMarker = z.object({
  marker: z.string(),
  qualifier: z.string().optional(),      // "recheck 8–12 weeks"
  // fullWidth items span both columns in the 2-column list
  fullWidth: z.boolean().default(false),
});
export type MonitoringMarker = z.infer<typeof MonitoringMarker>;

export const Reference = z.object({
  index: z.number().int().positive(),
  authors: z.string(),
  year: z.number().int(),
  title: z.string(),
  journal: z.string(),                   // rendered in italic
  supports: z.string(),                  // ingredient this citation backs
});
export type Reference = z.infer<typeof Reference>;

// ── Root document schema ─────────────────────────────────────────────────────

export const HealthAnalysis = z.object({
  // Metadata (metadata grid + cover band + running header/footer)
  submissionId: z.string(),              // "SUB-2026-682"
  patientPseudonym: z.string(),
  age: z.number().int().positive(),
  sexAtBirth: z.string(),
  testType: z.string(),
  labId: z.string(),
  collectionDate: z.string(),
  practitionerId: z.string(),
  practitionerType: z.string(),
  generatedAt: z.string(),              // ISO 8601
  auditReference: z.string(),           // "XXXX-XXXX-XXXX" format

  // 'draft' → show draft-notice band; 'approved' → hide it
  status: z.enum(['draft', 'approved']),

  // §01 Executive Summary
  executiveSummary: z.string(),
  clinicalPatterns: z.array(ClinicalPattern),

  // §02 Detailed Biomarker / Findings Analysis
  findings: z.array(Finding),

  // §03 Diet and Lifestyle Considerations
  lifestyleConsiderations: z.array(LifestyleConsideration),

  // §04 Recommended Formulation Logic
  formulationStrategy: z.object({
    intro: z.string(),
    axes: z.array(z.string()),           // one string per numbered strategy card
    dosingNote: z.string(),
    included: z.array(IngredientLine),
    excluded: z.array(ExclusionLine),
    companionScheduleNote: z.string(),   // points to the companion .xlsx
  }),

  // §05 Contraindication and Interaction Considerations
  contraindications: z.array(Contraindication),
  bindingExclusions: z.array(BindingExclusion),

  // §06 Monitoring and Follow-Up
  monitoring: z.object({
    intro: z.string(),
    markers: z.array(MonitoringMarker),
    caveat: z.string(),                  // italic caveat line
  }),

  // §07 Areas of Strength (conditional — render only when non-empty)
  areasOfStrength: z.array(z.string()),

  // References (conditional — render only when non-empty)
  references: z.array(Reference),
});

export type HealthAnalysis = z.infer<typeof HealthAnalysis>;
