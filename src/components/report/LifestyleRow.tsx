/**
 * LifestyleRow
 *
 * One row in the §03 Diet and Lifestyle Considerations grid.
 * The grid itself is `display:grid;gap:14px` — LifestyleRow is a single row.
 *
 * Prototype reference: NofISHealthAnalysis.dc.html lines 501–536
 *
 * Visual spec:
 *   Container:  break-inside:avoid; grid 150px | 1fr; gap 16px;
 *               padding-bottom 14px; border-bottom 1px rule.medium
 *               (last row omits border-bottom via `isLast`)
 *   Topic col:  Jost medium 10.5pt, olive (#535B50)
 *   Content col:
 *     consideration: default body text (ink.body), margin-bottom 5px
 *     rationale block: 9pt, ink.faint (#7A7F72)
 *       "RATIONALE" label: Jost 7.5pt tracking-wide uppercase, ink.labelLight
 */
import type { LifestyleConsideration } from '../../lib/health-analysis-schema';

interface LifestyleRowProps {
  item: LifestyleConsideration;
  /** Pass true on the final row to suppress the bottom rule. */
  isLast?: boolean;
}

export function LifestyleRow({ item, isLast }: LifestyleRowProps) {
  return (
    <div
      className={[
        'break-inside-avoid pb-[14px]',
        isLast ? '' : 'border-b border-rule-medium',
      ].join(' ')}
      style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '16px' }}
    >
      {/* Topic label — narrow left column */}
      <div className="font-jost font-medium text-[10.5pt] text-brand-olive">
        {item.topic}
      </div>

      {/* Content — right column */}
      <div>
        <p className="m-0 mb-[5px] text-ink-body">
          {item.consideration}
        </p>
        <p className="m-0 text-[9pt] text-ink-faint">
          <span className="font-jost text-[7.5pt] tracking-[.12em] uppercase text-ink-labelLight">
            Rationale&nbsp;&nbsp;
          </span>
          {item.rationale}
        </p>
      </div>
    </div>
  );
}
