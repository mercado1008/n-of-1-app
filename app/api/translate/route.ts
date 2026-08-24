/**
 * app/api/translate/route.ts
 * --------------------------
 * POST /api/translate
 *
 * Translates a practitioner's current commercial product stack into a
 * N of 1 pod formulation using the product translation engine.
 *
 * Request body:
 *   {
 *     selections: Array<{ artgId: string; unitsPerDay: number }>;
 *   }
 *
 * Response:
 *   {
 *     directActives: DirectActive[];        // DIRECT + FORM_SUBSTITUTION
 *     classSubstitutes: ClassSub[];         // folic acid → levomefolic acid, etc.
 *     purchaseSeparately: PurchaseSep[];    // omega-3s, probiotics, CFU
 *     unresolved: Unresolved[];             // no match and no substitute
 *     podFill: PodFill;                     // granule counts for direct actives
 *     nof1Exclusives: Nof1Exclusive[];      // library moieties not in ANY ARTG product
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getProductsByIds,
  getCoveredMoietyIds,
  getLibraryIngredients,
} from '@/lib/candidates-cache';
import {
  translateProducts,
  DEFAULT_TRANSLATION_CONFIG,
  type SelectedProduct,
  type LibraryGranuleSpec,
} from '@/src/lib/compounding/product-translation-engine';
import { productionMoietyRegistry } from '@/src/lib/compounding/moiety';
import { libraryMap } from '@/src/lib/compounding/library-map';
import {
  classSubstituteMap,
  type ClassSubstituteSpec,
} from '@/src/lib/compounding/class-substitute-map';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

interface DirectActive {
  moietyId: string;
  name: string;
  totalDose: number;
  unit: string;
  granules: number;
  stacked: boolean;
  exceedsMax: boolean;
  /** Library upper daily dose limit for this ingredient (null if none defined). */
  maxDailyDose: number | null;
  /** Unit for maxDailyDose — always 'mg' or 'mcg' (library unit, may differ from `unit`). */
  maxDailyDoseUnit: string | null;
  /** Dose delivered per granule (from library). Use this to compute dispensed dose accurately. */
  dosePerGranule: number | null;
  tier: string;
  sources: Array<{
    artgId: string;
    productName: string;
    dosePerUnit: number;
    unitsPerDay: number;
    subtotal: number;
  }>;
}

interface ClassSub {
  artgIngredientName: string;
  substituteId: string;
  substituteName: string;
  unit: string;
  recommendedDose: number;
  recommendedGranules: number;
  rationale: string;
  sources: Array<{ artgId: string; productName: string }>;
}

interface PurchaseSep {
  name: string;
  totalDose: number;
  unit: string;
  note: string;
  sources: string[];
}

interface Unresolved {
  artgId: string;
  ingredientName: string;
}

interface PodFill {
  totalGranules: number;
  capacity: number;
  percentage: number;
  fits: boolean;
}

interface Nof1Exclusive {
  tsiCode: string;
  name: string;
  category: string;
  recommendedDose: number;
  unit: string;
  dosePerGranule: number;
  recommendedGranules: number;
  maxDailyDose: number | null;
}

interface TranslateResponse {
  directActives: DirectActive[];
  classSubstitutes: ClassSub[];
  purchaseSeparately: PurchaseSep[];
  unresolved: Unresolved[];
  podFill: PodFill;
  nof1Exclusives: Nof1Exclusive[];
  selectedProducts: Array<{ artgId: string; productName: string; sponsor: string; unitsPerDay: number }>;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const selections: Array<{ artgId: string; unitsPerDay: number }> =
      body?.selections ?? [];

    if (!selections.length) {
      return NextResponse.json({ error: 'No products selected.' }, { status: 400 });
    }

    // ── Resolve products from cache ──────────────────────────────────────────
    const artgIds = selections.map((s) => s.artgId);
    const productMap = getProductsByIds(artgIds);

    const selected: SelectedProduct[] = [];
    for (const sel of selections) {
      const product = productMap.get(sel.artgId);
      if (!product) continue;
      selected.push({ product, unitsPerDay: Math.max(1, sel.unitsPerDay) });
    }

    if (!selected.length) {
      return NextResponse.json({ error: 'None of the selected ARTG IDs were found in the candidates pool.' }, { status: 400 });
    }

    // ── Run translation engine ───────────────────────────────────────────────
    const result = translateProducts(
      selected,
      productionMoietyRegistry,
      libraryMap as Map<string, LibraryGranuleSpec>,
      new Map(), // classAlternatives: CLASS_SUBSTITUTION never auto-applies
      DEFAULT_TRANSLATION_CONFIG,
      undefined, // no justification input in onboarding flow
      classSubstituteMap as Map<string, ClassSubstituteSpec>,
    );

    // ── Build direct actives DTO ─────────────────────────────────────────────
    const directActives: DirectActive[] = result.targets
      .map((target, i) => ({ target, tx: result.translated[i] }))
      .filter(({ tx }) => tx.tier === 'DIRECT' || tx.tier === 'FORM_SUBSTITUTION')
      .map(({ target, tx }) => ({
        moietyId: String(target.moietyId),
        name: target.displayName,
        totalDose: target.totalDose,
        unit: target.unit,
        granules: tx.granules ?? 0,
        stacked: target.stacked,
        exceedsMax: tx.exceedsLibraryMax,
        maxDailyDose: tx.library?.maxDailyDose ?? null,
        maxDailyDoseUnit: tx.library?.unit ?? null,
        dosePerGranule: tx.library?.dosePerGranule ?? null,
        tier: tx.tier,
        sources: target.contributions.map((c) => ({
          artgId: c.artgId,
          productName: c.productName,
          dosePerUnit: c.dosePerUnit,
          unitsPerDay: c.unitsPerDay,
          subtotal: c.subtotal,
        })),
      }))
      .sort((a, b) => b.granules - a.granules);

    // ── Build class substitutes DTO ──────────────────────────────────────────
    const classSubstitutes: ClassSub[] = result.classSubstitutes.map((cs) => ({
      artgIngredientName: cs.artgIngredientName,
      substituteId: cs.substituteLibraryId,
      substituteName: cs.substituteDisplayName,
      unit: cs.unit,
      recommendedDose: cs.recommendedDose,
      recommendedGranules: cs.recommendedGranules,
      rationale: cs.rationale,
      sources: cs.sources,
    }));

    // ── Build purchase-separately DTO ────────────────────────────────────────
    const purchaseSeparately: PurchaseSep[] = result.purchaseSeparately.map((ps) => ({
      name: ps.target.displayName,
      totalDose: ps.target.totalDose,
      unit: ps.target.unit,
      note: ps.note,
      sources: ps.target.contributions.map((c) => c.productName),
    }));

    // ── Build unresolved DTO (exclude any that have a class substitute) ──────
    const substitutedNames = new Set(
      result.classSubstitutes.map((cs) => cs.artgIngredientName.toLowerCase().trim()),
    );
    const unresolved: Unresolved[] = result.unresolvedSourceActives.filter(
      (u) => !substitutedNames.has(u.ingredientName.toLowerCase().trim()),
    );

    // ── Pod fill ─────────────────────────────────────────────────────────────
    const { totalGranules, capacity, utilisationFraction, fits } = result.podFill;
    const podFill: PodFill = {
      totalGranules,
      capacity,
      percentage: Math.round(utilisationFraction * 1000) / 10,
      fits,
    };

    // ── N of 1 exclusives (library moieties absent from ARTG Listed pool) ────
    const coveredIds = getCoveredMoietyIds();
    const classSubstituteResultIds = new Set(result.classSubstitutes.map((cs) => cs.substituteLibraryId));

    const nof1Exclusives: Nof1Exclusive[] = getLibraryIngredients()
      .filter(
        (ing) =>
          !coveredIds.has(ing.tsi_code) &&
          !classSubstituteResultIds.has(ing.tsi_code),
      )
      .map((ing) => {
        const recDose =
          parseFloat(String(ing.recommended_dose)) ||
          parseFloat(String(ing.max_dose)) / 2 ||
          0;
        return {
          tsiCode: ing.tsi_code,
          name: ing.common_name,
          category: ing.category,
          recommendedDose: recDose,
          unit: ing.dose_per_granule_unit,
          dosePerGranule: ing.dose_per_granule,
          recommendedGranules: ing.dose_per_granule > 0 ? Math.ceil(recDose / ing.dose_per_granule) : 0,
          maxDailyDose: parseFloat(String(ing.max_dose)) || null,
        };
      })
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

    // ── Selected products summary ─────────────────────────────────────────────
    const selectedProducts = result.selected.map((s) => {
      const product = productMap.get(s.artgId);
      return {
        artgId: s.artgId,
        productName: s.productName,
        sponsor: product?.sponsor ?? '',
        unitsPerDay: s.unitsPerDay,
      };
    });

    const response: TranslateResponse = {
      directActives,
      classSubstitutes,
      purchaseSeparately,
      unresolved,
      podFill,
      nof1Exclusives,
      selectedProducts,
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error('[/api/translate] Error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
