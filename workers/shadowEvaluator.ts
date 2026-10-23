/**
 * shadowEvaluator.ts — Stage 005 §4.2 post-trip ground-truth calibration.
 *
 * Runs in the operational domain under role `ride_dispatch` (Stage 003 §3.1:
 * INSERT on dpmaps.routing_eval_events; column-level SELECT on Tier V).
 * NEVER as dpmaps_worker (REVOKE ALL on public.ride_vendor_data).
 *
 * Hard insert contract (Stage 003 §4.7, Rev 2.1):
 * - Exact 12-column list: vehicle_type, tod_bucket, osrm_duration_s,
 *   osrm_distance_m, actual_driven_duration_s, actual_driven_distance_m,
 *   vendor_duration_error_pct, vendor_distance_error_pct, duration_error_pct,
 *   distance_error_pct, corridor_overlap_pct, route_deviation_flag.
 * - ZERO trip_id / trip_hash columns. ZERO raw vendor quotes, ZERO vendor
 *   coordinates, ZERO vendor polylines. Vendor Tier V values are read ONCE,
 *   converted to percentages in memory, and discarded.
 * - corridor_overlap_pct is computed against the OSRM (first-party) geometry
 *   only — vendor geometry is NEVER used (F-005-11). Buffer 50 m [ESTIMATE];
 *   route_deviation_flag trips below 70% [ESTIMATE].
 *
 * Zero dependencies. The DB sink is injected; persistRoutingEval enforces the
 * column allowlist at runtime (defense in depth — throws on forbidden keys).
 */

export type VehicleType = 'car' | 'bike' | 'cng';
export type TodBucket = 'morning_peak' | 'evening_peak' | 'off_peak' | 'night';

/** First-party OSRM shadow quote (Redis shadow:route:<trip_hash>, 24 h TTL). */
export interface ShadowQuote {
  osrm_distance_m: number;
  osrm_duration_s: number;
  /** First-party OSM-derived encoded polyline (precision 5). */
  osrm_geometry?: string;
  vehicle_type: VehicleType;
  /** Dispatch timestamp (ms epoch): the conditions being predicted. */
  dispatched_at: number;
}

/** First-party completed-trip truth (driver handset + orders table). */
export interface TripTruth {
  elapsedSeconds: number;
  drivenOdometerMeters: number;
  drivenGpsTrace: { lat: number; lng: number }[];
  /** Tier V vendor quote, read ONCE by the operational caller (nullable). */
  vendorDistM?: number | null;
  vendorDurS?: number | null;
}

/** Exact Stage 003 §4.7 insert shape. No other keys permitted. */
export interface RoutingEvalRow {
  vehicle_type: VehicleType;
  tod_bucket: TodBucket;
  osrm_duration_s: number;
  osrm_distance_m: number;
  actual_driven_duration_s: number;
  actual_driven_distance_m: number;
  vendor_duration_error_pct: number | null;
  vendor_distance_error_pct: number | null;
  duration_error_pct: number;
  distance_error_pct: number;
  corridor_overlap_pct: number;
  route_deviation_flag: boolean;
}

export const ROUTING_EVAL_COLUMNS: readonly (keyof RoutingEvalRow)[] = [
  'vehicle_type',
  'tod_bucket',
  'osrm_duration_s',
  'osrm_distance_m',
  'actual_driven_duration_s',
  'actual_driven_distance_m',
  'vendor_duration_error_pct',
  'vendor_distance_error_pct',
  'duration_error_pct',
  'distance_error_pct',
  'corridor_overlap_pct',
  'route_deviation_flag',
];

/** Keys that must NEVER appear in a dpmaps-bound eval row. */
const FORBIDDEN_KEYS = [
  'trip_id',
  'trip_hash',
  'ride_id',
  'vendor_duration_s',
  'vendor_distance_m',
  'vendor_quoted_dur_s',
  'vendor_quoted_dist_m',
  'vendor_lat',
  'vendor_lng',
  'vendor_polyline',
  'vendor_geometry',
  'temp_client_id',
  'display_name',
];

export const CORRIDOR_BUFFER_M = 50; // [ESTIMATE]
export const ROUTE_DEVIATION_THRESHOLD_PCT = 70; // [ESTIMATE] below → flag

const VALID_VEHICLES: readonly string[] = ['car', 'bike', 'cng'];
const VALID_BUCKETS: readonly string[] = ['morning_peak', 'evening_peak', 'off_peak', 'night'];

/** e = |pred − actual| / actual × 100. Two-decimal commercial rounding. */
export function errorPct(pred: number, actual: number): number {
  if (!(actual > 0)) throw new Error('errorPct: actual must be > 0');
  return Number(((Math.abs(pred - actual) / actual) * 100).toFixed(2));
}

/** Decode a precision-5 encoded polyline to lat/lng points. */
export function decodePolyline5(encoded: string): { lat: number; lng: number }[] {
  const pts: { lat: number; lng: number }[] = [];
  let lat = 0;
  let lng = 0;
  let i = 0;
  while (i < encoded.length) {
    let shift = 0;
    let result = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return pts;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Equirectangular point-to-segment distance (adequate at 50 m buffers). */
function distToSegmentM(
  p: { lat: number; lng: number },
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  const ky = 110_540;
  const px = p.lng * kx;
  const py = p.lat * ky;
  const ax = a.lng * kx;
  const ay = a.lat * ky;
  const bx = b.lng * kx;
  const by = b.lat * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
}

function distanceToPolylineM(
  p: { lat: number; lng: number },
  geom: { lat: number; lng: number }[],
): number {
  if (geom.length === 0) return Number.POSITIVE_INFINITY;
  if (geom.length === 1) return haversineMeters(p.lat, p.lng, geom[0].lat, geom[0].lng);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < geom.length - 1; i++) {
    const d = distToSegmentM(p, geom[i], geom[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * corridor_overlap_pct (F-005-11): % of driven fixes within bufferM of the
 * dpMaps/OSRM quoted geometry. Empty trace → 0. Missing geometry → 0
 * (never fall back to vendor geometry — there is no such parameter).
 */
export function computeCorridorOverlapPct(
  osrmGeometry: string | undefined,
  drivenTrace: { lat: number; lng: number }[],
  bufferM = CORRIDOR_BUFFER_M,
): number {
  if (!osrmGeometry || drivenTrace.length === 0) return 0;
  const geom = decodePolyline5(osrmGeometry);
  if (geom.length === 0) return 0;
  const inside = drivenTrace.filter((p) => distanceToPolylineM(p, geom) <= bufferM).length;
  return Number(((inside / drivenTrace.length) * 100).toFixed(2));
}

/**
 * Pure evaluation: shadow quote + first-party truth → §4.7 row.
 * Returns null when the quote is missing (GETDEL miss) or truth is invalid.
 * Vendor raw values enter as numbers and leave only as percentages.
 */
export function evaluateTrip(
  quote: ShadowQuote | null | undefined,
  truth: TripTruth,
  todBucket: TodBucket,
): RoutingEvalRow | null {
  if (!quote) return null;
  if (!(truth.elapsedSeconds > 0) || !(truth.drivenOdometerMeters > 0)) return null;
  if (!VALID_VEHICLES.includes(quote.vehicle_type)) throw new Error('evaluateTrip: bad vehicle_type');
  if (!VALID_BUCKETS.includes(todBucket)) throw new Error('evaluateTrip: bad tod_bucket');

  const corridorOverlapPct = computeCorridorOverlapPct(quote.osrm_geometry, truth.drivenGpsTrace);
  return {
    vehicle_type: quote.vehicle_type,
    tod_bucket: todBucket,
    osrm_duration_s: quote.osrm_duration_s,
    osrm_distance_m: quote.osrm_distance_m,
    actual_driven_duration_s: truth.elapsedSeconds,
    actual_driven_distance_m: truth.drivenOdometerMeters,
    vendor_duration_error_pct:
      truth.vendorDurS != null ? errorPct(truth.vendorDurS, truth.elapsedSeconds) : null,
    vendor_distance_error_pct:
      truth.vendorDistM != null ? errorPct(truth.vendorDistM, truth.drivenOdometerMeters) : null,
    duration_error_pct: errorPct(quote.osrm_duration_s, truth.elapsedSeconds),
    distance_error_pct: errorPct(quote.osrm_distance_m, truth.drivenOdometerMeters),
    corridor_overlap_pct: corridorOverlapPct,
    route_deviation_flag: corridorOverlapPct < ROUTE_DEVIATION_THRESHOLD_PCT,
  };
}

export interface EvalDb {
  query: (text: string, params: unknown[]) => Promise<unknown>;
}

/**
 * Insert percentages ONLY into dpmaps.routing_eval_events. Throws if the row
 * carries any forbidden key (trip_id, raw vendor quotes/coords/polylines) or
 * any key outside the §4.7 column list.
 */
export async function persistRoutingEval(db: EvalDb, row: RoutingEvalRow): Promise<void> {
  const keys = Object.keys(row);
  for (const k of keys) {
    if (FORBIDDEN_KEYS.includes(k)) {
      throw new Error(`persistRoutingEval: forbidden key '${k}' — clean-room violation`);
    }
    if (!(ROUTING_EVAL_COLUMNS as readonly string[]).includes(k)) {
      throw new Error(`persistRoutingEval: unknown column '${k}' — not in §4.7 contract`);
    }
  }
  for (const c of ROUTING_EVAL_COLUMNS) {
    if (!(c in row)) throw new Error(`persistRoutingEval: missing column '${c}'`);
  }
  await db.query(
    `INSERT INTO dpmaps.routing_eval_events (
       vehicle_type, tod_bucket, osrm_duration_s, osrm_distance_m,
       actual_driven_duration_s, actual_driven_distance_m,
       vendor_duration_error_pct, vendor_distance_error_pct,
       duration_error_pct, distance_error_pct,
       corridor_overlap_pct, route_deviation_flag
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    ROUTING_EVAL_COLUMNS.map((c) => (row as unknown as Record<string, unknown>)[c]),
  );
}
