/**
 * dispatchRouter.ts — Stage 005 §3 production dispatch waterfall.
 *
 * Four-state administrative toggle (hot-reloadable via system_config):
 *   0: off     — 100% vendor, ZERO OSRM calls, zero shadow overhead.
 *   1: shadow  — vendor serves live; async OSRM shadow quote (first-party only).
 *   2: primary — OSRM serves live (300 ms); vendor fallback on timeout/error.
 *   3: sole    — OSRM only; vendor endpoints severed in code.
 *
 * Clean-room (Hard Rules 1/8, Stage 003 Rev 2.1 contract):
 * - Raw vendor quotes live only in public.ride_vendor_data (Tier V, written by
 *   the operational caller — NOT by this router). This router returns vendor
 *   numbers as a LIVE pass-through only; it never persists, logs, or forwards
 *   them into dpmaps.* payloads.
 * - The shadow payload carries FIRST-PARTY OSRM numbers + OSRM geometry only,
 *   keyed `shadow:route:<trip_hash>` (24 h TTL). Zero vendor values.
 * - Vendor polylines are response-only (handset rendering). Never logged.
 *
 * Zero dependencies: all transports, caches, and clocks are injected so the
 * Stage 005 audit can execute this file behaviorally with fakes (same pattern
 * as Stage 004). Production wires:
 *   resolveSelection -> utils-server/vendorClientWrapper.resolveVendorSelection
 *   osrm leg         -> utils-server/osrmRoutingClient (300 ms, 3-strike breaker)
 *   vendor legs      -> vendorClientWrapper.executeBarikoiRoute / googleFallback
 *   recordShadow     -> Redis SET shadow:route:<trip_hash> EX 86400
 *   tripHash         -> lib/tripHash HMAC-SHA256(trip_id, IngestionSalt)
 */

export type VehicleType = 'car' | 'bike' | 'cng';
export type RoutingMode = 'off' | 'shadow' | 'primary' | 'sole';

/** Canonical per-leg budgets (ms). Floor is in-memory: 0 ms. */
export const OSRM_TIMEOUT_MS = 300;
export const BARIKOI_TIMEOUT_MS = 400;
export const GOOGLE_TIMEOUT_MS = 600;

/** Shadow quote cache contract: key prefix + 24 h TTL (seconds). */
export const SHADOW_KEY_PREFIX = 'shadow:route:';
export const SHADOW_TTL_SECONDS = 86_400;

/** Legal gate: Stage 002 Items 3, 7, 14–17 sign-off. Closed until counsel signs. */
export const LEGAL_GATE_ITEMS = [3, 7, 14, 15, 16, 17] as const;

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteRequest {
  /** Operational order UUID. Logs only; 30-day purge. Never enters dpmaps.*. */
  tripId: string;
  origin: LatLng;
  destination: LatLng | { tempClientId: string };
  vehicleType: VehicleType;
}

export interface ActiveRouteResult {
  distance_meters: number;
  duration_seconds: number;
  /**
   * Vendor polyline: LIVE PASS-THROUGH ONLY for handset rendering (F-005-9).
   * Never logged, persisted, benchmarked, or copied into dpmaps.*.
   */
  polyline?: string;
  provider: 'osrm' | 'barikoi' | 'google' | 'haversine_floor';
  latency_ms: number;
}

export interface OsrmQuote {
  distance_meters: number;
  duration_seconds: number;
  /** First-party OSM-derived geometry. Never vendor geometry. */
  polyline?: string;
  vehicleType: VehicleType;
  /** Dispatch timestamp (ms epoch): the conditions being predicted (§4.3). */
  dispatchedAt: number;
}

export interface RouterDeps {
  /** Raw admin value: 0|1|2|3 or 'off'|'shadow'|'primary'|'sole'. */
  getModeRaw: () => unknown;
  /** Stage 002 legal-gate sign-off state. Default closed. */
  isLegalGateOpen?: () => boolean;
  /** Atomic single-use GETDEL resolution of vendor:resolve:* (Stage 002). */
  resolveSelection: (tempClientId: string) => Promise<LatLng | null>;
  /** Vehicle's own OSRM engine leg (Stage 004 client semantics). */
  osrmRoute: (origin: LatLng, dest: LatLng, vehicle: VehicleType) => Promise<ActiveRouteResult | null>;
  barikoiRoute: (origin: LatLng, dest: LatLng) => Promise<ActiveRouteResult | null>;
  /** Already spend-cap + circuit-breaker guarded (googleFallback.ts). */
  googleRoute: (origin: LatLng, dest: LatLng, tier: string) => Promise<ActiveRouteResult | null>;
  /** Service tier for the Google whitelist (e.g. 'sedan'; moto/cng excluded). */
  serviceTier?: string;
  /** Async shadow-quote sink (Redis SET … EX 86400 in production). */
  recordShadow?: (key: string, quote: OsrmQuote, ttlSeconds: number) => Promise<void>;
  /** Pseudonymous correlation: HMAC-SHA256(trip_id, IngestionSalt) (§4.4). */
  tripHash?: (tripId: string) => string;
  /** Alert sink: P1 on invalid mode, P2 on vendor fallback. Enums only. */
  onAlert?: (severity: 'P1' | 'P2', code: string) => void;
  now?: () => number;
}

const MODE_BY_NUMBER: Record<number, RoutingMode> = {
  0: 'off',
  1: 'shadow',
  2: 'primary',
  3: 'sole',
};
const VALID_MODES: readonly RoutingMode[] = ['off', 'shadow', 'primary', 'sole'];

/**
 * Normalize the admin toggle. Unknown/invalid values fail safe to 'off'
 * (F-005-8) — never silently another mode. Returns whether input was invalid
 * so the caller can raise the P1 alert exactly once per request.
 */
export function normalizeMode(raw: unknown): { mode: RoutingMode; invalid: boolean } {
  if (typeof raw === 'number' && Number.isInteger(raw) && MODE_BY_NUMBER[raw] !== undefined) {
    return { mode: MODE_BY_NUMBER[raw], invalid: false };
  }
  if (typeof raw === 'string' && (VALID_MODES as readonly string[]).includes(raw)) {
    return { mode: raw as RoutingMode, invalid: false };
  }
  return { mode: 'off', invalid: true };
}

/**
 * Emergency floor: Haversine distance × 1.3 tortuosity at 18 km/h.
 * 18 km/h = 18,000 m / 3,600 s = 5 m/s, hence seconds = roadMeters / 5.
 * The `/ 18000 … * 3600` form is kept explicit so the 18 km/h baseline
 * (F-005-6 repair: was /5000) stays grep-visible to the audit.
 */
export function getHaversineFallback(origin: LatLng, dest: LatLng): ActiveRouteResult {
  const directMeters = haversineMeters(origin.lat, origin.lng, dest.lat, dest.lng);
  const roadMeters = directMeters * 1.3; // standard urban tortuosity multiplier
  const estSeconds = Math.round((roadMeters / 18000) * 3600); // 18 km/h baseline
  return {
    distance_meters: Math.round(roadMeters),
    duration_seconds: estSeconds,
    provider: 'haversine_floor',
    latency_ms: 0,
  };
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

/** Error percentage vs first-party ground truth: |pred − actual| / actual × 100. */
export function errorPct(pred: number, actual: number): number {
  if (!(actual > 0)) throw new Error('errorPct: actual must be > 0');
  return Number((Math.abs(pred - actual) / actual) * 100);
}

async function resolveDestination(
  dest: LatLng | { tempClientId: string },
  resolveSelection: RouterDeps['resolveSelection'],
): Promise<LatLng | null> {
  if (!isTempClientRef(dest)) return dest;
  return resolveSelection(dest.tempClientId);
}

function isTempClientRef(dest: LatLng | { tempClientId: string }): dest is { tempClientId: string } {
  return typeof (dest as { tempClientId?: unknown }).tempClientId === 'string';
}

/**
 * Canonical dispatch waterfall. Mode 0 performs ZERO OSRM calls and records
 * ZERO shadow quotes. Mode 3 performs ZERO vendor calls. Mode 1 serves the
 * vendor live and fires the shadow quote off the hot path (setImmediate —
 * never awaited on dispatch latency).
 */
export async function calculateDispatchRoute(req: RouteRequest, deps: RouterDeps): Promise<ActiveRouteResult> {
  const alert = deps.onAlert ?? ((): void => undefined);
  const now = deps.now ?? Date.now;
  let { mode, invalid } = normalizeMode(deps.getModeRaw());
  if (invalid) alert('P1', 'INVALID_ROUTING_MODE_FAILSAFE_OFF');
  // Legal gate: shadow evaluation (incl. driver-GPS comparison) is barred
  // until Stage 002 Items 3,7,14–17 are signed off — fail safe to off (F-005-12).
  if (mode === 'shadow' && !(deps.isLegalGateOpen?.() ?? false)) {
    alert('P1', 'SHADOW_BLOCKED_LEGAL_GATE_LOCK');
    mode = 'off';
  }

  const destCoords = await resolveDestination(req.destination, deps.resolveSelection);
  if (!destCoords) throw new Error('SELECTION_EXPIRED_PLEASE_RESELECT');

  if (mode === 'sole') {
    const osrm = await deps.osrmRoute(req.origin, destCoords, req.vehicleType);
    if (osrm) return osrm;
    return getHaversineFallback(req.origin, destCoords);
  }

  if (mode === 'primary') {
    const osrm = await deps.osrmRoute(req.origin, destCoords, req.vehicleType);
    if (osrm) return osrm;
    alert('P2', 'OSRM_FALLBACK_BARIKOI');
    const barikoi = await deps.barikoiRoute(req.origin, destCoords);
    if (barikoi) return barikoi;
    alert('P2', 'BARIKOI_FALLBACK_GOOGLE');
    const google = await deps.googleRoute(req.origin, destCoords, deps.serviceTier ?? 'sedan');
    if (google) return google;
    return getHaversineFallback(req.origin, destCoords);
  }

  if (mode === 'shadow') {
    let active: ActiveRouteResult | null = null;
    const barikoi = await deps.barikoiRoute(req.origin, destCoords);
    if (barikoi) {
      active = barikoi;
    } else {
      alert('P2', 'BARIKOI_FALLBACK_GOOGLE');
      active =
        (await deps.googleRoute(req.origin, destCoords, deps.serviceTier ?? 'sedan')) ??
        getHaversineFallback(req.origin, destCoords);
    }
    // Non-blocking async shadow evaluation — first-party OSRM quote only.
    // setImmediate keeps it off dispatch latency; failures never fail dispatch.
    const sink = deps.recordShadow;
    const hash = deps.tripHash;
    if (sink && hash) {
      const origin = req.origin;
      const vehicleType = req.vehicleType;
      const tripId = req.tripId;
      const dispatchedAt = now();
      const osrmRoute = deps.osrmRoute;
      setImmediate(() => {
        osrmRoute(origin, destCoords, vehicleType)
          .then((q) => {
            if (!q) return;
            const quote: OsrmQuote = {
              distance_meters: q.distance_meters,
              duration_seconds: q.duration_seconds,
              polyline: q.polyline, // first-party OSM geometry only
              vehicleType,
              dispatchedAt,
            };
            return sink(`${SHADOW_KEY_PREFIX}${hash(tripId)}`, quote, SHADOW_TTL_SECONDS);
          })
          .catch(() => undefined);
      });
    }
    return active;
  }

  // Mode 0: off — vendor only. ZERO OSRM calls, ZERO shadow quotes.
  const vendorResult = await deps.barikoiRoute(req.origin, destCoords);
  if (vendorResult) return vendorResult;
  const google = await deps.googleRoute(req.origin, destCoords, deps.serviceTier ?? 'sedan');
  if (google) return google;
  return getHaversineFallback(req.origin, destCoords);
}
