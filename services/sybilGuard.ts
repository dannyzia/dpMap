/**
 * sybilGuard.ts — Stage 009 §3.3 Sybil & collusion resistance.
 *
 * Caps (concept paper §12.1, plan §3.3):
 *  1. Pairwise rider–driver cap: within 30 days, a
 *     (pseudonym_hash, driver_pseudonym_hash) pair contributes at most ONE
 *     weighted vote per query_cluster_id; later pair trips are recorded
 *     with initial_weight = 0 (audit trail, zero influence).
 *  2. Per-rider cluster cap: at most 1 counted vote per rider per query
 *     cluster per ISO week, and at most 3 counted votes per rider per
 *     cluster per 90-day window. Excess votes are logged with weight 0.
 *  3. Driver cohort cap: no driver exceeds 25 % of the cluster's total
 *     vote count (denominator = total votes, not distinct riders).
 *  4. Burst quarantine: > 60 % of a cluster's lifetime votes within 48 h
 *     holds `candidate` status and requires 2 extra weeks of traffic.
 *  5. Suppression: any coordinate/cell in dpmaps.suppressions (Redis Set
 *     dpmaps:suppression:active_place_ids — Set semantics, NOT a Bloom
 *     filter) excludes the vote/cell outright.
 *
 * Zero dependencies. Pure functions over caller-supplied vote lists —
 * production feeds rows joined exactly as v_active_cluster_evidence does
 * (ledger ⋈ ledger_pseudonyms ⋈ active_dedup_key, invalidations excluded).
 */

export const PAIR_WINDOW_DAYS = 30;
export const PAIR_MAX_COUNTED = 1;
export const RIDER_WEEKLY_CAP = 1;
export const RIDER_90D_CAP = 3;
export const WINDOW_90D_DAYS = 90;
export const DRIVER_COHORT_CAP = 0.25;
export const BURST_FRACTION = 0.6;
export const BURST_WINDOW_HOURS = 48;

export interface CountedVote {
  riderKey: string;
  driverKey: string;
  /** ISO week 'IYYY-IW' of completion. */
  isoWeek: string;
  /** Days since first vote in the evaluated set (window arithmetic). */
  dayIndex: number;
  initialWeight: number;
}

export interface CapResult {
  counted: CountedVote[];
  /** Votes logged with weight forced to 0 (audit trail, zero influence). */
  zeroWeighted: CountedVote[];
}

/**
 * Per-rider cluster cap: ≤ 1 counted vote per rider per ISO week and
 * ≤ 3 counted votes per rider per 90-day window (dayIndex < 90).
 * First-seen wins; excess → zeroWeighted (weight forced to 0 by caller).
 */
export function applyRiderCap(votes: CountedVote[]): CapResult {
  const counted: CountedVote[] = [];
  const zeroWeighted: CountedVote[] = [];
  const weeks = new Map<string, Set<string>>(); // rider -> weeks used
  const counts = new Map<string, number>(); // rider -> counted in window
  for (const v of votes) {
    if (v.dayIndex >= WINDOW_90D_DAYS) {
      zeroWeighted.push(v); // outside the evidence window entirely
      continue;
    }
    const used = weeks.get(v.riderKey) ?? new Set<string>();
    const n = counts.get(v.riderKey) ?? 0;
    if (used.has(v.isoWeek) || n >= RIDER_90D_CAP) {
      zeroWeighted.push(v);
      continue;
    }
    used.add(v.isoWeek);
    weeks.set(v.riderKey, used);
    counts.set(v.riderKey, n + RIDER_WEEKLY_CAP);
    counted.push(v);
  }
  return { counted, zeroWeighted };
}

/**
 * Pairwise rider–driver cap: at most PAIR_MAX_COUNTED (1) counted vote per
 * (rider, driver) pair per query cluster within PAIR_WINDOW_DAYS (30).
 * Later pair trips → zeroWeighted (recorded for audit, weight 0).
 */
export function applyPairCap(votes: CountedVote[]): CapResult {
  const counted: CountedVote[] = [];
  const zeroWeighted: CountedVote[] = [];
  const firstSeen = new Map<string, number>(); // pair -> dayIndex of counted vote
  for (const v of votes) {
    const k = `${v.riderKey}\u0000${v.driverKey}`;
    const seen = firstSeen.get(k);
    if (seen !== undefined && v.dayIndex - seen < PAIR_WINDOW_DAYS) {
      zeroWeighted.push(v);
      continue;
    }
    firstSeen.set(k, v.dayIndex);
    counted.push(v);
  }
  return { counted, zeroWeighted };
}

/** Driver cohort share: max_driver_trips / total_vote_count ≤ 0.25. */
export function driverCohortShare(driverTrips: number, totalVotes: number): number {
  if (!(totalVotes > 0)) throw new Error('driverCohortShare: totalVotes must be > 0');
  return driverTrips / totalVotes;
}

export function driverCohortPasses(driverTrips: number, totalVotes: number): boolean {
  return driverCohortShare(driverTrips, totalVotes) <= DRIVER_COHORT_CAP;
}

/**
 * Burst quarantine: true when more than BURST_FRACTION (60 %) of the
 * cluster's lifetime votes fall inside ANY rolling 48 h window.
 * dayIndex may be fractional (completion timestamps in days).
 */
export function isBurstQuarantined(dayIndexes: number[]): boolean {
  if (dayIndexes.length === 0) return false;
  const windowDays = BURST_WINDOW_HOURS / 24;
  const sorted = [...dayIndexes].sort((a, b) => a - b);
  let j = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (j < i) j = i;
    while (j + 1 < sorted.length && sorted[j + 1] - sorted[i] <= windowDays) j++;
    if (j - i + 1 > BURST_FRACTION * sorted.length) return true;
  }
  return false;
}

/**
 * Suppression check (Stage 011 integration): exact membership in the
 * suppression set (Redis Set semantics). Any hit excludes the cell.
 */
export function isSuppressed(cellOrPlaceId: string, suppressionSet: Set<string>): boolean {
  return suppressionSet.has(cellOrPlaceId);
}
