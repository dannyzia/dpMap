/**
 * osrmRoutingClient.ts — Stage 004 §8 OSRM client (owned by Stage 004;
 * the dispatch fallback waterfall itself is Stage 005).
 *
 * Canonical contracts (F-004-3): 300 ms request timeout; 3-strike circuit
 * breaker (CLOSED → OPEN after 3 consecutive 5xx/timeouts → HALF_OPEN after
 * the reset window; fast-fail while OPEN). No vendor coordinates, place IDs,
 * or quotes anywhere in this client (Hard Rule 1).
 */

export type VehicleType = 'car' | 'bike' | 'cng';
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export const REQUEST_TIMEOUT_MS = 300; // canonical OSRM contract
export const BREAKER_STRIKES = 3;
export const BREAKER_RESET_MS = 30_000; // [ESTIMATE] half-open probe window

const ENGINE_PORT: Record<VehicleType, number> = { car: 5001, bike: 5002, cng: 5003 };

export interface RouteResult {
  durationS: number;
  distanceM: number;
}

export type RouteFetcher = (url: string, timeoutMs: number) => Promise<{ status: number; body: RouteResponse }>;
export interface RouteResponse {
  code?: string;
  routes?: { duration?: number; distance?: number }[];
}

const defaultFetcher: RouteFetcher = async (url, timeoutMs) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return { status: res.status, body: (await res.json()) as RouteResponse };
  } finally {
    clearTimeout(t);
  }
};

export class OsrmCircuitOpenError extends Error {
  constructor(public vehicle: VehicleType) {
    super(`OSRM circuit OPEN for ${vehicle}: fast-fail, use Stage 005 fallback`);
    this.name = 'OsrmCircuitOpenError';
  }
}

export class OsrmRoutingClient {
  private failures = 0;
  private state: BreakerState = 'CLOSED';
  private openedAt = 0;
  constructor(
    private readonly vehicle: VehicleType,
    private readonly fetcher: RouteFetcher = defaultFetcher,
    private readonly now: () => number = Date.now,
  ) {}

  get breakerState(): BreakerState {
    if (this.state === 'OPEN' && this.now() - this.openedAt >= BREAKER_RESET_MS) {
      this.state = 'HALF_OPEN';
    }
    return this.state;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  private recordSuccess(): void {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  private recordFailure(): void {
    this.failures += 1;
    if (this.failures >= BREAKER_STRIKES) {
      this.state = 'OPEN';
      this.openedAt = this.now();
    }
  }

  /** Route via the vehicle's own engine. Throws on timeout/5xx; fast-fails while OPEN. */
  async route(origin: { lat: number; lng: number }, dest: { lat: number; lng: number }): Promise<RouteResult | null> {
    if (this.breakerState === 'OPEN') throw new OsrmCircuitOpenError(this.vehicle);
    const port = ENGINE_PORT[this.vehicle];
    const url =
      `http://localhost:${port}/route/v1/driving/${origin.lng},${origin.lat};${dest.lng},${dest.lat}` +
      `?overview=false&annotations=false`;
    let res: { status: number; body: RouteResponse };
    try {
      res = await this.fetcher(url, REQUEST_TIMEOUT_MS);
    } catch {
      this.recordFailure(); // timeout / network error
      return null;
    }
    if (res.status >= 500) {
      this.recordFailure();
      return null;
    }
    const first = res.body?.routes?.[0];
    if (res.body?.code !== 'Ok' || first === undefined) {
      // NoRoute (4xx-class): engine healthy, don't trip the breaker.
      return null;
    }
    this.recordSuccess();
    return { durationS: first.duration ?? 0, distanceM: first.distance ?? 0 };
  }
}

// ---------- Learned multiplicative ETA correction (§6.6) ----------

export interface EvalSample {
  actual_duration_s: number;
  osrm_duration_s: number;
}

export const ETA_MIN_SAMPLES = 30; // [ESTIMATE]
export const ETA_K_MIN = 0.5; // [ESTIMATE]
export const ETA_K_MAX = 2.0; // [ESTIMATE]

/** Median(actual/osrm); 1.0 when fewer than 30 samples; clamped to [0.5, 2.0]. */
export function calculateEtaMultiplier(samples: EvalSample[]): number {
  if (samples.length < ETA_MIN_SAMPLES) return 1.0;
  const ratios = samples
    .filter((s) => s.osrm_duration_s > 0 && s.actual_duration_s >= 0)
    .map((s) => s.actual_duration_s / s.osrm_duration_s)
    .sort((a, b) => a - b);
  if (ratios.length === 0) return 1.0;
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 === 1 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  return Math.min(ETA_K_MAX, Math.max(ETA_K_MIN, median));
}

/** T̂ = k · T_osrm — read-time correction, zero write amplification. */
export function getCorrectedEta(rawOsrmDurationS: number, multiplier: number): number {
  return multiplier * rawOsrmDurationS;
}

// ---------- Relative cutover gates (§8.3; never flat minutes) ----------

export interface GateSample {
  pred_duration_s: number;
  actual_duration_s: number;
  pred_distance_m: number;
  actual_distance_m: number;
}

const pct = (pred: number, actual: number): number => (Math.abs(pred - actual) / actual) * 100;

/** e_T = |T_pred − T_actual| / T_actual × 100%. */
export function relativeTimeError(s: GateSample): number {
  if (!(s.actual_duration_s > 0)) throw new Error('relativeTimeError: actual_duration_s must be > 0');
  return pct(s.pred_duration_s, s.actual_duration_s);
}

/** e_D = |D_pred − D_actual| / D_actual × 100%. */
export function relativeDistanceError(s: GateSample): number {
  if (!(s.actual_distance_m > 0)) throw new Error('relativeDistanceError: actual_distance_m must be > 0');
  return pct(s.pred_distance_m, s.actual_distance_m);
}

const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error('median: empty input');
  const s = sorted(xs);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) throw new Error('percentile: empty input');
  const s = sorted(xs);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

export interface Gate1Verdict {
  medianET: number;
  p95ET: number;
  medianED: number;
  corridorOverlapPct: number;
  pass: boolean;
}

/** Gate 1 → primary: median e_T ≤ 12%, p95 e_T ≤ 25%, median e_D ≤ 3%, overlap ≥ 85%. */
export function evaluateGate1(samples: GateSample[], corridorOverlapPct: number): Gate1Verdict {
  const eT = samples.map(relativeTimeError);
  const eD = samples.map(relativeDistanceError);
  const v: Gate1Verdict = {
    medianET: median(eT),
    p95ET: percentile(eT, 95),
    medianED: median(eD),
    corridorOverlapPct,
    pass: false,
  };
  v.pass = v.medianET <= 12 && v.p95ET <= 25 && v.medianED <= 3 && corridorOverlapPct >= 85;
  return v;
}
