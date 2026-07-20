# Nof1 Precision Formulation — STATUS

**Last updated:** 2026-07-20, end of session — SPP panel class (questionnaire-only input path) + General_Comprehensive_Panel test type + underfill retry backstop
**Current versions:** prompt v0.6.8, schema v0.4.8, library revision 15
**Last known state:** 59/59 mock tests passing. Three input paths now live: `/api/analyse` (PDF), `/api/analyse-hl7` (HL7), `/api/analyse-questionnaire` (SPP — no pathology test attached, symptom questionnaire is the sole clinical input). Underfill retry backstop live on all three routes. SPP validated via 4 live-fires (2 mild-case iterations, 1 safety-trigger refusal, 1 multi-pattern — see below).

---

## What the system does today

A Next.js 14 App Router service accepts functional pathology input and JSON metadata, calls Claude Opus 4.7 with strict tool-use schema enforcement, and returns a structured JSON formulation. Three input paths are operational:

- **`/api/analyse`** — accepts a pathology PDF (multipart/form-data)
- **`/api/analyse-hl7`** — accepts a raw HL7 v2.3.1 ORU^R01 message (text field); biomarkers pre-extracted from 193 NM-type OBX segments, FT narrative excluded from prompt
- **`/api/analyse-questionnaire`** — accepts a JSON body, no file at all; a practitioner-submitted symptom questionnaire (15 categories rated none/mild/moderate/severe + safety-screening answers) is the sole clinical input. `panel_classes: ["SPP"]` only.

The route owns granule arithmetic deterministically (720-granule pod ceiling). After successful granule verification, an underfill-retry backstop fires automatically if a multi-pattern/note-activated panel lands under the 600-granule floor (one corrective retry, capped). All three routes then make a second lightweight Claude call to generate one published-study citation per formulation ingredient, and write a JSONL audit log entry to `logs/audit.jsonl`.

A separate document generation pipeline (`scripts/generate-docs/`) reads the JSON output and produces:

1. **Health Analysis (.docx)** — clinical narrative: executive summary, biomarker analysis, diet/lifestyle, formulation logic (with bullet-list included/excluded), contraindications, monitoring, areas of strength, References section with numbered study citations
2. **Recommended Formulation Schedule (.xlsx)** — 5 sheets: Formulation / Dose Adjustments / Standalones / Contraindications / Summary

**Panel classes implemented:** FBP (NutriSTAT primary calibration + Organic Acids + `General_Comprehensive_Panel` catch-all for non-NutriPath comprehensive panels), HMP (EndoSCAN), GP (myDNA Longevity, modifier-only), SPP (practitioner symptom questionnaire, modifier-only, no pathology test at all — new this session).

**Panel classes refused:** MP, TP, RIP — return `panel_class_not_yet_supported`. Multi-class combinations (e.g. `["FBP","SPP"]`) also refused for now.

---

## Most recent green live-fire (2026-07-20, SPP — questionnaire-only input path v0.6.7–v0.6.8)

Four fires against the new `/api/analyse-questionnaire` route, none with a pathology test attached.

**SUB-2026-SPP-MILD, first attempt** (2 categories at moderate — Low Cortisol/Adrenal Fatigue, Sleep/Mood/Anxiety):
- `panel_classes: ["SPP"]` echoed correctly, `critical_review_required: true`, `spp_modifier_only_no_biomarker_data` flag present (plus two Claude-generated extras: `biomarker_gated_exclusions_unavailable`, `conservative_dosing_substituted_for_missing_biomarker_data` — good sign the SPP-class reasoning was internalised, not just checkbox-satisfied)
- First pass: 312/720 → underfill retry fired → **423/720 (58.8%)** — still under the 600 floor even after retry. Root cause: a sparse (2-category) questionnaire has far less distinct clinical signal than a biomarker panel, so mapping only the directly-activated axes underfills even after full layering within them.
- Fix: added explicit language to the SPP-class section pointing at Step 4's "almost always includable" background-support list (Vitamin C, D3, quercetin, turmeric, second adaptogen, thiamine, nicotinamide) for submissions with <4 categories rated moderate/severe. Prompt v0.6.7 → v0.6.8.

**SUB-2026-SPP-MILD, re-run after the fix** (identical input):
- First pass: 431/720 (up from 312 — the fix changed baseline behaviour, not just the retry) → retry fired → **534/720 (74.2%)**, pulling in Turmeric/curcumin, Quercetin, Alpha-lipoic acid, Zinc citrate exactly as intended
- Still under 600 — accepted as a reasonable floor for a minimally-rated (2-category, moderate-only) presentation rather than over-fitting the prompt further to this specific sparse edge case. See Known Issues.

**SUB-2026-SPP-SAFETY** (1 category moderate + `end_stage_organ_failure_or_dialysis: true`, medications "Furosemide, calcium acetate"):
- Correct refusal, HTTP 200 in 29s (cheap — no formulation attempted): `refusal_trigger: "end_stage_organ_failure_or_dialysis"`, explanation correctly cross-referenced the medication list (calcium acetate is a phosphate binder consistent with advanced renal disease) as corroborating evidence
- Confirms the safety-screening-answers-as-hard-refusal-trigger design works exactly as intended, and that refusal outputs still short-circuit the granule pipeline cleanly on this new route

**SUB-2026-SPP-MULTI** (6 categories rated — Metabolic Syndrome, Hypometabolism, Low Cortisol/Adrenal Fatigue [severe], Digestive/GI, Immune/Inflammation, Neurological/Cognitive, Sleep/Mood/Anxiety [severe], Musculoskeletal/Joint) — the strongest of the four results:
- First pass: 576/720 (just under the floor) → underfill retry fired → **691/720 (96.0%)**, `retry_info.underfill_retry_outcome: "succeeded"`
- 4 recognised patterns, 23 ingredients spanning 9 categories (thyroid_adaptogenic, minerals, b_vitamins_methylation, anti_inflammatory_core, antioxidant_redox, vitamin_d_c_neurotransmitter, blood_glucose_insulin, mitochondrial_cardiovascular, gastrointestinal) — each traceable to the symptom-to-axis mapping table
- Confirms the conservative-dosing-substitution design: conservative iodine (131mcg, under the 150mcg cap) included in-pod rather than excluded outright; selenomethionine correctly routed to `standalone_recommendations` at ≤100mcg rather than in-pod, exactly mirroring the GP-class selenium precedent
- Escalation flags beyond the mandatory one were Claude-generated and clinically sharp: `severe_sleep_mood_anxiety_serotonergic_medication_check_required` (correctly flags the medication-list gap given severe mood/anxiety) and `female_reproductive_age_pregnancy_status_confirmation_advised`
- Confirms the hypothesis from the mild case: richer symptom signal (6 categories, 2 severe) gives the model enough distinct material to reach a healthy fill without needing the sparse-case background-support workaround at all.

See "SPP panel class + questionnaire-only input path" session write-up below for the full design and code changes.

## Previous green live-fire (2026-07-20, NutriSTAT — underfill retry backstop v0.6.5)

Two consecutive fires against NutriSTAT/FBP panels, back-to-back within the 5-minute prompt-cache window.

**SUB-2026-352** (test_lab_id 978913429-H-H900, same lab report that produced the SUB-2026-796 bug) — the clean validation case:
- 5 patterns recognised, 23 ingredients
- First-pass estimate: 550/720 granules (under the 600 floor) → underfill retry fired automatically
- Retry succeeded: **602/720 granules (83.6%)** — clears the floor
- `retry_info.underfill_retry_outcome: "succeeded"`, `pre_retry_granules_computed: 550`

**SUB-2026-001** (`test-fixtures/sample-nutristat.pdf` + `sample-notes.txt`, fatigue/brain-fog clinical notes) — the safe-fallback case:
- 3 patterns recognised, 21 ingredients
- First-pass estimate: 574/720 granules (79.7% — already far better than SUB-2026-796's 39%, from the prompt-only loophole closures alone)
- Retry fired (574 < 600) but the retry's own output failed the route's structural check (likely pod overage from overcorrecting) — route discarded the invalid retry and kept the original, structurally-valid 574-granule result
- `retry_info.underfill_retry_outcome: "retry_failed"` — practitioner still got a usable draft, no crash, no broken response

See "Underfill retry backstop" session write-up below for the full root-cause chain and code changes.

## Previous green live-fire (2026-05-31, Patient P000066 EndoSCAN — symptom matrix v0.5.8)

Test panel: NutriPath EndoSCAN, 53-year-old male, system_prompt_version: 0.5.8.

- HTTP 200, ~5.5 min total (formulation + citations)
- 5 patterns: HPA-hypocortisolism / 16-OH dominant oestrogen / Phase II substrate-limited methylation / **Cardiometabolic symptom burden (Metabolic Syndrome 36.67%)** / **Autonomic-arousal symptom overlay (High Cortisol 29.82%)**
- 18 ingredients, **658/710 granules (92.7% fill)**
- 2 symptom-driven binding exclusions: Licorice (High blood pressure MODERATE) + High-dose iodine (Hypometabolism 29.17% + unknown antibody status)
- Berberine (W010026000) included for `blood_glucose_insulin` axis activated by Metabolic Syndrome 36.67% symptom category — no biomarker driver needed
- Executive summary explicitly references symptom matrix burden
- 0 phantom W codes; escalation flags include `symptom_only_cardiometabolic_axis`

## Previous green live-fire (2026-05-31, Patient P000066 EndoSCAN — HMP v0.5.3)

Test panel: NutriPath EndoSCAN (24h urinary hormone profiling), 53-year-old male.

- HTTP 200, ~4.5 min total (formulation + citations), system_prompt_version: 0.5.3
- 3 patterns: HPA-hypocortisolism (cortisol 24.91 ug/gCR vs ref 50–200) / 16-OH dominant oestrogen (2:16 ratio 0.60 vs ref 1.10–5.60) / Low 2-OH substrate with preserved COMT capacity
- 20 ingredients, **682/710 granules (96.1% fill)**
- Key ingredients: DIM, Calcium D-glucarate, Milk thistle, Resveratrol, Ashwagandha, Rhodiola, Panax ginseng, CoQ10 (mitochondrial/adrenal), full B-vitamin complex, Magnesium, Zinc, NAC, Quercetin, Vitamin C, Vitamin D3
- 1 binding exclusion: Iodine (thyroid antibody status not assessed)
- 20 citations generated
- 0 phantom W codes
- Documents: `Nof1_HealthAnalysis_SUB-2026-004_DRAFT.docx` (45.4 KB), `Nof1_FormulationSchedule_SUB-2026-004_DRAFT.xlsx` (15.7 KB)

## Previous green live-fire (2026-05-30, Patient P000065 OAT via HL7 — FBP class)

Test panel: NutriPath Organic Acids Profiling, 56-year-old female, HL7 v2.3.1 input.

- HTTP 200, ~4.5 min total (formulation + citations)
- 6 patterns: Xenobiotic-burdened / Oxidative stress / Mitochondrial TCA strain / Kynurenine pathway shift / Methylation stress / Modest dysbiosis
- 16 ingredients, **678/710 granules (95.5% fill)**
- Allocation plan: 700 granules. Execution gap: 22 granules (within 80-granule tolerance)
- 16 citations generated (e.g. "Hewlings SJ & Kalman DS (2017). Curcumin: A Review of Its Effects on Human Health. Foods.")
- 0 phantom W codes; CoQ10 correctly placed as W030021000 (not the adjacent W030022000 Vitamin E)
- 27 uncached input tokens + 313k cache-read tokens (prompt caching confirmed working)
- `input_source: "hl7"` in audit block; audit log entry written

---

## What changed in today's session (2026-05-30)

### Option A — Server-side audit log (complete)

1. **`lib/audit-ref.ts`** — NEW. `computeAuditReference(audit: AuditBlock)` produces the same deterministic `XXXX-XXXX-XXXX` token that appears on practitioner documents. Shared between both routes and the generator.
2. **`lib/audit-log.ts`** — NEW. `appendAuditLog(entry)` writes one JSON line per submission to `logs/audit.jsonl` (creates `logs/` on first write). Entry contains full AuditBlock, audit_reference, outcome (output_type, granules, pod fill, ingredient count), and token usage.
3. **Both routes** — now call `appendAuditLog` after successful granule verification (and on granule-verification failure). Wrapped in try/catch — log failure never blocks the API response.
4. **`.gitignore`** — `/logs/` added.

### Option C — HL7 input adapter (complete)

5. **`lib/hl7-parser.ts`** — NEW. Parses raw HL7 v2 text into `HL7Segment[]`. Handles pipe/caret/CRLF. `field(seg, n)` and `comp(seg, fieldIdx, compIdx)` accessors.
6. **`lib/hl7-adapter.ts`** — NEW. Extracts PID (patient_id, dob, sex), OBR (order_id, collection_datetime), OBX NM (193 numeric findings with code/name/value/unit/ref_range/flag) and OBX FT (141 narrative entries — excluded from prompt as lab boilerplate). Confirmed against `sample-oat-p000065.hl7`.
7. **`app/api/analyse-hl7/route.ts`** — NEW endpoint. Same response shape as `/api/analyse`. `buildHL7UserPrompt` formats 193 biomarkers as a markdown table inline (no PDF attachment). Audit block sets `input_source: 'hl7'`; `pdf_sha256` contains SHA-256 of the HL7 text bytes.
8. **`scripts/live-test-hl7.ts`** — NEW CLI. Usage: `npx tsx scripts/live-test-hl7.ts <hl7> <metadata> [notes]`. Writes to `live-test-output-hl7.json`. Uses undici global dispatcher for 600s timeout (Node's default 300s was cutting connections on slow runs).
9. **`lib/build-prompt.ts`** — `buildHL7UserPrompt()` added. Shared `metadataSection()` / `taskSection()` helpers extracted. `AuditBlock` gains `input_source?: 'pdf' | 'hl7'`. FT narrative entries excluded from HL7 prompt (37KB lab boilerplate; reduced prompt from 55k → 12k chars).
10. **`lib/claude-client.ts`** — Refactored: shared private `executeClaudeCall(client, systemPrompt, content)` helper. `callClaudeForAnalysisFromText()` added for text-only (no PDF) calls.
11. **`lib/request-schema.ts`** — unchanged; same `RequestMetadataSchema` used by both routes.
12. **`prompts/system-prompt.md`** — two lines updated to accept both PDF and HL7 input (v0.3.8).

### Two-pass citations (complete)

13. **`lib/generate-citations.ts`** — NEW. Lightweight second Claude call after formulation verification. Takes ingredient names + clinical context (target biomarker findings), returns one published-study citation per ingredient. Format: `"First Author et al. (Year). Title or key finding. Journal Name."` No PMIDs/DOIs (hallucination-prone). ~$0.20 per call, ~30s.
14. **Both routes** — call `generateCitations()` after successful granule verification. Citations merged into `output.references`. Failure is graceful (formulation returned without citations on error).
15. **`prompts/output-schema.ts`** — `references?: Array<{ingredient_name, citation}>` added to `FormulationOutput` (v0.4.7). `key_references` on `ProposedIngredient` was tried and abandoned (caused arithmetic interference).

### Document generator fixes

16. **`scripts/generate-docs/health-analysis.ts`** — Section 4 fixed: `what_was_intentionally_included_and_why` (string array) and `what_was_intentionally_excluded_and_why` ({excluded, reason} array) now rendered as bullet lists. Previously passed to `bodyParagraph()` which expected a string.
17. **`buildReferencesSection()`** — NEW in health-analysis.ts. Reads from `output.references` (v0.4.7 citations), falls back to `evidence_pointer` per ingredient (legacy). Numbered list with gold `[n]` label and italic ingredient name. Placed before the closing disclaimer.
18. **`scripts/generate-docs/types.ts`** — `ProposedIngredient` gains `common_name?` and `evidence_pointer?`; `AnalysisOutput` gains `references?`.

### Pod ceiling and six-step rewrite (complete)

19. **`lib/granule-calc.ts`** — Pod ceiling changed from 700 → 710. `pod_budget_used` now computed as `/ 710`. Error message updated.
20. **`prompts/system-prompt.md`** — Six-step procedure completely rewritten (v0.4.5):
    - **Step 1:** Rank therapeutic areas (primary / secondary / supportive)
    - **Step 2:** Identify foundational + ordered layer ingredients for each area
    - **Step 3:** Foundational pass — one foundational per area in priority order, ALL areas before any layers
    - **Step 4:** Layer pass — cycle through areas in priority order adding one layer ingredient per area per cycle until total exceeds 710
    - **Step 5:** Back out the last ingredient entirely (no trimming), record in `excluded_from_pod`
    - **Step 6:** Verify total is 630–710, write sum in compliance_self_check.notes
    - Target zone: 630–710 (was 630–680, ceiling was 700)
    - All 700-granule references updated to 710 throughout the prompt
21. **Self-check items** — Updated to v0.4.5: explicit numeric check ("write the sum in notes, if <630 with ≥2 patterns this FAILS"); allocation plan consistency check removed; layer pass verification added.
22. **`scripts/live-test.ts` and `scripts/live-test-hl7.ts`** — undici global dispatcher added for 600s headersTimeout/bodyTimeout. Display strings updated from `/ 700` to `/ 710`.

---

## What changed in this session (2026-07-20 — SPP panel class + questionnaire-only input path)

### Context
Practitioner wants a genuine test-free formulation mode for patients with no pathology report at all. Considered reusing `panel_classes: ["FBP"]` (cheaper) but rejected it — FBP is explicitly defined as biomarker-driven, and calling a zero-biomarker submission "FBP" is the same mislabeling problem just fixed for `General_Comprehensive_Panel` below. Added a genuine 7th panel class instead: **SPP — Symptom Presentation Panel**, architecturally closer to GP (modifier-only, no biomarker data) than to FBP, just symptom-driven rather than genotype-driven.

### Schema (complete)
1. **`lib/request-schema.ts`** — `PanelClass` enum gains `SPP`. `SupportedTestType` gains `Practitioner_Symptom_Questionnaire`.
2. **`prompts/output-schema.ts`** — `PanelClassEnum` gains `SPP`. Genuine output-schema change (not just prompt content) — `output_schema_version` bumped 0.4.7 → 0.4.8 with a CHANGELOG entry. No other schema fields needed changing: `escalation_flags_raised` and `refusal_trigger` are free-form strings, so new SPP-specific values need no enum changes.
3. **`lib/questionnaire-schema.ts`** — NEW. `SymptomCategory` enum (the 15 categories from the existing symptom-to-axis mapping table, exact string match required — Claude's lookup is by name). `Severity` enum (none/mild/moderate/severe). `SymptomCategoriesSchema = z.record(SymptomCategory, Severity)` — confirmed via direct test that Zod v4 requires ALL 15 keys present and rejects unrecognised ones, which is the strictness wanted (catches frontend/schema drift immediately). `SafetyScreeningSchema` — direct yes/no questions standing in for the lab-dependent hard-refusal triggers (pregnancy, malignancy, end-stage organ failure/dialysis, eating disorder, SI, known kidney/liver disease, current medications). `hasAnyClinicalContent()` helper (not a Zod `.refine` on the schema, since `clinical_notes` is a sibling field on the request body validated by the existing shared `ClinicalNotesSchema` — same architecture as the other two routes, no duplication).

### Route (complete)
4. **`app/api/analyse-questionnaire/route.ts`** — NEW. JSON body (not multipart — no file involved), validates `panel_classes` is exactly `["SPP"]` (400 otherwise). From granule verification onward, copied verbatim from `/api/analyse-hl7`'s pipeline — `verifyGranuleCounts`, the underfill-retry backstop, `generateCitations`, `appendAuditLog`, `saveSubmission`/`saveDocuments`, `generateDocuments` are all input-format-agnostic and needed zero changes. Audit block hashes the canonicalised questionnaire JSON instead of file bytes.
5. **`lib/build-prompt.ts`** — `buildQuestionnaireUserPrompt()` NEW, mirrors `buildHL7UserPrompt()`: metadata → Form-B-style severity table (omitting "none" rows) → safety-screening summary (only flagged items) → clinical notes → shared `taskSection()`. `AuditBlock.input_source` widened `'pdf' | 'hl7'` → `'pdf' | 'hl7' | 'questionnaire'` — traced every read site first; nothing pattern-matches exhaustively on the old two-value union, confirmed safe.

### Prompt (complete) — v0.6.6 → v0.6.8
6. **New `## SPP-class panel interpretation` section**, modeled closely on GP-class: every activated axis is necessarily supportive priority (no biomarker can corroborate); biomarker-dependent binding exclusions (selenium, copper) cannot fire, conservative dosing substitutes; safety-screening answers map onto existing hard/soft refusal triggers — `end_stage_organ_failure_or_dialysis: true` → existing hard refusal (unchanged trigger, now practitioner-answered instead of lab-inferred); `known_kidney_disease`/`known_liver_disease` (without end-stage) → existing **soft** escalation ("mild-to-moderate CKD") — deliberately not a hard refusal, since severity can't be confirmed without labs and hard-refusing every reported kidney/liver history would make the mode unusable for a common comorbidity. Always `critical_review_required: true` + `spp_modifier_only_no_biomarker_data` escalation flag.
7. **Opportunistic fix**: lines ~154–156 ("Hard refusal triggers... any class other than FBP") were already stale, contradicted by the "Panel classes" section which correctly allowed FBP/HMP/GP — fixed while editing this exact region to include GP and SPP.
8. **v0.6.8 fill-fix** (see live-fire results below): added explicit language pointing SPP submissions with <4 rated categories at Step 4's "almost always includable" background-support list (Vitamin C, D3, quercetin, turmeric, second adaptogen, thiamine, nicotinamide) — a sparse questionnaire has much less distinct clinical signal than a biomarker panel, so mapping only the directly-activated axes reliably underfills even after full layering within them.

### Frontend (complete)
9. **`src/components/QuestionnaireForm.tsx`** + **`app/questionnaire/page.tsx`** — NEW. 15 severity selectors (segmented None/Mild/Moderate/Severe per category, sourced from `SymptomCategory.options` so the category list can't drift from the schema), 7 safety-screening checkboxes + medications textarea, existing clinical-notes textarea reused. `test_type` and `panel_classes` hardcoded (no dropdown — this route only ever produces one combination). `test_lab_id`/`test_collection_date` auto-filled (no real lab test exists) rather than forking `RequestMetadataSchema`. POSTs JSON, not FormData. Nav link added in `app/layout.tsx`.

### Tests (40 → 59, wait: 46 → 59 across this session's two features)
10. **`scripts/test-claude-client-mock.ts`** — 13 new tests: `VALID_SPP_FORMULATION` + `SPP_COMBINED_REFUSAL` fixtures (mirroring the HMP/GP pattern), `QuestionnaireAnswersSchema` validation (valid, missing category, invalid severity, unrecognised category), `hasAnyClinicalContent` (three branches), `buildQuestionnaireUserPrompt` formatting (omits none-rows, safety block reflects only flags, notes fallback). All zero Claude spend. 59/59 passing.

### Live-fire validation (see "Most recent green live-fire" above for full results)
11. Zero-spend checks first: manual `tsx -e` prompt-rendering smoke test, and three route dry-runs against the running dev server (malformed metadata, missing questionnaire, wrong panel_classes, empty-content guard) — all confirmed correct before spending on Claude.
12. Mild case (2 categories moderate) exposed a real underfill gap (312→423/720, 58.8%) that the generic retry backstop didn't fully close — root-caused to sparse symptom data having less distinct signal than a biomarker panel, fixed with the v0.6.8 background-support pointer (re-run: 431→534/720, 74.2% — genuine improvement, first-pass baseline moved not just the retry outcome, but still under 600; accepted as a reasonable floor for a minimally-rated presentation rather than further over-fitting this specific sparse edge case).
13. Safety-trigger case (end-stage organ failure/dialysis) — clean refusal, cheap (29s), correctly cross-referenced the medication list as corroborating evidence.
14. Multi-pattern case (6 categories, 2 severe) — clean success: first pass 576/720 → retry → **691/720 (96.0%)**. Confirms richer symptom signal reaches a healthy fill without needing the sparse-case background-support workaround; conservative iodine/selenium substitution behaved exactly as designed.

### CLAUDE.md (complete)
15. Panel-class enum documentation updated: FBP/HMP/GP/MP/TP/RIP/SPP, with FBP/HMP/GP/SPP now marked implemented. Repository structure and "input paths" locked decision updated from two paths to three.

---

## What changed in this session (2026-07-20 — General_Comprehensive_Panel test type)

Practitioner had been uploading real comprehensive GP-ordered blood panels (haematology, iron, lipids, electrolytes, eGFR, vitamin D, thyroid, cortisol, micronutrients) under `test_type: "NutriSTAT"` because no dropdown option existed for a non-NutriPath FBP panel — an accurate-routing-but-inaccurate-labelling problem (`panel_classes: ["FBP"]` already drove the correct clinical interpretation; only the document label was wrong).

1. **`lib/request-schema.ts`** — `SupportedTestType` gains `General_Comprehensive_Panel`.
2. **`src/components/SubmissionForm.tsx`** — new dropdown entry "General Comprehensive Panel (non-NutriPath)".
3. **`prompts/system-prompt.md` v0.6.5 → v0.6.6** — three clarifying edits so Claude doesn't treat the unfamiliar `test_type` string as a refusal trigger or expect a symptom matrix that won't be present: noted Stream 2 absence is expected for this test type; added it to the "interpretable but `critical_review_required`" list; clarified the recognised-pattern catalogue applies to any FBP-class panel reporting the relevant biomarkers, not just NutriPath products. No clinical-logic or output-schema changes — purely a labelling fix.
4. Mock tests: 46/46 still passing (no new tests needed — no new schema surface beyond the enum value itself).

---

## What changed in this session (2026-07-20 — underfill retry backstop)

### Root cause: SUB-2026-796 (complete diagnosis)

Practitioner reported that a NutriSTAT formulation "did not address clinical notes." Investigation of `data/submissions/SUB-2026-796/` found the ingredient-to-note mapping was structurally present (4 axes correctly activated by the notes) but the depth behind it was thin — the pod landed at **281/720 granules (39%)** despite 5 recognised patterns, well under the 600-granule floor. Root cause chain:

1. `compliance_self_check.notes` acknowledged the sub-600 fill and wrote a prose justification ("clinical discipline was prioritised over pod-fill maximisation... no clear biomarker abnormalities driving high-dose interventions") — the exact failure mode system-prompt.md's own "HARD STOP" rule (Step 4) already banned in v0.6.4. Prose-only reinforcement wasn't holding.
2. Claude's own `granule_budget_allocation_plan` totalled 600 granules across categories, but the actual `proposed_formulation` delivered only 281 — a ~53% execution gap between plan and output, meaning the Step 4 layer pass was abandoned after roughly one thin cycle instead of the required 2–4.
3. Found a real secondary bug while diagnosing this: `prompts/system-prompt.md` line 1's header comment said "v0.6.4" while the inline `# Version:` line still said "0.6.3" — this explains why SUB-2026-796's self-reported `audit_metadata.prompt_version` (0.6.3) didn't match the route's authoritative audit block (0.6.4). Fixed as part of this session's version bump.

### Prompt fix — v0.6.4 → v0.6.5 (complete)

Closed the two specific loopholes Claude used to rationalise the underfill, in `prompts/system-prompt.md`:
- **"Biomarkers within reference range" is not a valid reason to underfill** — added directly after the pod-sizing definition. States explicitly that the 600 floor is triggered by pattern/note-axis count, not biomarker severity, and calls out the exact rationalisation phrases from SUB-2026-796's self-check as the banned pattern.
- **Conservative dosing is not a reason to include fewer ingredients** — added in Step 4. A mild panel should add MORE moderate-dose ingredients for breadth, not fewer ingredients at higher individual doses.
- `prompts/prompt-version.json` bumped `system_prompt_version` 0.6.4 → 0.6.5. Header/inline version lines in system-prompt.md now agree.

### Retry backstop — new deterministic fallback (complete)

Prompt-only reinforcement had already been escalated across v0.6.2–v0.6.4 and still failed on SUB-2026-796, so this session adds a route-level backstop rather than relying solely on prose:

1. **`lib/underfill-retry.ts`** — NEW. `multiPatternFloorApplies(output, clinicalNotes)` mirrors the prompt's own floor trigger (2+ recognised patterns, or 1+ pattern with clinical notes present). `isUnderfilled(verification)` checks the route's deterministic total against the 600 floor. `buildUnderfillRetryAddendum({output, verification})` builds the corrective retry prompt — quotes the exact shortfall, per-category planned-vs-delivered gap, and the same three rules as the prompt fix, back at the model with concrete numbers rather than another abstract reminder.
2. **Both routes** (`app/api/analyse/route.ts`, `app/api/analyse-hl7/route.ts`) — after the first structural granule verification passes, check `multiPatternFloorApplies && isUnderfilled`. If true, fire exactly one retry call (same system prompt + PDF/HL7 content, original user prompt + addendum appended). Re-verify the retry's output:
   - If the retry passes structural verification, use it as the final result (regardless of whether it still underfills — capped at one retry to bound cost).
   - If the retry itself fails structural verification (e.g. overcorrects past 720), discard it and keep the original structurally-valid-but-underfilled result rather than fail the whole request. Now logs `retryVerification.issues` via `console.error` so the reason is diagnosable (added after SUB-2026-001's live-fire retry failed with no visibility into why — see below).
   - Token usage from both calls is summed (`totalUsage`) for accurate cost tracking in `logs/audit.jsonl` and the saved submission.
3. **`lib/audit-log.ts`** — `AuditLogEntry.outcome` gains `underfill_retry_attempted`, `underfill_retry_outcome` (`succeeded` | `still_underfilled` | `retry_failed`), `pre_retry_granules_computed`.
4. **`lib/submissions.ts`** — `SubmissionResponse` gains optional `retry_info` block, populated only when the retry fired.
5. **Both routes** — the final `NextResponse.json(...)` return simplified to reuse the already-built `responseBody` instead of duplicating the same fields a second time (pre-existing duplication, cleaned up incidentally while wiring usage/retry_info through).

### Mock tests (40 → 46)
6. **`scripts/test-claude-client-mock.ts`** — 6 new tests: `multiPatternFloorApplies` true for 2+ patterns, false for 1 pattern with no notes, true for 1 pattern with notes, false for refusal outputs; `isUnderfilled` true below 600 / false at 600; `buildUnderfillRetryAddendum` includes the shortfall total, the per-category planned vs. delivered breakdown, and the floor number. All 46/46 pass. No Claude spend.

### Live-fire validation (complete — see "Most recent green live-fire" above)
7. Two live-fires against NutriSTAT/FBP panels confirmed both branches of the retry logic: a clean retry-success (SUB-2026-352, 550→602/720) and a safe retry-fallback where the retry itself was structurally invalid and got discarded (SUB-2026-001, stayed at 574/720). First-pass fill rates in both cases (550, 574) were already roughly double SUB-2026-796's 281 — evidence the prompt-only loophole closures are doing real work independent of the retry backstop.

---

## What changed in this session (2026-07-14 — pod ceiling 720, underfill fixes, clinical notes)

### Pod ceiling raised 710 → 720 (complete)
1. **`lib/granule-calc.ts`** — overage check `> 710` → `> 720`, budget ratio `/ 710` → `/ 720`, error message updated.
2. **`scripts/live-test.ts`**, **`scripts/live-test-hl7.ts`** — display strings updated to `/ 720`.
3. **`app/submissions/[id]/page.tsx`** — pod fill display updated to `/ 720 granules`.
4. **`prompts/system-prompt.md` v0.6.3** — all 710 ceiling references updated. Estimate targets shifted: Step 4 stop range 660–690 (was 650–680), Step 5 trim threshold >670 (was >660), self-check gate ≤700 (was ≤690), allocation plan target 660–680 (was 650–670).
5. **`CLAUDE.md`** — locked design decisions updated to 720 throughout.
6. **`prompts/prompt-version.json`** — system_prompt_version bumped 0.6.2 → 0.6.3.

### Pod underfill root causes fixed — prompt v0.6.3 (complete)
Identified via SUB-2026-221 (249/720 gr, 2 patterns) and SUB-2026-352 (425/720 gr, 4 patterns).

**Root cause 1 — "clinical discipline" escape hatch:** Claude was rationalising sub-630 fills in `compliance_self_check.notes` and passing its own self-check. Fix: self-check enforcement language strengthened; self-check gate failure requires adding ingredients, not writing a justification.

**Root cause 2 — binding exclusions treated as axis blockers:** Claude was citing copper/iodine/5-HTP exclusions as the reason for underfill on entire axes. Fix: **Anti-pattern C** added — each binding exclusion blocks only the specific excluded ingredient; it never reduces fill obligation on the axis or the pod.

**Root cause 3 — "genuinely exhausted" definition too loose:** Claude was treating "I addressed the primary findings" as Library exhaustion. Fix: definition now requires explicitly naming every evaluated candidate and its specific contraindication. A concrete fallback ingredient list (Vitamin C, Vitamin D3, Quercetin, Turmeric, Rhodiola, Thiamine, Nicotinamide) is provided for use when fill is below target.

**Root cause 4 — stale v0.4.5 self-check item:** Still referenced the old "cycle until >710, back out last ingredient" procedure. Updated to match the current stop-at-660–690 + trim approach.

### Clinical notes as a formal input stream — prompt v0.6.3 (complete)
Previously, practitioner free-text clinical notes were only used for refusal checks and contraindication lookups. They are now a direct input to axis activation:

- **Formulation philosophy step 1** — rewritten to explicitly include clinical notes alongside biomarker patterns. Symptom language in notes (fatigue, brain fog, poor sleep, joint pain, digestive discomfort, etc.) activates corresponding therapeutic axes at supportive priority, or secondary if biomarkers corroborate.
- **Six-step procedure step 1** — updated: "From the recognised patterns **and the practitioner's clinical notes**..." Every axis activated by a note must appear in the allocation plan with a `findings_addressed` entry referencing the note.
- **Symptom-to-axis mapping** — explicit table added covering common note language patterns (fatigue → `thyroid_adaptogenic` / `mitochondrial_cardiovascular`, poor sleep → `minerals` / `b_vitamins_methylation`, joint pain → `anti_inflammatory_core`, etc.).

### Mock tests
- 40/40 still passing after all prompt and code changes.

---

## What changed in this session (2026-06-01, third pass — mock tests 34→40)

### Mock tests expanded (complete)
1. **`scripts/test-claude-client-mock.ts`** — 6 new tests added (34→40). All 40/40 pass.
   - **GP (3):** `["GP"]` accepted as formulation with `antioxidant_redox` category; `gp_modifier_only_no_biomarker_integration` escalation flag present; `["FBP","GP"]` combined refused with `panel_class_not_yet_supported`.
   - **Symptom matrix (3):** licorice binding exclusion with "High blood pressure MODERATE" trigger round-trips; symptom-only Cardiometabolic pattern in `recognised_patterns`; symptom-activated `blood_glucose_insulin` axis with Metabolic Syndrome 36.67% in allocation plan.
2. **New fixtures:** `VALID_GP_FORMULATION`, `GP_COMBINED_REFUSAL`, `FORMULATION_WITH_SYMPTOM_BINDING_EXCLUSION`, `FORMULATION_WITH_SYMPTOM_PATTERN`.

---

## What changed in this session (2026-06-01, second pass — document download)

### Document download from frontend (complete)
1. **`lib/generate-documents.ts`** — NEW. `generateDocuments()` orchestrates both generators programmatically: loads Library, builds TSI resolver, calls `generateHealthAnalysis()` and `generateFormulationSchedule()` in parallel, returns `{healthAnalysis: Buffer, formulationSchedule: Buffer}`.
2. **`lib/submissions.ts`** — `saveDocuments()` writes `health-analysis.docx` + `formulation-schedule.xlsx` to `data/submissions/{id}/`. `hasDocuments()` checks if both files exist. `getDocumentPath()` resolves file path for the download route.
3. **`app/api/submissions/[id]/documents/[type]/route.ts`** — NEW download endpoint. Serves `health-analysis` (docx) or `formulation-schedule` (xlsx) with correct MIME types and `Content-Disposition: attachment` headers.
4. **Both API routes** — call `generateDocuments()` + `saveDocuments()` after successful granule verification. Wrapped in try/catch — document failure never blocks the formulation response.
5. **Results page** — shows ↓ Health Analysis (.docx) and ↓ Formulation Schedule (.xlsx) download buttons when documents exist. Buttons hidden on refusal outputs. Forest green for docx, Gold for xlsx.

---

## What changed in this session (2026-06-01 — GP panel class + jsonrepair)

### GP panel class — myDNA Longevity (complete)
1. **`prompts/system-prompt.md` v0.6.0–v0.6.2** — GP unlocked. `["GP"]` now processes through (combined multi-class still refused). Full GP interpretation section added:
   - **What myDNA Longevity measures:** 18 gene modules, two result scales (longevity outcome: Exceptional/Average/Reduced; nutrient priority: Average/Medium/High Priority)
   - **Axis activation rules:** HIGH PRIORITY → secondary, MEDIUM PRIORITY → supportive, AVERAGE PRIORITY → no intervention
   - **Required `category` mapping table** for all GP axes (added v0.6.2 after early fires returned missing category → schema rejection)
   - **8 recognised GP patterns:** antioxidant-depleted, methylation-modifier, mitochondrial-support, COMT catecholamine clearance, APOE e4, FOXO3 pathway, choline-deficient, metabolic syndrome risk
   - **GP binding exclusion:** selenomethionine conservative dose when no red-cell selenium biomarker data
   - **Always:** `critical_review_required: true`, escalation flag `gp_modifier_only_no_biomarker_integration`
2. **`test-fixtures/sample-mydna.pdf`** — myDNA Longevity report (PT-2026-006, PNR42Y46)
3. **`test-fixtures/sample-metadata-mydna-p000067.json`** — SUB-2026-006, 44F, collection 2026-04-07

### jsonrepair — robust JSON normalisation (complete)
4. **`lib/claude-client.ts`** — `normaliseToolInput()` now has three levels:
   1. Direct `JSON.parse` — well-formed string
   2. Trailing-comma strip then parse — fast fix for common case
   3. `jsonrepair` then parse — handles malformed JSON in very long outputs (unquoted keys, truncated content, nested syntax errors)
   - `jsonrepair@3.14.0` added to `package.json`
   - Fixes the recurring "result is string not object" schema error on large outputs

### Panel class scorecard (as of 2026-06-01)
| Panel | Test | Fill | Notes |
|---|---|---|---|
| FBP | OAT P000065 | ~94% | Primary calibration panel |
| HMP | EndoSCAN P000066 | 92.7% | 24h urinary hormones |
| GP | myDNA P000067 | 94.1% | Genomic modifier-only |

---

## What changed in this session (2026-05-31, fourth pass — end-to-end validation)

### Frontend end-to-end test (complete)
1. **Seeded SUB-2026-004** from existing EndoSCAN live-fire output to `data/submissions/SUB-2026-004/` — verified history list and results page render correctly without a live-fire.
2. **Live-fired SUB-2026-005** through the form endpoint — OAT P000065 (FBP), 598/710 granules (84.2%), 6 patterns, 20 ingredients, 20 citations, 320 seconds.
3. **Persistence confirmed:** both `request.json` and `response.json` written to `data/submissions/SUB-2026-005/`.
4. **History list confirmed:** both SUB-2026-004 (EndoSCAN 92.7%) and SUB-2026-005 (Organic Acids 84.2%) appear correctly.
5. **Results page confirmed:** patient pseudonym, granule count, patterns, ingredient table, binding exclusions, citations all rendering correctly for SUB-2026-005.

**Full loop confirmed:** form submission → `/api/analyse` → granule verification → citations → persistence → `/submissions/{id}` results page → `/submissions` history list.

---

## What changed in this session (2026-05-31, third pass — frontend + persistence)

### Frontend (complete)
1. **`app/layout.tsx`** — branded root layout: Forest green header, Gold/Cloud palette, Geist font, nav links (New Submission, History), draft disclaimer footer.
2. **`app/page.tsx`** — home page hosting the submission form.
3. **`src/components/SubmissionForm.tsx`** — client component: PDF/HL7 input toggle, all RequestMetadata fields (practitioner ID/type/name, patient pseudonym/age/sex, test type, lab ID, collection date, panel classes checkboxes, clinical notes), auto-generated submission ID, 4-minute loading spinner, error display, redirect to results on success.
4. **`app/submissions/page.tsx`** — history list: table of all saved submissions (patient pseudonym, test type, panel classes, pod fill %, date, ingredient count or "Refusal" badge).
5. **`app/submissions/[id]/page.tsx`** — results display: headline, pod fill progress bar, recognised patterns (with supporting findings), ingredient table (route-computed granules), binding exclusions, standalone recommendations, citations list, audit footer (prompt/schema/library versions, generated timestamp).
6. **Tailwind config** — brand colors added (forest, gold, sage, cloud); content paths updated to cover `./app/**` and `./src/**`.

### Persistence (complete)
7. **`lib/submissions.ts`** — `saveSubmission()` writes `request.json` + `response.json` to `data/submissions/{submission_id}/`. `getSubmission()` reads a single submission. `listSubmissions()` reads all directories and returns sorted summaries. All I/O wrapped in try/catch — persistence failure never blocks the API response.
8. **Both API routes** (`/api/analyse` and `/api/analyse-hl7`) — call `saveSubmission()` after successful granule verification. Wrapped in try/catch.
9. **`.gitignore`** — `data/submissions/` excluded (contains patient pseudonym data).

### Notes
- Frontend renders correctly at `http://localhost:3000`. The `./app/` directory takes precedence over `./src/app/` in Next.js routing; pages placed in `./app/` directly.
- Submissions history will populate on first live-fire through the form.
- Document download (docx/xlsx) not yet wired to the frontend — deferred.

---

## What changed in this session (2026-05-31, second pass — symptom matrix)

### Symptom matrix integration — input stream 2 (complete)
1. **`prompts/system-prompt.md` v0.5.4–v0.5.8** — new "Symptom matrix — input stream 2" section added. Covers:
   - **Form A (Symptom Categories):** named categories with % scores (e.g. "Metabolic Syndrome 36.67%"). Category score ≥25% activates the corresponding therapeutic axis even when biomarkers are in-range.
   - **Form B (Symptom Score matrix):** three-column MILD/MODERATE/SEVERE severity placement. Symptom's column is its severity rating — no per-symptom numeric scores.
   - **Axis activation priority:** symptom-only axes are supportive; biomarker-confirmed axes are primary/secondary. Prevents symptom load from displacing biomarker-confirmed axes.
   - **Budget discipline with many axes:** when >6 axes active, lowest-priority symptom axes may receive 1 layer ingredient only or be deferred.
   - **Symptom-driven binding exclusions:** Licorice excluded when "high blood pressure" MODERATE/SEVERE or cardiovascular category ≥30%. High-dose iodine excluded when thyroid symptom category ≥20% AND antibody status unknown.
   - **Executive summary and `biomarker_analysis`:** must reference symptom findings ≥25%.
2. **Symptom-to-axis mapping table** — 15 category name patterns mapped to therapeutic axes.
3. **Fill calibration through v0.5.4–v0.5.8** — resolved bidirectional overshoot (711-963) and undershoot (578-620):
   - Self-check gate: **630 ≤ sum ≤ 690** (both floors enforced)
   - Allocation plan target: **650–670 minimum**
   - Step 4 layer pass: **target 650–680, centre ~665**
   - Step 5 trim: fires when estimate > 680
   - Explicit overhead note: ~1 granule per ingredient from ceil() arithmetic; 20 ingredients = ~20 granule overhead

### PDF symptom format confirmed
4. Read Mark Martin EndoSCAN PDF via direct Claude API call. Confirmed format:
   - Page 5, headings "Symptom Categories" (Form A) and "Symptom Score" (Form B)
   - 8 categories with % scores (range 23.81%–36.67% for this patient)
   - "High blood pressure" appears at MODERATE severity → licorice binding exclusion trigger confirmed

---

## What changed in this session (2026-05-31)

### HMP panel class — EndoSCAN (complete)
1. **`prompts/system-prompt.md` v0.5.0–v0.5.3** — HMP unlocked. Panel classes section updated: `["HMP"]` now processes through; combined `["FBP","HMP"]` still refused. Full HMP interpretation section added covering:
   - What EndoSCAN measures (Phase I hydroxylation: 2-OH/4-OH/16-OH; Phase II methylation: 2-MeO; ratios: 2:16, COMT, cortisol:cortisone)
   - 8 recognised patterns (16-OH dominant, 4-OH dominant, COMT insufficiency, androgen excess/insufficiency, HPA-hypocortisolism, HPA-hypercortisolism, oestrogen dominant, progesterone insufficiency)
   - HMP-specific binding exclusions (phytoestrogens, high-dose zinc in androgen excess)
   - HMP formulation axes with specific ingredient/TSI code guidance (DIM W140019000, Saw palmetto W010043000, Vitex W010067000, CoQ10 W030021000 for adrenal support)
   - Explicit ingredient list for a complete HMP layer pass (15–20 ingredients for 3-pattern male HMP)
2. **`test-fixtures/sample-endoscan-p000066.pdf`** — Mark Martin EndoSCAN March 2026 (PT-2026-004)
3. **`test-fixtures/sample-metadata-endoscan-p000066.json`** — SUB-2026-004, 53M, collection 2026-03-10, lab ID 6463011
4. **Documents** — `Nof1_HealthAnalysis_SUB-2026-004_DRAFT.docx` + `Nof1_FormulationSchedule_SUB-2026-004_DRAFT.xlsx`

### Pod fill — layer pass targeting change
5. **Step 4 rewritten** — changed from "cycle until total EXCEEDS 710 then back out" to "cycle until ESTIMATE reaches 650–695 then stop." The back-out strategy was unreliable (Claude can't remove items from JSON it has already written). New target: self-estimate 650–695 → route arithmetic adds ~1–2gr per ingredient → final fill 660–710.
6. **Step 5 rewritten** — from "back out last ingredient" to "trim highest-cost ingredient in lowest-priority category by 15–25% if estimate is above 700." More actionable for sequential text generation.
7. **Allocation plan target** — changed from "sum to 680–710" to "sum to 670–700" to align with the new step 4 target.

### Mock tests (21 → 30)
8. **`scripts/test-claude-client-mock.ts`** — 9 new tests added: v0.4.7 `references` field (round-trip and optional), `callClaudeForAnalysisFromText` (HL7 path), HL7 parser (segment splitting, field/comp accessors, CRLF/LF), HL7 adapter (PID, NM/FT OBX, OBR). All 30/30 pass.

### Document polish
9. **`buildMetadataTable()` in health-analysis.ts** — accepts `RouteAuditBlock` as third parameter; falls through to `routeAudit.generated_at_iso` when Claude's `audit_metadata.generated_at_iso` is absent. Fixes "Generated: —" on page 1.
10. **xlsx Summary label column** — widened from 36 to 48 characters. "Mitochondrial / Cardiovascular (secondary)" no longer clips in print preview.

### Gitignore
11. **`.gitignore`** — added `generated-docs/~$*` to prevent Office temp/lock files from being committed.

---

## What changed in this session (2026-05-30, second pass)

### Prompt caching
1. **`lib/build-prompt.ts`** — `assembleFullSystemPrompt()` now returns `TextBlockParam[]` with `cache_control: { type: 'ephemeral' }` on each block (system prompt + Library separately). First call after server restart writes to cache; subsequent calls within 5 min serve from cache at $1.50/MTok vs $15/MTok.
2. **`lib/claude-client.ts`** — `SystemPrompt` type widened from `string` to `string | Anthropic.Messages.TextBlockParam[]`. Both route client functions and the shared `executeClaudeCall` helper updated.
3. **Both routes** — `systemPrompt` variable type updated to `SystemPromptBlocks`. No logic changes.
4. **Confirmed:** 27 uncached + 312,742 cache-read tokens. ~$2.37 saved per call on the 175k-token cacheable portion.

### Pod fill reliability fixes
5. **Root cause 1 — TSI code confusion:** W030021000 (CoQ10, 1mg/granule) and W030022000 (Vitamin E, 4.99mg/granule) are adjacent codes Claude was confusing. When Claude placed W030022000 but computed self-check granules using CoQ10's dose_per_granule (1mg), it thought the pod was 79 granules fuller than it actually was — causing the self-check to pass at 651 (in range) when the actual was 572 (out of range). Fix: added explicit disambiguation note to the Library context block in `getLibraryContextBlock()`.
6. **Root cause 2 — Layer pass stopping early:** Claude was treating the allocation plan total (630–650) as a target ceiling, stopping after one cycle through the axes. Fix: prompt v0.4.6 strengthens Step 4 to state that 2–4 cycles are expected, defines "genuinely exhausted" more strictly (must have evaluated every Library ingredient for every active category, not just "covered the axes"), adds plan-vs-actual gap check to the self-check (>80 granule gap = layer pass failed), and adds a bold override note that 549 granules for a 6-pattern panel is a formulation error.
7. **Allocation plan target:** changed from "sum to ≤ 710" to "aim for 680–710" so the plan itself targets near-full utilisation rather than a conservative floor.
8. **System prompt:** v0.4.5 → v0.4.6.

---

## Locked design decisions

### From Phase 4 (do not re-debate)
- **Route owns granule arithmetic** — confirmed by extensive live-fire evidence.
- **Therapeutic category enum: 14 + `other`** — locked.
- **`gastrointestinal`: single bucket** — locked.
- **Selenium**: BINDING EXCLUSION when red-cell Se ≥90% upper reference.
- **Copper**: BINDING EXCLUSION when Cu:Zn>1.50 OR plasma upper third OR %free>25%. Low zinc does NOT override.
- **Pattern enum**: free string (vocabulary may evolve).
- **Panel architecture**: FBP-shaped, refuse other classes with `panel_class_not_yet_supported`.
- **`panel_classes` is required at the request level**, not inferred from test_type.
- **OAT is FBP-class** — explicit decision.

### Formulation construction (updated 2026-07-14)
- **Pod ceiling: 720 granules** (route enforces; raised from 710 on 2026-07-14).
- **Six-step procedure:** (1) rank areas (including clinical-note-activated axes), (2) identify foundationals + layers, (3) foundational pass all areas, (4) layer pass cycles until self-estimate reaches 660–690, (5) trim highest-cost ingredient if estimate > 670, (6) verify self-check gate 630–700.
- **Self-check gate: 600 ≤ estimate ≤ 700.** Route adds ~1 gr/ingredient; 700 estimate + 20 ingredients ≈ 720 route-computed.
- **Allocation plan target: 660–680 minimum.**
- **Foundational dose floor:** ≥75% of clinical target (primary + secondary); ≥50% (supportive).
- **Layer dose floor:** ≥50% of clinical target.
- **Catalyst-layer threshold:** ≥1000 granules at foundational-pass total.
- **Target fill zone:** 600–720 granules (route-computed). Sub-600 on a multi-pattern panel is a formulation error.
- **Clinical notes are a direct input stream.** Practitioner free-text notes activate therapeutic axes using the same priority logic as the symptom matrix. Note-activated axes appear in the allocation plan and `biomarker_analysis`.
- **Binding exclusions block specific ingredients only.** They do not reduce fill obligation on the axis or the pod (Anti-pattern C, v0.6.3).
- **"Within reference range" and "conservative dosing" are not valid underfill excuses** (v0.6.5, `lib/underfill-retry.ts`). The 600 floor is triggered by pattern/note-axis count, not biomarker severity or dose caution — closed after SUB-2026-796 (281/720, 39% fill) rationalised both in its self-check.
- **Underfill retry backstop is a deterministic route-level fallback, not prompt-only.** After v0.6.2–v0.6.4 prose reinforcement still failed on SUB-2026-796, the route now fires one corrective retry when `multiPatternFloorApplies && isUnderfilled`, using the model's own shortfall numbers in the retry prompt. Falls back safely to the original result if the retry itself is structurally invalid.

### Symptom matrix (locked as of 2026-05-31)
- **Input stream 2 is mandatory.** Symptom matrix must be read and used alongside biomarker tables for all NutriPath panels.
- **Form A (Symptom Categories):** category score ≥25% activates corresponding therapeutic axis. Symptom-only axes are supportive priority; biomarker-confirmed axes are primary/secondary.
- **Form B (Symptom Score):** MILD/MODERATE/SEVERE column placement is the severity rating — no per-symptom numeric score.
- **Licorice binding exclusion** fires when "high blood pressure" is MODERATE or SEVERE in symptom matrix, or cardiovascular symptom category ≥30%.
- **High-dose iodine binding exclusion** fires when thyroid symptom category ≥20% AND antibody status unknown on the panel.
- **Executive summary and `biomarker_analysis`** must reference symptom category scores ≥25%.

### Panel classes (updated 2026-07-20)
- **FBP (Functional Biomarker Panel):** NutriSTAT, Organic Acids, Cardiovascular Comprehensive, `General_Comprehensive_Panel` (non-NutriPath catch-all, added 2026-07-20), etc. Full pattern catalogue calibrated against NutriSTAT; other FBP test types work but flag `critical_review_required`.
- **HMP (Hormone Metabolism Panel):** EndoSCAN (24h urinary hormones). Full interpretation section. Other HMP panels (Neurotransmitters Profile) flag `critical_review_required`. Combined FBP+HMP still refused.
- **GP (Genomic Panel):** myDNA Longevity. Modifier-only — genotype-driven, no biomarker data. Always `critical_review_required` + `gp_modifier_only_no_biomarker_integration` escalation. Other GP panels not yet calibrated.
- **SPP (Symptom Presentation Panel, added 2026-07-20):** practitioner-submitted symptom questionnaire, no pathology test attached at all. Modifier-only like GP but symptom-driven. Always `critical_review_required` + `spp_modifier_only_no_biomarker_data` escalation. `end_stage_organ_failure_or_dialysis` safety-screening answer is a hard refusal (unchanged existing trigger); `known_kidney_disease`/`known_liver_disease` alone is a soft escalation, not a refusal.
- **MP, TP, RIP:** refused with `panel_class_not_yet_supported`. Multi-class combinations (including `["FBP","SPP"]`) also refused for now.

### Input paths (updated 2026-07-20)
- **PDF path (`/api/analyse`):** accepts pathology PDF as document attachment.
- **HL7 path (`/api/analyse-hl7`):** accepts raw HL7 v2.3.1 ORU^R01 text. FT narrative entries excluded from prompt (lab boilerplate). `input_source: 'hl7'` in audit block.
- **Questionnaire path (`/api/analyse-questionnaire`, added 2026-07-20):** accepts a JSON body (no file). `panel_classes` must be exactly `["SPP"]`. `input_source: 'questionnaire'` in audit block; `pdf_sha256` hashes the canonicalised questionnaire JSON.
- **All three paths:** identical response shape, audit log, granule verification, underfill-retry backstop, citation pass.
- **HL7 FT narrative excluded from prompt** — 37KB of lab-intro boilerplate; only NM numeric findings go to Claude.

### Document conventions
- **Page size:** A4 portrait.
- **Brand colours:** White, Black, Gold `#C3AF88`, Forest `#535B50`, Sage Green `#A7B7A5`, Cloud `#E2E0D9`.
- **Fonts:** Roboto Medium (headings) / Roboto Regular (body), Arial fallback.
- **Filename:** `Nof1_HealthAnalysis_{submission_id}_DRAFT.docx` and `Nof1_FormulationSchedule_{submission_id}_DRAFT.xlsx`.
- **TSI codes:** xlsx only, never docx. Labelled as "W Code".
- **No AI/model identifier** in any practitioner-facing document.
- **Audit Reference:** opaque `XXXX-XXXX-XXXX` (12 hex chars from SHA-256 of audit state). Appears in docx footer only.
- **Brand band:** pre-composited PNG at `assets/brand/nof1_header_band.png`.
- **References section:** numbered list in docx, populated from `output.references` (two-pass citation call). Falls back to `evidence_pointer` for older outputs.
- **Internal taxonomy never in client-facing output** — humanised via `CATEGORY_DISPLAY_NAMES`.

### Regulatory and audit
- **Server-side audit log:** `logs/audit.jsonl`, one JSON line per submission. Contains full AuditBlock, audit_reference, outcome, usage. Written by both routes. `logs/` is gitignored.
- **Audit Reference is shared:** `lib/audit-ref.ts` computes the same reference used by both routes and the document generator. Same 6 inputs → same reference.
- **Two-pass citations:** formulation call first, citation call second. Failure in citation pass never blocks formulation response.

### Prompt caching
- **`assembleFullSystemPrompt()`** returns `TextBlockParam[]` with `cache_control: { type: 'ephemeral' }` on each block. System prompt (~17k tokens) and Library JSON (~158k tokens) are cached separately.
- **175k cacheable tokens.** Cache read: $1.50/MTok vs $15/MTok uncached. Saving ~$2.37 per cache-hit call.
- **Cache TTL: 5 minutes.** Each API call within the window refreshes the TTL.

### TSI code disambiguation
- **W030021000 = Coenzyme Q10** (1 mg/granule). **W030022000 = Vitamin E** (4.99 mg/granule). These are adjacent codes that Claude confuses. Disambiguation note is embedded in the Library context block. If further adjacent-code confusions surface, add them to the note in `getLibraryContextBlock()` in `lib/build-prompt.ts`.

---

## What's working now (high confidence)

### Frontend and persistence
- **`http://localhost:3000/`** — submission form: PDF/HL7 toggle, all metadata fields, panel class checkboxes, loading spinner.
- **`http://localhost:3000/submissions`** — history list (populates after first form submission).
- **`http://localhost:3000/submissions/{id}`** — results: headline, pod fill bar, patterns, ingredient table, binding exclusions, citations, audit footer.
- **File persistence:** `data/submissions/{id}/request.json` + `response.json` written by both routes after success. `data/submissions/` gitignored.
- **Document download** wired to frontend. Results page shows download buttons; documents generated automatically after each analysis and persisted to `data/submissions/{id}/`.

### Clinical reasoning
- **Panel-class routing.** FBP (NutriSTAT, OAT) and HMP (EndoSCAN) process correctly; non-FBP/HMP refuses cleanly.
- **Pattern recognition.** 3–6 patterns on FBP panels; 3 patterns correctly identified on first HMP live-fire.
- **Library accuracy.** Zero phantom W codes across all recent runs.
- **Granule arithmetic.** Route-computed, deterministic. 710-granule ceiling enforced.
- **Pod fill.** FBP: reliably 630–710. HMP first fire: 682/710 (96.1%). TSI code disambiguation note prevents CoQ10/Vitamin E confusion.
- **Standalone routing.** Library gaps correctly routed to `standalone_recommendations`.
- **Binding exclusions.** Fire correctly. HMP-specific exclusions (iodine, phytoestrogens) working.

### HMP panel class
- **EndoSCAN interpretation.** Phase I hydroxylation (2-OH/4-OH/16-OH), Phase II methylation (COMT), adrenal/cortisol, androgens — all correctly extracted and reasoned.
- **8 HMP patterns.** 16-OH dominant, 4-OH dominant, COMT insufficiency, androgen excess/insufficiency, HPA-hypocortisolism, HPA-hypercortisolism, oestrogen dominant, progesterone insufficiency.
- **HMP ingredient set.** DIM (W140019000), Saw palmetto (W010043000), Vitex (W010067000), CoQ10 (W030021000) all correctly deployed for HMP patterns.
- **Mark Martin (PT-2026-004):** confirmed green. 682/710 fill, 3 patterns, 20 ingredients, 20 citations.

### HL7 input path
- **Parser.** 193 NM + 141 FT OBX segments correctly extracted from NutriPath HL7 v2.3.1.
- **Adapter.** PID (patient_id, dob, sex), OBR (order_id, collection_datetime), all numeric findings parsed correctly.
- **Route.** `/api/analyse-hl7` HTTP 200 confirmed. `input_source: 'hl7'` in audit block.
- **Prompt size.** 12k chars (down from 55k before FT exclusion).
- **Timeout handling.** undici global dispatcher at 600s prevents connection drops on slow runs.

### Citations (two-pass)
- **Separation works.** Citation call runs after formulation verification; no arithmetic interference.
- **Quality.** Real author/year/journal citations (e.g. "Hewlings SJ & Kalman DS (2017). Curcumin: A Review of Its Effects on Human Health. Foods.")
- **Coverage.** 17–22 citations per run (one per ingredient).
- **Graceful failure.** Formulation returned even if citation call fails.

### Document generation
- **Health Analysis docx.** All sections rendering. Section 4 included/excluded now bullet-list (was array-to-string bug). References section populated with numbered study citations.
- **Formulation Schedule xlsx.** 5 sheets, brand styling, severity colour-coding.
- **Audit Reference.** Deterministic, opaque, consistent between route and generator.

### Infrastructure
- **Server-side audit log.** `logs/audit.jsonl` written per submission. Contains audit_reference cross-referenceable to document.
- **Both routes parity.** `/api/analyse` and `/api/analyse-hl7` both have: granule verification, citation pass, audit log, same response shape.

---

## Known issues and unfinished work

### Document polish (deferred)
- **Metadata table shows "Generated: —"** on page 1 of docx. `audit_metadata.generated_at_iso` not populated by Claude; falls through to `routeAudit.generated_at_iso` but that field name differs. Fix: update fallback path in `buildMetadataTable()`.
- **xlsx Summary label column truncates** long category names in print preview. Widen from 36 to 44+.
- **"Catalyst-layer pod strategy" vestigial flag** still appears occasionally in escalation flags. Worth cleaning up in next prompt revision.

### Duplicate-emission bug (partially fixed)
- Claude occasionally duplicates an `excluded_from_pod` item into `standalone_recommendations`. Prompt clarification (v0.3.7) improved this but didn't eliminate it. If still seen, add explicit rule to the self-check: "do not list an excluded_from_pod item in standalone_recommendations."

### HL7 path
- **NutriPath local code → display name:** OBX-3.2 display names used as-is from HL7. Some are truncated (e.g. `4_HYDROXYBENZOIC_ACI`). Sufficient for clinical reasoning.
- **Apples-to-apples comparison not yet done.** P000065 available in both PDF and HL7 formats; not yet compared in the same session.
- **OAT PDF has no symptom matrix.** Confirmed via direct PDF read: NutriPath US BioTek OAT is a pure biomarker report (23 pages, no patient-reported symptom section). Symptom matrix is specific to NutriPath panels that include patient questionnaires (e.g. EndoSCAN). Validating symptom integration on OAT would not exercise stream 2.
- **Q3, Q4, Q7, Q8 from NutriPath still open** (push/pull, sandbox, corrections, per-test cost).
- **Other adjacent TSI code pairs may exist** beyond W030021000/W030022000. The disambiguation note covers the known confusion; further code confusions may surface in future runs.

### Pod fill
- **Run-to-run variance persists.** LLM property — occasional outlier fills (sub-630 or near-720) should be expected despite prompt fixes. Route hard-rejects anything over 720; sub-630 self-check enforcement strengthened in v0.6.3, backstopped by the v0.6.5 underfill retry.
- **Underfill retry has only been exercised on FBP/NutriSTAT panels and SPP panels so far.** HMP and GP panels haven't hit this path yet — no reason to expect different behaviour, but unconfirmed.
- **SUB-2026-001's retry failed structurally with no diagnosed cause.** Most likely overcorrection past 720 (pod overage) after being told to add more ingredients, but the retry's raw output isn't persisted when it's discarded, so this is inferred, not confirmed. `retryVerification.issues` is now logged via `console.error` on this path (added this session) — check server logs next time this fires to confirm.
- **SPP submissions with few rated categories reliably underfill even after the retry and the v0.6.8 background-support fix.** SUB-2026-SPP-MILD (2 categories, both moderate) landed at 534/720 (74.2%) after two rounds of prompt strengthening this session — genuine improvement over the initial 423/720, but still short of the 600 floor. Root cause is structural, not a prompt bug: a sparse questionnaire has far less distinct clinical signal than a biomarker panel, so there are fewer well-differentiated ingredients to legitimately justify. Accepted as a reasonable floor for minimally-rated presentations rather than continuing to over-fit the prompt to this specific edge case — revisit if it recurs on more richly-rated SPP submissions (4+ categories), which should have more distinct signal to work with.
- **Prompt cache TTL is 5 minutes.** If more than 5 minutes pass between fires, the cache expires and the next call is a cache write (slightly slower, slightly more expensive). Between sequential fires this is not an issue. The underfill retry's second call benefits from this — it lands well within the TTL of the first call.

### Mock tests
- **Mock tests don't cover the HL7 or questionnaire paths' underfill-retry branch specifically** (only the shared `lib/underfill-retry.ts` helpers are unit-tested, via PDF-path fixtures). All three routes share the same helper functions so behaviour should be identical, but no route-level integration test exists for any of the three paths — consistent with this test file's convention of testing `lib/` modules directly rather than the Next.js routes.

### SPP / questionnaire path
- **Only exercised with naturopath practitioner_type and female/male patients in the four live-fires so far.** No reason to expect practitioner-type filtering to behave differently, but unconfirmed for this specific route.
- **Richer symptom presentations (4+ categories, some severe) reach a healthy fill without issue.** SUB-2026-SPP-MULTI (6 categories, 2 severe) landed at 691/720 (96.0%) after one retry — no special-casing needed beyond what already exists. The underfill problem is specific to sparse (1–3 category) presentations; see "Pod fill" above.

### Cost
- **Each HL7 live-fire:** ~$3 (formulation) + ~$0.20 (citations) = ~$3.20 total.
- **Each PDF live-fire:** ~$3 (formulation) + ~$0.20 (citations) = ~$3.20 total.
- **Prompt caching** would cut formulation cost ~75% on the cached system-prompt + library portion. Not yet implemented.

### Architectural extensions queued
- **HMP panel-class (EndoSCAN)** — still refused. Mark Martin EndoSCAN test on file.
- **Library gaps:** L-carnitine, glycine, vanadium. Revision 16 when added.
- **Persistence, auth, rate limiting** — none.
- **Frontend** — none.
- **Shopify Admin API "My Formulation" upload** — not started.
- **`test_recommendations` schema bucket** — lab-test ordering recommendations (e.g. "iron studies before supplementation") don't fit cleanly in `standalone_recommendations`. Consider `test_recommendations` array in v0.5 schema.
- **Server-side audit log — no query interface yet.** Written to JSONL but no search/lookup tooling built. For regulatory inquiry, requires manual `grep` on `audit.jsonl` by audit_reference or submission_id.

---

## Spend tracking

- Pre-2026-05-13 cumulative: ~$51
- 2026-05-13 session: ~$6 (2 fires)
- 2026-05-14 session: ~$6 (2 fires)
- 2026-05-30 session (HL7/audit/citations/six-step/caching/fill): ~$67
- 2026-05-31 session (HMP/mock tests/polish): ~$20
- 2026-05-31 session (symptom matrix): ~$22
- 2026-05-31 session (frontend validation): ~$3
- 2026-06-01 session (GP panel class): ~$16
- **2026-06-01 session (document download):** no Claude spend
- **Cumulative through 2026-06-01: ~$191**
- *(2026-06-01 third-pass mock-test session and 2026-07-14 pod-ceiling session not logged here — gap in this tracking, not a claim of zero spend.)*
- 2026-07-20 session (underfill retry backstop validation): ~$16 (2 live-fires, each including one automatic retry call + citations; SUB-2026-001 ≈$10.5 with a cache-write retry, SUB-2026-352 ≈$4.7 all-cache-read since it ran within the 5-min TTL of the first)

---

## Quick reference

### Start dev server
```bash
npm run dev
```

### Run mock tests
```bash
npx tsx scripts/test-claude-client-mock.ts
```
59/59 green expected. Covers HL7 path, v0.4.7 `references` field, the v0.6.5 underfill retry helpers, and the v0.6.7 SPP/questionnaire schema + prompt-builder tests.

### Run live-fire — questionnaire path (SPP, no pathology test attached)
```bash
npx tsx scripts/live-test-questionnaire.ts \
  test-fixtures/sample-metadata-spp-mild.json \
  test-fixtures/sample-questionnaire-spp-mild.json
```
Writes to `live-test-output-questionnaire.json`. Other fixture pairs: `sample-metadata-spp-safety-trigger.json` / `sample-questionnaire-spp-safety-trigger.json` (exercises the end-stage-organ-failure hard refusal), `sample-metadata-spp-multipattern.json` / `sample-questionnaire-spp-multipattern.json` (6 categories rated).

### Run live-fire — PDF path (OAT, P000065, FBP)
```bash
npx tsx scripts/live-test.ts \
  test-fixtures/sample-oat.pdf \
  test-fixtures/sample-metadata-oat.json
```
Writes to `live-test-output.json`.

### Run live-fire — PDF path (EndoSCAN, P000066, HMP)
```bash
npx tsx scripts/live-test.ts \
  test-fixtures/sample-endoscan-p000066.pdf \
  test-fixtures/sample-metadata-endoscan-p000066.json
```
Writes to `live-test-output.json`. Generate docs with:
```bash
npx tsx scripts/generate-docs/index.ts ./live-test-output.json ./generated-docs ./test-fixtures/sample-metadata-endoscan-p000066.json
```

### Run live-fire — HL7 path (OAT, P000065)
```bash
npx tsx scripts/live-test-hl7.ts \
  test-fixtures/sample-oat-p000065.hl7 \
  test-fixtures/sample-metadata-oat-p000065.json
```
Writes to `live-test-output-hl7.json`. ~4 min formulation + ~30s citations, ~$3.20.

### Generate documents from PDF live-fire output
```bash
npx tsx scripts/generate-docs/index.ts
```
Reads `live-test-output.json` by default.

### Generate documents from HL7 live-fire output
```bash
npx tsx scripts/generate-docs/index.ts ./live-test-output-hl7.json
```

### Type-check
```bash
npx tsc --noEmit
```

### Inspect last HL7 live-fire
```bash
node -e "
const d = require('./live-test-output-hl7.json');
const out = d.output;
console.log('Patterns:', out.recognised_patterns?.length);
console.log('Ingredients:', out.proposed_formulation?.length);
console.log('Granules:', d.granule_verification?.computed_total_granules, '/ 710');
console.log('Pod fill:', (d.granule_verification?.pod_budget_used * 100).toFixed(1) + '%');
console.log('References:', out.references?.length ?? 0);
console.log('input_source:', d.audit?.input_source);
"
```

### Strategic options for next session

**A — Combined panel support (FBP+HMP or FBP+GP):** Currently refused. Multi-class orchestration design needed.

**D — MP panel class (Advanced Microbiome Mapping):** Fourth panel class. Drives `gastrointestinal` axis.

**E — Shopify Admin API "My Formulation" upload:** Destination integration. Not started.
