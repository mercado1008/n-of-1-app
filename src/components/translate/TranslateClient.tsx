'use client';

/**
 * src/components/translate/TranslateClient.tsx
 * ---------------------------------------------
 * Practitioner onboarding UI.
 *
 * Flow:
 *   1. Brand search → product list → add to protocol
 *   2. "Build Formula" → POST /api/translate
 *   3. Display:
 *      A. Direct actives (DIRECT / FORM_SUBSTITUTION) — stacked actives consolidated
 *      B. Class substitutes (folic acid → levomefolic acid, etc.)
 *      C. N of 1 additions — library moieties not in any ARTG Listed Medicine (checkable)
 *      D. Purchase separately (omega-3s, probiotics)
 *      E. Pod fill gauge — updates live as user checks N of 1 additions
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// ---------------------------------------------------------------------------
// Types (mirrors /api/translate DTOs)
// ---------------------------------------------------------------------------

interface ActiveDetail {
  moiety: string;
  amount: number;
  unit: string;
  libraryId: string | null;
}

interface ProductSummary {
  artgId: string;
  productName: string;
  sponsor: string;
  doseForm: string;
  activesCount: number;
  unmatchedCount: number;
  maxUnitsPerDay: number | null;
  actives: ActiveDetail[];
}

interface SelectedProduct {
  artgId: string;
  productName: string;
  sponsor: string;
  unitsPerDay: number;
}

interface Source {
  artgId: string;
  productName: string;
  dosePerUnit?: number;
  unitsPerDay?: number;
  subtotal?: number;
}

interface DirectActive {
  moietyId: string;
  name: string;
  totalDose: number;
  unit: string;
  granules: number;
  stacked: boolean;
  exceedsMax: boolean;
  /** Library upper daily dose limit (null if none defined). */
  maxDailyDose?: number | null;
  /** Unit for maxDailyDose — library unit ('mg' or 'mcg'), may differ from `unit`. */
  maxDailyDoseUnit?: string | null;
  /** Dose delivered per granule from the library. Use this for accurate dispensed-dose display. */
  dosePerGranule?: number | null;
  tier: string;
  sources: Source[];
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

interface FormulaResult {
  directActives: DirectActive[];
  classSubstitutes: ClassSub[];
  purchaseSeparately: PurchaseSep[];
  unresolved: Unresolved[];
  podFill: PodFill;
  nof1Exclusives: Nof1Exclusive[];
  selectedProducts: Array<{ artgId: string; productName: string; sponsor: string; unitsPerDay: number }>;
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

const CATEGORY_COLORS: Record<string, string> = {
  Vitamin: 'bg-blue-50 border-blue-200 text-blue-800',
  Mineral: 'bg-purple-50 border-purple-200 text-purple-800',
  Herb: 'bg-green-50 border-green-200 text-green-800',
  'Amino acid': 'bg-orange-50 border-orange-200 text-orange-800',
  Enzyme: 'bg-yellow-50 border-yellow-200 text-yellow-800',
  Natural: 'bg-teal-50 border-teal-200 text-teal-800',
  Synthetic: 'bg-gray-50 border-gray-200 text-gray-700',
  Bioactives: 'bg-gray-50 border-gray-200 text-gray-700',
};

/** Maps internal classification names to practitioner-facing display labels. */
function displayCategory(cat: string): string {
  if (cat.toLowerCase() === 'synthetic') return 'Bioactives';
  return cat;
}

function categoryBadge(cat: string) {
  return CATEGORY_COLORS[displayCategory(cat)] ?? CATEGORY_COLORS[cat] ?? 'bg-gray-50 border-gray-200 text-gray-700';
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PodGauge({ total, capacity }: { total: number; capacity: number }) {
  const pct = Math.min((total / capacity) * 100, 100);
  const over = total > capacity;
  const inZone = total >= 600 && total <= capacity;

  let barColor = 'bg-[#C3AF88]';
  let label = `${total} / ${capacity} granules`;
  let statusText = total < 600 ? 'Below target fill zone (600–720)' : inZone ? 'Within target fill zone' : 'Over pod capacity';
  let statusColor = total < 600 ? 'text-amber-600' : inZone ? 'text-green-700' : 'text-red-600';

  if (over) barColor = 'bg-red-500';
  else if (inZone) barColor = 'bg-green-500';

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm font-medium">
        <span className="text-[#535B50]">{label}</span>
        <span className={`text-xs ${statusColor}`}>{statusText}</span>
      </div>
      {/* Track */}
      <div className="relative h-4 rounded-full bg-gray-200 overflow-hidden">
        {/* Target zone marker (600–720) */}
        <div
          className="absolute top-0 bottom-0 bg-green-100 border-l border-r border-green-300"
          style={{ left: `${(600 / capacity) * 100}%`, right: '0%' }}
        />
        {/* Fill bar */}
        <div
          className={`absolute top-0 left-0 bottom-0 ${barColor} transition-all duration-300`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-gray-400">
        <span>0</span>
        <span>600</span>
        <span>720</span>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span className="inline-block h-4 w-4 rounded-full border-2 border-[#535B50] border-t-transparent animate-spin" />
  );
}

function SectionHeader({ letter, title, count }: { letter: string; title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[#535B50] text-white text-xs flex items-center justify-center font-bold">
        {letter}
      </span>
      <h3 className="font-semibold text-[#535B50]">{title}</h3>
      {count !== undefined && (
        <span className="ml-auto text-xs text-gray-500 bg-gray-100 rounded-full px-2 py-0.5">
          {count}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TranslateClient() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [sponsors, setSponsors] = useState<string[]>([]);
  const [sponsorFilter, setSponsorFilter] = useState('');
  const [showSponsorDropdown, setShowSponsorDropdown] = useState(false);
  const [selectedSponsor, setSelectedSponsor] = useState<string | null>(null);

  const [productSearch, setProductSearch] = useState('');
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [productsLimited, setProductsLimited] = useState(false);
  const [productsLoading, setProductsLoading] = useState(false);

  const [selectedProducts, setSelectedProducts] = useState<SelectedProduct[]>([]);
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);

  const [formula, setFormula] = useState<FormulaResult | null>(null);
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [checkedExclusives, setCheckedExclusives] = useState<Set<string>>(new Set());
  const [confirmedSubs, setConfirmedSubs] = useState<Set<string>>(new Set());

  /** Direct actives the practitioner has manually excluded from the pod. */
  const [excludedActives, setExcludedActives] = useState<Set<string>>(new Set());

  // Formula save state
  const [formulaName, setFormulaName] = useState('');
  const [practitionerEmail, setPractitionerEmail] = useState(() => {
    // Persist the practitioner's email in localStorage so they don't re-enter it each session.
    if (typeof window !== 'undefined') return localStorage.getItem('nof1_practitioner_email') ?? '';
    return '';
  });
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  // Per-ingredient granule overrides — keyed by moietyId (direct), substituteId (class subs),
  // or tsiCode (N of 1 exclusives). Cleared on each new translation so stale adjustments don't carry over.
  const [directGranuleOverrides, setDirectGranuleOverrides] = useState<Record<string, number>>({});
  const [subGranuleOverrides, setSubGranuleOverrides] = useState<Record<string, number>>({});
  const [exclusiveGranuleOverrides, setExclusiveGranuleOverrides] = useState<Record<string, number>>({});

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sponsorInputRef = useRef<HTMLInputElement>(null);

  // ── Load sponsors on mount ────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/translate/products?sponsors=true')
      .then((r) => r.json())
      .then((d) => setSponsors(d.sponsors ?? []))
      .catch(() => {});
  }, []);

  // ── Load products when sponsor changes or product search changes ───────────
  const loadProducts = useCallback(
    (sponsor: string | null, search: string) => {
      if (!sponsor && !search) {
        setProducts([]);
        return;
      }
      setProductsLoading(true);
      const params = new URLSearchParams();
      if (sponsor) params.set('sponsor', sponsor);
      if (search) params.set('search', search);
      fetch(`/api/translate/products?${params}`)
        .then((r) => r.json())
        .then((d) => {
          setProducts(d.products ?? []);
          setProductsLimited(d.limited ?? false);
          setProductsLoading(false);
        })
        .catch(() => setProductsLoading(false));
    },
    [],
  );

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!selectedSponsor && !productSearch) { setProducts([]); return; }
    if (productSearch) {
      searchTimerRef.current = setTimeout(() => loadProducts(selectedSponsor, productSearch), 300);
    } else {
      loadProducts(selectedSponsor, productSearch);
    }
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [selectedSponsor, productSearch, loadProducts]);

  // ── Add / remove products ─────────────────────────────────────────────────
  function addProduct(p: ProductSummary) {
    if (selectedProducts.some((s) => s.artgId === p.artgId)) return;
    setSelectedProducts((prev) => [...prev, {
      artgId: p.artgId,
      productName: p.productName,
      sponsor: p.sponsor,
      unitsPerDay: 1,
    }]);
  }

  function removeProduct(artgId: string) {
    setSelectedProducts((prev) => prev.filter((p) => p.artgId !== artgId));
    if (formula) setFormula(null);
  }

  function updateUnits(artgId: string, units: number) {
    setSelectedProducts((prev) =>
      prev.map((p) => (p.artgId === artgId ? { ...p, unitsPerDay: Math.max(1, units) } : p)),
    );
    if (formula) setFormula(null);
  }

  // ── Run translation ───────────────────────────────────────────────────────
  async function handleTranslate() {
    if (!selectedProducts.length) return;
    setTranslating(true);
    setError(null);
    setFormula(null);
    setCheckedExclusives(new Set());
    setConfirmedSubs(new Set());
    setExcludedActives(new Set());
    setDirectGranuleOverrides({});
    setSubGranuleOverrides({});
    setExclusiveGranuleOverrides({});
    setFormulaName('');
    setSaveStatus('idle');
    setSaveError(null);

    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selections: selectedProducts.map((p) => ({ artgId: p.artgId, unitsPerDay: p.unitsPerDay })),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error ?? `HTTP ${res.status}`);
      } else {
        setFormula(data);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setTranslating(false);
    }
  }

  // ── Save formula to Shopify ───────────────────────────────────────────────
  async function handleSaveFormula() {
    if (!formula || !formulaName.trim() || !practitionerEmail.trim()) return;
    setSaveStatus('saving');
    setSaveError(null);

    // Persist email across sessions
    localStorage.setItem('nof1_practitioner_email', practitionerEmail.trim());

    // Build the serialised ingredient list reflecting all practitioner adjustments.
    // Excluded actives are not included in the saved formula.
    const ingredients = [
      ...formula.directActives.filter((a) => !excludedActives.has(a.moietyId)).map((a) => ({
        name: a.name,
        dose: getDirectDose(a),
        unit: a.unit,
        granules: getDirectGranules(a),
        section: 'direct' as const,
        tier: a.tier,
      })),
      ...formula.classSubstitutes
        .filter((cs) => confirmedSubs.has(cs.substituteId))
        .map((cs) => ({
          name: cs.substituteName,
          dose: getSubDose(cs),
          unit: cs.unit,
          granules: getSubGranules(cs),
          section: 'class_substitute' as const,
        })),
      ...formula.nof1Exclusives
        .filter((e) => checkedExclusives.has(e.tsiCode))
        .map((e) => ({
          name: e.name,
          dose: getExclusiveDose(e),
          unit: e.unit,
          granules: getExclusiveGranules(e),
          section: 'nof1_addition' as const,
        })),
    ];

    const payload = {
      schema_version: '1.0' as const,
      formula_name: formulaName.trim(),
      practitioner_email: practitionerEmail.trim(),
      created_at: new Date().toISOString(),
      pod_granules: podTotal,
      pod_capacity: 720 as const,
      pod_fill_percentage: Math.round((podTotal / 720) * 1000) / 10,
      ingredients,
      purchase_separately: formula.purchaseSeparately.map((p) => ({
        name: p.name,
        total_dose: p.totalDose,
        unit: p.unit,
      })),
      source_products: formula.selectedProducts.map((p) => ({
        artg_id: p.artgId,
        product_name: p.productName,
        sponsor: p.sponsor,
        units_per_day: p.unitsPerDay,
      })),
    };

    try {
      const res = await fetch('/api/formula-export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setSaveStatus('error');
        setSaveError(data.error ?? `HTTP ${res.status}`);
      } else {
        setSaveStatus('saved');
      }
    } catch (e) {
      setSaveStatus('error');
      setSaveError(String(e));
    }
  }

  // ── Granule adjustment helpers ─────────────────────────────────────────────
  function getDirectGranules(a: DirectActive): number {
    return directGranuleOverrides[a.moietyId] ?? a.granules;
  }

  function getDirectDose(a: DirectActive): number {
    if (a.granules === 0) return a.totalDose;
    // Prefer library dosePerGranule: gives the actual dispensed dose (granules × dpg).
    // Fallback to the protocol ratio when dosePerGranule isn't available (legacy data).
    if (a.dosePerGranule != null) {
      return Math.round(getDirectGranules(a) * a.dosePerGranule * 10) / 10;
    }
    return Math.round((a.totalDose / a.granules) * getDirectGranules(a) * 10) / 10;
  }

  function getSubGranules(cs: ClassSub): number {
    return subGranuleOverrides[cs.substituteId] ?? cs.recommendedGranules;
  }

  function getSubDose(cs: ClassSub): number {
    if (cs.recommendedGranules === 0) return cs.recommendedDose;
    return Math.round((cs.recommendedDose / cs.recommendedGranules) * getSubGranules(cs) * 10) / 10;
  }

  function getExclusiveGranules(e: Nof1Exclusive): number {
    return exclusiveGranuleOverrides[e.tsiCode] ?? e.recommendedGranules;
  }

  function getExclusiveDose(e: Nof1Exclusive): number {
    return Math.round(e.dosePerGranule * getExclusiveGranules(e) * 10) / 10;
  }

  function adjustDirectGranules(id: string, delta: number, base: number) {
    setDirectGranuleOverrides((prev) => {
      const current = prev[id] ?? base;
      return { ...prev, [id]: Math.max(1, current + delta) };
    });
  }

  function adjustSubGranules(id: string, delta: number, base: number) {
    setSubGranuleOverrides((prev) => {
      const current = prev[id] ?? base;
      return { ...prev, [id]: Math.max(1, current + delta) };
    });
  }

  function adjustExclusiveGranules(id: string, delta: number, base: number) {
    setExclusiveGranuleOverrides((prev) => {
      const current = prev[id] ?? base;
      return { ...prev, [id]: Math.max(1, current + delta) };
    });
  }

  function toggleExcludeActive(moietyId: string) {
    setExcludedActives((prev) => {
      const next = new Set(prev);
      if (next.has(moietyId)) next.delete(moietyId);
      else next.add(moietyId);
      return next;
    });
  }

  // ── Live pod total (direct + confirmed subs + checked exclusives) ──────────
  const podTotal = formula
    ? formula.directActives
        .filter((a) => !excludedActives.has(a.moietyId))
        .reduce((s, a) => s + getDirectGranules(a), 0) +
      formula.classSubstitutes
        .filter((cs) => confirmedSubs.has(cs.substituteId))
        .reduce((s, cs) => s + getSubGranules(cs), 0) +
      [...checkedExclusives].reduce((s, id) => {
        const e = formula.nof1Exclusives.find((x) => x.tsiCode === id);
        return s + (e ? getExclusiveGranules(e) : 0);
      }, 0)
    : 0;

  // ── Filtered sponsor list ─────────────────────────────────────────────────
  const filteredSponsors = sponsors.filter((s) =>
    s.toLowerCase().includes(sponsorFilter.toLowerCase()),
  );

  // ── Group N of 1 exclusives by category ──────────────────────────────────
  const exclusivesByCategory = formula
    ? formula.nof1Exclusives.reduce<Record<string, Nof1Exclusive[]>>((acc, e) => {
        (acc[e.category] ??= []).push(e);
        return acc;
      }, {})
    : {};

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col lg:flex-row gap-0 min-h-[calc(100vh-72px)]">

      {/* ── LEFT PANEL: Protocol Builder ─────────────────────────────────── */}
      <aside className="w-full lg:w-96 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col">

        {/* ── Brand picker ──────────────────────────────────────────────── */}
        <div className="p-4 border-b border-gray-100">
          <label className="block text-xs font-semibold text-[#535B50] uppercase tracking-wider mb-2">
            Brand / Sponsor
          </label>
          <div className="relative">
            <input
              ref={sponsorInputRef}
              type="text"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#535B50] focus:ring-1 focus:ring-[#535B50]"
              placeholder={selectedSponsor ?? 'Search brand…'}
              value={sponsorFilter}
              onChange={(e) => { setSponsorFilter(e.target.value); setShowSponsorDropdown(true); }}
              onFocus={() => setShowSponsorDropdown(true)}
              onBlur={() => setTimeout(() => setShowSponsorDropdown(false), 150)}
            />
            {selectedSponsor && (
              <button
                className="absolute right-2 top-2 text-gray-400 hover:text-gray-600"
                onClick={() => {
                  setSelectedSponsor(null);
                  setSponsorFilter('');
                  setProductSearch('');
                  setProducts([]);
                }}
              >
                ×
              </button>
            )}
            {showSponsorDropdown && filteredSponsors.length > 0 && (
              <ul className="absolute z-20 w-full mt-1 max-h-56 overflow-y-auto bg-white border border-gray-200 rounded-md shadow-lg text-sm">
                {filteredSponsors.slice(0, 60).map((s) => (
                  <li
                    key={s}
                    className={`px-3 py-2 cursor-pointer hover:bg-[#E2E0D9] ${
                      s === selectedSponsor ? 'font-semibold text-[#535B50]' : 'text-gray-700'
                    }`}
                    onMouseDown={() => {
                      setSelectedSponsor(s);
                      setSponsorFilter('');
                      setProductSearch('');
                      setShowSponsorDropdown(false);
                    }}
                  >
                    {s}
                  </li>
                ))}
                {filteredSponsors.length > 60 && (
                  <li className="px-3 py-2 text-gray-400 text-xs">
                    Showing 60 of {filteredSponsors.length} — type to narrow
                  </li>
                )}
              </ul>
            )}
          </div>
          {selectedSponsor && (
            <p className="mt-1.5 text-xs text-[#535B50] font-medium truncate">
              ✓ {selectedSponsor}
            </p>
          )}
        </div>

        {/* ── Product search ────────────────────────────────────────────── */}
        <div className="p-4 border-b border-gray-100">
          <label className="block text-xs font-semibold text-[#535B50] uppercase tracking-wider mb-2">
            Product Name {selectedSponsor ? `(within ${selectedSponsor.split(' ')[0]}…)` : '(all brands)'}
          </label>
          <input
            type="text"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#535B50] focus:ring-1 focus:ring-[#535B50]"
            placeholder={selectedSponsor ? 'Filter products…' : 'Search all products…'}
            value={productSearch}
            onChange={(e) => setProductSearch(e.target.value)}
          />
        </div>

        {/* ── Product list ──────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          {productsLoading && (
            <div className="p-4 flex items-center gap-2 text-sm text-gray-500">
              <Spinner /> Loading products…
            </div>
          )}

          {!productsLoading && (selectedSponsor || productSearch) && products.length === 0 && (
            <p className="p-4 text-sm text-gray-400">No products found.</p>
          )}

          {!productsLoading && !selectedSponsor && !productSearch && (
            <p className="p-4 text-sm text-gray-400">
              Select a brand or search a product name to begin.
            </p>
          )}

          {products.length > 0 && (
            <>
              {productsLimited && (
                <p className="px-4 py-2 text-xs text-amber-600 bg-amber-50 border-b border-amber-100">
                  Showing first 60 results — type to narrow
                </p>
              )}
              <ul className="divide-y divide-gray-100">
                {products.map((p) => {
                  const alreadyAdded = selectedProducts.some((s) => s.artgId === p.artgId);
                  const isExpanded = expandedProduct === p.artgId;

                  return (
                    <li key={p.artgId} className="px-4 py-3">
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-800 leading-tight">
                            {p.productName}
                          </p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {p.artgId} · {p.doseForm} · {p.activesCount} active{p.activesCount !== 1 ? 's' : ''}
                            {p.unmatchedCount > 0 && (
                              <span className="ml-1 text-amber-500">({p.unmatchedCount} unmatched)</span>
                            )}
                          </p>
                        </div>
                        <div className="flex gap-1 flex-shrink-0">
                          <button
                            className="text-xs text-gray-400 hover:text-[#535B50]"
                            onClick={() => setExpandedProduct(isExpanded ? null : p.artgId)}
                          >
                            {isExpanded ? '▲' : '▼'}
                          </button>
                          <button
                            onClick={() => addProduct(p)}
                            disabled={alreadyAdded}
                            className={`px-2 py-1 text-xs rounded font-medium ${
                              alreadyAdded
                                ? 'bg-gray-100 text-gray-400 cursor-default'
                                : 'bg-[#535B50] text-white hover:bg-[#3f4640]'
                            }`}
                          >
                            {alreadyAdded ? 'Added' : 'Add'}
                          </button>
                        </div>
                      </div>

                      {/* Expanded actives list */}
                      {isExpanded && (
                        <ul className="mt-2 space-y-0.5 pl-2 border-l-2 border-[#E2E0D9]">
                          {p.actives.map((a, i) => (
                            <li key={i} className="text-xs text-gray-500 flex gap-1.5">
                              <span className={`flex-shrink-0 ${a.libraryId ? 'text-green-600' : 'text-amber-500'}`}>
                                {a.libraryId ? '●' : '○'}
                              </span>
                              <span>{a.moiety}</span>
                              <span className="text-gray-400">{a.amount} {a.unit}</span>
                            </li>
                          ))}
                          {p.unmatchedCount > 0 && (
                            <li className="text-xs text-amber-500 pl-4">
                              + {p.unmatchedCount} unmatched ingredient{p.unmatchedCount !== 1 ? 's' : ''}
                            </li>
                          )}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        {/* ── Selected protocol ─────────────────────────────────────────── */}
        <div className="border-t border-gray-200 bg-[#f8f7f5]">
          <div className="px-4 pt-3 pb-1 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-[#535B50] uppercase tracking-wider">
              Selected Protocol ({selectedProducts.length})
            </h3>
            {selectedProducts.length > 0 && (
              <button
                className="text-xs text-red-400 hover:text-red-600"
                onClick={() => { setSelectedProducts([]); setFormula(null); }}
              >
                Clear all
              </button>
            )}
          </div>

          {selectedProducts.length === 0 ? (
            <p className="px-4 py-3 text-xs text-gray-400">No products added yet.</p>
          ) : (
            <ul className="px-4 py-2 space-y-2">
              {selectedProducts.map((p) => (
                <li key={p.artgId} className="flex items-center gap-2 text-sm">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-700 text-xs leading-tight truncate">{p.productName}</p>
                    <p className="text-xs text-gray-400">{p.sponsor.split(' ').slice(0,3).join(' ')}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <label className="text-xs text-gray-500">×</label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={p.unitsPerDay}
                      onChange={(e) => updateUnits(p.artgId, parseInt(e.target.value, 10))}
                      className="w-12 text-center border border-gray-300 rounded text-xs py-0.5 focus:outline-none focus:border-[#535B50]"
                    />
                    <span className="text-xs text-gray-400">/day</span>
                  </div>
                  <button
                    onClick={() => removeProduct(p.artgId)}
                    className="text-gray-300 hover:text-red-400 text-sm"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Translate button */}
          <div className="p-4 pt-2">
            <button
              onClick={handleTranslate}
              disabled={selectedProducts.length === 0 || translating}
              className={`w-full py-2.5 rounded-md text-sm font-semibold transition-colors ${
                selectedProducts.length === 0
                  ? 'bg-gray-100 text-gray-400 cursor-default'
                  : translating
                  ? 'bg-[#A7B7A5] text-white cursor-wait'
                  : 'bg-[#535B50] text-white hover:bg-[#3f4640]'
              }`}
            >
              {translating ? (
                <span className="flex items-center justify-center gap-2">
                  <Spinner /> Building Formula…
                </span>
              ) : (
                'Build N of 1 Formula →'
              )}
            </button>
          </div>
        </div>
      </aside>

      {/* ── RIGHT PANEL: Formula Result ───────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">
            <strong>Error:</strong> {error}
          </div>
        )}

        {!formula && !translating && !error && (
          <div className="flex flex-col items-center justify-center h-full text-center text-gray-400 py-24">
            <div className="text-5xl mb-4">⟳</div>
            <p className="text-lg font-medium text-gray-500 mb-2">Formula will appear here</p>
            <p className="text-sm">Select commercial products on the left, then click "Build N of 1 Formula"</p>
          </div>
        )}

        {formula && (
          <div className="space-y-6 max-w-4xl">

            {/* ── Pod Summary ──────────────────────────────────────────────── */}
            <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-bold text-[#535B50]">Pod Fill</h2>
                <span className="text-xs text-gray-400">720-granule capacity · target 600–720</span>
              </div>
              <PodGauge total={podTotal} capacity={720} />
              <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-600">
                <span>
                  <strong className="text-[#535B50]">{formula.directActives.filter((a) => !excludedActives.has(a.moietyId)).reduce((s, a) => s + getDirectGranules(a), 0)}</strong> from direct translation
                </span>
                {confirmedSubs.size > 0 && (
                  <span>
                    <strong className="text-[#535B50]">
                      {formula.classSubstitutes
                        .filter((cs) => confirmedSubs.has(cs.substituteId))
                        .reduce((s, cs) => s + getSubGranules(cs), 0)}
                    </strong> from confirmed substitutes
                  </span>
                )}
                {checkedExclusives.size > 0 && (
                  <span>
                    <strong className="text-[#535B50]">
                      {[...checkedExclusives].reduce((s, id) => {
                        const e = formula.nof1Exclusives.find((x) => x.tsiCode === id);
                        return s + (e ? getExclusiveGranules(e) : 0);
                      }, 0)}
                    </strong> from N of 1 additions
                  </span>
                )}
              </div>
            </div>

            {/* ── A: Direct Actives ────────────────────────────────────────── */}
            <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
              <SectionHeader
                letter="A"
                title="Direct Translation"
                count={formula.directActives.length}
              />
              <p className="text-xs text-gray-500 mb-3">
                Moieties matched directly to the N of 1 library. Stacked actives (from multiple products) are consolidated to a single dose.
              </p>

              {formula.directActives.length === 0 ? (
                <p className="text-sm text-gray-400">No direct matches found.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 text-xs text-gray-500 uppercase tracking-wider">
                        <th className="text-left py-2 pr-4 font-medium">Active</th>
                        <th className="text-right py-2 px-2 font-medium">Dose / day</th>
                        <th className="text-right py-2 px-2 font-medium">Granules</th>
                        <th className="text-left py-2 pl-2 font-medium">Sources</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {formula.directActives.map((a) => {
                        const excluded = excludedActives.has(a.moietyId);
                        const overMax = !excluded && a.maxDailyDose != null && getDirectDose(a) > a.maxDailyDose;
                        return (
                        <tr key={a.moietyId} className={excluded ? 'bg-gray-50' : overMax ? 'bg-red-50' : ''}>
                          <td className="py-2 pr-4">
                            <div className="flex items-center gap-1.5">
                              <span className={`font-medium ${excluded ? 'text-gray-400 line-through decoration-gray-300' : 'text-gray-800'}`}>
                                {a.name}
                              </span>
                              {!excluded && a.stacked && (
                                <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">
                                  stacked
                                </span>
                              )}
                              {!excluded && a.tier === 'FORM_SUBSTITUTION' && (
                                <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">
                                  form sub
                                </span>
                              )}
                              {overMax && (
                                <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full">
                                  ⚠ exceeds max
                                </span>
                              )}
                              {excluded && (
                                <span className="text-xs bg-gray-200 text-gray-400 px-1.5 py-0.5 rounded-full">
                                  excluded
                                </span>
                              )}
                              {/* Exclude / restore toggle */}
                              <button
                                onClick={() => toggleExcludeActive(a.moietyId)}
                                title={excluded ? 'Restore to formula' : 'Remove from formula'}
                                className={`ml-auto flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                                  excluded
                                    ? 'bg-gray-200 text-gray-500 hover:bg-[#535B50] hover:text-white'
                                    : 'text-gray-300 hover:text-red-400 hover:bg-red-50'
                                }`}
                              >
                                {excluded ? '↩' : '×'}
                              </button>
                            </div>
                          </td>
                          <td className={`py-2 px-2 text-right ${excluded ? 'text-gray-300' : 'text-gray-700'}`}>
                            {!excluded ? (
                              <div>
                                <span>{getDirectDose(a)} {a.unit}</span>
                                {a.maxDailyDose != null && (
                                  <div className="text-xs text-gray-400 mt-0.5">
                                    max {a.maxDailyDose} {a.maxDailyDoseUnit}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="line-through decoration-gray-200">{getDirectDose(a)} {a.unit}</span>
                            )}
                          </td>
                          <td className="py-2 px-2 text-right font-mono font-medium text-[#535B50]">
                            <div className={`flex items-center justify-end gap-0.5 ${excluded ? 'opacity-25 pointer-events-none' : ''}`}>
                              <button
                                onClick={() => adjustDirectGranules(a.moietyId, -1, a.granules)}
                                className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-[#535B50] hover:bg-gray-100 text-xs font-bold leading-none"
                                aria-label="Decrease granules"
                              >
                                −
                              </button>
                              <span className="w-8 text-center">{getDirectGranules(a)}</span>
                              <button
                                onClick={() => adjustDirectGranules(a.moietyId, +1, a.granules)}
                                className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-[#535B50] hover:bg-gray-100 text-xs font-bold leading-none"
                                aria-label="Increase granules"
                              >
                                +
                              </button>
                            </div>
                          </td>
                          <td className={`py-2 pl-2 text-xs ${excluded ? 'text-gray-300' : 'text-gray-400'}`}>
                            {a.stacked ? (
                              <ul className="space-y-0.5">
                                {a.sources.map((s, i) => (
                                  <li key={i}>
                                    {s.productName.slice(0, 28)}{s.productName.length > 28 ? '…' : ''} ({s.subtotal} {a.unit} × {s.unitsPerDay})
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              a.sources[0]?.productName.slice(0, 32)
                            )}
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ── B: Class Substitutes ─────────────────────────────────────── */}
            {formula.classSubstitutes.length > 0 && (
              <div className="bg-white rounded-xl border border-amber-200 p-5 shadow-sm">
                <SectionHeader
                  letter="B"
                  title="Class Substitutes — Requires Practitioner Confirmation"
                  count={formula.classSubstitutes.length}
                />
                <p className="text-xs text-gray-500 mb-3">
                  These ARTG ingredients have no direct library match. A therapeutically related N of 1 moiety is proposed. Library dose is applied (commercial dose not used). Confirm each before including in the pod.
                </p>

                <div className="space-y-3">
                  {formula.classSubstitutes.map((cs) => {
                    const confirmed = confirmedSubs.has(cs.substituteId);
                    return (
                      <div
                        key={cs.artgIngredientName}
                        className={`border rounded-lg p-3 ${confirmed ? 'border-green-300 bg-green-50' : 'border-amber-200 bg-amber-50'}`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="flex-1">
                            <div className="flex flex-wrap items-center gap-2 mb-1">
                              <span className="font-medium text-gray-700 text-sm">{cs.artgIngredientName}</span>
                              <span className="text-gray-400 text-xs">→</span>
                              <span className="font-semibold text-[#535B50] text-sm">{cs.substituteName}</span>
                              <span className="text-xs text-gray-500 ml-1">
                                {confirmed ? getSubDose(cs) : cs.recommendedDose} {cs.unit}/day
                                {' · '}
                                {confirmed ? getSubGranules(cs) : cs.recommendedGranules} granules
                              </span>
                            </div>
                            <p className="text-xs text-gray-500 leading-relaxed mb-2">{cs.rationale}</p>
                            <div className="flex items-center gap-3 flex-wrap">
                              <p className="text-xs text-gray-400">
                                From: {cs.sources.map((s) => s.productName).join(', ')}
                              </p>
                              {confirmed && (
                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={() => adjustSubGranules(cs.substituteId, -1, cs.recommendedGranules)}
                                    className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-[#535B50] hover:bg-white text-xs font-bold"
                                    aria-label="Decrease granules"
                                  >
                                    −
                                  </button>
                                  <span className="text-xs text-[#535B50] font-mono w-6 text-center">
                                    {getSubGranules(cs)}
                                  </span>
                                  <button
                                    onClick={() => adjustSubGranules(cs.substituteId, +1, cs.recommendedGranules)}
                                    className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-[#535B50] hover:bg-white text-xs font-bold"
                                    aria-label="Increase granules"
                                  >
                                    +
                                  </button>
                                  <span className="text-xs text-gray-400">gr</span>
                                </div>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={() =>
                              setConfirmedSubs((prev) => {
                                const next = new Set(prev);
                                if (next.has(cs.substituteId)) next.delete(cs.substituteId);
                                else next.add(cs.substituteId);
                                return next;
                              })
                            }
                            className={`flex-shrink-0 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                              confirmed
                                ? 'bg-green-600 text-white hover:bg-green-700'
                                : 'bg-amber-600 text-white hover:bg-amber-700'
                            }`}
                          >
                            {confirmed ? '✓ Confirmed' : 'Confirm →'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── C: N of 1 Additions ──────────────────────────────────────── */}
            {formula.nof1Exclusives.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
                <SectionHeader
                  letter="C"
                  title="N of 1 Additions — Exclusive to Compounding"
                  count={formula.nof1Exclusives.length}
                />
                <p className="text-xs text-gray-500 mb-4">
                  These library moieties are <strong>not available in any ARTG Listed Medicine</strong>. They can only be delivered via a compounded pod. Check any you wish to include — the pod fill gauge updates in real time.
                </p>

                {Object.entries(exclusivesByCategory).sort().map(([cat, items]) => (
                  <div key={cat} className="mb-4">
                    <div className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-semibold mb-2 ${categoryBadge(cat)}`}>
                      {displayCategory(cat)}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                      {items.map((e) => {
                        const checked = checkedExclusives.has(e.tsiCode);
                        return (
                          <label
                            key={e.tsiCode}
                            className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${
                              checked
                                ? 'border-[#535B50] bg-[#f0f2f0]'
                                : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                            }`}
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5 accent-[#535B50]"
                              checked={checked}
                              onChange={() =>
                                setCheckedExclusives((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(e.tsiCode)) next.delete(e.tsiCode);
                                  else next.add(e.tsiCode);
                                  return next;
                                })
                              }
                            />
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-800 leading-tight">{e.name}</p>
                              <p className="text-xs text-gray-500 mt-0.5">
                                {checked ? getExclusiveDose(e) : e.recommendedDose} {e.unit} · {checked ? getExclusiveGranules(e) : e.recommendedGranules} granules
                              </p>
                              {checked && (
                                <div
                                  className="flex items-center gap-1 mt-1.5"
                                  onClick={(ev) => ev.preventDefault()}
                                >
                                  <button
                                    onClick={(ev) => { ev.preventDefault(); adjustExclusiveGranules(e.tsiCode, -1, e.recommendedGranules); }}
                                    className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-[#535B50] hover:bg-white text-xs font-bold"
                                    aria-label="Decrease granules"
                                  >
                                    −
                                  </button>
                                  <span className="text-xs text-[#535B50] font-mono w-6 text-center">{getExclusiveGranules(e)}</span>
                                  <button
                                    onClick={(ev) => { ev.preventDefault(); adjustExclusiveGranules(e.tsiCode, +1, e.recommendedGranules); }}
                                    className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-[#535B50] hover:bg-white text-xs font-bold"
                                    aria-label="Increase granules"
                                  >
                                    +
                                  </button>
                                  <span className="text-xs text-gray-400">gr</span>
                                </div>
                              )}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}

                {checkedExclusives.size > 0 && (
                  <div className="mt-3 pt-3 border-t border-gray-100 flex justify-between items-center text-sm">
                    <span className="text-gray-600">
                      {checkedExclusives.size} addition{checkedExclusives.size !== 1 ? 's' : ''} selected
                    </span>
                    <button
                      className="text-xs text-gray-400 hover:text-red-500"
                      onClick={() => setCheckedExclusives(new Set())}
                    >
                      Deselect all
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ── D: Purchase Separately ───────────────────────────────────── */}
            {formula.purchaseSeparately.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
                <SectionHeader
                  letter="D"
                  title="Purchase Separately"
                  count={formula.purchaseSeparately.length}
                />
                <p className="text-xs text-gray-500 mb-3">
                  Actives that cannot be delivered as granules (omega-3s, probiotics, CFU-dosed ingredients).
                  Advise the patient to continue sourcing these as standalone commercial products.
                </p>
                <ul className="space-y-2">
                  {formula.purchaseSeparately.map((p, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <span className="flex-shrink-0 text-[#C3AF88] mt-0.5">↗</span>
                      <div>
                        <span className="font-medium text-gray-700">{p.name}</span>
                        <span className="text-gray-500 ml-2">{p.totalDose} {p.unit}/day</span>
                        <p className="text-xs text-gray-400 mt-0.5">{p.note}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* ── E: Unresolved ────────────────────────────────────────────── */}
            {formula.unresolved.length > 0 && (() => {
              // Build a product-name lookup from selected products
              const productName = (artgId: string) =>
                formula.selectedProducts.find((p) => p.artgId === artgId)?.productName ?? artgId;

              // Group by ingredient name so one row = one ingredient (with all sources)
              const grouped = formula.unresolved.reduce<Record<string, string[]>>((acc, u) => {
                (acc[u.ingredientName] ??= []).push(u.artgId);
                return acc;
              }, {});

              return (
                <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
                  <SectionHeader
                    letter="E"
                    title="Unresolved Ingredients"
                    count={Object.keys(grouped).length}
                  />
                  <p className="text-xs text-gray-500 mb-3">
                    These ARTG ingredient names could not be matched to any N of 1 library moiety and have no
                    class substitute. Add aliases in <code className="text-xs bg-gray-100 px-1 rounded">data/artg-aliases.json</code> to
                    resolve them, or accept as not applicable.
                  </p>
                  <ul className="space-y-2">
                    {Object.entries(grouped).map(([ingredientName, artgIds]) => (
                      <li key={ingredientName} className="text-sm">
                        <span className="font-medium text-gray-700">{ingredientName}</span>
                        <div className="mt-0.5 flex flex-wrap gap-1.5">
                          {artgIds.map((id) => (
                            <span
                              key={id}
                              className="inline-flex items-center gap-1 text-xs text-gray-500 bg-gray-100 rounded px-1.5 py-0.5"
                            >
                              <span className="font-mono text-gray-400">{id}</span>
                              <span>{productName(id)}</span>
                            </span>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}

            {/* ── Formula summary banner ──────────────────────────────────── */}
            <div className="bg-[#535B50] text-white rounded-xl p-5 shadow-sm">
              <h3 className="font-bold text-lg mb-1">Formula Summary</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm mt-3">
                <div>
                  <p className="text-[#A7B7A5] text-xs uppercase tracking-wider mb-0.5">Direct actives</p>
                  <p className="font-bold text-xl">{formula.directActives.length}</p>
                </div>
                <div>
                  <p className="text-[#A7B7A5] text-xs uppercase tracking-wider mb-0.5">Class substitutes</p>
                  <p className="font-bold text-xl">{formula.classSubstitutes.length}</p>
                </div>
                <div>
                  <p className="text-[#A7B7A5] text-xs uppercase tracking-wider mb-0.5">N of 1 additions</p>
                  <p className="font-bold text-xl">{checkedExclusives.size}</p>
                </div>
                <div>
                  <p className="text-[#A7B7A5] text-xs uppercase tracking-wider mb-0.5">Pod granules</p>
                  <p className={`font-bold text-xl ${podTotal > 720 ? 'text-red-300' : podTotal >= 600 ? 'text-green-300' : 'text-[#C3AF88]'}`}>
                    {podTotal} / 720
                  </p>
                </div>
              </div>
              <p className="mt-4 text-xs text-[#A7B7A5]">
                For practitioner review only. This formulation is a draft pending clinical confirmation. The practitioner is the prescribing clinician of record.
              </p>
            </div>

            {/* ── Save to My Formulas ─────────────────────────────────────── */}
            <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-lg">📋</span>
                <h3 className="font-semibold text-[#535B50]">Save to My Formulas</h3>
              </div>
              <p className="text-xs text-gray-500 mb-4">
                Name this formula and save it to your account on nof1script.com.au. It will appear on your My Formulas page.
              </p>

              <div className="space-y-3">
                {/* Formula name */}
                <div>
                  <label className="block text-xs font-semibold text-[#535B50] uppercase tracking-wider mb-1">
                    Formula name <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Patient ABC — Aug 2026 Protocol"
                    value={formulaName}
                    onChange={(e) => { setFormulaName(e.target.value); setSaveStatus('idle'); }}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#535B50] focus:ring-1 focus:ring-[#535B50]"
                  />
                </div>

                {/* Practitioner email */}
                <div>
                  <label className="block text-xs font-semibold text-[#535B50] uppercase tracking-wider mb-1">
                    Your account email <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="email"
                    placeholder="you@clinic.com.au"
                    value={practitionerEmail}
                    onChange={(e) => { setPractitionerEmail(e.target.value); setSaveStatus('idle'); }}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#535B50] focus:ring-1 focus:ring-[#535B50]"
                  />
                  <p className="text-xs text-gray-400 mt-1">Must match your nof1script.com.au account email. Remembered for next time.</p>
                </div>

                {/* Save button + status */}
                <div className="flex items-center gap-3 pt-1">
                  <button
                    onClick={handleSaveFormula}
                    disabled={!formulaName.trim() || !practitionerEmail.trim() || saveStatus === 'saving' || saveStatus === 'saved'}
                    className={`px-5 py-2 rounded-md text-sm font-semibold transition-colors ${
                      saveStatus === 'saved'
                        ? 'bg-green-600 text-white cursor-default'
                        : saveStatus === 'saving'
                        ? 'bg-[#A7B7A5] text-white cursor-wait'
                        : !formulaName.trim() || !practitionerEmail.trim()
                        ? 'bg-gray-100 text-gray-400 cursor-default'
                        : 'bg-[#535B50] text-white hover:bg-[#3f4640]'
                    }`}
                  >
                    {saveStatus === 'saving' ? (
                      <span className="flex items-center gap-2"><Spinner /> Saving…</span>
                    ) : saveStatus === 'saved' ? (
                      '✓ Saved to My Formulas'
                    ) : (
                      'Save to My Formulas →'
                    )}
                  </button>

                  {saveStatus === 'saved' && (
                    <button
                      onClick={() => { setFormulaName(''); setSaveStatus('idle'); setSaveError(null); }}
                      className="text-xs text-gray-400 hover:text-gray-600"
                    >
                      Save another
                    </button>
                  )}
                </div>

                {saveStatus === 'error' && saveError && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                    ⚠ {saveError}
                  </p>
                )}
              </div>
            </div>

          </div>
        )}
      </main>
    </div>
  );
}
