/**
 * scripts/generate-docs/formulation-schedule.ts
 *
 * Generates the Recommended Formulation Schedule .xlsx for a single submission.
 *
 * Five sheets:
 *   1. Formulation         — ingredient list with W Codes, doses, granules, rationale
 *   2. Dose Adjustments    — capped or sub-target doses with rationale
 *   3. Standalones         — items recommended outside the pod
 *   4. Contraindications   — safety flags with severity colouring
 *   5. Summary             — headline numbers + granule budget breakdown
 *
 * Uses exceljs (already installed). Brand styling (Forest/Gold/Sage/Cloud)
 * follows the same palette as the docx generator.
 *
 * Reads: AnalysisOutput, optional RouteGranuleVerification (preferred source
 * for granule counts; Claude's self-reported counts are a fallback),
 * optional tsi → common-name resolver.
 *
 * Writes: a Buffer that the caller persists to disk.
 */

import ExcelJS from 'exceljs';
import { COLOURS } from './brand';
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

// ---------------------------------------------------------------------------
// Brand constants for Excel (ARGB format — leading FF = opaque alpha)
// ---------------------------------------------------------------------------

const XL_COLOURS = {
  white: 'FFFFFFFF',
  black: 'FF000000',
  forest: 'FF535B50',
  gold: 'FFC3AF88',
  sageGreen: 'FFA7B7A5',
  cloud: 'FFE2E0D9',
  greyText: 'FF666666',
  draftRed: 'FF8B2A2A',
  lightGrey: 'FFCCCCCC',
} as const;

const FONT_BODY = 'Roboto';
const FONT_BODY_FALLBACK = 'Arial';
const BODY_SIZE = 10;
const HEADER_SIZE = 11;

// ---------------------------------------------------------------------------
// Display helpers — internal taxonomy → practitioner-readable strings
// ---------------------------------------------------------------------------

// Mapping for therapeutic category codes used in granule_budget_allocation_plan
// and proposed_formulation. Internal snake_case → display string.
const CATEGORY_DISPLAY_NAMES: Record<string, string> = {
  antioxidant_redox: 'Antioxidant / Redox',
  anti_inflammatory_core: 'Anti-inflammatory Core',
  mitochondrial_cardiovascular: 'Mitochondrial / Cardiovascular',
  b_vitamins_methylation: 'B-Vitamins / Methylation',
  heavy_metal_detox: 'Heavy Metal Detox',
  minerals: 'Minerals',
  vitamin_d_c_neurotransmitter: 'Vitamin D / C / Neurotransmitter',
  thyroid_adaptogenic: 'Thyroid / Adaptogenic',
  blood_glucose_insulin: 'Blood Glucose / Insulin',
  gastrointestinal: 'Gastrointestinal',
  hormone_balance: 'Hormone Balance',
  cognitive_neuro: 'Cognitive / Neuro',
  immune_support: 'Immune Support',
  cardiovascular_lipids: 'Cardiovascular / Lipids',
};

function humanise(category: string | undefined): string {
  if (!category) return '—';
  if (CATEGORY_DISPLAY_NAMES[category]) return CATEGORY_DISPLAY_NAMES[category];
  // Fallback: snake_case → Title Case
  return category
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Cell styling helpers
// ---------------------------------------------------------------------------

function applyHeaderRowStyle(row: ExcelJS.Row): void {
  row.height = 26;
  row.eachCell({ includeEmpty: false }, (cell) => {
    cell.font = {
      name: FONT_BODY,
      size: HEADER_SIZE,
      bold: true,
      color: { argb: XL_COLOURS.forest },
    };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: XL_COLOURS.cloud },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.border = {
      bottom: { style: 'medium', color: { argb: XL_COLOURS.gold } },
    };
  });
}

function applyBandedRowStyle(row: ExcelJS.Row, isAlt: boolean): void {
  row.eachCell({ includeEmpty: false }, (cell) => {
    cell.font = cell.font ?? { name: FONT_BODY, size: BODY_SIZE };
    cell.font = { ...cell.font, name: cell.font.name ?? FONT_BODY, size: cell.font.size ?? BODY_SIZE };
    cell.alignment = cell.alignment ?? { vertical: 'top', wrapText: true };
    cell.alignment = { vertical: 'top', wrapText: true, ...cell.alignment };
    if (isAlt) {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: XL_COLOURS.cloud },
      };
    }
  });
}

function setPriorityCellColour(cell: ExcelJS.Cell, priority: string): void {
  const p = (priority ?? '').toUpperCase();
  let colour: string | undefined;
  if (p.includes('HIGH') || p.includes('URGENT')) colour = XL_COLOURS.draftRed;
  else if (p.includes('WATCH') || p.includes('MONITOR')) colour = XL_COLOURS.gold;
  // STANDARD or other — leave default
  if (colour) {
    cell.font = { ...cell.font, color: { argb: colour }, bold: true };
  }
}

function setSeverityCellColour(cell: ExcelJS.Cell, severity: string): void {
  const s = (severity ?? '').toLowerCase();
  let colour: string | undefined;
  if (s.includes('absolute') || s.includes('critical') || s.includes('high')) colour = XL_COLOURS.draftRed;
  else if (s.includes('moderate') || s.includes('caution') || s.includes('monitor')) colour = XL_COLOURS.gold;
  if (colour) {
    cell.font = { ...cell.font, color: { argb: colour }, bold: true };
  }
}

// ---------------------------------------------------------------------------
// Resolver helper — TSI codes → common ingredient names
// ---------------------------------------------------------------------------

export type TsiResolver = (tsiCode: string) => string | undefined;

function resolveCodes(codes: string[] | undefined, resolver?: TsiResolver): string {
  if (!Array.isArray(codes) || codes.length === 0) return '—';
  return codes
    .map((c) => resolver?.(c) ?? '—')
    .filter((n) => n !== '—')
    .join(', ') || '—';
}

// ---------------------------------------------------------------------------
// SHEET 1: FORMULATION
// ---------------------------------------------------------------------------

function buildFormulationSheet(
  workbook: ExcelJS.Workbook,
  output: AnalysisOutput,
  granuleVerification?: RouteGranuleVerification,
): void {
  const sheet = workbook.addWorksheet('Formulation');

  // Column definitions
  sheet.columns = [
    { header: 'W Code', key: 'wcode', width: 14 },
    { header: 'Common Name', key: 'name', width: 28 },
    { header: 'Proposed Dose', key: 'dose', width: 14 },
    { header: 'Unit', key: 'unit', width: 8 },
    { header: 'Granules', key: 'granules', width: 10 },
    { header: 'Category', key: 'category', width: 22 },
    { header: 'Review Priority', key: 'priority', width: 14 },
    { header: 'Target Biomarker Findings', key: 'targets', width: 32 },
    { header: 'Rationale for Practitioner', key: 'rationale', width: 60 },
    { header: 'Practitioner Cautions', key: 'cautions', width: 40 },
    { header: 'Evidence Pointer', key: 'evidence', width: 40 },
  ];

  applyHeaderRowStyle(sheet.getRow(1));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  // Build a lookup of route-computed granules by W Code
  const granulesByCode = new Map<string, number>();
  for (const ci of granuleVerification?.computed_per_ingredient ?? []) {
    if (ci.tsi_code) granulesByCode.set(ci.tsi_code, (ci as any).computed_granules ?? ci.granules_computed ?? 0);
  }

  const ingredients = output.proposed_formulation ?? [];
  ingredients.forEach((ing, idx) => {
    const i = ing as ProposedIngredient & Record<string, unknown>;
    const targets = i.target_biomarkers ?? (i as any).target_biomarker_findings;
    const targetsText = Array.isArray(targets) ? targets.join(', ') : targets ?? '';
    const granules = granulesByCode.get(i.tsi_code ?? '') ?? i.granules ?? '—';

    const rowData = {
      wcode: i.tsi_code ?? '—',
      name: (i as any).common_name ?? i.ingredient_name ?? '—',
      dose: i.proposed_dose ?? '—',
      unit: i.dose_unit ?? '—',
      granules: granules,
      category: humanise(i.category) ?? '—',
      priority: (i as any).practitioner_review_priority ?? 'STANDARD',
      targets: targetsText || '—',
      rationale: i.rationale_for_practitioner ?? '—',
      cautions: (i as any).practitioner_cautions ?? '—',
      evidence: (i as any).evidence_pointer ?? '—',
    };

    const row = sheet.addRow(rowData);
    applyBandedRowStyle(row, idx % 2 === 1);
    // Colour the priority cell
    const priorityCell = row.getCell('priority');
    setPriorityCellColour(priorityCell, rowData.priority);
    // Right-align numeric columns
    row.getCell('dose').alignment = { horizontal: 'right', vertical: 'top' };
    row.getCell('granules').alignment = { horizontal: 'right', vertical: 'top' };
  });
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

  sheet.columns = [
    { header: 'Adjustment Type', key: 'type', width: 28 },
    { header: 'Description', key: 'description', width: 80 },
    { header: 'Affected Ingredient(s)', key: 'affected', width: 32 },
  ];

  applyHeaderRowStyle(sheet.getRow(1));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const adjustments = output.dose_adjustments ?? [];
  if (adjustments.length === 0) {
    const row = sheet.addRow({
      type: '(none)',
      description: 'No dose adjustments recorded on this formulation.',
      affected: '—',
    });
    row.getCell('type').font = { name: FONT_BODY, size: BODY_SIZE, italic: true, color: { argb: XL_COLOURS.greyText } };
    row.getCell('description').font = { name: FONT_BODY, size: BODY_SIZE, italic: true, color: { argb: XL_COLOURS.greyText } };
    return;
  }

  adjustments.forEach((adj, idx) => {
    const a = adj as DoseAdjustment & Record<string, unknown>;
    const affectedCodes = (a as any).affected_tsi_codes as string[] | undefined;
    const row = sheet.addRow({
      type: (a as any).adjustment_type ?? a.adjustment ?? '—',
      description: (a as any).description ?? a.note ?? a.reason ?? '—',
      affected: resolveCodes(affectedCodes, tsiResolver),
    });
    applyBandedRowStyle(row, idx % 2 === 1);
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

  sheet.columns = [
    { header: 'Recommendation', key: 'recommendation', width: 40 },
    { header: 'In Library?', key: 'inLibrary', width: 14 },
    { header: 'Practitioner Note', key: 'note', width: 80 },
  ];

  applyHeaderRowStyle(sheet.getRow(1));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  // Combine in-pod-adjacent items: standalone_recommendations + excluded_from_pod
  // (excluded items get rendered here because they carry standalone_recommendation
  // text that the practitioner needs).
  const standalones = output.standalone_recommendations ?? [];
  const excluded = output.excluded_from_pod ?? [];

  let rowIdx = 0;

  // First section: explicit standalone_recommendations
  standalones.forEach((s) => {
    const item = s as StandaloneRecommendation;
    const row = sheet.addRow({
      recommendation: item.recommendation ?? '—',
      inLibrary: item.in_library === true ? 'Yes' : 'No',
      note: (item as any).note_for_practitioner ?? '—',
    });
    applyBandedRowStyle(row, rowIdx % 2 === 1);
    rowIdx++;
  });

  // Second section: excluded_from_pod items (each carries a standalone_recommendation text)
  excluded.forEach((e) => {
    const item = e as ExcludedFromPod & Record<string, unknown>;
    const reason = item.reason_excluded ?? 'excluded';
    const row = sheet.addRow({
      recommendation: `${item.ingredient_name ?? '—'} (excluded from pod: ${reason})`,
      inLibrary: 'Yes',
      note: (item as any).standalone_recommendation ?? '—',
    });
    applyBandedRowStyle(row, rowIdx % 2 === 1);
    rowIdx++;
  });

  if (rowIdx === 0) {
    const row = sheet.addRow({
      recommendation: '(none)',
      inLibrary: '—',
      note: 'No standalone recommendations or pod exclusions on this formulation.',
    });
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.font = { name: FONT_BODY, size: BODY_SIZE, italic: true, color: { argb: XL_COLOURS.greyText } };
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

  sheet.columns = [
    { header: 'Severity', key: 'severity', width: 16 },
    { header: 'Flag', key: 'flag', width: 28 },
    { header: 'Description', key: 'description', width: 70 },
    { header: 'Affected Ingredient(s)', key: 'affected', width: 32 },
  ];

  applyHeaderRowStyle(sheet.getRow(1));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const flags = output.contraindication_flags ?? [];
  if (flags.length === 0) {
    const row = sheet.addRow({
      severity: '—',
      flag: '(none)',
      description: 'No contraindication or interaction flags raised on this panel.',
      affected: '—',
    });
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.font = { name: FONT_BODY, size: BODY_SIZE, italic: true, color: { argb: XL_COLOURS.greyText } };
    });
    return;
  }

  flags.forEach((f, idx) => {
    const flag = f as ContraindicationFlag & Record<string, unknown>;
    const severity = (flag as any).severity ?? '—';
    const affectedCodes = (flag as any).affected_tsi_codes as string[] | undefined;

    const row = sheet.addRow({
      severity: severity,
      flag: (flag as any).flag ?? flag.ingredient ?? '—',
      description: (flag as any).description ?? flag.interaction_or_contraindication ?? '—',
      affected: resolveCodes(affectedCodes, tsiResolver),
    });
    applyBandedRowStyle(row, idx % 2 === 1);
    setSeverityCellColour(row.getCell('severity'), severity);
  });
}

// ---------------------------------------------------------------------------
// SHEET 5: SUMMARY (last sheet)
// ---------------------------------------------------------------------------

function buildSummarySheet(
  workbook: ExcelJS.Workbook,
  output: AnalysisOutput,
  granuleVerification?: RouteGranuleVerification,
  routeAudit?: RouteAuditBlock,
): void {
  const sheet = workbook.addWorksheet('Summary');

  sheet.columns = [
    { header: '', key: 'label', width: 36 },
    { header: '', key: 'value', width: 22 },
  ];

  // Title row
  const titleRow = sheet.addRow({ label: 'Formulation Summary', value: '' });
  titleRow.height = 28;
  titleRow.getCell('label').font = {
    name: FONT_BODY,
    size: 16,
    bold: true,
    color: { argb: XL_COLOURS.forest },
  };
  titleRow.getCell('label').alignment = { vertical: 'middle' };

  sheet.addRow({}); // breathing room

  // Headline numbers block
  const headlineHeader = sheet.addRow({ label: 'Headline Numbers', value: '' });
  headlineHeader.getCell('label').font = { name: FONT_BODY, size: 12, bold: true, color: { argb: XL_COLOURS.forest } };
  headlineHeader.getCell('label').border = { bottom: { style: 'medium', color: { argb: XL_COLOURS.gold } } };
  headlineHeader.getCell('value').border = { bottom: { style: 'medium', color: { argb: XL_COLOURS.gold } } };

  const totalGranules = granuleVerification?.computed_total_granules ?? output.total_granules ?? '—';
  const podBudgetPct = granuleVerification?.pod_budget_used != null
    ? `${(granuleVerification.pod_budget_used * 100).toFixed(1)}%`
    : '—';
  const podWeight = granuleVerification?.computed_total_pod_weight_mg != null
    ? `${Math.round(granuleVerification.computed_total_pod_weight_mg).toLocaleString('en-AU')} mg`
    : '—';
  const ingredientCount = output.proposed_formulation?.length ?? 0;
  const excludedCount = output.excluded_from_pod?.length ?? 0;
  const standaloneCount = output.standalone_recommendations?.length ?? 0;
  const patternsCount = output.recognised_patterns?.length ?? 0;
  const bindingExclusionsCount = output.binding_exclusions_applied?.length ?? 0;
  const contraindicationsCount = output.contraindication_flags?.length ?? 0;

  const headlineRows: Array<[string, string | number]> = [
    ['Total granules (route-computed)', totalGranules],
    ['Pod budget utilisation', podBudgetPct],
    ['Pod weight (estimated)', podWeight],
    ['Ingredients in pod', ingredientCount],
    ['Items excluded from pod', excludedCount],
    ['Standalone recommendations', standaloneCount],
    ['Recognised clinical patterns', patternsCount],
    ['Binding exclusions applied', bindingExclusionsCount],
    ['Contraindication flags raised', contraindicationsCount],
  ];

  headlineRows.forEach(([label, value], idx) => {
    const row = sheet.addRow({ label, value });
    row.getCell('label').font = { name: FONT_BODY, size: BODY_SIZE };
    row.getCell('value').font = { name: FONT_BODY, size: BODY_SIZE, bold: true };
    row.getCell('value').alignment = { horizontal: 'right' };
    if (idx % 2 === 1) {
      row.eachCell({ includeEmpty: false }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOURS.cloud } };
      });
    }
  });

  sheet.addRow({});
  sheet.addRow({});

  // Granule budget breakdown by category
  const breakdownHeader = sheet.addRow({ label: 'Granule Budget Breakdown by Category', value: '' });
  breakdownHeader.getCell('label').font = { name: FONT_BODY, size: 12, bold: true, color: { argb: XL_COLOURS.forest } };
  breakdownHeader.getCell('label').border = { bottom: { style: 'medium', color: { argb: XL_COLOURS.gold } } };
  breakdownHeader.getCell('value').border = { bottom: { style: 'medium', color: { argb: XL_COLOURS.gold } } };

  // Reuse the two-column layout: category name → granules allocated (with priority annotation)
  const breakdownSubHeader = sheet.addRow({ label: 'Category (priority)', value: 'Granules allocated' });
  breakdownSubHeader.getCell('label').font = { name: FONT_BODY, size: HEADER_SIZE, bold: true, color: { argb: XL_COLOURS.forest } };
  breakdownSubHeader.getCell('value').font = { name: FONT_BODY, size: HEADER_SIZE, bold: true, color: { argb: XL_COLOURS.forest } };
  breakdownSubHeader.getCell('value').alignment = { horizontal: 'right' };
  breakdownSubHeader.eachCell({ includeEmpty: false }, (cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOURS.cloud } };
  });

  const plan = output.granule_budget_allocation_plan ?? [];
  let planTotal = 0;
  plan.forEach((entry, idx) => {
    const e = entry as AllocationPlanEntry;
    const cat = e.category ?? '—';
    const priority = e.priority ?? '';
    const granules = e.granules_allocated ?? 0;
    planTotal += granules;

    const row = sheet.addRow({
      label: priority ? `${humanise(cat)} (${priority})` : humanise(cat),
      value: granules,
    });
    row.getCell('label').font = { name: FONT_BODY, size: BODY_SIZE };
    row.getCell('value').font = { name: FONT_BODY, size: BODY_SIZE };
    row.getCell('value').alignment = { horizontal: 'right' };
    if (idx % 2 === 1) {
      row.eachCell({ includeEmpty: false }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOURS.cloud } };
      });
    }
  });

  // Plan total row
  const planTotalRow = sheet.addRow({ label: 'Plan total', value: planTotal });
  planTotalRow.getCell('label').font = { name: FONT_BODY, size: BODY_SIZE, bold: true, color: { argb: XL_COLOURS.forest } };
  planTotalRow.getCell('value').font = { name: FONT_BODY, size: BODY_SIZE, bold: true, color: { argb: XL_COLOURS.forest } };
  planTotalRow.getCell('value').alignment = { horizontal: 'right' };
  planTotalRow.getCell('label').border = { top: { style: 'medium', color: { argb: XL_COLOURS.gold } } };
  planTotalRow.getCell('value').border = { top: { style: 'medium', color: { argb: XL_COLOURS.gold } } };

  // Hide column headers row (we manage headings ourselves)
  sheet.getRow(1).height = 0;
}

// ---------------------------------------------------------------------------
// PUBLIC ENTRY POINT
// ---------------------------------------------------------------------------

export interface GenerateFormulationScheduleOptions {
  output: AnalysisOutput;
  granuleVerification?: RouteGranuleVerification;
  routeAudit?: RouteAuditBlock;
  tsiResolver?: TsiResolver;
}

/**
 * Build the Recommended Formulation Schedule xlsx for a single submission
 * and return the file as a Buffer. The caller persists to disk.
 */
export async function generateFormulationSchedule(
  opts: GenerateFormulationScheduleOptions,
): Promise<Buffer> {
  const { output, granuleVerification, routeAudit, tsiResolver } = opts;

  if (output.output_type === 'refusal') {
    // Refusal path: minimal workbook — just an explanatory sheet
    return buildRefusalWorkbook(output);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'N of 1 Precision Formulation';
  workbook.created = new Date();
  workbook.modified = new Date();

  buildFormulationSheet(workbook, output, granuleVerification);
  buildDoseAdjustmentsSheet(workbook, output, tsiResolver);
  buildStandalonesSheet(workbook, output);
  buildContraindicationsSheet(workbook, output, tsiResolver);
  buildSummarySheet(workbook, output, granuleVerification, routeAudit);

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
  applyHeaderRowStyle(sheet.getRow(1));

  sheet.addRow({ field: 'Output type', value: output.output_type });
  sheet.addRow({ field: 'Trigger', value: output.refusal_trigger ?? '—' });
  sheet.addRow({ field: 'Explanation', value: output.refusal_explanation ?? '—' });
  sheet.addRow({ field: 'Escalation', value: output.escalation_recommended ? 'Recommended' : 'Not flagged' });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
