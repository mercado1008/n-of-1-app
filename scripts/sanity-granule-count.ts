/**
 * scripts/sanity-granule-count.ts
 *
 * One-shot: read last night's live-test-output.json (the 16-ingredient run)
 * and compute its actual granule cost against the v0.4.0 library data.
 *
 * Read-only. No schema validation, no route changes. Just answers:
 *   1. What was the granule total?
 *   2. Did the proposed dose units match the library's dose_per_granule_unit?
 *   3. Are any individual ingredients pathologically heavy on granules?
 *
 * Run via: npx tsx scripts/sanity-granule-count.ts <path-to-live-test-output.json>
 *   (or set LIVE_OUTPUT env var)
 */

import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
const LIBRARY_FILE = path.join(ROOT, "data", "library-built", "ingredients-library.json");

interface LibraryIngredient {
  tsi_code: string;
  active_ingredient: string;
  common_name?: string;
  dose_per_granule?: number;
  dose_per_granule_unit?: string;
  granule_weight_mg?: number;
  max_dose?: string;
}

interface LiveOutputIngredient {
  tsi_code: string;
  common_name: string;
  proposed_dose: number;
  dose_unit: string;
  // Other fields ignored for this sanity check.
}

interface LiveOutput {
  output_type: string;
  proposed_formulation: LiveOutputIngredient[];
  // Other fields ignored.
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

function main() {
  const arg = process.argv[2] ?? process.env.LIVE_OUTPUT;
  if (!arg) {
    console.error("Usage: npx tsx scripts/sanity-granule-count.ts <path-to-live-test-output.json>");
    console.error("   or set LIVE_OUTPUT env var.");
    process.exit(1);
  }
  const livePath = path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
  if (!fs.existsSync(livePath)) {
    console.error(`ERROR: live output file not found: ${livePath}`);
    process.exit(1);
  }
  if (!fs.existsSync(LIBRARY_FILE)) {
    console.error(`ERROR: library file not found: ${LIBRARY_FILE}`);
    process.exit(1);
  }

  const live: LiveOutput = JSON.parse(fs.readFileSync(livePath, "utf-8"));
  const lib: { ingredients: LibraryIngredient[]; metadata: { library_revision?: number } } = JSON.parse(
    fs.readFileSync(LIBRARY_FILE, "utf-8")
  );

  if (live.output_type !== "formulation") {
    console.error(`Live output is not a formulation (output_type=${live.output_type}). Nothing to compute.`);
    process.exit(1);
  }

  const libByTsi = new Map<string, LibraryIngredient>();
  for (const i of lib.ingredients) libByTsi.set(i.tsi_code, i);

  console.log("\n=== Sanity granule count ===");
  console.log(`Live output:      ${livePath}`);
  console.log(`Library revision: ${lib.metadata.library_revision ?? "unknown"}`);
  console.log(`Ingredients:      ${live.proposed_formulation.length}`);
  console.log("");

  console.log(
    pad("TSI", 11) +
      pad("Name", 30) +
      pad("Proposed", 14) +
      pad("Per-granule", 14) +
      pad("Granules", 10) +
      "Status"
  );
  console.log("-".repeat(110));

  let totalGranules = 0;
  let totalWeightMg = 0;
  const issues: string[] = [];

  for (const ing of live.proposed_formulation) {
    const libEntry = libByTsi.get(ing.tsi_code);
    const name = (ing.common_name ?? "").slice(0, 28);
    const proposed = `${ing.proposed_dose} ${ing.dose_unit}`;

    if (!libEntry) {
      console.log(
        pad(ing.tsi_code, 11) +
          pad(name, 30) +
          pad(proposed, 14) +
          pad("-", 14) +
          pad("-", 10) +
          "❌ TSI not in library"
      );
      issues.push(`${ing.tsi_code} (${ing.common_name}): TSI not in library`);
      continue;
    }

    const dpg = libEntry.dose_per_granule;
    const dpgUnit = libEntry.dose_per_granule_unit;

    if (dpg === undefined || !dpgUnit) {
      console.log(
        pad(ing.tsi_code, 11) +
          pad(name, 30) +
          pad(proposed, 14) +
          pad("-", 14) +
          pad("-", 10) +
          "❌ no per-granule data"
      );
      issues.push(`${ing.tsi_code} (${ing.common_name}): library has no per-granule data`);
      continue;
    }

    const perGranule = `${dpg} ${dpgUnit}`;

    const proposedUnitNorm = ing.dose_unit.trim().toLowerCase();
    const libUnitNorm = dpgUnit.trim().toLowerCase();

    if (proposedUnitNorm !== libUnitNorm) {
      console.log(
        pad(ing.tsi_code, 11) +
          pad(name, 30) +
          pad(proposed, 14) +
          pad(perGranule, 14) +
          pad("-", 10) +
          `⚠️  unit mismatch (proposed ${ing.dose_unit}, lib ${dpgUnit})`
      );
      issues.push(
        `${ing.tsi_code} (${ing.common_name}): unit mismatch — proposed in ${ing.dose_unit}, library expects ${dpgUnit}`
      );
      continue;
    }

    const granules = Math.ceil(ing.proposed_dose / dpg);
    totalGranules += granules;
    if (libEntry.granule_weight_mg !== undefined) {
      totalWeightMg += granules * libEntry.granule_weight_mg;
    }

    let flag = "";
    if (granules > 100) flag = "⚠️  heavy";
    else if (granules > 50) flag = "(heavy)";

    console.log(
      pad(ing.tsi_code, 11) +
        pad(name, 30) +
        pad(proposed, 14) +
        pad(perGranule, 14) +
        pad(String(granules), 10) +
        flag
    );
  }

  console.log("-".repeat(110));
  console.log("");
  console.log(`Total granules:      ${totalGranules} / 700  (${((totalGranules / 700) * 100).toFixed(1)}% of pod)`);
  if (totalWeightMg > 0) {
    console.log(`Total weight:        ${totalWeightMg.toFixed(0)} mg`);
  }
  console.log(`Pod headroom:        ${700 - totalGranules} granules unused`);

  if (issues.length > 0) {
    console.log("");
    console.log(`⚠️  ${issues.length} ingredient(s) couldn't be computed:`);
    for (const i of issues) console.log(`   - ${i}`);
  }

  console.log("=============================\n");
}

main();