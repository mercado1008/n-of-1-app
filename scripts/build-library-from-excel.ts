#!/usr/bin/env npx tsx
/**
 * scripts/build-library-from-excel.ts
 *
 * Converts the TSI Ingredients Library Excel workbook into the
 * ingredients-library.json format consumed by the moiety registry
 * and the Protocol Translator.
 *
 * Usage:
 *   npx tsx scripts/build-library-from-excel.ts \
 *     "data/library-built/TS Ingredients Library AUST Master Rev21 17Aug2026.xlsx"
 *
 * Output:
 *   data/library-built/ingredients-library.json  (overwrites in-place)
 *
 * Column mapping (row 3 = header row, data from row 4):
 *   1  tsi_code
 *   2  available  (A → true, else false)
 *   3  price_per_granule_aud
 *   4  active_ingredient
 *   5  common_name
 *   6  tsic_active_code
 *   7  scientific_name
 *   9  tga_approved_name
 *  10  plant_part
 *  11  preparation_type
 *  12  extract_ratio
 *  14  standardisation
 *  17  label_expression  (RichText → plain text)
 *  18  dose_per_granule  (TGA Label Expression Qty Line 1)
 *  19  dose_per_granule_unit / unit_of_measure
 *  20  equivalent_line_2_quantity
 *  21  equivalent_line_2_unit
 *  22  equivalent_line_3_quantity
 *  23  equivalent_line_3_unit
 *  24  equivalent_line_4_quantity
 *  25  equivalent_line_4_unit
 *  28  granule_weight_mg
 *  29  max_dose
 *  30  recommended_dose
 *  31  category
 *  32  regulatory_status
 *  75  tga_restrictions
 *  76  tga_warnings
 *
 * Clinical details sheet (col 1=code, 7=introduction, 8=side_effects_and_risks, 9=references)
 *
 * Preserved from the existing JSON (not present in the Excel):
 *   max_dose_justification — hand-curated clinical notes; kept from old JSON for matching codes.
 */

import ExcelJS from 'exceljs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collapse ExcelJS RichText or plain string to a plain text string. */
function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  // RichText
  if (typeof value === 'object' && 'richText' in (value as object)) {
    return (value as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('').trim();
  }
  return String(value).trim();
}

function cellNum(value: ExcelJS.CellValue): number | undefined {
  if (value == null) return undefined;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  return isNaN(n) ? undefined : n;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const xlsxPath = process.argv[2];
  if (!xlsxPath) {
    console.error('Usage: npx tsx scripts/build-library-from-excel.ts <path-to-xlsx>');
    process.exit(1);
  }

  const absPath = resolve(process.cwd(), xlsxPath);
  const outPath = resolve(process.cwd(), 'data/library-built/ingredients-library.json');
  const oldLibPath = outPath; // same file — read before overwriting

  // Load existing JSON to preserve max_dose_justification (not in Excel).
  type OldIngredient = { tsi_code: string; max_dose_justification?: string };
  const oldLib = JSON.parse(readFileSync(oldLibPath, 'utf8')) as {
    metadata: Record<string, unknown>;
    ingredients: OldIngredient[];
  };
  const oldJustifications = new Map<string, string>();
  for (const ing of oldLib.ingredients) {
    if (ing.max_dose_justification) oldJustifications.set(ing.tsi_code, ing.max_dose_justification);
  }

  console.log(`\nReading ${xlsxPath} …`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(absPath);

  const mainSheet  = wb.worksheets[0]; // ' Ingredients Library'
  const clinSheet  = wb.worksheets[2]; // 'Clinical details'

  // ── Clinical details by W-code ─────────────────────────────────────────────
  type ClinicalDetails = {
    introduction: string;
    side_effects_and_risks: string;
    references: string;
  };
  const clinicalMap = new Map<string, ClinicalDetails>();
  clinSheet.eachRow({ includeEmpty: false }, (row, rowIdx) => {
    if (rowIdx < 4) return; // skip header rows
    const code = cellText(row.getCell(1).value);
    if (!code.startsWith('W')) return;
    clinicalMap.set(code, {
      introduction:        cellText(row.getCell(7).value),
      side_effects_and_risks: cellText(row.getCell(8).value),
      references:          cellText(row.getCell(9).value),
    });
  });
  console.log(`Clinical details loaded for ${clinicalMap.size} ingredients.`);

  // ── Main ingredient rows ───────────────────────────────────────────────────
  const ingredients: Record<string, unknown>[] = [];

  mainSheet.eachRow({ includeEmpty: false }, (row, rowIdx) => {
    if (rowIdx < 4) return;

    const tsiCode = cellText(row.getCell(1).value);
    if (!tsiCode.startsWith('W')) return; // skip non-ingredient rows (cups, lids, key)

    const availRaw = cellText(row.getCell(2).value).toUpperCase();
    const available = availRaw === 'A';

    const labelExpr    = cellText(row.getCell(17).value);
    const dpg          = cellNum(row.getCell(18).value);
    const dpgUnit      = cellText(row.getCell(19).value);
    const equiv2qty    = cellNum(row.getCell(20).value);
    const equiv2unit   = cellText(row.getCell(21).value);
    const equiv3qty    = cellNum(row.getCell(22).value);
    const equiv3unit   = cellText(row.getCell(23).value);
    const equiv4qty    = cellNum(row.getCell(24).value);
    const equiv4unit   = cellText(row.getCell(25).value);
    const granuleWt    = cellNum(row.getCell(28).value);
    const maxDose      = cellNum(row.getCell(29).value);
    const recDose      = cellNum(row.getCell(30).value);

    const ing: Record<string, unknown> = {
      tsi_code:           tsiCode,
      available,
      price_per_granule_aud: cellText(row.getCell(3).value),
      active_ingredient:  cellText(row.getCell(4).value),
      common_name:        cellText(row.getCell(5).value),
      tsic_active_code:   cellText(row.getCell(6).value),
      scientific_name:    cellText(row.getCell(7).value),
      tga_approved_name:  cellText(row.getCell(9).value),
      plant_part:         cellText(row.getCell(10).value),
      preparation_type:   cellText(row.getCell(11).value),
      extract_ratio:      cellText(row.getCell(12).value),
      standardisation:    cellText(row.getCell(14).value),
      label_expression:   labelExpr,
      category:           cellText(row.getCell(31).value),
      regulatory_status:  cellText(row.getCell(32).value),
    };

    if (granuleWt !== undefined)  ing.granule_weight_mg          = granuleWt;
    if (dpg       !== undefined)  ing.dose_per_granule           = dpg;
                                  ing.dose_per_granule_unit      = dpgUnit;
    if (equiv2qty !== undefined)  ing.equivalent_line_2_quantity = equiv2qty;
    if (equiv2unit)               ing.equivalent_line_2_unit     = equiv2unit;
    if (equiv3qty !== undefined)  ing.equivalent_line_3_quantity = equiv3qty;
    if (equiv3unit)               ing.equivalent_line_3_unit     = equiv3unit;
    if (equiv4qty !== undefined)  ing.equivalent_line_4_quantity = equiv4qty;
    if (equiv4unit)               ing.equivalent_line_4_unit     = equiv4unit;

    if (maxDose !== undefined)    ing.max_dose                   = String(maxDose);
    if (recDose !== undefined)    ing.recommended_dose           = String(recDose);
                                  ing.unit_of_measure            = dpgUnit;

    ing.tga_restrictions = cellText(row.getCell(75).value);
    ing.tga_warnings     = cellText(row.getCell(76).value);

    // Preserve hand-curated max_dose_justification from old JSON
    ing.max_dose_justification = oldJustifications.get(tsiCode) ?? '';

    // Clinical details
    const clin = clinicalMap.get(tsiCode);
    ing.clinical_details = clin ?? {
      introduction:           '',
      side_effects_and_risks: '',
      references:             '',
    };

    ingredients.push(ing);
  });

  console.log(`Processed ${ingredients.length} W-code ingredients.`);

  // ── Build metadata ─────────────────────────────────────────────────────────
  // Extract revision number from filename
  const revMatch = xlsxPath.match(/Rev(\d+)/i);
  const revision = revMatch ? parseInt(revMatch[1], 10) : 0;
  const dateMatch = xlsxPath.match(/(\d{1,2}[A-Za-z]+\d{4})/);
  // Parse "17Aug2026" → "2026-08-17"
  let revDate = new Date().toISOString().slice(0, 10);
  if (dateMatch) {
    const parsed = new Date(dateMatch[1]);
    if (!isNaN(parsed.getTime())) revDate = parsed.toISOString().slice(0, 10);
  }

  const output = {
    metadata: {
      source_file:           xlsxPath.split('/').pop()!,
      library_revision:      revision,
      library_revision_date: revDate,
      built_at:              new Date().toISOString(),
      ingredient_count:      ingredients.length,
      scheduling_note:       (oldLib.metadata.scheduling_note as string) ?? '',
    },
    ingredients,
  };

  writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nWritten to ${outPath}`);
  console.log(`  Revision: ${revision} (${revDate})`);
  console.log(`  Ingredients: ${ingredients.length}`);

  // Summarise what's new vs old
  const oldCodes = new Set(oldLib.ingredients.map((i) => i.tsi_code));
  const newCodes = new Set(ingredients.map((i) => i.tsi_code as string));
  const added   = [...newCodes].filter((c) => !oldCodes.has(c));
  const removed = [...oldCodes].filter((c) => !newCodes.has(c));

  if (added.length > 0) {
    console.log(`\n  ✅ New ingredients added (${added.length}):`);
    for (const c of added) {
      const ing = ingredients.find((i) => i.tsi_code === c);
      console.log(`     ${c}  ${ing?.common_name}`);
    }
  }
  if (removed.length > 0) {
    console.log(`\n  ⚠️  Ingredients removed from old JSON (${removed.length}):`);
    for (const c of removed) console.log(`     ${c}`);
  }
  if (added.length === 0 && removed.length === 0) {
    console.log('\n  Same ingredient set as previous revision (no additions or removals).');
  }

  console.log('\nNext steps:');
  console.log('  1. npx tsx scripts/ingest-artg-export.ts data/artg-export.xlsx');
  console.log('  2. curl -X POST http://localhost:3000/api/dev/reset-cache');
  console.log('');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
