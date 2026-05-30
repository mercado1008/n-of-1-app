# Phase 3 — Completion Summary

**Status:** Complete. Live-fire passed end-to-end against a real NutriSTAT
PDF on Claude Opus 4.7.

**Date completed:** 2026-05-05

**Predecessor:** Phase 2 — system prompt v0.2.0 + output schema v0.2.0
(see `docs/phase-2-testing.md`).

---

## What Phase 3 delivers

A Next.js App Router POST route at `/api/analyse` that:

1. Accepts `multipart/form-data` with three fields: `pdf` (the pathology
   test report), `metadata` (a JSON-encoded practitioner + patient + test
   block), and `clinical_notes` (optional free text).
2. Validates the request: PDF size and MIME type, metadata against
   `RequestMetadataSchema`, patient age ≥ 18, supported test type,
   recognised practitioner type.
3. Loads the v0.2.0 system prompt and the built ingredients library, and
   assembles a single combined system prompt.
4. Calls Claude Opus 4.7 (`claude-opus-4-7`) with a single forced tool
   (`submit_analysis`), sending the PDF as a base64 `document` content
   block.
5. Validates the returned tool input against `ClaudeToolInputSchema`,
   then re-validates the unwrapped output against `ClaudeOutputSchema`.
6. Returns `{ ok, output, audit, usage, stop_reason }` to the caller.
   Refusal is a 200, not an error.

No frontend, no Shopify, no document generation. Those are Phase 4+.

## Live-fire verification — what we actually saw

Submission ID `SUB-2026-001`, NutriSTAT, 42-year-old female, naturopath
practitioner, 13.7 MB PDF.

| Metric | Value |
| --- | --- |
| HTTP status | 200 OK |
| Round-trip time | 207 seconds |
| Output type | `formulation` |
| Stop reason | `tool_use` (clean — not truncation) |
| Input tokens | 304,527 |
| Output tokens | 14,396 |
| Ingredients proposed | 8 |
| Contraindication flags | 12 |
| Escalation flags raised | 2 (`renal_function_eGFR_67_monitor`, `selenium_red_cell_upper_portion_caution`) |
| `s4_ingredients_excluded_count` | 0 (naturopath scope filter applied) |
| Critical review required | No |
| Library revision | 15 (correct) |
| All 8 TSI codes valid | Yes (`^[A-Z]\d{9}$` regex pass) |
| `compliance_self_check` populated | Yes |

The full output was captured to `live-test-output.json` for diff-testing
future schema or prompt changes against.

### Qualitative observations from the live output

- **Hedging discipline held under live conditions.** The headline used
  "may inform practitioner consideration", third-person framing
  throughout, no diagnostic or causal language. Phase 2 testing flagged
  this as the highest-risk discipline and it survived contact with reality.
- **Clinical notes were used.** The headline explicitly references "as
  requested in the clinical notes" — Claude read both the PDF and the
  notes block and integrated them.
- **Real biomarker reading.** Escalation flag `renal_function_eGFR_67_monitor`
  was triggered by a specific value in the PDF (eGFR 67), confirming
  Claude is reading lab values out of the visual PDF structure, not just
  pattern-matching.
- **Scope filtering worked.** Output was filtered to ingredients available
  to a naturopath; `s4_ingredients_excluded_count: 0` indicates no
  Schedule 4 items were proposed and removed (because none were
  candidates for this patient profile in the first place).

## Schema enforcement: Option A (forced tool use, no `strict: true`)

This was the single most important architectural decision in Phase 3.

### What we do

- `tool_choice: { type: 'tool', name: 'submit_analysis' }` forces Claude
  to call exactly one tool. There is no free-text response path.
- The Zod wrapper schema (`ClaudeToolInputSchema`) is compiled to JSON
  Schema via Zod v4's native `z.toJSONSchema()` and sent as the tool's
  `input_schema`. Without `strict: true`, this is a hint to the model,
  not a grammar constraint.
- Every response is fully validated against the v0.2.0 schema including
  `.passthrough()`, regex patterns, length bounds, and the `not_*`
  sentinel.

### Why we don't use `strict: true`

`strict: true` (Anthropic's November-2025 grammar-constrained sampling
feature) is incompatible with the v0.2.0 schema in three ways:

1. **`additionalProperties: false` requirement.** Strict mode requires
   it at every object level. The v0.2.0 schema uses `.passthrough()`
   deliberately — Phase 2 found that Claude produces thoughtful field
   variations (four spellings of `third_person_framing*` in
   `compliance_self_check`, etc.) and rejecting them caused brittle
   failures.
2. **No support for `minLength`/`maxLength`/`minimum`/`maximum`/`pattern`.**
   The schema uses all four. The TSI regex (`^[A-Z]\d{9}$`),
   `HedgedClinicalText` length bounds, and the `library_revision` union
   would all be silently dropped.
3. **Production stability with complex schemas.** SDK issue #885
   documents `strict: true` returning 500 errors on schemas with the
   shape of the v0.2.0 formulation output.

The live-fire result (clean structured output, all 8 TSI codes valid,
compliance language disciplined) confirms forced tool use without strict
mode is sufficient for this workload.

## Other key design decisions

### Wrapper schema for the tool input

Anthropic's tool `input_schema` rejects `anyOf` / `oneOf` / `allOf` at
the top level. The v0.2.0 `ClaudeOutputSchema` is a discriminated union,
which compiles to `oneOf` at the root. Fix is structural — wrap the
union in an object with a single `result` property:

```ts
export const ClaudeToolInputSchema = z.object({
  result: ClaudeOutputSchema,
});
```

The route unwraps `tool_use.input.result` and returns a bare
`ClaudeOutput` to the caller, so the public API contract is unchanged.

### PDF as a `document` content block, not extracted text

We pass the raw PDF base64-encoded as a `{ type: 'document', source: ... }`
block. Claude Opus 4.7 reads PDFs natively, including tables and
multi-column layouts. The live-fire confirmed this works — Claude
correctly extracted eGFR 67 from the visually-structured biomarker grid.
We do not pre-extract text.

### Refusal is a first-class output, not an error

`output_type` discriminates between `formulation` and `refusal`. The
route returns refusals as HTTP 200 with `output.output_type === 'refusal'`.
Phase 2 verified this logic across three refusal scenarios; Phase 3 did
not exercise it live (live-fire used a valid adult patient with a
supported test type), so the refusal path is mock-tested only at this
stage. Worth a second live-fire targeting one of the refusal triggers
before Phase 4.

### Errors map to distinct HTTP status codes

| Code | Cause |
| --- | --- |
| 400 | Malformed multipart, missing field, metadata fails Zod, PDF too large/wrong MIME, patient under 18 |
| 500 | `ANTHROPIC_API_KEY` not set, system prompt or library file unreadable |
| 502 | Anthropic API call failed, or schema-violating output |

Each error includes a `code` and structured detail (Zod issues,
`stop_reason`, raw tool input).

### Audit block built before the Claude call

Audit metadata (submission ID, timestamp, PDF SHA-256, versions, model,
draft statement) is constructed before the API call so it's available
even on failure paths. Phase 4 should write it to a durable store before
the response returns.

## Mock test coverage

`scripts/test-claude-client-mock.ts` — 8 tests, all passing. Injects a
fake Anthropic client to exercise the parsing/validation pipeline
without an API key. Verifies:

1. Valid formulation parses to typed `ClaudeOutput`.
2. Valid refusal parses to typed `ClaudeOutput`.
3. The `not_*` `library_revision` sentinel is accepted on refusal.
4. Malformed TSI codes (regex violation) are rejected with a Zod issue
   on the `tsi_code` path.
5. `.passthrough()` preserves unknown fields.
6. Response with no `tool_use` block raises `ClaudeOutputShapeError`.
7. `tool_use` block with the wrong tool name is rejected.
8. Unwrapped tool input (missing the `result` envelope) is rejected.

Run with `npx tsx scripts/test-claude-client-mock.ts`.

## Files produced

| Path | Purpose |
| --- | --- |
| `app/api/analyse/route.ts` | The POST handler |
| `lib/claude-client.ts` | Anthropic SDK wrapper, schema build, validation |
| `lib/build-prompt.ts` | System prompt + library + audit assembly |
| `lib/request-schema.ts` | Multipart field validation |
| `prompts/output-schema.ts` | v0.2.0 schema + Phase 3 wrapper |
| `scripts/test-claude-client-mock.ts` | 8-test mock harness |
| `scripts/live-test.ts` | Real-PDF harness for live-fire |
| `test-fixtures/sample-metadata.json` | Sample metadata input |
| `test-fixtures/sample-notes.txt` | Sample clinical notes input |

## Debugging journey — what actually happened during install

The install path from "Phase 3 code is written" to "live-fire green"
took longer than expected and produced a useful set of lessons for
Phase 4 onward. In rough order:

1. **`@/...` path alias unresolved.** The `tsconfig.json` from
   `create-next-app` had `"@/*": ["./src/*"]`, but the project structure
   was at the root, not in `src/`. Fix: change to `"@/*": ["./*"]` and
   add `"baseUrl": "."`.
2. **Missing dependency.** `zod-to-json-schema` wasn't installed (the
   README's `npm install` step had been deferred). Fix: install it.
3. **PDF size cap (10 MB) tripped by 13.7 MB sample.** Fix: bump
   `MAX_PDF_BYTES` to 25 MB. (PDFs this large are also worth shrinking
   for cost reasons — see deferred items.)
4. **`zod-to-json-schema` v3.x silently produced `{}` against Zod v4.**
   This was the hardest one to diagnose. The project uses Zod v4 (pulled
   in transitively by `@anthropic-ai/sdk@0.93.0`); `zod-to-json-schema`
   only supports Zod v3. The library returned an empty object instead of
   throwing, which produced a misleading "top-level type undefined"
   error. Fix: drop `zod-to-json-schema` entirely; use Zod v4's native
   `z.toJSONSchema()` instead. This is the better long-term shape — one
   fewer dependency, and the API is officially supported.
5. **`max_tokens: 8192` truncated the response.** Claude got partway
   through the formulation and was cut off; the partial JSON tool input
   parsed as `{}`. The first error message ("expected object at .result")
   pointed at the wrong cause (looked like a wrapper issue). Surfacing
   `stop_reason` in the error confirmed truncation, and bumping to
   16384 fixed it.
6. **Two file-edit goofs along the way** (duplicate class definition
   after a botched paste, and an unused-but-deleted import error). Both
   fixed by sending a complete file rewrite instead of patches.

The resilience-relevant fixes that should persist into Phase 4:

- **Pin Zod version explicitly.** Add `zod: 4.x` to `package.json`
  rather than relying on transitive resolution.
- **Surface `stop_reason` in every error response.** It's the single
  most useful diagnostic field and was missing from the original Phase 3
  shape-error response.
- **Default to `max_tokens: 16384`** (or higher) for any pipeline
  involving large documents. 8192 is too low for full formulation
  output.
- **Write detailed error responses to disk** (the
  `live-test-error-detail.json` pattern). Saved hours.

## Cost analysis

Live-fire used 304,527 input tokens and 14,396 output tokens. At Opus 4.7
list pricing ($5/M input, $25/M output):

| Item | Tokens | Rate | Cost |
| --- | ---: | ---: | ---: |
| Input | 304,527 | $5/M | $1.5226 |
| Output | 14,396 | $25/M | $0.3599 |
| **Total per submission** | | | **$1.88** |

Per 1,000 submissions: **~$1,883**.

### Where the cost actually goes

The non-obvious finding from this single live-fire: input cost is
dominated by the PDF, not the system prompt or the library. Rough
breakdown of the ~305k input tokens:

- PDF (13.7 MB pathology report, native document block): **~270k tokens**
- System prompt + library (107 ingredients) + clinical notes + metadata: **~30k tokens**
- Tool definition + scaffolding: small remainder

Output (14.4k tokens) is the formulation itself — 8 ingredients, 12
contraindication flags, biomarker analysis, executive summary, audit
metadata, compliance self-check.

### Cost levers, ranked by impact for this workload

1. **Compress the PDF before uploading.** A 13.7 MB pathology report
   compressed to 2-3 MB without quality loss would cut input tokens by
   roughly 80%, taking per-call cost from $1.88 to roughly $0.50. This
   is the single biggest lever and should happen upstream of the API
   call. macOS Preview's Quartz Filter does this in seconds; a
   server-side equivalent (Ghostscript, pdfcpu) is straightforward.
2. **Batch API for non-realtime workloads.** 50% off everything
   (input, output, cache reads). For nightly evaluation runs,
   reformulation backfills, or any minutes-to-hours SLA, this halves
   the bill. Per-call standard $1.88 → batch $0.94. Doesn't help
   real-time practitioner submissions.
3. **Prompt caching.** With ~30k tokens of system prompt + library
   that's stable across calls, caching saves ~$0.13 per call (about 7%)
   under default pricing. Implementation cost is small (one
   `cache_control` block on the system prompt + library), but the
   savings are smaller than you'd expect because the PDF dominates
   input cost. If we shrink the PDF first (lever 1), prompt caching's
   relative impact grows considerably — at a 2 MB PDF, system prompt
   caching saves ~25-30%.

### Combined optimisations

If we did all three (compress PDF to 2 MB, prompt caching active, Batch
API for non-realtime calls): per-call cost approximately **$0.20**.
Per 1,000 submissions approximately **$200**. Roughly a 9× reduction
versus current naive usage.

### Practical implication

For early Phase 4 work — the route is exposed to a small handful of
practitioners and traffic is low — current cost is acceptable as-is.
At ~10 submissions per day per practitioner across a small pilot, this
is single-digit dollars per day per practitioner. The optimisation
investment should be sequenced: PDF compression first (genuinely
valuable, cheap to implement), prompt caching second (worthwhile once
PDF compression is in place), Batch API third (only relevant once
there are non-realtime workloads to route through it).

## How to re-run the live-fire

Useful to capture this concretely for future-you, since the install path
to get here was non-trivial.

### Prerequisites

- Dev server running: `npm run dev` in one terminal, wait for
  `✓ Ready in ...ms`.
- Valid `ANTHROPIC_API_KEY` in `.env.local`. Confirm with
  `grep ANTHROPIC_API_KEY .env.local`.
- A real pathology PDF placed at a known path. For repeatability,
  keep it in `test-fixtures/`.
- A metadata JSON file matching the patient/practitioner the PDF
  represents. `test-fixtures/sample-metadata.json` is the template.
- (Optional) clinical notes file. `test-fixtures/sample-notes.txt`.

### Run

In a second terminal:

```bash
npx tsx scripts/live-test.ts \
  ./test-fixtures/sample-nutristat.pdf \
  ./test-fixtures/sample-metadata.json \
  ./test-fixtures/sample-notes.txt
```

Expect a 60–210 second wait depending on PDF size. The script prints
`Calling Claude — this typically takes 30–90 seconds...` while it
waits.

### What success looks like

```
HTTP 200 OK (~200000ms)
Output type:        formulation
Stop reason:        tool_use
Tokens (in/out):    ~300000 / ~14000
--- Formulation summary ---
Headline:           ...
Ingredients:        N
  - <TSI code> <name> <dose><unit> (<priority>)
  ...
Contraindication flags: N
Critical review:    no
Library revision:   15
Escalation flags:   [...]
s4 excluded count:  0
```

Full structured output written to `./live-test-output.json`. Diff
against previous runs to check for regressions on the same PDF.

### What failure looks like

The route maps every failure mode to a structured JSON error response.
The script prints the error and writes the full detail to
`./live-test-error-detail.json` if present.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `HTTP 502, code: claude_output_shape_error`, body `{}`, `stop_reason: max_tokens` | Output truncated by `MAX_TOKENS` cap | Increase `MAX_TOKENS` in `lib/claude-client.ts` |
| `HTTP 502, code: claude_output_shape_error`, populated body, Zod issues on specific fields | Real schema-vs-prompt drift | Read the Zod issues; decide whether the schema or the system prompt should change |
| `HTTP 502, code: claude_upstream_error, status: 529` | Anthropic capacity / overloaded | Retry. Transient. |
| `HTTP 502, code: claude_upstream_error, status: 401` | API key invalid or expired | Check `.env.local` |
| `HTTP 400, code: bad_request`, message about PDF size | PDF exceeds `MAX_PDF_BYTES` (25 MB) | Compress the PDF, or bump the cap if it's a legitimate large file |
| `HTTP 400, code: bad_request`, message about metadata | Metadata JSON failed Zod validation | Read the issue list — usually a missing or wrong-typed field |
| `HTTP 500, response is HTML` | Next.js compile error before the route runs | Check Terminal A (the `npm run dev` window) for the actual stack trace |

### Sanity checks before each run

If the project has been idle for a while, two quick checks save time:

```bash
# Mock tests still passing?
npx tsx scripts/test-claude-client-mock.ts

# Typecheck clean?
npx tsc --noEmit
```

Both should be silent / 8/8 pass. Anything else means something has
drifted.

## Versions in scope

- Skill version: 1.0
- System prompt version: 0.2.0 (Phase 2)
- Output schema version: 0.2.0 (Phase 2, with Phase 3 wrapper added)
- Library revision: 15 (2026-03-02)
- Phase: 3
- Schema enforcement: Forced tool use without strict mode (Option A)
- Zod version: 4.x (uses `z.toJSONSchema()` native)
- Anthropic SDK: 0.93.0
- Model: `claude-opus-4-7`
- `MAX_TOKENS`: 16384
- `MAX_PDF_BYTES`: 25 MB

## Deferred to Phase 4 or later

In rough priority order:

- **Live-fire across more test types.** Phase 3 verified NutriSTAT
  only. Run the harness against EndoSCAN, Comprehensive Stool Analysis,
  Advanced Thyroid, etc. before exposing the route to real practitioner
  traffic.
- **Live-fire of the refusal path.** Build a metadata fixture that
  triggers a refusal (e.g. minor patient, contradictory test type) and
  confirm the discriminated-union refusal arm works end-to-end.
- **Document generation.** Word health-analysis + Excel formulation
  schedule. The structured output contains everything needed to drive
  both — `executive_summary`, `biomarker_analysis`, `proposed_formulation`
  are sized for direct template injection.
- **Auth + rate limiting.** The route is currently open. Required
  before any other practitioner can hit the URL.
- **Persistence.** Write the audit block + structured output to a
  durable store (Postgres, S3, or both) before the response returns.
- **Prompt caching.** With ~107 ingredients in the library and a stable
  v0.2.0 system prompt, both are excellent candidates for `cache_control`
  blocks. At 304k input tokens per call, caching could cut input cost
  by ~90% on repeat calls within a 5-minute window.
- **PDF compression upstream.** A 13.7 MB pathology PDF that compresses
  to 2 MB without quality loss represents a meaningful token reduction.
  Worth a pre-processing step (Quartz Filter on macOS, or a server-side
  step in production).
- **Streaming response.** Currently the route waits for the full
  response. Streaming would improve perceived latency for the eventual
  frontend.
- **Strict-compatible schema variant.** If shape errors are observed
  in production, building a parallel strict-compatible schema (without
  `.passthrough()` and with bounds expressed via descriptions) would
  let us re-introduce `strict: true` for shape guarantees.
- **CI.** Run `npx tsx scripts/test-claude-client-mock.ts` and `npx tsc
  --noEmit` on every PR. Add a GitHub Action.

## Phase 4 candidate ordering

The two highest-value next moves are roughly tied:

- **Document generation** if the next external milestone is "show a
  finished formulation to a practitioner".
- **Auth + persistence** if the next external milestone is "let two
  practitioners try it".

Pick based on whichever is sooner.
