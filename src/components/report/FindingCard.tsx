/**
 * FindingCard
 *
 * One row in the §02 Detailed Biomarker / Finding Analysis list.
 * Each card shows gene name + optional rsID, a StatusPill, and a three-row
 * field grid: Interpretation, Contributors, Formulation.
 *
 * The last card in the list also receives `border-bottom` via `isLast`.
 *
 * Prototype reference: NofISHealthAnalysis.dc.html lines 118–128 (first card),
 * 478–488 (last card — note extra border-bottom).
 *
 * Field grid: grid-template-columns: 104px 1fr; gap: 5px 14px
 * All three label/value pairs share the same grid — labels in col 1, values
 * in col 2, producing aligned left-column labels at 104 px.
 */
import type { Finding } from '../../lib/health-analysis-schema';
import { StatusPill } from './StatusPill';

interface FindingCardProps {
  finding: Finding;
  /** Pass true on the final card to close the list with a bottom rule. */
  isLast?: boolean;
}

/** Shared uppercase field label (104 px column) */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-jost text-[7.5pt] tracking-[.12em] uppercase text-ink-labelLight pt-[3px]">
      {children}
    </div>
  );
}

export function FindingCard({ finding, isLast }: FindingCardProps) {
  const { gene, rsid, genotypeLabel, direction, interpretation, contributors, formulationRelevance } =
    finding;

  return (
    <div
      className={[
        'break-inside-avoid py-[14px] pb-[12px] border-t border-rule-medium',
        isLast ? 'border-b border-rule-medium' : '',
      ].join(' ')}
    >
      {/* Header row: gene name + pill */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2 mb-[8px]">
        <div className="font-jost font-semibold text-[11pt] text-brand-oliveDark">
          {gene}
          {rsid && (
            <span className="font-light text-ink-label ml-1">({rsid})</span>
          )}
        </div>
        <StatusPill label={genotypeLabel} direction={direction} />
      </div>

      {/* Field grid: label 104 px | value auto */}
      <div
        className="text-[9.5pt] leading-[1.5]"
        style={{ display: 'grid', gridTemplateColumns: '104px 1fr', gap: '5px 14px' }}
      >
        <FieldLabel>Interpretation</FieldLabel>
        <div className="text-ink-body">{interpretation}</div>

        <FieldLabel>Contributors</FieldLabel>
        <div className="text-ink-soft">{contributors}</div>

        <FieldLabel>Formulation</FieldLabel>
        <div className="text-ink-body">{formulationRelevance}</div>
      </div>
    </div>
  );
}
