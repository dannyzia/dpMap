/**
 * searchOrchestrator.ts — Stage 008 §4 mixed autocomplete orchestrator.
 *
 * Four-state toggle (hot-reloadable via system_config, cf. Stage 005):
 *   0: off     — vendor only (legal lock / maintenance). Local indexes untouched.
 *   1: shadow  — parallel local + vendor, fused mixed list FROM LAUNCH.
 *   2: primary — local first; vendor called STRICTLY on zero local results.
 *   3: sole    — local only; zero external calls.
 * Invalid values fail safe to 0: off with a P1 alert (never another mode).
 *
 * Clean-room (Hard Rules 1/8):
 * - The ONLY merge point is the in-memory fuse() below (RAM, per request).
 *   The two Meili indexes are never co-indexed (searchIndexConfig.ts F-008-1).
 * - Vendor suggestions flow exclusively through the Stage 002 wrapper shape
 *   (SafeVendorSuggestion, import type — zero runtime vendor dependency).
 *   Vendor display strings are response-only; vendor coordinates never
 *   persist (destSession.ts handoff only), never logged.
 * - Stage 007 normalizer pre-processes every query (NFC, digit folding,
 *   digit locking preserved); raw keystrokes never stream anywhere —
 *   telemetry is selection-time only (searchTelemetry.ts).
 * - Legal gate (Stage 002 Items 3,7,14–17): shadow AND primary both mix or
 *   fall back to vendor pre-clearance, so both fail safe to off while the
 *   gate is closed. Mode 3 (sole, zero vendor) stays available.
 *
 * Zero dependencies: MeiliSearch client, platform config, vendor transport,
 * and clocks are injected (production wires meilisearch@port 7700,
 * getPlatformConfig, fetchSafeVendorSuggestions). No 'meilisearch' import
 * here — the search API process owns the client.
 */

import type { SafeVendorSuggestion } from '../utils-server/vendorClientWrapper';
import { normalizeSearchQuery } from '../utils-server/textNormalizer';

export type SearchMode = 'off' | 'shadow' | 'primary' | 'sole';
export type SuggestionSource = 'first_party' | 'osm' | 'vendor';
export type ProvenanceBadge = 'verified_landmark' | 'open_directory' | null;

/** Canonical per-request local-search budget (plan §4, [ESTIMATE]). */
export const LOCAL_SEARCH_TIMEOUT_MS = 40;
/** Cross-source dedupe radius (hub order: 50 m with matching name/alias). */
export const MERGE_DEDUP_METERS = 50;
/** Minimum normalized query length (plan §4.1). */
export const MIN_QUERY_CHARS = 2;
/** Dropdown cap (plan §4.1). */
export const MAX_ITEMS = 6;

/** Raw hit from either local index (Meili hit subset). */
export interface LocalHit {
  id: string;
  canonical_name?: string;
  bangla_name?: string;
  category: string;
  search_aliases?: string[];
  popularity?: number;
  confidence_score?: number;
  _geo?: { lat: number; lng: number };
}

export interface AutocompleteItem {
  id: string;
  title: string;
  subtitle: string;
  category: string;
  source: SuggestionSource;
  badge: ProvenanceBadge;
  /** Vendor only: session token for the dest_session handoff (F-008-4). */
  session_token?: string;
  /** Local hits only: coordinates for client map preview. */
  coords?: { lat: number; lng: number };
  /** Ephemeral in-RAM fusion hint (vendor approx position). Stripped pre-response. */
  _fusePos?: { lat: number; lng: number };
  /** Ephemeral alias set for name/alias dedupe. Stripped pre-response. */
  _aliases?: string[];
}

export interface SearchDeps {
  getModeRaw: () => unknown;
  /** Stage 002 legal-gate sign-off state. Default closed. */
  isLegalGateOpen?: () => boolean;
  searchFirstParty: (query: string) => Promise<LocalHit[]>;
  searchOsm: (query: string) => Promise<LocalHit[]>;
  vendorSearch: (
    rawQuery: string,
    userLoc?: { lat: number; lng: number },
  ) => Promise<SafeVendorSuggestion[]>;
  onAlert?: (severity: 'P1' | 'P2', code: string) => void;
  timeoutMs?: number;
  maxItems?: number;
}

const MODE_BY_NUMBER: Record<number, SearchMode> = {
  0: 'off',
  1: 'shadow',
  2: 'primary',
  3: 'sole',
};
const VALID_MODES: readonly SearchMode[] = ['off', 'shadow', 'primary', 'sole'];

/** Unknown/invalid values fail safe to 'off' — never silently another mode. */
export function normalizeSearchMode(raw: unknown): { mode: SearchMode; invalid: boolean } {
  if (typeof raw === 'number' && Number.isInteger(raw) && MODE_BY_NUMBER[raw] !== undefined) {
    return { mode: MODE_BY_NUMBER[raw], invalid: false };
  }
  if (typeof raw === 'string' && (VALID_MODES as readonly string[]).includes(raw)) {
    return { mode: raw as SearchMode, invalid: false };
  }
  return { mode: 'off', invalid: true };
}

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

function normTitle(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Hub-order dedupe: keep the higher-precedence hit when a competitor lies
 * within MERGE_DEDUP_METERS *with a matching name/alias*. Precedence:
 * first_party > osm > vendor. Title equality or shared alias token counts
 * as a name match; nearby-but-differently-named places are all kept
 * (distinct shops in one mall must never collapse).
 */
export function fuse(
  localItems: AutocompleteItem[],
  vendorItems: AutocompleteItem[],
): AutocompleteItem[] {
  const rank = (i: AutocompleteItem): number =>
    i.source === 'first_party' ? 0 : i.source === 'osm' ? 1 : 2;
  const posOf = (i: AutocompleteItem): { lat: number; lng: number } | undefined =>
    i.coords ?? i._fusePos;
  const namesOf = (i: AutocompleteItem): Set<string> => {
    const s = new Set<string>([normTitle(i.title)]);
    for (const a of i._aliases ?? []) {
      const n = normTitle(a);
      if (n) s.add(n);
    }
    return s;
  };
  const ordered = [...localItems, ...vendorItems].sort((a, b) => rank(a) - rank(b));
  const kept: AutocompleteItem[] = [];
  for (const item of ordered) {
    const p2 = posOf(item);
    const n2 = namesOf(item);
    const dup = kept.some((k) => {
      const p1 = posOf(k);
      if (p1 && p2 && haversineMeters(p1.lat, p1.lng, p2.lat, p2.lng) < MERGE_DEDUP_METERS) {
        const n1 = namesOf(k);
        for (const n of n2) if (n1.has(n)) return true;
      }
      return false;
    });
    if (!dup) kept.push(item);
  }
  return kept;
}

/** Strips ephemeral fusion fields before the HTTP response. */
export function stripEphemeral(i: AutocompleteItem): AutocompleteItem {
  const pub = { ...i } as unknown as Record<string, unknown>;
  delete pub._fusePos;
  delete pub._aliases;
  return pub as unknown as AutocompleteItem;
}

function formatLocalHit(hit: LocalHit, source: 'first_party' | 'osm'): AutocompleteItem {
  return {
    id: hit.id,
    title: hit.canonical_name ?? hit.bangla_name ?? '',
    subtitle: hit.bangla_name ?? hit.category,
    category: hit.category,
    source,
    badge: source === 'first_party' ? 'verified_landmark' : 'open_directory',
    coords: hit._geo ? { lat: hit._geo.lat, lng: hit._geo.lng } : undefined,
    _aliases: hit.search_aliases ?? [],
  };
}

function formatVendorSuggestion(s: SafeVendorSuggestion): AutocompleteItem {
  const withSession = s as SafeVendorSuggestion & {
    session_token?: string;
    approx_coords?: { lat: number; lng: number };
  };
  return {
    id: `vendor_${withSession.session_token ?? s.temp_client_id}`,
    title: s.display_name, // response-only; never persisted (Stage 002)
    subtitle: s.secondary_text,
    category: s.category,
    source: 'vendor',
    badge: null,
    // Wrapper contract migration (plan §5 X-2): prefers session_token when
    // the wrapper emits it; today's verified wrapper emits temp_client_id.
    session_token: withSession.session_token ?? s.temp_client_id,
    // Ephemeral in-memory fusion hint only; stripped pre-response.
    _fusePos: withSession.approx_coords,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    t = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([
    p.then(
      (v) => {
        if (t !== undefined) clearTimeout(t);
        return v as T | null;
      },
      () => {
        if (t !== undefined) clearTimeout(t);
        return null;
      },
    ),
    timeout,
  ]);
}

async function mergeLocalIndexes(
  q: string,
  deps: SearchDeps,
  budgetMs: number,
): Promise<AutocompleteItem[]> {
  const [fp, osm] = await Promise.all([
    withTimeout(deps.searchFirstParty(q), budgetMs),
    withTimeout(deps.searchOsm(q), budgetMs),
  ]);
  return fuse(
    [...(fp ?? []).map((h) => formatLocalHit(h, 'first_party')),
     ...(osm ?? []).map((h) => formatLocalHit(h, 'osm'))],
    [],
  );
}

/**
 * Mixed autocomplete entry point. Modes 1 (shadow) and 2 (primary) both
 * touch the vendor path, so both require the legal gate; closed gate fails
 * safe to off. Local legs share one 40 ms budget; a timed-out leg degrades
 * to empty rather than failing the request.
 */
export async function getMixedAutocomplete(
  rawQuery: string,
  deps: SearchDeps,
  userLat?: number,
  userLng?: number,
): Promise<AutocompleteItem[]> {
  const alert = deps.onAlert ?? ((): void => undefined);
  const budgetMs = deps.timeoutMs ?? LOCAL_SEARCH_TIMEOUT_MS;
  const maxItems = deps.maxItems ?? MAX_ITEMS;
  let { mode, invalid } = normalizeSearchMode(deps.getModeRaw());
  if (invalid) alert('P1', 'INVALID_SEARCH_MODE_FAILSAFE_OFF');
  const gateOpen = deps.isLegalGateOpen?.() ?? false;
  if ((mode === 'shadow' || mode === 'primary') && !gateOpen) {
    alert('P1', 'SEARCH_BLOCKED_LEGAL_GATE_LOCK');
    mode = 'off';
  }

  const normalized = normalizeSearchQuery(rawQuery);
  const q = normalized.normalized_query;
  if (q.length < MIN_QUERY_CHARS) return [];

  const userLoc =
    userLat !== undefined && userLng !== undefined ? { lat: userLat, lng: userLng } : undefined;
  const vendor = (): Promise<AutocompleteItem[]> =>
    deps
      .vendorSearch(rawQuery, userLoc)
      .then((ss) => ss.map(formatVendorSuggestion))
      .catch(() => []);

  let items: AutocompleteItem[];
  if (mode === 'sole') {
    items = await mergeLocalIndexes(q, deps, budgetMs);
  } else if (mode === 'primary') {
    const hits = await mergeLocalIndexes(q, deps, budgetMs);
    // F-008-3: vendor strictly on ZERO local results.
    items = hits.length > 0 ? hits : await vendor();
  } else if (mode === 'shadow') {
    const [hits, vend] = await Promise.all([mergeLocalIndexes(q, deps, budgetMs), vendor()]);
    items = fuse(hits, vend);
  } else {
    items = await vendor(); // mode 0: off — vendor only, zero local queries
  }
  return items.slice(0, maxItems).map(stripEphemeral);
}
