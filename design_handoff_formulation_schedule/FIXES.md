# Data Fixes — Formulation Schedule generator

Three defects found while reading `Nof1_FormulationSchedule_SUB-2026-682_DRAFT.xlsx`. These are **generator logic bugs, not design issues.** Fix them before or alongside the restyle — a styled sheet makes wrong numbers more prominent, not less.

Fix in this order. Bug 1 is correctness and affects a clinical figure. Bug 3 is a data-model change and lands cleanest last.

---

## Bug 1 — Summary sheet category totals don't match the Formulation sheet

### What's wrong

The Summary sheet's "Granule Budget Breakdown by Category" disagrees with the Formulation sheet it summarises. Summing column E (Granules) of the Formulation sheet, grouped by column F (Category):

| Category | Summary sheet says | Actual sum of column E | Delta |
|---|---|---|---|
| B-Vitamins / Methylation | 195 | **84** | −111 |
| Antioxidant / Redox | 176 | **208** | +32 |
| Minerals | 27 | **109** | +82 |
| Hormone Metabolism | 120 | 120 | ✓ |
| Mitochondrial / Cardiovascular | 100 | 100 | ✓ |
| Vitamin D / C / Neurotransmitter | 52 | 52 | ✓ |
| **Plan total** | **670** | **673** | −3 |

The Summary's own headline, "Total granules (route-computed) = 673", **is correct** — it matches column E exactly. So the workbook contains two different totals, 673 and 670, three rows apart.

Working from the Formulation sheet, the correct grouping is:

- **B-Vitamins / Methylation = 84** — calcium folinate 3, methylcobalamin 2, riboflavin 3, P5P 2, thiamine 3, nicotinamide 10, pantothenic acid 19, choline bitartrate 42
- **Minerals = 109** — zinc citrate 8, magnesium glycinate 100, selenium 1
- **Antioxidant / Redox = 208** — NAC 100, L-glutathione 45, alpha-lipoic acid 20, quercetin 18, resveratrol 10, milk thistle 15
- **Vitamin D / C / Neurotransmitter = 52** — vitamin C 50, vitamin D3 2
- **Mitochondrial / Cardiovascular = 100** — CoQ10 100
- **Hormone Metabolism = 120** — DIM 20, calcium D-glucarate 100

Total 673, matching the headline and the ingredient rows.

### Why it's happening

Two code paths compute the same quantity. The headline reads the actual ingredient lines ("route-computed"); the category breakdown is coming from somewhere else — most likely a planning/allocation step that ran *before* doses were finalised, whose intermediate figures were written to the summary and never reconciled. The three categories that are correct are the ones the planner didn't adjust.

Note that 195 + 176 + 27 = 398 while 84 + 208 + 109 = 401, and the totals differ by exactly 3 — consistent with an allocation pass that reserved a budget and then had doses trimmed under it.

### How to find it

In your project, search for the strings that appear in the sheet:

```
Granule Budget Breakdown by Category
Plan total
Total granules (route-computed)
```

Whatever writes the "Plan total" row is the wrong source. Also search for `granules_allocated`, `budget`, `allocation`, or `plan` in your formulation logic and library-build scripts.

### The fix

Derive both the headline and the breakdown from one pass over the finalised ingredient lines. Replace whatever populates the Summary with a single function, and call it from both the workbook writer and the Health Analysis document writer:

```ts
// lib/formulation/deriveSummary.ts
import type { FormulationSchedule } from './schema';

const PRIORITY_TIER = {
  'B-Vitamins / Methylation': 'primary',
  'Antioxidant / Redox': 'primary',
  'Minerals': 'secondary',
  'Mitochondrial / Cardiovascular': 'secondary',
  'Hormone Metabolism': 'secondary',
  'Vitamin D / C / Neurotransmitter': 'supportive',
} as const;

// Display order for the workbook and document. Not generator order.
const CATEGORY_ORDER = [
  'B-Vitamins / Methylation',
  'Minerals',
  'Antioxidant / Redox',
  'Vitamin D / C / Neurotransmitter',
  'Mitochondrial / Cardiovascular',
  'Hormone Metabolism',
] as const;

export function deriveSummary(schedule: FormulationSchedule) {
  const { lines, podBudget } = schedule;

  const totalGranules = lines.reduce((sum, l) => sum + l.granules, 0);

  const byCategory = CATEGORY_ORDER
    .map((category) => ({
      category,
      priorityTier: PRIORITY_TIER[category],
      granules: lines
        .filter((l) => l.category === category)
        .reduce((sum, l) => sum + l.granules, 0),
    }))
    .filter((c) => c.granules > 0);

  // Invariant: the breakdown must reconcile to the total. If a new category is
  // added to the schema but not to CATEGORY_ORDER, this catches it at build time
  // rather than shipping a wrong number to a practitioner.
  const breakdownTotal = byCategory.reduce((sum, c) => sum + c.granules, 0);
  if (breakdownTotal !== totalGranules) {
    throw new Error(
      `Granule breakdown (${breakdownTotal}) does not reconcile with total (${totalGranules}). ` +
      `Unmapped categories: ${[...new Set(lines.map(l => l.category))]
        .filter(c => !CATEGORY_ORDER.includes(c as never)).join(', ') || 'none'}`
    );
  }

  return {
    totalGranules,
    byCategory,
    podBudgetUtilisation: totalGranules / podBudget.granuleCapacity,
    estimatedWeightMg: podBudget.estimatedWeightMg,
    ingredientCount: lines.length,
  };
}
```

Then in the workbook writer, the Summary sheet reads only from `deriveSummary(schedule)` — never from a stored field, and never from cells already written to another sheet.

### How to verify

Add to `scripts/validate-output.ts`:

```ts
const summary = deriveSummary(schedule);
assert(summary.totalGranules === 673, 'SUB-2026-682 regression: expected 673 granules');
assert(
  summary.byCategory.reduce((s, c) => s + c.granules, 0) === summary.totalGranules,
  'Category breakdown must reconcile with total'
);
```

Regenerate SUB-2026-682 and confirm the Summary sheet shows 673 in both places and the six category figures above.

---

## Bug 2 — Selenium dose stated three different ways

### What's wrong

| Location | Value |
|---|---|
| Formulation sheet, column C | `124.19` mcg |
| Dose Adjustments sheet | "dosed at **50 mcg elemental**" |
| Contraindications sheet | "dosed at **50 mcg elemental**" |
| **Health Analysis doc**, ingredient list | "Selenomethionine **100 mcg elemental**" |
| Health Analysis doc, contraindications table | "dosed at **50 mcg elemental**" |

124.19 mcg selenomethionine ≈ 50 mcg elemental selenium. So the spreadsheet is internally consistent and **the Health Analysis document is wrong — and contradicts itself**, stating 100 mcg in its ingredient list and 50 mcg in its contraindications table a few sections later.

### Why it matters clinically

Selenium toxicity is cumulative, which both documents say explicitly. A practitioner reading "100 mcg elemental" in the ingredient list may reasonably conclude the formulation is at the GP-class conservative ceiling when it is at half of it — and may add a separate selenium supplement on that basis. This is the one bug here with a plausible patient-safety consequence, so fix it even if you defer the others.

### How to find it

Search for the literal strings:

```
100 mcg elemental
Selenomethionine
selenium
```

The contraindications text is correct, so the defect is in whatever renders the "Intentionally included" ingredient list in the Health Analysis document. Likely causes: a hardcoded string, or a unit conversion applied twice (or not at all) when converting `doseAsSupplied` to an elemental figure for display.

### The fix

Don't fix the string. Fix the source: the document's ingredient list must read the same field as everything else. Once the two-column dose model from Bug 3 is in place, the ingredient list renders `elementalDose` + `elementalUnit` directly and the discrepancy is structurally impossible. Until then, populate the display value from a single conversion function:

```ts
// One place converts salt weight to elemental. Nowhere else does the arithmetic.
const ELEMENTAL_FRACTION: Record<string, number> = {
  'Selenium (as selenomethionine)': 0.4026,   // 50 / 124.19
  'Zinc citrate': 0.3212,                     // 15 / 46.7
  'Magnesium glycinate': 0.1170,              // 100 / 855
};

export function elementalDose(line: FormulationLine): { value: number; unit: string } | null {
  const fraction = ELEMENTAL_FRACTION[line.commonName];
  if (!fraction) return null;              // not a salt — dose IS the active figure
  return { value: Math.round(line.doseAsSupplied * fraction), unit: line.doseUnit };
}
```

Keying off `commonName` is a stopgap. The durable version stores the elemental fraction (or the elemental dose itself) on the ingredient's record in the library, so it lives with the ingredient rather than in a lookup table. Your `build:library` script is the natural home for it.

### How to verify

Regenerate SUB-2026-682 and grep both outputs for `selenium`. Every occurrence should read 50 mcg elemental, or 124.19 mcg as supplied. No occurrence of 100 mcg should remain except the sentence describing the GP-class *ceiling*, which is a different figure and correctly 100.

---

## Bug 3 — Salt weight and elemental weight are not distinguished

### What's wrong

Column C mixes two conventions with nothing to tell them apart:

| Ingredient | Column C | What it actually is | Elemental |
|---|---|---|---|
| Zinc citrate | 46.7 mg | salt weight | ~15 mg |
| Magnesium glycinate | 855 mg | salt weight | 100 mg |
| Selenium (as selenomethionine) | 124.19 mcg | salt weight | ~50 mcg |
| Calcium folinate | 547 mcg | salt weight | 500 mcg folinic acid |
| Vitamin C (ascorbic acid) | 500 mg | **the active figure** | 500 mg |
| NAC | 500 mg | **the active figure** | 500 mg |

A practitioner scanning the column cannot tell which row follows which convention, and the elemental figure is the clinically meaningful one. This is also the root cause of Bug 2 — with one ambiguous column, a document author has to guess, and guessed wrong.

### The fix

Split into two columns:

| Col | Header | Contents |
|---|---|---|
| C | `Dose (as supplied)` | The product/salt weight. Always populated. |
| D | `Unit` | mg / mcg |
| E | `Elemental / active` | The clinically meaningful figure. Populated **only for salts**; blank otherwise. |
| F | `Unit` | mg / mcg |

Leave column E genuinely blank for non-salts rather than repeating column C. A blank reads as "the dose column already is the active figure" and stops practitioners hunting for a difference that doesn't exist. Add a note under the total row stating this.

Schema change:

```ts
doseAsSupplied: z.number(),
doseUnit: z.enum(['mg', 'mcg']),
elementalDose: z.number().nullable(),          // null when not a salt
elementalUnit: z.enum(['mg', 'mcg']).nullable(),
```

Then, in the Health Analysis document's ingredient list, render `elementalDose ?? doseAsSupplied` with the matching unit — one expression, no arithmetic at the call site.

### Sequencing

Do this **after** the styling work is stable. It shifts every column letter on the Formulation sheet (F→H, G→I, and so on), so doing it mid-restyle means redoing every cell reference. Bug 2's stopgap fix holds the line until then.

---

## Handing this to Claude Code

Open Claude Code in your project and paste:

> Read `design_handoff_formulation_schedule/FIXES.md`. It documents three data bugs in the formulation schedule generator, found by inspecting the generated .xlsx for SUB-2026-682.
>
> Start with Bug 1 only. First, find the code that writes the "Granule Budget Breakdown by Category" rows on the Summary sheet and show me what it currently reads from — don't change anything yet. I want to confirm the diagnosis before we fix it.

Have it confirm each diagnosis against your actual code before changing anything. The numbers in this document come from reading the spreadsheet, not your source, so the *symptoms* are certain but the *cause* is inferred.

Once Bug 1 is fixed and `validate:output` passes, move to Bug 2, then the restyle in `README.md`, and leave Bug 3 until last.
