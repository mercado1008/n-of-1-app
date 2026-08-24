/**
 * scripts/generate-docs/health-analysis-html.ts
 *
 * Generates a self-contained HTML string for the N of 1 Health Analysis
 * document. Intended to be rendered to PDF via Puppeteer (see
 * health-analysis-pdf.ts).
 *
 * Design tokens, typography, and section structure match the prototype in
 * design_handoff_health_analysis/NofISHealthAnalysis.dc.html (pixel-for-pixel
 * fidelity target). See design_handoff_health_analysis/README.md for spec.
 *
 * All sections are conditional on non-empty data. Section numerals are
 * computed from the list of sections that actually render — a document with
 * no Diet & Lifestyle section still numbers subsequent sections correctly.
 *
 * Intentionally included ingredients are rendered from proposed_formulation[]
 * structured data (not Claude's free-text formulation_logic field). See Stage
 * 3 Bug 2 fix in FIXES.md.
 */

import type { AnalysisOutput, RouteAuditBlock } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthAnalysisHtmlOptions {
  output: AnalysisOutput;
  /** Route audit block from the JSON wrapper (submission_id, generated_at_iso etc.) */
  routeAudit?: RouteAuditBlock;
  /** Request metadata (patient_pseudonym, age, sex, collection_date etc.) */
  requestMetadata?: Record<string, unknown>;
  /** Base64-encoded PNG/JPG logo, embedded as a data URI on the cover band. */
  logoBase64?: string;
  logoMimeType?: string;
  /** Computed audit reference (XXXX-XXXX-XXXX). Falls back to submission_id. */
  auditReference?: string;
  /** Resolver: TSI code → display name. Used in contraindication ingredients column. */
  tsiResolver?: (code: string) => string | undefined;
}

// ---------------------------------------------------------------------------
// HTML escape / text helpers
// ---------------------------------------------------------------------------

function esc(s: unknown): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Spell numbers one–ten as words, use numerals above ten (per design spec). */
function spellNumber(n: number): string {
  const words = ['zero','one','two','three','four','five','six','seven','eight','nine','ten'];
  return n <= 10 ? words[n] : String(n);
}

function upperFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Format an ISO 8601 timestamp as "12 August 2026, 6:16 am" (UTC). */
function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const months = ['January','February','March','April','May','June','July',
                    'August','September','October','November','December'];
    const h = d.getUTCHours();
    const m = d.getUTCMinutes().toString().padStart(2, '0');
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h % 12 || 12}:${m} ${h < 12 ? 'am' : 'pm'}`;
  } catch {
    return iso;
  }
}

/**
 * Parse a citation string of the form
 *   "Author et al. (Year). Title. Journal."
 * and wrap the trailing journal name in <em>. Falls back to raw escaped text.
 */
function formatCitation(citation: string): string {
  // Find the last '. ' that separates the title from the journal.
  // citation may end with a period; skip the final period when searching.
  const searchIn = citation.endsWith('.') ? citation.slice(0, -1) : citation;
  const lastDot = searchIn.lastIndexOf('. ');
  if (lastDot === -1) return esc(citation);
  const body = citation.slice(0, lastDot + 1);   // up to and including the dot
  const journal = citation.slice(lastDot + 2);    // skip '. '
  return `${esc(body)} <em>${esc(journal)}</em>`;
}

/** Build a name lookup from proposed_formulation + excluded_from_pod tsi_codes → names. */
function buildIngredientMap(output: AnalysisOutput): Map<string, string> {
  const map = new Map<string, string>();
  for (const ing of output.proposed_formulation ?? []) {
    const i = ing as Record<string, unknown>;
    if (i.tsi_code) map.set(String(i.tsi_code), String(i.common_name ?? i.tsi_code));
  }
  for (const ex of output.excluded_from_pod ?? []) {
    const e = ex as Record<string, unknown>;
    if (e.tsi_code) map.set(String(e.tsi_code), String(e.ingredient_name ?? e.tsi_code));
  }
  return map;
}

function resolveIngredients(
  codes: unknown[],
  localMap: Map<string, string>,
  tsiResolver?: (code: string) => string | undefined,
): string {
  if (!codes || codes.length === 0) return '—';
  return codes
    .map((c) => {
      const code = String(c);
      return localMap.get(code) ?? tsiResolver?.(code) ?? code;
    })
    .join(', ');
}

/** Status-pill background and text color based on direction/status string. */
function pillColors(statusOrDirection: string): { bg: string; color: string } {
  const s = (statusOrDirection ?? '').toLowerCase();
  if (s.includes('fast') || s.includes('upregulat') || s.includes('high')) {
    return { bg: '#F2EADA', color: '#7A6A3E' };
  }
  // default: surfacePill / olive
  return { bg: '#EDEDE4', color: '#535B50' };
}

// ---------------------------------------------------------------------------
// CSS — all inline in the <head> so the file is self-contained
// ---------------------------------------------------------------------------

const CSS = `
  @page { size: A4; margin: 0.7in; }

  *, *::before, *::after { box-sizing: border-box; }

  body {
    margin: 0;
    font-family: 'Source Serif 4', Georgia, serif;
    font-size: 10.5pt;
    line-height: 1.6;
    color: #23261F;
    background: #ffffff;
  }

  h1, h2, h3, p { margin: 0; }
  em { font-style: italic; }
  strong { font-weight: 600; }

  /* Utility: Jost (UI) font class */
  .jost { font-family: 'Jost', sans-serif; }

  /* Breaking hints */
  .break-avoid { break-inside: avoid; }
  .break-after-avoid { break-after: avoid; }

  /* Section heading block */
  .section-heading {
    display: flex;
    align-items: baseline;
    gap: 14px;
    border-bottom: 2px solid #535B50;
    padding-bottom: 8px;
    break-inside: avoid;
    break-after: avoid;
    margin-bottom: 14px;
  }
  .section-numeral {
    font-family: 'Jost', sans-serif;
    font-weight: 300;
    font-size: 22pt;
    line-height: 1;
    color: #C6AF81;
    flex: none;
  }
  .section-title {
    font-family: 'Jost', sans-serif;
    font-weight: 500;
    font-size: 15pt;
    letter-spacing: .01em;
    color: #2E332A;
  }

  /* Eyebrow labels */
  .eyebrow {
    font-family: 'Jost', sans-serif;
    font-size: 8.5pt;
    font-weight: 500;
    letter-spacing: .16em;
    text-transform: uppercase;
    color: #8A8F81;
  }

  /* Body paragraph with max-width */
  p.body { max-width: 46em; }

  /* Status pill */
  .pill {
    display: inline-block;
    font-family: 'Jost', sans-serif;
    font-size: 8pt;
    letter-spacing: .1em;
    text-transform: uppercase;
    padding: 3px 8px;
  }

  /* Card field label (inside finding cards) */
  .field-label {
    font-family: 'Jost', sans-serif;
    font-size: 7.5pt;
    letter-spacing: .12em;
    text-transform: uppercase;
    color: #9A9F91;
    padding-top: 3px;
  }

  /* Gold bullet for areas of strength */
  .gold-bullet {
    flex: none;
    margin-top: 6px;
    width: 6px;
    height: 6px;
    background: #C6AF81;
  }

  /* Companion schedule callout (olive block) */
  .companion-callout {
    background: #535B50;
    color: #EFEEE7;
    padding: 16px 20px;
    margin-bottom: 34px;
  }
`;

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

/** Section heading HTML with (optional) section numeral. */
function sectionHeading(num: number | null, title: string): string {
  const numeral = num != null
    ? `<div class="section-numeral">${String(num).padStart(2, '0')}</div>` : '';
  return `
  <div class="section-heading break-avoid break-after-avoid" style="margin:0 0 14px">
    <div style="display:flex;align-items:baseline;gap:14px;border-bottom:2px solid #535B50;padding-bottom:8px">
      ${numeral}
      <h2 class="section-title">${esc(title)}</h2>
    </div>
  </div>`;
}

function buildCoverBand(
  logoBase64: string | undefined,
  logoMimeType: string,
  submissionId: string,
  patientPseudonym: string,
  generatedAt: string,
): string {
  const logoSrc = logoBase64
    ? `data:${logoMimeType};base64,${logoBase64}`
    : '';
  const logoImg = logoSrc
    ? `<img src="${logoSrc}" alt="N of 1" style="display:block;width:132px;height:auto;margin-bottom:38px" />`
    : `<div style="font-family:Jost,sans-serif;font-weight:700;font-size:20pt;color:#C6AF81;margin-bottom:38px">N of 1</div>`;

  return `
  <div class="break-avoid" style="background:#535B50;margin:0 -0.7in;padding:0.5in 0.7in 0.5in;color:#F4F3EE">
    ${logoImg}
    <div style="font-family:Jost,sans-serif;font-size:8.5pt;letter-spacing:.24em;text-transform:uppercase;color:#C6AF81;margin-bottom:14px">Precision Formulation</div>
    <h1 style="font-family:Jost,sans-serif;font-weight:300;font-size:34pt;line-height:1.05;letter-spacing:-0.01em;margin:0 0 16px">Health Analysis</h1>
    <div style="display:flex;flex-wrap:wrap;gap:10px 22px;font-family:Jost,sans-serif;font-size:9.5pt;font-weight:300;letter-spacing:.02em;color:#D6D8CE">
      <div>Submission ${esc(submissionId)}</div>
      <div style="color:#8E9686">|</div>
      <div>Patient ${esc(patientPseudonym)}</div>
      <div style="color:#8E9686">|</div>
      <div>Generated ${esc(generatedAt)}</div>
    </div>
  </div>`;
}

function buildDraftNotice(): string {
  return `
  <div class="break-avoid" style="margin:0 -0.7in;padding:16px 0.7in 18px;background:#EFEDE4;border-bottom:1px solid #DEDCD2">
    <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:7px">
      <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#C6AF81"></span>
      <div style="font-family:Jost,sans-serif;font-weight:600;font-size:9pt;letter-spacing:.16em;text-transform:uppercase;color:#535B50">Draft — pending practitioner review and approval</div>
    </div>
    <p style="margin:0 0 0 19px;font-size:9.5pt;line-height:1.55;color:#4A4E43;max-width:44em">This document is decision support for a qualified healthcare practitioner. It is not a diagnosis, not a prescription, and not directed to the patient. The reviewing practitioner is the prescribing clinician of record and exercises independent clinical judgement on every recommendation contained herein.</p>
  </div>`;
}

function buildMetadataGrid(
  requestMetadata: Record<string, unknown> | undefined,
  routeAudit: RouteAuditBlock | undefined,
): string {
  const fields: Array<[string, string]> = [
    ['Patient pseudonym', String(requestMetadata?.patient_pseudonym ?? '—')],
    ['Age', String(requestMetadata?.patient_age_years ?? '—')],
    ['Sex (at birth)', upperFirst(String(requestMetadata?.patient_sex_assigned_at_birth ?? '—'))],
    ['Test type', String(requestMetadata?.test_type ?? routeAudit?.test_type ?? '—')],
    ['Lab ID', String(requestMetadata?.test_lab_id ?? routeAudit?.test_lab_id ?? '—')],
    ['Collection date', String(requestMetadata?.test_collection_date ?? '—')],
    ['Practitioner ID', String(requestMetadata?.practitioner_id ?? routeAudit?.practitioner_id ?? '—')],
    ['Practitioner type', upperFirst(String(requestMetadata?.practitioner_type ?? routeAudit?.practitioner_type ?? '—'))],
    ['Generated', formatDate(routeAudit?.generated_at_iso)],
  ];

  const cells = fields.map(([label, value]) => `
    <div style="padding:11px 14px;border-right:1px solid #DEDCD2;border-bottom:1px solid #DEDCD2">
      <div style="font-family:Jost,sans-serif;font-size:7.5pt;letter-spacing:.14em;text-transform:uppercase;color:#8A8F81;margin-bottom:3px">${esc(label)}</div>
      <div style="font-family:Jost,sans-serif;font-size:10.5pt;color:#23261F">${esc(value)}</div>
    </div>`).join('');

  return `
  <div class="break-avoid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin:26px 0 34px;border-top:1px solid #DEDCD2;border-left:1px solid #DEDCD2">
    ${cells}
  </div>`;
}

function buildSection01(output: AnalysisOutput): string {
  // Executive summary — handle both string and structured object forms
  const es = output.executive_summary as unknown;
  let summaryHtml = '';
  if (typeof es === 'string') {
    summaryHtml = `<p class="body" style="margin:0 0 18px">${esc(es)}</p>`;
  } else if (es && typeof es === 'object') {
    const obj = es as Record<string, string>;
    const parts = [obj.headline, obj.primary_findings, obj.areas_within_reference, obj.framing_for_practitioner]
      .filter(Boolean);
    summaryHtml = parts.map((p, i) =>
      `<p class="body" style="margin:0 0 ${i < parts.length - 1 ? '10px' : '18px'}">${esc(p)}</p>`
    ).join('');
  }

  const patterns = output.recognised_patterns ?? [];
  let patternsHtml = '';
  if (patterns.length > 0) {
    const cards = patterns.map((p) => {
      const pat = p as Record<string, unknown>;
      const name = String(pat.pattern_name ?? '—');
      const sf = pat.supporting_findings;
      const snps = Array.isArray(sf) ? sf.map(String).join(' · ') : String(sf ?? '');
      return `
      <div class="break-avoid" style="background:#F4F3EC;border-left:3px solid #C6AF81;padding:13px 15px">
        <div style="font-family:Jost,sans-serif;font-weight:500;font-size:10.5pt;color:#2E332A;margin-bottom:5px">${esc(name)}</div>
        <div style="font-size:9pt;line-height:1.5;color:#5C6155">${esc(snps)}</div>
      </div>`;
    }).join('');

    patternsHtml = `
    <div class="eyebrow" style="margin:0 0 12px">Recognised clinical patterns</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:34px">
      ${cards}
    </div>`;
  }

  return summaryHtml + patternsHtml;
}

function buildSection02(output: AnalysisOutput): string {
  const findings = (output as unknown as Record<string, unknown>).biomarker_findings as unknown[] | undefined;
  if (!findings || findings.length === 0) return '';

  const count = findings.length;
  const countWord = count <= 10 ? spellNumber(count) : String(count);
  const intro = `<p class="body" style="margin:0 0 6px">The following ${countWord} biomarker finding${count !== 1 ? 's are' : ' is'} surfaced for practitioner review. Each finding includes a hedged interpretation, possible contributors per the published literature, and the relevance of the finding to the formulation strategy.</p>`;

  const cards = findings.map((f, idx) => {
    const finding = f as Record<string, unknown>;
    const geneName = String(finding.gene ?? finding.biomarker_name ?? finding.marker_name ?? '—');
    const rsid = finding.rsid ? ` <span style="font-weight:300;color:#8A8F81">(${esc(String(finding.rsid))})</span>` : '';
    const genotypeLabel = String(finding.genotypeLabel ?? finding.status_label ?? finding.measured_value ?? '');
    const direction = String(finding.direction ?? finding.status ?? '');
    const pc = pillColors(direction);
    const isLast = idx === findings.length - 1;

    const interpretation = String(finding.interpretation ?? '');
    const contributors = String(finding.contributors ?? '');
    const formulationRelevance = String(finding.formulationRelevance ?? finding.formulation_relevance ?? '');

    return `
    <div class="break-avoid" style="padding:14px 0 12px;border-top:1px solid #E4E2DA${isLast ? ';border-bottom:1px solid #E4E2DA' : ''}">
      <div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 12px;margin-bottom:8px">
        <div style="font-family:Jost,sans-serif;font-weight:600;font-size:11pt;color:#2E332A">${esc(geneName)}${rsid}</div>
        ${genotypeLabel ? `<div class="pill" style="background:${pc.bg};color:${pc.color}">${esc(genotypeLabel)}</div>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:104px 1fr;gap:5px 14px;font-size:9.5pt;line-height:1.5">
        ${interpretation ? `<div class="field-label">Interpretation</div><div>${esc(interpretation)}</div>` : ''}
        ${contributors ? `<div class="field-label">Contributors</div><div style="color:#5C6155">${esc(contributors)}</div>` : ''}
        ${formulationRelevance ? `<div class="field-label">Formulation</div><div>${esc(formulationRelevance)}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  return `${intro}<div style="margin-bottom:34px">${cards}</div>`;
}

function buildSection03(output: AnalysisOutput): string {
  const items = (output as unknown as Record<string, unknown>).diet_and_lifestyle_considerations as unknown[] | undefined;
  if (!items || items.length === 0) return '';

  const intro = `<p class="body" style="margin:0 0 20px">The following considerations are surfaced for practitioner-led discussion. They sit alongside the recommended formulation rather than substituting for it.</p>`;

  const rows = items.map((item, idx) => {
    const it = item as Record<string, unknown>;
    const topic = String(it.topic ?? '—');
    const consideration = String(it.consideration ?? '');
    const rationale = String(it.rationale ?? '');
    const isLast = idx === items.length - 1;

    return `
    <div class="break-avoid" style="display:grid;grid-template-columns:150px 1fr;gap:16px;padding-bottom:14px${!isLast ? ';border-bottom:1px solid #E4E2DA' : ''}">
      <div style="font-family:Jost,sans-serif;font-weight:500;font-size:10.5pt;color:#535B50">${esc(topic)}</div>
      <div>
        <p style="margin:0 0 5px">${esc(consideration)}</p>
        ${rationale ? `<p style="margin:0;font-size:9pt;color:#7A7F72"><span style="font-family:Jost,sans-serif;font-size:7.5pt;letter-spacing:.12em;text-transform:uppercase;color:#9A9F91">Rationale &nbsp;</span>${esc(rationale)}</p>` : ''}
      </div>
    </div>`;
  }).join('');

  return `${intro}<div style="display:grid;gap:14px;margin-bottom:34px">${rows}</div>`;
}

function buildSection04(output: AnalysisOutput): string {
  const fl = (output.formulation_logic ?? {}) as Record<string, unknown>;
  const strategy = String(fl.overall_strategy ?? fl.strategy ?? '');

  // Intentionally included — rendered from proposed_formulation[] (Bug 2 fix)
  const included = output.proposed_formulation ?? [];
  const includedRows = included.map((ing) => {
    const i = ing as Record<string, unknown>;
    const name = String(i.common_name ?? i.ingredient_name ?? '—');
    const dose = i.proposed_dose != null ? ` ${i.proposed_dose} ${i.dose_unit ?? ''}`.trim() : '';
    const rationale = String(i.rationale_for_practitioner ?? '');
    return `
    <div class="break-avoid" style="display:grid;grid-template-columns:200px 1fr;gap:16px;padding:9px 0;border-bottom:1px solid #EDEBE3">
      <div style="font-family:Jost,sans-serif;font-size:10pt;color:#2E332A">
        ${esc(name)}${dose ? ` <span style="color:#9A9F91">${esc(dose)}</span>` : ''}
      </div>
      <div style="font-size:9.5pt;line-height:1.5">${esc(rationale)}</div>
    </div>`;
  }).join('');

  // Intentionally excluded — rendered from excluded_from_pod[]
  const excluded = output.excluded_from_pod ?? [];
  const excludedRows = excluded.map((ex) => {
    const e = ex as Record<string, unknown>;
    const name = String(e.ingredient_name ?? e.common_name ?? '—');
    const code = e.tsi_code ? ` <span style="color:#9A9F91">${esc(String(e.tsi_code))}</span>` : '';
    const reason = String(e.reason_excluded ?? e.reason ?? '');
    return `
    <div class="break-avoid" style="display:grid;grid-template-columns:200px 1fr;gap:16px;padding:9px 0;border-bottom:1px solid #EDEBE3">
      <div style="font-family:Jost,sans-serif;font-size:10pt;color:#2E332A">${esc(name)}${code}</div>
      <div style="font-size:9.5pt;line-height:1.5">${esc(reason)}</div>
    </div>`;
  }).join('');

  // Companion callout
  const callout = `
  <div class="companion-callout break-avoid">
    <p style="margin:0;font-size:9.5pt;line-height:1.55">The detailed ingredient-by-ingredient formulation, including doses, granule counts, and per-ingredient rationale, is in the companion <strong style="color:#E4D6B4">Recommended Formulation Schedule (.xlsx)</strong>.</p>
  </div>`;

  return `
  ${strategy ? `<div class="eyebrow" style="margin:0 0 8px">Overall strategy</div><p class="body" style="margin:0 0 24px">${esc(strategy)}</p>` : ''}
  ${included.length > 0 ? `
  <div class="eyebrow" style="margin:0 0 10px">Intentionally included</div>
  <div style="margin-bottom:24px;border-top:1px solid #DEDCD2">${includedRows}</div>` : ''}
  ${excluded.length > 0 ? `
  <div class="eyebrow" style="margin:0 0 10px">Intentionally excluded</div>
  <div style="margin-bottom:34px;border-top:1px solid #DEDCD2">${excludedRows}</div>` : ''}
  ${callout}`;
}

function buildSection05(
  output: AnalysisOutput,
  ingredientMap: Map<string, string>,
  tsiResolver?: (code: string) => string | undefined,
): string {
  const flags = output.contraindication_flags ?? [];
  const exclusions = output.binding_exclusions_applied ?? [];

  const count = flags.length;
  const countWord = count <= 10 ? upperFirst(spellNumber(count)) : String(count);
  const intro = count > 0
    ? `<p class="body" style="margin:0 0 14px">${countWord} contraindication or interaction consideration${count !== 1 ? 's are' : ' is'} raised for practitioner review.</p>`
    : `<p class="body" style="margin:0 0 14px">No contraindication or interaction considerations are raised on this panel.</p>`;

  // Severity sort descending
  const severityRank = (s: string): number => {
    const sl = s.toLowerCase();
    if (sl.includes('high') || sl.includes('critical')) return 4;
    if (sl.includes('monitor') || sl.includes('moderate')) return 3;
    if (sl.includes('informational')) return 2;
    return 1;
  };
  const sortedFlags = [...flags].sort((a, b) => {
    const sa = String((a as Record<string, unknown>).severity ?? '');
    const sb = String((b as Record<string, unknown>).severity ?? '');
    return severityRank(sb) - severityRank(sa);
  });

  const severityColor = (s: string): string => {
    const sl = s.toLowerCase();
    if (sl.includes('monitor') || sl.includes('moderate')) return '#7A6A3E';
    if (sl.includes('high') || sl.includes('critical')) return '#535B50';
    return '#8A8F81';
  };

  const tableRows = sortedFlags.map((f) => {
    const flag = f as Record<string, unknown>;
    const severity = String(flag.severity ?? '');
    const flagName = String(flag.flag ?? flag.interaction_or_contraindication ?? '—');
    const description = String(flag.description ?? '');
    const codes = (flag.affected_tsi_codes as string[] | undefined) ?? [];
    const ingredients = resolveIngredients(codes, ingredientMap, tsiResolver);
    return `
      <tr class="break-avoid">
        <td style="padding:10px;border-bottom:1px solid #E4E2DA;vertical-align:top;font-family:Jost,sans-serif;font-size:8pt;letter-spacing:.06em;text-transform:uppercase;color:${severityColor(severity)}">${esc(severity)}</td>
        <td style="padding:10px;border-bottom:1px solid #E4E2DA;vertical-align:top;font-family:Jost,sans-serif;font-size:8.5pt;color:#535B50">${esc(flagName)}</td>
        <td style="padding:10px;border-bottom:1px solid #E4E2DA;vertical-align:top">${esc(description)}</td>
        <td style="padding:10px;border-bottom:1px solid #E4E2DA;vertical-align:top;color:#5C6155">${esc(ingredients)}</td>
      </tr>`;
  }).join('');

  const table = flags.length > 0 ? `
  <table style="width:100%;border-collapse:collapse;font-size:9pt;line-height:1.45;margin-bottom:26px">
    <thead>
      <tr>
        <th style="text-align:left;font-family:Jost,sans-serif;font-size:7.5pt;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:#F1F0EA;background:#535B50;padding:8px 10px;width:88px">Severity</th>
        <th style="text-align:left;font-family:Jost,sans-serif;font-size:7.5pt;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:#F1F0EA;background:#535B50;padding:8px 10px;width:120px">Flag</th>
        <th style="text-align:left;font-family:Jost,sans-serif;font-size:7.5pt;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:#F1F0EA;background:#535B50;padding:8px 10px">Description</th>
        <th style="text-align:left;font-family:Jost,sans-serif;font-size:7.5pt;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:#F1F0EA;background:#535B50;padding:8px 10px;width:104px">Ingredients</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>` : '';

  const exclusionsHtml = exclusions.length > 0 ? (() => {
    const excCount = exclusions.length;
    const excWord = excCount === 1 ? 'One binding exclusion applied' : `${upperFirst(spellNumber(excCount))} binding exclusions applied`;
    const cards = exclusions.map((ex) => {
      const e = ex as Record<string, unknown>;
      const name = String(e.ingredient_name ?? e.ingredient ?? '—');
      const reason = String(e.practitioner_note ?? e.panel_finding_that_triggered ?? e.reason ?? '');
      return `
      <div class="break-avoid" style="border-left:3px solid #C6AF81;background:#F4F3EC;padding:14px 16px;margin-bottom:12px">
        <div style="font-family:Jost,sans-serif;font-weight:500;font-size:10.5pt;color:#2E332A;margin-bottom:5px">${esc(name)} — excluded</div>
        <p style="margin:0;font-size:9.5pt;line-height:1.55;color:#4A4E43">${esc(reason)}</p>
      </div>`;
    }).join('');
    return `
    <div class="eyebrow" style="margin:0 0 10px">Binding exclusions applied</div>
    <p style="margin:0 0 12px;max-width:46em;font-size:9.5pt">${excWord}. These are ingredients held out of the pod because the panel does not measure the data needed to confirm safety, or the panel data crossed a hard exclusion threshold.</p>
    <div style="margin-bottom:34px">${cards}</div>`;
  })() : '';

  return `${intro}${table}${exclusionsHtml}`;
}

function buildSection06(output: AnalysisOutput): string {
  const mf = (output as unknown as Record<string, unknown>).monitoring_and_followup as Record<string, unknown> | undefined;
  if (!mf) return '';

  const intro = String(mf.intro ?? '');
  const markers = (mf.markers ?? mf.monitoring_markers ?? []) as unknown[];
  const caveat = String(mf.caveat ?? '');
  const eyebrow = String(mf.markers_eyebrow ?? 'Markers for consideration at follow-up');

  const markerRows = markers.map((m) => {
    const marker = m as Record<string, unknown>;
    const name = String(marker.marker ?? marker.name ?? m);
    const qualifier = String(marker.qualifier ?? '');
    const fullWidth = Boolean(marker.full_width ?? marker.fullWidth ?? false);
    const span = fullWidth ? 'grid-column:span 2;' : '';
    return `<div style="padding:7px 0;border-bottom:1px solid #EDEBE3;${span}">${esc(name)}${qualifier ? ` <span style="color:#9A9F91">— ${esc(qualifier)}</span>` : ''}</div>`;
  }).join('');

  return `
  ${intro ? `<p class="body" style="margin:0 0 16px">${esc(intro)}</p>` : ''}
  ${eyebrow ? `<div class="eyebrow" style="margin:0 0 10px">${esc(eyebrow)}</div>` : ''}
  ${markers.length > 0 ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 26px;margin-bottom:16px;font-size:9.5pt">${markerRows}</div>` : ''}
  ${caveat ? `<p style="margin:0 0 34px;font-size:9.5pt;font-style:italic;color:#7A7F72">${esc(caveat)}</p>` : ''}`;
}

function buildSection07(output: AnalysisOutput): string {
  const strengths = output.areas_of_strength ?? [];
  if (strengths.length === 0) return '';

  const count = strengths.length;
  const countWord = spellNumber(count);

  const items = strengths.map((s) => {
    const text = typeof s === 'string' ? s : String((s as Record<string, unknown>).description ?? s);
    return `
    <div class="break-avoid" style="display:flex;gap:12px;align-items:flex-start;font-size:9.5pt;line-height:1.5">
      <span class="gold-bullet"></span>
      <div>${esc(text)}</div>
    </div>`;
  }).join('');

  return `
  <p class="body" style="margin:0 0 14px">${upperFirst(countWord)} finding${count !== 1 ? 's' : ''} on this panel ${count !== 1 ? 'are' : 'is'} within reference and surfaced as an area of clinical strength to contextualise the findings above.</p>
  <div style="display:grid;gap:9px;margin-bottom:34px">${items}</div>`;
}

function buildReferences(output: AnalysisOutput): string {
  const refs = output.references ?? [];
  if (refs.length === 0) return '';

  const entries = refs.map((r, idx) => {
    const ref = r as Record<string, unknown>;
    // New format: {ingredient_name, citation}
    // Legacy format: {index, authors, year, title, journal, supports}
    let body: string;
    if (ref.citation) {
      body = formatCitation(String(ref.citation));
      const supports = ref.ingredient_name ?? ref.supports;
      if (supports) body += ` — ${esc(String(supports))}`;
    } else {
      const authors = String(ref.authors ?? '');
      const year = ref.year ? ` (${ref.year})` : '';
      const title = String(ref.title ?? '');
      const journal = ref.journal ? `<em>${esc(String(ref.journal))}</em>` : '';
      const supports = ref.supports ? ` — ${esc(String(ref.supports))}` : '';
      body = `${esc(authors)}${esc(year)}. ${esc(title)}. ${journal}.${supports}`;
    }
    const num = ref.index ?? idx + 1;
    return `<p style="margin:0 0 7px;break-inside:avoid"><span style="color:#C6AF81;font-family:Jost,sans-serif">${esc(String(num))}</span> &nbsp;${body}</p>`;
  }).join('');

  return `
  <p class="body" style="margin:0 0 14px;font-size:9.5pt;color:#5C6155">Key published studies cited by the clinical decision support system in support of each formulation decision. Citations should be independently verified by the reviewing practitioner before clinical reliance.</p>
  <div style="column-count:2;column-gap:26px;font-size:8.5pt;line-height:1.45;color:#4A4E43">${entries}</div>`;
}

function buildClosingBlock(submissionId: string, generatedAt: string, auditRef: string): string {
  return `
  <div class="break-avoid" style="margin-top:32px;padding-top:16px;border-top:2px solid #535B50">
    <p style="margin:0 0 10px;font-family:Jost,sans-serif;font-size:9pt;font-weight:500;color:#535B50">Patients should not act on the contents of this document without the direct guidance of their treating practitioner.</p>
    <div style="display:flex;flex-wrap:wrap;gap:6px 20px;font-family:Jost,sans-serif;font-size:8pt;letter-spacing:.1em;text-transform:uppercase;color:#9A9F91">
      <div>Submission ${esc(submissionId)}</div>
      <div>Generated ${esc(generatedAt)}</div>
      <div>Audit reference ${esc(auditRef)}</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build the complete self-contained HTML string for the Health Analysis PDF.
 * Embed the logo as a base64 data URI — Puppeteer's setContent() cannot
 * resolve relative file paths.
 */
export function buildHealthAnalysisHtml(opts: HealthAnalysisHtmlOptions): string {
  const { output, routeAudit, requestMetadata, logoBase64, logoMimeType = 'image/png',
          auditReference, tsiResolver } = opts;

  // Derived values
  const submissionId = String(
    requestMetadata?.submission_id ?? routeAudit?.submission_id ?? output.audit_metadata?.submission_id ?? 'unknown',
  );
  const patientPseudonym = String(requestMetadata?.patient_pseudonym ?? '—');
  const generatedAt = formatDate(routeAudit?.generated_at_iso);
  const auditRef = auditReference ?? submissionId;

  // Build TSI code → name lookup for contraindication ingredient resolution
  const ingredientMap = buildIngredientMap(output);

  // Determine which sections have content and assign section numbers dynamically
  interface Section { title: string; content: string }
  const candidateSections: Section[] = [
    {
      title: 'Executive Summary',
      content: buildSection01(output),
    },
    {
      title: 'Detailed Biomarker Analysis',
      content: buildSection02(output),
    },
    {
      title: 'Diet and Lifestyle Considerations',
      content: buildSection03(output),
    },
    {
      title: 'Recommended Formulation Logic',
      content: buildSection04(output),
    },
    {
      title: 'Contraindication and Interaction Considerations',
      content: buildSection05(output, ingredientMap, tsiResolver),
    },
    {
      title: 'Monitoring and Follow-Up',
      content: buildSection06(output),
    },
    {
      title: 'Areas of Strength',
      content: buildSection07(output),
    },
  ];

  const activeSections = candidateSections.filter((s) => s.content.trim().length > 0);
  const sectionsHtml = activeSections.map((s, idx) => {
    const num = idx + 1;
    return `<div style="margin-bottom:34px">${sectionHeading(num, s.title)}${s.content}</div>`;
  }).join('');

  // References section (no numeral — matches prototype)
  const refsContent = buildReferences(output);
  const refsHtml = refsContent.trim()
    ? `<div style="margin-bottom:34px">${sectionHeading(null, 'References')}${refsContent}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Health Analysis — ${submissionId}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
<link href="https://fonts.googleapis.com/css2?family=Jost:wght@300;400;500;600&family=Source+Serif+4:ital,opsz,wght@0,8..60,300..700;1,8..60,300..600&display=swap" rel="stylesheet" />
<style>${CSS}</style>
</head>
<body>
<div style="font-family:'Source Serif 4',Georgia,serif;color:#23261F;font-size:10.5pt;line-height:1.6">

  ${buildCoverBand(logoBase64, logoMimeType, submissionId, patientPseudonym, generatedAt)}
  ${buildDraftNotice()}
  ${buildMetadataGrid(requestMetadata, routeAudit)}

  ${sectionsHtml}
  ${refsHtml}
  ${buildClosingBlock(submissionId, generatedAt, auditRef)}

</div>
</body>
</html>`;
}
