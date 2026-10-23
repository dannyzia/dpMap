/**
 * sreRunbooks.ts — Stage 016 §5 runbooks A–D as executable guards.
 * Human-readable procedures live in docs/runbooks/RUNBOOKS_A_D.md;
 * this module encodes each runbook's machine-checkable invariants so
 * drills and the audit suite exercise the REAL thresholds.
 *
 * Runbook A — OSRM crash/timeout failover (< 5 min MTTR [ESTIMATE],
 *   < 300 ms cutover to standby, then waterfall absorption).
 * Runbook B — Emergency landmark takedown (Tier 1 < 1 h SLA; Redis Set
 *   sAdd < 5 ms, dual-index Meili purge, Stage 003 suppressions row,
 *   Cloudflare fp-poi tag purge, lifecycle + provenance writes).
 * Runbook C — Immediate mode rollback (primary → shadow → off via
 *   system_config hot reload; Redis suppression set NEVER cleared).
 * Runbook D — Geofabrik graph re-ingestion + MLD rebuild (monthly
 *   default [ESTIMATE], Blue/Green zero-downtime swap, manifest hash
 *   chaining, golden replay before done).
 */

import { FAILOVER_CUTOVER_BUDGET_MS, CIRCUIT_BREAKER_STRIKES } from './infrastructureSizing';
import { REDIS_SUPPRESSION_SET } from '../utils-server/emergencySuppression';

export const RUNBOOK_A_MTTR_MIN = 5;
export const RUNBOOK_B_SLA_MS = 60 * 60 * 1000; // Tier 1 < 1 h (measured applied_at − reported_at)
export const RUNBOOK_B_ENGINEERING_TARGET_S = 60; // [ESTIMATE]
export const RUNBOOK_B_CACHE_TAG = 'fp-poi';
export const RUNBOOK_B_PURGE_BUDGET_S = 30;
export const RUNBOOK_D_CADENCE_DAYS = 30; // monthly default [ESTIMATE], configurable
export const RUNBOOK_D_REBUILD_ALERT_MULTIPLE = 2; // Stage 004 alerts at 2× rebuild interval

export type ProviderMode = 0 | 1 | 2 | 3; // off | shadow | primary | sole

/** Runbook A: cutover within the 300 ms budget after 3 breaker strikes. */
export function runbookAFailover(args: {
  consecutiveStrikes: number;
  measuredCutoverMs: number;
  standbyHealthy: boolean;
}): { failover: boolean; absorbViaWaterfall: boolean; reason: string } {
  if (args.consecutiveStrikes < CIRCUIT_BREAKER_STRIKES) {
    return { failover: false, absorbViaWaterfall: false, reason: 'below-strike-threshold' };
  }
  if (!args.standbyHealthy) {
    // Both engines down → Stage 005 waterfall absorbs (vendor → capped → Haversine).
    return { failover: false, absorbViaWaterfall: true, reason: 'standby-down-waterfall-absorbs' };
  }
  if (args.measuredCutoverMs > FAILOVER_CUTOVER_BUDGET_MS) {
    return { failover: true, absorbViaWaterfall: false, reason: 'cutover-over-budget-escalate' };
  }
  return { failover: true, absorbViaWaterfall: false, reason: 'standby-promoted' };
}

/** Runbook A MTTR check (< 5 min [ESTIMATE]). */
export function runbookAMttrMet(minutes: number): boolean {
  return minutes < RUNBOOK_A_MTTR_MIN;
}

/** Runbook C: allowed rollback path primary(2) → shadow(1) → off(0). */
export function runbookCNextMode(current: ProviderMode, direction: 'down' | 'up'): ProviderMode {
  if (direction === 'down') return (Math.max(0, current - 1) ) as ProviderMode;
  return (Math.min(3, current + 1)) as ProviderMode;
}

/** Runbook C invariant: rollback NEVER clears the suppression set. */
export function runbookCPreservesSuppressions(clearedKeys: string[]): boolean {
  return !clearedKeys.includes(REDIS_SUPPRESSION_SET);
}

/** Runbook D: rebuild overdue when elapsed ≥ 2× the configured cadence. */
export function runbookDRebuildOverdue(elapsedDays: number, cadenceDays = RUNBOOK_D_CADENCE_DAYS): boolean {
  return elapsedDays >= RUNBOOK_D_REBUILD_ALERT_MULTIPLE * cadenceDays;
}

/** Runbook D completion checklist (all true before declaring done). */
export interface RunbookDChecklist {
  extractVerified: boolean; // bangladesh-latest.osm.pbf size check
  profilesBuilt: boolean; // extract/partition/customize per profile
  blueGreenSwapped: boolean; // synthetic probe, zero dropped queries
  geometryAuditSubset: boolean; // Stage 007 subset
  goldenReplayPassed: boolean; // Stage 015 routing replay
  manifestHashRecorded: boolean; // Stage 009 §11 chaining
}

export function runbookDComplete(c: RunbookDChecklist): boolean {
  return (
    c.extractVerified && c.profilesBuilt && c.blueGreenSwapped &&
    c.geometryAuditSubset && c.goldenReplayPassed && c.manifestHashRecorded
  );
}
