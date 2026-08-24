/**
 * N of 1 — Moiety identity types and registry protocol
 * -----------------------------------------------------
 * Defines the MoietyId branded type and the MoietyRegistry interface used by
 * the product translation engine. The concrete implementation wraps the
 * existing moiety-registry.ts map; the interface keeps the translation engine
 * testable with minimal stubs.
 */

import { moietyRegistry } from './moiety-registry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Branded TSI code — the stable identifier for a moiety in the Rev15 library.
 * Format: one uppercase letter + 9 digits, e.g. "W030012000".
 * Branded to prevent accidental use of arbitrary strings as moiety keys.
 */
export type MoietyId = string & { readonly __brand: 'MoietyId' };

/** Minimal moiety descriptor surfaced to callers of MoietyRegistry.get(). */
export interface MoietyInfo {
  canonicalName: string;
}

/**
 * Protocol the translation engine needs from the moiety registry.
 * Kept narrow so it is easy to stub in tests without loading the full library.
 */
export interface MoietyRegistry {
  /**
   * Returns the canonical descriptor for a known moiety ID.
   * Throws if the ID is not in the registry — callers must only pass IDs
   * obtained from this registry or from CommercialMedicine.activesPerUnit.libraryId.
   */
  get(moietyId: MoietyId): MoietyInfo;
  /**
   * Resolves an ARTG ingredient name (or a known artgAlias) to a MoietyId.
   * Returns null when no mapping exists — the active is recorded as an
   * unresolved source active in the translation result.
   */
  fromArtg(ingredientName: string): MoietyId | null;
}

// ---------------------------------------------------------------------------
// Production factory
// ---------------------------------------------------------------------------

/**
 * Builds a MoietyRegistry backed by the compiled moiety-registry map.
 * Exported for tests that need to construct a registry over a partial set;
 * most production callers should use the `productionMoietyRegistry` singleton.
 *
 * The name index includes both the canonical moietyName and any artgAliases
 * that have been populated on each entry. Lookup is case-insensitive and
 * trims surrounding whitespace.
 */
export function buildMoietyRegistry(): MoietyRegistry {
  // Reverse index: normalised name or alias → TSI code
  const nameIndex = new Map<string, string>();
  for (const [tsiCode, def] of moietyRegistry) {
    nameIndex.set(def.moietyName.toLowerCase().trim(), tsiCode);
    for (const alias of def.artgAliases) {
      nameIndex.set(alias.toLowerCase().trim(), tsiCode);
    }
  }

  return {
    get(moietyId: MoietyId): MoietyInfo {
      const def = moietyRegistry.get(moietyId as string);
      if (!def) {
        throw new Error(
          `[MoietyRegistry] Unknown MoietyId: "${moietyId}". ` +
          `Verify this TSI code exists in the Rev15 library.`,
        );
      }
      return { canonicalName: def.moietyName };
    },

    fromArtg(ingredientName: string): MoietyId | null {
      const tsiCode = nameIndex.get(ingredientName.toLowerCase().trim());
      return tsiCode ? (tsiCode as MoietyId) : null;
    },
  };
}

/** Singleton registry for use in production paths. Initialised once at module load. */
export const productionMoietyRegistry: MoietyRegistry = buildMoietyRegistry();
