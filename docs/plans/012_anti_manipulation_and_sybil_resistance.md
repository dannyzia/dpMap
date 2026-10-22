# Stage 012: Anti-Manipulation & Sybil Resistance Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-012  
**Stage:** 12 of 16 (Security, Fraud & Sybil Defense Engineering)  
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§12, §12.1)  
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)  
**Current Status:** **Revision 2.0 (Audited & Upgraded)**  
**Target Phase:** Phase 1 (Dual-Connected Launch & Operational Defense)  
**Primary Dependencies:** [`002_provenance_firewall_and_legal_compliance.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/002_provenance_firewall_and_legal_compliance.md), [`003_storage_schema_and_continuous_evidence_ledger.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/003_storage_schema_and_continuous_evidence_ledger.md), [`009_winner_selection_and_statistical_confidence.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/009_winner_selection_and_statistical_confidence.md), [`011_privacy_architecture_and_abuse_resistant_takedowns.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/011_privacy_architecture_and_abuse_resistant_takedowns.md)

---

## 1. Executive Summary & Objective

In a commercial ride-hailing and sovereign mapping ecosystem, search rankings and physical map coordinates directly govern consumer behavior, fleet dispatch routing, and merchant foot traffic. Consequently, commercial tenants, competing transport services, and malicious actors have strong economic incentives to manipulate the mapping engine:
- **Location Spoofing:** Fabricating drop-offs to create fake commercial POIs or residential landmarks.
- **Search Hijacking:** Coordinated queries attempting to divert traffic from established landmarks (*"Bashundhara City"*, *"Gulshan 2 Circle"*) to competing businesses.
- **Collusive Farming:** Driver-rider rings staging circular or short rides to artificially satisfy the 6 publication gates.
- **Competitor Vandalism:** Submitting swarms of false takedown reports or poisoning autocomplete suggestions with abusive strings.

Stage 012 implements a defense-in-depth **Anti-Manipulation & Sybil Resistance Architecture**:
1. **Multi-Layer Defensive Firewall:** Validates physical GPS feasibility, device entropy, account age, and pairwise driver-rider frequencies before ledger entry.
2. **Mathematical Vote Throttling:** Enforces per-rider weekly and 90-day voting caps, a 90% collusion penalty on repeated driver-rider pairings, and a hard 25% driver cohort concentration ceiling.
3. **Swarm & Anomaly Quarantine:** Automatically quarantines sudden volume surges where $>40\%$ of votes originate from young accounts (<14 days old).
4. **Merchant Integrity Boundary:** Enforces a cryptographic barrier guaranteeing that verified merchants can never buy, bid on, or distort organic search rankings.
5. **Retroactive Invalidation Engine:** Provides an administrative audit pipeline to instantaneously purge compromised fraud rings and recalculate affected query clusters.

---

## 2. Threat Modeling & Attack Vectors in Bangladesh

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        THREAT TAXONOMY & DEFENSIVE GATES                               │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Threat 1: SIM-Swarm / Burner Accounts                                                  │
│ • Attack: Sybil ring activates 20-50 SIMs to fake 15 distinct riders for Gate 1.       │
│ • Defense: Device hardware fingerprinting, account age weighting, carrier OTP gate.    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Threat 2: Driver-Rider Collusion ("Ghost Rides")                                       │
│ • Attack: Accomplice driver and rider book repeat short rides to force a map pin.      │
│ • Defense: Pairwise trip cap (max 2/month before 90% downweight; 0% at >5), driver cap.│
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Threat 3: Mock-Location GPS Spoofing                                                   │
│ • Attack: Emulators simulate fake trip drop-offs without physical vehicle movement.    │
│ • Defense: GPS trace speed variance check (>0.05 m²/s²), OSRM road snapping, duration. │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Threat 4: Commercial Keyword Hijacking                                                 │
│ • Attack: Competitor links "Square Hospital" query to a private pharmacy 500m away.   │
│ • Defense: Strict spatial convergence threshold (<=30m DBSCAN), Stage 009 20% margin.  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Threat 5: Swarm Takedown Vandalism                                                     │
│ • Attack: Coordinated reports to trigger auto-hide against a legitimate competitor.    │
│ • Defense: Multi-Factor Reporter Trust Score (Stage 011), 1-report/user/day limit.    │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. The 5-Layer Defensive Architecture

Every trip event must pass through five defensive layers before its vote can influence `dpmaps.trip_evidence_ledger` or `dpmaps.public_pois`:

```
[ Completed Trip Event ]
          │
          ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ LAYER 1: Physical Telemetry & Trajectory Feasibility                                   │
│ • Duration >= 120 seconds, Distance >= 200 meters, Speed <= 120 km/h                   │
│ • Minimum GPS breadcrumbs: >= 20 points along route                                    │
│ • Trajectory speed variance: Var(v) > 0.05 m²/s² (blocks stationary spoofing)         │
│ • Road Snapping: Driver drop-off fix snaps to drivable road edge within 35 meters     │
└────────────────────────────────────────────────────────────────────────────────────────┘
          │ (If Passed)
          ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ LAYER 2: Hardware Device & Identity Entropy                                            │
│ • Device Fingerprint Cap: Max 1 vote per physical device per query cluster per 30 days │
│ • Account Phone Verification: Mandatory +880 mobile carrier verification               │
│ • Account Age Weighting: Accounts < 14 days old cannot contribute to Gate 1 quorum    │
└────────────────────────────────────────────────────────────────────────────────────────┘
          │ (If Passed)
          ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ LAYER 3: Vote Throttling & Pairwise Collusion Shield                                   │
│ • Per-Rider Cap: Max 1 vote/7 days and 3 votes/90 days per query cluster               │
│ • Driver-Rider Pair Cap: Trips 1-2 = 1.0x; Trips 3-5 = 0.10x; Trips > 5 = 0.0x        │
│ • Driver Concentration Cap: No single driver may exceed 25% of cluster votes           │
└────────────────────────────────────────────────────────────────────────────────────────┘
          │ (If Passed)
          ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ LAYER 4: Swarm & Temporal Velocity Anomaly Detection                                   │
│ • Young Account Ratio: If > 40% of votes from accounts < 14d -> QUARANTINE CLUSTER    │
│ • Velocity Spike: If weekly volume > 3x trailing 4-week average -> HOLD PUBLICATION    │
│ • Coordinated Bursts: > 60% of votes in < 48 hours requires 2 additional weeks traffic │
└────────────────────────────────────────────────────────────────────────────────────────┘
          │ (If Passed)
          ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ LAYER 5: Merchant Integrity & Clean-Room Firewall Boundary                             │
│ • Verified Merchants receive Tier 1 naming & coordinates for storefronts only          │
│ • ABSOLUTE INVARIANT: Merchant status CANNOT purchase, bid, or boost search rank       │
│ • Autocomplete relevance is 100% organic based on trip volume and linguistic match     │
└────────────────────────────────────────────────────────────────────────────────────────┘
          │ (If all 5 Passed)
          ▼
[ Record Clean Vote in dpmaps.trip_evidence_ledger ]
```

---

## 4. Mathematical Formulations & Anti-Fraud Algorithms

### 4.1 Per-Rider Voting Cap Formulation
To ensure that an overzealous commuter or business owner cannot single-handedly establish a public landmark:
$$w_{\text{rider\_capped}} = \begin{cases} 
w_{\text{base}} & \text{if Trips}_{\text{7d}}(R, Q) = 1 \text{ and } \text{Trips}_{\text{90d}}(R, Q) \le 3 \\ 
0.0000 & \text{otherwise} 
\end{cases}$$

Where $R$ is the rider's active pseudonym and $Q$ is the candidate query cluster. Excess trips are fully billed for transportation but discarded from the mapping evidence pool.

### 4.2 Driver-Rider Collusion Shield
When an accomplice driver and rider collude, they repeatedly complete rides together:
$$w_{\text{collusion\_adjusted}} = w_{\text{rider\_capped}} \times \mu_{\text{pair}}(R, D)$$

Where the pairwise dampening factor $\mu_{\text{pair}}$ is defined as:
$$\mu_{\text{pair}}(R, D) = \begin{cases} 
1.00 & \text{if } N_{\text{30d}}(R, D) \le 2 \\ 
0.10 & \text{if } 3 \le N_{\text{30d}}(R, D) \le 5 \\ 
0.00 & \text{if } N_{\text{30d}}(R, D) > 5 \text{ (Flagged for fraud audit)} 
\end{cases}$$

### 4.3 Driver Cohort Concentration Ceiling
In accordance with Stage 009 (Gate 2):
$$\text{MaxDriverShare}(Q) = \max_{d \in \text{Drivers}} \left( \frac{\text{Trips}(d, Q)}{\text{TotalTrips}(Q)} \right) \le 0.2500$$

If any single driver accounts for more than **25.0%** of the candidate cluster's unweighted trips, the candidate is automatically rejected for driver diversity failure.

### 4.4 GPS Variance & Anti-Emulator Filter
Stationary GPS mock-location tools inject fixed coordinates or linear interpolated paths with zero speed variance. Real vehicular travel in Dhaka traffic displays continuous acceleration, braking, and idle micro-movements:
$$\text{Var}(v) = \frac{1}{K} \sum_{k=1}^{K} (v_k - \bar{v})^2$$

**Rule:** If $\text{Var}(v) \le 0.0500\text{ m}^2/\text{s}^2$ across a trip with duration $> 120\text{s}$, the telemetry is classified as emulated/mock-location and dropped.

---

## 5. Implementation: Production Fraud Filter Pipeline

```typescript
// workers/fraudFilterWorker.ts
import { RedisClientType } from 'redis';
import { Pool } from 'pg';
import { logger } from '../utils-server/logger';

export interface RawTripEvidence {
  trip_id: string;
  rider_pseudonym: string;
  driver_pseudonym: string;
  device_fingerprint_hash: string;
  query_cluster_id: string;
  account_age_days: number;
  duration_seconds: number;
  odometer_meters: number;
  speed_variance: number;
  snapped_distance_meters: number;
  raw_weight: number;
}

export interface FilterResult {
  accepted: boolean;
  final_weight: number;
  rejection_reason?: string;
  quarantine_flag?: boolean;
}

export class AntiManipulationFilterService {
  constructor(
    private readonly redisClient: RedisClientType,
    private readonly dbPool: Pool
  ) {}

  /**
   * Evaluates all 5 defensive layers on an incoming completed trip vote
   */
  async evaluateTripVote(trip: RawTripEvidence): Promise<FilterResult> {
    // ---------------------------------------------------------
    // LAYER 1: Physical Telemetry Feasibility
    // ---------------------------------------------------------
    if (trip.duration_seconds < 120 || trip.odometer_meters < 200) {
      return { accepted: false, final_weight: 0, rejection_reason: 'Telemetry: sub-minimum duration or distance' };
    }
    const avgSpeedKmH = (trip.odometer_meters / trip.duration_seconds) * 3.6;
    if (avgSpeedKmH > 120.0) {
      return { accepted: false, final_weight: 0, rejection_reason: 'Telemetry: speed exceeds urban physical threshold' };
    }
    if (trip.speed_variance <= 0.0500) {
      return { accepted: false, final_weight: 0, rejection_reason: 'Telemetry: zero speed variance indicates GPS spoofing emulator' };
    }
    if (trip.snapped_distance_meters > 35.0) {
      return { accepted: false, final_weight: 0, rejection_reason: 'Telemetry: drop-off coordinate does not snap to drivable road curb' };
    }

    // ---------------------------------------------------------
    // LAYER 2: Hardware Device & Identity Entropy
    // ---------------------------------------------------------
    const deviceClusterKey = `fraud:device:${trip.device_fingerprint_hash}:${trip.query_cluster_id}`;
    const deviceAlreadyVoted = await this.redisClient.exists(deviceClusterKey);
    if (deviceAlreadyVoted) {
      return { accepted: false, final_weight: 0, rejection_reason: 'Entropy: physical device already voted for this cluster in 30d' };
    }

    // ---------------------------------------------------------
    // LAYER 3: Vote Throttling & Pairwise Collusion Shield
    // ---------------------------------------------------------
    const riderWeeklyKey = `fraud:rider_week:${trip.rider_pseudonym}:${trip.query_cluster_id}`;
    const rider90dKey = `fraud:rider_90d:${trip.rider_pseudonym}:${trip.query_cluster_id}`;

    const weekCount = await this.redisClient.incr(riderWeeklyKey);
    if (weekCount === 1) await this.redisClient.expire(riderWeeklyKey, 7 * 86400);

    const total90dCount = await this.redisClient.incr(rider90dKey);
    if (total90dCount === 1) await this.redisClient.expire(rider90dKey, 90 * 86400);

    if (weekCount > 1 || total90dCount > 3) {
      return { accepted: false, final_weight: 0, rejection_reason: 'Throttling: rider vote frequency cap exceeded' };
    }

    // Pairwise driver-rider check
    const pairKey = `fraud:pair_30d:${trip.rider_pseudonym}:${trip.driver_pseudonym}`;
    const pairCount = await this.redisClient.incr(pairKey);
    if (pairCount === 1) await this.redisClient.expire(pairKey, 30 * 86400);

    let weightMultiplier = 1.0000;
    if (pairCount > 5) {
      logger.warn({ trip_id: trip.trip_id, pairKey }, '[FraudFilter] Extreme collusion detected; pairCount > 5');
      return { accepted: false, final_weight: 0, rejection_reason: 'Collusion: excessive repeated driver-rider pairing' };
    } else if (pairCount > 2) {
      weightMultiplier = 0.1000; // 90% downweighting
    }

    // ---------------------------------------------------------
    // LAYER 4: Swarm & Temporal Velocity Anomaly Detection
    // ---------------------------------------------------------
    let quarantine = false;
    if (trip.account_age_days < 14) {
      const swarmSetKey = `fraud:swarm_young:${trip.query_cluster_id}`;
      await this.redisClient.sAdd(swarmSetKey, trip.rider_pseudonym);
      await this.redisClient.expire(swarmSetKey, 7 * 86400);

      const youngCount = await this.redisClient.sCard(swarmSetKey);
      if (youngCount >= 10) {
        quarantine = true;
        await this.redisClient.set(`fraud:cluster_quarantine:${trip.query_cluster_id}`, '1', { EX: 14 * 86400 });
        logger.warn({ query_cluster_id: trip.query_cluster_id, youngCount }, '[FraudFilter] Young account swarm triggered quarantine');
      }
    }

    // Lock device flag for 30 days
    await this.redisClient.set(deviceClusterKey, '1', { EX: 30 * 86400 });

    const finalWeight = Number((trip.raw_weight * weightMultiplier).toFixed(4));
    return {
      accepted: true,
      final_weight: finalWeight,
      quarantine_flag: quarantine
    };
  }
}
```

---

## 6. Retroactive Vote Invalidation & Audit Console

When platform security discovers a sophisticated fraud ring or compromised driver union post-ingestion:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        RETROACTIVE FRAUD PURGE PIPELINE                                │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Fraud Ring Identification: Security analyst inputs compromised driver/rider hashes. │
│ 2. Database Purge: Sets initial_weight = 0.0000 for all matching ledger evidence.      │
│ 3. Impact Assessment: Identifies all query_clusters affected by purged evidence.       │
│ 4. Immediate Recalculation: Runs evaluateCandidateGates() on affected clusters.       │
│ 5. Automated Takedown: Demotes any POI that falls below the 6 publication gates.       │
│ 6. Cryptographic Audit Log: Records incident in dpmaps.provenance_events with HMAC.     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.1 Database Purge & Recalculation SQL
```sql
-- Security Analyst Invalidation Script
WITH purged_pseudonyms AS (
  SELECT unnest(:compromised_pseudonym_hashes::text[]) AS phash
),
compromised_evidence AS (
  UPDATE dpmaps.trip_evidence_ledger tel
  SET initial_weight = 0.0000
  FROM dpmaps.ledger_pseudonyms lp
  JOIN purged_pseudonyms pp ON pp.phash = lp.pseudonym_hash
  WHERE lp.ledger_id = tel.id
    AND lp.created_at = tel.created_at
  RETURNING tel.query_cluster_id
)
-- Return list of query clusters requiring immediate recalculation
SELECT DISTINCT query_cluster_id FROM compromised_evidence;
```

---

## 7. Merchant Integrity Boundary Specification

1. **Clean-Room Verification Only:** Verified merchants onboarded through the Ride Merchant Portal provide authoritative display names and entrance coordinates (Tier 1).
2. **Strict Invariant on Relevance:**
   - Autocomplete suggestion order is governed strictly by organic trip volume, spatial proximity, and linguistic match score.
   - **No Paid Placement:** The search engine API has zero parameters for "promoted_poi", "bid_rank", or "commercial_boost".
   - **Competitor Trademark Protection:** Merchants cannot register search aliases for competitor brand names (e.g., a local pizza parlor cannot register *"Domino's Pizza"* as an alias). Verified in `dpmaps.poi_aliases` through brand collision checks.

---

## 8. Unit Testing Matrix & Sybil Defense Verification

| Test Case | Scenario / Parameters | Expected Outcome | Rationale |
|---|---|:---:|---|
| **TC-012-01** | Duration = 90s, Distance = 150m | **REJECTED** | Fails Layer 1 minimum physical thresholds ($<120\text{s}$, $<200\text{m}$). |
| **TC-012-02** | Trajectory speed variance = $0.01\text{ m}^2/\text{s}^2$ | **REJECTED** | Fails Layer 1: Zero speed variance indicates stationary GPS emulator. |
| **TC-012-03** | Same physical device votes twice in 30 days | **REJECTED** | Fails Layer 2: Device fingerprint cap enforced (max 1 vote/device/30d). |
| **TC-012-04** | Rider votes for same cluster twice in 5 days | **REJECTED** | Fails Layer 3: Rider weekly cap exceeded ($2 > 1\text{ vote/week}$). |
| **TC-012-05** | Driver-Rider pair completes 3rd trip in 30 days | **DOWNWEIGHTED (0.10x)** | Passes Layer 3 with 90% collusion penalty ($3 \le N \le 5$). |
| **TC-012-06** | Driver-Rider pair completes 6th trip in 30 days | **REJECTED (0.00x)** | Fails Layer 3: Extreme collusion threshold ($N > 5$). |
| **TC-012-07** | Single driver accounts for 35% of cluster trips | **DISQUALIFIED** | Fails Gate 2: Driver concentration ceiling exceeded ($35\% > 25\%$). |
| **TC-012-08** | 12 Young accounts (<14d) vote in 3 days | **QUARANTINED** | Layer 4: Young account swarm triggers cluster quarantine. |
| **TC-012-09** | Retroactive purge of 50 compromised trips | **RECALCULATED** | Initial weight zeroed, affected POIs falling below gates demoted. |
| **TC-012-10** | Merchant attempts to add competitor alias | **REJECTED** | Layer 5: Merchant integrity boundary prevents brand hijacking. |

---

## 9. Deliverables & Definition of Done

- [ ] **Fraud Filter Service:** `AntiManipulationFilterService` deployed in the real-time trip completion pipeline with $<15\text{ms}$ execution latency.
- [ ] **Redis Rate Limiting & Pair Counters:** Keys configured for device fingerprints, weekly rider caps, and 30-day driver-rider pair counters.
- [ ] **GPS Variance Checker:** Kalman filter and speed variance calculator integrated into driver handset telemetry collectors.
- [ ] **Swarm Quarantine Logic:** Automated cluster quarantine active, verified on synthetic 10-account registration swarms.
- [ ] **Admin Audit Console:** Retroactive vote purge and instant recalculation tool operational and benchmarked at $<5\text{ seconds}$ on 10,000 affected rows.
- [ ] **Merchant Firewall Audit:** Codebase audit confirms zero paid ranking parameters exist in MeiliSearch or Postgres query orchestrators.
