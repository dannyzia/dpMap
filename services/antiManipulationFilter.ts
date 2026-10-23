/**
 * antiManipulationFilter.ts — Stage 012 sections 3–4, 7.
 * Single formula of record for the 5-layer defensive firewall.
 *
 * Layering vs Stage 009 (services/sybilGuard.ts — NOT modified):
 * - 009 governs INGESTION cluster caps (1 vote/pair/cluster/30d).
 * - THIS module adds the LANDMARK-layer publication recount (<=2 counted
 *   trips per rider-driver pair per landmark per 90d) plus L1/L2/L4/L5 and
 *   the optional ingestion-time dampening tiers. Hard caps always win at
 *   publication time.
 *
 * All thresholds are [ESTIMATE] pending replay on live trip data, and are
 * centralized in FRAUD_THRESHOLDS so tuning never touches logic.
 * Zero dependencies. Pure functions (testable without Redis/Postgres).
 */

export const FRAUD_THRESHOLDS = {
  // L1 telemetry feasibility
  minDurationS: 120,
  minDistanceM: 200,
  maxSpeedKmh: 120,
  minBreadcrumbs: 20,
  minSpeedVariance: 0.05, // m^2/s^2; applies over trips > 120 s
  maxDropoffSnapM: 35,
  // L2 identity entropy
  deviceVoteWindowDays: 30,
  minAccountAgeDaysForQuorum: 14,
  // L3 caps (formula of record)
  riderVotesPerWeek: 1,
  riderVotesPer90d: 3,
  clusterPairVotesPer30d: 1,
  landmarkPairTripsPer90d: 2,
  driverCohortMaxShare: 0.25,
  // L4 swarm / velocity
  youngAccountSwarmRatio: 0.4,
  velocityMultiplier: 5,
  velocityWindowH: 48,
  velocityFloorVotes: 10,
  timeBurstShare: 0.6,
  timeBurstWindowH: 48,
  timeBurstExtraWeeks: 2,
  weeklyVolumeMultiplier: 3,
  // Trust
  quorumMinAccountAgeDays: 14,
} as const;

/** Redis keys owned by this stage. */
export const QUARANTINE_CLUSTERS_SET = 'dpmaps:quarantine:clusters';
export const QUARANTINE_TTL_S = 30 * 86400;
export const DEVICE_KEY_PREFIX = 'fraud:device:';

// ---------------------------------------------------------------- L1 ---
export interface TripTelemetry {
  durationS: number;
  distanceM: number;
  maxSpeedKmh: number;
  breadcrumbCount: number;
  /** Variance of per-second speeds, m^2/s^2. */
  speedVariance: number;
  /** Drop-off snap distance to a drivable edge, meters. */
  dropoffSnapM: number;
}

export type L1RejectReason =
  | 'too_short'
  | 'too_close'
  | 'too_fast'
  | 'too_few_breadcrumbs'
  | 'emulated_no_variance'
  | 'off_network_dropoff';

/**
 * L1 telemetry feasibility. Returns the list of failures (empty = pass).
 * The variance gate applies only over trips > 120 s (emulator signature:
 * Var(v) <= 0.05 with sustained motion).
 */
export function evaluateTelemetry(t: TripTelemetry): L1RejectReason[] {
  const out: L1RejectReason[] = [];
  if (!(t.durationS >= FRAUD_THRESHOLDS.minDurationS)) out.push('too_short');
  if (!(t.distanceM >= FRAUD_THRESHOLDS.minDistanceM)) out.push('too_close');
  if (!(t.maxSpeedKmh <= FRAUD_THRESHOLDS.maxSpeedKmh)) out.push('too_fast');
  if (!(t.breadcrumbCount >= FRAUD_THRESHOLDS.minBreadcrumbs)) out.push('too_few_breadcrumbs');
  if (t.durationS > FRAUD_THRESHOLDS.minDurationS && !(t.speedVariance > FRAUD_THRESHOLDS.minSpeedVariance)) {
    out.push('emulated_no_variance');
  }
  if (!(t.dropoffSnapM <= FRAUD_THRESHOLDS.maxDropoffSnapM)) out.push('off_network_dropoff');
  return out;
}

// ---------------------------------------------------------------- L2 ---
/** L2 device key: 1 vote/device/cluster/30d. */
export function deviceVoteKey(deviceHash: string, clusterId: string): string {
  return `${DEVICE_KEY_PREFIX}${deviceHash}:${clusterId}`;
}

/** Accounts < 14 d cannot satisfy quorum (phone verification decided upstream). */
export function isQuorumEligible(accountAgeDays: number, phoneVerified: boolean): boolean {
  return phoneVerified && accountAgeDays >= FRAUD_THRESHOLDS.minAccountAgeDaysForQuorum;
}

// ---------------------------------------------------------------- L3 ---
/** Count prior timestamps within a trailing window (first-seen-wins ordering). */
export function countInWindow(priorTsMs: number[], nowMs: number, windowDays: number): number {
  const cutoff = nowMs - windowDays * 86400000;
  let n = 0;
  for (const ts of priorTsMs) if (ts > cutoff && ts <= nowMs) n++;
  return n;
}

/**
 * Per-rider cluster cap: 1 counted vote per 7 d, at most 3 per 90 d.
 * Returns the counted weight (1 or 0).
 */
export function riderClusterWeight(priorVoteTsMs: number[], nowMs: number): number {
  if (countInWindow(priorVoteTsMs, nowMs, 7) >= FRAUD_THRESHOLDS.riderVotesPerWeek) return 0;
  if (countInWindow(priorVoteTsMs, nowMs, 90) >= FRAUD_THRESHOLDS.riderVotesPer90d) return 0;
  return 1;
}

/** Driver cohort cap: no driver holds more than 25% of cluster votes. */
export function isDriverCohortDisqualified(driverTrips: number, totalTrips: number): boolean {
  if (totalTrips <= 0) throw new Error('STAGE012-L3: zero-denominator cluster vote count');
  return driverTrips / totalTrips > FRAUD_THRESHOLDS.driverCohortMaxShare;
}

/** Cluster-layer pair cap (009 §3.3): 1 counted vote per pair per cluster per 30 d. */
export function clusterPairAllowed(priorPairVotes30d: number): boolean {
  return priorPairVotes30d < FRAUD_THRESHOLDS.clusterPairVotesPer30d;
}

export interface LandmarkPairOutcome {
  /** Publication-time counted weight for this trip number. */
  weight: number;
  /** Trips 3–5: dampened (ingestion signal); trips 6+: audit flag. [ESTIMATE] */
  dampened: boolean;
  auditFlag: boolean;
}

/**
 * Landmark-layer pair weight (F-012-2/3). `tripNumber` is 1-based within
 * (rider, driver, landmark, 90 d). Hard cap (<=2 counted) always wins at
 * publication; the 0.1 tier is an ingestion-time partial-evidence signal.
 */
export function landmarkPairWeight(tripNumber: number): LandmarkPairOutcome {
  if (tripNumber <= FRAUD_THRESHOLDS.landmarkPairTripsPer90d) {
    return { weight: 1, dampened: false, auditFlag: false };
  }
  if (tripNumber <= 5) return { weight: 0.1, dampened: true, auditFlag: false };
  return { weight: 0, dampened: true, auditFlag: true };
}

// ---------------------------------------------------------------- L4 ---
/** Young-account swarm: ratio of young-account votes above 40% → quarantine. */
export function isYoungSwarm(youngVotes: number, totalVotes: number): boolean {
  if (totalVotes <= 0) return false;
  return youngVotes / totalVotes > FRAUD_THRESHOLDS.youngAccountSwarmRatio;
}

/**
 * F-012-4 velocity: votes(cell, 48h) > 5 × baseline_48h AND >= 10 floor.
 * Windows must be unit-matched (same 48 h width). The floor stops empty
 * cells self-triggering on their first votes.
 */
export function isVelocityBurst(votes48h: number, baseline48h: number): boolean {
  return votes48h >= FRAUD_THRESHOLDS.velocityFloorVotes && votes48h > FRAUD_THRESHOLDS.velocityMultiplier * baseline48h;
}

/** Time-burst: > 60% of votes inside a 48 h span → +2 weeks traffic required. */
export function isTimeBurst(votesIn48h: number, totalVotes: number): boolean {
  if (totalVotes <= 0) return false;
  return votesIn48h / totalVotes > FRAUD_THRESHOLDS.timeBurstShare;
}

/** Weekly volume > 3× trailing-4-week average → hold for review. */
export function isWeeklyVolumeHold(thisWeek: number, trailing4wkAvg: number): boolean {
  return thisWeek > FRAUD_THRESHOLDS.weeklyVolumeMultiplier * trailing4wkAvg;
}

// ---------------------------------------------------------------- L5 ---
const PAID_PLACEMENT_PARAMS = ['promoted_poi', 'bid_rank', 'commercial_boost'];

/**
 * L5 merchant integrity: the search/ranking surface has ZERO paid-placement
 * parameters. Throws on any commercial-boost key (structural CI gate).
 */
export function assertNoPaidPlacement(params: Record<string, unknown>): void {
  for (const p of PAID_PLACEMENT_PARAMS) {
    if (params[p] !== undefined && params[p] !== null) {
      throw new Error(`STAGE012-L5: paid-placement parameter "${p}" is forbidden on organic ranking`);
    }
  }
}

/** Brand-collision alias check: an alias may not carry a rival merchant name. */
export function isBrandCollision(aliasText: string, rivalMerchantNames: string[]): boolean {
  const lower = aliasText.toLowerCase();
  return rivalMerchantNames.some((m) => m && lower.includes(m.toLowerCase()));
}

// ------------------------------------------------- Invalidation ----
export const INVALIDATION_REASONS = [
  'fraud_sybil',
  'burst_suppression',
  'collusion',
  'audit_purge',
  'quarantine',
  'driver_bias',
] as const;
export type InvalidationReason = (typeof INVALIDATION_REASONS)[number];

/** Work-order vocabulary crosswalk (F-012-1). */
export const WORK_ORDER_CROSSWALK: Record<string, InvalidationReason> = {
  sybil_burst_fraud: 'fraud_sybil',
  sybil_burst_suppression: 'burst_suppression',
  collusion_ring: 'collusion',
  admin_manual: 'audit_purge',
  driver_bias: 'driver_bias',
};

/** Side-table insert ONLY — the ledger is append-only, never UPDATEd. */
export const RECORD_INVALIDATION_SQL =
  'INSERT INTO dpmaps.ledger_invalidations (ledger_id, created_at, reason, invalidated_by)\n' +
  'VALUES ($1, $2, $3, $4) ON CONFLICT (ledger_id, created_at) DO NOTHING';

/**
 * Landmark-layer publication recount pre-check (012-owned rule, runs inside
 * Stage 009's gate evaluation): excludes surplus pair-trips over the
 * candidate CellSet from the trailing 90 d. Trips 3+ per pair contribute 0.
 */
export const PAIR_RECOUNT_SQL =
  'WITH pair_trips AS (\n' +
  '  SELECT lp.pseudonym_hash AS rider, lp.driver_pseudonym_hash AS driver,\n' +
  '         tel.id, tel.created_at, tel.initial_weight,\n' +
  '         ROW_NUMBER() OVER (\n' +
  '           PARTITION BY lp.pseudonym_hash, lp.driver_pseudonym_hash\n' +
  '           ORDER BY tel.created_at) AS rn\n' +
  '  FROM dpmaps.trip_evidence_ledger tel\n' +
  '  JOIN dpmaps.ledger_pseudonyms lp\n' +
  '    ON lp.ledger_id = tel.id AND lp.created_at = tel.created_at\n' +
  '  JOIN dpmaps.active_dedup_key adk ON lp.key_id = adk.key_id\n' +
  '  LEFT JOIN dpmaps.ledger_invalidations li\n' +
  '    ON li.ledger_id = tel.id AND li.created_at = tel.created_at\n' +
  '  WHERE li.ledger_id IS NULL\n' +
  "    AND tel.h3_res10 = ANY($1::text[])\n" +
  "    AND tel.created_at >= NOW() - INTERVAL '90 days'\n" +
  ')\n' +
  'SELECT * FROM pair_trips WHERE rn <= 2;';

/** Invalidation-set selector (read-only) feeding recordInvalidation per row. */
export const INVALIDATION_SET_SELECT_SQL =
  'SELECT tel.id AS ledger_id, tel.created_at\n' +
  'FROM dpmaps.trip_evidence_ledger tel\n' +
  'JOIN dpmaps.ledger_pseudonyms lp ON lp.ledger_id = tel.id AND lp.created_at = tel.created_at\n' +
  'JOIN unnest($1::text[]) pp(phash) ON pp.phash = lp.pseudonym_hash\n' +
  'WHERE NOT EXISTS (SELECT 1 FROM dpmaps.ledger_invalidations li\n' +
  '                  WHERE li.ledger_id = tel.id AND li.created_at = tel.created_at);';
