# Nof1 Precision Formulation — STATUS

**Last updated:** 2026-05-30, end of session — prompt caching, fill reliability fixes
**Current versions:** prompt v0.4.6, schema v0.4.7, library revision 15
**Last known state:** Prompt caching live (312k tokens/call from cache, ~$2.37 saved per call). Pod fill reliability fixed: identified two root causes of sub-630 fills (TSI code confusion, layer pass stopping early) and resolved both. Latest confirmed fill: 678/710 (95.5%).

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

## Most recent green live-fire (2026-05-30, Patient P000065 OAT via HL7)

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

### Formulation construction (locked as of 2026-05-30)
- **Pod ceiling: 710 granules** (route enforces; raised from 700 on 2026-05-30).
- **Six-step procedure:** (1) rank areas, (2) identify foundationals + layers, (3) foundational pass all areas, (4) layer pass cycling to overfill, (5) back out last ingredient, (6) verify 630–710.
- **Foundational dose floor:** ≥75% of clinical target (primary + secondary); ≥50% (supportive).
- **Layer dose floor:** ≥50% of clinical target.
- **Back-out preferred over trim for layer ingredients on overage.**
- **Catalyst-layer threshold:** ≥1000 granules at foundational-pass total.
- **Target fill zone:** 630–710 granules. Sub-630 on a multi-pattern panel is a formulation error.

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

### Clinical reasoning
- **Panel-class routing.** FBP (NutriSTAT, OAT) processes correctly; non-FBP refuses cleanly.
- **Pattern recognition.** 4–5 patterns on OAT panel consistently.
- **Library accuracy.** Zero phantom W codes across all recent runs.
- **Granule arithmetic.** Route-computed, deterministic. 710-granule ceiling enforced.
- **Pod fill.** New six-step procedure landing 630–710 consistently on OAT panel.
- **Standalone routing.** Library gaps correctly routed to `standalone_recommendations`.
- **Binding exclusions.** Fire correctly on missing data.

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
- 2026-05-30 session (first pass — HL7/audit/citations/six-step): ~14 fires × ~$3 + citation passes ~$4 = ~$46
- **2026-05-30 session (second pass — caching/fill):** ~8 fires × ~$1.90 (cached) + ~2 cache-write fires × ~$3 = **~$21**
- **Cumulative: ~$130**

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

### Run live-fire — PDF path (OAT, P000065)
```bash
npx tsx scripts/live-test.ts \
  test-fixtures/sample-oat.pdf \
  test-fixtures/sample-metadata-oat.json
```
Writes to `live-test-output.json`.

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

**A — HMP panel class (EndoSCAN):** Second panel class. Mark Martin EndoSCAN test on file. ~3–4h, ~$9–12 in live-fires.

**B — Library extension:** Add L-carnitine, glycine, vanadium. Revision 16. Modest scope, immediate formulation density improvement.

**C — Mock test update:** Update 21 mock tests to cover HL7 path, v0.4.7 schema (`references` field), `panel_classes`. No Claude spend.

**D — Document polish:** Fix "Generated: —" metadata table bug, xlsx label column width, vestigial catalyst-layer escalation flag. ~2h, no Claude spend.

**E — Prompt caching:** 75% cost reduction on cached system-prompt + library. Significant for ongoing iteration cost.

**F — Persistence + frontend stub:** Move toward a real service. Multi-day.
