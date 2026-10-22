# Stage 009: Winner Selection & Statistical Confidence Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-009  
**Stage:** 9 of 16 (Learning Engine & Publication Statistics)  
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§4, §5.1–5.4, §7.1–7.2, §8.1–8.3)  
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)  
**Current Status:** **Revision 2.0 (Audited & Upgraded)**  
**Target Phase:** Phase 2 (The Routing Switch Flip / Autonomous Learning)  
**Primary Dependencies:** [`002_provenance_firewall_and_legal_compliance.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/002_provenance_firewall_and_legal_compliance.md), [`003_storage_schema_and_continuous_evidence_ledger.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/003_storage_schema_and_continuous_evidence_ledger.md), [`007_text_normalization_and_alias_clustering.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/007_text_normalization_and_alias_clustering.md), [`008_search_engine_meilisearch_and_mixed_autocomplete.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/008_search_engine_meilisearch_and_mixed_autocomplete.md)

---

## 1. Executive Summary & Objective

In crowdsourced map learning, naive majority voting is inherently fatal. If 50 riders search for a university campus and the driver stops at a convenient tea stall 250 meters away on a busy thoroughfare, a naive majority vote algorithm would publish the tea stall as the university gate. Furthermore, single-cycle voting causes spatial oscillation, where competing locations alternate month-to-month, corrupting user bookmarks, saved routes, and dispatch reliability.

Stage 009 implements a sovereign, mathematically verified **Winner Selection & Publication Engine** that converts raw, append-only completed trip evidence into high-confidence physical points of interest (`public_pois`).

### Key Architectural Upgrades in Revision 2.0
1. **Three-Layer Learning Engine Decoupling:** Enforces strict isolation between **Relevance (Layer 1)**, **Spatial Identity (Layer 2)**, and **Display Name (Layer 3)**. Passenger trip votes determine *where* vehicles stop; they never independently dictate *how places are named*.
2. **Elimination of UUIDv5 Conflation:** Fully aligns with Stage 003's schema. Discards fragile `UUIDv5(h3 + canonical_name)` hashing in favor of immutable random UUIDv4 (`gen_random_uuid()`), preserving bookmark integrity when names or curb coordinates are refined, with lineage tracked via `dpmaps.poi_versions` and `superseded_by_id`.
3. **Exact 120-Day Deduplication Key Integration:** Connects Gate 1 distinct rider counts directly to Stage 003’s 120-day key schedule in `dpmaps.ledger_pseudonyms`, completely eliminating the 1.6×–2.3× overcounting defect caused by naive 30-day key rotation boundaries.
4. **Spatial Pre-Clustering & Hex Boundary Splitting Prevention:** Resolves H3 cell boundary splitting using PostGIS spatial clustering (`ST_ClusterDBSCAN` with $\varepsilon = 30\text{m}$) and H3 1-ring consolidation before evaluating vote dominance, preventing split-vote rejection at entrance gates that straddle hexagonal borders.
5. **Zero-Write-Amplification Query-Time Exponential Decay:** Evaluates time decay ($\lambda = \ln(2)/45 \approx 0.01540327/\text{day}$) dynamically at query time in PostgreSQL without mutating millions of partitioned ledger rows.
6. **Kish Effective Sample Size ($n_{\text{eff}}$) & Wilson Score Interval:** Calculates the exact 95% Wilson Score lower bound ($W_{\text{lower}} > 0.50$) using Kish effective sample size to penalize decayed and low-sample vote distributions.
7. **Two-Cycle Challenger Stability Engine:** Protects published places against rapid oscillation by requiring challenging spatial clusters to satisfy all 6 gates across **two consecutive monthly publication cycles** before unseating an incumbent.
8. **Anti-Collusion & Sybil Defense Layer:** Enforces pairwise rider-driver trip caps, maximum driver cohort contribution caps ($\le 25\%$), minimum trajectory duration/distance filters, and integration with `dpmaps.suppressions`.

---

## 2. The Three-Layer Learning Engine

The dpMaps search architecture is fundamentally decomposed into three independent, decoupled operational layers:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        THE THREE-LAYER LEARNING ENGINE                                 │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Layer 1: Query-to-Place Association (Relevance Engine)                                 │
│ • Maps what riders type ("dhan 27", "dhanmondi shonchita", "rd 27") to Place IDs.       │
│ • Governed by rider trip votes, phonetic sound keys, and prefix trees.                 │
│ • Decides: "Which candidate entities match this search intent and ranking order?"      │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Layer 2: Place Identity (Spatial Entity Engine)                                        │
│ • Defines distinct physical locations in the physical world via spatial clustering.    │
│ • Stores precise curb coordinates, H3 indices (res 9 & 10), and point_type.            │
│ • Decides: "Is there a distinct, recurring destination here, and where do cars stop?"   │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Layer 3: Display Name (Publication & Presentation Engine)                              │
│ • Formats what is publicly shown in the client autocomplete list and map canvas.       │
│ • Decided strictly by Stage 010's 4-Tier Authority Hierarchy:                          │
│     Tier 1: Pin Tool survey & merchant onboarded names (Highest Trust)                 │
│     Tier 2: Post-trip verification label prompt submissions                             │
│     Tier 3: Formatted canonical query (cased, spellchecked, abuse-filtered)             │
│     Tier 4: Ephemeral vendor passthrough (never stored) / coarse centroid               │
│ • Decides: "What is the canonical, verified, culturally correct name for this place?"  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### The Cardinal Rule of dpMaps Learning
> **Trip votes primarily power Layer 1 (Relevance), partly establish Layer 2 (Identity), and NEVER alone decide Layer 3 (Display Name).**  
> Passenger drop-offs tell the engine *where people travel*; they cannot authoritatively determine *how a place should be named or published*. A cluster of 100 trips to an entrance establishes that a destination exists at those coordinates; the name assigned to that entity must be verified through the Stage 010 authority hierarchy.

---

## 3. Atomic Vote Definition & Ingestion Safeguards

### 3.1 The Atomic Vote Unit
An atomic vote in `dpmaps.trip_evidence_ledger` is formally defined as:
$$\text{Vote} = \langle Q_{\text{cluster}}, \text{DropoffPoint}(lat, lng), C_{\text{trip}}, w_{\text{base}}, t_{\text{completion}} \rangle$$

Where:
- $Q_{\text{cluster}}$: The normalized query cluster ID derived from rider keystrokes before autocomplete selection (conforming to Stage 007 text normalization).
- $\text{DropoffPoint}(lat, lng)$: The physical GPS coordinate fix from the driver handset at the moment of passenger drop-off, Kalman filtered, speed-variance checked, and snapped to the nearest road curb.
- $C_{\text{trip}}$: The cryptographic trip hash (`trip_hash = HMAC-SHA256(order_id, WindowSecretKey)`), decoupling the evidence from raw operational order tables.
- $w_{\text{base}}$: Base vote weight:
  - **Full Query Vote ($1.00\times$):** Rider typed $\ge 4$ characters or selected an unprompted match. Powers Layer 1 and Layer 2.
  - **Prefix-Only Vote ($0.35\times$):** Rider typed $\le 3$ characters (e.g., *"dha"*) and tapped an early autocomplete suggestion. Powers **Layer 1 relevance only**; cannot establish Layer 2 spatial identity or trigger POI creation.
  - **Merchant Verified Trip ($1.25\times$):** Drop-off confirmed via merchant POS or geofenced physical QR code checkout.
- $t_{\text{completion}}$: Immutable completion timestamp, used for query-time exponential decay.

### 3.2 Pre-Ingestion Sanitization & Exclusion Pipeline
Every completed trip must pass the following multi-stage filter before insertion into `dpmaps.trip_evidence_ledger`. Disqualified trips are discarded immediately:

```
[ Completed Trip Event ]
          │
          ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. Trip Execution Check: Must be completed. Cancelled or in-trip rerouted = DROP       │
│ 2. Telemetry Realism: Duration >= 120s, Distance >= 200m, Speed <= 120 km/h = PASS    │
│ 3. GPS Integrity Check: GPS speed variance along trace > 0.05 m²/s² (anti-spoofing)    │
│ 4. PII & Structural Filter: 9+ digit phone numbers, personal names, flat/house = DROP   │
│ 5. Clean-Room Provenance: Zero vendor strings, IDs, or polylines present = PASS        │
│ 6. Suppression Blacklist: Checked against dpmaps.suppressions Bloom filter = PASS      │
└────────────────────────────────────────────────────────────────────────────────────────┘
          │
          ▼ (If all passed)
[ Ingest into dpmaps.trip_evidence_ledger + dpmaps.ledger_pseudonyms ]
```

### 3.3 Sybil & Collusion Resistance Rules
To prevent driver rings or coordinated groups from creating fictitious map entities or redirecting traffic:
1. **Pairwise Rider-Driver Cap:** In any 30-day window, a specific `(pseudonym_hash, driver_pseudonym_hash)` pair can contribute at most **1 vote** to any given `query_cluster_id`. Subsequent trips between the same rider and driver are recorded with `initial_weight = 0.0000`.
2. **Driver Cohort Dominance Cap:** No single driver account may represent more than **$25\%$** of the unweighted votes in a candidate spatial cluster. If Driver $D_1$ accounts for 8 of 20 votes ($40\%$), the cluster is flagged as collusive and disqualified from publication.
3. **Temporal Burst Suppression:** If more than **$60\%$** of a candidate cluster's lifetime votes arrive within a single 48-hour window, the cluster is quarantined in `candidate` status and requires an additional **2 consecutive weeks** of sustained traffic before publication can be considered.

---

## 4. Spatial Pre-Clustering & Hex Boundary Consolidation

### 4.1 The Hexagon Boundary Splitting Problem
Uber H3 Resolution 10 cells have an average area of **$15,047\text{ m}^2$** (~1.5 hectares) with an average edge length of **$65.9\text{ meters}$** and diameter of ~**$132\text{ meters}$**. 

A major shopping center entrance, hospital gate, or university drop-off curb frequently sits directly on or near the boundary between two adjacent H3 resolution-10 hexagons:

```
          Hexagon A (Res 10)                 Hexagon B (Res 10)
     ┌─────────────────────────┐        ┌─────────────────────────┐
     │                         │        │                         │
     │      55 Drop-offs       │  Curb  │      45 Drop-offs       │
     │      (55% share)        │ ══════ │      (45% share)        │
     │                         │  Gate  │                         │
     └─────────────────────────┘        └─────────────────────────┘
```

If evaluated on raw `h3_res10` strings:
- Hexagon A has 55% vote share $\rightarrow$ **Fails Gate 4 ($\ge 70\%$)**.
- Hexagon B has 45% vote share $\rightarrow$ **Fails Gate 4 ($\ge 70\%$)**.
- Margin of victory is $55\% - 45\% = 10\%$ $\rightarrow$ **Fails Gate 5 ($\ge 20\%$)**.
- **Outcome:** The system falsely rejects a legitimate destination where 100% of riders arrived at the exact same physical curb gate!

### 4.2 DBSCAN Density Pre-Clustering Pipeline
Before evaluating the 6 publication gates, the winner selection worker executes spatial consolidation on all drop-off points for the candidate query cluster:

```sql
-- Consolidate dropoff points within 30 meters using PostGIS ST_ClusterDBSCAN
WITH query_votes AS (
  SELECT 
    tel.id AS evidence_id,
    tel.dropoff_geom,
    tel.h3_res10,
    tel.initial_weight * EXP(-0.01540327 * (EXTRACT(EPOCH FROM (:eval_cutoff - tel.created_at)) / 86400.0)) AS decayed_weight,
    lp.pseudonym_hash,
    lp.driver_pseudonym_hash,
    TO_CHAR(tel.created_at, 'IYYY-IW') AS cal_week
  FROM dpmaps.trip_evidence_ledger tel
  JOIN dpmaps.ledger_pseudonyms lp 
    ON lp.ledger_id = tel.id AND lp.created_at = tel.created_at
  WHERE tel.query_cluster_id = :query_cluster_id
    AND lp.key_id = :anchor_key_id
    AND tel.created_at >= :eval_cutoff - INTERVAL '90 days'
    AND tel.created_at < :eval_cutoff
),
clustered AS (
  SELECT 
    qv.*,
    ST_ClusterDBSCAN(qv.dropoff_geom, eps := 0.0003, minpoints := 1) OVER () AS cluster_id
  FROM query_votes qv
)
SELECT 
  cluster_id,
  ST_Centroid(ST_Collect(dropoff_geom)) AS cluster_centroid,
  ST_ClosestPoint(ST_Collect(dropoff_geom), ST_Centroid(ST_Collect(dropoff_geom))) AS representative_dropoff,
  COUNT(DISTINCT pseudonym_hash) AS distinct_riders,
  COUNT(DISTINCT driver_pseudonym_hash) AS distinct_drivers,
  COUNT(DISTINCT cal_week) AS calendar_weeks,
  SUM(decayed_weight) AS cluster_weighted_votes,
  SUM(POWER(decayed_weight, 2)) AS cluster_sum_sq_weights
FROM clustered
GROUP BY cluster_id;
```

#### Spatial Rules:
1. **Cluster Radius ($\varepsilon = 0.0003^\circ \approx 30\text{ meters}$):** Drop-offs within 30 meters along a curb are merged into a single spatial candidate.
2. **Anchor Hexagon Assignment:** The spatial cluster's primary `h3_res10` is assigned as the H3 cell containing the representative medoid/centroid.
3. **Competition Separation:** Only spatial clusters separated by $> 75\text{ meters}$ compete against each other as distinct candidate places.

---

## 5. The 6 Minimum Publication Thresholds

Before any candidate query-to-place association is promoted to `public_pois`, the leading spatial cluster must satisfy **all 6 mathematical publication gates simultaneously**:

```
                                  [ Leading Spatial Candidate ]
                                                │
       ┌────────────────────────────────────────┼────────────────────────────────────────┐
       ▼                                        ▼                                        ▼
 [ Gate 1: Distinct Riders ]              [ Gate 2: Distinct Drivers ]             [ Gate 3: Temporal Spread ]
 >= 15 unique pseudonyms                  >= 5 distinct drivers                    >= 3 separate calendar weeks
 (Evaluated under anchor key)             (Evaluated on distinct accounts)         (Eliminates viral single-day events)
       │                                        │                                        │
       └────────────────────────────────────────┼────────────────────────────────────────┘
                                                │
       ┌────────────────────────────────────────┴────────────────────────────────────────┐
       ▼                                        ▼                                        ▼
 [ Gate 4: Vote Share Dominance ]         [ Gate 5: Margin of Victory ]            [ Gate 6: Wilson Score ]
 >= 70% weighted vote share               >= 20 percentage points lead             W_lower > 0.50 (95% CI)
 (Decayed weights: λ = ln(2)/45)          over runner-up cluster                   using Kish n_eff sample size
```

### 5.1 Gate 1: Distinct Rider Diversity ($\ge 15$)
- **Requirement:** At least **15 distinct rider pseudonyms** must have completed trips to this spatial cluster within the 90-day window.
- **Deduplication Key Schedule Enforcement:** Evaluated strictly using the **anchor key** $K_{\text{anchor}}$ from `dpmaps.ledger_pseudonyms` (the key created $\ge 90$ days before evaluation cutoff). This guarantees zero double-counting across monthly key rotations.
- **Invariant:** Evaluated on unweighted, distinct pseudonym hashes, *never* on decayed weights.

### 5.2 Gate 2: Distinct Driver Diversity ($\ge 5$)
- **Requirement:** Trips to the cluster must involve at least **5 distinct driver accounts**.
- **Collusion Shield:** Evaluated on distinct `driver_pseudonym_hash` values under $K_{\text{anchor}}$. Furthermore, no single driver may account for $>25\%$ of the total cluster trips.

### 5.3 Gate 3: Temporal Spread ($\ge 3$ Calendar Weeks)
- **Requirement:** Trip completions must span at least **3 separate ISO calendar weeks** (`IYYY-IW`).
- **Rationale:** Protects against single-day or weekend viral spikes (e.g., a one-off concert, rally, or street fair that does not represent a permanent POI).

### 5.4 Gate 4: Vote Share Dominance ($\ge 70.0\%$)
- **Requirement:** The leading spatial cluster must capture at least **$70.0\%$** of the total time-decayed weighted votes cast for that query cluster:
  $$\hat{p} = \frac{W_{\text{leader}}}{W_{\text{total}}} \ge 0.7000$$
  where $W_{\text{leader}} = \sum_{i \in \text{leader}} w_i$ and $W_{\text{total}} = \sum_{i \in \text{all}} w_i$.

### 5.5 Gate 5: Margin of Victory ($\ge 20.0\%$)
- **Requirement:** The leading spatial cluster must hold at least a **20.0 percentage point lead** over the runner-up spatial cluster:
  $$\Delta_{\text{margin}} = \hat{p}_{\text{leader}} - \hat{p}_{\text{runner\_up}} \ge 0.2000$$
- **Ambiguity Rule:** If two competing destinations (e.g., "Bashundhara Gate 1" vs "Bashundhara Gate 2") hold 52% and 48% of votes, the margin is 4%. **The system publishes nothing and falls back to vendor passthrough.**dpMaps will never guess between ambiguous locations.

### 5.6 Gate 6: Wilson Score Interval Lower Bound ($W_{\text{lower}} > 0.50$)

#### 5.6.1 The Need for Kish Effective Sample Size ($n_{\text{eff}}$)
Because votes decay exponentially ($\lambda = \ln(2)/45 \approx 0.01540327/\text{day}$), raw sample size $n$ falsely inflates statistical confidence (e.g., 50 old votes with decayed weights of 0.05 carry the variance of only a few fresh votes). Stage 009 computes the **Kish effective sample size**:
$$n_{\text{eff}} = \frac{\left(\sum_{i=1}^{m} w_i\right)^2}{\sum_{i=1}^{m} w_i^2} = \frac{W_{\text{total}}^2}{S_{\text{total}}}$$

Where $W_{\text{total}}$ is the sum of decayed weights, and $S_{\text{total}}$ is the sum of squared decayed weights across all competing votes for the query cluster.

#### 5.6.2 Wilson Score Formulation
With 95% confidence level ($z = 1.96$):
$$W_{\text{lower}} = \frac{\hat{p} + \frac{z^2}{2 n_{\text{eff}}} - z \sqrt{\frac{\hat{p}(1 - \hat{p})}{n_{\text{eff}}} + \frac{z^2}{4 n_{\text{eff}}^2}}}{1 + \frac{z^2}{n_{\text{eff}}}}$$

**Publication Invariant:** Candidate is approved only if $W_{\text{lower}} > 0.5000$.

#### 5.6.3 Mathematical Synergy & Boundary Behavior
The 6 gates act in mathematical harmony:
| Scenario | $n_{\text{eff}}$ | Observed Share $\hat{p}$ | $W_{\text{lower}}$ | Gate Status | Explanation |
|---|:---:|:---:|:---:|:---:|---|
| Minimal Sample at Gate 4 Bound | 15.0 | 0.7000 (70%) | **0.448** | **REJECTED** | At exactly 15 effective votes and 70% share, sampling error is too wide. Requires $n_{\text{eff}} \ge 25$ to clear $W_{\text{lower}} > 0.50$. |
| Strong Consensus at Minimal Sample | 15.0 | 0.8500 (85%) | **0.604** | **PASSED** | Strong consensus allows publication at the 15-rider minimum. |
| Borderline Sample at High Dominance | 25.0 | 0.7000 (70%) | **0.504** | **PASSED** | With 25 effective votes, 70% dominance achieves statistical certainty ($>0.50$). |
| Large Sample with Weak Lead | 100.0 | 0.5500 (55%) | **0.452** | **REJECTED** | Fails Gate 4 (<70%), Gate 5 (<20% margin), and Gate 6 ($\le 0.50$). |
| Decayed Stale Evidence | 8.2 | 0.9000 (90%) | **0.573** | **REJECTED** | Fails Gate 1 (Insufficient distinct riders). |

---

## 6. Zero-Write-Amplification Query-Time Decay Engine

### 6.1 Database Zero-Write Invariant
Updating decayed weights in-place across millions of rows in `dpmaps.trip_evidence_ledger` causes massive table bloat, index thrashing, and write-ahead log (WAL) saturation.

In accordance with Stage 003:
1. `dpmaps.trip_evidence_ledger` is strictly **append-only and immutable**.
2. Decay is computed dynamically during the monthly publication run using the exact evaluation cutoff timestamp $T_{\text{cutoff}}$.
3. The decay constant is:
   $$\lambda = \frac{\ln(2)}{45} \approx 0.01540327298 \text{ days}^{-1}$$
4. An evidence row cast $\Delta t$ days before $T_{\text{cutoff}}$ has weight:
   $$w_i = \text{initial\_weight}_i \times \exp(-\lambda \cdot \Delta t)$$

### 6.2 SQL Candidate Extraction Query
The extraction query runs during the monthly publication maintenance window (21:00–23:00 UTC / 03:00–05:00 Dhaka time) with read-only connection pooling:

```sql
-- File: database/queries/extract_winner_candidates.sql
WITH params AS (
  SELECT 
    :eval_cutoff::timestamptz AS cutoff,
    :anchor_key_id::varchar AS anchor_key,
    0.01540327298::numeric AS lambda
),
raw_evidence AS (
  SELECT 
    tel.id,
    tel.query_cluster_id,
    tel.h3_res10,
    tel.dropoff_geom,
    tel.initial_weight,
    tel.created_at,
    (EXTRACT(EPOCH FROM (p.cutoff - tel.created_at)) / 86400.0) AS age_days,
    lp.pseudonym_hash,
    lp.driver_pseudonym_hash,
    TO_CHAR(tel.created_at, 'IYYY-IW') AS cal_week
  FROM dpmaps.trip_evidence_ledger tel
  CROSS JOIN params p
  JOIN dpmaps.ledger_pseudonyms lp 
    ON lp.ledger_id = tel.id 
   AND lp.created_at = tel.created_at
   AND lp.key_id = p.anchor_key
  WHERE tel.created_at >= p.cutoff - INTERVAL '90 days'
    AND tel.created_at < p.cutoff
    AND tel.initial_weight > 0
),
weighted_evidence AS (
  SELECT 
    re.*,
    (re.initial_weight * EXP(-p.lambda * re.age_days)) AS decayed_w,
    POWER(re.initial_weight * EXP(-p.lambda * re.age_days), 2) AS decayed_w_sq,
    -- Pre-cluster dropoff points within 30 meters
    ST_ClusterDBSCAN(re.dropoff_geom, eps := 0.0003, minpoints := 1) 
      OVER (PARTITION BY re.query_cluster_id) AS spatial_cluster_id
  FROM raw_evidence re
  CROSS JOIN params p
),
spatial_summaries AS (
  SELECT 
    query_cluster_id,
    spatial_cluster_id,
    MODE() WITHIN GROUP (ORDER BY h3_res10) AS representative_h3_res10,
    ST_Centroid(ST_Collect(dropoff_geom)) AS centroid_geom,
    COUNT(DISTINCT pseudonym_hash) AS distinct_riders,
    COUNT(DISTINCT driver_pseudonym_hash) AS distinct_drivers,
    COUNT(DISTINCT cal_week) AS active_weeks,
    SUM(decayed_w) AS spatial_weighted_votes,
    SUM(decayed_w_sq) AS spatial_sum_w_sq,
    -- Anti-collusion: max single driver vote count
    MAX(driver_trip_count) AS max_driver_trips
  FROM (
    SELECT 
      we.*,
      COUNT(*) OVER (PARTITION BY query_cluster_id, spatial_cluster_id, driver_pseudonym_hash) AS driver_trip_count
    FROM weighted_evidence we
  ) sub
  GROUP BY query_cluster_id, spatial_cluster_id
),
cluster_totals AS (
  SELECT 
    query_cluster_id,
    SUM(spatial_weighted_votes) AS total_query_weighted_votes,
    SUM(spatial_sum_w_sq) AS total_query_sum_w_sq
  FROM spatial_summaries
  GROUP BY query_cluster_id
)
SELECT 
  ss.query_cluster_id,
  ss.spatial_cluster_id,
  ss.representative_h3_res10,
  ST_AsGeoJSON(ss.centroid_geom) AS centroid_geojson,
  ss.distinct_riders,
  ss.distinct_drivers,
  ss.active_weeks,
  ss.spatial_weighted_votes,
  ss.spatial_sum_w_sq,
  ct.total_query_weighted_votes,
  ct.total_query_sum_w_sq,
  (ss.spatial_weighted_votes / ct.total_query_weighted_votes) AS vote_share,
  ss.max_driver_trips,
  RANK() OVER (PARTITION BY ss.query_cluster_id ORDER BY ss.spatial_weighted_votes DESC) AS rank
FROM spatial_summaries ss
JOIN cluster_totals ct ON ct.query_cluster_id = ss.query_cluster_id
ORDER BY ss.query_cluster_id, rank ASC;
```

---

## 7. The Two-Cycle Challenger Rule & State Transitions

### 7.1 The Oscillation Threat
If destination mapping is updated in a single monthly cycle, competing locations with near-equal traffic (e.g. 52% vs 48%) will bounce back and forth between consecutive releases:
- Month 1: Entrance A is published.
- Month 2: Entrance B gets 53% and replaces Entrance A.
- Month 3: Entrance A gets 52% and replaces Entrance B.

This destroys search cache coherence, causes rider confusion, and breaks saved dispatch pins.

### 7.2 Two-Cycle Challenger Protocol
To unseat an incumbent place associated with a query cluster:
1. **Cycle $M$ (Detection & Provisional Tag):**
   - A challenger spatial cluster $C$ satisfies all 6 publication gates.
   - $C$'s Wilson Score lower bound exceeds the incumbent $I$'s lower bound: $W_{\text{lower}}(C) > W_{\text{lower}}(I)$.
   - **Action:** $C$ does **NOT** unseat $I$. $C$ is recorded as a `provisional_challenger` in the release manifest. $I$ remains the published destination for live search and routing.
2. **Cycle $M+1$ (Confirmation & Promotion):**
   - In the subsequent monthly release cycle, challenger $C$ must **again** satisfy all 6 publication gates and maintain $W_{\text{lower}}(C) > W_{\text{lower}}(I)$.
   - **Action:** Challenger $C$ is promoted to `published` status in `dpmaps.public_pois`.
   - Incumbent $I$ is unseated:
     - If $I$ has no other supporting query clusters, its status transitions to `deprecated`.
     - $I$'s pointer `superseded_by_id` is updated to $C$'s `id`.
     - Historical orders, bookmarks, and logs referencing $I$'s UUID remain valid.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        POI LIFECYCLE STATE TRANSITIONS                                 │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   [ Raw Ledger Evidence ]                                                              │
│              │                                                                         │
│              ▼ (Meets 6 Gates in Month M)                                              │
│        ┌───────────┐                                                                   │
│        │ provisional│ ──► (Fails in Month M+1) ──► [ candidate / dropped ]             │
│        └─────┬─────┘                                                                   │
│              │                                                                         │
│              ▼ (Meets 6 Gates again in Month M+1 under Challenger Rule)                 │
│        ┌───────────┐                                                                   │
│        │ published │ ──► (Emergency Privacy Takedown) ──► ┌────────────┐               │
│        └─────┬─────┘                                      │ suppressed │               │
│              │                                            └────────────┘               │
│              ▼ (Unseated by confirmed challenger or natural decay)                     │
│        ┌────────────┐                                                                  │
│        │ deprecated │ (Retains permanent UUID, superseded_by_id points to winner)      │
│        └────────────┘                                                                  │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Stable Entity Architecture & Permanent UUIDv4

### 8.1 Elimination of UUIDv5 Conflation
Earlier drafts proposed deriving Place IDs via `UUIDv5(NamespaceUUID, h3_res10 + canonical_name)`. This was a critical design flaw:
1. **Name Fragility:** If a place's name is corrected for spelling or transliterated to Bengali, its UUID changes.
2. **Coordinate Snapping Fragility:** If a curb coordinate is snapped by 2 meters from roadway centroid to curb gate, its H3 index or coordinate changes, generating a new UUID.
3. **Broken User State:** Saved user bookmarks, trip history receipts, and fleet dispatch caches referencing the old UUID would immediately fail.

### 8.2 Sovereign UUIDv4 with Version Lineage
Stage 009 strictly adheres to Stage 003's architecture:
1. **Immutable Random Primary Key:** Every entity in `dpmaps.public_pois` is assigned an immutable random UUIDv4: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`.
2. **Decoupled Aliases:** Name strings and search variations reside in `dpmaps.poi_aliases` referencing `poi_id`. Refining an alias or adding a Bengali variant never touches the entity's primary ID.
3. **Immutable Audit Lineage:** Whenever an entity's geometry or metadata is updated, the previous state is archived in `dpmaps.poi_versions` with the active `release_id`.
4. **Clean-Room Merkle Leaf:** Each published POI calculates its canonical payload hash:
   $$\text{leaf\_hash} = \text{SHA-256}(\text{id} \parallel \text{h3\_res10} \parallel \text{ST\_AsBinary(geom)} \parallel \text{publication\_cycle})$$

---

## 9. Implementation: Production Winner Selection Worker

```typescript
// File: workers/winnerSelectionWorker.ts
import { Pool, PoolClient } from 'pg';
import { createHmac } from 'crypto';

export interface SpatialCandidate {
  query_cluster_id: string;
  spatial_cluster_id: number;
  representative_h3_res10: string;
  centroid_geojson: string;
  distinct_riders: number;
  distinct_drivers: number;
  active_weeks: number;
  spatial_weighted_votes: number;
  spatial_sum_w_sq: number;
  total_query_weighted_votes: number;
  total_query_sum_w_sq: number;
  vote_share: number;
  max_driver_trips: number;
  rank: number;
}

export interface GateEvaluationResult {
  passed: boolean;
  gate_failures: string[];
  w_lower: number;
  n_eff: number;
  margin: number;
  vote_share: number;
}

export interface PublicationAction {
  query_cluster_id: string;
  action: 'PROMOTE_NEW' | 'CONFIRM_CHALLENGER' | 'FLAG_PROVISIONAL' | 'RETAIN_INCUMBENT' | 'REJECT';
  entity_id?: string;
  h3_res10: string;
  centroid_geojson: string;
  confidence_score: number;
  reason: string;
}

/**
 * Computes the 95% Wilson Score Interval Lower Bound using Kish Effective Sample Size
 */
export function computeKishWilsonLowerBound(
  weightedVotes: number,
  totalWeightedVotes: number,
  totalSumSqWeights: number,
  z: number = 1.96
): { w_lower: number; n_eff: number; p: number } {
  if (totalWeightedVotes <= 0 || totalSumSqWeights <= 0) {
    return { w_lower: 0.0, n_eff: 0.0, p: 0.0 };
  }

  // Kish effective sample size: (sum w_i)^2 / sum (w_i^2)
  const n_eff = Math.pow(totalWeightedVotes, 2) / totalSumSqWeights;
  const p = weightedVotes / totalWeightedVotes;

  if (n_eff < 1.0) {
    return { w_lower: 0.0, n_eff, p };
  }

  const zSq = z * z;
  const denominator = 1 + zSq / n_eff;
  const center = p + zSq / (2 * n_eff);
  const spreadUnderRoot = (p * (1 - p)) / n_eff + zSq / (4 * n_eff * n_eff);
  
  // Guard against numerical precision epsilon yielding negative values under sqrt
  const spread = z * Math.sqrt(Math.max(0, spreadUnderRoot));
  const w_lower = (center - spread) / denominator;

  return {
    w_lower: Math.max(0.0, Math.min(1.0, w_lower)),
    n_eff,
    p
  };
}

/**
 * Evaluates the 6 Minimum Publication Gates on a spatial candidate cluster
 */
export function evaluateCandidateGates(
  leader: SpatialCandidate,
  runnerUp: SpatialCandidate | null
): GateEvaluationResult {
  const failures: string[] = [];

  // Gate 1: Distinct Rider Diversity (>= 15 unique pseudonyms under anchor key)
  if (leader.distinct_riders < 15) {
    failures.push(`Gate 1 Failed: Distinct riders (${leader.distinct_riders}) < 15`);
  }

  // Gate 2: Distinct Driver Diversity (>= 5 drivers) & Anti-Collusion Cap
  if (leader.distinct_drivers < 5) {
    failures.push(`Gate 2 Failed: Distinct drivers (${leader.distinct_drivers}) < 5`);
  }
  const maxDriverShare = leader.max_driver_trips / leader.distinct_riders;
  if (maxDriverShare > 0.25) {
    failures.push(`Gate 2 Anti-Collusion Failed: Single driver represents ${(maxDriverShare * 100).toFixed(1)}% of trips (max 25%)`);
  }

  // Gate 3: Temporal Spread (>= 3 separate calendar weeks)
  if (leader.active_weeks < 3) {
    failures.push(`Gate 3 Failed: Active calendar weeks (${leader.active_weeks}) < 3`);
  }

  // Gate 4: Vote Share Dominance (>= 70.0% of decayed weighted votes)
  const voteShare = leader.spatial_weighted_votes / leader.total_query_weighted_votes;
  if (voteShare < 0.7000) {
    failures.push(`Gate 4 Failed: Vote share (${(voteShare * 100).toFixed(2)}%) < 70.0%`);
  }

  // Gate 5: Margin of Victory (>= 20.0 percentage points lead over runner-up)
  let margin = 1.0000;
  if (runnerUp) {
    const runnerUpShare = runnerUp.spatial_weighted_votes / runnerUp.total_query_weighted_votes;
    margin = voteShare - runnerUpShare;
    if (margin < 0.2000) {
      failures.push(`Gate 5 Failed: Victory margin (${(margin * 100).toFixed(2)}%) < 20.0%`);
    }
  }

  // Gate 6: Wilson Score Lower Bound on Effective Sample Size (W_lower > 0.5000)
  const { w_lower, n_eff } = computeKishWilsonLowerBound(
    leader.spatial_weighted_votes,
    leader.total_query_weighted_votes,
    leader.total_query_sum_w_sq
  );

  if (w_lower <= 0.5000) {
    failures.push(`Gate 6 Failed: Wilson lower bound (${w_lower.toFixed(4)}) <= 0.5000 (n_eff = ${n_eff.toFixed(1)})`);
  }

  return {
    passed: failures.length === 0,
    gate_failures: failures,
    w_lower: Number(w_lower.toFixed(4)),
    n_eff: Number(n_eff.toFixed(2)),
    margin: Number(margin.toFixed(4)),
    vote_share: Number(voteShare.toFixed(4))
  };
}

/**
 * Main Winner Selection Orchestrator for Monthly Publication
 */
export async function runWinnerSelectionCycle(
  pool: Pool,
  evalCutoff: Date,
  anchorKeyId: string,
  publicationCycle: string,
  auditSecret: string
): Promise<{ processed: number; published: number; rejected: number; cycle: string }> {
  const client: PoolClient = await pool.connect();
  let publishedCount = 0;
  let rejectedCount = 0;

  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ');

    // 1. Fetch grouped candidates from PostGIS
    const candidateQuery = `
      SELECT * FROM dpmaps.v_spatial_winner_candidates
      WHERE cutoff = $1 AND anchor_key = $2
    `;
    const res = await client.query(candidateQuery, [evalCutoff, anchorKeyId]);
    const candidatesByQuery: Map<string, SpatialCandidate[]> = new Map();

    for (const row of res.rows) {
      const qId = row.query_cluster_id;
      if (!candidatesByQuery.has(qId)) candidatesByQuery.set(qId, []);
      candidatesByQuery.get(qId)!.push(row);
    }

    // 2. Evaluate each query cluster
    for (const [queryClusterId, candidates] of candidatesByQuery.entries()) {
      candidates.sort((a, b) => b.spatial_weighted_votes - a.spatial_weighted_votes);
      const leader = candidates[0];
      const runnerUp = candidates[1] || null;

      const evalResult = evaluateCandidateGates(leader, runnerUp);

      // Fetch existing incumbent association
      const incumbentRes = await client.query(
        `SELECT p.id, p.lifecycle_status, p.confidence_score, p.h3_res10
         FROM dpmaps.public_pois p
         JOIN dpmaps.query_clusters qc ON qc.published_poi_id = p.id
         WHERE qc.id = $1`,
        [queryClusterId]
      );
      const incumbent = incumbentRes.rows[0] || null;

      // Handle Challenger Rule & Publication Decision
      if (evalResult.passed) {
        if (!incumbent) {
          // New POI creation
          const canonicalHash = createHmac('sha256', auditSecret)
            .update(`${queryClusterId}:${leader.representative_h3_res10}:${publicationCycle}`)
            .digest('hex');

          await client.query(
            `INSERT INTO dpmaps.public_pois (
              canonical_name, bangla_name, category, point_type,
              lifecycle_status, h3_res9, h3_res10, geom,
              confidence_score, weighted_votes, distinct_riders, distinct_drivers, active_weeks,
              publication_cycle, canonical_payload_hash, audit_hmac, provenance
            ) VALUES (
              $1, $2, 'other', 'dropoff_point',
              'published', substr($3, 1, 15), $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326),
              $5, $6, $7, $8, $9,
              $10, $11, $12, $13
            )`,
            [
              `Learned Place ${leader.representative_h3_res10.slice(-6)}`,
              null,
              leader.representative_h3_res10,
              leader.centroid_geojson,
              evalResult.w_lower,
              leader.spatial_weighted_votes,
              leader.distinct_riders,
              leader.distinct_drivers,
              leader.active_weeks,
              publicationCycle,
              canonicalHash,
              canonicalHash,
              JSON.stringify({
                source: 'trip_cluster',
                n_eff: evalResult.n_eff,
                vote_share: evalResult.vote_share,
                margin: evalResult.margin
              })
            ]
          );
          publishedCount++;
        } else if (incumbent.h3_res10 === leader.representative_h3_res10) {
          // Existing incumbent reinforced
          await client.query(
            `UPDATE dpmaps.public_pois SET
              confidence_score = $1,
              weighted_votes = $2,
              distinct_riders = $3,
              distinct_drivers = $4,
              active_weeks = $5,
              updated_at = NOW()
             WHERE id = $6`,
            [
              evalResult.w_lower,
              leader.spatial_weighted_votes,
              leader.distinct_riders,
              leader.distinct_drivers,
              leader.active_weeks,
              incumbent.id
            ]
          );
          publishedCount++;
        } else {
          // Challenger unseating incumbent: Check 2-cycle status
          const provisionalCheck = await client.query(
            `SELECT * FROM dpmaps.provisional_challengers 
             WHERE query_cluster_id = $1 AND challenger_h3 = $2 AND status = 'active'`,
            [queryClusterId, leader.representative_h3_res10]
          );

          if (provisionalCheck.rowCount === 0) {
            // Cycle 1: Mark as provisional challenger
            await client.query(
              `INSERT INTO dpmaps.provisional_challengers (
                query_cluster_id, challenger_h3, incumbent_poi_id,
                cycle_1_score, cycle_1_cycle, status
              ) VALUES ($1, $2, $3, $4, $5, 'active')`,
              [
                queryClusterId,
                leader.representative_h3_res10,
                incumbent.id,
                evalResult.w_lower,
                publicationCycle
              ]
            );
            // Incumbent remains active for this release
          } else {
            // Cycle 2: Confirmed challenger! Unseat incumbent
            const newPoiId = await client.query(
              `INSERT INTO dpmaps.public_pois (
                canonical_name, bangla_name, category, point_type,
                lifecycle_status, h3_res9, h3_res10, geom,
                confidence_score, weighted_votes, distinct_riders, distinct_drivers, active_weeks,
                publication_cycle, canonical_payload_hash, audit_hmac, provenance
              ) VALUES (
                $1, $2, 'other', 'dropoff_point',
                'published', substr($3, 1, 15), $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326),
                $5, $6, $7, $8, $9,
                $10, 'canonical-hash', 'audit-hmac', $11
              ) RETURNING id`,
              [
                `Learned Place ${leader.representative_h3_res10.slice(-6)}`,
                null,
                leader.representative_h3_res10,
                leader.centroid_geojson,
                evalResult.w_lower,
                leader.spatial_weighted_votes,
                leader.distinct_riders,
                leader.distinct_drivers,
                leader.active_weeks,
                publicationCycle,
                JSON.stringify({ superseded_poi_id: incumbent.id, cycle: publicationCycle })
              ]
            );

            // Deprecate old incumbent and link superseded_by_id
            await client.query(
              `UPDATE dpmaps.public_pois SET 
                lifecycle_status = 'deprecated',
                superseded_by_id = $1,
                updated_at = NOW()
               WHERE id = $2`,
              [newPoiId.rows[0].id, incumbent.id]
            );

            // Update query cluster pointer
            await client.query(
              `UPDATE dpmaps.query_clusters SET 
                published_poi_id = $1, 
                updated_at = NOW() 
               WHERE id = $2`,
              [newPoiId.rows[0].id, queryClusterId]
            );

            // Close provisional challenger record
            await client.query(
              `UPDATE dpmaps.provisional_challengers SET status = 'promoted' WHERE query_cluster_id = $1`,
              [queryClusterId]
            );

            publishedCount++;
          }
        }
      } else {
        rejectedCount++;
      }
    }

    await client.query('COMMIT');
    return {
      processed: candidatesByQuery.size,
      published: publishedCount,
      rejected: rejectedCount,
      cycle: publicationCycle
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

---

## 10. Unit Testing Matrix & Mathematical Boundary Verification

The winner selection worker must be validated against synthetic datasets covering all boundary conditions before activation:

| Test Case | Scenario / Parameters | Expected Outcome | Rationale |
|---|---|:---:|---|
| **TC-009-01** | `distinct_riders = 14`, all other gates satisfied | **REJECTED** | Strict Gate 1 boundary enforcement ($14 < 15$). |
| **TC-009-02** | `distinct_drivers = 4`, `distinct_riders = 30` | **REJECTED** | Strict Gate 2 boundary enforcement ($4 < 5$). |
| **TC-009-03** | `active_weeks = 2`, 100 trips in 14 days | **REJECTED** | Strict Gate 3 viral event suppression ($2 < 3$). |
| **TC-009-04** | `vote_share = 69.9%`, `distinct_riders = 50` | **REJECTED** | Strict Gate 4 dominance threshold ($0.699 < 0.700$). |
| **TC-009-05** | Leader = 72%, Runner-Up = 54% (invalid shares) | **REJECTED** | Data integrity check ($\sum \hat{p} > 1.0$). |
| **TC-009-06** | Leader = 72%, Runner-Up = 28% (Margin = 44%) | **PASSED** | Margin $44\% \ge 20\%$, Dominance $72\% \ge 70\%$. |
| **TC-009-07** | Leader = 55%, Runner-Up = 45% (Margin = 10%) | **REJECTED** | Ambiguous margin triggers fallback ($10\% < 20\%$). |
| **TC-009-08** | $n_{\text{eff}} = 15.0, \hat{p} = 0.7000$ | **REJECTED** | $W_{\text{lower}} = 0.448 \le 0.5000$. Demonstrates Wilson penalty on minimal effective sample size. |
| **TC-009-09** | $n_{\text{eff}} = 25.0, \hat{p} = 0.7000$ | **PASSED** | $W_{\text{lower}} = 0.504 > 0.5000$. Satisfies Gate 6. |
| **TC-009-10** | Single driver accounts for 30% of trips | **REJECTED** | Gate 2 anti-collusion cap violation ($30\% > 25\%$). |
| **TC-009-11** | Challenger beats incumbent in Month $M_1$ only | **PROVISIONAL** | Challenger Rule: Incumbent retained in Month 1; challenger marked `provisional`. |
| **TC-009-12** | Challenger beats incumbent in $M_1$ and $M_2$ | **PUBLISHED** | Challenger Rule: Promoted to `published`, old incumbent marked `deprecated`, permanent UUIDs preserved. |
| **TC-009-13** | Drop-offs straddle H3 res-10 boundary (55%/45%) | **PASSED** | DBSCAN pre-clustering merges points within 30m, preventing split-vote rejection. |

---

## 11. Operational Controls, Release Manifests & Emergency Takedown

### 11.1 Immutable Release Manifest
Every publication cycle writes an immutable record to `dpmaps.releases`:
```json
{
  "release_id": "pub-2026-11-01",
  "cutoff_timestamp": "2026-10-31T23:59:59Z",
  "anchor_key_id": "key-2026-07-01",
  "normalizer_version": "v2.4.0",
  "ruleset_version": "rules-2026.11",
  "published_poi_count": 52840,
  "promoted_new_count": 312,
  "deprecated_count": 18,
  "merkle_root": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "tsa_receipt": "MIAGCSqGSIb3DQEHAqCAMIACAQExDzANBglghkgBZQMEAgEFADCABgkqhkiG9w0BBwE..."
}
```

### 11.2 Emergency Suppression & One-Step Rollback
1. **Sub-Hour Suppression Layer:** If a published place is contested, fraudulent, or subject to a privacy takedown, an administrative command writes its ID to `dpmaps.suppressions` and invalidates the Redis Bloom filter. The MeiliSearch indexer removes the entity within **$< 15\text{ minutes}$**, completely bypassing the monthly release cycle.
2. **One-Step Release Rollback:** If an updated release exhibits unexpected routing or search regressions:
   ```bash
   # CLI rollback execution
   npm run dpmaps:release -- --rollback-to pub-2026-10-01
   ```
   The database switches active pointers to the previous release snapshot in `dpmaps.poi_versions`, reloading MeiliSearch and invalidating CDN vector tile caches simultaneously.

---

## 12. Deliverables & Definition of Done

- [ ] **Mathematical Verification:** Kish effective sample size and Wilson score formulations verified against test suites covering all edge cases.
- [ ] **DBSCAN Pre-Clustering:** PostGIS spatial grouping script implemented and benchmarked on 50,000 synthetic Dhaka drop-offs, proving resolution of H3 boundary splits.
- [ ] **Database Queries:** Production-ready `extract_winner_candidates.sql` verified with `EXPLAIN ANALYZE` ensuring index-backed execution on partitioned tables.
- [ ] **Worker Implementation:** `workers/winnerSelectionWorker.ts` implemented with 2-cycle challenger logic, anti-collusion caps, and transactional commit/rollback.
- [ ] **UUIDv4 Permanence:** Provenance tests confirm entity IDs remain stable across name updates, with lineage tracked via `dpmaps.poi_versions`.
- [ ] **Legal Compliance:** Strict verification that no vendor-derived strings, IDs, or coordinates enter the voting ledger (Stage 002 Legal Gate).
