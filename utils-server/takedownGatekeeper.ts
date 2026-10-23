/**
 * takedownGatekeeper.ts — Stage 011 section 4 traveler-qualified, Sybil-resistant reporting.
 *
 * Hard qualifier (F-011-2): a report counts toward auto-hide ONLY from a
 * reporter who COMPLETED A RIDE whose drop-off fell in the POI's H3 res-10
 * cell (or its k=1 ring) within the last 90 days. Searches never qualify.
 * Unqualified reports are queued for humans but can NEVER auto-hide
 * (TC-011-08/09).
 *
 * Trust matrix (points all [ESTIMATE]): phone verified +30 (mandatory),
 * account age 0..25, completed trips 0..25, nearby context +20,
 * abuse penalty -50/strike, threshold >= 70.
 *
 * Counter mechanics (F-011-1): Redis Sets with TTL-on-first-add
 * (EXPIRE only when the counter is created — never reset the window):
 *   rate limit: dpmaps:takedown:user_rate:<user_id> (1 report / 24 h)
 *   auto-hide:  dpmaps:takedown:place_reports:<place_id> (>= 3 DISTINCT
 *               qualified travelers / 24 h → Tier 1 emergency suppression)
 *
 * Zero infrastructure deps: orders-lookup (the hard qualifier) and the
 * suppression service arrive injected. The qualifier returns a BOOLEAN
 * only — no rider↔place linkage leaves the operational domain (Class 4).
 * Production SQL for the qualifier is kept as a documented constant; the
 * injected function is what the audit exercises.
 */

import {
  DAY_SECONDS,
  EmergencySuppressionService,
  SuppressionSetClient,
  TAKEDOWN_PLACE_SET_PREFIX,
  TAKEDOWN_USER_RATE_PREFIX,
} from './emergencySuppression';

export type TakedownReason =
  | 'privacy_residential'
  | 'privacy_personal'
  | 'commercial_dispute'
  | 'profanity_abuse'
  | 'security_sensitive'
  | 'other';

export interface ReportSubmission {
  poi_id: string;
  poi_h3_res10: string;
  /** k=1 ring snapshot (Stage 009 section 4.3). */
  ring_cells: string[];
  reporter_user_id: string;
  phone_verified: boolean;
  account_created_at: Date;
  completed_trips_count: number;
  /** Trust bonus only — NEVER the qualifier. */
  has_nearby_context: boolean;
  prior_abuse_strikes: number;
  reason: TakedownReason;
  details?: string;
}

/** Trust threshold for auto-hide counting (points [ESTIMATE]). */
export const TRUST_THRESHOLD = 70;
/** Distinct qualified travelers within 24 h that trip auto-hide. */
export const AUTO_HIDE_REPORTER_THRESHOLD = 3;
/** Hard traveler window (days). */
export const TRAVELER_WINDOW_DAYS = 90;

/**
 * Production qualifier SQL (operational domain; boolean result only).
 * Requires public.orders.user_id (Stage 003 Rev 2.4 stub completion).
 * Where no DB H3 extension is provisioned, compute cells application-side
 * (h3-js) and pass them as the equality list — still a boolean.
 */
export const QUALIFIED_TRAVELER_SQL =
  'SELECT 1 FROM public.orders o\n' +
  " WHERE o.user_id = $1 AND o.status = 'completed'\n" +
  "   AND o.created_at >= NOW() - INTERVAL '90 days'\n" +
  '   AND h3_lat_lng_to_cell(o.dropoff_lat, o.dropoff_lng, 10) = ANY($2::text[])\n' +
  ' LIMIT 1';

/** Stage 003 Rev 2.4 conformant takedown_reports INSERT (exact columns). */
export const TAKEDOWN_REPORT_INSERT_SQL =
  'INSERT INTO dpmaps.takedown_reports\n' +
  '  (poi_id, reporter_user_id, reporter_trust_score, traveler_qualified,\n' +
  '   report_reason, report_details, status, reported_at)\n' +
  "VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)";

/** Narrow injected Postgres surface for the gatekeeper path. */
export interface GatekeeperDbClient {
  query(
    text: string,
    params?: unknown[]
  ): Promise<{ rowCount?: number | null; rows?: Array<Record<string, unknown>> }>;
}

export interface GatekeeperDeps {
  sets: SuppressionSetClient;
  db: GatekeeperDbClient;
  suppression: EmergencySuppressionService;
  /**
   * Hard qualifier probe: completed ride to (cell ∪ k=1 ring) < 90 d.
   * Returns a boolean ONLY (Class 4: no rider↔place linkage escapes).
   */
  hasCompletedRideToCell: (userId: string, cells: string[]) => Promise<boolean> | boolean;
  now?: () => Date;
}

export class TakedownGatekeeper {
  private readonly sets: SuppressionSetClient;
  private readonly db: GatekeeperDbClient;
  private readonly suppression: EmergencySuppressionService;
  private readonly hasCompletedRideToCell: (
    userId: string,
    cells: string[]
  ) => Promise<boolean> | boolean;
  private readonly now: () => Date;

  constructor(deps: GatekeeperDeps) {
    this.sets = deps.sets;
    this.db = deps.db;
    this.suppression = deps.suppression;
    this.hasCompletedRideToCell = deps.hasCompletedRideToCell;
    this.now = deps.now ?? (() => new Date());
  }

  /** Trust matrix (section 4). Unverified phone ⇒ 0 (mandatory prerequisite). */
  calculateTrustScore(sub: ReportSubmission): number {
    if (!sub.phone_verified) return 0;
    let score = 30;
    const ageDays = (this.now().getTime() - sub.account_created_at.getTime()) / 86400000;
    if (ageDays >= 90) score += 25;
    else if (ageDays >= 30) score += 15;
    if (sub.completed_trips_count >= 20) score += 25;
    else if (sub.completed_trips_count >= 5) score += 15;
    if (sub.has_nearby_context) score += 20;
    score -= sub.prior_abuse_strikes * 50;
    return Math.max(0, Math.min(100, score));
  }

  async isQualifiedTraveler(
    userId: string,
    poiH3Res10: string,
    ringCells: string[]
  ): Promise<boolean> {
    return this.hasCompletedRideToCell(userId, [poiH3Res10, ...ringCells]);
  }

  async processTakedownReport(
    sub: ReportSubmission
  ): Promise<{ status: 'auto_hidden' | 'queued'; trust_score: number; traveler_qualified: boolean }> {
    const trustScore = this.calculateTrustScore(sub);
    const qualified = await this.isQualifiedTraveler(
      sub.reporter_user_id,
      sub.poi_h3_res10,
      sub.ring_cells
    );
    const reportedAt = this.now();

    // Rate limit: 1 report per user per 24 h (TTL set ONCE on first add).
    const rateKey = `${TAKEDOWN_USER_RATE_PREFIX}${sub.reporter_user_id}`;
    const count = await this.sets.incr(rateKey);
    if (count === 1) await this.sets.expire(rateKey, DAY_SECONDS);
    const rateLimited = count > 1;

    // Persist (traveler_qualified recorded; reported_at has no DEFAULT —
    // the caller sets the SLA clock).
    await this.db.query(TAKEDOWN_REPORT_INSERT_SQL, [
      sub.poi_id,
      sub.reporter_user_id,
      trustScore,
      qualified,
      sub.reason,
      sub.details ?? null,
      reportedAt,
    ]);

    // Unqualified, low-trust, or rate-limited: queue only — NEVER auto-hide.
    if (rateLimited || trustScore < TRUST_THRESHOLD || !qualified) {
      return { status: 'queued', trust_score: trustScore, traveler_qualified: qualified };
    }

    // Distinct qualified-reporter Set (TTL 86400 set ONCE at first add).
    const key = `${TAKEDOWN_PLACE_SET_PREFIX}${sub.poi_id}`;
    await this.sets.sadd(key, sub.reporter_user_id);
    if ((await this.sets.scard(key)) === 1) await this.sets.expire(key, DAY_SECONDS);

    if ((await this.sets.scard(key)) >= AUTO_HIDE_REPORTER_THRESHOLD) {
      await this.suppression.executeEmergencySuppression({
        target_type: 'poi_id',
        target_value: sub.poi_id,
        reason:
          sub.reason === 'privacy_residential' || sub.reason === 'privacy_personal'
            ? 'privacy_request'
            : 'security_sensitive',
        requester: 'auto_hide',
        reported_at: reportedAt,
        tier: '1_hour',
        actor_id: 'system-auto-hide',
        audit_note: 'Auto-hidden via 3 distinct qualified travelers (F-011-2)',
      });
      await this.db.query(
        "UPDATE dpmaps.takedown_reports SET status = 'auto_hidden' WHERE poi_id = $1 AND status = 'pending'",
        [sub.poi_id]
      );
      return { status: 'auto_hidden', trust_score: trustScore, traveler_qualified: qualified };
    }
    return { status: 'queued', trust_score: trustScore, traveler_qualified: qualified };
  }
}
