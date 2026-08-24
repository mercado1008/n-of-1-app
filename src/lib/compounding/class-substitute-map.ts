/**
 * N of 1 — Class substitute map
 * --------------------------------
 * Loads data/class-substitutes.json and pairs each ARTG ingredient name with
 * the closest N of 1 library moiety. Used by the translation engine when an
 * ARTG ingredient from a selected product could not be resolved to any moiety
 * in the registry (i.e. it lands in unresolvedSourceActives).
 *
 * CLASS SUBSTITUTION vs DIRECT TRANSLATION
 * ----------------------------------------
 * DIRECT: ARTG ingredient matches a library moiety via pass 1/2 alias — same
 *   chemical entity or a documented equivalent form. Dose comes from the
 *   commercial product label.
 *
 * CLASS_SUBSTITUTION (this map): ARTG ingredient has no library entry, but a
 *   therapeutically related moiety exists in the library. The library's
 *   recommended therapeutic dose is applied — the commercial product's dose
 *   is not used (units and forms are incompatible). ALWAYS requires practitioner
 *   confirmation before inclusion in a pod.
 *
 * Examples handled here:
 *   folic acid        → Levomefolic acid (bioactive form, library dose)
 *   betacarotene      → Vitamin A (preformed, library recommended dose)
 *   Panax ginseng     → American ginseng (same genus, library dose)
 *   phytomenadione    → Vitamin K2 MK-7 (superior supplementation form)
 *
 * EXCLUDED by design:
 *   omega-3 fatty acids (fish oil, DHA, EPA) — route to PURCHASE_SEPARATELY
 *   probiotics (Lactobacillus, Bifidobacterium) — route to PURCHASE_SEPARATELY
 *   ingredients with no library equivalent (Echinacea, Ganoderma, etc.)
 */

import substituteData from '@/data/class-substitutes.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClassSubstituteSpec {
  /** TSI code of the N of 1 library ingredient that serves as the substitute. */
  libraryId: string;
  /**
   * Recommended daily dose in the library moiety unit (from moiety-registry.ts).
   * Applied instead of the commercial product's dose — forms/units are not
   * directly comparable for class substitutions.
   */
  recommendedDose: number;
  /** Clinical rationale for the substitution. Shown to the practitioner. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Build the class substitute lookup map from data/class-substitutes.json.
 * Keys are lowercase ARTG ingredient names.
 * Comment/note entries (keys starting with "_") are skipped.
 */
export function buildClassSubstituteMap(): Map<string, ClassSubstituteSpec> {
  const map = new Map<string, ClassSubstituteSpec>();
  const raw = substituteData as Record<string, unknown>;

  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('_')) continue;
    if (!value || typeof value !== 'object') continue;
    const entry = value as Partial<ClassSubstituteSpec>;
    if (
      typeof entry.libraryId === 'string' &&
      typeof entry.recommendedDose === 'number' &&
      typeof entry.rationale === 'string'
    ) {
      map.set(key.toLowerCase().trim(), {
        libraryId: entry.libraryId,
        recommendedDose: entry.recommendedDose,
        rationale: entry.rationale,
      });
    }
  }

  return map;
}

/** Singleton map for use in production paths. */
export const classSubstituteMap: ReadonlyMap<string, ClassSubstituteSpec> =
  buildClassSubstituteMap();
