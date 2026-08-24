/**
 * PatternCard
 *
 * One card in the "Recognised clinical patterns" grid (§01 Executive Summary).
 * The grid itself is 2-column (1fr 1fr) — PatternCard is a single cell.
 *
 * Prototype reference: NofISHealthAnalysis.dc.html lines 82–105
 *
 * Visual spec:
 *   Container: break-inside:avoid; background surface.card (#F4F3EC);
 *              3px left border in brand.gold; padding 13px 15px
 *   Pattern name:    Jost medium 10.5pt, oliveDark, margin-bottom 5px
 *   Supporting text: 9pt, 1.5 line-height, ink.soft (#5C6155)
 */
import type { ClinicalPattern } from '../../lib/health-analysis-schema';

interface PatternCardProps {
  pattern: ClinicalPattern;
}

export function PatternCard({ pattern }: PatternCardProps) {
  return (
    <div className="break-inside-avoid bg-surface-card border-l-[3px] border-brand-gold px-[15px] py-[13px]">
      <div className="font-jost font-medium text-[10.5pt] text-brand-oliveDark mb-[5px]">
        {pattern.name}
      </div>
      <div className="text-[9pt] leading-[1.5] text-ink-soft">
        {pattern.supportingSnps.join(' · ')}
      </div>
    </div>
  );
}
