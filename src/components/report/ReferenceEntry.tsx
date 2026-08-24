/**
 * ReferenceEntry
 *
 * One paragraph entry in the References section.
 * The section wrapper uses CSS column-count:2 — each ReferenceEntry is a
 * single break-inside:avoid paragraph inside that multi-column block.
 *
 * Prototype reference: NofISHealthAnalysis.dc.html lines 697–718
 *
 * Visual spec:
 *   Container:  break-inside:avoid; margin-bottom 7px
 *   Index:      Jost, brand.gold (#C6AF81) — left of the citation text
 *   Body:       8.5pt, line-height 1.45, ink.muted (#4A4E43)
 *   Journal:    italic via <em>
 *   Trailing:   "— {supports}" in muted body colour after the journal name
 *
 * Format string: "{index}  {authors} ({year}). {title}. {journal}. — {supports}"
 */
import type { Reference } from '../../lib/health-analysis-schema';

interface ReferenceEntryProps {
  reference: Reference;
}

export function ReferenceEntry({ reference }: ReferenceEntryProps) {
  const { index, authors, year, title, journal, supports } = reference;

  return (
    <p className="m-0 mb-[7px] break-inside-avoid text-[8.5pt] leading-[1.45] text-ink-muted">
      {/* Gold index numeral, followed by a non-breaking space for visual gap */}
      <span className="text-brand-gold font-jost" aria-hidden="true">
        {index}
      </span>
      {'  '}
      {authors} ({year}). {title}.{' '}
      <em>{journal}</em>. — {supports}
    </p>
  );
}
