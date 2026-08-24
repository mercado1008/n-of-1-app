# Handoff: N of 1 Recommended Formulation Schedule — Branded Workbook

## Overview

This bundle contains a branded layout for the **Recommended Formulation Schedule** — the `.xlsx` workbook that `n-of-1-app` generates alongside the Health Analysis document. It replaces the current unstyled five-sheet export with a workbook carrying the N of 1 brand identity: olive/gold palette, category grouping, review-priority pills, a legible reading hierarchy across the wide rationale columns, and a Summary sheet that presents the granule budget visually rather than as a bare list.

It is the companion to `design_handoff_health_analysis`. Use the same design tokens for both — practitioners receive them together and they must read as one system.

## About the Design Files

The files in this bundle are **design references created in HTML** — a prototype showing the intended look, not production code to copy directly.

`NofISFormulationSchedule.dc.html` renders all five sheets as a **landscape print document** — a paginated PDF-ready layout, not a spreadsheet emulation. Open it in a browser. It exists to show you the intended visual treatment of each sheet's content: header rows, category grouping, priority pills, type hierarchy and colour.

**Read it as two specs at once.** The colours, weights, groupings and hierarchy apply to the `exceljs` workbook (see "Sheet" sections below). The pagination, landscape orientation and print behaviour apply only if you also build the printable PDF variant (see "Two outputs" below). Do not try to make Excel reproduce the paginated layout.

## Fidelity

**High-fidelity.** Colours, weights, alignments, column widths and grouping behaviour are final. Content is real generated data from submission SUB-2026-682.

---

## ⚠️ Read this first: three data bugs in the current generator

While reading the existing workbook I found discrepancies that are **generator logic bugs, not design issues.** Fix these before or alongside the restyle — styling will make them more visible, not less.

**Step-by-step fix instructions, with reference implementations, are in `FIXES.md` in this folder.** The summary below is diagnosis only.

### 1. Summary sheet category granule counts are wrong

The Summary sheet's "Granule Budget Breakdown by Category" does not match the Formulation sheet it summarises. Summing column E of the Formulation sheet by category gives:

| Category | Summary sheet says | Actual sum of column E | Delta |
|---|---|---|---|
| B-Vitamins / Methylation | 195 | **84** | −111 |
| Antioxidant / Redox | 176 | **208** | +32 |
| Minerals | 27 | **109** | +82 |
| Hormone Metabolism | 120 | 120 | ✓ |
| Mitochondrial / Cardiovascular | 100 | 100 | ✓ |
| Vitamin D / C / Neurotransmitter | 52 | 52 | ✓ |
| **Plan total** | **670** | **673** | −3 |

The headline "Total granules (route-computed) = 673" is correct and matches column E. The category breakdown and its "Plan total" of 670 do not. Three categories are wrong and the total is short by 3. Whatever computes the category breakdown is not reading the same source as the route-computed total — derive both from one pass over the ingredient list.

### 2. Selenium dose is stated three different ways

- Formulation sheet, column C: `124.19 mcg` (salt weight)
- Dose Adjustments sheet: "dosed at **50 mcg elemental**"
- Contraindications sheet: "dosed at **50 mcg elemental**"
- Health Analysis document, ingredient list: "Selenomethionine **100 mcg elemental**"

124.19 mcg selenomethionine ≈ 50 mcg elemental selenium, so the spreadsheet is internally consistent and **the Health Analysis document is the one that is wrong.** Its own contraindications section says 50 mcg, contradicting its own ingredient list. Both documents draw from the same generator, so fix it at the source.

### 3. Salt weight vs. elemental weight is not labelled

Column C mixes the two without distinguishing them. Zinc citrate reads `46.7 mg` (salt, ≈15 mg elemental); magnesium glycinate reads `855 mg` (salt, = 100 mg elemental); selenium reads `124.19 mcg` (salt, ≈50 mcg elemental). Meanwhile vitamin C's `500 mg` **is** the elemental/active figure. A practitioner scanning the column cannot tell which convention any given row follows, and the elemental figure is the clinically meaningful one.

**Recommended fix:** split into two columns — `Dose (as supplied)` and `Elemental / active` — and populate the second only for salts. The design in this bundle shows the single-column version to stay faithful to your current data shape; add the second column when the data supports it. This is the highest-value change on the sheet.

### Also worth deciding

Column C values are stored as **numbers** with the unit in a separate column D. That is correct and worth preserving — do not concatenate them into a display string, or you lose sortability and Excel's numeric alignment. Format the display with a number format instead (see below).

---

## Design Tokens

Identical to the Health Analysis handoff. Reproduced here so this README stands alone.

### Colours

| Token | Hex | Usage in workbook |
|---|---|---|
| `brand.olive` | `#535B50` | Header row fills, total row fill, sheet tab active state, section rules |
| `brand.oliveDark` | `#2E332A` | Ingredient names, primary cell text |
| `brand.gold` | `#C6AF81` | Budget bars, accent rules |
| `brand.goldDeep` | `#7A6A3E` | MODERATE / monitor pill text |
| `brand.goldPale` | `#F2EADA` | MODERATE / monitor pill fill |
| `onOlive` | `#F1F0EA` | Text on olive header rows |
| `onOlive.gold` | `#E4D6B4` | Emphasised total figure on olive |
| `onOlive.rule` | `#6B7266` | Vertical dividers inside olive header rows |
| `ink.body` | `#23261F` | Body cell text |
| `ink.soft` | `#5C6155` | Target findings column |
| `ink.faint` | `#7A7F72` | Cautions column, category column |
| `ink.label` | `#8A8F81` | W codes, uppercase labels |
| `ink.labelLight` | `#9A9F91` | Machine keys, qualifiers |
| `surface.band` | `#EFEDE4` | Category band rows, empty budget bar track |
| `surface.pill` | `#EDEDE4` | STANDARD pill fill |
| `surface.zebra` | `#FAFAF7` | Alternating data row fill |
| `paper` | `#FFFFFF` | Default cell fill |
| `rule.medium` | `#E4E2DA` | Row bottom borders |
| `rule.light` | `#EDEBE3` | Column dividers inside data rows |
| `rule.strong` | `#DEDCD2` | Summary grid borders |
| `chrome.border` | `#C9C7BD` | Outer workbook border, inactive tab border |
| `chrome.tabIdle` | `#DCDAD1` | Inactive sheet tab fill |

Olive `#535B50` and gold `#C6AF81` are sampled from the N of 1 logo and are the brand's colour authority.

### Typography

The HTML prototype uses **Jost** (UI/data) and **Source Serif 4** (prose columns). In Excel you cannot rely on either being installed on a practitioner's machine.

**In the `.xlsx`:** use a single safe family throughout — **Calibri** (Excel's default, present everywhere) or **Aptos** if you are targeting current Office. Do not set Jost in the workbook; an uninstalled font falls back unpredictably and breaks column fit. Carry the brand through **colour, weight, fill and spacing**, which travel reliably.

**In any HTML or PDF rendering of the same data** (see "Two outputs" below), use Jost and Source Serif 4 as specified in the Health Analysis handoff.

| Role | Size | Weight | Colour | Alignment |
|---|---|---|---|---|
| Header row | 9pt | bold | `onOlive` on `brand.olive` | left, wrap, vertical centre |
| Category band | 9.5pt | bold | `brand.olive` on `surface.band` | left, caps, letterspaced if available |
| W code | 9pt | regular | `ink.label` | left |
| Ingredient name | 10.5pt | semibold | `brand.oliveDark` | left |
| Dose | 10pt | regular | `ink.body` | **right** |
| Unit | 9pt | regular | `ink.faint` | left |
| Granules | 10pt | semibold | `brand.olive` | **right** |
| Review priority | 9pt | regular | pill colours | centre |
| Category | 9pt | regular | `ink.faint` | left |
| Target findings | 9.5pt | regular | `ink.soft` | left, wrap |
| Rationale | 9.5pt | regular | `ink.body` | left, wrap, vertical top |
| Cautions | 9.5pt | regular | `ink.faint` | left, wrap, vertical top |
| Total row | 10.5pt | bold | `onOlive` / `onOlive.gold` on `brand.olive` | matches column |

Numeric columns must be right-aligned with a fixed number format so decimals line up. Dose: `0.##` (renders `547`, `46.7`, `124.19`). Granules: `0`.

---

## Sheet 1: Formulation

The primary sheet — 22 ingredient rows, 11 columns.

### Column widths (Excel character units, as currently set)

| Col | Field | Current | Keep? |
|---|---|---|---|
| A | W Code | 14 | ✓ |
| B | Common Name | 28 | ✓ |
| C | Proposed Dose | 14 | → **10** |
| D | Unit | 8 | ✓ |
| E | Granules | 10 | ✓ |
| F | Category | 22 | → **24** |
| G | Review Priority | 14 | → **16** |
| H | Target Biomarker Findings | 32 | ✓ |
| I | Rationale for Practitioner | 60 | ✓ |
| J | Practitioner Cautions | 40 | ✓ |
| K | Evidence Pointer | 40 | ✓ |

Note the prototype omits column K (Evidence Pointer) for legibility on screen. **Keep it in the workbook** — it is the audit trail. Style it like Cautions but in `ink.label`.

### Structural changes from the current sheet

1. **Freeze panes at `C2`.** The header row and the W code + name columns stay visible while scrolling the wide rationale columns. This is the single biggest usability win and is one line in `exceljs`:
   ```ts
   sheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];
   ```

2. **Group rows by category, with a band row per group.** Currently rows appear in generator order and category is only readable in column F. Insert a merged band row before each group carrying the category name, its priority tier (primary / secondary / supportive), and its granule subtotal. Order: B-Vitamins / Methylation, Minerals, Antioxidant / Redox, Vitamin D / C / Neurotransmitter, Mitochondrial / Cardiovascular, Hormone Metabolism.

3. **Add a total row** at the foot: olive fill, ingredient count on the left, granule total in `onOlive.gold`, and budget utilisation and estimated pod weight as a note spanning the remaining columns. This mirrors the Summary sheet's headline and gives the practitioner the number without switching sheets — but it must be **computed from the same source** as the Summary (see bug 1).

4. **Zebra striping** on data rows using `surface.zebra`. Essential at this column count.

5. **`Review Priority` as a coloured pill.** Excel cannot render a rounded pill, so use a **full-cell fill** with centred text: MODERATE → `surface.goldPale` fill + `brand.goldDeep` text; STANDARD → `surface.pill` fill + `brand.olive` text. If a HIGH tier exists, use `brand.olive` fill + `onOlive` text. Note that fill-per-cell fights zebra striping — the priority cell wins; let it override.

6. **Row height.** Set `row.height` explicitly rather than relying on autofit — `exceljs` does not autofit, and wrapped rationale text will clip. Estimate from the longest wrapped cell: roughly `Math.ceil(chars / colWidth) * 12 + 8` points, floored at 32. Verify against the longest row (calcium folinate) before shipping.

7. **Add an `autoFilter`** over the header row so practitioners can filter by category or priority.

### Do not

- Merge cells anywhere in the data region. Merges break sorting, filtering and copy-paste, which is most of why a practitioner opens a spreadsheet. The category band rows are the only permitted merges.
- Use conditional formatting to fake the pills — set the styles directly; the values are known at generation time.
- Set a print area on this sheet. It is a working reference, not a print artefact; the Health Analysis PDF is the printable deliverable.

---

## Sheet 2: Dose Adjustments

Three columns (28 / 80 / 32), three rows. Low volume, high importance — these are the places a clinician overrode the naive dose.

- Column A currently holds a raw machine key (`dose_reduction_for_pod_budget`). Show a **human label on the first line** and the machine key beneath it in `ink.labelLight` at 8pt, as the prototype does. Keep the key visible — it is what the generator logs against.
- Column B is prose: wrap, vertical top, 9.5pt.
- Column C: ingredient name in `brand.olive`. Note the current file has a **literal newline inside the cell** for "Selenium\n(Selenomethionine)" — normalise these to a single line before writing.
- Freeze the header row only (`ySplit: 1`).

## Sheet 3: Standalones

Three columns (40 / 14 / 80). Recommendations that fall outside the pod.

- Column B (`In Library?`) is a Yes/No — render as a centred pill fill, gold-pale for Yes, neutral for No.
- Columns A and C are prose: wrap, vertical top.
- Row 4 in the current file mixes registers: rows 2–3 are sentences describing a discussion, row 4 is a title (`5-HTP (excluded from pod: deprioritised)`). Worth making the generator consistent — either all are titles with detail in column C, or all are sentences. Not a design fix.

## Sheet 4: Contraindications

Four columns (16 / 28 / 70 / 32). Same content as section 05 of the Health Analysis document — they must never diverge, so generate both from one array.

- Column A severity as a pill fill: `monitor` → gold-pale; `informational` and `low in this context` → neutral. Reserve olive fill for a `high` severity if the generator can emit one.
- Severity values arrive lowercase with underscores (`low_in_this_context`). Title-case for display, keep the raw value for logic.
- Column B: human label above machine key, as sheet 2.
- Sort rows by severity descending so the most serious flag is always first. The current file happens to be ordered that way; make it deliberate.

## Sheet 5: Summary

Currently a bare label/value list with blank spacer rows. This sheet is what a practitioner glances at first, so it earns real layout.

- **Title** in row 2, 16pt, `brand.oliveDark`, with a bottom border in `brand.olive` (2pt) spanning columns A–B.
- **Headline numbers** as a bordered grid. The three route-computed figures (total granules, budget utilisation, pod weight) get large type — 18pt, weight 300 if the font supports it, `brand.olive`. The remaining six counts get 12pt `brand.oliveDark`. Label above value, label in 8pt `ink.label` uppercase.
- **Granule budget by category** as a horizontal bar per category. In HTML this is a div; in Excel, use `REPT("█", n)` in a helper column with `brand.gold` font colour, scaled so the largest category fills a set width. Ugly to write, reads well. Alternative: an embedded native bar chart via `exceljs` chart support — heavier, and worth it only if practitioners have asked for it.
- Keep the priority tier (primary / secondary / supportive) beside each category name in `ink.labelLight`.
- **Plan total** row with a 2pt `brand.olive` top border. Must equal the Formulation sheet total (bug 1).
- Remove the blank spacer rows and use row heights for breathing room instead — spacer rows break `autoFilter` and range references.

---

## Two outputs, one data source

Worth deciding explicitly, because it affects how you structure this:

**The workbook** is the practitioner's working tool — sortable, filterable, copy-pasteable into clinical notes. `exceljs` is the right tool and styling it as specified above gets you most of the way to brand. This is the primary deliverable.

**A printable schedule** for practitioners who file a paper record. Do **not** try to make Excel print nicely. The prototype in this bundle *is* the print design — landscape, paginated, five sections in sequence. Render it as HTML and print to PDF exactly as described in the Health Analysis handoff, sharing the same components and tokens.

### What differs between the two

The print variant is not the workbook with a print stylesheet. Deliberate differences, all visible in the prototype:

| | Workbook | Print PDF |
|---|---|---|
| Sheets | Five separate tabs | Five numbered sections in one flow, `break-before: page` between |
| Category column (F) | Present | **Removed** — the grouping bands carry it, freeing width for rationale |
| Column headers | Frozen pane, once | Repeated above **each category group** so they survive page breaks |
| Evidence Pointer (K) | Present — the audit trail | Omitted for width |
| Font | Calibri / Aptos (portability) | Jost + Source Serif 4 |
| Table type size | 9–10.5pt | 7.5–8.5pt (nine columns on landscape) |
| Interactivity | Freeze panes, autofilter, sort | None |

The repeated-header-per-group pattern is worth understanding: it replaces `<thead>` repetition, and because the groups are also `break-inside: avoid`, each category block stays whole and self-labelling wherever it lands on the page.

Either way, generate from a **single validated `FormulationSchedule` object** — never from the spreadsheet cells. The workbook is an output, not a data store.

---

## Data Contract

Extends the schema in the Health Analysis handoff. Use `zod` (already a dependency) and wire into `validate:output`.

```ts
import { z } from 'zod';

export const Category = z.enum([
  'B-Vitamins / Methylation',
  'Minerals',
  'Antioxidant / Redox',
  'Vitamin D / C / Neurotransmitter',
  'Mitochondrial / Cardiovascular',
  'Hormone Metabolism',
]);

export const PriorityTier = z.enum(['primary', 'secondary', 'supportive']);
export const ReviewPriority = z.enum(['STANDARD', 'MODERATE', 'HIGH']);

export const FormulationLine = z.object({
  wCode: z.string(),                       // "W030027000"
  commonName: z.string(),
  doseAsSupplied: z.number(),              // 46.7  — salt/product weight
  doseUnit: z.enum(['mg', 'mcg']),
  elementalDose: z.number().nullable(),    // 15    — null for non-salts
  elementalUnit: z.enum(['mg', 'mcg']).nullable(),
  granules: z.number().int(),
  category: Category,
  reviewPriority: ReviewPriority,
  targetFindings: z.array(z.string()),     // rendered comma-joined
  rationale: z.string(),
  cautions: z.string(),
  evidencePointer: z.string(),
});

export const DoseAdjustment = z.object({
  type: z.string(),                        // machine key, shown small
  label: z.string(),                       // human label, shown large
  description: z.string(),
  affectedIngredients: z.array(z.string()),
});

export const Standalone = z.object({
  recommendation: z.string(),
  inLibrary: z.boolean(),
  practitionerNote: z.string(),
});

export const FormulationSchedule = z.object({
  submissionId: z.string(),
  patientPseudonym: z.string(),
  status: z.enum(['draft', 'approved']),
  generatedAt: z.string(),

  lines: z.array(FormulationLine),
  doseAdjustments: z.array(DoseAdjustment),
  standalones: z.array(Standalone),
  contraindications: z.array(Contraindication),   // reuse from health-analysis schema

  podBudget: z.object({
    granuleCapacity: z.number().int(),            // e.g. 720
    estimatedWeightMg: z.number(),
  }),
});
```

### Everything else is derived

Do not store these — compute them, or they will drift:

- `totalGranules` = sum of `lines[].granules`
- `budgetUtilisation` = `totalGranules / podBudget.granuleCapacity`
- `ingredientCount` = `lines.length`
- category subtotals = group `lines` by `category`, sum `granules`
- `priorityTier` for a category = a constant lookup, not per-line data
- counts quoted in Health Analysis prose ("22 ingredients", "four contraindication flags")

Bug 1 exists precisely because some of these were stored rather than derived. One `deriveSummary(schedule)` function feeding both the workbook and the document removes the whole class of error.

## Interactions & Behaviour

The workbook has no interactivity to design beyond what Excel provides: frozen panes, autofilter, and column sort. The print variant has none at all.

The prototype was previously a tabbed viewer; it is now a paginated print document. If you see a reference to sheet tabs anywhere, it is stale — there are no tabs to build in either output.

## State Management

None. Both outputs are pure functions of one validated `FormulationSchedule`.

## Assets

`assets/logo.png` — the N of 1 wordmark (1600×300, transparent PNG), source of the brand olive and gold. **Not used in the workbook** — `exceljs` image embedding is fragile and a logo in a data sheet interferes with sorting. It appears on the cover band of the print variant only, at 112px wide.

## Files in this bundle

```
README.md                          This document — design spec and data contract.
FIXES.md                           How to fix the three data bugs. Start here.
NofISFormulationSchedule.dc.html   Design prototype — landscape print document,
                                   all five sheets. Open in a browser.
doc-page.js                        Print-geometry shell the prototype needs.
                                   DO NOT PORT — see the Health Analysis handoff
                                   for how to handle print geometry in Next.js.
support.js                         Runtime the prototype needs. Not for production.
assets/logo.png                    N of 1 wordmark.
```

## Suggested implementation order

1. Fix bug 1 — one `deriveSummary()` pass feeding both outputs. Do this first; it is correctness, not styling.
2. Fix bug 2 — correct the selenium figure at the generator, verify both documents agree.
3. Define the `FormulationSchedule` schema, wire into `validate:output`.
4. Build a small `exceljs` style module: fills, fonts, borders, pill styles, number formats as named constants. Do not inline style objects at each `getCell` call.
5. Restyle Sheet 1: header, freeze panes, zebra, category bands, pills, total row, autofilter, row heights.
6. Restyle sheets 2–4 (same patterns, fewer columns).
7. Rebuild Sheet 5 with the headline grid and category bars.
8. Then consider bug 3 (split dose columns) — it is a data-model change, so it lands cleanest after the styling is stable.
9. Open the generated file in Excel, Numbers and Google Sheets before shipping. Fills and fonts are portable; letterspacing and some border styles are not.
