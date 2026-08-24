#!/usr/bin/env npx tsx
/**
 * scripts/assess-formulation.ts
 *
 * Validate the formulation adapter on a real saved submission and run the
 * full justification engine pipeline.
 *
 * Usage:
 *   npx tsx scripts/assess-formulation.ts [submission-id|path-to-json]
 *
 * Examples:
 *   npx tsx scripts/assess-formulation.ts SUB-2026-005
 *   npx tsx scripts/assess-formulation.ts ./live-test-output.json
 *   npx tsx scripts/assess-formulation.ts ./live-test-output-hl7.json
 *
 * When called with a submission ID, reads from data/submissions/{id}/response.json.
 * When called with a path, reads the file directly (live-test-output format).
 *
 * What this validates:
 *   1. Every TSI code in proposed_formulation maps to a MoietyDefinition (no
 *      UNMAPPED_TSI_CODE warnings expected for well-formed real submissions).
 *   2. ELEMENTAL ratios are computed correctly from the library row.
 *      When elemental_dose is present in the ingredient output, that value is
 *      used directly; otherwise the registry ratio is applied.
 *   3. IU → mcg conversions fire for D3 and Vitamin A if the proposed_dose
 *      unit is IU.  Expected: UNIT_CONVERSION warning with factor 0.025 or 0.3.
 *   4. The resulting DraftFormulation drives assessJustification without crashing.
 *
 * Candidate pool:
 *   Without a candidates.json argument, assessJustification runs against an
 *   empty pool.  Every active is uncoverable → COMBINATION_REQUIRED fires for
 *   every active → status = JUSTIFIED.  This is not a clinically meaningful
 *   result; it confirms the engine and adapter integrate end-to-end.
 *
 *   Pass candidates.json as a second argument to run against real ARTG data:
 *     npx tsx scripts/assess-formulation.ts SUB-2026-005 candidates.json
 */

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { toDraftFormulation }    from '../src/lib/compounding/adapters/formulation-adapter';
import { moietyRegistry }         from '../src/lib/compounding/moiety-registry';
import {
  assessJustification,
  DEFAULT_CONFIG,
  type CommercialMedicine,
} from '../src/lib/compounding/justification-engine';

// ---------------------------------------------------------------------------
// Load response JSON
// ---------------------------------------------------------------------------

function loadResponse(arg: string): Record<string, unknown> {
  let filePath: string;
  // Looks like a submission ID?
  if (/^SUB-\d{4}-/.test(arg)) {
    filePath = resolve(process.cwd(), 'data', 'submissions', arg, 'response.json');
  } else {
    filePath = resolve(process.cwd(), arg);
  }
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const DIM    = '\x1b[2m';

function h(text: string) { console.log('\n' + BOLD + text + RESET); }
function ok(text: string) { console.log('  ' + GREEN + '✓' + RESET + '  ' + text); }
function warn(text: string) { console.log('  ' + YELLOW + '⚠' + RESET + '  ' + text); }
function err(text: string) { console.log('  ' + RED + '✗' + RESET + '  ' + text); }
function info(text: string) { console.log('  ' + DIM + text + RESET); }
function row(label: string, value: string) {
  console.log('  ' + CYAN + label.padEnd(34) + RESET + value);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const submissionArg = process.argv[2];
  const candidatePath = process.argv[3];

  if (!submissionArg) {
    console.error('Usage: npx tsx scripts/assess-formulation.ts <submission-id|path> [candidates.json]');
    console.error('Example: npx tsx scripts/assess-formulation.ts SUB-2026-005');
    process.exit(1);
  }

  // ── Load response ─────────────────────────────────────────────────────────
  const response = loadResponse(submissionArg);
  // The saved response may use `output` or the raw Claude output directly.
  // live-test-output files have a top-level `output` key; submission response.json
  // also has a top-level `output` key wrapping the FormulationOutputType.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const output = (response.output ?? response) as any;

  const subId     = output?.submission_metadata?.submission_id ?? submissionArg;
  const panelClass = (output?.panel_classes ?? output?.submission_metadata?.panel_classes ?? ['?']).join(', ');
  const testType  = output?.submission_metadata?.test_type ?? '?';

  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(BOLD + '  N of 1 — Formulation Assessment' + RESET);
  console.log('══════════════════════════════════════════════════════════════════════');
  row('Submission ID:',  subId);
  row('Panel class:',    panelClass);
  row('Test type:',      testType);
  row('Patient ref:',    output?.submission_metadata?.patient_pseudonymous_id ?? '?');

  // ── Adapter pass ──────────────────────────────────────────────────────────
  h('1. Formulation adapter');

  let adapterResult: ReturnType<typeof toDraftFormulation>;
  try {
    adapterResult = toDraftFormulation(output);
  } catch (e) {
    err('toDraftFormulation threw: ' + String(e));
    process.exit(1);
  }

  const { draft, warnings } = adapterResult;

  console.log('');
  info(`${draft.targetActives.length} actives → DraftFormulation (requiredDoseForm: ${draft.requiredDoseForm})`);

  // ── Target actives table ──────────────────────────────────────────────────
  h('2. Target actives (moiety mapping)');
  console.log('');

  const COL = { code: 14, common: 34, moiety: 38, amount: 14, basis: 16 };
  const header =
    BOLD +
    '  TSI Code'.padEnd(COL.code + 2) +
    'Common Name'.padEnd(COL.common) +
    'Moiety'.padEnd(COL.moiety) +
    'Amount'.padEnd(COL.amount) +
    'Basis' +
    RESET;
  console.log(header);
  console.log('  ' + '─'.repeat(COL.code + COL.common + COL.moiety + COL.amount + COL.basis));

  for (const active of draft.targetActives) {
    const def = moietyRegistry.get(active.libraryId ?? '');
    const basis = def?.basis ?? '?';
    const isAmbig = def?.ambiguous ? ' ⚠' : '';
    const amountStr = `${active.amount.toFixed(3)} ${active.unit}`;
    console.log(
      '  ' +
      (active.libraryId ?? '?').padEnd(COL.code) +
      active.moiety.slice(0, COL.common - 2).padEnd(COL.common) +
      (active.moiety.slice(0, COL.moiety - 2) + isAmbig).padEnd(COL.moiety) +
      amountStr.padEnd(COL.amount) +
      basis,
    );
  }

  // Cross-check: show ingredients whose elemental_dose was used directly vs computed from ratio
  h('3. Elemental derivation check (ELEMENTAL basis only)');
  const podIngredients = (output?.proposed_formulation ?? []) as Array<Record<string, unknown>>;
  let elementalChecks = 0;
  for (const ing of podIngredients) {
    const code = ing.tsi_code as string;
    const def = moietyRegistry.get(code);
    if (!def || def.basis !== 'ELEMENTAL') continue;
    elementalChecks++;

    const proposedDose = ing.proposed_dose as number;
    const doseUnit     = ing.dose_unit as string;
    const elemDose     = ing.elemental_dose as number | undefined;
    const elemUnit     = ing.elemental_unit as string | undefined;

    // Find the matching active in targetActives
    const active = draft.targetActives.find(a => a.libraryId === code);
    if (!active) continue;

    if (elemDose !== undefined) {
      ok(
        `${code} ${String(ing.common_name).slice(0, 28)} — elemental_dose present: ` +
        `${elemDose} ${elemUnit} → engine sees ${active.amount.toFixed(3)} ${active.unit}`,
      );
    } else {
      // Ratio was applied: moiety amount in targetActives was derived from proposed_dose
      // via the library's equiv_line_2_quantity / dose_per_granule ratio.
      ok(
        `${code} ${String(ing.common_name).slice(0, 24)} — ratio applied: ` +
        `${proposedDose} ${doseUnit} salt → ${active.amount.toFixed(3)} ${active.unit} elemental`,
      );
    }
  }
  if (elementalChecks === 0) info('No ELEMENTAL basis ingredients in this formulation.');

  // ── Conversion warnings ───────────────────────────────────────────────────
  h('4. Adapter conversion warnings');
  if (warnings.length === 0) {
    ok('No conversion warnings (all units matched; no ambiguous moieties).');
  } else {
    for (const w of warnings) {
      const icon = w.kind === 'UNMAPPED_TSI_CODE' ? RED + '✗' + RESET
                 : w.kind === 'MOIETY_AMBIGUOUS'  ? YELLOW + '⚠' + RESET
                 : w.kind === 'UNRESOLVABLE_UNIT'  ? RED + '✗' + RESET
                 : YELLOW + 'ℹ' + RESET;
      console.log(`  ${icon}  [${w.kind}] ${w.tsiCode} ${w.ingredientName}`);
      info(`      ${w.detail}`);
    }
  }

  // ── Ingredients NOT in pod (standalone_recommendations, excluded_from_pod) ─
  const standalone = (output?.standalone_recommendations ?? []) as Array<Record<string, unknown>>;
  const excluded   = (output?.excluded_from_pod          ?? []) as Array<Record<string, unknown>>;
  const podCodes   = new Set((output?.proposed_formulation ?? []).map((i: Record<string, unknown>) => i.tsi_code));
  const outsideCodes = [
    ...standalone.filter(i => i.tsi_code).map(i => i.tsi_code as string),
    ...excluded.filter(i => i.tsi_code).map(i => i.tsi_code as string),
  ].filter(c => !podCodes.has(c));

  if (outsideCodes.length > 0) {
    h('5. Outside-pod ingredients (standalone / excluded_from_pod)');
    for (const code of outsideCodes) {
      const def = moietyRegistry.get(code);
      if (def) {
        info(`  ${code}  ${def.moietyName}  [${def.basis}] — in registry, not adapted (not in pod)`);
      } else {
        warn(`  ${code}  — NOT in registry`);
      }
    }
  }

  // ── Engine assessment ─────────────────────────────────────────────────────
  h('6. Justification engine assessment');

  let candidates: CommercialMedicine[] = [];
  if (candidatePath) {
    try {
      const raw = JSON.parse(readFileSync(resolve(process.cwd(), candidatePath), 'utf8'));
      candidates = Array.isArray(raw) ? raw : raw.candidates ?? [];
      info(`Loaded ${candidates.length} ARTG candidates from ${candidatePath}`);
    } catch (e) {
      err(`Failed to load ${candidatePath}: ${String(e)}`);
      process.exit(1);
    }
  } else {
    warn('No candidates.json supplied — running against empty pool.');
    info('Every active is uncoverable → COMBINATION_REQUIRED fires → JUSTIFIED (not clinically meaningful).');
    info('Supply a candidates.json as the second argument for a real assessment.');
  }

  console.log('');

  const assessment = assessJustification(draft, candidates, DEFAULT_CONFIG, null);

  const statusColor = assessment.status === 'JUSTIFIED' ? GREEN : YELLOW;
  console.log('  Status: ' + BOLD + statusColor + assessment.status + RESET);
  console.log('  Snapshot date: ' + assessment.snapshotDate);
  console.log('');

  // Data quality notes (partial-match products in covering set)
  if (assessment.dataQualityNotes.length > 0) {
    console.log('');
    console.log('  ' + YELLOW + '⚠  Data quality notes (' + assessment.dataQualityNotes.length + ')' + RESET);
    for (const note of assessment.dataQualityNotes) {
      warn(`${note.artgId} ${note.productName}`);
      info(`      Unmatched: [${note.unmatchedActiveNames.join(', ')}]`);
      info(`      ${note.note}`);
    }
  }

  if (assessment.reasons.length === 0) {
    info('No justification reasons fired — no commercial alternative exists and no failure modes detected.');
  } else {
    for (const reason of assessment.reasons) {
      const icon = ['COMBINATION_REQUIRED','INGREDIENT_EXCLUSION','DELIVERY_SYSTEM','DOSE_OUTSIDE_AVAILABLE_STRENGTHS'].includes(reason.code)
        ? GREEN + '●' + RESET   // carrying code
        : YELLOW + '○' + RESET; // corroborating only
      console.log(`  ${icon}  ${BOLD}${reason.code}${RESET}  [${reason.determinedBy}]  ${reason.guidelineRef}`);

      // Show key evidence fields compactly
      const ev = reason.evidence as Record<string, unknown>;
      if (reason.code === 'COMBINATION_REQUIRED') {
        info(`      ${ev.minimumCommercialProductsRequired} products required (max ${ev.maxConcurrentProducts}). ` +
          `Uncoverable: ${(ev.activesNotAvailableInAnyCommercialMedicine as string[]).length || 'none (product limit exceeded)'}`);
      } else if (reason.code === 'DOSE_FORM') {
        info(`      Required: ${ev.requiredDoseForm}. Available: ${(ev.availableDoseForms as string[]).join(', ')}`);
      } else if (reason.code === 'DOSE_OUTSIDE_AVAILABLE_STRENGTHS') {
        const failures = ev.activesOutsideAvailableStrengths as Array<Record<string, unknown>>;
        for (const f of failures) {
          info(`      ${f.moiety}: target ${f.targetDose} ${f.unit}, nearest ${
            (f.nearestAchievable as Record<string, unknown>)?.achievableDose ?? '?'
          } (${((f.deviationFraction as number) * 100).toFixed(1)}% deviation)`);
        }
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  h('7. Summary');
  const unmapped = warnings.filter(w => w.kind === 'UNMAPPED_TSI_CODE');
  const ambig    = warnings.filter(w => w.kind === 'MOIETY_AMBIGUOUS');
  const unitConv = warnings.filter(w => w.kind === 'UNIT_CONVERSION');
  const unresol  = warnings.filter(w => w.kind === 'UNRESOLVABLE_UNIT');

  if (unmapped.length > 0) {
    err(`${unmapped.length} UNMAPPED TSI codes — these actives were dropped from targetActives`);
    for (const w of unmapped) info(`    ${w.tsiCode} ${w.ingredientName}`);
  } else {
    ok('All TSI codes mapped — no actives dropped');
  }
  if (unitConv.length > 0) ok(`${unitConv.length} unit conversion(s) applied (IU → mcg)`);
  if (ambig.length > 0)    warn(`${ambig.length} ambiguous moiety(ies) — verify manually`);
  if (unresol.length > 0)  err(`${unresol.length} unresolvable unit(s) — engine matching will fail for these`);

  console.log('');
  console.log('  ' + BOLD + `${draft.targetActives.length}` + RESET + ' actives in DraftFormulation  |  ' +
    BOLD + assessment.reasons.length + RESET + ' justification reason(s)  |  ' +
    BOLD + statusColor + assessment.status + RESET);
  console.log('');
}

main();
