/**
 * SectionHeading
 *
 * The numbered heading block that opens each document section.
 * When `number` is omitted (References section has no numeral per prototype)
 * the numeral slot is hidden and the heading rule is preserved.
 *
 * Prototype reference: NofISHealthAnalysis.dc.html lines 72–77 (§01) and
 * 692–694 (References — no number).
 *
 * The outer div carries `break-inside-avoid` and `break-after-avoid` so the
 * heading and its first paragraph never orphan at a page break.
 */

interface SectionHeadingProps {
  /** Two-digit numeral string, e.g. "01". Omit for the References section. */
  number?: string;
  title: string;
}

export function SectionHeading({ number, title }: SectionHeadingProps) {
  return (
    <div className="break-inside-avoid break-after-avoid mb-[14px]">
      <div className="flex items-baseline gap-[14px] border-b-2 border-brand-olive pb-[8px]">
        {number && (
          <span
            className="font-jost font-light text-[22pt] leading-none text-brand-gold"
            aria-hidden="true"
          >
            {number}
          </span>
        )}
        <h2 className="font-jost font-medium text-[15pt] tracking-[.01em] text-brand-oliveDark m-0">
          {title}
        </h2>
      </div>
    </div>
  );
}
