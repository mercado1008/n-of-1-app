/**
 * N of 1 — Library granule spec map
 * -----------------------------------
 * Builds the Map<string, LibraryGranuleSpec> consumed by the product translation
 * engine. One entry per Rev15 library ingredient, keyed by TSI code.
 *
 * dosePerGranule reflects the active-moiety amount per granule, not the salt or
 * extract mass:
 *   - ELEMENTAL minerals → moietyAmountPerGranule = equivalent_line_2_quantity
 *     (the elemental figure the ARTG publishes)
 *   - AS_STATED / DRY_EQUIVALENT → moietyAmountPerGranule already resolved by
 *     the moiety registry builder (picks the correct line per the label pattern)
 *
 * maxDailyDose is parsed from the library's max_dose string and is expressed in
 * the same unit as dosePerGranule (both use the moiety unit, never the salt unit).
 *
 * All 107 Rev15 entries use 'mg' or 'mcg' as their dose unit; the unit cast
 * below is safe within this library version.
 */

import libraryData from '@/data/library-built/ingredients-library.json';
import type { LibraryIngredient } from './adapters/library-ingredient';
import { moietyRegistry } from './moiety-registry';
import type { LibraryGranuleSpec } from './product-translation-engine';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseMaxDose(maxDoseStr: string): number | null {
  const n = parseFloat(maxDoseStr);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildLibraryMap(): Map<string, LibraryGranuleSpec> {
  const map = new Map<string, LibraryGranuleSpec>();
  const ingredients = (libraryData as { ingredients: LibraryIngredient[] }).ingredients;

  for (const ing of ingredients) {
    const def = moietyRegistry.get(ing.tsi_code);
    if (!def) continue; // should never occur — registry is built from the same source

    // All Rev15 moiety units are mg or mcg. The cast is safe within this library version.
    const unit = def.moietyUnit as 'mg' | 'mcg';

    map.set(ing.tsi_code, {
      tsiCode: ing.tsi_code,
      moietyId: ing.tsi_code as import('./moiety').MoietyId,
      displayName: def.moietyName,
      // moietyAmountPerGranule already selects the correct line:
      //   ELEMENTAL minerals → equivalent_line_2_quantity (elemental)
      //   everything else    → dose_per_granule or the free-base line 2 amount
      dosePerGranule: def.moietyAmountPerGranule,
      unit,
      maxDailyDose: parseMaxDose(ing.max_dose),
    });
  }

  return map;
}

/**
 * Singleton library map for use in production paths.
 * Initialised once at module load from the Rev15 library JSON + moiety registry.
 */
export const libraryMap: ReadonlyMap<string, LibraryGranuleSpec> = buildLibraryMap();
