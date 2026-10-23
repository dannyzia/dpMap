/**
 * trafficHarvester.ts — Stage 004 §6 first-party TOD speed harvester.
 *
 * Runs only when routing_provider_mode in {shadow, primary, sole} AND
 * traffic_harvest_enabled AND the Stage 002 legal gate (Items 3,7,14–17)
 * is signed off. Consumes asynchronously from an off-path queue (never on
 * the dispatch path). Traces > 100 points are split into 50-point
 * overlapping chunks (5-point overlap).
 *
 * Clean-room: input is FIRST-PARTY driver GPS only (ground truth). OSM node
 * IDs are isolated OSM-layer identifiers, never merged into public_pois.
 * Zero vendor dependencies, zero vendor data.
 */

export type VehicleType = 'car' | 'bike' | 'cng';
export type TodBucket = 'morning_peak' | 'evening_peak' | 'off_peak' | 'night';

export interface GpsPing {
  lat: number;
  lng: number;
  /** epoch millis, handset trip clock */
  timestamp: number;
  /** instantaneous handset speed km/h (when available) */
  speedKmh?: number;
}

export interface EdgeSpeedRecord {
  fromNode: number;
  toNode: number;
  speedKmh: number;
  todBucket: TodBucket;
  vehicleType: VehicleType;
}

/** Vehicle's own profile engine port (F-004-11: never cross-match). */
export const ENGINE_PORT: Record<VehicleType, number> = {
  car: 5001,
  bike: 5002,
  cng: 5003,
};

const HALT_SPEED_KMH = 2;
const HALT_SUSTAIN_MS = 30_000;
const MIN_MATCH_POINTS = 3;
const MIN_CONFIDENCE = 0.6; // [ESTIMATE] discard low-confidence matchings
const SPEED_CLAMP_MIN = 3; // [ESTIMATE] km/h
const SPEED_CLAMP_MAX = 100; // [ESTIMATE] km/h
const MATCH_TIMEOUT_MS = 1500;
const MAX_CHUNK = 50;
const CHUNK_OVERLAP = 5;

/**
 * Drop pings with speed < 2 km/h sustained for > 30 s (pickup/dropoff halts).
 * Pings without speedKmh are kept (map-matcher decides).
 */
export function filterStationaryHalts(trace: GpsPing[]): GpsPing[] {
  const out: GpsPing[] = [];
  let haltStart: number | null = null;
  for (const p of trace) {
    const stopped = p.speedKmh !== undefined && p.speedKmh < HALT_SPEED_KMH;
    if (!stopped) {
      haltStart = null;
      out.push(p);
      continue;
    }
    if (haltStart === null) haltStart = p.timestamp;
    if (p.timestamp - haltStart <= HALT_SUSTAIN_MS) out.push(p);
    // else: sustained halt — drop.
  }
  return out;
}

/** Harmonic mean: N / Σ(1/vᵢ). A single speeder cannot skew congestion. */
export function calculateHarmonicMean(speeds: number[]): number {
  if (speeds.length === 0) throw new Error('calculateHarmonicMean: empty input');
  let inv = 0;
  for (const v of speeds) {
    if (!(v > 0)) throw new Error('calculateHarmonicMean: speeds must be > 0');
    inv += 1 / v;
  }
  return speeds.length / inv;
}

/**
 * TOD bucket in Asia/Dhaka local time (UTC+6, no DST observance):
 * morning_peak 07:00–10:59, evening_peak 16:00–20:59,
 * night 00:00–04:59, off_peak otherwise. Defaults are [ESTIMATE].
 */
export function resolveTodBucket(dateOrTimestamp: Date | number): TodBucket {
  const ms = typeof dateOrTimestamp === 'number' ? dateOrTimestamp : dateOrTimestamp.getTime();
  const dhakaHour = new Date(ms + 6 * 3_600_000).getUTCHours();
  if (dhakaHour >= 7 && dhakaHour < 11) return 'morning_peak';
  if (dhakaHour >= 16 && dhakaHour < 21) return 'evening_peak';
  if (dhakaHour < 5) return 'night';
  return 'off_peak';
}

export type MatchFetcher = (url: string, timeoutMs: number) => Promise<MatchResponse>;

export interface MatchAnnotation {
  nodes?: number[];
  duration?: number[];
  distance?: number[];
}
export interface MatchLeg {
  annotation?: MatchAnnotation;
}
export interface MatchMatching {
  confidence?: number;
  legs?: MatchLeg[];
}
export interface MatchResponse {
  code: string;
  matchings?: MatchMatching[];
}

const defaultFetcher: MatchFetcher = async (url, timeoutMs) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return (await res.json()) as MatchResponse;
  } finally {
    clearTimeout(t);
  }
};

function chunkTrace(trace: GpsPing[]): GpsPing[][] {
  if (trace.length <= 100) return [trace];
  const chunks: GpsPing[][] = [];
  for (let i = 0; i < trace.length; i += MAX_CHUNK - CHUNK_OVERLAP) {
    chunks.push(trace.slice(i, i + MAX_CHUNK));
    if (i + MAX_CHUNK >= trace.length) break;
  }
  return chunks;
}

/**
 * Map-match a first-party GPS trace against the vehicle's OWN profile engine
 * and extract per-edge speeds from parallel annotation arrays
 * (nodes[N], duration[N-1], distance[N-1]). Clamps 3–100 km/h; discards
 * matches with confidence < 0.6.
 */
export async function extractSegmentSpeeds(
  gpsTrace: GpsPing[],
  vehicleType: VehicleType,
  fetcher: MatchFetcher = defaultFetcher,
): Promise<EdgeSpeedRecord[]> {
  const moving = filterStationaryHalts(gpsTrace);
  if (moving.length < MIN_MATCH_POINTS) return [];
  const port = ENGINE_PORT[vehicleType];
  const todBucket = resolveTodBucket(moving[0].timestamp);
  const records: EdgeSpeedRecord[] = [];

  for (const chunk of chunkTrace(moving)) {
    if (chunk.length < MIN_MATCH_POINTS) continue;
    const coords = chunk.map((p) => `${p.lng},${p.lat}`).join(';');
    const timestamps = chunk.map((p) => Math.round(p.timestamp / 1000)).join(';');
    const url =
      `http://localhost:${port}/match/v1/driving/${coords}` +
      `?timestamps=${timestamps}&annotations=nodes,duration,distance&geometries=geojson`;
    let data: MatchResponse;
    try {
      data = await fetcher(url, MATCH_TIMEOUT_MS);
    } catch {
      continue;
    }
    if (data.code !== 'Ok' || !Array.isArray(data.matchings)) continue;

    for (const match of data.matchings) {
      if ((match.confidence ?? 1) < MIN_CONFIDENCE) continue;
      for (const leg of match.legs ?? []) {
        const nodes = leg.annotation?.nodes ?? [];
        const durations = leg.annotation?.duration ?? [];
        const distances = leg.annotation?.distance ?? [];
        // F-004-2: per-edge values from parallel arrays.
        for (let i = 0; i < nodes.length - 1 && i < durations.length; i++) {
          const t = durations[i];
          const d = distances[i] ?? 0;
          if (!(t > 0) || !(d > 0)) continue;
          const raw = (d / t) * 3.6;
          const speedKmh = Math.round(Math.min(SPEED_CLAMP_MAX, Math.max(SPEED_CLAMP_MIN, raw)));
          records.push({ fromNode: nodes[i], toNode: nodes[i + 1], speedKmh, todBucket, vehicleType });
        }
      }
    }
  }
  return records;
}

/** Bucket-boundary CSV payload for osrm-customize --segment-speed-file. */
export function generateSpeedCsv(records: EdgeSpeedRecord[]): string {
  const lines = ['# from_osm_node,to_osm_node,speed'];
  for (const r of records) {
    lines.push(`${r.fromNode},${r.toNode},${r.speedKmh}`);
  }
  return lines.join('\n') + '\n';
}
