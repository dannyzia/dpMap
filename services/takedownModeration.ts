/**
 * takedownModeration.ts — Stage 011 section 7 moderation queue & one-step rollback.
 *
 * Tier 2 manual review SLA: adjudicated_at - reported_at < 4 h (F-011-3).
 * Tier 1 automated SLA: applied_at - reported_at < 1 h (target < 60 s
 * engineering goal [ESTIMATE] — measured, not asserted, on Stage 003's
 * reported_at/applied_at/adjudicated_at columns).
 *
 * One-step rollback invariant (TC-011-12): a release rollback MUST NOT
 * clear the Redis suppression set — emergency takedowns persist, preventing
 * revived privacy leaks. rollbackReleasePlan() returns the step list and
 * REFUSES to build a plan that touches a protected key.
 */

import { REDIS_SUPPRESSION_SET } from '../utils-server/emergencySuppression';

export const TIER_1_SLA_MS = 60 * 60 * 1000;
export const TIER_2_SLA_MS = 4 * 60 * 60 * 1000;
/** On-call alert fires before the Tier 2 deadline [ESTIMATE]. */
export const TIER_2_ALERT_MS = 3 * 60 * 60 * 1000;

/** Redis keys a release rollback must never mutate. */
export const ROLLBACK_PROTECTED_KEYS = [REDIS_SUPPRESSION_SET] as const;

export type ModerationDecision = 'confirm_takedown' | 'restore_place' | 'anonymize_name';

/** Tier 1: applied_at - reported_at < 1 h. */
export function tier1SlaMet(reportedAt: Date, appliedAt: Date): boolean {
  return appliedAt.getTime() - reportedAt.getTime() < TIER_1_SLA_MS;
}

/** Tier 2: adjudicated_at - reported_at < 4 h. */
export function tier2SlaMet(reportedAt: Date, adjudicatedAt: Date): boolean {
  return adjudicatedAt.getTime() - reportedAt.getTime() < TIER_2_SLA_MS;
}

/** True once the 3 h on-call alert threshold is crossed without adjudication. */
export function tier2AlertDue(reportedAt: Date, now: Date): boolean {
  return now.getTime() - reportedAt.getTime() >= TIER_2_ALERT_MS;
}

export interface RollbackStep {
  action: string;
  /** Redis keys / indexes the step touches (empty for pure-DB steps). */
  touchesKeys: string[];
}

export interface RollbackPlan {
  releaseId: string;
  previousReleaseId: string;
  steps: RollbackStep[];
  suppressionsPreserved: true;
}

/**
 * One-step rollback plan: switches active_release_id, re-points MeiliSearch
 * aliases, invalidates tile caches. Any step touching a protected
 * suppression key is refused at plan-build time (TC-011-12).
 */
export function rollbackReleasePlan(releaseId: string, previousReleaseId: string): RollbackPlan {
  const steps: RollbackStep[] = [
    { action: 'switch-active-release', touchesKeys: [] },
    { action: 'repoint-meili-aliases', touchesKeys: [] },
    { action: 'invalidate-tile-caches', touchesKeys: [] },
  ];
  for (const step of steps) {
    for (const key of step.touchesKeys) {
      if ((ROLLBACK_PROTECTED_KEYS as readonly string[]).includes(key)) {
        throw new Error(`STAGE011-ROLLBACK: rollback must never touch ${key}`);
      }
    }
  }
  return { releaseId, previousReleaseId, steps, suppressionsPreserved: true };
}
