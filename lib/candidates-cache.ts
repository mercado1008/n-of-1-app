/**
 * lib/candidates-cache.ts
 * -----------------------
 * Module-level server-side cache for candidates.json and the ingredients library.
 * Loaded once per Node.js process and served from memory on all subsequent calls.
 *
 * All exports are safe to call from Next.js API routes (server-only).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CommercialMedicine } from '../src/lib/compounding/justification-engine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LibraryIngredientRaw {
  tsi_code: string;
  common_name: string;
  category: string;
  recommended_dose: number | string;
  max_dose: number | string;
  dose_per_granule: number;
  dose_per_granule_unit: string;
  [key: string]: unknown;
}

export interface ProductSummary {
  artgId: string;
  productName: string;
  sponsor: string;
  doseForm: string;
  activesCount: number;
  unmatchedCount: number;
  maxUnitsPerDay: number | null;
  actives: Array<{ moiety: string; amount: number; unit: string; libraryId: string | null }>;
}

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

let _candidates: CommercialMedicine[] | null = null;
let _sponsors: string[] | null = null;
let _coveredMoietyIds: Set<string> | null = null;
let _libraryIngredients: LibraryIngredientRaw[] | null = null;

/**
 * Reset all module-level caches so the next request re-reads from disk.
 * Only intended for use in development (called from /api/dev/reset-cache).
 */
export function resetCandidatesCache(): void {
  _candidates        = null;
  _sponsors          = null;
  _coveredMoietyIds  = null;
  _libraryIngredients = null;
}

const CANDIDATES_PATH = resolve(process.cwd(), 'candidates.json');
const LIBRARY_PATH = resolve(process.cwd(), 'data/library-built/ingredients-library.json');

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export function getCandidates(): CommercialMedicine[] {
  if (_candidates) return _candidates;
  if (!existsSync(CANDIDATES_PATH)) {
    _candidates = [];
    return _candidates;
  }
  try {
    const raw = JSON.parse(readFileSync(CANDIDATES_PATH, 'utf8'));
    _candidates = Array.isArray(raw) ? raw : (raw.candidates ?? []);
  } catch {
    _candidates = [];
  }
  return _candidates!;
}

export function getSponsors(): string[] {
  if (_sponsors) return _sponsors;
  const seen = new Set<string>();
  for (const c of getCandidates()) {
    if (c.sponsor) seen.add(c.sponsor);
  }
  _sponsors = [...seen].sort((a, b) => a.localeCompare(b));
  return _sponsors;
}

/** Products for a given sponsor, optionally filtered by name query. */
export function getProductsBySponsor(
  sponsor: string,
  search = '',
  limit = 100,
): CommercialMedicine[] {
  const q = search.toLowerCase();
  const results: CommercialMedicine[] = [];
  for (const c of getCandidates()) {
    if (c.sponsor !== sponsor) continue;
    if (q && !c.productName.toLowerCase().includes(q)) continue;
    results.push(c);
    if (results.length >= limit) break;
  }
  return results.sort((a, b) => a.productName.localeCompare(b.productName));
}

/** Search across all products by name (and optionally within a sponsor). */
export function searchProducts(
  search: string,
  sponsor?: string,
  limit = 60,
): CommercialMedicine[] {
  const q = search.toLowerCase();
  const results: CommercialMedicine[] = [];
  for (const c of getCandidates()) {
    if (sponsor && c.sponsor !== sponsor) continue;
    if (!c.productName.toLowerCase().includes(q) && !c.artgId.includes(search)) continue;
    results.push(c);
    if (results.length >= limit) break;
  }
  return results.sort((a, b) => a.productName.localeCompare(b.productName));
}

/** Retrieve specific products by ARTG ID. */
export function getProductsByIds(artgIds: string[]): Map<string, CommercialMedicine> {
  const idSet = new Set(artgIds);
  const result = new Map<string, CommercialMedicine>();
  for (const c of getCandidates()) {
    if (idSet.has(c.artgId)) result.set(c.artgId, c);
  }
  return result;
}

/** Convert a CommercialMedicine to a lightweight ProductSummary for API responses. */
export function toSummary(c: CommercialMedicine): ProductSummary {
  return {
    artgId: c.artgId,
    productName: c.productName,
    sponsor: c.sponsor,
    doseForm: c.doseForm,
    activesCount: c.activesPerUnit.length,
    unmatchedCount: (c as { unmatchedActiveNames?: string[] }).unmatchedActiveNames?.length ?? 0,
    maxUnitsPerDay: c.maxUnitsPerDay,
    actives: c.activesPerUnit.map((a) => ({
      moiety: a.moiety,
      amount: a.amount,
      unit: a.unit,
      libraryId: a.libraryId,
    })),
  };
}

// ---------------------------------------------------------------------------
// ARTG moiety coverage
// ---------------------------------------------------------------------------

/**
 * Returns the set of N of 1 library moiety IDs (TSI codes) that appear in at
 * least one product in the ARTG candidates pool. Used to identify which library
 * moieties have NO Listed Medicine equivalent — the "N of 1 exclusives".
 */
export function getCoveredMoietyIds(): Set<string> {
  if (_coveredMoietyIds) return _coveredMoietyIds;
  _coveredMoietyIds = new Set<string>();
  for (const c of getCandidates()) {
    for (const a of c.activesPerUnit) {
      if (a.libraryId) _coveredMoietyIds.add(a.libraryId);
    }
  }
  return _coveredMoietyIds;
}

// ---------------------------------------------------------------------------
// Library ingredients
// ---------------------------------------------------------------------------

export function getLibraryIngredients(): LibraryIngredientRaw[] {
  if (_libraryIngredients) return _libraryIngredients;
  try {
    const raw = JSON.parse(readFileSync(LIBRARY_PATH, 'utf8'));
    _libraryIngredients = raw.ingredients ?? [];
  } catch {
    _libraryIngredients = [];
  }
  return _libraryIngredients!;
}
