# CLAUDE.md — Nof1 Precision Formulation

This file is read by Claude Code at the start of every session. It captures the architecture, locked design decisions, and conventions you need to operate effectively in this project.

If a session needs more context than this provides, read `STATUS.md` in the project root — it's the running log of where the project is at right now and what's open.

---

## What this project does

Nof1 Precision Formulation is a decision-support system for practitioners ordering functional pathology tests. The practitioner submits a PDF lab report and patient metadata; the system returns a structured JSON formulation of dietary supplement ingredients (granule-pod format) along with two practitioner-facing documents:

1. **Health Analysis (.docx)** — clinical narrative across 7 sections
2. **Recommended Formulation Schedule (.xlsx)** — 5-sheet structured data

The granule pod is compounded by a separately-licensed pharmacy on the practitioner's order. The practitioner is the prescribing clinician of record; this system produces drafts pending practitioner review.

---

## Stack

- **Runtime:** Node.js 18+, TypeScript, Next.js 14 (App Router)
- **AI:** `@anthropic-ai/sdk` calling Claude Opus 4.7 with strict tool-use schema enforcement
- **Schema validation:** Zod v4
- **Document generation:** `docx` (npm package, docx-js) for .docx, `exceljs` for .xlsx
- **Persistence:** none yet (in-memory dev only); audit log written to `logs/audit.jsonl`
- **Frontend:** none yet (`scripts/live-test.ts` and `scripts/live-test-hl7.ts` are the only invokers)
- **Auth:** none yet
- **Page size convention:** A4 portrait (Australian default)

---

## Repository structure

```
~/n-of-1-app/
├── app/api/
│   ├── analyse/route.ts              # PDF input endpoint
│   └── analyse-hl7/route.ts          # HL7 v2.3.1 input endpoint
├── lib/                              # Core server-side modules
│   ├── claude-client.ts              # Anthropic SDK wrapper; callClaudeForAnalysis (PDF) + callClaudeForAnalysisFromText (HL7)
│   ├── build-prompt.ts               # buildUserPrompt (PDF) + buildHL7UserPrompt (HL7), audit block
│   ├── request-schema.ts             # Zod schemas for incoming requests
│   ├── granule-calc.ts               # Deterministic granule arithmetic (710-granule ceiling)
│   ├── audit-ref.ts                  # computeAuditReference — shared between routes and generator
│   ├── audit-log.ts                  # appendAuditLog → logs/audit.jsonl
│   ├── generate-citations.ts         # Second-pass Claude call: one study citation per ingredient
│   ├── hl7-parser.ts                 # Raw HL7 v2 text → HL7Segment[]
│   └── hl7-adapter.ts                # HL7Segment[] → ParsedHL7Message (BiomarkerFinding[])
├── prompts/
│   ├── system-prompt.md              # The clinical reasoning prompt (v0.4.5)
│   ├── output-schema.ts              # Zod schemas for Claude's tool-use output (v0.4.7)
│   └── prompt-version.json           # Version manifest (skill/prompt/schema/library)
├── data/library-built/
│   └── ingredients-library.json      # 107 ingredients, W codes, dose-per-granule data
├── logs/
│   └── audit.jsonl                   # Per-submission audit log (gitignored)
├── scripts/
│   ├── live-test.ts                  # CLI: PDF path against /api/analyse
│   ├── live-test-hl7.ts              # CLI: HL7 path against /api/analyse-hl7
│   ├── test-claude-client-mock.ts    # 21 unit tests against the Claude client
│   └── generate-docs/                # docx + xlsx generators
│       ├── brand.ts                  # Colour palette, fonts, dimensions, brand strings
│       ├── types.ts                  # TypeScript interfaces mirroring JSON output
│       ├── health-analysis.ts        # docx generator (sections 1–7 + References)
│       ├── formulation-schedule.ts   # xlsx generator (5 sheets)
│       └── index.ts                  # Orchestrator: reads JSON, runs both generators
├── assets/brand/
│   └── nof1_header_band.png          # Pre-composited Forest-green header band
├── test-fixtures/                    # Sample inputs (see "Test fixtures" below)
├── generated-docs/                   # Output directory for generated documents
├── STATUS.md                         # Current project state (READ FIRST in new sessions)
└── CLAUDE.md                         # This file
```

---

## Locked design decisions (do not re-debate)

### Architecture
- **Route owns granule arithmetic, not Claude.** Claude proposes doses; the route computes granules deterministically and enforces the 710-granule pod ceiling. Do not change.
- **Schema is the structural floor; prompt carries clinical-routing policy.** Clinical rules go in the prompt, not the schema, unless they're true structural invariants.
- **Panel-class architecture is extensibility-locked.** Schema supports FBP/HMP/GP/MP/TP/RIP enum; currently only FBP is fully implemented. Other classes return `panel_class_not_yet_supported`. Do not refuse on unknown classes — extend instead.
- **`panel_classes` is a required field on every request.** Not inferred from `test_type`.
- **Two input paths:** `/api/analyse` (PDF) and `/api/analyse-hl7` (HL7 v2.3.1). Identical response shape. HL7 FT narrative excluded from prompt (lab boilerplate).
- **Two-pass citation generation:** formulation call first; citation call second after granule verification. Failure in citation pass never blocks the formulation response.
- **Server-side audit log:** `logs/audit.jsonl`, one JSON line per submission, written by both routes. Gitignored. `lib/audit-ref.ts` computes the shared Audit Reference.

### Clinical routing rules
- **Therapeutic categories:** 14 + `other`. Enum is locked.
- **`gastrointestinal`:** single bucket. Don't subdivide.
- **Selenium:** BINDING EXCLUSION when red-cell Se ≥90% upper reference.
- **Copper:** BINDING EXCLUSION when Cu:Zn>1.50 OR plasma upper third OR %free>25%. Low zinc does NOT override.
- **OAT is FBP-class.** Don't route to HMP/MP even though it has methylation/metabolic markers.

### Formulation construction (the six-step procedure — v0.4.5)
1. **Rank** therapeutic areas by priority (primary / secondary / supportive)
2. **Identify** the foundational ingredient and ordered layer ingredients for each area
3. **Foundational pass:** place one foundational per area in priority order — ALL areas before any layers. Primary + secondary foundationals at ≥75%; supportive at ≥50%.
4. **Layer pass:** cycle through areas in priority order, adding one layer ingredient per area per cycle at ≥50%, until the running total exceeds 710. Do not stop early.
5. **Back out the last ingredient** that caused the overage — entirely, no trimming. Record in `excluded_from_pod`.
6. **Verify:** compute the sum; confirm 630–710. Write sum in `compliance_self_check.notes`.
- **Pod ceiling: 710 granules** (route enforces). Target fill zone: 630–710.
- **Catalyst-layer threshold:** ≥1000 granules at the foundational-pass total.

### Document conventions
- **Page size:** A4 portrait. Australian default.
- **Brand colours:** White, Black, Gold `#C3AF88`, Forest `#535B50`, Sage Green `#A7B7A5`, Cloud `#E2E0D9`. Defined in `scripts/generate-docs/brand.ts`.
- **Fonts:** Roboto Medium (headings) / Roboto Regular (body), with Arial fallback.
- **Filename pattern:** `Nof1_HealthAnalysis_{submission_id}_DRAFT.docx` and `Nof1_FormulationSchedule_{submission_id}_DRAFT.xlsx`.
- **TSI codes (W codes):** xlsx only, never docx. Labelled "W Code" not "TSI Code".
- **No AI/model identifier in any practitioner-facing document.** Opaque Audit Reference (`XXXX-XXXX-XXXX`) only.
- **Brand band:** pre-composited PNG at `assets/brand/nof1_header_band.png`.
- **References section:** numbered list of study citations at end of docx, populated from `output.references` (two-pass citation call). Format: `"First Author et al. (Year). Title. Journal."` No PMIDs/DOIs.

### Categorisation
- **Internal taxonomy never appears in client-facing output.** Snake_case codes humanised via `CATEGORY_DISPLAY_NAMES` in `formulation-schedule.ts`.

---

## Coding conventions

### TypeScript
- Strict mode on. `npx tsc --noEmit` must pass before any commit.
- Prefer `?? '—'` for optional-field display fallbacks (em-dash glyph).
- Defensive optional access: every field in the AnalysisOutput types is `?: ` because Claude's output can vary across schema versions.
- `as any` casts are acceptable in generator code where Claude's output structure is more permissive than the strict types — but document with a comment why.

### File naming
- `kebab-case.ts` for files
- `camelCase` for functions and variables
- `PascalCase` for types, interfaces, classes, and Zod schemas

### Testing
- Mock tests in `scripts/test-claude-client-mock.ts` — 21 tests, no Claude spend
- Live-fires via `scripts/live-test.ts` — ~$3 per fire, ~4 min
- Always run type-check before live-fire. Saves $3 on a typo.

### Commits and git
- This is a solo developer project; commit hygiene is light
- Avoid committing `live-test-output.json` (it's a per-fire artifact)
- `generated-docs/` is per-fire output — currently committed for reference but should probably be gitignored in production setup

---

## How to do common tasks

### Run a live-fire — PDF path (OAT panel)
```bash
npx tsx scripts/live-test.ts \
  test-fixtures/sample-oat.pdf \
  test-fixtures/sample-metadata-oat.json
```
~4 min, ~$3.20 (formulation + citations), writes full response to `live-test-output.json`.

### Run a live-fire — HL7 path (OAT panel)
```bash
npx tsx scripts/live-test-hl7.ts \
  test-fixtures/sample-oat-p000065.hl7 \
  test-fixtures/sample-metadata-oat-p000065.json
```
~4 min, ~$3.20 (formulation + citations), writes full response to `live-test-output-hl7.json`.

### Regenerate both documents from the latest PDF live-fire
```bash
npx tsx scripts/generate-docs/index.ts
```
No Claude spend. Reads `live-test-output.json`. Writes to `generated-docs/`.

### Regenerate both documents from the latest HL7 live-fire
```bash
npx tsx scripts/generate-docs/index.ts ./live-test-output-hl7.json
```

### Run the type-check
```bash
npx tsc --noEmit
```
Silent pass is good.

### Run the mock tests
```bash
npx tsx scripts/test-claude-client-mock.ts
```
21/21 green expected.

### Inspect the latest live-fire programmatically
```bash
node -e "
const d = require('./live-test-output.json');
const out = d.output;
console.log('Patterns:', out.recognised_patterns?.length);
console.log('Ingredients:', out.proposed_formulation?.length);
console.log('Granules:', d.granule_verification?.computed_total_granules);
console.log('Pod fill:', (d.granule_verification?.pod_budget_used * 100).toFixed(1) + '%');
"
```

---

## Test fixtures

Two test patients available for OAT panel:

**P000060** (PT-2026-002, SUB-2026-002) — original calibration patient.
- `test-fixtures/sample-oat-p000060.pdf`
- `test-fixtures/sample-metadata-oat-p000060.json`

**P000065** (PT-2026-003, SUB-2026-003) — current default. Available in both PDF and HL7 formats.
- `test-fixtures/sample-oat-p000065.pdf`
- `test-fixtures/sample-metadata-oat-p000065.json`
- `test-fixtures/sample-oat-p000065.hl7` (80KB, HL7 v2.3.1 ORU^R01 from NutriPath — 193 NM + 141 FT OBX rows)

The default `sample-oat.pdf` / `sample-metadata-oat.json` and `sample-oat-p000065.hl7` / `sample-metadata-oat-p000065.json` both point to P000065.

**Hygiene rule:** new patient = new pseudonym + new submission_id. Never reuse identifiers across different patients.

---

## Known issues (queue for fix)

- **Duplicate-emission bug:** Claude occasionally duplicates `excluded_from_pod` items into `standalone_recommendations`. Partially fixed by v0.3.7 prompt; still seen occasionally. If it recurs, add explicit self-check rule.
- **Page 1 metadata table shows "Generated: —"** on docx. Reads from Claude's narrow `audit_metadata.generated_at_iso`; should fall through to `routeAudit.generated_at_iso` in `buildMetadataTable()`.
- **xlsx Summary truncates long category labels** in print preview. Widen the label column from 36 to 44+.
- **Mock tests don't cover HL7 path, v0.4.7 schema, or `references` field.** Should be updated.
- **"Catalyst-layer pod strategy" vestigial flag.** Appears in escalation flags occasionally despite healthy pod fill. Worth cleaning up next prompt revision.
- **Run-to-run variance is real.** Ingredient counts can vary by 3–5 and pod fill by 5–10 percentage points between runs on identical input. LLM property, not a bug. Don't assume single-run equality when comparing PDF vs HL7 paths.

---

## Architectural extensions queued

In rough order of priority:

1. **HMP panel-class support via EndoSCAN** (~3-4 hours, ~$9-12 in live-fires) — second panel class. Mark Martin EndoSCAN test on file. Demonstrates panel-class extensibility.
2. **Library extension** — add L-carnitine, glycine, possibly vanadium. Bumps library_revision to 16.
3. **Mock test update** — cover HL7 path, v0.4.7 schema (`references`), updated pod ceiling. No Claude spend.
4. **Prompt caching** — 75% cost reduction on cached system-prompt + library. Significant for iteration cost.
5. **Production plumbing** — persistence, frontend, auth, rate limiting. Multi-day.
6. **Shopify Admin API "My Formulation" upload** — destination integration. Not started.

**Complete:**
- ✓ Server-side audit log (`logs/audit.jsonl`, both routes)
- ✓ HL7 input adapter (`/api/analyse-hl7`, confirmed with P000065 NutriPath file)
- ✓ Two-pass citation generation (study references in docx References section)

---

## Regulatory posture (Australia)

Current target market is AU. The system is positioned as:
- **Decision-support software for licensed practitioners**, not a medical device
- **Patient data is anonymised** (pseudonym only); no PHI in requests
- **The practitioner is the prescribing clinician of record**
- **The granule pod is a dietary supplement** dispensed by a separately-licensed compounding pharmacy
- **No diagnostic claims** — output uses hedged language ("per published literature", "for practitioner consideration", "pattern consistent with")

For US use, the same architecture is substantively well-positioned with minor hardening (practitioner credential validation, slightly heavier practitioner-accountability language). Detailed analysis in earlier chat session — not a blocker for development.

---

## How to interact with this project

When picking up a new task:

1. **Read STATUS.md first.** It's the running log of where things are right now. CLAUDE.md (this file) is for architecture and conventions; STATUS.md is for current state.
2. **Check `prompts/prompt-version.json`** for current versions of system_prompt, schema, library.
3. **Type-check before doing anything destructive.** `npx tsc --noEmit`.
4. **Don't run live-fires speculatively.** Each one costs ~$3. Verify with mock tests and type-checks first.

When making changes:

1. **Schema changes require version bumps** in `prompts/prompt-version.json` AND the corresponding header comment in `prompts/output-schema.ts`.
2. **Prompt changes require version bumps** in `prompts/prompt-version.json` AND the header comment in `prompts/system-prompt.md`.
3. **Generator changes don't require version bumps** — they're rendering-layer only.
4. **Library changes require revision bumps** in `data/library-built/ingredients-library.json` metadata AND `prompts/prompt-version.json`.

When something feels wrong:

1. **Re-read STATUS.md.** The issue may already be known.
2. **Check the audit metadata of the most recent live-fire** for version mismatches between Claude's view and yours.
3. **Run the mock tests.** They cover the structural invariants and catch many regressions.

---

## Things this project deliberately doesn't have

So you don't go looking for them or build them by accident:

- No HIPAA compliance work — handled by the practitioner who holds patient identity
- No payment processing — handled by Shopify, not in scope here
- No prescription generation — the document is decision-support, not a prescription
- No medical device classification work — system is positioned as software, not a device
- No frontend yet — live-test.ts is the only invocation surface
- No user accounts or auth — dev only currently
- No persistence — every request is independent
