/**
 * StatusPill
 *
 * The coloured badge that appears next to a gene / biomarker name in section 02.
 * Colour logic (from prototype):
 *   direction === 'fast' → goldPale background, goldDeep text ("upregulated")
 *   everything else      → surface.pill background, brand.olive text
 *
 * Prototype reference: NofISHealthAnalysis.dc.html lines 121–122 (slow) and 313 (fast)
 */
import type { StatusDirection } from '../../lib/health-analysis-schema';

interface StatusPillProps {
  /** The genotype label shown inside the pill, e.g. "AG heterozygous — slow" */
  label: string;
  /** Determines background / text colour. */
  direction: StatusDirection;
}

export function StatusPill({ label, direction }: StatusPillProps) {
  const isFast = direction === 'fast';
  return (
    <span
      className={[
        'font-jost text-[8pt] tracking-[.1em] uppercase leading-none',
        'px-2 py-[3px]',
        // No border-radius — design is deliberately square (README "No border radius anywhere")
        isFast
          ? 'bg-brand-goldPale text-brand-goldDeep'
          : 'bg-surface-pill text-brand-olive',
      ].join(' ')}
    >
      {label}
    </span>
  );
}
