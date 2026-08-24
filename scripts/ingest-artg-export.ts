#!/usr/bin/env npx tsx
/**
 * scripts/ingest-artg-export.ts  (v2 — TGA public export format)
 *
 * Convert a TGA ARTG public export (.xlsx) into the candidates.json format
 * consumed by the justification engine.
 *
 * Usage:
 *   npx tsx scripts/ingest-artg-export.ts <artg-export.xlsx> [options]
 *
 * Options:
 *   --out <path>     Output path for candidates.json  (default: candidates.json)
 *   --sponsor <name> Filter candidates output to sponsors whose name contains
 *                    <name> (case-insensitive substring match). Default: all.
 *                    Reports always reflect the full dataset.
 *   --limit <n>      Only process the first N product rows (for testing).
 *
 * Output files (always written):
 *   candidates.json        — CommercialMedicine[] for the engine
 *   artg-alias-report.json — Unmatched names, inverse moiety list, alias coverage
 *
 * ── TGA EXPORT FORMAT ─────────────────────────────────────────────────────
 *
 * Download: TGA ARTG Visualisation Tool — filter to Listed medicines, export xlsx.
 *
 * One row per product. Active ingredient data is in a single cell:
 *   "Name, Quantity: X unit (Equivalent: Name, Qty X unit; ...); ..."
 *
 * Multiple ingredients are separated by "; " at the top level.
 * Equivalents (dry-herb equivalent, elemental equivalent, etc.) are inside
 * parentheses and separated by "; Equivalent: " within that block.
 *
 * Column headers expected (update COLUMN_MAP if yours differ):
 *   ARTG ID              Numeric ARTG entry identifier
 *   Product Name         Full product name
 *   Sponsor Name         Sponsor/distributor legal name
 *   Active Ingredients   Structured ingredient string (parsed by this script)
 *   Excipient Ingredients Excipient string (names only — amounts not published)
 *   ARTG Category        "Listed Medicine", "Registered Medicine", etc.
 *   Dosage Form          "Tablet, film coated", "Capsule, hard", etc.
 *
 * ── MOIETY MATCHING — THREE PASSES ────────────────────────────────────────
 *
 * For each parsed ingredient block:
 *
 *   Step A — Resolve the primary ingredient name (pass 1/2/3).
 *     Pass 1: exact (case-insensitive) against registry moietyName + artgAliases.
 *     Pass 2: hand-curated alias lookup in data/artg-aliases.json.
 *     Pass 3: first-token prefix — SUGGEST ONLY. Never auto-assigned.
 *
 *   Step B — Quantity selection.
 *     If the matched moiety basis is ELEMENTAL (mineral), look for an equivalent
 *     entry that resolves to the same moiety via "equivalent {name}" alias key.
 *     If found, use the equivalent quantity (the elemental amount published by TGA)
 *     rather than the salt/chelate amount in the primary row.
 *     For all other bases (herbs, vitamins, synthetics), use the primary quantity.
 *
 *   Step C — Equivalent fallback.
 *     If the primary name did NOT match, try each equivalent name:
 *       (i)  exact match of equivName,
 *       (ii) tryMatch("equivalent {equivName}") — catches alias keys like
 *            "equivalent magnesium" → "Magnesium (elemental)".
 *     Use the equivalent quantity on match.
 *
 * ── UNITS ──────────────────────────────────────────────────────────────────
 *   TGA uses "microgram" (spelled out); normalised to "mcg".
 *   "g" is converted to mg (×1000) for consistency with the engine.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import ExcelJS from 'exceljs';
import { moietyRegistry, type MoietyDefinition } from '../src/lib/compounding/moiety-registry';
import type { CommercialMedicine, NormalisedActive, DoseForm } from '../src/lib/compounding/justification-engine';

// ---------------------------------------------------------------------------
// Configuration — update if your TGA export uses different column header names
// ---------------------------------------------------------------------------

const COLUMN_MAP = {
  artgId:             'ARTG ID',
  productName:        'Product Name',
  sponsor:            'Sponsor Name',
  activeIngredients:  'Active Ingredients',
  excipientIngredients: 'Excipient Ingredients',
  artgCategory:       'ARTG Category',
  dosageForm:         'Dosage Form',
};

/** Snapshot date embedded in every CommercialMedicine (ISO date, set at run time). */
const SNAPSHOT_DATE = new Date().toISOString().slice(0, 10);

/**
 * Physiological ceiling for ELEMENTAL mineral moieties (in mg, after unit
 * normalisation). Any product unit reporting more than this amount is almost
 * certainly bad ARTG data — either the salt-form mass appearing in an
 * "Equivalent …" row, or a per-container amount from a multi-serve product.
 *
 * Basis: TGA upper intake levels × 3 (conservative headroom for high-dose
 * therapeutic products). Add new minerals here only if the library supports them.
 *
 * Caps NOT listed: Calcium (2000 mg), Magnesium (800 mg), Iron (50 mg),
 * Iodine (1 mg expressed as mcg → handled separately), Selenium (0.4 mg/mcg).
 * Those can be added if the same defect is observed for those moieties.
 */
const ELEMENTAL_AMOUNT_CAPS_MG: Record<string, number> = {
  // TGA UL 40 mg/day. Legitimate therapeutic caps ≤ 60 mg; anything higher
  // is almost certainly a zinc salt form amount stored in the equivalence row.
  'Zinc (elemental)': 60,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AliasEntry { target: string; verified: boolean; }

interface AliasStore {
  map: Map<string, string>;
  unverifiedKeys: Set<string>;
  markFired(normKey: string, resolved: boolean): void;
  report(): AliasCoverageReport;
}

interface AliasCoverageReport {
  firedResolved: string[];
  firedBroken:   string[];
  unfired:       string[];
  verifiedFired: string[];
}

interface AliasMiss {
  artgIngredientName:    string;
  productsContainingIt:  number;
  pass3PrefixCandidates: string[];
}

/** One parsed ingredient block from the structured Active Ingredients cell. */
interface IngredientBlock {
  primaryName:     string;
  primaryQuantity: number;
  primaryUnit:     string;
  equivalents: Array<{ name: string; quantity: number; unit: string }>;
}

interface MatchResult {
  def: MoietyDefinition;
  pass: 1 | 2;
}

interface MatchAttempt {
  match: MatchResult | null;
  pass3Suggestions: string[];
  firedAliasKey: string | null;
}

// ---------------------------------------------------------------------------
// Alias store
// ---------------------------------------------------------------------------

function buildAliasStore(filePath: string): AliasStore {
  const map            = new Map<string, string>();
  const unverifiedKeys = new Set<string>();
  const firedResolved  = new Set<string>();
  const firedBroken    = new Set<string>();
  const verifiedFired  = new Set<string>();

  if (existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith('_')) continue;
        const normKey = k.toLowerCase().trim();
        let target: string | undefined;
        let verified = true;
        if (typeof v === 'string') {
          target = v;
        } else if (v && typeof v === 'object' && 'target' in v) {
          const entry = v as AliasEntry;
          target   = entry.target;
          verified = entry.verified;
        }
        if (!target) continue;
        map.set(normKey, target);
        if (!verified) unverifiedKeys.add(normKey);
      }
    } catch (e) {
      console.error(`Warning: could not parse alias file at ${filePath}: ${String(e)}`);
    }
  }

  return {
    map,
    unverifiedKeys,
    markFired(normKey: string, resolved: boolean) {
      if (unverifiedKeys.has(normKey)) {
        if (resolved) firedResolved.add(normKey);
        else          firedBroken.add(normKey);
      } else {
        if (resolved) verifiedFired.add(normKey);
      }
    },
    report(): AliasCoverageReport {
      const unfired = [...unverifiedKeys].filter(
        (k) => !firedResolved.has(k) && !firedBroken.has(k),
      );
      return {
        firedResolved: [...firedResolved].sort(),
        firedBroken:   [...firedBroken].sort(),
        unfired:       unfired.sort(),
        verifiedFired: [...verifiedFired].sort(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Moiety index
// ---------------------------------------------------------------------------

function buildMoietyNameIndex(): Map<string, MoietyDefinition> {
  const idx = new Map<string, MoietyDefinition>();
  for (const def of moietyRegistry.values()) {
    idx.set(def.moietyName.toLowerCase().trim(), def);
    for (const alias of def.artgAliases) {
      idx.set(alias.toLowerCase().trim(), def);
    }
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Matching — PASS 3 IS SUGGEST-ONLY, NEVER AUTO-ASSIGNED
// ---------------------------------------------------------------------------

function tryMatch(
  artgName: string,
  moietyByName: Map<string, MoietyDefinition>,
  aliases: AliasStore,
): MatchAttempt {
  const norm = artgName.toLowerCase().trim();

  // Pass 1: exact match
  const exact = moietyByName.get(norm);
  if (exact) return { match: { def: exact, pass: 1 }, pass3Suggestions: [], firedAliasKey: null };

  // Pass 2: hand-curated alias file
  const aliasTarget = aliases.map.get(norm);
  if (aliasTarget !== undefined) {
    const resolved = moietyByName.get(aliasTarget.toLowerCase().trim());
    aliases.markFired(norm, resolved !== undefined);
    if (resolved) return { match: { def: resolved, pass: 2 }, pass3Suggestions: [], firedAliasKey: norm };
    return { match: null, pass3Suggestions: [], firedAliasKey: norm };
  }

  // Pass 3: first-token prefix — SUGGEST ONLY
  const firstToken = norm.split(/\s+/)[0];
  const suggestions = new Map<string, string>();
  for (const [key, def] of moietyByName) {
    if (key.startsWith(firstToken) && !suggestions.has(def.moietyName)) {
      suggestions.set(def.moietyName, key);
    }
  }
  return { match: null, pass3Suggestions: [...suggestions.keys()], firedAliasKey: null };
}

// ---------------------------------------------------------------------------
// Unit normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise TGA unit strings to the engine's unit enum.
 * Converts g → mg (×1000) for consistency. TGA uses "microgram" spelled out.
 *
 * Some ARTG products (particularly powders like METAGENICS FEMMEX) express
 * ingredient amounts as concentrations per gram of formulation: "microgram/g"
 * or "mg/g". These are treated as the base unit (mcg or mg respectively).
 * The per-gram qualifier is implicit context — the Protocol Translator treats
 * all ARTG amounts as per-serving, so mcg/g → mcg and mg/g → mg.
 */
function normaliseUnit(rawUnit: string, quantity: number): { amount: number; unit: NormalisedActive['unit'] } {
  const u = rawUnit.toLowerCase().trim();
  if (u === 'mg' || u === 'milligram' || u === 'milligrams') {
    // Pharmaceutical convention: sub-milligram doses (< 1 mg) of vitamins and micronutrients
    // are more naturally expressed in mcg. The TGA occasionally records these in mg
    // (e.g. "calcifediol monohydrate, Quantity: 0.01 mg" instead of "10 mcg").
    // Converting here keeps units consistent with the library which stores D3, K2, B12, etc. in mcg.
    // Herbs and amino acids always appear at doses ≥ 1 mg, so this conversion is safe.
    if (quantity < 1) return { amount: quantity * 1000, unit: 'mcg' };
    return { amount: quantity, unit: 'mg' };
  }
  if (u === 'mcg' || u === 'microgram' || u === 'micrograms' || u === 'µg' || u === 'ug')
    return { amount: quantity, unit: 'mcg' };
  if (u === 'g' || u === 'gram' || u === 'grams')
    return { amount: quantity * 1000, unit: 'mg' };
  if (u === 'iu')
    return { amount: quantity, unit: 'IU' };
  if (u === 'cfu')
    return { amount: quantity, unit: 'CFU' };
  // Per-gram concentration units (powder products, e.g. METAGENICS FEMMEX).
  // "microgram/g" → mcg; "mg/g" → mg. The /g qualifier is dropped because
  // the engine treats all amounts as per-serving.
  if (u === 'microgram/g' || u === 'micrograms/g' || u === 'µg/g' || u === 'ug/g' || u === 'mcg/g')
    return { amount: quantity, unit: 'mcg' };
  if (u === 'mg/g' || u === 'milligram/g' || u === 'milligrams/g')
    return { amount: quantity, unit: 'mg' };
  // Unknown unit — store as mg (will surface in unmatched report)
  return { amount: quantity, unit: 'mg' };
}

// ---------------------------------------------------------------------------
// Ingredient string parser
// ---------------------------------------------------------------------------

/**
 * Split `str` on `sep` only when NOT inside parentheses.
 * Used to separate top-level ingredient blocks without splitting on the
 * semicolons that separate equivalents inside (Equivalent: ...; Equivalent: ...).
 */
function splitOutsideParens(str: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '(') { depth++; current += str[i]; continue; }
    if (str[i] === ')') { depth--; current += str[i]; continue; }
    if (depth === 0 && str.slice(i, i + sep.length) === sep) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      i += sep.length - 1;
      continue;
    }
    current += str[i];
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Parse the equivalents string extracted from inside parentheses.
 * Input (with outer parens stripped): "Equivalent: Name, Qty X unit; Equivalent: Name, Qty X unit"
 */
function parseEquivalents(equivSection: string): Array<{ name: string; quantity: number; unit: string }> {
  const results: Array<{ name: string; quantity: number; unit: string }> = [];
  // Split on "; Equivalent:" boundaries. The first part starts with "Equivalent: " itself.
  const parts = equivSection.split(/;\s*Equivalent:\s*/);
  for (const part of parts) {
    const cleaned = part.replace(/^Equivalent:\s*/i, '').trim();
    // Format: "Name, Qty X unit"
    const m = cleaned.match(/^(.+?),\s*Qty\s+([\d.]+)\s+(\S+)/i);
    if (m) {
      results.push({
        name:     m[1].trim(),
        quantity: parseFloat(m[2]),
        unit:     m[3].trim(),
      });
    }
  }
  return results;
}

/**
 * Parse the full Active Ingredients cell into a list of ingredient blocks.
 *
 * Input cell (semicolon-separated at the top level):
 *   "Name, Quantity: X unit (Equivalent: Name, Qty X unit; ...); Name, Quantity: ..."
 */
function parseIngredientString(raw: string): IngredientBlock[] {
  if (!raw || !raw.trim()) return [];

  const blocks = splitOutsideParens(raw, ';');
  const results: IngredientBlock[] = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    // Match: "Name, Quantity: X unit" optionally followed by "(Equivalent: ...)"
    // Use a two-step approach: find ", Quantity:" as the reliable pivot.
    const quantIdx = trimmed.search(/,\s*Quantity:\s*/i);
    if (quantIdx === -1) continue;

    const primaryName = trimmed.slice(0, quantIdx).trim();
    const afterName   = trimmed.slice(quantIdx).replace(/^,\s*Quantity:\s*/i, '');

    // Extract quantity and unit (stop before optional parentheses)
    const qm = afterName.match(/^([\d.]+)\s+(\S+)([\s\S]*)/);
    if (!qm) continue;

    const primaryQuantity = parseFloat(qm[1]);
    const primaryUnit     = qm[2].trim();
    const remainder       = (qm[3] ?? '').trim();

    // Extract equivalents from "(Equivalent: ...)"
    const equivMatch = remainder.match(/^\(([\s\S]+)\)$/);
    const equivalents = equivMatch ? parseEquivalents(equivMatch[1]) : [];

    results.push({ primaryName, primaryQuantity, primaryUnit, equivalents });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Dose form normalisation
// ---------------------------------------------------------------------------

const DOSE_FORM_MAP: Array<[RegExp, DoseForm]> = [
  [/tablet/i,                                              'TABLET'],
  [/soft\s*(capsule|cap|gel)|softgel/i,                   'SOFT_CAPSULE'],
  [/capsule/i,                                            'CAPSULE'],
  [/powder|granule/i,                                     'POWDER'],
  [/liquid|solution|oral\s*drop|syrup/i,                  'ORAL_LIQUID'],
  [/sachet/i,                                             'SACHET'],
  [/cream|ointment|\bgel\b/i,                             'CREAM'],
];

function normaliseDoseForm(raw: string): DoseForm | null {
  for (const [re, form] of DOSE_FORM_MAP) {
    if (re.test(raw)) return form;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Category filter
// ---------------------------------------------------------------------------

/**
 * Returns true for Listed Medicine products.
 * TGA export uses "Listed Medicine" (and variants); the stub CSV used "Listed".
 * A prefix match on "listed" handles both.
 */
function isListedCategory(cat: string): boolean {
  return cat.toLowerCase().trimStart().startsWith('listed');
}

// ---------------------------------------------------------------------------
// Excel reader
// ---------------------------------------------------------------------------

async function readExcelRows(filePath: string): Promise<Record<string, string>[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheet = wb.worksheets[0];
  if (!sheet) return [];
  const headers: string[] = [];
  const rows: Record<string, string>[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowIdx) => {
    if (rowIdx === 1) {
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        headers[col - 1] = String(cell.value ?? '').trim();
      });
    } else {
      const r: Record<string, string> = {};
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        const h = headers[col - 1];
        if (h) r[h] = String(cell.value ?? '').trim();
      });
      rows.push(r);
    }
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // ── CLI args ──────────────────────────────────────────────────────────────
  const exportPath   = process.argv[2];
  const outIdx       = process.argv.indexOf('--out');
  const outPath      = outIdx !== -1 ? process.argv[outIdx + 1] : 'candidates.json';
  const sponsorIdx   = process.argv.indexOf('--sponsor');
  const sponsorFilter = sponsorIdx !== -1
    ? (process.argv[sponsorIdx + 1] ?? '').toLowerCase()
    : null;
  const limitIdx   = process.argv.indexOf('--limit');
  const rowLimit   = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1] ?? '0', 10) : 0;

  const aliasFilePath = resolve(process.cwd(), 'data', 'artg-aliases.json');
  const reportPath    = 'artg-alias-report.json';

  if (!exportPath) {
    console.error('');
    console.error('Usage: npx tsx scripts/ingest-artg-export.ts <artg-export.xlsx> [--out candidates.json] [--sponsor <name>] [--limit <n>]');
    console.error('');
    console.error('Download from TGA ARTG Visualisation Tool (filter to Listed medicines, export xlsx).');
    console.error('');
    console.error('Expected column names (update COLUMN_MAP in the script if yours differ):');
    for (const [k, v] of Object.entries(COLUMN_MAP)) {
      console.error(`  ${k.padEnd(22)} "${v}"`);
    }
    process.exit(1);
  }

  // ── Load export ───────────────────────────────────────────────────────────
  const absPath = resolve(process.cwd(), exportPath);
  const ext     = extname(absPath).toLowerCase();

  let rawRows: Record<string, string>[];
  if (ext === '.xlsx' || ext === '.xls') {
    console.log(`\nReading Excel: ${exportPath} …`);
    rawRows = await readExcelRows(absPath);
  } else {
    console.error('Only .xlsx/.xls files are supported in this version.');
    process.exit(1);
  }

  console.log(`${rawRows.length.toLocaleString()} rows loaded`);

  // Apply row limit if set (useful for quick validation runs)
  const workRows = rowLimit > 0 ? rawRows.slice(0, rowLimit) : rawRows;
  if (rowLimit > 0) console.log(`--limit ${rowLimit}: processing ${workRows.length} rows`);

  // ── Check column headers ──────────────────────────────────────────────────
  // Warn early if essential columns are missing — saves debugging time.
  const sampleHeaders = workRows.length > 0 ? Object.keys(workRows[0]) : [];
  const missingCols: string[] = [];
  for (const [key, colName] of Object.entries(COLUMN_MAP)) {
    if (key === 'excipientIngredients') continue; // optional
    if (!sampleHeaders.includes(colName)) missingCols.push(`${colName} (COLUMN_MAP.${key})`);
  }
  if (missingCols.length > 0) {
    console.error('\n⚠  Missing columns in export file. Update COLUMN_MAP in the script:');
    for (const c of missingCols) console.error(`   "${c}"`);
    console.error('\nColumns found in file:');
    for (const h of sampleHeaders.slice(0, 20)) console.error(`   "${h}"`);
    if (sampleHeaders.length > 20) console.error(`   … and ${sampleHeaders.length - 20} more`);
    process.exit(1);
  }

  // ── Build lookup structures ───────────────────────────────────────────────
  const aliases      = buildAliasStore(aliasFilePath);
  const moietyByName = buildMoietyNameIndex();

  const matchedMoietyNames = new Set<string>();
  const misses = new Map<string, AliasMiss>();

  // ── Process rows ──────────────────────────────────────────────────────────
  const candidates: CommercialMedicine[] = [];
  let droppedByCat      = 0;
  let droppedByDoseForm = 0;
  let droppedNoMatch    = 0;
  let pass1Count        = 0;
  let pass2Count        = 0;

  for (const rawRow of workRows) {
    const artgId         = (rawRow[COLUMN_MAP.artgId]           ?? '').trim();
    const productName    = (rawRow[COLUMN_MAP.productName]       ?? '').trim();
    const sponsor        = (rawRow[COLUMN_MAP.sponsor]           ?? '').trim();
    const artgCategory   = (rawRow[COLUMN_MAP.artgCategory]      ?? '').trim();
    const dosageFormRaw  = (rawRow[COLUMN_MAP.dosageForm]        ?? '').trim();
    const activeIngrRaw  = (rawRow[COLUMN_MAP.activeIngredients] ?? '').trim();

    if (!artgId) continue;

    // Category filter
    if (!isListedCategory(artgCategory)) { droppedByCat++; continue; }

    // Dose form filter
    const doseForm = normaliseDoseForm(dosageFormRaw);
    if (!doseForm) { droppedByDoseForm++; continue; }

    // Parse ingredient blocks
    const blocks = parseIngredientString(activeIngrRaw);
    if (blocks.length === 0) { droppedNoMatch++; continue; }

    const activesPerUnit: NormalisedActive[] = [];
    const productUnmatched: string[] = [];

    for (const block of blocks) {
      // ── Step A: match primary name ─────────────────────────────────────────
      const primaryAttempt = tryMatch(block.primaryName, moietyByName, aliases);

      if (primaryAttempt.match) {
        const { def, pass } = primaryAttempt.match;

        // ── Step B: quantity selection for ELEMENTAL moieties ─────────────────
        // For minerals (ELEMENTAL basis), the primary quantity is the salt/chelate
        // mass. The TGA publishes the true elemental quantity in the equivalents
        // block (e.g. "Equivalent: Magnesium, Qty 49 mg"). Use that when available.
        let finalAmount: number;
        let finalUnit: NormalisedActive['unit'];

        if (def.basis === 'ELEMENTAL' && block.equivalents.length > 0) {
          let elementalEquiv: { quantity: number; unit: string } | null = null;
          for (const equiv of block.equivalents) {
            // Try "equivalent {name}" alias — matches "equivalent magnesium" → "Magnesium (elemental)"
            const equivKeyAttempt = tryMatch(`equivalent ${equiv.name}`, moietyByName, aliases);
            if (equivKeyAttempt.match && equivKeyAttempt.match.def.tsiCode === def.tsiCode) {
              elementalEquiv = { quantity: equiv.quantity, unit: equiv.unit };
              break;
            }
            // Try direct name — catches "Magnesium (elemental)" if TGA writes it that way
            const directAttempt = tryMatch(equiv.name, moietyByName, aliases);
            if (directAttempt.match && directAttempt.match.def.tsiCode === def.tsiCode) {
              elementalEquiv = { quantity: equiv.quantity, unit: equiv.unit };
              break;
            }
          }
          const norm = elementalEquiv
            ? normaliseUnit(elementalEquiv.unit, elementalEquiv.quantity)
            : normaliseUnit(block.primaryUnit, block.primaryQuantity);
          finalAmount = norm.amount;
          finalUnit   = norm.unit;
        } else {
          const norm = normaliseUnit(block.primaryUnit, block.primaryQuantity);
          finalAmount = norm.amount;
          finalUnit   = norm.unit;
        }

        if (pass === 1) pass1Count++; else pass2Count++;
        matchedMoietyNames.add(def.moietyName);

        // ── ELEMENTAL data-quality guards ─────────────────────────────────
        //
        // Guard 1 — Unit compatibility.
        //   For ELEMENTAL minerals, the moiety unit is fixed by the library
        //   (e.g. 'mcg' for chromium/selenium, 'mg' for zinc/magnesium).
        //   If the normalised ARTG amount arrives in a different unit it means
        //   we fell back to the salt-form primary quantity without finding a
        //   proper elemental equivalence row — discard rather than store a
        //   physically mismatched amount. This prevents chromium picolinate
        //   salt (mg) from appearing as elemental chromium (mcg) in the engine.
        if (def.basis === 'ELEMENTAL' && finalUnit !== def.moietyUnit) {
          productUnmatched.push(`${block.primaryName} [unit mismatch: ${finalUnit} vs moiety ${def.moietyUnit}]`);
          continue;
        }
        //
        // Guard 2 — Physiological ceiling (mg-unit moieties only).
        //   Some ARTG 'Equivalent' rows incorrectly report the salt-form mass
        //   rather than the true elemental amount. Any amount exceeding the
        //   ceiling defined in ELEMENTAL_AMOUNT_CAPS_MG is clinically impossible
        //   for a single product unit and is discarded.
        if (
          def.basis === 'ELEMENTAL' &&
          finalUnit === 'mg' &&
          ELEMENTAL_AMOUNT_CAPS_MG[def.moietyName] !== undefined &&
          finalAmount > ELEMENTAL_AMOUNT_CAPS_MG[def.moietyName]
        ) {
          productUnmatched.push(`${block.primaryName} [capped: ${finalAmount}mg > ${ELEMENTAL_AMOUNT_CAPS_MG[def.moietyName]}mg limit]`);
          continue;
        }

        // Dedup: same moiety from two forms in one product → keep larger amount
        const existing = activesPerUnit.find((a) => a.moiety === def.moietyName);
        if (existing) {
          existing.amount = Math.max(existing.amount, finalAmount);
        } else {
          activesPerUnit.push({
            libraryId: def.tsiCode,
            moiety:    def.moietyName,
            amount:    finalAmount,
            unit:      finalUnit,
          });
        }
        continue;
      }

      // ── Step C: primary didn't match — try equivalents ────────────────────
      let matchedViaEquiv = false;
      for (const equiv of block.equivalents) {
        // (i) direct match on equivalent name
        const directAttempt = tryMatch(equiv.name, moietyByName, aliases);
        if (directAttempt.match) {
          const { def, pass } = directAttempt.match;
          const { amount, unit } = normaliseUnit(equiv.unit, equiv.quantity);
          // Apply same ELEMENTAL guards as Step B (unit compatibility + mg cap)
          if (def.basis === 'ELEMENTAL' && unit !== def.moietyUnit) break;
          if (
            def.basis === 'ELEMENTAL' && unit === 'mg' &&
            ELEMENTAL_AMOUNT_CAPS_MG[def.moietyName] !== undefined &&
            amount > ELEMENTAL_AMOUNT_CAPS_MG[def.moietyName]
          ) break;
          if (pass === 1) pass1Count++; else pass2Count++;
          matchedMoietyNames.add(def.moietyName);
          const existing = activesPerUnit.find((a) => a.moiety === def.moietyName);
          if (existing) { existing.amount = Math.max(existing.amount, amount); }
          else activesPerUnit.push({ libraryId: def.tsiCode, moiety: def.moietyName, amount, unit });
          matchedViaEquiv = true;
          break;
        }
        // (ii) "equivalent {name}" alias key
        const equivKeyAttempt = tryMatch(`equivalent ${equiv.name}`, moietyByName, aliases);
        if (equivKeyAttempt.match) {
          const { def, pass } = equivKeyAttempt.match;
          const { amount, unit } = normaliseUnit(equiv.unit, equiv.quantity);
          // Apply same ELEMENTAL guards as Step B (unit compatibility + mg cap)
          if (def.basis === 'ELEMENTAL' && unit !== def.moietyUnit) break;
          if (
            def.basis === 'ELEMENTAL' && unit === 'mg' &&
            ELEMENTAL_AMOUNT_CAPS_MG[def.moietyName] !== undefined &&
            amount > ELEMENTAL_AMOUNT_CAPS_MG[def.moietyName]
          ) break;
          if (pass === 1) pass1Count++; else pass2Count++;
          matchedMoietyNames.add(def.moietyName);
          const existing = activesPerUnit.find((a) => a.moiety === def.moietyName);
          if (existing) { existing.amount = Math.max(existing.amount, amount); }
          else activesPerUnit.push({ libraryId: def.tsiCode, moiety: def.moietyName, amount, unit });
          matchedViaEquiv = true;
          break;
        }
      }
      if (matchedViaEquiv) continue;

      // Completely unmatched — record for alias report
      productUnmatched.push(block.primaryName);
      let miss = misses.get(block.primaryName);
      if (!miss) {
        miss = {
          artgIngredientName:    block.primaryName,
          productsContainingIt:  0,
          pass3PrefixCandidates: primaryAttempt.pass3Suggestions,
        };
        misses.set(block.primaryName, miss);
      }
      miss.productsContainingIt++;
    }

    if (activesPerUnit.length === 0) { droppedNoMatch++; continue; }

    candidates.push({
      artgId,
      productName,
      sponsor,
      doseForm,
      activesPerUnit,
      maxUnitsPerDay:       null, // not published in ARTG public summary
      excipients:           [],   // names-only excipient column not parsed (irrelevant for coverage)
      snapshotDate:         SNAPSHOT_DATE,
      unmatchedActiveCount: productUnmatched.length,
      unmatchedActiveNames: productUnmatched,
    });
  }

  // ── Inverse moiety report ─────────────────────────────────────────────────
  const seenMoietyNames = new Set<string>();
  const unmatchedMoieties: Array<{ tsiCode: string; moietyName: string; basis: string }> = [];
  for (const def of moietyRegistry.values()) {
    if (!matchedMoietyNames.has(def.moietyName) && !seenMoietyNames.has(def.moietyName)) {
      unmatchedMoieties.push({ tsiCode: def.tsiCode, moietyName: def.moietyName, basis: def.basis });
      seenMoietyNames.add(def.moietyName);
    }
  }
  unmatchedMoieties.sort((a, b) => a.tsiCode.localeCompare(b.tsiCode));

  // ── Alias coverage report ─────────────────────────────────────────────────
  const aliasCoverage = aliases.report();
  const missArray     = [...misses.values()].sort(
    (a, b) => b.productsContainingIt - a.productsContainingIt,
  );

  // ── Write artg-alias-report.json ──────────────────────────────────────────
  const reportData = {
    generatedAt: new Date().toISOString(),
    exportFile:  exportPath,
    limitApplied: rowLimit > 0 ? rowLimit : null,
    summary: {
      productRowsProcessed:            workRows.length,
      categoryDropped:                 droppedByCat,
      doseFormDropped:                 droppedByDoseForm,
      noMatchDropped:                  droppedNoMatch,
      candidatesProduced:              candidates.length,
      unmatchedArtgIngredientNames:    misses.size,
      registryMoietiesWithZeroMatches: unmatchedMoieties.length,
      aliasSeedsFiredAndResolved:      aliasCoverage.firedResolved.length,
      aliasSeedsFiredButBrokenTarget:  aliasCoverage.firedBroken.length,
      aliasSeedsNeverFired:            aliasCoverage.unfired.length,
    },
    unmatchedArtgIngredients: missArray.map((m) => ({
      artgIngredientName:    m.artgIngredientName,
      productsContainingIt:  m.productsContainingIt,
      pass3PrefixCandidates: m.pass3PrefixCandidates,
      // NEVER auto-apply prefix candidates. Add confirmed mappings to data/artg-aliases.json.
    })),
    registryMoietiesWithZeroMatches: unmatchedMoieties,
    aliasSeedCoverage: {
      firedAndResolved: aliasCoverage.firedResolved.map((k) => ({
        aliasKey: k,
        target:   aliases.map.get(k) ?? '?',
        note:     'Seed fired and resolved — consider setting verified: true in data/artg-aliases.json.',
      })),
      firedButBrokenTarget: aliasCoverage.firedBroken.map((k) => ({
        aliasKey:    k,
        wrongTarget: aliases.map.get(k) ?? '?',
        note:        'Key appeared in ARTG data but target moiety not in registry. Fix the target.',
      })),
      neverFired: aliasCoverage.unfired.map((k) => ({
        aliasKey: k,
        target:   aliases.map.get(k) ?? '?',
        note:     'Key never appeared in this export. Either ARTG uses a different name, or ingredient is absent.',
      })),
    },
  };

  writeFileSync(resolve(process.cwd(), reportPath), JSON.stringify(reportData, null, 2), 'utf8');

  // ── Apply --sponsor filter to candidates output ───────────────────────────
  const outputCandidates = sponsorFilter
    ? candidates.filter((c) => c.sponsor.toLowerCase().includes(sponsorFilter))
    : candidates;

  writeFileSync(resolve(process.cwd(), outPath), JSON.stringify(outputCandidates, null, 2), 'utf8');

  // ── Console summary ───────────────────────────────────────────────────────
  const sep = '══════════════════════════════════════════════════════════════════';
  console.log('');
  console.log(sep);
  console.log('  ARTG Ingest — Complete');
  console.log(sep);
  console.log('');
  console.log('  Input');
  console.log(`    Rows loaded:               ${rawRows.length.toLocaleString()}`);
  if (rowLimit > 0)
    console.log(`    Rows processed (--limit):  ${workRows.length.toLocaleString()}`);
  console.log(`    Category dropped:          ${droppedByCat.toLocaleString()} (not "Listed")`);
  console.log(`    Unrecognised dose form:    ${droppedByDoseForm.toLocaleString()} products`);
  console.log(`    No moiety matched:         ${droppedNoMatch.toLocaleString()} products`);
  console.log('');
  console.log('  Ingredient matching');
  console.log(`    Pass 1 (exact):            ${pass1Count.toLocaleString()}`);
  console.log(`    Pass 2 (alias file):       ${pass2Count.toLocaleString()}`);
  console.log(`    Pass 3:                    suggest-only → see ${reportPath}`);
  console.log(`    Unmatched names:           ${misses.size.toLocaleString()} → see ${reportPath}`);
  console.log('');
  console.log('  Output');
  console.log(`    Total candidates:          ${candidates.length.toLocaleString()}`);
  if (sponsorFilter)
    console.log(`    After --sponsor filter:    ${outputCandidates.length.toLocaleString()}  (sponsor ∋ "${sponsorFilter}")`);
  console.log(`    Written to:                ${outPath}`);
  console.log('');
  console.log('  Alias seed coverage  (data/artg-aliases.json seeds only)');
  console.log(`    Fired + resolved:          ${aliasCoverage.firedResolved.length}  ✓`);
  console.log(`    Fired + broken target:     ${aliasCoverage.firedBroken.length}  ✗  (fix these first)`);
  console.log(`    Never fired:               ${aliasCoverage.unfired.length}`);
  console.log('');
  console.log('  Registry moieties with zero matches in candidate pool');
  console.log(`    Count:                     ${unmatchedMoieties.length} of ${seenMoietyNames.size + unmatchedMoieties.length}`);

  // Top unmatched ARTG ingredient names
  console.log('');
  console.log('  Top unmatched ARTG ingredient names (by product frequency):');
  for (const m of missArray.slice(0, 30)) {
    const sugg = m.pass3PrefixCandidates.length > 0
      ? `  [pass-3: ${m.pass3PrefixCandidates.slice(0, 3).join(', ')}]`
      : '  [no prefix match]';
    console.log(`    "${m.artgIngredientName}"  (${m.productsContainingIt} products)${sugg}`);
  }

  // Inverse moiety list
  console.log('');
  console.log('  Registry moieties with ZERO matches (full list):');
  if (unmatchedMoieties.length === 0) {
    console.log('    None — all 107 library moieties appeared in at least one candidate.');
  } else {
    for (const m of unmatchedMoieties) {
      console.log(`    ${m.tsiCode.padEnd(14)}  ${m.basis.padEnd(14)}  ${m.moietyName}`);
    }
  }

  // Broken seeds (highest priority to fix)
  if (aliasCoverage.firedBroken.length > 0) {
    console.log('');
    console.log('  ✗ Seeds with broken targets — fix these first:');
    for (const k of aliasCoverage.firedBroken) {
      console.log(`    "${k}"  →  target "${aliases.map.get(k)}"  [NOT in registry]`);
    }
  }

  // Never-fired seeds
  if (aliasCoverage.unfired.length > 0) {
    console.log('');
    console.log(`  Seeds that never fired (${aliasCoverage.unfired.length}):`);
    for (const k of aliasCoverage.unfired.slice(0, 30)) {
      console.log(`    "${k}"  →  "${aliases.map.get(k)}"`);
    }
    if (aliasCoverage.unfired.length > 30)
      console.log(`    … and ${aliasCoverage.unfired.length - 30} more. See ${reportPath}.`);
  }

  console.log('');
  console.log(`  Full alias report: ${reportPath}`);
  console.log('');
  console.log('  Next steps:');
  if (aliasCoverage.firedBroken.length > 0) {
    console.log('    1. Fix broken-target seeds in data/artg-aliases.json (see above).');
    console.log('    2. Re-run this script.');
  } else {
    console.log('    1. Review never-fired seeds in artg-alias-report.json.');
    console.log('    2. Add aliases for high-frequency unmatched ARTG names.');
    console.log('    3. Re-run for better coverage.');
  }
  console.log(`    npx tsx scripts/assess-formulation.ts SUB-2026-005 ${outPath}`);
  console.log(`    npx tsx scripts/translate-products.ts --products <artgId:units,...> ${outPath}`);
  console.log('');

  if (outputCandidates.length === 0) {
    console.error('  ⚠  Zero candidates written. Common causes:');
    console.error('     — Column names differ from COLUMN_MAP (update the map at the top of the script)');
    console.error('     — Category values not recognised as "Listed" (check ARTG Category column)');
    console.error('     — All ingredient names unmatched (add mappings to data/artg-aliases.json)');
    console.error('     — File contains no product rows after the header row');
    console.error('');
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
