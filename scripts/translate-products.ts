#!/usr/bin/env npx tsx
/**
 * scripts/translate-products.ts
 * ------------------------------
 * Translate selected ARTG products into a N of 1 pod formula.
 * Practitioner-onboarding path: takes the products a practitioner currently
 * prescribes and produces an equivalent granule schedule from the Rev15 library.
 *
 * Usage:
 *   npx tsx scripts/translate-products.ts --products <artgId:units,...> <candidates.json>
 *
 * Options:
 *   --products  Comma-separated list of ARTG ID:daily-units pairs (required)
 *   --form      Required dose form for justification check (default: CAPSULE)
 *   --out       Write full JSON result to this path (optional)
 *
 * Examples:
 *   npx tsx scripts/translate-products.ts --products 100002:2,100050:1 candidates.json
 *   npx tsx scripts/translate-products.ts --products 100001:1,100006:1,100026:1 \
 *       --form CAPSULE --out translation-result.json candidates.json
 *
 * When candidates.json is supplied, the justification engine runs on the in-pod
 * actives and the assessment is included in the output.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  translateProducts,
  DEFAULT_TRANSLATION_CONFIG,
  type SelectedProduct,
  type TranslationResult,
} from '../src/lib/compounding/product-translation-engine';
import { productionMoietyRegistry } from '../src/lib/compounding/moiety';
import { libraryMap } from '../src/lib/compounding/library-map';
import { classSubstituteMap } from '../src/lib/compounding/class-substitute-map';
import type { CommercialMedicine, DoseForm } from '../src/lib/compounding/justification-engine';

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const DIM    = '\x1b[2m';

function h(text: string)  { console.log('\n' + BOLD + text + RESET); }
function ok(text: string)  { console.log('  ' + GREEN  + '✓' + RESET + '  ' + text); }
function warn(text: string){ console.log('  ' + YELLOW + '⚠' + RESET + '  ' + text); }
function err(text: string) { console.log('  ' + RED    + '✗' + RESET + '  ' + text); }
function info(text: string){ console.log('  ' + DIM + text + RESET); }
function row(label: string, value: string) {
  console.log('  ' + CYAN + label.padEnd(28) + RESET + value);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);

  let productsArg: string | null = null;
  let formArg = 'CAPSULE';
  let outArg: string | null = null;
  let candidatesPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--products' && args[i + 1]) {
      productsArg = args[++i];
    } else if (args[i] === '--form' && args[i + 1]) {
      formArg = args[++i];
    } else if (args[i] === '--out' && args[i + 1]) {
      outArg = args[++i];
    } else if (!args[i].startsWith('--')) {
      candidatesPath = args[i];
    }
  }

  if (!productsArg) {
    console.error(RED + 'Error: --products is required.' + RESET);
    console.error('Usage: npx tsx scripts/translate-products.ts --products <artgId:units,...> <candidates.json>');
    console.error('Example: npx tsx scripts/translate-products.ts --products 100002:2,100050:1 candidates.json');
    process.exit(1);
  }

  // Parse "100002:2,100050:1" into [{artgId, units}, ...]
  const productPairs = productsArg.split(',').map((pair) => {
    const [artgId, unitsStr] = pair.trim().split(':');
    const unitsPerDay = parseInt(unitsStr ?? '1', 10);
    if (!artgId || isNaN(unitsPerDay) || unitsPerDay < 1) {
      console.error(RED + `Invalid product spec "${pair}". Expected format: artgId:units (e.g. 100002:2)` + RESET);
      process.exit(1);
    }
    return { artgId, unitsPerDay };
  });

  return { productPairs, formArg, outArg, candidatesPath };
}

// ---------------------------------------------------------------------------
// Tier display helpers
// ---------------------------------------------------------------------------

const TIER_ICON: Record<string, string> = {
  DIRECT:            GREEN  + '●' + RESET,
  FORM_SUBSTITUTION: GREEN  + '○' + RESET,
  CLASS_SUBSTITUTION:YELLOW + '◐' + RESET,
  PURCHASE_SEPARATELY: YELLOW + '↗' + RESET,
  UNAVAILABLE:       RED    + '✗' + RESET,
};

const TIER_LABEL: Record<string, string> = {
  DIRECT:             'DIRECT',
  FORM_SUBSTITUTION:  'FORM_SUBSTITUTION',
  CLASS_SUBSTITUTION: 'CLASS_SUBSTITUTION (needs confirmation)',
  PURCHASE_SEPARATELY:'PURCHASE_SEPARATELY',
  UNAVAILABLE:        'UNAVAILABLE',
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { productPairs, formArg, outArg, candidatesPath } = parseArgs();

  // ── Load candidates ───────────────────────────────────────────────────────
  let candidates: CommercialMedicine[] = [];
  if (candidatesPath) {
    try {
      const raw = JSON.parse(readFileSync(resolve(process.cwd(), candidatesPath), 'utf8'));
      candidates = Array.isArray(raw) ? raw : (raw.candidates ?? []);
    } catch (e) {
      console.error(RED + `Failed to load candidates from ${candidatesPath}: ${String(e)}` + RESET);
      process.exit(1);
    }
  }

  // ── Build selected products list ──────────────────────────────────────────
  const selected: SelectedProduct[] = [];
  for (const { artgId, unitsPerDay } of productPairs) {
    const product = candidates.find((c) => c.artgId === artgId);
    if (!product) {
      err(`ARTG ID ${artgId} not found in ${candidatesPath ?? 'candidate pool'}. Skipping.`);
      continue;
    }
    selected.push({ product, unitsPerDay });
  }

  if (selected.length === 0) {
    err('No products resolved from candidates. Exiting.');
    process.exit(1);
  }

  // ── Run translation ───────────────────────────────────────────────────────
  const requiredDoseForm = formArg as DoseForm;

  const result: TranslationResult = translateProducts(
    selected,
    productionMoietyRegistry,
    // libraryMap is ReadonlyMap; cast to Map satisfies the parameter type
    libraryMap as Map<string, import('../src/lib/compounding/product-translation-engine').LibraryGranuleSpec>,
    new Map(), // classAlternatives — empty; CLASS_SUBSTITUTION never auto-applies
    DEFAULT_TRANSLATION_CONFIG,
    // Justification input — runs if candidates were supplied
    candidates.length > 0
      ? {
          draftId: `TRANSLATE-${Date.now()}`,
          patientRef: 'ONBOARDING',
          practitionerId: 'SCRIPT',
          requiredDoseForm,
          candidates,
        }
      : undefined,
    // Class substitute map — proposes N of 1 substitutes for unresolved ARTG ingredients
    classSubstituteMap as Map<string, import('../src/lib/compounding/class-substitute-map').ClassSubstituteSpec>,
  );

  // ── Print report ──────────────────────────────────────────────────────────

  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(BOLD + '  N of 1 — Product Translation Engine' + RESET);
  console.log('══════════════════════════════════════════════════════════════════════');

  h('1. Selected products');
  for (const s of result.selected) {
    row(s.artgId, `${s.productName}  ×${s.unitsPerDay}/day`);
  }

  h('2. Aggregated targets');
  console.log('');
  const COL = { id: 14, name: 34, dose: 20, granules: 12, tier: 0 };
  console.log(
    BOLD +
    '  ' + 'Moiety ID'.padEnd(COL.id) +
    'Name'.padEnd(COL.name) +
    'Total dose'.padEnd(COL.dose) +
    'Granules'.padEnd(COL.granules) +
    'Tier' +
    RESET,
  );
  console.log('  ' + '─'.repeat(COL.id + COL.name + COL.dose + COL.granules + 28));

  for (let i = 0; i < result.targets.length; i++) {
    const t = result.targets[i];
    const tx = result.translated[i];
    const icon = TIER_ICON[tx.tier] ?? '?';
    const doseStr = `${t.totalDose} ${t.unit}`;
    const granuleStr = tx.granules !== null ? String(tx.granules) : '—';
    const stackBadge = t.stacked ? DIM + ' [stacked]' + RESET : '';

    console.log(
      '  ' + icon + ' ' +
      t.moietyId.padEnd(COL.id - 2) +
      t.displayName.slice(0, COL.name - 2).padEnd(COL.name) +
      doseStr.padEnd(COL.dose) +
      granuleStr.padEnd(COL.granules) +
      TIER_LABEL[tx.tier] +
      stackBadge,
    );

    if (t.stacked) {
      for (const c of t.contributions) {
        info(
          `  ${c.artgId.padEnd(10)} ${c.productName.slice(0, 28).padEnd(30)} ` +
          `${c.dosePerUnit} ${t.unit} × ${c.unitsPerDay} = ${c.subtotal} ${t.unit}`,
        );
      }
    }
    if (tx.exceedsLibraryMax) {
      warn(`  ${t.displayName}: dose ${t.totalDose} ${t.unit} exceeds library maximum — review with practitioner`);
    }
  }

  h('3. Pod fill');
  const { totalGranules, capacity, utilisationFraction, fits } = result.podFill;
  const pct = (utilisationFraction * 100).toFixed(1);
  const fillColour = fits ? GREEN : RED;
  console.log(
    `  ${fillColour}${BOLD}${totalGranules}${RESET} / ${capacity} granules  ` +
    `(${fillColour}${pct}%${RESET})  ` +
    (fits ? GREEN + 'FITS' + RESET : RED + 'OVER CAPACITY' + RESET),
  );

  if (!fits && result.podFill.largestConsumers.length > 0) {
    console.log('');
    info('Largest consumers:');
    for (const lc of result.podFill.largestConsumers.slice(0, 5)) {
      info(`  ${lc.displayName.padEnd(36)} ${lc.granules} granules`);
    }
  }

  if (result.purchaseSeparately.length > 0) {
    h('4. Purchase separately');
    for (const t of result.purchaseSeparately) {
      warn(`${t.target.displayName}  (${t.target.totalDose} ${t.target.unit})`);
      info(`  ${t.note}`);
    }
  }

  if (result.requiresConfirmation.length > 0) {
    h('5. Requires practitioner confirmation (CLASS_SUBSTITUTION)');
    for (const t of result.requiresConfirmation) {
      warn(`${t.target.displayName}`);
      info(`  ${t.note}`);
      for (const alt of t.proposedAlternatives ?? []) {
        info(`    → ${alt.displayName}  (${alt.dosePerGranule} ${alt.unit}/granule)`);
      }
    }
  }

  if (result.unavailable.length > 0) {
    h('6. Unavailable actives');
    for (const t of result.unavailable) {
      err(`${t.target.displayName}  (${t.target.totalDose} ${t.target.unit})`);
      info(`  ${t.note}`);
    }
  }

  if (result.classSubstitutes.length > 0) {
    h('7. Class substitutes — requires practitioner confirmation');
    info('These ARTG ingredients have no library entry but a therapeutically related');
    info('N of 1 moiety was found. Library dose applied (commercial dose not used).');
    info('Each MUST be confirmed by the practitioner before entering the pod.');
    console.log('');
    for (const cs of result.classSubstitutes) {
      console.log(
        `  ${YELLOW}◈${RESET}  ${BOLD}${cs.artgIngredientName}${RESET}` +
        `  →  ${GREEN}${cs.substituteDisplayName}${RESET}` +
        `  (${cs.recommendedDose} ${cs.unit}/day · ${cs.recommendedGranules} granules)`,
      );
      info(`     Sources: ${cs.sources.map((s) => `${s.artgId} ${s.productName}`).join(', ')}`);
      info(`     ${cs.rationale}`);
    }
    console.log('');
    info(`${result.classSubstitutes.length} substitute(s) above are NOT in the current pod fill.`);
    info('If confirmed, add them to the formulation manually or via the onboarding workflow.');
  }

  if (result.unresolvedSourceActives.length > 0) {
    const substitutedNames = new Set(
      result.classSubstitutes.map((cs) => cs.artgIngredientName.toLowerCase().trim()),
    );
    const trulyUnresolved = result.unresolvedSourceActives.filter(
      (u) => !substitutedNames.has(u.ingredientName.toLowerCase().trim()),
    );
    if (trulyUnresolved.length > 0) {
      h('8. Unresolved source actives (no library substitute)');
      info('These ARTG ingredient names could not be mapped and have no class substitute.');
      info('Add aliases in data/artg-aliases.json and re-ingest, or accept as unavailable.');
      for (const u of trulyUnresolved) {
        warn(`${u.artgId}  ${u.ingredientName}`);
      }
    }
  }

  if (result.justificationAssessment) {
    const ja = result.justificationAssessment;
    h('8. Justification assessment');
    const statusColour = ja.status === 'JUSTIFIED' ? GREEN : YELLOW;
    console.log(`  Status: ${BOLD}${statusColour}${ja.status}${RESET}`);

    if (ja.dataQualityNotes.length > 0) {
      console.log('');
      warn(`${ja.dataQualityNotes.length} data quality note(s) — assessment may overstate justification`);
      for (const n of ja.dataQualityNotes) {
        info(`  ${n.artgId} ${n.productName}: unmatched [${n.unmatchedActiveNames.join(', ')}]`);
      }
    }

    if (ja.reasons.length > 0) {
      console.log('');
      for (const reason of ja.reasons) {
        const icon = GREEN + '●' + RESET;
        console.log(`  ${icon}  ${BOLD}${reason.code}${RESET}  ${reason.guidelineRef}`);
      }
    } else {
      info('No justification reasons fired.');
    }
  }

  // ── Summary line ──────────────────────────────────────────────────────────
  h('Summary');
  ok(`${result.selected.length} product(s) → ${result.targets.length} target moiety(s) → ${result.podFill.totalGranules} granules`);
  if (result.doseWarnings.length > 0) {
    warn(`${result.doseWarnings.length} moiety(s) exceed library maximum daily dose`);
  }
  if (result.purchaseSeparately.length > 0) {
    info(`${result.purchaseSeparately.length} active(s) to source separately`);
  }
  if (result.unavailable.length > 0) {
    err(`${result.unavailable.length} active(s) have no library equivalent`);
  }
  console.log('');

  // ── Write JSON output ─────────────────────────────────────────────────────
  if (outArg) {
    const outPath = resolve(process.cwd(), outArg);
    writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
    ok(`Result written to ${outPath}`);
    console.log('');
  }
}

main();
