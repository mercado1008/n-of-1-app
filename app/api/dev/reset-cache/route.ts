/**
 * app/api/dev/reset-cache/route.ts
 *
 * Development-only route that clears the in-memory candidates + library
 * cache so the next API call re-reads from disk — without restarting the
 * dev server.
 *
 * Usage after rebuilding candidates.json:
 *   curl -X POST http://localhost:3000/api/dev/reset-cache
 *
 * Returns 403 in production (NODE_ENV === 'production').
 */

import { NextResponse } from 'next/server';
import { resetCandidatesCache } from '@/lib/candidates-cache';

export async function POST() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not available in production' }, { status: 403 });
  }

  resetCandidatesCache();

  return NextResponse.json({
    ok: true,
    message: 'Cache cleared — next request will re-read candidates.json and ingredients-library.json from disk.',
    timestamp: new Date().toISOString(),
  });
}

// GET so you can hit it in a browser tab during development
export async function GET() {
  return POST();
}
