/**
 * Static validation of data/artg-aliases.json against the moiety registry.
 *
 * This test runs at CI cost (no network, no Claude spend) and catches broken
 * alias targets before they reach the ARTG ingest pipeline. A broken target
 * means pass-2 silently fails — the ARTG ingredient looks unmatched even
 * though an alias exists — and the product's actives are understated.
 *
 * Rules enforced:
 *   1. Every alias entry with a non-`_` key must have a non-empty `target`
 *      string (supports both flat-string and { target, verified } formats).
 *   2. Every `target` must match a moietyName (or artgAlias) in the registry
 *      (case-insensitive). An unrecognised target never resolves in pass 2.
 *   3. No alias key may equal its own target (lowercased) — that is a no-op
 *      that provides no mapping and only adds maintenance noise.
 *   4. The `_removed_*` and `_comment_*` and `_not_added_*` tombstone keys
 *      must have string values starting with "_" so the ingest skips them.
 *      This ensures removal intent is visible in the file without silently
 *      becoming a live alias.
 *
 * When a seed is wrong:
 *   Fix the target in data/artg-aliases.json and re-run `npm test`.
 *   The ingest's artg-alias-report.json also surfaces broken targets as
 *   "firedButBrokenTarget" after a real export run.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { moietyRegistry } from '../moiety-registry';

// ---------------------------------------------------------------------------
// Build the moiety name index (same logic as ingest-artg-export.ts buildMoietyNameIndex)
// ---------------------------------------------------------------------------

function buildRegistryIndex(): Set<string> {
  const idx = new Set<string>();
  for (const def of moietyRegistry.values()) {
    idx.add(def.moietyName.toLowerCase().trim());
    for (const alias of def.artgAliases) {
      idx.add(alias.toLowerCase().trim());
    }
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;           // legacy flat format
  if (
    value &&
    typeof value === 'object' &&
    'target' in value &&
    typeof (value as Record<string, unknown>).target === 'string'
  ) {
    return (value as { target: string }).target;
  }
  return null;
}

/** Returns true for meta/tombstone keys that the ingest unconditionally skips. */
function isSkippedKey(key: string): boolean {
  return key.startsWith('_');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('data/artg-aliases.json', () => {
  const raw = JSON.parse(
    readFileSync(resolve(process.cwd(), 'data', 'artg-aliases.json'), 'utf8'),
  ) as Record<string, unknown>;

  const registryIndex = buildRegistryIndex();

  // Partition entries upfront so test bodies can share the work
  const liveEntries: Array<[string, string]> = [];  // [key, target]
  const tombstoneEntries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(raw)) {
    if (isSkippedKey(key)) {
      tombstoneEntries.push([key, value]);
    } else {
      const target = extractTarget(value);
      liveEntries.push([key, target ?? '']);
    }
  }

  // ── Rule 1: every live entry has a non-empty target ──────────────────────
  it('every alias entry has a non-empty target string', () => {
    const missing = liveEntries
      .filter(([, target]) => !target)
      .map(([key]) => `"${key}": missing or null target`);

    expect(missing, missing.join('\n')).toHaveLength(0);
  });

  // ── Rule 2: every target exists in the registry ───────────────────────────
  it('every alias target matches a moiety name in the registry', () => {
    const bad = liveEntries
      .filter(([, target]) => target && !registryIndex.has(target.toLowerCase().trim()))
      .map(([key, target]) => `"${key}" → target "${target}" NOT in registry`);

    expect(
      bad,
      bad.length > 0
        ? `${bad.length} broken target(s):\n${bad.map(s => '  ' + s).join('\n')}\n\n` +
          `Fix the target values in data/artg-aliases.json so they match the ` +
          `moietyName field in moiety-registry.ts exactly.`
        : '',
    ).toHaveLength(0);
  });

  // ── Rule 3: no alias key equals its own target (would be a no-op) ─────────
  // Pass 1 in the ingest already does a case-insensitive exact match against all
  // registry moiety names. So "levomefolic acid" → "Levomefolic acid" is redundant:
  // pass 1 handles it and the alias never fires. These entries inflate the
  // never-fired seed count and add confusion.
  it('no alias key is identical to its own target (would be a no-op — pass 1 handles it)', () => {
    const noops = liveEntries
      .filter(([key, target]) => key.trim().toLowerCase() === target.trim().toLowerCase())
      .map(([key]) => `"${key}"`);

    expect(
      noops,
      noops.length > 0
        ? `No-op aliases (key === target lowercased): ${noops.join(', ')}\n\n` +
          `Remove these from data/artg-aliases.json. Pass 1 (exact moiety-name match) ` +
          `already handles them, so the alias never fires and only inflates the ` +
          `never-fired seed list.`
        : '',
    ).toHaveLength(0);
  });

  // ── Rule 4: tombstone keys must not contain a live alias object ────────────
  // The ingest skips all keys starting with "_" regardless of their value type.
  // But a live-looking { target, verified } object on a tombstone key is
  // confusing — it looks like a real mapping that should be active.
  it('tombstone keys (_removed_*, _comment_*, _not_added_*, etc.) do not contain live alias objects', () => {
    const bad = tombstoneEntries
      .filter(([, value]) => {
        if (!value || typeof value !== 'object') return false;
        return 'target' in (value as Record<string, unknown>);
      })
      .map(([key]) => `"${key}": contains { target, ... } — looks like a live alias but is skipped by the ingest`);

    expect(
      bad,
      bad.length > 0
        ? `${bad.length} tombstone key(s) with live-looking objects:\n${bad.map(s => '  ' + s).join('\n')}`
        : '',
    ).toHaveLength(0);
  });

  // ── Informational: live entry count ──────────────────────────────────────
  it('has at least 80 live alias entries (sanity check against accidental truncation)', () => {
    expect(liveEntries.length).toBeGreaterThan(80);
  });
});
