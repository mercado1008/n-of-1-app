/**
 * HealthAnalysisDocument
 *
 * Full-page document component. Pure function of one validated HealthAnalysis
 * object — no client-side state, no event handlers, no useEffect.
 *
 * Renders as a simulated A4 sheet on screen (white paper on cloud-grey
 * desktop). In step 5 a print stylesheet will convert this to true
 * paginated output; in step 6 Puppeteer will render it to PDF.
 *
 * Document structure (matches design_handoff_health_analysis/README.md):
 *   Running header (inline for now; becomes @page fixed in step 5)
 *   Cover band (full-bleed olive)
 *   Draft notice (conditional on status === 'draft')
 *   Metadata grid (9 cells, 3 columns)
 *   §01 Executive Summary
 *   §02 Detailed Biomarker Analysis
 *   §03 Diet and Lifestyle Considerations
 *   §04 Recommended Formulation Logic
 *   §05 Contraindication and Interaction Considerations
 *   §06 Monitoring and Follow-Up
 *   §07 Areas of Strength (conditional on areasOfStrength.length > 0)
 *   References (conditional, no numeral)
 *   Closing block
 *   Running footer
 *
 * Prototype reference: design_handoff_health_analysis/NofISHealthAnalysis.dc.html
 */
import Image from 'next/image';
import type { HealthAnalysis, Contraindication } from '../../lib/health-analysis-schema';
import { FindingCard } from './FindingCard';
import { PatternCard } from './PatternCard';
import { SectionHeading } from './SectionHeading';
import { LifestyleRow } from './LifestyleRow';
import { IngredientRow } from './IngredientRow';
import { ReferenceEntry } from './ReferenceEntry';
// Static import — Next.js processes this at build time and serves from /_next/static/media/
// design_handoff_health_analysis/assets/logo.png has the olive background (#535B50) baked in,
// matching the cover band exactly — so it renders seamlessly on the dark olive block.
// nof1_logo_header.jpg has a black background and is NOT suitable for the cover band.
import logoImg from '../../../design_handoff_health_analysis/assets/logo.png';

// ── Helpers ───────────────────────────────────────────────────────────────────

const SPELL = ['zero','one','two','three','four','five','six','seven','eight','nine','ten'] as const;

/** Numbers 0–10 spelled as words; 11+ as numerals. Matches prototype prose style. */
function spellNumber(n: number): string {
  return n >= 0 && n <= 10 ? SPELL[n] : String(n);
}

/** Capitalise the first character of a string. */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Severity cell colour per prototype: "monitor" → goldDeep, everything else → ink.label */
function severityColour(severity: Contraindication['severity']): string {
  return severity === 'monitor' ? '#7A6A3E' : '#8A8F81';
}

/** Human-readable severity label. */
function severityLabel(severity: Contraindication['severity']): string {
  if (severity === 'lowInContext') return 'Low in context';
  return cap(severity);
}

/** Companion schedule note: bold the ".xlsx" mention if present. */
const XLSX_MARK = 'Recommended Formulation Schedule (.xlsx)';
function CompanionNote({ note }: { note: string }) {
  const idx = note.indexOf(XLSX_MARK);
  if (idx < 0) return <p className="m-0 text-[9.5pt] leading-[1.55] text-[#EFEEE7]">{note}</p>;
  return (
    <p className="m-0 text-[9.5pt] leading-[1.55] text-[#EFEEE7]">
      {note.slice(0, idx)}
      <strong className="font-semibold text-onOlive-gold">{XLSX_MARK}</strong>
      {note.slice(idx + XLSX_MARK.length)}
    </p>
  );
}

// ── Subsection eyebrow ────────────────────────────────────────────────────────
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-jost text-[8.5pt] font-medium tracking-[.16em] uppercase text-ink-label mb-[10px]">
      {children}
    </div>
  );
}

// ── Section gap ───────────────────────────────────────────────────────────────
// 34px bottom margin after each completed section block.
const SECTION_GAP = 'mb-[34px]';

// ── Main component ────────────────────────────────────────────────────────────

interface HealthAnalysisDocumentProps {
  doc: HealthAnalysis;
}

export function HealthAnalysisDocument({ doc }: HealthAnalysisDocumentProps) {
  const {
    submissionId, patientPseudonym, age, sexAtBirth, testType, labId,
    collectionDate, practitionerId, practitionerType, generatedAt, auditReference,
    status, executiveSummary, clinicalPatterns, findings, lifestyleConsiderations,
    formulationStrategy, contraindications, bindingExclusions, monitoring,
    areasOfStrength, references,
  } = doc;

  // ── Conditional sections ─────────────────────────────────────────────────
  const showStrengths  = areasOfStrength.length > 0;
  const showReferences = references.length > 0;

  // ── Section numbers (always 01–06; 07 only when strengths present) ───────
  // References have no numeral (per prototype + README).
  const SEC = {
    executive:        '01',
    findings:         '02',
    lifestyle:        '03',
    formulation:      '04',
    contraindications:'05',
    monitoring:       '06',
    strengths:        showStrengths ? '07' : undefined,
  };

  // ── Generated-at formatted strings ───────────────────────────────────────
  // Cover band shows date only; closing block and footer show date + time.
  const generatedDate = (() => {
    try {
      return new Date(generatedAt).toLocaleDateString('en-AU', {
        day: 'numeric', month: 'long', year: 'numeric',
      });
    } catch { return generatedAt; }
  })();

  const generatedDisplay = (() => {
    try {
      return new Date(generatedAt).toLocaleString('en-AU', {
        day: 'numeric', month: 'long', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
      });
    } catch { return generatedAt; }
  })();

  // ── Logo intrinsic height (maintain aspect ratio at 132px display width) ─
  const logoDisplayH = Math.round((logoImg.height / logoImg.width) * 132);

  // ── Prose count strings ──────────────────────────────────────────────────
  const findingCountStr = `${findings.length > 10 ? findings.length : spellNumber(findings.length)} biomarker finding${findings.length === 1 ? '' : 's'}`;
  const contrainCountStr = `${cap(spellNumber(contraindications.length))} contraindication or interaction consideration${contraindications.length === 1 ? '' : 's'}`;
  const exclusionCountStr = `${cap(spellNumber(bindingExclusions.length))} binding exclusion${bindingExclusions.length === 1 ? '' : 's'} applied.`;
  const strengthCountStr = `${cap(spellNumber(areasOfStrength.length))} finding${areasOfStrength.length === 1 ? '' : 's'}`;

  return (
    // "Paper on desk" preview wrapper.
    // doc-desktop / doc-paper classes are targeted by globals.css @media print rules
    // to strip screen decorations and make the sheet fill the A4 page.
    <div className="bg-cloud min-h-screen py-8 doc-desktop">
      <div
        className="relative bg-paper mx-auto shadow-sm text-ink-body doc-paper"
        style={{
          width: '210mm',
          fontFamily: 'var(--font-serif)',
          fontSize: '10.5pt',
          lineHeight: '1.6',
        }}
      >
        {/* ── Running header ────────────────────────────────────────────────────
            doc-header-wrap becomes position:fixed in print (globals.css), repeating
            the header line on every page. pt-[0.7in] provides the top page margin
            when @page { margin: 0 } is active.
        */}
        <div className="doc-header-wrap">
          <div className="px-[0.7in]">
            <div className="pt-[0.7in] pb-[7px] border-b border-rule-strong flex items-center justify-between gap-4 font-jost text-[7.5pt] tracking-[.14em] uppercase text-ink-label">
              <div className="font-medium text-brand-olive">N of 1</div>
              <div>Health Analysis &nbsp;·&nbsp; Practitioner Decision Support</div>
              <div>{submissionId}</div>
            </div>
          </div>
        </div>

        {/* ── Content body ──────────────────────────────────────────────────────
            doc-body gains padding-top/bottom in print (globals.css) to prevent
            content hiding behind the fixed header/footer. The cover band and draft
            notice use negative horizontal margins (-mx-[0.7in]) to bleed to the
            sheet edge within the px-[0.7in] horizontal padding.
        */}
        <div className="px-[0.7in] doc-body">

          {/* ── Cover band (full-bleed) ─────────────────────────────────────── */}
          {/* margin: 16px -0.7in 0 bleeds to the sheet edge while keeping the
              internal content aligned with the page column (padding: 0.5in 0.7in). */}
          <div
            className="bg-brand-olive text-onOlive"
            style={{
              marginTop: '16px',
              marginLeft: '-0.7in',
              marginRight: '-0.7in',
              marginBottom: '0',
              padding: '0.5in 0.7in',
            }}
          >
            <Image
              src={logoImg}
              alt="N of 1 Precision Formulation"
              width={132}
              height={logoDisplayH}
              className="block mb-[38px]"
              priority
            />
            <div className="font-jost text-[8.5pt] tracking-[.24em] uppercase text-brand-gold mb-[14px]">
              Precision Formulation
            </div>
            <h1
              className="font-jost font-light text-[34pt] leading-[1.05] tracking-[-0.01em] text-onOlive m-0 mb-4"
            >
              Health Analysis
            </h1>
            <div className="flex flex-wrap gap-[10px_22px] font-jost text-[9.5pt] font-light tracking-[.02em] text-onOlive-muted">
              <span>Submission {submissionId}</span>
              <span className="text-onOlive-faint" aria-hidden="true">|</span>
              <span>Patient {patientPseudonym}</span>
              <span className="text-onOlive-faint" aria-hidden="true">|</span>
              <span>Generated {generatedDate}</span>
            </div>
          </div>

          {/* ── Draft notice (conditional, full-bleed) ──────────────────────── */}
          {status === 'draft' && (
            <div
              className="break-inside-avoid bg-surface-notice border-b border-rule-strong"
              style={{
                marginLeft: '-0.7in',
                marginRight: '-0.7in',
                padding: '16px 0.7in 18px',
              }}
            >
              <div className="flex items-baseline gap-3 mb-[7px]">
                {/* Square gold dot — no border-radius per design spec */}
                <span
                  className="flex-none bg-brand-gold"
                  style={{ display: 'inline-block', width: '7px', height: '7px' }}
                  aria-hidden="true"
                />
                <div className="font-jost font-semibold text-[9pt] tracking-[.16em] uppercase text-brand-olive">
                  Draft — pending practitioner review and approval
                </div>
              </div>
              <p className="m-0 ml-[19px] text-[9.5pt] leading-[1.55] text-ink-muted max-w-[44em]">
                This document is decision support for a qualified healthcare practitioner. It is
                not a diagnosis, not a prescription, and not directed to the patient. The
                reviewing practitioner is the prescribing clinician of record and exercises
                independent clinical judgement on every recommendation contained herein.
              </p>
            </div>
          )}

          {/* ── Metadata grid ────────────────────────────────────────────────── */}
          {/* 3-column grid, all cells share left + top border on container;
              each cell adds right + bottom border → hairline grid appearance. */}
          <div
            className="break-inside-avoid mt-[26px] mb-[34px] border-t border-l border-rule-strong"
            style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' }}
          >
            {[
              { label: 'Patient pseudonym', value: patientPseudonym },
              { label: 'Age',               value: String(age) },
              { label: 'Sex (at birth)',     value: cap(sexAtBirth) },
              { label: 'Test type',          value: testType },
              { label: 'Lab ID',             value: labId },
              { label: 'Collection date',    value: collectionDate },
              { label: 'Practitioner ID',    value: practitionerId },
              { label: 'Practitioner type',  value: cap(practitionerType) },
              { label: 'Generated',          value: generatedDisplay },
            ].map(({ label, value }) => (
              <div
                key={label}
                className="border-r border-b border-rule-strong"
                style={{ padding: '11px 14px' }}
              >
                <div className="font-jost text-[7.5pt] tracking-[.14em] uppercase text-ink-label mb-[3px]">
                  {label}
                </div>
                <div className="font-jost text-[10.5pt] text-ink-body">
                  {value}
                </div>
              </div>
            ))}
          </div>

          {/* ════════════════════════════════════════════════════════════════════
              §01 Executive Summary
          ═══════════════════════════════════════════════════════════════════════ */}
          <SectionHeading number={SEC.executive} title="Executive Summary" />
          <p className="m-0 mb-[18px] max-w-[46em]">{executiveSummary}</p>

          <Eyebrow>Recognised clinical patterns</Eyebrow>
          <div
            className={SECTION_GAP}
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}
          >
            {clinicalPatterns.map((p) => (
              <PatternCard key={p.name} pattern={p} />
            ))}
          </div>

          {/* ════════════════════════════════════════════════════════════════════
              §02 Detailed Biomarker Analysis
          ═══════════════════════════════════════════════════════════════════════ */}
          <SectionHeading number={SEC.findings} title="Detailed Biomarker Analysis" />
          <p className="m-0 mb-[6px] max-w-[46em]">
            The following {findingCountStr}{' '}
            {findings.length === 1 ? 'is' : 'are'} surfaced for practitioner review.
            Each finding includes a hedged interpretation, possible contributors per the published
            literature, and the relevance of the finding to the formulation strategy.
            {findings.length > 0 && findings[0].rsid && (
              ' All calls are genotype-only; wild type is considered reference.'
            )}
          </p>

          <div className={SECTION_GAP}>
            {findings.map((f, i) => (
              <FindingCard
                key={`${f.gene}-${i}`}
                finding={f}
                isLast={i === findings.length - 1}
              />
            ))}
          </div>

          {/* ════════════════════════════════════════════════════════════════════
              §03 Diet and Lifestyle Considerations
          ═══════════════════════════════════════════════════════════════════════ */}
          <SectionHeading number={SEC.lifestyle} title="Diet and Lifestyle Considerations" />
          <p className="m-0 mb-[20px] max-w-[46em]">
            The following considerations are surfaced for practitioner-led discussion. They sit
            alongside the recommended formulation rather than substituting for it.
          </p>
          <div className={`flex flex-col gap-[14px] ${SECTION_GAP}`}>
            {lifestyleConsiderations.map((item, i) => (
              <LifestyleRow
                key={item.topic}
                item={item}
                isLast={i === lifestyleConsiderations.length - 1}
              />
            ))}
          </div>

          {/* ════════════════════════════════════════════════════════════════════
              §04 Recommended Formulation Logic
          ═══════════════════════════════════════════════════════════════════════ */}
          <SectionHeading number={SEC.formulation} title="Recommended Formulation Logic" />

          <Eyebrow>Overall strategy</Eyebrow>
          <p className="m-0 mb-[10px] max-w-[46em]">{formulationStrategy.intro}</p>

          {/* Strategy cards — 2-column grid; last card spans both if total is odd */}
          <div
            className="mb-[14px]"
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}
          >
            {formulationStrategy.axes.map((axis, i) => {
              const isLast = i === formulationStrategy.axes.length - 1;
              const spansTwo = isLast && formulationStrategy.axes.length % 2 !== 0;
              return (
                <div
                  key={i}
                  className="break-inside-avoid flex gap-[10px] bg-surface-card px-[13px] py-[11px]"
                  style={spansTwo ? { gridColumn: 'span 2' } : undefined}
                >
                  <div className="font-jost text-[13pt] font-light text-brand-gold leading-none flex-none">
                    {i + 1}
                  </div>
                  <div className="text-[9pt] leading-[1.5]">{axis}</div>
                </div>
              );
            })}
          </div>

          <p className="m-0 mb-[24px] max-w-[46em]">{formulationStrategy.dosingNote}</p>

          {/* Intentionally included */}
          <Eyebrow>Intentionally included</Eyebrow>
          <div className="mb-[24px] border-t border-rule-strong">
            {formulationStrategy.included.map((item) => (
              <IngredientRow
                key={item.name}
                name={item.name}
                badge={item.dose}
                description={item.rationale}
              />
            ))}
          </div>

          {/* Intentionally excluded */}
          <Eyebrow>Intentionally excluded</Eyebrow>
          <div className="mb-[34px] border-t border-rule-strong">
            {formulationStrategy.excluded.map((item) => (
              <IngredientRow
                key={item.name}
                name={item.name}
                badge={item.code}
                description={item.reason}
              />
            ))}
          </div>

          {/* Companion schedule callout — olive background, text in onOlive colours */}
          <div
            className={`break-inside-avoid bg-brand-olive px-[20px] py-[16px] ${SECTION_GAP}`}
          >
            <CompanionNote note={formulationStrategy.companionScheduleNote} />
          </div>

          {/* ════════════════════════════════════════════════════════════════════
              §05 Contraindication and Interaction Considerations
          ═══════════════════════════════════════════════════════════════════════ */}
          <SectionHeading
            number={SEC.contraindications}
            title="Contraindication and Interaction Considerations"
          />
          <p className="m-0 mb-[14px] max-w-[46em]">
            {contrainCountStr}{' '}
            {contraindications.length === 1 ? 'is' : 'are'} raised for practitioner review.
          </p>

          {/* Contraindications table */}
          <table
            className="w-full border-collapse mb-[26px]"
            style={{ fontSize: '9pt', lineHeight: '1.45' }}
          >
            <thead>
              <tr>
                {[
                  { label: 'Severity',     width: '88px'  },
                  { label: 'Flag',         width: '120px' },
                  { label: 'Description',  width: undefined },
                  { label: 'Ingredients',  width: '104px' },
                ].map(({ label, width }) => (
                  <th
                    key={label}
                    className="text-left font-jost text-[7.5pt] font-medium tracking-[.12em] uppercase bg-brand-olive p-[8px_10px]"
                    style={{ color: '#F1F0EA', ...(width ? { width } : {}) }}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {contraindications.map((c, i) => (
                <tr key={i} className="break-inside-avoid">
                  <td
                    className="p-[10px] border-b border-rule-medium align-top font-jost text-[8pt] tracking-[.06em] uppercase"
                    style={{ color: severityColour(c.severity) }}
                  >
                    {severityLabel(c.severity)}
                  </td>
                  <td className="p-[10px] border-b border-rule-medium align-top font-jost text-[8.5pt] text-brand-olive">
                    {c.flag}
                  </td>
                  <td className="p-[10px] border-b border-rule-medium align-top text-ink-body">
                    {c.description}
                  </td>
                  <td className="p-[10px] border-b border-rule-medium align-top text-ink-soft">
                    {c.ingredients.join('; ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Binding exclusions */}
          <Eyebrow>Binding exclusions applied</Eyebrow>
          <p className="m-0 mb-3 max-w-[46em] text-[9.5pt]">
            {exclusionCountStr}{' '}
            These are ingredients held out of the pod because the panel does not measure the
            data needed to confirm safety, or the panel data crossed a hard exclusion threshold.
          </p>
          <div className={`flex flex-col gap-[14px] ${SECTION_GAP}`}>
            {bindingExclusions.map((be) => (
              <div
                key={be.ingredient}
                className="break-inside-avoid bg-surface-card"
                style={{ borderLeft: '3px solid #C6AF81', padding: '14px 16px' }}
              >
                <div className="font-jost font-medium text-[10.5pt] text-brand-oliveDark mb-[5px]">
                  {be.ingredient} — excluded
                </div>
                <p className="m-0 text-[9.5pt] leading-[1.55] text-ink-muted">
                  {be.reason}
                </p>
              </div>
            ))}
          </div>

          {/* ════════════════════════════════════════════════════════════════════
              §06 Monitoring and Follow-Up
          ═══════════════════════════════════════════════════════════════════════ */}
          <SectionHeading number={SEC.monitoring} title="Monitoring and Follow-Up" />
          <p className="m-0 mb-[16px] max-w-[46em]">{monitoring.intro}</p>

          <Eyebrow>Markers for consideration at follow-up</Eyebrow>
          <div
            className="mb-[16px] text-[9.5pt]"
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 26px' }}
          >
            {monitoring.markers.map((m, i) => (
              <div
                key={i}
                className="py-[7px] border-b border-rule-light"
                style={m.fullWidth ? { gridColumn: 'span 2' } : undefined}
              >
                {m.marker}
                {m.qualifier && (
                  <span className="text-ink-labelLight"> — {m.qualifier}</span>
                )}
              </div>
            ))}
          </div>
          <p className={`m-0 ${SECTION_GAP} text-[9.5pt] italic text-ink-faint`}>
            {monitoring.caveat}
          </p>

          {/* ════════════════════════════════════════════════════════════════════
              §07 Areas of Strength (conditional)
          ═══════════════════════════════════════════════════════════════════════ */}
          {showStrengths && (
            <>
              <SectionHeading number={SEC.strengths} title="Areas of Strength" />
              <p className="m-0 mb-[14px] max-w-[46em]">
                {strengthCountStr} on this panel{' '}
                {areasOfStrength.length === 1 ? 'is' : 'are'} within reference and{' '}
                {areasOfStrength.length === 1 ? 'is' : 'are'} surfaced as{' '}
                {areasOfStrength.length === 1 ? 'an area' : 'areas'} of clinical strength to
                contextualise the abnormal findings above.
              </p>
              <div className={SECTION_GAP} style={{ display: 'grid', gap: '9px' }}>
                {areasOfStrength.map((item, i) => (
                  <div
                    key={i}
                    className="break-inside-avoid flex gap-3 items-start text-[9.5pt] leading-[1.5]"
                  >
                    {/* 6×6 square gold bullet — no border-radius per design spec */}
                    <span
                      className="flex-none bg-brand-gold mt-[6px]"
                      style={{ width: '6px', height: '6px' }}
                      aria-hidden="true"
                    />
                    <div>{item}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ════════════════════════════════════════════════════════════════════
              References (conditional — no section numeral per prototype)
          ═══════════════════════════════════════════════════════════════════════ */}
          {showReferences && (
            <>
              <SectionHeading title="References" />
              <p className="m-0 mb-[14px] max-w-[46em] text-[9.5pt] text-ink-soft">
                Key published studies cited by the clinical decision support system in support of
                each formulation decision. Citations should be independently verified by the
                reviewing practitioner before clinical reliance. PMIDs and DOIs can be confirmed
                via PubMed.
              </p>
              <div
                className={SECTION_GAP}
                style={{ columnCount: 2, columnGap: '26px' }}
              >
                {references.map((ref) => (
                  <ReferenceEntry key={ref.index} reference={ref} />
                ))}
              </div>
            </>
          )}

          {/* ── Closing block ─────────────────────────────────────────────────── */}
          <div className="break-inside-avoid mt-[32px] pt-[16px] border-t-2 border-brand-olive">
            <p className="m-0 mb-[10px] font-jost text-[9pt] font-medium text-brand-olive">
              Patients should not act on the contents of this document without the direct
              guidance of their treating practitioner.
            </p>
            <div className="flex flex-wrap gap-[6px_20px] font-jost text-[8pt] tracking-[.1em] uppercase text-ink-labelLight">
              <div>Submission {submissionId}</div>
              <div>Generated {generatedDisplay}</div>
              <div>Audit reference {auditReference}</div>
            </div>
          </div>

        </div>{/* end doc-body */}

        {/* ── Running footer ────────────────────────────────────────────────────
            doc-footer-wrap becomes position:fixed in print (globals.css), repeating
            the footer line on every page. pb-[0.7in] provides the bottom page margin
            when @page { margin: 0 } is active.
            doc-footer-inner strips mt-[32px] in print (the footer is out of flow;
            the screen margin is not needed when it's detached from the content body).
        */}
        <div className="doc-footer-wrap">
          <div className="px-[0.7in]">
            <div className="doc-footer-inner mt-[32px] pt-[7px] pb-[0.7in] border-t border-rule-strong flex items-center justify-between gap-4 font-jost text-[7.5pt] tracking-[.1em] uppercase text-ink-labelLight">
              <div>Confidential — practitioner use only</div>
              <div>Audit ref {auditReference}</div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
