/**
 * destSession.ts — Stage 008 §5 destination session handoff contract.
 *
 * When a rider taps a VENDOR suggestion, dispatch later needs its
 * coordinates. The handoff:
 *   key   `dest_session:<session_token>` (server-minted ephemeral UUID v4)
 *   value `{ lat, lng }` ONLY — never names, IDs, or polylines
 *   TTL   15 minutes (900 s, single session handoff window)
 *   read  atomic GETDEL (Redis ≥ 6.2) — single use
 *   miss  fail safe: prompt rider reselection; NO database fallback,
 *         NO vendor re-query
 *   store vendor coordinates NEVER enter public_pois, osm_pois, or any
 *         Ride core table (Hard Rule 1)
 *
 * Cross-plan note: this module is the search-side write path (authoritative
 * per plan §5). Stage 005's dispatch resolver consumes the same key.
 * Stage 002's `vendor:resolve:<temp_client_id>` (120 s) is superseded and
 * awaits its rename/retirement in the next Stage 002 audit — this module
 * does NOT modify the verified Stage 002 wrapper.
 *
 * Zero dependencies. Cache + UUID generator injected (production: Redis
 * GETDEL, node:crypto randomUUID).
 */

export const DEST_SESSION_PREFIX = 'dest_session:';
export const DEST_SESSION_TTL_SECONDS = 900; // 15 minutes

export interface SessionCache {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  /** Atomic get-and-delete. Null when expired or already consumed. */
  getdel(key: string): Promise<string | null>;
}

export interface DestSessionDeps {
  cache: SessionCache;
  mintToken?: () => string;
}

function defaultMintToken(): string {
  // Production passes node:crypto randomUUID. Fallback is collision-safe
  // enough for audit/fake environments only.
  return `sess-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
}

function isFiniteCoord(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Stores vendor coordinates ephemerally; returns the session token handed
 * to the client. Throws on non-finite coordinates (never store junk).
 */
export async function recordDestinationSession(
  coords: { lat: number; lng: number },
  deps: DestSessionDeps,
): Promise<string> {
  if (!isFiniteCoord(coords.lat) || !isFiniteCoord(coords.lng)) {
    throw new Error('recordDestinationSession: non-finite coordinates refused');
  }
  const token = (deps.mintToken ?? defaultMintToken)();
  if (!token || typeof token !== 'string') {
    throw new Error('recordDestinationSession: token minter returned empty token');
  }
  await deps.cache.set(
    `${DEST_SESSION_PREFIX}${token}`,
    JSON.stringify({ lat: coords.lat, lng: coords.lng }),
    'EX',
    DEST_SESSION_TTL_SECONDS,
  );
  return token;
}

/**
 * Atomic single-use consumption for Ride dispatch. Returns null when the
 * token expired (>15 min) or was already consumed — the client must prompt
 * rider reselection. Malformed payloads also resolve to null (never throw
 * into the dispatch path).
 */
export async function consumeDestinationSession(
  deps: DestSessionDeps,
  sessionToken: string,
): Promise<{ lat: number; lng: number } | null> {
  if (!sessionToken || typeof sessionToken !== 'string') return null;
  const raw = await deps.cache.getdel(`${DEST_SESSION_PREFIX}${sessionToken}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { lat?: unknown; lng?: unknown };
    if (!isFiniteCoord(parsed.lat) || !isFiniteCoord(parsed.lng)) return null;
    return { lat: parsed.lat, lng: parsed.lng };
  } catch {
    return null;
  }
}
