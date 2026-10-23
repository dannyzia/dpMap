/**
 * cutoverGateEvaluator.ts — Stage 015 §§2/4 telemetry conformance + numeric gates.
 *
 * Relative errors ONLY (never flat minutes):
 *   e_T = |T_pred − T_actual| / T_actual × 100%
 *   e_D = |D_pred − D_actual| / D_actual × 100%
 *
 * Gate ladder (F-015-3, admin-configurable via GATE_DEFAULTS):
 *   Gate 1A routing→primary: median e_D ≤ 3.0%, median e_T ≤ 12%
 *     (p95 ≤ 25%), vendor parity, corridor ≥ 85% — 3 consecutive weeks.
 *   Gate 1B search→primary: Top-1 ≥ 92%, MRR ≥ 0.88 — 3 consecutive weeks.
 *   Gate 2 →sole: median e_D ≤ 2.5%, median e_T ≤ 10% (p95 ≤ 20%),
 *     corridor ≥ 92%, Top-1 ≥ 96%, MRR ≥ 0.94, deflection > 85% —
 *     4 consecutive weeks + 24 h vendor-off rehearsal.
 * Gate placement follows the TOC/concept-paper consensus (96%/4wk +
 * deflection live at SOLE); the stricter work-order reading is available
 * as an admin override, not the default.
 *
 * Telemetry conformance: evaluators may write ONLY the Stage 003 §4.7
 * columns (exact allowlists below). order_id, pre_autocomplete_query and
 * any typed text in Tier B are refused at the builder.
 */

export const TOD_BUCKETS = ['morning_peak', 'evening_peak', 'off_peak', 'night'] as const;
export type TodBucket = (typeof TOD_BUCKETS)[number];

/** Exact Stage 003 §4.7 routing_eval_events write columns. */
export const ROUTING_EVAL_COLUMNS = [
  'vehicle_type', 'tod_bucket', 'osrm_duration_s', 'osrm_distance_m',
  'actual_driven_duration_s', 'actual_driven_distance_m',
  'vendor_duration_error_pct', 'vendor_distance_error_pct',
  'duration_error_pct', 'distance_error_pct',
  'corridor_overlap_pct', 'route_deviation_flag',
] as const;

/** Exact Stage 003 §4.7 search_eval_events write columns. */
export const SEARCH_EVAL_COLUMNS = [
  'search_success', 'exit_distance_delta_m', 'search_radius_m',
  'vendor_suggestion_selected', 'query_cluster_id', 'selected_source',
  'selected_place_id', 'latency_ms', 'result_count',
] as const;

const FORBIDDEN_EVAL_TOKENS = ['order_id', 'trip_id', 'pre_autocomplete_query', 'typed_query', 'typed_text'];

/** Refuse non-conformant column lists before they reach Postgres. */
export function assertEvalColumns(table: 'routing_eval_events' | 'search_eval_events', columns: string[]): void {
  const allowed = table === 'routing_eval_events' ? ROUTING_EVAL_COLUMNS : SEARCH_EVAL_COLUMNS;
  const allowedSet = new Set<string>([...allowed]);
  for (const c of columns) {
    if (!allowedSet.has(c)) throw new Error(`STAGE015-TIERB: column "${c}" is not in the Stage 003 §4.7 ${table} contract`);
    for (const f of FORBIDDEN_EVAL_TOKENS) {
      if (c === f || c.includes(f)) throw new Error(`STAGE015-TIERB: forbidden eval token "${f}" in column "${c}"`);
    }
  }
}

/** Relative percentage error (never flat minutes). */
export function relativeErrorPct(predicted: number, actual: number): number {
  if (!(actual > 0)) throw new Error('STAGE015: zero/negative actual in relative error');
  return (Math.abs(predicted - actual) / actual) * 100;
}

function sorted(xs: number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}
/** Median (Stage 009-style percentile_disc semantics on sorted values). */
export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error('STAGE015: empty sample for median');
  const s = sorted(xs);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** p95 (nearest-rank). */
export function p95(xs: number[]): number {
  if (xs.length === 0) throw new Error('STAGE015: empty sample for p95');
  const s = sorted(xs);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

/** Mean reciprocal rank over per-query first-relevant ranks (1-based). */
export function meanReciprocalRank(firstRelevantRanks: number[]): number {
  if (firstRelevantRanks.length === 0) throw new Error('STAGE015: empty sample for MRR');
  return firstRelevantRanks.reduce((a, r) => a + 1 / r, 0) / firstRelevantRanks.length;
}

/** Top-1 accuracy share. */
export function top1Accuracy(top1Hits: boolean[]): number {
  if (top1Hits.length === 0) throw new Error('STAGE015: empty sample for Top-1');
  return top1Hits.filter(Boolean).length / top1Hits.length;
}

/** All gate thresholds admin-configurable; defaults = plan §4. */
export const GATE_DEFAULTS = {
  gate1a: { maxMedianED: 3.0, maxMedianET: 12.0, maxP95ET: 25.0, minCorridor: 85, weeks: 3 },
  gate1b: { minTop1: 0.92, minMRR: 0.88, weeks: 3 },
  gate2: {
    maxMedianED: 2.5, maxMedianET: 10.0, maxP95ET: 20.0, minCorridor: 92,
    minTop1: 0.96, minMRR: 0.94, minDeflection: 0.85, weeks: 4,
  },
  rehearsal: { minDispatchRate: 0.995, maxWrongLocationCancels: 0.015 },
} as const;

export interface RoutingWeek {
  eD: number[];
  eT: number[];
  corridor: number[]; // overlap shares 0..1
  vendorParity: boolean;
}
export interface SearchWeek {
  top1: boolean[];
  mrrRanks: number[];
  deflectionLocalShare?: number; // Gate 2 only
}

export function evaluateGate1A(weeks: RoutingWeek[], g = GATE_DEFAULTS.gate1a): boolean {
  if (weeks.length < g.weeks) return false;
  return weeks.slice(-g.weeks).every(
    (w) =>
      w.vendorParity &&
      median(w.eD) <= g.maxMedianED &&
      median(w.eT) <= g.maxMedianET &&
      p95(w.eT) <= g.maxP95ET &&
      median(w.corridor) * 100 >= g.minCorridor
  );
}

export function evaluateGate1B(weeks: SearchWeek[], g = GATE_DEFAULTS.gate1b): boolean {
  if (weeks.length < g.weeks) return false;
  return weeks.slice(-g.weeks).every(
    (w) => top1Accuracy(w.top1) >= g.minTop1 && meanReciprocalRank(w.mrrRanks) >= g.minMRR
  );
}

export function evaluateGate2(routing: RoutingWeek[], search: SearchWeek[], g = GATE_DEFAULTS.gate2): boolean {
  if (routing.length < g.weeks || search.length < g.weeks) return false;
  const rOk = routing.slice(-g.weeks).every(
    (w) =>
      w.vendorParity &&
      median(w.eD) <= g.maxMedianED &&
      median(w.eT) <= g.maxMedianET &&
      p95(w.eT) <= g.maxP95ET &&
      median(w.corridor) * 100 >= g.minCorridor
  );
  const sOk = search.slice(-g.weeks).every(
    (w) =>
      top1Accuracy(w.top1) >= g.minTop1 &&
      meanReciprocalRank(w.mrrRanks) >= g.minMRR &&
      (w.deflectionLocalShare ?? 0) > g.minDeflection
  );
  return rOk && sOk;
}

export interface RehearsalOutcome {
  vendorHttpCalls: number;
  dispatchRate: number;
  wrongLocationCancelShare: number;
  sev1Count: number;
}

/**
 * 24 h vendor-off rehearsal monitor (Gate 2 final step). ANY vendor HTTP
 * call, dispatch < 99.5%, cancels > 1.5%, or any sev-1 ⇒ auto-revert to
 * primary (Runbook C).
 */
export function evaluateRehearsal(o: RehearsalOutcome, g = GATE_DEFAULTS.rehearsal): 'certified' | 'auto_revert_to_primary' {
  if (o.vendorHttpCalls !== 0) return 'auto_revert_to_primary';
  if (o.sev1Count !== 0) return 'auto_revert_to_primary';
  if (o.dispatchRate < g.minDispatchRate) return 'auto_revert_to_primary';
  if (o.wrongLocationCancelShare > g.maxWrongLocationCancels) return 'auto_revert_to_primary';
  return 'certified';
}
