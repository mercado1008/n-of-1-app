/**
 * build-library.ts
 *
 * Reads the supplier XLSX from data/library-source/ and writes a clean
 * ingredients-library.json to data/library-built/.
 *
 * Contract documented in docs/library-build.md (to be created in Phase 2).
 *
 * Run via: npm run build:library
 */

import ExcelJS from "exceljs";
import * as fs from "fs";
import * as path from "path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIR = path.join(ROOT, "data", "library-source");
const OUTPUT_DIR = path.join(ROOT, "data", "library-built");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "ingredients-library.json");

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ClinicalDetailsSchema = z.object({
  introduction: z.string().optional(),
  side_effects_and_risks: z.string().optional(),
  references: z.string().optional(),
});

const IngredientSchema = z.object({
  tsi_code: z.string(),
  available: z.boolean(),
  price_per_granule_aud: z.string().optional(),
  active_ingredient: z.string(),
  common_name: z.string().optional(),
  tsic_active_code: z.string().optional(),
  scientific_name: z.string().optional(),
  tga_approved_name: z.string().optional(),
  plant_part: z.string().optional(),
  preparation_type: z.string().optional(),
  extract_ratio: z.string().optional(),
  standardisation: z.string().optional(),
  label_expression: z.string().optional(),
  granule_weight_mg: z.number().optional(),
  max_dose: z.string().optional(),
  recommended_dose: z.string().optional(),
  unit_of_measure: z.string().optional(),
  category: z.string().optional(),
  regulatory_status: z.string().optional(),
  tga_restrictions: z.string().optional(),
  tga_warnings: z.string().optional(),
  max_dose_justification: z.string().optional(),
  clinical_details: ClinicalDetailsSchema.optional(),
});

const MetadataSchema = z.object({
  source_file: z.string(),
  library_revision: z.number().optional(),
  library_revision_date: z.string().optional(),
  built_at: z.string(),
  ingredient_count: z.number(),
  scheduling_note: z.string(),
});

const LibrarySchema = z.object({
  metadata: MetadataSchema,
  ingredients: z.array(IngredientSchema),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cellStr(row: ExcelJS.Row, col: number): string {
  const cell = row.getCell(col);
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && "richText" in v) {
    return v.richText.map((r: { text: string }) => r.text).join("").trim();
  }
  if (typeof v === "object" && "result" in v) {
    return String((v as ExcelJS.CellFormulaValue).result ?? "").trim();
  }
  return String(v).trim();
}

function cellNum(row: ExcelJS.Row, col: number): number | undefined {
  const cell = row.getCell(col);
  const v = cell.value;
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isNaN(n) ? undefined : n;
}

function toISO(value: ExcelJS.CellValue): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString().split("T")[0];
  const d = new Date(String(value));
  if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  return String(value);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // 1. Locate source file
  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`ERROR: source directory not found: ${SOURCE_DIR}`);
    process.exit(1);
  }
  const xlsxFiles = fs
    .readdirSync(SOURCE_DIR)
    .filter((f) => f.toLowerCase().endsWith(".xlsx"));

  if (xlsxFiles.length === 0) {
    console.error(`ERROR: no .xlsx file found in ${SOURCE_DIR}`);
    process.exit(1);
  }
  if (xlsxFiles.length > 1) {
    console.error(
      `ERROR: multiple .xlsx files found in ${SOURCE_DIR} — expected exactly one:\n  ${xlsxFiles.join("\n  ")}`
    );
    process.exit(1);
  }
  const sourceFile = xlsxFiles[0];
  const sourcePath = path.join(SOURCE_DIR, sourceFile);
  console.log(`\nSource file: ${sourceFile}`);

  // 2. Open workbook
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(sourcePath);

  // 3. Locate sheets
  const ingredientSheet = workbook.getWorksheet(" Ingredients Library");
  if (!ingredientSheet) {
    const available = workbook.worksheets.map((ws) => `"${ws.name}"`).join(", ");
    console.error(
      `ERROR: sheet " Ingredients Library" (with leading space) not found.\nAvailable sheets: ${available}`
    );
    process.exit(1);
  }

  const clinicalSheet = workbook.getWorksheet("Clinical details");
  if (!clinicalSheet) {
    console.warn(
      `WARN: "Clinical details" sheet not found — clinical_details will be omitted for all ingredients.`
    );
  }

  // 4. Read metadata from row 1 of ingredient sheet
  const metaRow = ingredientSheet.getRow(1);
  const libraryRevisionRaw = cellNum(metaRow, 7);
  const libraryRevisionDate = toISO(metaRow.getCell(5).value);

  console.log(`Library revision: ${libraryRevisionRaw ?? "(not found)"}`);
  console.log(`Library revision date: ${libraryRevisionDate ?? "(not found)"}`);

  // 5. Build clinical details map (TSI code → details)
  const clinicalMap = new Map<
    string,
    { introduction?: string; side_effects_and_risks?: string; references?: string }
  >();

  if (clinicalSheet) {
    clinicalSheet.eachRow((row, rowNum) => {
      if (rowNum === 1) return; // header
      const tsiCode = cellStr(row, 1);
      if (!tsiCode) return;
      clinicalMap.set(tsiCode, {
        introduction: cellStr(row, 4) || undefined,
        side_effects_and_risks: cellStr(row, 5) || undefined,
        references: cellStr(row, 6) || undefined,
      });
    });
    console.log(`Clinical details entries: ${clinicalMap.size}`);
  }

  // 6. Read ingredient rows (skip header row 1, also skip row 2 if it's a sub-header)
  type Ingredient = z.infer<typeof IngredientSchema>;
  const ingredients: Ingredient[] = [];
  let totalRows = 0;
  let skippedNoIngredient = 0;
  let skippedUnavailable = 0;
  let withClinical = 0;

  ingredientSheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return; // metadata / header row

    const availableRaw = cellStr(row, 2);
    const activeIngredient = cellStr(row, 4);
    const tsiCode = cellStr(row, 1);

    // Skip sub-header or column-header rows
    if (!tsiCode && !activeIngredient) return;

    totalRows++;

    // Skip rows without an active ingredient (cups, lids, etc.)
    if (!activeIngredient) {
      skippedNoIngredient++;
      return;
    }

    // Parse availability
    const available = availableRaw.toUpperCase() === "A";

    // Skip unavailable ingredients
    if (!available) {
      skippedUnavailable++;
      return;
    }

    // Build ingredient record
    const granuleWeightRaw = cellNum(row, 28);
    const clinical = clinicalMap.get(tsiCode);
    if (clinical) withClinical++;

    const ingredient: Ingredient = {
      tsi_code: tsiCode,
      available: true,
      price_per_granule_aud: cellStr(row, 3) || undefined,
      active_ingredient: activeIngredient,
      common_name: cellStr(row, 5) || undefined,
      tsic_active_code: cellStr(row, 6) || undefined,
      scientific_name: cellStr(row, 7) || undefined,
      tga_approved_name: cellStr(row, 9) || undefined,
      plant_part: cellStr(row, 10) || undefined,
      preparation_type: cellStr(row, 11) || undefined,
      extract_ratio: cellStr(row, 12) || undefined,
      standardisation: cellStr(row, 14) || undefined,
      label_expression: cellStr(row, 17) || undefined,
      granule_weight_mg: granuleWeightRaw,
      max_dose: cellStr(row, 29) || undefined,
      recommended_dose: cellStr(row, 30) || undefined,
      unit_of_measure: cellStr(row, 19) || undefined,
      category: cellStr(row, 31) || undefined,
      regulatory_status: cellStr(row, 32) || undefined,
      tga_restrictions: cellStr(row, 75) || undefined,
      tga_warnings: cellStr(row, 76) || undefined,
      max_dose_justification: cellStr(row, 123) || undefined,
      ...(clinical ? { clinical_details: clinical } : {}),
    };

    ingredients.push(ingredient);
  });

  // 7. Assemble output
  const output = {
    metadata: {
      source_file: sourceFile,
      library_revision: libraryRevisionRaw,
      library_revision_date: libraryRevisionDate,
      built_at: new Date().toISOString(),
      ingredient_count: ingredients.length,
      scheduling_note:
        "All ingredients in this MVP library are unscheduled. The S2/S3/S4 practitioner scope filter has no effect at this stage and will be activated in a future revision when scheduling status is added per ingredient.",
    },
    ingredients,
  };

  // 8. Validate with Zod
  const result = LibrarySchema.safeParse(output);
  if (!result.success) {
    console.error("\nERROR: Output failed Zod validation:");
    for (const issue of result.error.issues) {
      console.error(`  [${issue.path.join(".")}] ${issue.message}`);
    }
    process.exit(1);
  }

  // 9. Write output
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");

  // 10. Print summary
  console.log("\n--- Build summary ---");
  console.log(`Source file:               ${sourceFile}`);
  console.log(`Library revision:          ${libraryRevisionRaw ?? "unknown"}`);
  console.log(`Total data rows read:      ${totalRows}`);
  console.log(`Skipped (no ingredient):   ${skippedNoIngredient}`);
  console.log(`Skipped (unavailable):     ${skippedUnavailable}`);
  console.log(`Ingredients in output:     ${ingredients.length}`);
  console.log(`With clinical details:     ${withClinical}`);
  console.log(`Output:                    ${OUTPUT_FILE}`);
  console.log("---------------------\n");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
