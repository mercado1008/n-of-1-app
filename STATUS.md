# Nof1 Precision Formulation — STATUS

**Last updated:** 2026-05-31, end of session — frontend + persistence
**Current versions:** prompt v0.5.8, schema v0.4.7, library revision 15
**Last known state:** Frontend operational at http://localhost:3000. Submission form, results display, and history list all rendering. File-based persistence live — both routes save request + response JSON to data/submissions/{id}/.

---

## What the system does today

A Next.js 14 App Router service accepts functional pathology input and JSON metadata, calls Claude Opus 4.7 with strict tool-use schema enforcement, and returns a structured JSON formulation. Two input paths are operational:

- **`/api/analyse`** — accepts a pathology PDF (multipart/form-data)
- **`/api/analyse-hl7`** — accepts a raw HL7 v2.3.1 ORU^R01 message (text field); biomarkers pre-extracted from 193 NM-type OBX segments, FT narrative excluded from prompt

The route owns granule arithmetic deterministically (710-granule pod ceiling). After successful granule verification, both routes make a second lightweight Claude call to generate one published-study citation per formulation ingredient, then write a JSONL audit log entry to `logs/audit.jsonl`.

A separate document generation pipeline (`scripts/generate-docs/`) reads the JSON output and produces:

1. **Health Analysis (.docx)** — clinical narrative: executive summary, biomarker analysis, diet/lifestyle, formulation logic (with bullet-list included/excluded), contraindications, monitoring, areas of strength, References section with numbered study citations
2. **Recommended Formulation Schedule (.xlsx)** — 5 sheets: Formulation / Dose Adjustments / Standalones / Contraindications / Summary

**Panel classes supported (FBP only):**
- NutriSTAT (primary calibration — PDF path)
- Organic Acids / OAT (PDF and HL7 paths)
- Other FBP panels are interpretable with a `critical_review_required` flag

**Panel classes refused:** HMP, GP, MP, TP, RIP — return `panel_class_not_yet_supported`.

---

## Most recent green live-fire (2026-05-31, Patient P000066 EndoSCAN — symptom matrix v0.5.8)

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

### Formulation construction (locked as of 2026-05-31)
- **Pod ceiling: 710 granules** (route enforces; raised from 700 on 2026-05-30).
- **Six-step procedure:** (1) rank areas, (2) identify foundationals + layers, (3) foundational pass all areas, (4) layer pass cycles until self-estimate reaches 650–680, (5) trim highest-cost ingredient if estimate > 680, (6) verify self-check gate 630–690.
- **Self-check gate: 630 ≤ estimate ≤ 690.** Route adds ~1 gr/ingredient; 690 estimate + 20 ingredients ≈ 710 route-computed.
- **Allocation plan target: 650–670 minimum.**
- **Foundational dose floor:** ≥75% of clinical target (primary + secondary); ≥50% (supportive).
- **Layer dose floor:** ≥50% of clinical target.
- **Catalyst-layer threshold:** ≥1000 granules at foundational-pass total.
- **Target fill zone:** 630–710 granules (route-computed). Sub-630 on a multi-pattern panel is a formulation error.

### Symptom matrix (locked as of 2026-05-31)
- **Input stream 2 is mandatory.** Symptom matrix must be read and used alongside biomarker tables for all NutriPath panels.
- **Form A (Symptom Categories):** category score ≥25% activates corresponding therapeutic axis. Symptom-only axes are supportive priority; biomarker-confirmed axes are primary/secondary.
- **Form B (Symptom Score):** MILD/MODERATE/SEVERE column placement is the severity rating — no per-symptom numeric score.
- **Licorice binding exclusion** fires when "high blood pressure" is MODERATE or SEVERE in symptom matrix, or cardiovascular symptom category ≥30%.
- **High-dose iodine binding exclusion** fires when thyroid symptom category ≥20% AND antibody status unknown on the panel.
- **Executive summary and `biomarker_analysis`** must reference symptom category scores ≥25%.

### Panel classes (as of 2026-05-31)
- **FBP (Functional Biomarker Panel):** NutriSTAT, Organic Acids, Cardiovascular Comprehensive, etc. Full pattern catalogue calibrated against NutriSTAT; OAT panels work but flag `critical_review_required`.
- **HMP (Hormone Metabolism Panel):** EndoSCAN (24h urinary hormones). Full interpretation section added. Other HMP panels (Neurotransmitters Profile) flag `critical_review_required`. Combined FBP+HMP still refused.
- **GP, MP, TP, RIP:** refused with `panel_class_not_yet_supported`.

### Input paths (locked as of 2026-05-30)
- **PDF path (`/api/analyse`):** accepts pathology PDF as document attachment.
- **HL7 path (`/api/analyse-hl7`):** accepts raw HL7 v2.3.1 ORU^R01 text. FT narrative entries excluded from prompt (lab boilerplate). `input_source: 'hl7'` in audit block.
- **Both paths:** identical response shape, audit log, granule verification, citation pass.
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
- **Document download** not yet wired to frontend — use CLI generator scripts for now.

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
- **Run-to-run variance persists.** Even with v0.4.6 fixes, fill can vary (678 in the final run, earlier runs at 549–751). The two root causes are fixed but LLM variance means occasional outliers should be expected. Route hard-rejects anything over 710; under-630 is caught by the self-check.
- **Prompt cache TTL is 5 minutes.** If more than 5 minutes pass between fires, the cache expires and the next call is a cache write (slightly slower, slightly more expensive). Between sequential fires this is not an issue.

### Mock tests
- **21 mock tests don't cover HL7 path, v0.4.7 schema changes, or `references` field.** Should be updated.

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
- **2026-05-31 session (symptom matrix):** ~7 fires × ~$3 + PDF read ~$0.50 = **~$22**
- **Cumulative: ~$172**

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
21/21 green expected. Does not yet cover HL7 path or v0.4.7 schema.

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

**A — Test frontend end-to-end:** Run a live-fire through the submission form, verify results page, verify history list. ~$3.

**B — Document download from frontend:** Wire the document generator into the results page — generate docx/xlsx server-side and provide download links. No Claude spend.

**C — Mock tests for symptom matrix:** Add mock tests for symptom-driven axis activation and binding exclusion logic. No Claude spend.

**D — Combined FBP+HMP panel support:** Currently refused. Multi-class orchestration design needed.

**E — GP panel class (myDNA):** Third panel class. SNP/genotype; modifier-only.

**F — Shopify Admin API "My Formulation" upload:** Destination integration. Not started.
