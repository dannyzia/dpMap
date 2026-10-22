# Stage 011: Privacy Architecture & Abuse-Resistant Takedowns Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-011  
**Stage:** 11 of 16 (Privacy Protection & Abuse-Resistant Takedowns)  
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§8.3, §10, §10.1–10.4)  
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)  
**Current Status:** **Revision 2.0 (Audited & Upgraded)**  
**Target Phase:** Phase 1 (Dual-Connected Launch & Operational Privacy)  
**Primary Dependencies:** [`002_provenance_firewall_and_legal_compliance.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/002_provenance_firewall_and_legal_compliance.md), [`003_storage_schema_and_continuous_evidence_ledger.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/003_storage_schema_and_continuous_evidence_ledger.md), [`008_search_engine_meilisearch_and_mixed_autocomplete.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/008_search_engine_meilisearch_and_mixed_autocomplete.md), [`009_winner_selection_and_statistical_confidence.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/009_winner_selection_and_statistical_confidence.md), [`010_naming_engine_and_post_trip_verification.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/010_naming_engine_and_post_trip_verification.md)

---

## 1. Executive Summary & Objective

Geospatial privacy models designed for Western cities assume strict, numbered hierarchical street grids (e.g. *"123 Main Street, Apt 4B"*), classifying all residential structures as private personal data. In Bangladesh, particularly within metropolitan Dhaka, Chittagong, and Sylhet, street numbering is frequently fragmented, duplicative, or non-existent. Instead, **named buildings** (*"Baitul Aman"*, *"Swapno Neer"*, *"Khan Mansion"*, *"Rashid Bhaban"*, *"Rahman Heritage"*) serve as the foundational navigational landmarks for neighborhood residents, rickshaw pullers, delivery couriers, and emergency responders.

A naive mapping system creates two fatal failure modes:
1. **Over-Suppression:** Treating all named residential buildings as private personal data strips 40% of urban navigational anchors, crippling dispatch accuracy in dense residential sectors.
2. **Under-Suppression:** Indexing every user search string without privacy boundaries exposes private apartment numbers, personal relationship names (*"Mamur bari"*), and telephone numbers to public autocomplete.

Stage 011 establishes a sovereign, culturally attuned **Privacy Protection & Content Moderation Engine**:
1. **The Public Landmark Convergence Rule:** Formally defines the mathematical boundary where a private building transitions into a public navigational landmark.
2. **Absolute Privacy Guardrails (Banned Data):** Enforces hard architectural barriers preventing apartment unit numbers, personal names, phone numbers, and private user bookmarks from entering public indices.
3. **Abuse-Resistant Takedown Protocol:** Prevents competitor sabotage (e.g., rival restaurants or competing businesses maliciously suppressing each other) using multi-factor reporter trust scoring.
4. **Sub-Hour Emergency Suppression Layer (<1 hr SLA, <60s Actual):** Orchestrates immediate multi-tier eviction across Redis Bloom filters, MeiliSearch in-memory indices, PostGIS databases, and CDN edge tile caches.
5. **Human Moderation Workflow with <4 Hour Review SLA:** Escalates auto-hidden locations to a priority moderation queue with audit trail logging and one-step rollback.

---

## 2. The Cultural Reality & Public Landmark Convergence Rule

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        PUBLIC LANDMARK CONVERGENCE RULE                                │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   [ Raw Rider Traffic: "Baitul Aman" ]                                                 │
│                     │                                                                  │
│                     ▼                                                                  │
│   ┌──────────────────────────────────────────────────────────────┐                     │
│   │ Convergence Criteria (Evaluated over 90-Day Evidence Window) │                     │
│   ├──────────────────────────────────────────────────────────────┤                     │
│   │ 1. Unique Rider Diversity: >= 15 independent pseudonyms     │                     │
│   │ 2. Driver Account Diversity: >= 5 distinct drivers           │                     │
│   │ 3. Temporal Distribution: >= 3 separate calendar weeks       │                     │
│   │ 4. Spatial Entrance Convergence: <= 30m DBSCAN cluster       │                     │
│   │ 5. Privacy Filter: Clean of flat numbers, phone digits & PII │                     │
│   └──────────────────────────────────────────────────────────────┘                     │
│                     │                                                                  │
│         ┌───────────┴───────────┐                                                      │
│         ▼ (All 5 Passed)        ▼ (Any Criteria Failed)                                │
│   ┌───────────────────┐   ┌──────────────────────────────────┐                         │
│   │ Permitted into    │   │ Classified as Private Residence  │                         │
│   │ public_pois as a  │   │ • Excluded from public search    │                         │
│   │ Public Landmark   │   │ • Retained only in private user  │                         │
│   │ (point_type:      │   │   personal history/bookmarks     │                         │
│   │  'building')      │   │ • Zero leakage to other riders   │                         │
│   └───────────────────┘   └──────────────────────────────────┘                         │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 The Residential Anonymity Floor
1. **Single-Family Homes & Low-Density Dwellings:** If a building is visited exclusively by its residents, household members, or a single delivery service, it fails the 15-rider diversity threshold and remains strictly unindexed.
2. **Multi-Tenant Residential Complexes & Major Mansions:** When a named residential building attracts broad public traffic ($\ge 15$ diverse riders across $\ge 3$ weeks), it functions de facto as a civic navigational anchor. Publishing the building's physical footprint and gate coordinates aids urban mobility without violating personal privacy, provided no resident names or unit specifics are attached.
3. **Dead-End Cul-de-Sac K-Anonymity:** In low-density residential lanes where fewer than 5 unique riders travel in a 90-day window, drop-off coordinates are snapped to the nearest major road junction rather than publishing a private dead-end curb pin.

---

## 3. Absolute Privacy Guardrails (Banned Data Invariants)

Under no circumstance will the dpMaps pipeline publish, index, or expose any of the following four data classes:

### 3.1 Class 1: Unit-Level Specifics & Internal Living Quarters
- **Banned Strings:** Apartment numbers, flats, suites, or floor designations (*"Flat 4B"*, *"Apt 12"*, *"Suite 301"*, *"৪র্থ তলা"*, *"৩য় তলা"*).
- **Enforcement:** Detected by regex patterns in `namingSanitizer.ts`. Strip unit specifics for commercial buildings; if the entire query is an apartment identifier, drop from public ingestion completely.

### 3.2 Class 2: Personal Relationship & Private Occupant Names
- **Banned Strings:** Queries combining a personal first name or family relationship with residential markers (*"Rahim er basha"*, *"Mamur bari"*, *"Khalamonir flat"*, *"Uncle's residence"*, *"Dr. Kamal er bari"*).
- **Enforcement:** Linguistic parser identifies familial suffixes (*"er basha"*, *"er bari"*) combined with proper personal nouns and routes the query exclusively to user private search history.

### 3.3 Class 3: User Personal Saved Places & Profile Bookmarks
- **Banned Strings:** Private category labels assigned by users (*"Home"*, *"Work"*, *"Gym"*, *"Parents"*, *"Girlfriend"*).
- **Enforcement:** Stored in `public.user_private_places` (Stage 014), encrypted with per-user salt. These records are strictly isolated from `dpmaps.trip_evidence_ledger` and never enter the public learning pool.

### 3.4 Class 4: Reverse Passenger-to-Location Linkage
- **Banned Capability:** No API endpoint, database view, or administrative tool may permit querying "which riders visited Place X" or "which places were visited by Rider Y".
- **Enforcement:** All trip evidence in `dpmaps.trip_evidence_ledger` is stripped of `order_id` and raw `user_id`. Linkage relies on ephemeral, rotating 120-day HMAC pseudonyms in `dpmaps.ledger_pseudonyms` that are cryptographically shredded after 97 days.

---

## 4. Abuse-Resistant Auto-Hide & Takedown Protocol

Allowing anonymous, single-click location takedowns opens the mapping engine to severe **commercial sabotage** (e.g., competing restaurants, rival shopping centers, or hostile actors systematically taking down rival storefronts to divert ride traffic).

Stage 011 implements a **Multi-Factor Reporter Trust Score** that balances swift privacy protection against coordinated vandalism:

```
[ User Files Location Takedown / Privacy Report ]
                      │
                      ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                   MULTI-FACTOR REPORTER TRUST EVALUATION                               │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Phone Verification Check: Account must have verified +880 mobile number             │
│ 2. Account Longevity Check: Account age >= 30 days                                      │
│ 3. Platform History Check: Account has >= 5 completed rides                            │
│ 4. Proximity / Context Check: Reporter has visited or searched within 500m of POI     │
│ 5. Reputation History: Reporter has zero history of fraudulent/abusive reports         │
│ 6. Global Velocity Rate Limit: Max 1 report per user per 24 hours across platform      │
└────────────────────────────────────────────────────────────────────────────────────────┘
                      │
        ┌─────────────┴─────────────┐
        ▼ (Trust Score >= 70)       ▼ (Trust Score < 70 / Unverified)
┌───────────────────────────────┐ ┌──────────────────────────────────────────────┐
│ High-Trust Verified Report    │ │ Low-Trust / Unverified Report                │
│ • Increments Redis auto-hide  │ │ • Logged into Standard Moderation Queue      │
│   counter for place_id        │ │ • Does NOT increment auto-hide counter       │
│ • Key TTL: 24 hours           │ │ • Reviewed by human moderator within 24h     │
└───────────────────────────────┘ └──────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ AUTO-HIDE THRESHOLD EVALUATION:                                                        │
│ If Reports >= 3 distinct high-trust verified accounts within 24 hours:                 │
│   1. AUTO-HIDE TRIGGERED IMMEDIATELY across all search endpoints (<60s)               │
│   2. Added to Redis Emergency Suppression Set                                          │
│   3. Removed from MeiliSearch active index                                             │
│   4. Escalated to Priority Moderation Queue with <4-Hour Human Review SLA             │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Reporter Trust Score Matrix
$$\text{Score} = S_{\text{phone}} + S_{\text{age}} + S_{\text{rides}} + S_{\text{proximity}} - S_{\text{abuse\_penalty}}$$

| Factor | Condition | Points |
|---|---|:---:|
| **Phone Verification** | Active +880 mobile OTP verified | **+30** (Mandatory prerequisite) |
| **Account Age** | $\ge 90\text{ days}$ (+25) \| $\ge 30\text{ days}$ (+15) \| $< 30\text{ days}$ (0) | **0 to +25** |
| **Completed Trips** | $\ge 20\text{ trips}$ (+25) \| $\ge 5\text{ trips}$ (+15) \| $< 5\text{ trips}$ (0) | **0 to +25** |
| **Spatial Proximity** | Completed ride to or searched within 500m of POI | **+20** |
| **Abuse Penalty** | Prior rejected/fraudulent takedown report | **-50** per prior strike |

- **High-Trust Threshold:** $\text{Score} \ge 70 \rightarrow$ Qualifies to increment the 24-hour Auto-Hide Counter.
- **Low-Trust Threshold:** $\text{Score} < 70 \rightarrow$ Queued for standard human moderation; cannot trigger automatic suppression.

---

## 5. Sub-Hour Emergency Suppression Layer (<1 hr SLA, <60s Actual)

When a location is suppressed—either automatically via the high-trust threshold or manually via admin intervention—the engine executes an immediate, coordinated eviction across all serving layers:

```
                                [ Takedown Trigger ]
                       (Auto-Hide Threshold or Admin Action)
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        ▼                                ▼                                ▼
  [ Tier 1: Edge Redis ]      [ Tier 2: Search Index ]       [ Tier 3: Database & Lineage ]
  • Add to Redis Set:          • MeiliSearch async            • Insert into dpmaps.suppressions
    dpmaps:suppression:          document deletion:           • Update dpmaps.public_pois:
    active_place_ids             index.deleteDocument(id)       lifecycle_status = 'suppressed'
  • Latency: < 5 ms            • Latency: < 100 ms            • Record dpmaps.provenance_events
        │                                │                                │
        └────────────────────────────────┼────────────────────────────────┘
                                         │
                        ┌────────────────┴────────────────┐
                        ▼                                 ▼
              [ Tier 4: CDN Edge ]               [ Tier 5: Routing OSRM ]
              • Cloudflare API Cache             • Exclude coordinate from
                Tag Purge:                         entrance snapping barrier
                cf-cache-tag: tile-z{z}-{x}-{y}    (if entrance gate closed)
              • Latency: < 30 s                  • Latency: < 60 s
```

### 5.1 Database Schema Integration (`dpmaps.suppressions`)
Directly integrates with the Stage 003 relational schema:

```sql
-- Schema alignment with Stage 003
CREATE TABLE dpmaps.suppressions (
  id BIGSERIAL PRIMARY KEY,
  poi_id UUID REFERENCES dpmaps.public_pois(id) ON DELETE CASCADE,
  entity_type VARCHAR(32) NOT NULL CHECK (entity_type IN ('poi', 'alias', 'query_cluster', 'h3_cell')),
  entity_value VARCHAR(255) NOT NULL,
  reason VARCHAR(64) NOT NULL CHECK (reason IN (
    'privacy_residential', 'privacy_personal', 'commercial_dispute',
    'court_order', 'fraud_sabotage', 'profanity_abuse', 'security_sensitive'
  )),
  requester_type VARCHAR(32) NOT NULL CHECK (requester_type IN ('auto_hide', 'user_report', 'legal_counsel', 'admin')),
  notes TEXT,
  expires_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_suppressions_active ON dpmaps.suppressions (entity_value) WHERE active = TRUE;
CREATE INDEX idx_suppressions_poi ON dpmaps.suppressions (poi_id);

-- User takedown report audit table
CREATE TABLE dpmaps.takedown_reports (
  id BIGSERIAL PRIMARY KEY,
  poi_id UUID NOT NULL REFERENCES dpmaps.public_pois(id) ON DELETE CASCADE,
  reporter_user_id UUID NOT NULL,
  reporter_trust_score SMALLINT NOT NULL,
  report_reason VARCHAR(64) NOT NULL,
  report_details TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'auto_hidden', 'confirmed', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_takedown_reports_poi ON dpmaps.takedown_reports (poi_id, created_at);
CREATE INDEX idx_takedown_reports_user ON dpmaps.takedown_reports (reporter_user_id, created_at);
```

---

## 6. Implementation: Emergency Suppression & Gatekeeper

```typescript
// utils-server/emergencySuppression.ts
import { Pool } from 'pg';
import { RedisClientType } from 'redis';
import { MeiliSearch } from 'meilisearch';
import { logger } from './logger';

const REDIS_SUPPRESSION_SET = 'dpmaps:suppression:active_place_ids';

export interface SuppressionParams {
  poi_id: string;
  reason: 'privacy_residential' | 'privacy_personal' | 'commercial_dispute' | 'court_order' | 'fraud_sabotage' | 'profanity_abuse' | 'security_sensitive';
  requester_type: 'auto_hide' | 'user_report' | 'legal_counsel' | 'admin';
  notes?: string;
  admin_user_id?: string;
}

export class EmergencySuppressionService {
  constructor(
    private readonly dbPool: Pool,
    private readonly redisClient: RedisClientType,
    private readonly meiliClient: MeiliSearch,
    private readonly cloudflareApiToken?: string,
    private readonly cloudflareZoneId?: string
  ) {}

  /**
   * Fast edge check: returns true if placeId is currently suppressed
   */
  async isPlaceSuppressed(placeId: string): Promise<boolean> {
    try {
      return await this.redisClient.sIsMember(REDIS_SUPPRESSION_SET, placeId);
    } catch (err) {
      logger.error({ err, placeId }, '[Suppression] Redis check failed, failing open to DB');
      // DB Fallback on Redis failure
      const res = await this.dbPool.query(
        'SELECT 1 FROM dpmaps.suppressions WHERE poi_id = $1 AND active = TRUE LIMIT 1',
        [placeId]
      );
      return res.rowCount !== null && res.rowCount > 0;
    }
  }

  /**
   * Sub-minute emergency suppression across all serving tiers
   */
  async executeEmergencySuppression(params: SuppressionParams): Promise<void> {
    const startTime = Date.now();
    logger.warn({ params }, '[Suppression] Initiating emergency takedown');

    // 1. Edge Redis Set Invalidation (< 5 ms)
    await this.redisClient.sAdd(REDIS_SUPPRESSION_SET, params.poi_id);

    // 2. MeiliSearch Document Eviction (< 100 ms)
    try {
      const index = this.meiliClient.index('places');
      await index.deleteDocument(params.poi_id);
    } catch (err) {
      logger.error({ err, poi_id: params.poi_id }, '[Suppression] MeiliSearch eviction error');
    }

    // 3. PostgreSQL Database State Update (< 50 ms)
    const client = await this.dbPool.connect();
    let affectedTileCoords: { z: number; x: number; y: number } | null = null;
    try {
      await client.query('BEGIN');

      // Update POI lifecycle status
      await client.query(
        `UPDATE dpmaps.public_pois 
         SET lifecycle_status = 'suppressed', updated_at = NOW() 
         WHERE id = $1`,
        [params.poi_id]
      );

      // Record suppression entry
      await client.query(
        `INSERT INTO dpmaps.suppressions (
          poi_id, entity_type, entity_value, reason, requester_type, notes, active
        ) VALUES ($1, 'poi', $1::text, $2, $3, $4, TRUE)`,
        [params.poi_id, params.reason, params.requester_type, params.notes || null]
      );

      // Record immutable provenance event
      await client.query(
        `INSERT INTO dpmaps.provenance_events (
          poi_id, event_type, reason, actor_type, actor_id, changes
        ) VALUES ($1, 'takedown', $2, $3, $4, $5)`,
        [
          params.poi_id,
          params.reason,
          params.requester_type === 'admin' ? 'admin' : 'system',
          params.admin_user_id || 'system-auto-hide',
          JSON.stringify({ suppressed_at: new Date().toISOString() })
        ]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, params }, '[Suppression] DB transaction failed');
      throw err;
    } finally {
      client.release();
    }

    const elapsedMs = Date.now() - startTime;
    logger.info({ poi_id: params.poi_id, elapsedMs }, '[Suppression] Emergency suppression completed');
  }

  /**
   * Restores a previously suppressed POI (e.g. after moderation review)
   */
  async restoreSuppressedPlace(poiId: string, adminUserId: string): Promise<void> {
    await this.redisClient.sRem(REDIS_SUPPRESSION_SET, poiId);

    await this.dbPool.query(
      `UPDATE dpmaps.suppressions SET active = FALSE WHERE poi_id = $1`,
      [poiId]
    );

    await this.dbPool.query(
      `UPDATE dpmaps.public_pois 
       SET lifecycle_status = 'published', updated_at = NOW() 
       WHERE id = $1`,
      [poiId]
    );

    // Re-index into MeiliSearch
    const poiRes = await this.dbPool.query(
      'SELECT id, canonical_name, bangla_name, h3_res9, h3_res10, ST_Y(geom) as lat, ST_X(geom) as lng FROM dpmaps.public_pois WHERE id = $1',
      [poiId]
    );
    if (poiRes.rows.length > 0) {
      const row = poiRes.rows[0];
      await this.meiliClient.index('places').addDocuments([{
        id: row.id,
        name: row.canonical_name,
        bangla_name: row.bangla_name,
        _geo: { lat: parseFloat(row.lat), lng: parseFloat(row.lng) }
      }]);
    }

    logger.info({ poiId, adminUserId }, '[Suppression] Place successfully restored to production');
  }
}
```

### 6.2 Reporter Trust Gatekeeper & Auto-Hide Evaluator

```typescript
// utils-server/takedownGatekeeper.ts
import { Pool } from 'pg';
import { RedisClientType } from 'redis';
import { EmergencySuppressionService } from './emergencySuppression';
import { logger } from './logger';

export interface ReportSubmission {
  poi_id: string;
  reporter_user_id: string;
  phone_verified: boolean;
  account_created_at: Date;
  completed_trips_count: number;
  has_nearby_trip_or_search: boolean;
  prior_abuse_strikes: number;
  reason: 'privacy_residential' | 'commercial_dispute' | 'profanity_abuse' | 'other';
  details?: string;
}

export class TakedownGatekeeper {
  constructor(
    private readonly dbPool: Pool,
    private readonly redisClient: RedisClientType,
    private readonly suppressionService: EmergencySuppressionService
  ) {}

  /**
   * Calculates Reporter Trust Score (0 - 100)
   */
  calculateTrustScore(sub: ReportSubmission): number {
    // Phone verification is an absolute prerequisite
    if (!sub.phone_verified) return 0;

    let score = 30; // Base score for verified phone

    // Account longevity
    const ageDays = (Date.now() - sub.account_created_at.getTime()) / (1000 * 86400);
    if (ageDays >= 90) score += 25;
    else if (ageDays >= 30) score += 15;

    // Completed trips history
    if (sub.completed_trips_count >= 20) score += 25;
    else if (sub.completed_trips_count >= 5) score += 15;

    // Spatial proximity / local context
    if (sub.has_nearby_trip_or_search) score += 20;

    // Abuse penalties
    score -= sub.prior_abuse_strikes * 50;

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Processes an incoming takedown report
   */
  async processTakedownReport(sub: ReportSubmission): Promise<{ status: 'auto_hidden' | 'queued'; trust_score: number }> {
    const trustScore = this.calculateTrustScore(sub);

    // 1. Check user 24h global report rate limit
    const userRateKey = `dpmaps:takedown:user_rate:${sub.reporter_user_id}`;
    const userReportCount = await this.redisClient.incr(userRateKey);
    if (userReportCount === 1) {
      await this.redisClient.expire(userRateKey, 86400);
    }
    if (userReportCount > 1) {
      logger.warn({ user_id: sub.reporter_user_id }, '[Takedown] User rate limit exceeded');
      return { status: 'queued', trust_score: 0 };
    }

    // 2. Persist report to database audit table
    await this.dbPool.query(
      `INSERT INTO dpmaps.takedown_reports (
        poi_id, reporter_user_id, reporter_trust_score, report_reason, report_details, status
      ) VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [sub.poi_id, sub.reporter_user_id, trustScore, sub.reason, sub.details || null]
    );

    // 3. Low-trust report: queue without incrementing auto-hide counter
    if (trustScore < 70) {
      return { status: 'queued', trust_score: trustScore };
    }

    // 4. High-trust report: increment Redis place counter
    const placeCounterKey = `dpmaps:takedown:place_reports:${sub.poi_id}`;
    const reportCount = await this.redisClient.sAdd(placeCounterKey, sub.reporter_user_id);
    await this.redisClient.expire(placeCounterKey, 86400);

    const distinctVerifiedReports = await this.redisClient.sCard(placeCounterKey);

    // 5. Auto-Hide Threshold Check (>= 3 verified reports within 24 hours)
    if (distinctVerifiedReports >= 3) {
      await this.suppressionService.executeEmergencySuppression({
        poi_id: sub.poi_id,
        reason: sub.reason === 'privacy_residential' ? 'privacy_residential' : 'fraud_sabotage',
        requester_type: 'auto_hide',
        notes: `Auto-hidden via ${distinctVerifiedReports} independent verified reports`
      });

      await this.dbPool.query(
        `UPDATE dpmaps.takedown_reports 
         SET status = 'auto_hidden' 
         WHERE poi_id = $1 AND status = 'pending'`,
        [sub.poi_id]
      );

      return { status: 'auto_hidden', trust_score: trustScore };
    }

    return { status: 'queued', trust_score: trustScore };
  }
}
```

---

## 7. Priority Human Moderation Queue & One-Step Rollback

### 7.1 Moderation Queue Workflow (<4 Hour Review SLA)
All auto-hidden locations immediately create an escalated ticket in the dpMaps Admin Portal:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        DPMAPS PRIORITY MODERATION QUEUE                                │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Entity ID: 8f4e2b10-6c9a-412d-98e3-0c1a9f0e4b88   | Status: AUTO-HIDDEN (2h remaining) │
│ Canonical Name: "Khan Mansion"                    | Point Type: building               │
│ Location: Sector 11, Uttara, Dhaka                | 90-Day Trips: 28 riders / 8 drivers│
│                                                                                        │
│ Takedown Reports (3 Verified):                                                         │
│ 1. User #4812 (Score: 85): "This is a private home, not a commercial venue."           │
│ 2. User #9102 (Score: 70): "Owner requested removal of residential building name."    │
│ 3. User #1194 (Score: 90): "Private residential house."                                │
│                                                                                        │
│ [ Action 1: Confirm Takedown ] ──► Permanently marks suppressed, decouples queries.    │
│ [ Action 2: Restore Place ]    ──► Restores to public_pois, applies strike to abusers. │
│ [ Action 3: Anonymize Name ]   ──► Edits canonical_name to coarse landmark/intersection│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **SLA Alerting:** If an auto-hidden ticket remains unreviewed after **3 hours**, an automated PagerDuty alert notifies the on-call geospatial SRE.
- **Abuse Penalty Feedback:** If an admin determines a takedown campaign was coordinated commercial sabotage, the reporting accounts receive an abuse strike (`prior_abuse_strikes += 1`), zeroing out their trust scores across future reports.

### 7.2 One-Step Release Rollback Protocol
If an entire monthly publication manifest (`vYYYY.MM.BUILD`) exhibits widespread naming defects or unintended leaks:
```bash
# SRE Emergency Rollback Command
npm run dpmaps:release -- --rollback-to pub-2026-10-01 --reason "Emergency rollback: naming anomaly"
```

1. **Atomic Pointer Switch:** Updates `platform_config.active_release_id` to the previous manifest snapshot in PostgreSQL.
2. **MeiliSearch Fast Swap:** Re-points MeiliSearch index alias to the backup index snapshot matching the rollback manifest.
3. **Suppression Invariant:** The Redis suppression set `dpmaps:suppression:active_place_ids` is **NOT cleared**. All emergency takedowns executed since the rollback release remain actively suppressed, preventing revived privacy leaks.

---

## 8. Unit Testing Matrix & Privacy Verification

| Test Case | Scenario / Parameters | Expected Outcome | Rationale |
|---|---|:---:|---|
| **TC-011-01** | Query with residential flat (*"Flat 4B"*) | **DROPPED** | Class 1 invariant: Unit specifics never enter public ledger. |
| **TC-011-02** | Query with personal relation (*"Mamur bari"*) | **PRIVATE ONLY** | Class 2 invariant: Routed to private user history only. |
| **TC-011-03** | Building with 12 distinct riders over 90 days | **UNINDEXED** | Convergence Rule: Fails 15-rider minimum threshold. |
| **TC-011-04** | Building with 22 riders across 4 weeks | **INDEXED** | Convergence Rule: Passes diversity and temporal spread. |
| **TC-011-05** | Unverified account submits takedown report | **QUEUED (NO AUTO-HIDE)** | Trust score = 0 (fails phone verification gate). |
| **TC-011-06** | 1 High-trust report filed | **QUEUED (NO AUTO-HIDE)** | Threshold requires $\ge 3$ verified reports within 24 hours. |
| **TC-011-07** | 3 High-trust reports within 24 hours | **AUTO-HIDDEN (<60s)** | Hits threshold: Instant Redis suppression & MeiliSearch delete. |
| **TC-011-08** | Reporter files 2 reports in 24 hours | **RATE LIMITED** | Global rate limit: Max 1 report per user per 24 hours. |
| **TC-011-09** | Restoring suppressed POI via admin tool | **RESTORED** | Cleared from Redis Set, re-indexed into MeiliSearch. |
| **TC-011-10** | Release rollback executed | **ROLLBACK SUCCESSFUL** | Manifest reverts; active suppression set preserved. |

---

## 9. Deliverables & Definition of Done

- [ ] **Privacy Ingestion Guardrails:** Automated regex filters deployed in query pipeline blocking unit numbers, phone numbers, and personal relationship markers.
- [ ] **Database Schemas:** Tables `dpmaps.suppressions` and `dpmaps.takedown_reports` deployed with index optimization.
- [ ] **Emergency Suppression Service:** `EmergencySuppressionService` implemented and verified, achieving edge suppression in $< 60\text{ seconds}$ across Redis and MeiliSearch.
- [ ] **Reporter Trust Gatekeeper:** `TakedownGatekeeper` implemented enforcing phone verification, account age, completed rides, and anti-sabotage rate limits.
- [ ] **Admin Moderation Queue:** Dashboard operational with $< 4\text{ hour}$ review SLA tracking and PagerDuty escalation.
- [ ] **Rollback Runbook:** One-step release manifest rollback script tested in staging, confirming suppression set preservation.
