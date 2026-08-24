/**
 * scripts/generate-docs/formulation-schedule.ts
 *
 * Generates the Recommended Formulation Schedule .xlsx for a single submission.
 *
 * Five sheets:
 *   1. Formulation         — ingredients grouped by category, with band rows,
 *                            freeze panes, zebra rows, priority pills, total row
 *   2. Dose Adjustments    — capped or sub-target doses with rationale
 *   3. Standalones         — items recommended outside the pod
 *   4. Contraindications   — safety flags sorted by severity, pill-filled cells
 *   5. Summary             — headline metrics + category bar chart
 *
 * Uses exceljs (already installed). Design tokens from
 * design_handoff_formulation_schedule/README.md — olive/gold palette,
 * Calibri font (safe on all Excel platforms), full design token set.
 *
 * Category totals are derived exclusively from deriveSummary() — never from
 * granule_budget_allocation_plan. See derive-summary.ts and FIXES.md.
 */

import ExcelJS from 'exceljs';
import type {
  AnalysisOutput,
  ProposedIngredient,
  ExcludedFromPod,
  StandaloneRecommendation,
  DoseAdjustment,
  ContraindicationFlag,
  AllocationPlanEntry,
  RouteAuditBlock,
  RouteGranuleVerification,
  ComputedIngredient,
} from './types';
import { deriveSummary, type FormulationSummary } from './derive-summary';

// ---------------------------------------------------------------------------
// Design tokens — ARGB (leading FF = fully opaque)
// Sourced from design_handoff_formulation_schedule/README.md
// ---------------------------------------------------------------------------

const C = {
  // Brand primaries (sampled from N of 1 logo)
  olive:         'FF535B50',
  oliveDark:     'FF2E332A',
  gold:          'FFC6AF81',
  goldDeep:      'FF7A6A3E',
  goldPale:      'FFF2EADA',

  // Text on olive backgrounds
  onOlive:       'FFF1F0EA',
  onOliveGold:   'FFE4D6B4',

  // Ink hierarchy
  inkBody:       'FF23261F',
  inkSoft:       'FF5C6155',
  inkFaint:      'FF7A7F72',
  inkLabel:      'FF8A8F81',
  inkLabelLight: 'FF9A9F91',

  // Surfaces
  surfaceBand:   'FFEFEDE4',
  surfacePill:   'FFEDEDE4',
  surfaceZebra:  'FFFAFAF7',
  paper:         'FFFFFFFF',

  // Rules
  ruleMedium:    'FFE4E2DA',
  ruleLight:     'FFEDEBE3',
  ruleStrong:    'FFDEDCD2',
} as const;

const FONT = 'Calibri';

// ---------------------------------------------------------------------------
// Category display helpers — kept local so sheet builders are self-contained.
// Must stay consistent with derive-summary.ts.
// ---------------------------------------------------------------------------

const CATEGORY_DISPLAY_NAMES: Record<string, string> = {
  antioxidant_redox:           'Antioxidant / Redox',
  anti_inflammatory_core:      'Anti-inflammatory Core',
  mitochondrial_cardiovascular:'Mitochondrial / Cardiovascular',
  b_vitamins_methylation:      'B-Vitamins / Methylation',
  heavy_metal_detox:           'Heavy Metal Detox',
  minerals:                    'Minerals',
  vitamin_d_c_neurotransmitter:'Vitamin D / C / Neurotransmitter',
  thyroid_adaptogenic:         'Thyroid / Adaptogenic',
  blood_glucose_insulin:       'Blood Glucose / Insulin',
  gastrointestinal:            'Gastrointestinal',
  hormone_balance:             'Hormone Balance',
  hormone_metabolism:          'Hormone Metabolism',
  cognitive_neuro:             'Cognitive / Neuro',
  immune_support:              'Immune Support',
  cardiovascular_lipids:       'Cardiovascular / Lipids',
};

function humanise(category: string | undefined): string {
  if (!category) return '—';
  return CATEGORY_DISPLAY_NAMES[category] ?? category
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function titleCase(s: string): string {
  return (s ?? '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Resolver helper — TSI codes → common ingredient names
// ---------------------------------------------------------------------------

export type TsiResolver = (tsiCode: string) => string | undefined;

function resolveCodes(codes: string[] | undefined, resolver?: TsiResolver): string {
  if (!Array.isArray(codes) || codes.length === 0) return '—';
  return codes.map((c) => resolver?.(c) ?? '—').filter((n) => n !== '—').join(', ') || '—';
}

// ---------------------------------------------------------------------------
// Row-height estimation for wrapped text cells
// exceljs does not autofit; rows clip without an explicit height.
// Formula from handoff README: ceil(chars / colWidth) × 12pt + 8pt, floor 32.
// ---------------------------------------------------------------------------

function estimateRowHeight(rationale: string | undefined, targets: string | undefined): number {
  const rLines = Math.ceil((rationale ?? '').length / 60);
  const tLines = Math.ceil((targets ?? '').length / 32);
  return Math.max(Math.max(rLines, tLines, 2) * 12 + 8, 32);
}

// ---------------------------------------------------------------------------
// Shared cell-styling helpers
// ---------------------------------------------------------------------------

function styleHeaderRow(row: ExcelJS.Row, colCount: number): void {
  row.height = 26;
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.font = { name: FONT, size: 9, bold: true, color: { argb: C.onOlive } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.olive } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: C.gold } } };
  }
}

function applyZebraRow(row: ExcelJS.Row, isAlt: boolean, colCount: number): void {
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    if (isAlt) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.surfaceZebra } };
    }
    cell.border = { bottom: { style: 'hair', color: { argb: C.ruleMedium } } };
  }
}

function applyPriorityPill(cell: ExcelJS.Cell, priority: string): void {
  const p = (priority ?? 'STANDARD').toUpperCase();
  if (p.includes('MODERATE')) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.goldPale } };
    cell.font = { name: FONT, size: 9, color: { argb: C.goldDeep } };
  } else if (p.includes('HIGH') || p.includes('URGENT')) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.olive } };
    cell.font = { name: FONT, size: 9, color: { argb: C.onOlive } };
  } else {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.surfacePill } };
    cell.font = { name: FONT, size: 9, color: { argb: C.olive } };
  }
  cell.alignment = { horizontal: 'center', vertical: 'middle' };
}

function applySeverityPill(cell: ExcelJS.Cell, severity: string): void {
  const s = (severity ?? '').toLowerCase().replace(/\s+/g, '_');
  if (s.includes('monitor') || s.includes('moderate')) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.goldPale } };
    cell.font = { name: FONT, size: 9, bold: true, color: { argb: C.goldDeep } };
  } else if (s.includes('high') || s.includes('critical') || s.includes('absolute')) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.olive } };
    cell.font = { name: FONT, size: 9, bold: true, color: { argb: C.onOlive } };
  } else {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.surfacePill } };
    cell.font = { name: FONT, size: 9, color: { argb: C.inkLabel } };
  }
  cell.alignment = { horizontal: 'center', vertical: 'middle' };
}

// Severity sort: higher rank = higher severity, sort descending
function severityRank(severity: string): number {
  const s = (severity ?? '').toLowerCase();
  if (s.includes('high') || s.includes('critical') || s.includes('absolute')) return 4;
  if (s.includes('monitor') || s.includes('moderate')) return 3;
  if (s.includes('informational')) return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// SHEET 1: FORMULATION
// ---------------------------------------------------------------------------

function buildFormulationSheet(
  workbook: ExcelJS.Workbook,
  output: AnalysisOutput,
  granuleVerification?: RouteGranuleVerification,
  formulationSummary?: FormulationSummary,
): void {
  const sheet = workbook.addWorksheet('Formulation');

  const COL_COUNT = 11;
  sheet.columns = [
    { header: 'W Code',                    key: 'wcode',    width: 14 },
    { header: 'Common Name',               key: 'name',     width: 28 },
    { header: 'Proposed Dose',             key: 'dose',     width: 10 },
    { header: 'Unit',                      key: 'unit',     width:  8 },
    { header: 'Granules',                  key: 'granules', width: 10 },
    { header: 'Category',                  key: 'category', width: 24 },
    { header: 'Review Priority',           key: 'priority', width: 16 },
    { header: 'Target Biomarker Findings', key: 'targets',  width: 32 },
    { header: 'Rationale for Practitioner',key: 'rationale',width: 60 },
    { header: 'Practitioner Cautions',     key: 'cautions', width: 40 },
    { header: 'Evidence Pointer',          key: 'evidence', width: 40 },
  ];

  styleHeaderRow(sheet.getRow(1), COL_COUNT);

  // Freeze: header row + first two columns (W Code + Common Name) stay visible
  sheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];

  // Autofilter over the full header row
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COL_COUNT } };

  // Build tsi_code → computed granules lookup
  const granulesByCode = new Map<string, number>();
  for (const ci of granuleVerification?.computed_per_ingredient ?? []) {
    if (ci.tsi_code) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      granulesByCode.set(ci.tsi_code, (ci as any).computed_granules ?? ci.granules_computed ?? 0);
    }
  }

  // Build category → priority tier lookup from the allocation plan
  const categoryPriority = new Map<string, string>();
  for (const p of (output.granule_budget_allocation_plan ?? []) as AllocationPlanEntry[]) {
    if (p.category && p.priority) categoryPriority.set(p.category, p.priority);
  }

  const ingredients = output.proposed_formulation ?? [];

  // Group ingredients by category code
  const ingsByCategory = new Map<string, ProposedIngredient[]>();
  for (const ing of ingredients) {
    const cat = ing.category ?? 'other';
    if (!ingsByCategory.has(cat)) ingsByCategory.set(cat, []);
    ingsByCategory.get(cat)!.push(ing);
  }

  // Determine display order: use formulationSummary if available, else generator order
  const categoryOrder: Array<{ category: string; displayName: string; granules: number }> =
    formulationSummary?.byCategory ??
    [...ingsByCategory.keys()].map((cat) => ({
      category: cat,
      displayName: humanise(cat),
      granules: ingsByCategory.get(cat)!.reduce(
        (s, i) => s + (granulesByCode.get(i.tsi_code ?? '') ?? i.granules ?? 0),
        0,
      ),
    }));

  let zebraIdx = 0; // global zebra index across all data rows

  for (const catEntry of categoryOrder) {
    const catIngs = ingsByCategory.get(catEntry.category) ?? [];
    if (catIngs.length === 0) continue;

    const tier = categoryPriority.get(catEntry.category) ?? '';
    const bandLabel = tier
      ? `${catEntry.displayName}   ·   ${tier}`
      : catEntry.displayName;

    // Category band row — merge columns A:B, granule subtotal in E
    const bandRow = sheet.addRow({
      wcode:    bandLabel,
      name:     '',
      dose:     '',
      unit:     '',
      granules: catEntry.granules,
      category: '',
      priority: '',
      targets:  '',
      rationale:'',
      cautions: '',
      evidence: '',
    });
    bandRow.height = 22;
    for (let c = 1; c <= COL_COUNT; c++) {
      const cell = bandRow.getCell(c);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.surfaceBand } };
      cell.font = { name: FONT, size: 9.5, bold: true, color: { argb: C.olive } };
      cell.border = {
        top:    { style: 'thin',  color: { argb: C.ruleMedium } },
        bottom: { style: 'thin',  color: { argb: C.ruleMedium } },
      };
    }
    // Granule subtotal in the Granules column
    bandRow.getCell('granules').alignment = { horizontal: 'right', vertical: 'middle' };
    bandRow.getCell('granules').font = { name: FONT, size: 9.5, bold: true, color: { argb: C.olive } };
    // Merge A:B for the label (leaves granules column independent)
    const rn = bandRow.number;
    sheet.mergeCells(`A${rn}:D${rn}`);

    // Ingredient data rows within this category
    for (const ing of catIngs) {
      const i = ing as ProposedIngredient & Record<string, unknown>;
      const targets = i.target_biomarkers ?? (i as any).target_biomarker_findings;
      const targetsText: string = Array.isArray(targets) ? targets.join(', ') : (targets as string) ?? '';
      const granules = granulesByCode.get(i.tsi_code ?? '') ?? i.granules ?? '—';
      const priority: string = (i as any).practitioner_review_priority ?? 'STANDARD';

      const row = sheet.addRow({
        wcode:    i.tsi_code ?? '—',
        name:     (i as any).common_name ?? i.ingredient_name ?? '—',
        dose:     i.proposed_dose ?? '—',
        unit:     i.dose_unit ?? '—',
        granules,
        category: humanise(i.category),
        priority,
        targets:  targetsText || '—',
        rationale:i.rationale_for_practitioner ?? '—',
        cautions: (i as any).practitioner_cautions ?? '—',
        evidence: (i as any).evidence_pointer ?? '—',
      });

      row.height = estimateRowHeight(i.rationale_for_practitioner, targetsText);
      applyZebraRow(row, zebraIdx % 2 === 1, COL_COUNT);
      zebraIdx++;

      // Cell-level styling
      row.getCell('wcode').font = { name: FONT, size: 9, color: { argb: C.inkLabel } };
      row.getCell('name').font = { name: FONT, size: 10.5, bold: true, color: { argb: C.oliveDark } };

      const doseCell = row.getCell('dose');
      doseCell.font = { name: FONT, size: 10, color: { argb: C.inkBody } };
      doseCell.alignment = { horizontal: 'right', vertical: 'top' };
      if (typeof doseCell.value === 'number') doseCell.numFmt = '0.##';

      row.getCell('unit').font = { name: FONT, size: 9, color: { argb: C.inkFaint } };
      row.getCell('unit').alignment = { vertical: 'top' };

      const granulesCell = row.getCell('granules');
      granulesCell.font = { name: FONT, size: 10, bold: true, color: { argb: C.olive } };
      granulesCell.alignment = { horizontal: 'right', vertical: 'top' };
      if (typeof granulesCell.value === 'number') granulesCell.numFmt = '0';

      row.getCell('category').font = { name: FONT, size: 9, color: { argb: C.inkFaint } };
      row.getCell('category').alignment = { vertical: 'top' };

      applyPriorityPill(row.getCell('priority'), priority);

      row.getCell('targets').font = { name: FONT, size: 9.5, color: { argb: C.inkSoft } };
      row.getCell('targets').alignment = { vertical: 'top', wrapText: true };

      row.getCell('rationale').font = { name: FONT, size: 9.5, color: { argb: C.inkBody } };
      row.getCell('rationale').alignment = { vertical: 'top', wrapText: true };

      row.getCell('cautions').font = { name: FONT, size: 9.5, color: { argb: C.inkFaint } };
      row.getCell('cautions').alignment = { vertical: 'top', wrapText: true };

      row.getCell('evidence').font = { name: FONT, size: 9, color: { argb: C.inkLabel } };
      row.getCell('evidence').alignment = { vertical: 'top', wrapText: true };
    }
  }

  // Total row — olive fill, ingredient count left, granule total in gold
  const totalGranules =
    formulationSummary?.totalGranules ??
    granuleVerification?.computed_total_granules ??
    ingredients.reduce((s, i) => s + (granulesByCode.get(i.tsi_code ?? '') ?? i.granules ?? 0), 0);

  const podPct = granuleVerification?.pod_budget_used != null
    ? `${(granuleVerification.pod_budget_used * 100).toFixed(1)}% of 720-granule pod`
    : '';
  const podWeight = granuleVerification?.computed_total_pod_weight_mg != null
    ? ` · ${Math.round(granuleVerification.computed_total_pod_weight_mg).toLocaleString('en-AU')} mg est.`
    : '';

  const totalRow = sheet.addRow({
    wcode:    `${ingredients.length} ingredient${ingredients.length !== 1 ? 's' : ''}`,
    name:     '',
    dose:     '',
    unit:     '',
    granules: totalGranules,
    category: podPct + podWeight,
    priority: '',
    targets:  '',
    rationale:'',
    cautions: '',
    evidence: '',
  });
  totalRow.height = 28;

  for (let c = 1; c <= COL_COUNT; c++) {
    const cell = totalRow.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.olive } };
    cell.font = { name: FONT, size: 10.5, bold: true, color: { argb: C.onOlive } };
    cell.border = { top: { style: 'medium', color: { argb: C.gold } } };
  }
  totalRow.getCell('granules').font = { name: FONT, size: 10.5, bold: true, color: { argb: C.onOliveGold } };
  totalRow.getCell('granules').alignment = { horizontal: 'right', vertical: 'middle' };
  if (typeof totalRow.getCell('granules').value === 'number') totalRow.getCell('granules').numFmt = '0';
  totalRow.getCell('wcode').alignment = { vertical: 'middle' };
  totalRow.getCell('category').font = { name: FONT, size: 9, color: { argb: C.onOlive } };
  totalRow.getCell('category').alignment = { vertical: 'middle' };

  // Suppress the auto-added header row (height 0 hides it; content is the row we styled above)
  sheet.getRow(1).height = 26; // already styled, keep visible
}

// ---------------------------------------------------------------------------
// SHEET 2: DOSE ADJUSTMENTS
// ---------------------------------------------------------------------------

function buildDoseAdjustmentsSheet(
  workbook: ExcelJS.Workbook,
  output: AnalysisOutput,
  tsiResolver?: TsiResolver,
): void {
  const sheet = workbook.addWorksheet('Dose Adjustments');
  const COL_COUNT = 3;

  sheet.columns = [
    { header: 'Adjustment Type',       key: 'type',        width: 28 },
    { header: 'Description',           key: 'description', width: 80 },
    { header: 'Affected Ingredient(s)',key: 'affected',    width: 32 },
  ];

  styleHeaderRow(sheet.getRow(1), COL_COUNT);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const adjustments = output.dose_adjustments ?? [];
  if (adjustments.length === 0) {
    const row = sheet.addRow({
      type: '(none)',
      description: 'No dose adjustments recorded on this formulation.',
      affected: '—',
    });
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.font = { name: FONT, size: 9.5, italic: true, color: { argb: C.inkFaint } };
    });
    return;
  }

  adjustments.forEach((adj, idx) => {
    const a = adj as DoseAdjustment & Record<string, unknown>;
    const affectedCodes = (a as any).affected_tsi_codes as string[] | undefined;

    // Human-readable label (first line) + machine key (shown small below in same cell)
    const machineKey = (a as any).adjustment_type ?? a.adjustment ?? '';
    const humanLabel = titleCase(machineKey);

    const row = sheet.addRow({
      type:        humanLabel,
      description: (a as any).description ?? a.note ?? a.reason ?? '—',
      affected:    resolveCodes(affectedCodes, tsiResolver),
    });

    row.height = 36;
    if (idx % 2 === 1) {
      row.eachCell({ includeEmpty: false }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.surfaceZebra } };
      });
    }
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.border = { bottom: { style: 'hair', color: { argb: C.ruleMedium } } };
    });

    row.getCell('type').font = { name: FONT, size: 9.5, bold: true, color: { argb: C.oliveDark } };
    row.getCell('type').alignment = { vertical: 'top', wrapText: true };

    row.getCell('description').font = { name: FONT, size: 9.5, color: { argb: C.inkBody } };
    row.getCell('description').alignment = { vertical: 'top', wrapText: true };

    // Normalise newlines in affected ingredient names (avoids rogue line breaks)
    const affectedVal = row.getCell('affected').value;
    if (typeof affectedVal === 'string') {
      row.getCell('affected').value = affectedVal.replace(/\r?\n/g, ', ');
    }
    row.getCell('affected').font = { name: FONT, size: 9.5, color: { argb: C.olive } };
    row.getCell('affected').alignment = { vertical: 'top', wrapText: true };
  });
}

// ---------------------------------------------------------------------------
// SHEET 3: STANDALONES
// ---------------------------------------------------------------------------

function buildStandalonesSheet(
  workbook: ExcelJS.Workbook,
  output: AnalysisOutput,
): void {
  const sheet = workbook.addWorksheet('Standalones');
  const COL_COUNT = 3;

  sheet.columns = [
    { header: 'Recommendation',  key: 'recommendation', width: 40 },
    { header: 'In Library?',     key: 'inLibrary',      width: 14 },
    { header: 'Practitioner Note',key: 'note',          width: 80 },
  ];

  styleHeaderRow(sheet.getRow(1), COL_COUNT);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const standalones = output.standalone_recommendations ?? [];
  const excluded   = output.excluded_from_pod ?? [];
  let rowIdx = 0;

  standalones.forEach((s) => {
    const item = s as StandaloneRecommendation;
    const inLib = item.in_library === true;
    const row = sheet.addRow({
      recommendation: item.recommendation ?? '—',
      inLibrary:      inLib ? 'Yes' : 'No',
      note:           (item as any).note_for_practitioner ?? '—',
    });
    row.height = Math.max(Math.ceil(((item.recommendation ?? '').length) / 40) * 12 + 8, 28);
    if (rowIdx % 2 === 1) {
      row.eachCell({ includeEmpty: false }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.surfaceZebra } };
      });
    }
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.border = { bottom: { style: 'hair', color: { argb: C.ruleMedium } } };
    });
    row.getCell('recommendation').font = { name: FONT, size: 9.5, color: { argb: C.inkBody } };
    row.getCell('recommendation').alignment = { vertical: 'top', wrapText: true };
    row.getCell('note').font = { name: FONT, size: 9.5, color: { argb: C.inkSoft } };
    row.getCell('note').alignment = { vertical: 'top', wrapText: true };

    // In Library? — pill fill
    const libCell = row.getCell('inLibrary');
    libCell.alignment = { horizontal: 'center', vertical: 'middle' };
    if (inLib) {
      libCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.goldPale } };
      libCell.font = { name: FONT, size: 9, color: { argb: C.goldDeep } };
    } else {
      libCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.surfacePill } };
      libCell.font = { name: FONT, size: 9, color: { argb: C.inkLabel } };
    }
    rowIdx++;
  });

  excluded.forEach((e) => {
    const item = e as ExcludedFromPod & Record<string, unknown>;
    const reason = item.reason_excluded ?? 'excluded';
    const row = sheet.addRow({
      recommendation: `${item.ingredient_name ?? '—'} (excluded from pod: ${reason})`,
      inLibrary:      'Yes',
      note:           (item as any).standalone_recommendation ?? '—',
    });
    row.height = 28;
    if (rowIdx % 2 === 1) {
      row.eachCell({ includeEmpty: false }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.surfaceZebra } };
      });
    }
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.border = { bottom: { style: 'hair', color: { argb: C.ruleMedium } } };
    });
    row.getCell('recommendation').font = { name: FONT, size: 9.5, color: { argb: C.inkBody } };
    row.getCell('recommendation').alignment = { vertical: 'top', wrapText: true };
    row.getCell('note').font = { name: FONT, size: 9.5, color: { argb: C.inkSoft } };
    row.getCell('note').alignment = { vertical: 'top', wrapText: true };
    const libCell = row.getCell('inLibrary');
    libCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.goldPale } };
    libCell.font = { name: FONT, size: 9, color: { argb: C.goldDeep } };
    libCell.alignment = { horizontal: 'center', vertical: 'middle' };
    rowIdx++;
  });

  if (rowIdx === 0) {
    const row = sheet.addRow({
      recommendation: '(none)',
      inLibrary:      '—',
      note:           'No standalone recommendations or pod exclusions on this formulation.',
    });
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.font = { name: FONT, size: 9.5, italic: true, color: { argb: C.inkFaint } };
    });
  }
}

// ---------------------------------------------------------------------------
// SHEET 4: CONTRAINDICATIONS
// ---------------------------------------------------------------------------

function buildContraindicationsSheet(
  workbook: ExcelJS.Workbook,
  output: AnalysisOutput,
  tsiResolver?: TsiResolver,
): void {
  const sheet = workbook.addWorksheet('Contraindications');
  const COL_COUNT = 4;

  sheet.columns = [
    { header: 'Severity',              key: 'severity',    width: 16 },
    { header: 'Flag',                  key: 'flag',        width: 28 },
    { header: 'Description',           key: 'description', width: 70 },
    { header: 'Affected Ingredient(s)',key: 'affected',    width: 32 },
  ];

  styleHeaderRow(sheet.getRow(1), COL_COUNT);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const flags = output.contraindication_flags ?? [];
  if (flags.length === 0) {
    const row = sheet.addRow({
      severity: '—', flag: '(none)',
      description: 'No contraindication or interaction flags raised on this panel.',
      affected: '—',
    });
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.font = { name: FONT, size: 9.5, italic: true, color: { argb: C.inkFaint } };
    });
    return;
  }

  // Sort by severity descending so highest-priority flags are always first
  const sorted = [...flags].sort((a, b) => {
    const sA = (a as any).severity ?? '';
    const sB = (b as any).severity ?? '';
    return severityRank(sB) - severityRank(sA);
  });

  sorted.forEach((f, idx) => {
    const flag = f as ContraindicationFlag & Record<string, unknown>;
    const severity: string = (flag as any).severity ?? '—';
    const affectedCodes = (flag as any).affected_tsi_codes as string[] | undefined;

    const row = sheet.addRow({
      severity:    titleCase(severity),
      flag:        (flag as any).flag ?? flag.ingredient ?? '—',
      description: (flag as any).description ?? flag.interaction_or_contraindication ?? '—',
      affected:    resolveCodes(affectedCodes, tsiResolver),
    });

    row.height = Math.max(
      Math.ceil(((flag as any).description ?? '').length / 70) * 12 + 8,
      28,
    );

    if (idx % 2 === 1) {
      row.eachCell({ includeEmpty: false }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.surfaceZebra } };
      });
    }
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.border = { bottom: { style: 'hair', color: { argb: C.ruleMedium } } };
    });

    applySeverityPill(row.getCell('severity'), severity);

    row.getCell('flag').font = { name: FONT, size: 9.5, bold: true, color: { argb: C.oliveDark } };
    row.getCell('flag').alignment = { vertical: 'top', wrapText: true };

    row.getCell('description').font = { name: FONT, size: 9.5, color: { argb: C.inkBody } };
    row.getCell('description').alignment = { vertical: 'top', wrapText: true };

    row.getCell('affected').font = { name: FONT, size: 9.5, color: { argb: C.olive } };
    row.getCell('affected').alignment = { vertical: 'top', wrapText: true };
  });
}

// ---------------------------------------------------------------------------
// SHEET 5: SUMMARY
// ---------------------------------------------------------------------------

function buildSummarySheet(
  workbook: ExcelJS.Workbook,
  output: AnalysisOutput,
  granuleVerification?: RouteGranuleVerification,
  routeAudit?: RouteAuditBlock,
  formulationSummary?: FormulationSummary,
): void {
  const sheet = workbook.addWorksheet('Summary');
  const COL_COUNT = 3;

  // No header: '' here — exceljs writes a phantom row 1 even for empty headers.
  // We manage all rows manually; columns just carry key + width.
  sheet.columns = [
    { key: 'label', width: 36 },
    { key: 'value', width: 16 },
    { key: 'bar',   width: 24 },
  ];

  // Compute (or reuse) summary — single source of truth for all figures on this sheet
  const summary: FormulationSummary | null = formulationSummary ?? (() => {
    if (output.proposed_formulation && granuleVerification?.computed_per_ingredient) {
      try { return deriveSummary(output.proposed_formulation, granuleVerification.computed_per_ingredient); }
      catch { return null; }
    }
    return null;
  })();

  const totalGranules = summary?.totalGranules ?? granuleVerification?.computed_total_granules ?? output.total_granules ?? 0;
  const podBudgetPct  = granuleVerification?.pod_budget_used != null
    ? `${(granuleVerification.pod_budget_used * 100).toFixed(1)}%` : '—';
  const podWeight     = granuleVerification?.computed_total_pod_weight_mg != null
    ? `${Math.round(granuleVerification.computed_total_pod_weight_mg).toLocaleString('en-AU')} mg` : '—';

  // ── Title ────────────────────────────────────────────────────────────────
  const titleRow = sheet.addRow({ label: 'Formulation Summary', value: '', bar: '' });
  titleRow.height = 32;
  titleRow.getCell('label').font = { name: FONT, size: 16, bold: true, color: { argb: C.oliveDark } };
  titleRow.getCell('label').alignment = { vertical: 'middle' };
  titleRow.getCell('label').border = { bottom: { style: 'medium', color: { argb: C.olive } } };
  titleRow.getCell('value').border = { bottom: { style: 'medium', color: { argb: C.olive } } };
  titleRow.getCell('bar').border   = { bottom: { style: 'medium', color: { argb: C.olive } } };

  // ── Headline metrics ─────────────────────────────────────────────────────
  sheet.addRow({}); // breathing room

  const metricHeader = sheet.addRow({ label: 'HEADLINE METRICS', value: '', bar: '' });
  metricHeader.height = 18;
  metricHeader.getCell('label').font = { name: FONT, size: 8, bold: true, color: { argb: C.inkLabel } };
  metricHeader.getCell('label').alignment = { vertical: 'middle' };

  // Three large metrics
  const bigMetrics: Array<[string, string | number]> = [
    ['Total granules (route-computed)', totalGranules],
    ['Pod budget utilisation', podBudgetPct],
    ['Pod weight (estimated)', podWeight],
  ];
  bigMetrics.forEach(([label, value]) => {
    const row = sheet.addRow({ label, value, bar: '' });
    row.height = 28;
    row.getCell('label').font = { name: FONT, size: 9, color: { argb: C.inkLabel } };
    row.getCell('label').alignment = { vertical: 'bottom' };
    row.getCell('value').font = { name: FONT, size: 18, bold: true, color: { argb: C.olive } };
    row.getCell('value').alignment = { horizontal: 'right', vertical: 'bottom' };
    row.getCell('value').border = { bottom: { style: 'hair', color: { argb: C.ruleStrong } } };
    row.getCell('label').border = { bottom: { style: 'hair', color: { argb: C.ruleStrong } } };
  });

  sheet.addRow({}); // breathing room

  // Six count metrics
  const countMetrics: Array<[string, number | string]> = [
    ['Ingredients in pod',           output.proposed_formulation?.length ?? 0],
    ['Items excluded from pod',      output.excluded_from_pod?.length ?? 0],
    ['Standalone recommendations',   output.standalone_recommendations?.length ?? 0],
    ['Recognised clinical patterns', output.recognised_patterns?.length ?? 0],
    ['Binding exclusions applied',   output.binding_exclusions_applied?.length ?? 0],
    ['Contraindication flags raised', output.contraindication_flags?.length ?? 0],
  ];
  countMetrics.forEach(([label, value], idx) => {
    const row = sheet.addRow({ label, value, bar: '' });
    row.height = 22;
    row.getCell('label').font = { name: FONT, size: 9.5, color: { argb: C.inkBody } };
    row.getCell('label').alignment = { vertical: 'middle' };
    row.getCell('value').font = { name: FONT, size: 12, bold: true, color: { argb: C.oliveDark } };
    row.getCell('value').alignment = { horizontal: 'right', vertical: 'middle' };
    if (idx % 2 === 1) {
      row.getCell('label').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.surfaceZebra } };
      row.getCell('value').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.surfaceZebra } };
    }
  });

  // ── Category breakdown ───────────────────────────────────────────────────
  sheet.addRow({});
  sheet.addRow({});

  const breakdownHeader = sheet.addRow({ label: 'GRANULE BUDGET BY CATEGORY', value: 'Granules', bar: 'Relative budget' });
  breakdownHeader.height = 20;
  for (let c = 1; c <= COL_COUNT; c++) {
    const cell = breakdownHeader.getCell(c);
    cell.font = { name: FONT, size: 8, bold: true, color: { argb: C.inkLabel } };
    cell.border = { bottom: { style: 'thin', color: { argb: C.gold } } };
  }
  breakdownHeader.getCell('value').alignment = { horizontal: 'right' };

  const categories = summary?.byCategory ?? [];
  const maxGranules = categories.length > 0 ? Math.max(...categories.map((c) => c.granules)) : 1;
  const BAR_SCALE = 18;

  categories.forEach((cat, idx) => {
    const barWidth = Math.max(Math.round((cat.granules / maxGranules) * BAR_SCALE), 1);
    const bar = '█'.repeat(barWidth);

    const row = sheet.addRow({ label: cat.displayName, value: cat.granules, bar });
    row.height = 22;
    row.getCell('label').font = { name: FONT, size: 9.5, color: { argb: C.inkBody } };
    row.getCell('label').alignment = { vertical: 'middle' };
    row.getCell('value').font = { name: FONT, size: 9.5, bold: true, color: { argb: C.olive } };
    row.getCell('value').alignment = { horizontal: 'right', vertical: 'middle' };
    if (typeof row.getCell('value').value === 'number') row.getCell('value').numFmt = '0';
    row.getCell('bar').font = { name: FONT, size: 9, color: { argb: C.gold } };
    row.getCell('bar').alignment = { vertical: 'middle' };
    if (idx % 2 === 1) {
      row.getCell('label').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.surfaceZebra } };
      row.getCell('value').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.surfaceZebra } };
      row.getCell('bar').fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.surfaceZebra } };
    }
  });

  // Total row — olive fill
  const totalRow = sheet.addRow({ label: 'Total', value: totalGranules, bar: '' });
  totalRow.height = 24;
  for (let c = 1; c <= COL_COUNT; c++) {
    const cell = totalRow.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.olive } };
    cell.font = { name: FONT, size: 10.5, bold: true, color: { argb: C.onOlive } };
    cell.border = { top: { style: 'medium', color: { argb: C.gold } } };
  }
  totalRow.getCell('value').font = { name: FONT, size: 10.5, bold: true, color: { argb: C.onOliveGold } };
  totalRow.getCell('value').alignment = { horizontal: 'right', vertical: 'middle' };
  if (typeof totalRow.getCell('value').value === 'number') totalRow.getCell('value').numFmt = '0';
  totalRow.getCell('label').alignment = { vertical: 'middle' };

  // Hide the auto-generated column header row (we manage headings ourselves)
  sheet.getRow(1).hidden = false; // row 1 is our title row — don't hide it
}

// ---------------------------------------------------------------------------
// PUBLIC ENTRY POINT
// ---------------------------------------------------------------------------

export interface GenerateFormulationScheduleOptions {
  output: AnalysisOutput;
  granuleVerification?: RouteGranuleVerification;
  routeAudit?: RouteAuditBlock;
  tsiResolver?: TsiResolver;
  /**
   * Pre-computed formulation summary from deriveSummary(). When provided,
   * buildSummarySheet and buildFormulationSheet read category totals exclusively
   * from this object — never from granule_budget_allocation_plan. Computed by
   * the orchestrator (scripts/generate-docs/index.ts) and passed to both
   * generators so both documents always reflect the same source.
   */
  formulationSummary?: FormulationSummary;
}

/**
 * Build the Recommended Formulation Schedule xlsx for a single submission
 * and return the file as a Buffer. The caller persists to disk.
 */
export async function generateFormulationSchedule(
  opts: GenerateFormulationScheduleOptions,
): Promise<Buffer> {
  const { output, granuleVerification, routeAudit, tsiResolver, formulationSummary } = opts;

  if (output.output_type === 'refusal') {
    return buildRefusalWorkbook(output);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'N of 1 Precision Formulation';
  workbook.created = new Date();
  workbook.modified = new Date();

  buildFormulationSheet(workbook, output, granuleVerification, formulationSummary);
  buildDoseAdjustmentsSheet(workbook, output, tsiResolver);
  buildStandalonesSheet(workbook, output);
  buildContraindicationsSheet(workbook, output, tsiResolver);
  buildSummarySheet(workbook, output, granuleVerification, routeAudit, formulationSummary);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

async function buildRefusalWorkbook(output: AnalysisOutput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Refusal');

  sheet.columns = [
    { header: 'Field', key: 'field', width: 24 },
    { header: 'Value', key: 'value', width: 80 },
  ];
  styleHeaderRow(sheet.getRow(1), 2);

  sheet.addRow({ field: 'Output type', value: output.output_type });
  sheet.addRow({ field: 'Trigger',     value: output.refusal_trigger ?? '—' });
  sheet.addRow({ field: 'Explanation', value: output.refusal_explanation ?? '—' });
  sheet.addRow({ field: 'Escalation',  value: output.escalation_recommended ? 'Recommended' : 'Not flagged' });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
