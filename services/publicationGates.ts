/**
 * publicationGates.ts — Stage 009 §5 six minimum publication thresholds.
 *
 * Evidence basis: dpmaps.v_active_cluster_evidence (anchor-key dedup via
 * dpmaps.active_dedup_key, invalidations excluded, NO HAVING filter —
 * runner-up cells preserved for Gate 5). All weights are read-time decayed
 * (dpmaps.calculate_decayed_weight, λ = ln2/45); production aggregates
 * sum_weights / sum_weight_sq per cell from that view and feeds them here.
 *
 * Gate 6 (F-009-3, PROVED): at p = 0.70, Wilson W_lower > 0.50 ⟺ n_eff ≥ 25.
 * The "≥ 23" claim is mathematically false (0.4957 at 23; 0.49996 at 24)
 * and is rejected. The gate evaluates the formula numerically per
 * candidate — the n_eff ≥ 25 boundary is the analytic consequence at
 * exactly 70 % share, not a hard-coded count.
 *
 * Gate 5 (F-009-2): anchor CELL share vs best runner-up CELL share from the
 * unfiltered view. Single-cell candidates: implied by Gate 4 (margin ≥ 0.40
 * whenever share ≥ 0.70 — retained as a hard invariant that binds if the
 * admin ever lowers Gate 4 below 0.60). Multi-cell: binding (TC-009-14).
 *
 * Zero dependencies. Pure functions — the audit executes them directly.
 */

export const GATE_MIN_RIDERS = 15;
export const GATE_MIN_DRIVERS = 5;
export const GATE_MIN_WEEKS = 3;
export const GATE_MIN_SHARE = 0.7;
export const GATE_MIN_MARGIN = 0.2;
export const GATE_WILSON_FLOOR = 0.5;
export const GATE_WILSON_Z = 1.96;
export const GATE_MAX_DRIVER_SHARE = 0.25;

export interface GateLeaderInput {
  distinct_riders: number;
  distinct_drivers: number;
  active_weeks: number;
  /** Decayed-weight sum over the candidate's CellSet (post-consolidation). */
  cluster_weighted_votes: number;
  /** Decayed-weight sum over the whole query cluster. */
  total_query_weighted_votes: number;
  /** Decayed sum-of-squares over the whole query cluster (Kish denominator). */
  total_query_sum_w_sq: number;
  /** Anchor-cell decayed share of the query cluster (Gate 5 basis). */
  anchor_cell_share: number;
  /** Max single-driver share of the cluster's total vote count. */
  max_driver_share: number;
}

export interface GateVerdict {
  passed: boolean;
  gate_failures: string[];
  w_lower: number;
  n_eff: number;
  margin: number;
  vote_share: number;
}

/**
 * Kish effective sample size + 95 % Wilson lower bound (plan §5.6,
 * formulation of record, two-sided z = 1.96).
 */
export function computeKishWilsonLowerBound(
  weightedVotes: number,
  totalWeightedVotes: number,
  totalSumSqWeights: number,
  z: number = GATE_WILSON_Z,
): { w_lower: number; n_eff: number; p: number } {
  if (totalWeightedVotes <= 0 || totalSumSqWeights <= 0) return { w_lower: 0, n_eff: 0, p: 0 };
  const n_eff = (totalWeightedVotes * totalWeightedVotes) / totalSumSqWeights;
  const p = weightedVotes / totalWeightedVotes;
  if (!(n_eff >= 1)) return { w_lower: 0, n_eff, p };
  const zSq = z * z;
  const denominator = 1 + zSq / n_eff;
  const center = p + zSq / (2 * n_eff);
  const spread =
    z * Math.sqrt(Math.max(0, (p * (1 - p)) / n_eff + zSq / (4 * n_eff * n_eff)));
  const w_lower = (center - spread) / denominator;
  return { w_lower: Math.max(0, Math.min(1, w_lower)), n_eff, p };
}

/**
 * Evaluates Gates 1–6 for one consolidated candidate. runnerUpCellShare is
 * the best per-cell share OUTSIDE the candidate's CellSet from
 * v_active_cluster_evidence (null = no rival cell observed).
 */
export function evaluateCandidateGates(
  leader: GateLeaderInput,
  runnerUpCellShare: number | null,
): GateVerdict {
  const failures: string[] = [];
  if (leader.distinct_riders < GATE_MIN_RIDERS) {
    failures.push(`Gate 1: riders ${leader.distinct_riders} < ${GATE_MIN_RIDERS}`);
  }
  if (leader.distinct_drivers < GATE_MIN_DRIVERS) {
    failures.push(`Gate 2: drivers ${leader.distinct_drivers} < ${GATE_MIN_DRIVERS}`);
  }
  if (leader.max_driver_share > GATE_MAX_DRIVER_SHARE) {
    failures.push(
      `Gate 2 cap: driver share ${(leader.max_driver_share * 100).toFixed(1)}% > 25%`,
    );
  }
  if (leader.active_weeks < GATE_MIN_WEEKS) {
    failures.push(`Gate 3: weeks ${leader.active_weeks} < ${GATE_MIN_WEEKS}`);
  }

  if (!(leader.total_query_weighted_votes > 0)) {
    failures.push('Gate 4: zero total query weight');
    return {
      passed: false, gate_failures: failures, w_lower: 0, n_eff: 0, margin: 0, vote_share: 0,
    };
  }
  const voteShare = leader.cluster_weighted_votes / leader.total_query_weighted_votes;
  if (voteShare < GATE_MIN_SHARE) {
    failures.push(`Gate 4: share ${(voteShare * 100).toFixed(2)}% < 70%`);
  }
  // Integrity (TC-009-05): cell shares must not sum past 100 %.
  if (leader.anchor_cell_share + (runnerUpCellShare ?? 0) > 1 + 1e-9) {
    failures.push(
      `Integrity: anchor ${leader.anchor_cell_share} + runner-up ${runnerUpCellShare} > 1`,
    );
  }

  // Gate 5 (F-009-2): anchor cell vs best rival cell.
  const margin = runnerUpCellShare === null ? 1 : leader.anchor_cell_share - runnerUpCellShare;
  if (margin < GATE_MIN_MARGIN) {
    failures.push(`Gate 5: cell margin ${(margin * 100).toFixed(2)} < 20 pts`);
  }

  const { w_lower, n_eff } = computeKishWilsonLowerBound(
    leader.cluster_weighted_votes,
    leader.total_query_weighted_votes,
    leader.total_query_sum_w_sq,
  );
  if (w_lower <= GATE_WILSON_FLOOR) {
    failures.push(
      `Gate 6: W_lower ${w_lower.toFixed(4)} <= 0.5 (n_eff ${n_eff.toFixed(1)})`,
    );
  }

  return {
    passed: failures.length === 0,
    gate_failures: failures,
    w_lower: +w_lower.toFixed(4),
    n_eff: +n_eff.toFixed(2),
    margin: +margin.toFixed(4),
    vote_share: +voteShare.toFixed(4),
  };
}
