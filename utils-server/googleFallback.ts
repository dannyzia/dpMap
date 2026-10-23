/**
 * googleFallback.ts — Stage 005 §7 commercial Google failover guard.
 *
 * Two independent tripwires sit in front of every Google route call:
 *   1. Spend/volume caps: ≤ 500 queries per rolling 15-min window AND a
 *      configurable daily spend ceiling (both [ESTIMATE] starting defaults,
 *      admin-configurable via system_config). Breach → fall through to the
 *      Haversine floor for the rest of the window/day.
 *   2. Error circuit: error rate > 15% [ESTIMATE] over the window opens the
 *      breaker for 15 min [ESTIMATE]; subsequent failovers drop to floor.
 * Service-tier whitelist: premium four-wheeler trips only ('sedan');
 * two-wheelers ('moto'), CNGs, and parcel are never sent to Google.
 *
 * Zero dependencies. Clock and cost accounting are injected for the audit.
 */

export const GOOGLE_WINDOW_CAP = 500; // max queries per rolling 15-min window [ESTIMATE]
export const GOOGLE_WINDOW_MS = 15 * 60_000;
export const GOOGLE_ERROR_RATE_THRESHOLD = 0.15; // [ESTIMATE]
export const GOOGLE_OPEN_MS = 15 * 60_000; // breaker open duration [ESTIMATE]
export const GOOGLE_MIN_WINDOW_SAMPLES = 10; // don't trip on tiny samples [ESTIMATE]

/** Google-served tiers. Everything else bypasses Google to the floor. */
const GOOGLE_ALLOWED_TIERS = new Set(['sedan']);

export interface GoogleGuardConfig {
  windowCap?: number;
  windowMs?: number;
  errorRateThreshold?: number;
  openMs?: number;
  /** Abstract spend units per query; pricing UNVERIFIED — admin-configured. */
  costPerQueryUnits?: number;
  /** Daily ceiling in the same abstract units. */
  dailySpendCapUnits?: number;
}

type GuardState = 'CLOSED' | 'OPEN';

export class GoogleGuard {
  private state: GuardState = 'CLOSED';
  private openedAt = 0;
  private attempts: number[] = []; // window timestamps (ms)
  private failures = 0; // failures within the current window
  private samples = 0; // attempts within the current window
  private dayKey = '';
  private daySpend = 0;

  constructor(
    private readonly cfg: GoogleGuardConfig = {},
    private readonly now: () => number = Date.now,
  ) {}

  get breakerState(): GuardState {
    if (this.state === 'OPEN' && this.now() - this.openedAt >= (this.cfg.openMs ?? GOOGLE_OPEN_MS)) {
      this.state = 'CLOSED';
      this.failures = 0;
      this.samples = 0;
    }
    return this.state;
  }

  /** Tier gate first: non-whitelisted tiers never consume cap or budget. */
  static tierAllowed(tier: string): boolean {
    return GOOGLE_ALLOWED_TIERS.has(tier);
  }

  private pruneWindow(t: number): void {
    const w = this.cfg.windowMs ?? GOOGLE_WINDOW_MS;
    const cutoff = t - w;
    while (this.attempts.length > 0 && this.attempts[0] <= cutoff) this.attempts.shift();
  }

  private dayOf(t: number): string {
    return new Date(t).toISOString().slice(0, 10); // UTC day boundary
  }

  canAttempt(tier: string): { ok: boolean; reason: string } {
    if (!GoogleGuard.tierAllowed(tier)) return { ok: false, reason: 'TIER_NOT_WHITELISTED' };
    const t = this.now();
    if (this.breakerState === 'OPEN') return { ok: false, reason: 'CIRCUIT_OPEN' };
    this.pruneWindow(t);
    if (this.attempts.length >= (this.cfg.windowCap ?? GOOGLE_WINDOW_CAP)) {
      return { ok: false, reason: 'WINDOW_CAP_EXCEEDED' };
    }
    const cap = this.cfg.dailySpendCapUnits;
    if (cap !== undefined) {
      const day = this.dayOf(t);
      const spend = day === this.dayKey ? this.daySpend : 0;
      if (spend + (this.cfg.costPerQueryUnits ?? 1) > cap) {
        return { ok: false, reason: 'SPEND_CAP_EXCEEDED' };
      }
    }
    return { ok: true, reason: 'OK' };
  }

  /** Record a completed attempt; called exactly once per issued query. */
  recordAttempt(success: boolean): void {
    const t = this.now();
    this.pruneWindow(t);
    this.attempts.push(t);
    this.samples += 1;
    if (success) {
      const day = this.dayOf(t);
      if (day !== this.dayKey) {
        this.dayKey = day;
        this.daySpend = 0;
      }
      this.daySpend += this.cfg.costPerQueryUnits ?? 1;
    } else {
      this.failures += 1;
    }
    const threshold = this.cfg.errorRateThreshold ?? GOOGLE_ERROR_RATE_THRESHOLD;
    const minSamples = GOOGLE_MIN_WINDOW_SAMPLES;
    if (this.samples >= minSamples && this.failures / this.samples > threshold) {
      this.state = 'OPEN';
      this.openedAt = t;
    }
    if (this.attempts.length > (this.cfg.windowCap ?? GOOGLE_WINDOW_CAP)) {
      // Window breach trips the breaker too (failovers → floor for openMs).
      this.state = 'OPEN';
      this.openedAt = t;
    }
  }

  get windowCount(): number {
    this.pruneWindow(this.now());
    return this.attempts.length;
  }

  get daySpendUnits(): number {
    const day = this.dayOf(this.now());
    return day === this.dayKey ? this.daySpend : 0;
  }
}
