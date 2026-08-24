/**
 * app/api/translate/products/route.ts
 * ------------------------------------
 * GET /api/translate/products
 *
 * Query params:
 *   ?sponsors=true          → { sponsors: string[] }
 *   ?sponsor=xxx            → { products: ProductSummary[], limited: boolean }
 *   ?search=xxx             → { products: ProductSummary[], limited: boolean }
 *   ?sponsor=xxx&search=yyy → filtered list within sponsor
 *   ?artgId=xxx             → { product: ProductSummary | null }
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getSponsors,
  getProductsBySponsor,
  searchProducts,
  getProductsByIds,
  toSummary,
} from '@/lib/candidates-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIMIT = 60;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  // ── Sponsor list ───────────────────────────────────────────────────────────
  if (sp.get('sponsors') === 'true') {
    return NextResponse.json({ sponsors: getSponsors() });
  }

  // ── Single product by ARTG ID ──────────────────────────────────────────────
  const artgId = sp.get('artgId');
  if (artgId) {
    const map = getProductsByIds([artgId]);
    const product = map.get(artgId);
    return NextResponse.json({ product: product ? toSummary(product) : null });
  }

  // ── Product list ───────────────────────────────────────────────────────────
  const sponsor = sp.get('sponsor') ?? undefined;
  const search = sp.get('search') ?? '';

  let products;
  if (sponsor && !search) {
    products = getProductsBySponsor(sponsor, '', LIMIT);
  } else if (search) {
    products = searchProducts(search, sponsor, LIMIT);
  } else {
    return NextResponse.json({ products: [], limited: false });
  }

  return NextResponse.json({
    products: products.map(toSummary),
    limited: products.length >= LIMIT,
  });
}
