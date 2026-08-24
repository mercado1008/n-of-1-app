/**
 * IngredientRow
 *
 * One row in either the "Intentionally included" or "Intentionally excluded"
 * ingredient lists in §04 Recommended Formulation Logic.
 *
 * Both lists share the same 200px | 1fr grid with identical typography; the
 * second column label differs (dose for included, code/reason for excluded).
 * This single component handles both via a neutral `badge` prop (dose string
 * or W-code string) — the caller decides which to pass.
 *
 * Prototype reference:
 *   Included: NofISHealthAnalysis.dc.html lines 559–580
 *   Excluded: NofISHealthAnalysis.dc.html lines 585–590
 *
 * Visual spec:
 *   Container:   break-inside:avoid; grid 200px | 1fr; gap 16px;
 *                padding 9px 0; border-bottom 1px rule.light (#EDEBE3)
 *   Name:        Jost 10pt, oliveDark (#2E332A)
 *   Badge span:  inline after name; ink.labelLight (#9A9F91)
 *   Description: 9.5pt, 1.5 line-height, default body
 */

interface IngredientRowProps {
  /** Ingredient or exclusion name, e.g. "Calcium folinate" */
  name: string;
  /** Optional dose or W-code displayed inline after the name in muted colour. */
  badge?: string;
  /** Rationale (included) or reason (excluded). */
  description: string;
}

export function IngredientRow({ name, badge, description }: IngredientRowProps) {
  return (
    <div
      className="break-inside-avoid py-[9px] border-b border-rule-light"
      style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: '16px' }}
    >
      {/* Name + optional badge */}
      <div className="font-jost text-[10pt] text-brand-oliveDark">
        {name}
        {badge && (
          <span className="text-ink-labelLight"> {badge}</span>
        )}
      </div>

      {/* Rationale / reason */}
      <div className="text-[9.5pt] leading-[1.5] text-ink-body">
        {description}
      </div>
    </div>
  );
}
