/**
 * fraudFilterWorker.ts — Stage 012 section 5 fraud filter pipeline.
 *
 * Evaluates a completed-trip vote through L1–L5 BEFORE it reaches
 * dpmaps.trip_evidence_ledger (append-only). L3 Redis counters
 * (fraud:rider_week:*, fraud:pair_30d:*) are NON-DURABLE by design —
 * Stage 009's publication SQL recounts from the ledger as the durable
 * enforcement; the landmark-layer recount constant lives in
 * services/antiManipulationFilter.ts (PAIR_RECOUNT_SQL).
 *
 * INVARIANT (F-012-1/2): recordInvalidation writes EXCLUSIVELY to
 * dpmaps.ledger_invalidations via ON CONFLICT DO NOTHING. There are ZERO
 * UPDATE statements against dpmaps.trip_evidence_ledger anywhere in this
 * pipeline (grep-enforced by the audit suite).
 *
 * Zero infra deps: device memory, counters, quarantine sets and the DB
 * sink arrive injected. Production wiring (ioredis/Pool) is OUT of scope
 * for this module — same pattern as Stages 004–011.
 */

import {
  assertNoPaidPlacement,
  clusterPairAllowed,
  countInWindow,
  deviceVoteKey,
  evaluateTelemetry,
  INVALIDATION_REASONS,
  InvalidationReason,
  isBrandCollision,
  isQuorumEligible,
  isTimeBurst,
  isVelocityBurst,
  isWeeklyVolumeHold,
  isYoungSwarm,
  landmarkPairWeight,
  QUARANTINE_CLUSTERS_SET,
  QUARANTINE_TTL_S,
  RECORD_INVALIDATION_SQL,
  riderClusterWeight,
  TripTelemetry,
} from '../services/antiManipulationFilter';

/** Minimal injected device-memory surface (fraud:device:<hash>:<cluster>, 30 d TTL). */
export interface DeviceMemory {
  has(key: string): boolean | Promise<boolean>;
  remember(key: string, ttlSeconds: number): void | Promise<void>;
}

/** Minimal injected sliding-window counter surface (TTL-on-first-add). */
export interface FraudCounters {
  incr(key: string): number | Promise<number>;
  expireOnce(key: string, seconds: number): void | Promise<void>;
}

/** Minimal injected quarantine-set surface. */
export interface QuarantineSets {
  add(key: string, member: string): void | Promise<void>;
  expireOnce(key: string, seconds: number): void | Promise<void>;
  has(key: string, member: string): boolean | Promise<boolean>;
}

/** Minimal injected invalidation sink (side table only). */
export interface InvalidationSink {
  query(text: string, params?: unknown[]): unknown | Promise<unknown>;
}

export interface RawTripVote {
  telemetry: TripTelemetry;
  deviceHash: string;
  clusterId: string;
  accountAgeDays: number;
  phoneVerified: boolean;
  riderPriorVoteTsMs: number[];
  pairPriorVotes30d: number;
  landmarkPairTripNumber: number;
  youngVotesInCluster: number;
  totalVotesInCluster: number;
  cellVotes48h: number;
  cellBaseline48h: number;
  clusterVotesIn48h: number;
  clusterTotalVotes: number;
  weekVolume: number;
  trailing4wkAvgVolume: number;
  searchParams: Record<string, unknown>;
  aliasText?: string;
  rivalMerchantNames?: string[];
  nowMs: number;
}

export type FilterVerdict = 'accept' | 'reject' | 'quarantine_hold';

export interface FilterResult {
  verdict: FilterVerdict;
  reasons: string[];
  /** Landmark-layer counted weight signal (1, 0.1, or 0). */
  pairWeight: number;
}

export interface WorkerDeps {
  devices: DeviceMemory;
  counters: FraudCounters;
  quarantine: QuarantineSets;
  invalidate: InvalidationSink;
}

/**
 * Pre-ledger evaluation. Order: L1 → L2 → L3 → L4 → L5.
 * A quarantine_hold parks the vote pending the monthly audit cycle —
 * it is neither counted nor invalidated here.
 */
export async function evaluateTripVote(deps: WorkerDeps, trip: RawTripVote): Promise<FilterResult> {
  const reasons: string[] = [];

  // L1 — telemetry feasibility.
  const l1 = evaluateTelemetry(trip.telemetry);
  if (l1.length > 0) {
    return { verdict: 'reject', reasons: l1.map((r) => `L1:${r}`), pairWeight: 0 };
  }

  // L2 — identity entropy.
  const dkey = deviceVoteKey(trip.deviceHash, trip.clusterId);
  if (await deps.devices.has(dkey)) {
    return { verdict: 'reject', reasons: ['L2:device-duplicate-30d'], pairWeight: 0 };
  }
  if (!isQuorumEligible(trip.accountAgeDays, trip.phoneVerified)) {
    reasons.push('L2:young-or-unverified-note');
  }

  // L3 — algorithmic caps.
  if (riderClusterWeight(trip.riderPriorVoteTsMs, trip.nowMs) === 0) {
    return { verdict: 'reject', reasons: ['L3:rider-cluster-cap'], pairWeight: 0 };
  }
  if (!clusterPairAllowed(trip.pairPriorVotes30d)) {
    return { verdict: 'reject', reasons: ['L3:cluster-pair-cap-30d'], pairWeight: 0 };
  }
  const pw = landmarkPairWeight(trip.landmarkPairTripNumber);
  if (pw.weight === 0) {
    return { verdict: 'reject', reasons: ['L3:landmark-pair-cap-90d', 'audit-flag'], pairWeight: 0 };
  }

  // L4 — swarm & velocity anomalies.
  const quarantined: string[] = [];
  if (isYoungSwarm(trip.youngVotesInCluster, trip.totalVotesInCluster)) quarantined.push('L4:young-swarm');
  if (isVelocityBurst(trip.cellVotes48h, trip.cellBaseline48h)) quarantined.push('L4:velocity-burst');
  if (isWeeklyVolumeHold(trip.weekVolume, trip.trailing4wkAvgVolume)) quarantined.push('L4:weekly-volume-hold');
  if (quarantined.length > 0) {
    await deps.quarantine.add(QUARANTINE_CLUSTERS_SET, trip.clusterId);
    await deps.quarantine.expireOnce(QUARANTINE_CLUSTERS_SET, QUARANTINE_TTL_S);
    return { verdict: 'quarantine_hold', reasons: quarantined, pairWeight: pw.weight };
  }
  if (isTimeBurst(trip.clusterVotesIn48h, trip.clusterTotalVotes)) {
    reasons.push('L4:time-burst-requires-2-weeks');
  }

  // L5 — merchant integrity (structural; throws on violation).
  try {
    assertNoPaidPlacement(trip.searchParams);
  } catch (err) {
    return { verdict: 'reject', reasons: [`L5:${(err as Error).message}`], pairWeight: 0 };
  }
  if (trip.aliasText && isBrandCollision(trip.aliasText, trip.rivalMerchantNames ?? [])) {
    return { verdict: 'reject', reasons: ['L5:brand-collision-alias'], pairWeight: 0 };
  }

  // Passed all layers: consume the device single-use key.
  // (deps.counters is reserved for production Redis TTL counters —
  //  fraud:rider_week:*, fraud:pair_30d:* — non-durable by design; the
  //  audit exercises the history-based pure functions instead.)
  await deps.devices.remember(dkey, 30 * 86400);
  return { verdict: 'accept', reasons, pairWeight: pw.weight };
}

/**
 * Side-table invalidation ONLY (F-012-1/2). The ledger is append-only:
 * this function contains no UPDATE against trip_evidence_ledger, and the
 * audit suite grep-enforces that across both Stage 012 modules.
 */
export async function recordInvalidation(
  db: InvalidationSink,
  ledgerId: number,
  createdAt: Date,
  reason: InvalidationReason,
  invalidatedBy: string
): Promise<void> {
  if (!(INVALIDATION_REASONS as readonly string[]).includes(reason)) {
    throw new Error(`STAGE012: unknown invalidation reason "${reason}"`);
  }
  await db.query(RECORD_INVALIDATION_SQL, [ledgerId, createdAt, reason, invalidatedBy]);
}

/** Re-export for worker wiring (single import surface). */
export { QUARANTINE_CLUSTERS_SET, QUARANTINE_TTL_S, RECORD_INVALIDATION_SQL };
