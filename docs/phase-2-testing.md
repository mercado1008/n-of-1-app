# Phase 2 Summary — System Prompt + Output Schema

**Status:** Complete (deferred items noted below)
**Date:** 2026-05-04
**Versions delivered:** prompt v0.2.0, schema v0.2.0
**Compatible Library revision:** 15

## What Phase 2 produced

- `prompts/system-prompt.md` (v0.2.0) — the consolidated N of 1 clinical decision support system prompt. Replaces the original SKILL.md ecosystem (compliance_rules.md, clinical_language_guide.md, out_of_scope.md, health_analysis_template.md, prescription_schedule_template.md). All compliance rules, refusal triggers, language constraints, and output requirements are baked in.
- `prompts/output-schema.ts` (v0.2.0) — the Zod schema defining the structured JSON Claude returns. Discriminated union of formulation and refusal output types.
- `prompts/prompt-version.json` — version tracking for prompt and schema, with compatible Library revision.
- `scripts/validate-output.ts` — one-off validator that runs Claude output JSON through the Zod schema and reports errors.

## What was tested in Anthropic Console

Four test runs executed against system prompt v0.1.0 → v0.2.0:

1. **Refusal — paediatric patient (age 14).** Claude correctly identified the under-18 trigger and produced a clean refusal output. Audit metadata populated correctly.
2. **Refusal — missing submission block.** Claude refused due to missing practitioner.scope (template was pasted with placeholders unfilled). Demonstrated correct fail-closed behaviour when input is incomplete.
3. **Refusal — sex/PDF mismatch.** Claude cross-referenced the stated patient sex against hormone values on the lab report, identified the mismatch, and refused. Demonstrated clinical reasoning applied as a safety check.
4. **Formulation — adult male, NutriSTAT panel.** Claude produced a clinically sound, compliance-compliant formulation. See `phase-2-formulation-test-4.json`.

## What test 4 demonstrated (the canonical Phase 2 result)

- 8-ingredient formulation drawn entirely from the supplied Library (8/8 TSI codes verified present in `data/library-built/ingredients-library.json`)
- Selenium correctly excluded based on RBC selenium at upper limit of reference range
- Zinc dose held conservative based on copper:zinc ratio in upper portion of range
- Berberine declined because metabolic markers were in range
- Conservative dosing applied throughout in light of mildly reduced eGFR (67)
- Magnesium glycinate selected specifically for renal-friendly profile
- All clinical statements hedged per language guide (zero banned terms detected)
- Third-person framing throughout
- All recommendations show working (biomarker → threshold → evidence → ingredient choice)
- Soft escalation flagged for chronic medical condition warranting caution

## What was deferred to Phase 3

**Schema field-name enforcement.** Console testing revealed that Claude produces clinically excellent output but with field names that drift from the schema specification (e.g., `proposed_dose_mg` instead of `proposed_dose` + `dose_unit`). This is solved structurally in Phase 3 by switching from prompt-described schemas (Console) to API tool-use enforcement, where the schema becomes a hard constraint Claude cannot violate.

**Why this is the right deferral:** Five Console iterations made the limits of prompt-described schemas clear. The next mechanism (tool-use) eliminates the entire class of drift. Continuing to iterate in Console would not have produced learning that survives the Phase 3 transition.

## Files in this folder

- `phase-2-formulation-test-4.json` — canonical Phase 2 formulation output (the good one)
- `phase-2-testing.md` — this summary
- `phase-2-archive/` — earlier refusal test outputs, kept for audit trail

## Next steps (Phase 3 brief)

Build `/api/analyse` Next.js API route:
- Accept multipart POST with PDF + practitioner metadata + clinical notes
- Load system prompt and Library at request time
- Call Claude Opus 4.7 with tool-use schema enforcement (using `ClaudeOutputSchema`)
- Return structured JSON to caller
- Handle errors (API failures, validation failures, refusal returns)
- No frontend, no Shopify, no file generation in this phase