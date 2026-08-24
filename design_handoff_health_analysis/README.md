# Handoff: N of 1 Health Analysis — Branded Document Layout

## Overview

This bundle contains a branded, print-ready layout for the **Health Analysis** document that `n-of-1-app` currently generates for practitioners. It replaces the plain, unstyled output with a document that carries the N of 1 brand identity: olive/gold palette, Jost + Source Serif 4 typography, a branded cover band, running header and footer, and structured presentation of findings, formulation logic, contraindications and references.

The design is derived from a real generated document (`SUB-2026-682`) and the N of 1 brand house deck, so every section in the design maps to a section your generator already produces.

## About the Design Files

The files in this bundle are **design references created in HTML** — a prototype showing the intended look and print behaviour. They are **not production code to copy directly.**

The task is to **recreate this design inside `n-of-1-app`** using its existing environment: Next.js 14 App Router, TypeScript, React 18 and Tailwind. `NofISHealthAnalysis.dc.html` is a self-contained HTML prototype that opens in any browser — use it as the visual source of truth and read its inline styles for exact values, but implement the real thing as Tailwind-styled React components fed by typed props.

## Fidelity

**High-fidelity.** Colours, typography, spacing, borders and print behaviour are final. Recreate pixel-for-pixel. Copy is real generated content from submission SUB-2026-682 and should be replaced by data from your generator.

---

## ⚠️ Critical architectural decision: docx vs. HTML→PDF

Your `package.json` shows the Health Analysis is currently assembled with the `docx` library (`docx@^9.6.1`). **This design cannot be reproduced faithfully in .docx.** The `docx` library has no support for the CSS-grid finding cards, the full-bleed cover band, multi-column reference lists, or reliable `break-inside: avoid` behaviour. Attempting it will produce an approximation that drifts every time the layout changes.

### Recommended route: render HTML, print to PDF

1. Build the document as a React server component under `app/` — e.g. `app/reports/[submissionId]/health-analysis/page.tsx`.
2. Render it server-side with headless Chromium (`puppeteer-core` + `@sparticuz/chromium` on serverless, or plain `puppeteer` on a long-running host) and `page.pdf({ format: 'A4', printBackground: true })`.
3. Store or stream the PDF as your practitioner deliverable.

Benefits: one source of truth, exact fidelity, practitioners get a document that cannot be silently edited, and the same route renders in-browser for on-screen review.

### If .docx is a hard requirement

Keep `docx` for a **plain, accessible companion version** (practitioners who need to annotate or paste into their own clinical notes), and ship the PDF as the primary branded deliverable. Do not try to make one output serve both. Note that `exceljs` should continue to own the Recommended Formulation Schedule `.xlsx` — the design references it but does not replace it.

### Pagination behaviour in the prototype

The prototype uses a `<doc-page>` web component (`doc-page.js`, included) purely to preview paged flow in the browser. **Do not port this component.** In your implementation, replace it with:

- A print stylesheet declaring `@page { size: A4; margin: 0.7in; }`
- `position: fixed` header/footer bands, or Puppeteer's `headerTemplate`/`footerTemplate` options for the running header and footer
- `break-inside: avoid` on every card, table row and list item (already marked in the prototype markup)

---

## Design Tokens

Add these to `tailwind.config.ts` under `theme.extend`.

### Colours

| Token | Hex | Usage |
|---|---|---|
| `brand.olive` | `#535B50` | Cover band, section rules, table headers, callout blocks, brand marks |
| `brand.oliveDark` | `#2E332A` | Section headings, finding gene names |
| `brand.gold` | `#C6AF81` | Section numerals, accent rules, list bullets, reference numerals |
| `brand.goldDeep` | `#7A6A3E` | "Fast / upregulated" status pills, "Monitor" severity |
| `brand.goldPale` | `#F2EADA` | "Fast / upregulated" pill background |
| `ink.body` | `#23261F` | Body copy |
| `ink.muted` | `#4A4E43` | Secondary paragraph copy |
| `ink.soft` | `#5C6155` | Contributor / tertiary copy |
| `ink.faint` | `#7A7F72` | Rationale lines, italic notes |
| `ink.label` | `#8A8F81` | Uppercase eyebrow labels |
| `ink.labelLight` | `#9A9F91` | Field labels inside cards, dose values |
| `surface.card` | `#F4F3EC` | Pattern cards, strategy cards, exclusion callout |
| `surface.notice` | `#EFEDE4` | Draft-notice band |
| `surface.pill` | `#EDEDE4` | Default status pill background |
| `rule.strong` | `#DEDCD2` | Metadata grid borders, header/footer rules |
| `rule.medium` | `#E4E2DA` | Finding card dividers, table row borders |
| `rule.light` | `#EDEBE3` | Ingredient row dividers |
| `paper` | `#FFFFFF` | Page background |
| `onOlive` | `#F4F3EE` | Text on olive cover |
| `onOlive.muted` | `#D6D8CE` | Cover metadata line |
| `onOlive.faint` | `#8E9686` | Cover metadata separators |
| `onOlive.gold` | `#E4D6B4` | Emphasis inside olive callout |

The olive and gold are sampled directly from the N of 1 logo (`assets/logo.png`) — `#535B50` and `#C6AF81` are the literal logo pixel values. Do not substitute approximations.

### Typography

Two families, loaded from Google Fonts:

- **Jost** (weights 300, 400, 500, 600) — all UI furniture: headings, labels, eyebrows, data values, pills, table headers, numerals
- **Source Serif 4** (300–700, italic) — all running body copy, interpretations, rationales, references

Use `next/font/google` rather than a `<link>`:

```ts
import { Jost, Source_Serif_4 } from 'next/font/google';
export const jost = Jost({ subsets: ['latin'], weight: ['300','400','500','600'], variable: '--font-jost' });
export const sourceSerif = Source_Serif_4({ subsets: ['latin'], style: ['normal','italic'], variable: '--font-serif' });
```

Sizes are in **points**, because this is a print document. Keep them in points; do not convert to Tailwind's rem scale.

| Role | Family | Size | Weight | Other |
|---|---|---|---|---|
| Document title ("Health Analysis") | Jost | 34pt | 300 | line-height 1.05, letter-spacing -0.01em |
| Cover eyebrow ("Precision Formulation") | Jost | 8.5pt | 400 | letter-spacing .24em, uppercase, gold |
| Cover metadata | Jost | 9.5pt | 300 | letter-spacing .02em |
| Section number ("01") | Jost | 22pt | 300 | line-height 1, gold |
| Section heading | Jost | 15pt | 500 | letter-spacing .01em |
| Subsection eyebrow | Jost | 8.5pt | 500 | letter-spacing .16em, uppercase, `ink.label` |
| Body paragraph | Source Serif 4 | 10.5pt | 400 | line-height 1.6, max-width 46em |
| Finding gene name | Jost | 11pt | 600 | rsID in 300 weight, `ink.label` |
| Status pill | Jost | 8pt | 400 | letter-spacing .1em, uppercase, padding 3px 8px |
| Card field label | Jost | 7.5pt | 400 | letter-spacing .12em, uppercase, `ink.labelLight` |
| Card field value | Source Serif 4 | 9.5pt | 400 | line-height 1.5 |
| Pattern card title | Jost | 10.5pt | 500 | — |
| Pattern card SNP list | Source Serif 4 | 9pt | 400 | line-height 1.5, `ink.soft` |
| Ingredient name | Jost | 10pt | 400 | dose span in `ink.labelLight` |
| Table header | Jost | 7.5pt | 500 | letter-spacing .12em, uppercase, on olive |
| Table body | Source Serif 4 | 9pt | 400 | line-height 1.45 |
| Reference entry | Source Serif 4 | 8.5pt | 400 | line-height 1.45, journal in italic |
| Running header / footer | Jost | 7.5pt | 400/500 | letter-spacing .14em / .1em, uppercase |

**Minimum size is 7.5pt** and only for uppercase letterspaced labels. Never go below it.

### Spacing & geometry

- Page margin: **0.7in** all sides
- Cover band: full-bleed horizontally (`margin: 0 -0.7in`), `0.5in` internal padding, `16px` top offset so it clears the running header
- Section heading block: `padding-bottom: 8px`, `border-bottom: 2px solid brand.olive`, gap `14px` between numeral and heading
- Gap between section heading and following paragraph: `14px`
- Gap after a completed section: `34px`
- Finding card: `padding: 14px 0 12px`, `border-top: 1px solid rule.medium`
- Finding card field grid: `grid-template-columns: 104px 1fr`, gap `5px 14px`
- Pattern / strategy cards: 2-column grid, gap `12px` (patterns) / `10px` (strategy), padding `13px 15px` / `11px 13px`
- Accent-bar cards: `border-left: 3px solid brand.gold`
- Diet & lifestyle rows: `grid-template-columns: 150px 1fr`, gap `16px`
- Ingredient rows: `grid-template-columns: 200px 1fr`, gap `16px`, padding `9px 0`
- Metadata grid: 3 columns, cell padding `11px 14px`, 1px `rule.strong` borders on all sides
- References: `column-count: 2`, `column-gap: 26px`
- **No border radius anywhere.** Every corner in this design is square. This is deliberate — it reads as clinical documentation rather than consumer software.
- **No shadows anywhere.** Depth comes from hairline rules and flat tonal fills.

---

## Document Structure

The document is a single continuous flow, not discrete screens. Sections in order:

### Running header (repeats every page)
Three-part flex row, space-between, `1px solid rule.strong` bottom border, `padding-bottom: 7px`.
Left: `N of 1` in olive, weight 500. Centre: `Health Analysis · Practitioner Decision Support`. Right: submission ID.

### Running footer (repeats every page)
Same treatment, `border-top`, `padding-top: 7px`. Left: `Confidential — practitioner use only`. Right: `Audit ref <hash>`.

### Cover band
Full-bleed olive block. N of 1 logo (132px wide, from `assets/logo.png`), `38px` gap, gold uppercase eyebrow, 34pt title, then a wrapping metadata row of submission / patient / generation date separated by `|` glyphs in `onOlive.faint`.

### Draft notice (conditional)
Full-bleed `surface.notice` band with a 7px gold dot, uppercase olive heading, and a paragraph establishing that the document is practitioner decision support and not a diagnosis or prescription. Hidden once a document is approved.

### Metadata grid
9 cells, 3 across: patient pseudonym, age, sex at birth, test type, lab ID, collection date, practitioner ID, practitioner type, generated timestamp. Uppercase label above value in each cell.

### 01 Executive Summary
Paragraph, then an eyebrow "Recognised clinical patterns" and a 2-column grid of gold-accented cards. Each card: pattern name + the SNP list supporting it.

### 02 Detailed Biomarker Analysis
Intro paragraph stating the finding count, then a stack of finding cards. Each card has a gene name, rsID, a status pill, and three labelled fields: **Interpretation**, **Contributors**, **Formulation**. Status pill colour is driven by direction: slow/wild-type/mixed use `surface.pill` + olive text; fast/upregulated use `surface.goldPale` + `brand.goldDeep`. The final card in the stack also takes a `border-bottom` to close the list.

### 03 Diet and Lifestyle Considerations
Intro paragraph, then rows on a `150px 1fr` grid: topic name in olive Jost, then the consideration paragraph followed by a **Rationale** line with an inline uppercase label.

### 04 Recommended Formulation Logic
Eyebrow "Overall strategy", paragraph, then a 2-column grid of numbered strategy cards (large gold numeral + text; card 5 spans both columns). Then a closing paragraph on dosing conservatism. Then two labelled tables on a `200px 1fr` grid — **Intentionally included** (ingredient + dose + rationale) and **Intentionally excluded** (ingredient + reason). Closes with a full-width olive callout pointing to the companion `.xlsx`.

### 05 Contraindication and Interaction Considerations
Intro paragraph with count, then a 4-column table (Severity 88px / Flag 120px / Description auto / Ingredients 104px) with an olive header row. Severity styling: "Monitor" in `brand.goldDeep`, "Informational" and "Low in context" in `ink.label`. Then an eyebrow "Binding exclusions applied", explanatory paragraph, and a gold-accented callout card per exclusion.

### 06 Monitoring and Follow-Up
Paragraph, eyebrow, then a 2-column list of follow-up markers with hairline bottom rules; qualifier text in `ink.labelLight`. The final full-width row spans both columns. Closes with an italic caveat line in `ink.faint`.

### 07 Areas of Strength (conditional)
Paragraph with count, then a list of items each led by a 6×6px square gold bullet.

### References (conditional, unnumbered)
Section heading without a numeral, a caution paragraph about independent verification, then a 2-column list. Each entry: gold numeral, authors, year, title, italic journal, then an em-dash and the ingredient the citation supports.

### Closing block
`2px solid brand.olive` top rule, a bolded practitioner-guidance line, then a wrapping row of submission ID / generation timestamp / audit reference in uppercase Jost.

---

## Data Contract

Everything in the document is data-driven. Define this with `zod` (already a dependency) so the generator output is validated before render — this pairs naturally with your existing `validate:output` script.

```ts
import { z } from 'zod';

const StatusDirection = z.enum(['slow', 'fast', 'intermediate', 'mixed', 'wildType', 'contextual']);

export const Finding = z.object({
  gene: z.string(),                    // "MTHFR C677T"
  rsid: z.string().optional(),         // "rs1801133"
  genotypeLabel: z.string(),           // "AG heterozygous — slow"
  direction: StatusDirection,          // drives pill colour
  interpretation: z.string(),
  contributors: z.string(),
  formulationRelevance: z.string(),
});

export const ClinicalPattern = z.object({
  name: z.string(),
  supportingSnps: z.array(z.string()),
});

export const LifestyleConsideration = z.object({
  topic: z.string(),
  consideration: z.string(),
  rationale: z.string(),
});

export const IngredientLine = z.object({
  name: z.string(),
  dose: z.string().optional(),         // "547 mcg"
  rationale: z.string(),
});

export const ExclusionLine = z.object({
  name: z.string(),
  code: z.string().optional(),         // "W030006000"
  reason: z.string(),
});

export const Contraindication = z.object({
  severity: z.enum(['informational', 'monitor', 'lowInContext', 'high']),
  flag: z.string(),
  description: z.string(),
  ingredients: z.array(z.string()),
});

export const BindingExclusion = z.object({
  ingredient: z.string(),
  reason: z.string(),
});

export const MonitoringMarker = z.object({
  marker: z.string(),
  qualifier: z.string().optional(),    // "recheck 8–12 weeks"
  fullWidth: z.boolean().default(false),
});

export const Reference = z.object({
  index: z.number(),
  authors: z.string(),
  year: z.number(),
  title: z.string(),
  journal: z.string(),
  supports: z.string(),                // ingredient this citation backs
});

export const HealthAnalysis = z.object({
  submissionId: z.string(),            // "SUB-2026-682"
  patientPseudonym: z.string(),
  age: z.number(),
  sexAtBirth: z.string(),
  testType: z.string(),
  labId: z.string(),
  collectionDate: z.string(),
  practitionerId: z.string(),
  practitionerType: z.string(),
  generatedAt: z.string(),
  auditReference: z.string(),
  status: z.enum(['draft', 'approved']),   // draft => show draft notice

  executiveSummary: z.string(),
  clinicalPatterns: z.array(ClinicalPattern),
  findings: z.array(Finding),
  lifestyleConsiderations: z.array(LifestyleConsideration),

  formulationStrategy: z.object({
    intro: z.string(),
    axes: z.array(z.string()),           // numbered strategy cards
    dosingNote: z.string(),
    included: z.array(IngredientLine),
    excluded: z.array(ExclusionLine),
    companionScheduleNote: z.string(),
  }),

  contraindications: z.array(Contraindication),
  bindingExclusions: z.array(BindingExclusion),
  monitoring: z.object({
    intro: z.string(),
    markers: z.array(MonitoringMarker),
    caveat: z.string(),
  }),
  areasOfStrength: z.array(z.string()),
  references: z.array(Reference),
});
```

### Section numbering

Section numerals are **derived, not authored**. Areas of Strength is `07` only because the six sections before it are present. Compute the numerals from the list of sections that actually render, so a document without, say, binding exclusions still numbers correctly.

### Counts in prose

Several intro paragraphs state counts ("The following 31 biomarker findings...", "Four contraindication or interaction considerations are raised..."). Derive these from array length at render time rather than storing them — they will drift otherwise. Note the prototype spells small numbers as words and uses numerals above ten; match that.

---

## Interactions & Behaviour

This is a print document, so behaviour is minimal.

**On screen (practitioner review route):**
- No hover states, no click handlers, no animation. Nothing is interactive.
- Links, if any are added: default and hover colours must be defined — use `brand.olive` default, `brand.gold` hover. Never leave browser-default blue.
- The three conditional sections (draft notice, areas of strength, references) are the only variable structure. Gate them on `status === 'draft'` and on array non-emptiness respectively.

**At print:**
- Every card, table row, list item and section heading block carries `break-inside: avoid`.
- Section heading blocks should also carry `break-after: avoid` so a heading never orphans at the foot of a page.
- `printBackground: true` is required — the olive cover band, olive callouts, table headers and tonal card fills are all backgrounds and will vanish without it.
- Backgrounds bleed to the page edge horizontally via negative margins; confirm this survives your `@page` margin in Chromium before shipping.

## State Management

None. The document is a pure function of one validated `HealthAnalysis` object. Render it as a React server component; no client-side JavaScript is needed at all. If you add a review UI around it (approve, annotate, regenerate), keep that state in the surrounding route, not in the document component.

## Assets

| Asset | Source | Notes |
|---|---|---|
| `assets/logo.png` | Extracted from the existing generated .docx (1600×300, transparent PNG) | The wordmark on the cover band. Rendered at 132px wide. Olive `#535B50` and gold `#C6AF81` are sampled from this file — it is the colour authority for the brand. |

Fonts load from Google Fonts (Jost, Source Serif 4) — both are open-licensed and safe to self-host via `next/font` for offline PDF generation. **Self-hosting is strongly recommended** for the Puppeteer route; a network font fetch during PDF render is a flaky dependency and a font fallback will silently break the layout.

## Files in this bundle

| File | What it is |
|---|---|
```
NofISHealthAnalysis.dc.html   The design prototype. Open in a browser. Visual source of truth.
doc-page.js                   Print-preview shell used by the prototype only. DO NOT PORT.
assets/logo.png               N of 1 wordmark.
README.md                     This document.
```

## Suggested implementation order

1. Add colour tokens and the two fonts to `tailwind.config.ts` / a fonts module.
2. Define the `HealthAnalysis` zod schema and wire it into `validate:output`.
3. Build leaf components against real SUB-2026-682 data: `FindingCard`, `PatternCard`, `StatusPill`, `SectionHeading`, `IngredientRow`, `LifestyleRow`, `ReferenceEntry`.
4. Compose `HealthAnalysisDocument` and render it at a review route.
5. Add the print stylesheet and running header/footer; verify pagination in Chromium at A4.
6. Add the Puppeteer PDF route.
7. Diff a generated PDF against the prototype side by side before replacing the docx path.
