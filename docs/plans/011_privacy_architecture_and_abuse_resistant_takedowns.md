# Stage 011: Privacy Architecture & Abuse-Resistant Takedowns Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-011 (Revision 2.1 — Redis-Set Suppression, Traveler-Qualified Reporting & Dual-Tier SLA)
**Stage:** 11 of 16 (Privacy Protection & Abuse-Resistant Takedowns)
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§8.3, §10, §10.1–10.4, §12)
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)
**Current Status:** **NotDone**
**Target Phase:** Phase 1 (Dual-Connected Launch & Operational Privacy)
**Primary Dependencies:** Stage 002, Stage 003 (Rev 2.3 schema of record), Stage 008 (dual indexes), Stage 009, Stage 010

---

## 1. Executive Summary & Objective

Western privacy models assume numbered street grids and classify all residential structures as private. In Bangladesh, **named buildings** (*"Baitul Aman"*, *"Khan Mansion"*, *"Rashid Bhaban"*) are the foundational navigational anchors for residents, rickshaw pullers, couriers, and emergency responders. Two failure modes must both be avoided: over-suppression strips residential navigation (the share of urban anchors affected is `[ESTIMATE/UNVERIFIED — the "40%" figure is not established]`); under-suppression leaks apartment numbers, personal relationship names, and phone numbers into public autocomplete.

Stage 011 delivers:
1. **The Public Landmark Convergence Rule (F-011-4):** named houses/buildings may become public landmarks when the **name converges across many unrelated riders**; unit/flat numbers, resident names, and personal Home/Work labels are **permanently barred** — categorical invariants, not regex suggestions.
2. **Redis Set / Sliding-Window Suppression (F-011-1):** active suppressions live in a Redis Set with TTL semantics and in `dpmaps.suppressions` — **not a Bloom filter** (a Bloom filter cannot expire or delete elements without a full rebuild).
3. **Traveler-Qualified, Sybil-Resistant Reporting (F-011-2):** reports count toward automated suppression **only from riders who completed a ride to the destination H3 cell within the last 90 days**. Searches are not trips; bots cannot qualify.
4. **Dual-Tier Takedown SLA (F-011-3):** Tier 1 automated emergency suppression **< 1 hour** SLA (engineering target < 60 s `[ESTIMATE]`); Tier 2 manual review **< 4 hours** — both measured on Stage 003's SLA columns (`reported_at` → `applied_at` / `adjudicated_at`).
5. **Absolute Privacy Guardrails:** four banned data classes with hard architectural enforcement.

> [!CAUTION]
> Privacy claims in this plan **reduce exposure** and are **subject to audit**; nothing here is "immune" or "100% compliant". All legal matters route to counsel (Stage 002 Legal Gate).

---

## 2. Cultural Reality & the Public Landmark Convergence Rule (F-011-4)

```
[ Raw rider traffic: "Baitul Aman" ]  (90-day evidence window)
        │
        ▼
 Convergence criteria (all five):
   1. >= 15 independent rider pseudonyms
   2. >= 5 distinct drivers
   3. >= 3 separate calendar weeks
   4. Spatial entrance convergence: <= 30 m DBSCAN cluster
   5. Privacy filter: clean of unit numbers, phone digits, personal names
        │
   ┌────┴─────────────────────────────┐
   ▼ All passed                       ▼ Any failed
 PUBLIC LANDMARK                  PRIVATE RESIDENCE
 • publishable as point_type      • excluded from public search
   'building' via Stage 010       • retained only in the rider's own
   naming hierarchy                 private history/bookmarks
 • footprint + gate coords only   • zero leakage to other riders
```

### 2.1 The Residential Boundary — categorical rules
1. **Named houses/buildings (convergence):** when the **name** is independently used by ≥ 15 unrelated riders across ≥ 3 weeks, the building functions as a civic navigational anchor. Publishing its footprint and gate coordinates aids mobility **without** any resident identification.
2. **Permanently barred from publication (never, under any convergence):** unit/flat/floor numbers, suite designations, resident or family names, relationship phrases (*"Mamur bari"*), and personal category labels (*Home, Work, Gym, Parents*). These are hard-pipeline invariants (§3), not heuristics.
3. **Single-family homes** (traffic from residents/household only) fail rider diversity and stay unindexed.
4. **Low-density lanes (k-anonymity floor):** < 5 unique riders in 90 days ⇒ snap to the nearest major road junction; never publish a private dead-end curb pin.

---

## 3. Absolute Privacy Guardrails (Banned Data Invariants)

| Class | Banned content | Enforcement |
|---|---|---|
| **1. Unit-level specifics** | *"Flat 4B"*, *"Apt 12"*, *"Suite 301"*, *"৪র্থ তলা"* | Regex + token rules in `namingSanitizer.ts`; entire unit-only queries dropped from public ingestion |
| **2. Personal/relationship names** | *"Rahim er basha"*, *"Mamur bari"*, *"Dr. Kamal er bari"* | Linguistic parser: familial suffixes + personal nouns → private history only |
| **3. Saved personal places** | *Home, Work, Gym, Parents* | `user_private_places` (Stage 014), per-user encrypted; never in the learning pool |
| **4. Rider↔place linkage** | any "who visited X" query capability | Evidence stores `trip_hash = HMAC-SHA256(trip_id, IngestionSalt)` only (key-independent, Stage 003 §4.4). **135-day** window keys (`ledger_pseudonyms`, rotated every 30 days), 90-day ledger retention, 30-day raw purge. No endpoint joins riders to places. |

---

## 4. Abuse-Resistant Reporting & Traveler-Qualified Auto-Hide (F-011-2)

Anonymous single-click takedowns enable commercial sabotage (rival restaurants hiding each other). Reporting is gated by a trust score **and** a hard traveler qualifier:

```
[ User files takedown / privacy report ]
        │
        ▼
 HARD QUALIFIER (before any auto-hide counting):
   "Qualified traveler" = the reporter COMPLETED A RIDE whose drop-off fell in
   the POI's H3 res-10 cell (or its k=1 ring) within the last 90 days.
   Verified against first-party orders (operational domain; boolean result only).
   A search near the POI does NOT qualify. Unqualified reports are queued for
   humans but can NEVER trigger automated suppression (bot/sybil defense).
        │
        ▼
 MULTI-FACTOR TRUST SCORE (points all [ESTIMATE]):
   phone verified +880 (mandatory prerequisite)      +30
   account age >= 90 d (+25) / >= 30 d (+15)         0..+25
   completed trips >= 20 (+25) / >= 5 (+15)          0..+25
   contextual proximity (searched or rode nearby)    +20
   abuse penalty (per prior rejected/fraud report)   -50
   rate limit: 1 report per user per 24 h (sliding-window counter)
        │
   ┌────┴───────────────┐
   ▼ score >= 70        ▼ score < 70
 HIGH-TRUST             QUEUED (no counter increment)
 + qualified traveler?
   │ yes → increment auto-hide SET for place (distinct reporters)
   │ no  → queue only
        ▼
 AUTO-HIDE THRESHOLD: >= 3 DISTINCT qualified travelers within 24 h
   → Tier 1 emergency suppression (§5), < 1 h SLA (target < 60 s)
   → priority moderation ticket, Tier 2 < 4 h SLA
```

### 4.1 Counter Mechanics (F-011-1)
- Auto-hide counter: Redis **Set** `dpmaps:takedown:place_reports:<place_id>` of qualified reporter IDs; **TTL set once on first add** (86400 s) — a sliding-window distinct-counter, not a Bloom filter. (`EXPIRE` must not reset the window on every add.)
- Rate limiter: `dpmaps:takedown:user_rate:<user_id>` counter with TTL-on-first-add.

---

## 5. Emergency Suppression & Dual-Tier SLA (F-011-3, F-011-5)

### 5.1 Schema of Record (Stage 003 §4.5 — do not redefine)

```sql
-- Stage 003 Rev 2.3 dpmaps.suppressions (authoritative):
--   id, target_type IN ('poi_id','osm_poi_id','h3_cell','name_pattern'),
--   target_value, reason IN ('court_order','privacy_request','security_sensitive',
--   'copyright_claim','sybil_attack'), is_auto_hidden, auto_hide_reason,
--   reported_at TIMESTAMPTZ NOT NULL (no default — SLA clock start),
--   suppression_target_sla VARCHAR(16) NOT NULL DEFAULT '1_hour',
--   applied_at, adjudicated_at, expires_at, actor_id, audit_note
-- Indexes: idx_suppressions_target (target_type, target_value),
--          idx_suppressions_active (applied_at, expires_at) — immutable predicate.

-- Active-suppression predicate (no 'active' column exists):
--   applied_at IS NOT NULL AND (expires_at IS NULL OR expires_at > NOW())

-- Tier mapping (F-011-3):
--   Tier 1 automated emergency: suppression_target_sla = '1_hour'
--     SLA = applied_at - reported_at  < 1 hour (engineering target < 60 s [ESTIMATE])
--   Tier 2 manual review/takedown:   suppression_target_sla = '4_hours'
--     SLA = adjudicated_at - reported_at < 4 hours (3 h on-call alert [ESTIMATE])
```

`dpmaps.takedown_reports` is added additively via the Stage 003 Rev 2.4 brief (batch-2 audit Part F), with `reported_at TIMESTAMPTZ NOT NULL` (no default — same SLA discipline) and a `traveler_qualified BOOLEAN NOT NULL` column.

### 5.2 Eviction Cascade

```
[ Takedown trigger (auto-hide threshold or admin) ]
   ├─ Tier A: Redis Set dpmaps:suppression:active_place_ids  (sAdd; < 5 ms)
   ├─ Tier B: MeiliSearch eviction — first_party_pois AND osm_pois (Stage 008
   │          dual indexes; pub_* / osm_* IDs; < 100 ms)
   ├─ Tier C: dpmaps.suppressions row (Stage 003 columns) + public_pois
   │          lifecycle_status = 'suppressed' + provenance_events row
   ├─ Tier D: Cloudflare cache-tag purge for affected tiles (< 30 s [ESTIMATE])
   └─ Tier E: OSRM entrance-snapping exclusion (< 60 s [ESTIMATE])
```

---

## 6. Implementation (schema-conformant)

```typescript
// utils-server/emergencySuppression.ts
import { Pool } from 'pg';
import { RedisClientType } from 'redis';
import { MeiliSearch } from 'meilisearch';
import { createHash } from 'crypto';
import { v5 as uuidv5 } from 'uuid';
import { logger } from './logger';

const REDIS_SUPPRESSION_SET = 'dpmaps:suppression:active_place_ids'; // Redis Set (F-011-1)
const DPMAPS_SUPPRESSION_NS = process.env.DPMAPS_UUID_NS!; // fixed namespace UUID, provisioned once

export class EmergencySuppressionService {
  constructor(
    private readonly dbPool: Pool,
    private readonly redisClient: RedisClientType,
    private readonly meiliClient: MeiliSearch
  ) {}

  async isPlaceSuppressed(targetValue: string): Promise<boolean> {
    try {
      return await this.redisClient.sIsMember(REDIS_SUPPRESSION_SET, targetValue);
    } catch (err) {
      logger.error({ err }, '[Suppression] Redis check failed; failing over to DB');
      const res = await this.dbPool.query(
        `SELECT 1 FROM dpmaps.suppressions
          WHERE target_value = $1 AND applied_at IS NOT NULL
            AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`, [targetValue]);
      return (res.rowCount ?? 0) > 0;
    }
  }

  async executeEmergencySuppression(params: {
    target_type: 'poi_id' | 'osm_poi_id' | 'h3_cell' | 'name_pattern';
    target_value: string;
    reason: 'court_order' | 'privacy_request' | 'security_sensitive' | 'copyright_claim' | 'sybil_attack';
    requester: 'auto_hide' | 'user_report' | 'legal_counsel' | 'admin';
    reported_at: Date;            // SLA clock start (Stage 003 discipline)
    tier: '1_hour' | '4_hours';
    actor_id: string;
    audit_note?: string;
  }): Promise<void> {
    // Tier A: Redis Set (< 5 ms)
    await this.redisClient.sAdd(REDIS_SUPPRESSION_SET, params.target_value);

    // Tier B: dual-index MeiliSearch eviction (Stage 008 names)
    for (const indexName of ['first_party_pois', 'osm_pois'] as const) {
      try {
        await this.meiliClient.index(indexName).deleteDocument(params.target_value);
      } catch (err) { logger.error({ err, indexName }, '[Suppression] eviction error'); }
    }

    // Tier C: Stage 003 conformant writes
    const client = await this.dbPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO dpmaps.suppressions
           (target_type, target_value, reason, is_auto_hidden, auto_hide_reason,
            reported_at, suppression_target_sla, applied_at, actor_id, audit_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9)`,
        [params.target_type, params.target_value, params.reason,
         params.requester === 'auto_hide', params.requester === 'auto_hide' ? 'qualified_traveler_threshold' : null,
         params.reported_at, params.tier, params.actor_id, params.audit_note ?? null]);

      if (params.target_type === 'poi_id') {
        await client.query(
          `UPDATE dpmaps.public_pois SET lifecycle_status = 'suppressed', updated_at = NOW()
            WHERE id = $1`, [params.target_value]);
      }

      // Provenance: exact Stage 003 §4.5 columns
      const eventHash = createHash('sha256')
        .update(`${params.target_value}:${params.reason}:${params.reported_at.toISOString()}`)
        .digest('hex');
      // record_id: the POI UUID for poi_id targets; for h3_cell / name_pattern / osm_poi_id
      // targets a deterministic namespace UUID (UUIDv5 over "type:value") satisfies NOT NULL
      // without inventing identifiers (refinement: no null-UUID placeholder).
      const recordId = params.target_type === 'poi_id'
        ? params.target_value
        : uuidv5(`${params.target_type}:${params.target_value}`, DPMAPS_SUPPRESSION_NS);
      await client.query(
        `INSERT INTO dpmaps.provenance_events
           (event_type, record_id, target_record_hash, reason_code, publication_cycle, actor_id, event_hash)
         VALUES ('takedown', $1::uuid, $2, $3, $4, $5, $6)`,
        [recordId, eventHash, params.reason, 'manual', params.actor_id, eventHash]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  }
}
```

```typescript
// utils-server/takedownGatekeeper.ts (traveler-qualified — F-011-2)
import { Pool } from 'pg';
import { RedisClientType } from 'redis';
import { EmergencySuppressionService } from './emergencySuppression';
import { logger } from './logger';

export interface ReportSubmission {
  poi_id: string;
  poi_h3_res10: string;
  ring_cells: string[];               // k=1 ring snapshot (Stage 009 §4.3)
  reporter_user_id: string;
  phone_verified: boolean;
  account_created_at: Date;
  completed_trips_count: number;
  has_nearby_context: boolean;        // trust bonus only — NOT the qualifier
  prior_abuse_strikes: number;
  reason: 'privacy_residential' | 'privacy_personal' | 'commercial_dispute'
        | 'profanity_abuse' | 'security_sensitive' | 'other';
  details?: string;
}

export class TakedownGatekeeper {
  constructor(
    private readonly dbPool: Pool,
    private readonly redisClient: RedisClientType,
    private readonly suppressionService: EmergencySuppressionService
  ) {}

  /** Reporter Trust Score per the §4 matrix (points all [ESTIMATE]). */
  calculateTrustScore(sub: ReportSubmission): number {
    if (!sub.phone_verified) return 0;                    // mandatory prerequisite
    let score = 30;
    const ageDays = (Date.now() - sub.account_created_at.getTime()) / 86400000;
    if (ageDays >= 90) score += 25;
    else if (ageDays >= 30) score += 15;
    if (sub.completed_trips_count >= 20) score += 25;
    else if (sub.completed_trips_count >= 5) score += 15;
    if (sub.has_nearby_context) score += 20;
    score -= sub.prior_abuse_strikes * 50;
    return Math.max(0, Math.min(100, score));
  }

  /** Hard qualifier (F-011-2): completed ride to the POI's H3 res-10 cell (k=1 ring)
   *  within 90 days. First-party orders in the operational domain; boolean result only.
   *  Requires public.orders.user_id (Stage 003 Rev 2.4 stub completion). */
  async isQualifiedTraveler(userId: string, poiH3Res10: string, ringCells: string[]): Promise<boolean> {
    const res = await this.dbPool.query(
      `SELECT 1 FROM public.orders o
        WHERE o.user_id = $1 AND o.status = 'completed'
          AND o.created_at >= NOW() - INTERVAL '90 days'
          AND h3_lat_lng_to_cell(o.dropoff_lat, o.dropoff_lng, 10) = ANY($2::text[])
        LIMIT 1`, [userId, [poiH3Res10, ...ringCells]]);
    return (res.rowCount ?? 0) > 0;
    // If no DB H3 extension is provisioned, compute cells application-side (h3-js)
    // and pass them as an explicit equality list; the result is still a boolean.
  }

  async processTakedownReport(sub: ReportSubmission): Promise<{ status: 'auto_hidden' | 'queued'; trust_score: number }> {
    const trustScore = this.calculateTrustScore(sub);
    const qualified = await this.isQualifiedTraveler(sub.reporter_user_id, sub.poi_h3_res10, sub.ring_cells);
    const reportedAt = new Date(); // SLA clock start (no DEFAULT on reported_at)

    // Rate limit: 1 report per user per 24 h (TTL-on-first-add sliding window)
    const rateKey = `dpmaps:takedown:user_rate:${sub.reporter_user_id}`;
    const count = await this.redisClient.incr(rateKey);
    if (count === 1) await this.redisClient.expire(rateKey, 86400);
    const rateLimited = count > 1;

    // Persist to dpmaps.takedown_reports (Stage 003 Rev 2.4; traveler_qualified recorded)
    await this.dbPool.query(
      `INSERT INTO dpmaps.takedown_reports
         (poi_id, reporter_user_id, reporter_trust_score, traveler_qualified,
          report_reason, report_details, status, reported_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
      [sub.poi_id, sub.reporter_user_id, trustScore, qualified,
       sub.reason, sub.details ?? null, reportedAt]);

    // Unqualified or low-trust or rate-limited: queue only — NEVER auto-hide
    if (rateLimited || trustScore < 70 || !qualified) {
      return { status: 'queued', trust_score: trustScore };
    }

    // Distinct qualified-reporter Set (TTL 86400 set ONCE at first add)
    const key = `dpmaps:takedown:place_reports:${sub.poi_id}`;
    await this.redisClient.sAdd(key, sub.reporter_user_id);
    if (await this.redisClient.sCard(key) === 1) await this.redisClient.expire(key, 86400);

    if (await this.redisClient.sCard(key) >= 3) {
      await this.suppressionService.executeEmergencySuppression({
        target_type: 'poi_id',
        target_value: sub.poi_id,
        reason: sub.reason === 'privacy_residential' || sub.reason === 'privacy_personal'
          ? 'privacy_request' : 'security_sensitive',
        requester: 'auto_hide',
        reported_at: reportedAt,
        tier: '1_hour',
        actor_id: 'system-auto-hide',
        audit_note: `Auto-hidden via 3 distinct qualified travelers (F-011-2)`
      });
      await this.dbPool.query(
        `UPDATE dpmaps.takedown_reports SET status = 'auto_hidden'
          WHERE poi_id = $1 AND status = 'pending'`, [sub.poi_id]);
      return { status: 'auto_hidden', trust_score: trustScore };
    }
    return { status: 'queued', trust_score: trustScore };
  }
}
```

---

## 7. Moderation Queue & One-Step Rollback

### 7.1 Tier 2 Manual Review (< 4 h SLA)
Auto-hidden tickets land in the admin portal with reporter justifications, 90-day trip evidence counts, and three actions: **Confirm Takedown** (permanent, decouple queries), **Restore Place** (strike abusers' trust), **Anonymize Name** (coarse landmark/intersection per Stage 010). SLA clock: `adjudicated_at - reported_at < 4 h`; an automated on-call alert fires at 3 h `[ESTIMATE]`. Coordinated-sabotage findings add `prior_abuse_strikes += 1` (−50 trust each).

### 7.2 One-Step Rollback
`npm run dpmaps:release -- --rollback-to pub-2026-10-01` switches `active_release_id`, re-points MeiliSearch aliases, and invalidates tile caches. **The Redis suppression set is never cleared by rollback** — emergency takedowns persist, preventing revived privacy leaks.

---

## 8. Unit Testing Matrix & Privacy Verification

| Test Case | Scenario | Expected | Rationale |
|---|---|:---:|---|
| TC-011-01 | *"Flat 4B"* query | DROPPED | Class 1 invariant |
| TC-011-02 | *"Mamur bari"* query | PRIVATE ONLY | Class 2 invariant |
| TC-011-03 | named building, 12 riders / 90 d | UNINDEXED | convergence fails diversity |
| TC-011-04 | named building, 22 riders / 4 weeks, clean name | INDEXABLE | convergence passes |
| TC-011-05 | unverified phone report | QUEUED | trust 0 |
| TC-011-06 | 1 high-trust qualified report | QUEUED | threshold is 3 |
| TC-011-07 | 3 qualified travelers / 24 h | AUTO-HIDDEN (Tier 1 < 1 h) | threshold + traveler qualifier |
| **TC-011-08** | 3 high-trust reports, **none** rode to the cell | **QUEUED (NO AUTO-HIDE)** | F-011-2 sybil defense |
| **TC-011-09** | reporter rode to cell 100 days ago | **QUEUED** | 90-day traveler window |
| TC-011-10 | 2 reports / 24 h from one user | RATE LIMITED | sliding-window rate limit |
| TC-011-11 | admin restore after review | RESTORED | Redis Set sRem + re-index both indexes |
| TC-011-12 | release rollback with active suppressions | SUPPRESSIONS PERSIST | rollback never clears the set |
| TC-011-13 | unit/flat string at 25-rider convergence | STILL BARRED | categorical privacy rule (F-011-4) |

---

## 9. Deliverables & Definition of Done

- [ ] Privacy ingestion guardrails (Classes 1–4) deployed as pipeline invariants with unit tests TC-011-01/02/13.
- [ ] Convergence rule engine wired to Stage 009 evidence; residential boundary documented and enforced categorically (F-011-4).
- [ ] Redis Set / sliding-window suppression (`dpmaps:suppression:active_place_ids`, TTL-on-first-add counters) replacing all Bloom-filter references (F-011-1).
- [ ] Traveler-qualified reporting enforced: `traveler_qualified` recorded; unqualified reports can never trip auto-hide (TC-011-08/09) (F-011-2).
- [ ] `suppressions` writes/reads conformant to Stage 003 §4.5 columns and predicates; SLA dashboards track `reported_at → applied_at` (< 1 h) and `reported_at → adjudicated_at` (< 4 h) (F-011-3, F-011-5).
- [ ] `provenance_events` inserts conformant (enum event types, `target_record_hash`, `event_hash`).
- [ ] Dual-index MeiliSearch purge (`first_party_pois`, `osm_pois`) verified < 60 s end-to-end `[ESTIMATE]`.
- [ ] Moderation queue with < 4 h SLA alerting; one-step rollback preserves suppressions.
- [ ] Pseudonym/retention facts aligned: 135-day keys, 90-day ledger, 30-day raw purge.

---

## 10. Revision Changelog

| Revision | Date | Author / Context | Summary of Major Changes |
|---|---|---|---|
| Rev 2.0 | 2026-10-22 | Orchestrator (audited baseline) | Convergence rule, privacy classes, reporter trust score, emergency suppression, moderation queue. |
| Rev 2.1 | 2026-10-22 | Lead Planning & Systems Architecture (batch-2 audit) | **Suppression Semantics, Sybil Defense & SLA Alignment:**<br>1. **Component rename (F-011-1):** Bloom filter → Redis Set / sliding-window counters (TTL-on-first-add; point deletion semantics).<br>2. **Traveler-qualified reporting (F-011-2):** hard qualifier — completed ride to the destination H3 cell (k=1 ring) within 90 days before a report counts toward auto-hide; searches never qualify (TC-011-08/09).<br>3. **Dual-tier SLA (F-011-3):** Tier 1 < 1 h automated / Tier 2 < 4 h manual, measured on Stage 003 `reported_at`/`applied_at`/`adjudicated_at` with `suppression_target_sla` mapping.<br>4. **Residential boundary (F-011-4):** convergent named houses publishable; unit numbers, resident names, Home/Work labels categorically barred.<br>5. **Schema conformance (F-011-5/6):** `suppressions` rewritten to the Stage 003 §4.5 columns/predicates (no invented `active`/`poi_id`/`notes`); `provenance_events` inserts conformant; `takedown_reports` moved to the Stage 003 Rev 2.4 adoption brief with `traveler_qualified`.<br>6. **Bundle (F-011-7):** dual-index Meili purge; 135-day key facts; sliding-window TTL fix; `[ESTIMATE]`/`[UNVERIFIED]` labels (incl. removal of the unverified "40%" claim). |
