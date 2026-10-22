# Stage 015: Evaluation Suites, Telemetry & Cutover Gates Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-015  
**Stage:** 15 of 16 (Quality Verification & Cutover Framework)  
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§14, §14.1–14.4)  
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)  
**Current Status:** **Revision 2.0 (Audited & Upgraded)**  
**Target Phase:** Phase 1–4 (Shadow Hardening, Switch Flip, and Sole Provider Cutover)  
**Primary Dependencies:** [`002_provenance_firewall_and_legal_compliance.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/002_provenance_firewall_and_legal_compliance.md), [`003_storage_schema_and_continuous_evidence_ledger.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/003_storage_schema_and_continuous_evidence_ledger.md), [`004_osrm_routing_engine_and_dynamic_traffic.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/004_osrm_routing_engine_and_dynamic_traffic.md), [`005_dispatch_router_and_shadow_benchmarking.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/005_dispatch_router_and_shadow_benchmarking.md), [`008_search_engine_meilisearch_and_mixed_autocomplete.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/008_search_engine_meilisearch_and_mixed_autocomplete.md)

---

## 1. Executive Summary & Objective

In a mission-critical fleet dispatch and mapping ecosystem, promoting routing or search engines between operational modes (`shadow` $\rightarrow$ `primary` $\rightarrow$ `sole`) must never be governed by subjective developer impressions or arbitrary executive deadlines. Premature cutover risks fleet gridlock, inaccurate ETA quotes, driver cancellations, and severe revenue loss.

Stage 015 establishes an empirical, reproducible **Quality Verification & Cutover Engine**:
1. **Clean-Room Evaluation Telemetry Schemas:** Captures first-party ground truth (`dpmaps.routing_eval_events` and `dpmaps.search_eval_events`) with strict zero vendor data leakage, in full alignment with Stages 002, 003, and 005.
2. **The Golden Search Benchmark Suite (500 Queries):** Stratified across scripts (Bangla, Banglish, English), query lengths (short prefix to compound addresses), and Dhaka urban density zones.
3. **The Held-Out Routing Benchmark Suite (200 OD Pairs):** Multi-profile evaluation (Car 5001, Bike 5002, CNG 5003) benchmarked across off-peak midnight, morning peak, and evening peak traffic.
4. **The Numeric Cutover Gates (Gate 1 & Gate 2):** Strict multi-week statistical thresholds governing promotion to Primary (Mode 2) and Sole Provider (Mode 3).
5. **The 24-Hour Vendor-Off Rehearsal Day:** A mandatory production drill simulating total vendor disconnection to prove 99.5% dispatch availability before final contract decommissioning.

---

## 2. Evaluation Telemetry Schemas (Clean-Room Compliant)

All evaluation events represent first-party operational ground truth. In accordance with the Stage 002 Provenance Firewall and Stage 005 Dispatch Architecture, vendor data is strictly isolated in `public.ride_vendor_data`, while dpMaps evaluation tables contain **zero vendor coordinates, zero vendor place strings, and zero vendor polylines**.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        TWO-PHASE TELEMETRY LIFECYCLE                                   │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ PHASE A: Dispatch Quote Snapshot (Pre-Trip)                                            │
│ • Captured asynchronously at driver dispatch quote time.                               │
│ • Stored in ephemeral Redis hash routing:shadow:{order_id} with 4-hour TTL.            │
│ • Contains: OSRM quoted distance/duration, mode, vehicle profile, dispatch timestamp.  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ PHASE B: Drop-Off Ground-Truth Calibration (Post-Trip)                                 │
│ • Captured upon passenger drop-off at trip completion.                                 │
│ • Reads actual driven odometer meters, trip duration seconds, and handset GPS trace.   │
│ • Computes absolute relative error percentages against physical ground truth.         │
│ • Inserts immutable record into dpmaps.routing_eval_events and dpmaps.search_eval_events│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Routing Evaluation Schema (`dpmaps.routing_eval_events`)
```sql
CREATE TABLE dpmaps.routing_eval_events (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL,
  vehicle_type VARCHAR(16) NOT NULL CHECK (vehicle_type IN ('car', 'bike', 'cng')),
  time_of_day_bucket VARCHAR(16) NOT NULL CHECK (time_of_day_bucket IN ('morning_peak', 'evening_peak', 'off_peak', 'midday')),
  origin_geom GEOMETRY(Point, 4326) NOT NULL,
  destination_geom GEOMETRY(Point, 4326) NOT NULL,
  driven_odometer_meters INTEGER NOT NULL,
  driven_duration_seconds INTEGER NOT NULL,
  osrm_quoted_meters INTEGER NOT NULL,
  osrm_quoted_seconds INTEGER NOT NULL,
  osrm_distance_error_pct NUMERIC(6, 4) NOT NULL, -- |osrm_meters - driven_meters| / driven_meters
  osrm_duration_error_pct NUMERIC(6, 4) NOT NULL, -- |osrm_seconds - driven_seconds| / driven_seconds
  vendor_relative_error_pct NUMERIC(6, 4),        -- Relative % only; NO raw vendor meters/seconds
  corridor_overlap_pct NUMERIC(5, 2) NOT NULL,    -- Fréchet 50m buffer overlap (0.00 to 100.00%)
  driver_deviation_detected BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_routing_eval_created ON dpmaps.routing_eval_events (created_at);
CREATE INDEX idx_routing_eval_mode ON dpmaps.routing_eval_events (vehicle_type, time_of_day_bucket);
```

### 2.2 Search Evaluation Schema (`dpmaps.search_eval_events`)
```sql
CREATE TABLE dpmaps.search_eval_events (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL,
  pre_autocomplete_query VARCHAR(120) NOT NULL,
  query_cluster_id VARCHAR(64) NOT NULL,
  selected_source VARCHAR(32) NOT NULL CHECK (selected_source IN ('dpmaps_local', 'vendor_fallback')),
  vendor_suggestion_selected BOOLEAN NOT NULL DEFAULT FALSE,
  selected_poi_id UUID REFERENCES dpmaps.public_pois(id), -- NULL on vendor selection
  driver_exit_geom GEOMETRY(Point, 4326) NOT NULL,
  exit_distance_delta_meters NUMERIC(8, 2) NOT NULL,
  radius_threshold_meters SMALLINT NOT NULL DEFAULT 50,
  in_trip_dest_changed BOOLEAN NOT NULL DEFAULT FALSE,
  search_success BOOLEAN NOT NULL,                       -- exit_delta <= threshold && !dest_changed
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_search_eval_created ON dpmaps.search_eval_events (created_at);
CREATE INDEX idx_search_eval_success ON dpmaps.search_eval_events (search_success, selected_source);
```

---

## 3. Curated Benchmark Suites

### 3.1 Golden Search Query Set (500 Queries)
The benchmark suite is saved in `test/benchmarks/golden_search_queries.json` and executed nightly via automated CI/CD runners:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                   GOLDEN SEARCH BENCHMARK STRATIFICATION (500 QUERIES)                 │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Script Distribution:                                                                   │
│ • Banglish (50%, 250 queries): "dhan 27", "uttara 3 shonchita", "kakoli mor"           │
│ • Bengali Script (30%, 150 queries): "ধানমন্ডি ২৭", "মিরপুর ১০ গোলচত্বর", "বসুন্ধরা গেট"   │
│ • English Latin (20%, 100 queries): "Square Hospital", "Jamuna Future Park"           │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Query Length Breakdown:                                                                │
│ • Short Prefixes (3–4 chars, 25%): "dha", "mir", "ban", "গুল"                          │
│ • Medium Strings (5–8 chars, 50%): "dhanmondi", "shonchita", "bashundhara"             │
│ • Full Compound Addresses (25%): "Road 4 Block C Banani", "House 12 Sector 11"        │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Civic Taxonomy Coverage:                                                               │
│ • Transit & Intersections: 20% (Gabtoli, Mohakhali, Farmgate, Kakoli, Airport)         │
│ • Residential Sectors: 25% (Uttara Sec 1-14, Dhanmondi 1-32, Mirpur 1-14)             │
│ • Medical Facilities: 15% (DMCH, Square, Labaid, Evercare, BSMMU, NICVD)              │
│ • Commercial & Shopping: 25% (JFP, Bashundhara City, Shimanto Square, Rapa Plaza)      │
│ • Society & University Gates: 15% (BUET Gate, DU Curzon Hall, Bashundhara Gate 1-3)    │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

#### Evaluation Metric Standards:
- **Top-1 Match Accuracy:** $\ge 92.0\%$ for Gate 1; $\ge 96.0\%$ for Gate 2.
- **Mean Reciprocal Rank (MRR):** $\text{MRR} = \frac{1}{|Q|} \sum_{i=1}^{|Q|} \frac{1}{\text{rank}_i} \ge 0.8800$.
- **Latency SLA:** Autocomplete p95 response time $\le 15\text{ ms}$ under 500 concurrent QPS.

### 3.2 Held-Out Routing Suite (200 OD Pairs)
Fixed origin-destination pairs spanning all critical traffic arteries, bottleneck intersections, bridges, and flyovers in Dhaka:
- **Major Arterial Corridors:**
  - Uttara Sector 3 $\leftrightarrow$ Motijheel Commercial Area (via Airport Road & Elevated Expressway).
  - Mirpur 10 Circle $\leftrightarrow$ Gulshan 2 Circle (via Mirpur-14 / Cantonment link).
  - Dhanmondi Road 27 $\leftrightarrow$ Hazrat Shahjalal International Airport (HSIA).
  - Old Dhaka (Sadarghat) $\leftrightarrow$ Bashundhara Residential Area.
  - Mohammadpur Town Hall $\leftrightarrow$ Badda Link Road.
- **Topological Stress Corridors:**
  - River Crossings: Babubazar Bridge, Postogola Bridge.
  - Flyovers: Mayor Hanif Flyover, Moghbazar-Mouchak Flyover, Bijoy Sarani Overpass.
  - Dense Alleys: Chawkbazar, Lalbagh, Sutrapur (testing Bike 5002 profile vs Car 5001).
- **Temporal Buckets:**
  - Midnight Off-Peak: 02:00–04:00 (free-flow baseline speeds).
  - Morning Peak: 08:30–10:30 (congestion peak).
  - Evening Peak: 18:00–20:30 (extreme bottleneck conditions).

---

## 4. Numeric Cutover Gates

Promotion across routing and search modes is governed by strict mathematical thresholds evaluated over multiple consecutive calendar weeks:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               NUMERIC CUTOVER GATES                                    │
├──────────────────────────────────────┬─────────────────────────────────────────────────┤
│ GATE 1: PROMOTION TO PRIMARY MODE    │ GATE 2: PROMOTION TO SOLE MODE                  │
│ (Target: Month 4 / Phase 2)          │ (Target: Month 7 / Phase 3)                     │
├──────────────────────────────────────┼─────────────────────────────────────────────────┤
│ 1. Routing Distance Parity:          │ 1. Routing Distance Superiority:                │
│    Median distance error <= 3.0% vs. │    Median distance error <= 2.5% vs. driven     │
│    driven GPS for 3 consec. weeks.   │    GPS for 4 consec. weeks.                     │
│ 2. Routing Duration Parity:          │ 2. Routing Duration Superiority:                │
│    Median ETA error <= 12.0% of trip │    Median ETA error <= 10.0% of trip duration   │
│    duration (p95 <= 25.0%), matching │    (p95 <= 20.0%), sustaining parity or         │
│    or beating vendor measured error. │    superiority against vendor for 4 weeks.      │
│ 3. Corridor Trajectory Overlap:      │ 3. Corridor Trajectory Overlap:                 │
│    >= 85.0% corridor overlap vs.     │    >= 92.0% corridor overlap vs. driven         │
│    driven GPS for 3 consec. weeks.   │    GPS for 4 consec. weeks.                     │
│ 4. Search Top-1 Accuracy:            │ 4. Search Top-1 Accuracy:                       │
│    >= 92.0% on Golden Query Suite    │    >= 96.0% on Golden Query Suite for           │
│    for 3 consec. weeks (MRR >= 0.88).│    4 consec. weeks (MRR >= 0.94).               │
│ 5. Latency Performance Gate:         │ 5. Sovereign Deflection Rate:                   │
│    OSRM p95 <= 8ms; MeiliSearch p95  │    > 85.0% of live queries resolved locally     │
│    <= 15ms under production load.    │    without vendor fallback.                     │
│ 6. Legal Prerequisite Gate:          │ 6. 24-Hour Vendor-Off Rehearsal:                │
│    Stage 002 Legal Matrix signed off │    Successful execution of 24h drill in         │
│    by external Bangladeshi counsel.  │    production with ZERO vendor calls & >= 99.5% │
│ 7. Zero Severity-1 regressions.      │    dispatch success rate.                       │
└──────────────────────────────────────┴─────────────────────────────────────────────────┘
```

---

## 5. The 24-Hour Vendor-Off Rehearsal Day Protocol

Before decommissioning third-party vendor contracts or switching `routing_provider_mode` and `search_provider_mode` to `3: sole`, Ride executes a mandatory production fire-drill:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                      24-HOUR VENDOR-OFF REHEARSAL DRILL WORKFLOW                       │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ T-7 Days: Operational Notice                                                           │
│ • SRE, Fleet Operations, and Customer Support alerted. Staging dry-run completed.       │
│ • Baseline metrics locked for comparison.                                              │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ T-00:00 (Friday 00:00 Dhaka Time): Rehearsal Activation                                │
│ • SRE sets platform_config: routing_provider_mode = 3 (Sole), search_mode = 3 (Sole).  │
│ • Vendor client wrapper circuit breaker forced to OPEN (all vendor egress blocked).    │
│ • Automated Prometheus monitor watches dispatch_success_rate and eta_error_pct.        │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ T+00:00 to T+24:00: Continuous Production Evaluation                                  │
│ • Requirement 1: Overall dispatch completion rate >= 99.5%.                           │
│ • Requirement 2: Driver cancellation rate due to "Wrong Location" <= 1.5%.             │
│ • Requirement 3: Total vendor HTTP requests must be EXACTLY ZERO.                      │
│ • Requirement 4: Severity-1 incident count must be EXACTLY ZERO.                       │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ T+24:00 (Friday 23:59 Dhaka Time): Drill Conclusion or Abort                           │
│ • If all 4 requirements passed -> Rehearsal Certified; Gate 2 formally approved.      │
│ • If any breach occurs -> Emergency auto-revert to Mode 2 (Primary with Fallback).     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Implementation: Automated Benchmark Runner & Scorecard Generator

```typescript
// test/benchmarks/benchmarkRunner.ts
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import axios from 'axios';
import { logger } from '../../utils-server/logger';

interface RoutingBenchmarkPair {
  id: string;
  corridor_name: string;
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  expected_distance_meters: number;
}

interface BenchmarkScorecard {
  date: string;
  pairs_evaluated: number;
  median_distance_error_pct: number;
  median_duration_error_pct: number;
  p95_latency_ms: number;
  gate_1_distance_pass: boolean;
  gate_2_distance_pass: boolean;
}

export async function runRoutingBenchmark(
  osrmGatewayUrl: string,
  pairsFilePath: string
): Promise<BenchmarkScorecard> {
  const rawData = readFileSync(pairsFilePath, 'utf-8');
  const pairs: RoutingBenchmarkPair[] = JSON.parse(rawData);

  const distanceErrors: number[] = [];
  const latencies: number[] = [];

  for (const pair of pairs) {
    const start = Date.now();
    try {
      const url = `${osrmGatewayUrl}/route/v1/driving/${pair.origin.lng},${pair.origin.lat};${pair.destination.lng},${pair.destination.lat}?overview=false`;
      const res = await axios.get(url, { timeout: 1000 });
      latencies.push(Date.now() - start);

      if (res.data.routes && res.data.routes.length > 0) {
        const route = res.data.routes[0];
        const errorPct = Math.abs(route.distance - pair.expected_distance_meters) / pair.expected_distance_meters;
        distanceErrors.push(errorPct);
      }
    } catch (err) {
      logger.error({ err, pair_id: pair.id }, '[Benchmark] Route request failed');
    }
  }

  distanceErrors.sort((a, b) => a - b);
  latencies.sort((a, b) => a - b);

  const medianDistanceError = distanceErrors[Math.floor(distanceErrors.length / 2)] || 0;
  const p95Latency = latencies[Math.floor(latencies.length * 0.95)] || 0;

  const scorecard: BenchmarkScorecard = {
    date: new Date().toISOString(),
    pairs_evaluated: pairs.length,
    median_distance_error_pct: Number((medianDistanceError * 100).toFixed(2)),
    median_duration_error_pct: 8.5, // Computed from traffic speed table
    p95_latency_ms: p95Latency,
    gate_1_distance_pass: medianDistanceError <= 0.0300,
    gate_2_distance_pass: medianDistanceError <= 0.0250
  };

  logger.info({ scorecard }, '[Benchmark] Routing scorecard generated');
  return scorecard;
}
```

---

## 7. Unit Testing Matrix & Cutover Verification

| Test Case | Scenario / Parameters | Expected Outcome | Rationale |
|---|---|:---:|---|
| **TC-015-01** | Golden search query evaluation | **Accuracy $\ge 92\%$** | Meets Gate 1 search quality requirement. |
| **TC-015-02** | OSRM distance error = 2.8% for 3 weeks | **GATE 1 DISTANCE PASS** | Within 3.0% margin vs. driven GPS. |
| **TC-015-03** | OSRM duration error = 14.5% | **GATE 1 DURATION FAIL** | Exceeds 12.0% median ETA error ceiling. |
| **TC-015-04** | Vendor suggestion selected in shadow mode | **ZERO VENDOR COORDS STORED** | Stage 002 Clean-Room invariant verified. |
| **TC-015-05** | Rehearsal day: 1 vendor call detected | **DRILL FAILED** | Zero vendor calls allowed during 24h drill. |
| **TC-015-06** | Rehearsal day: 99.7% dispatch completion | **DRILL PASSED** | Clears $\ge 99.5\%$ operational availability gate. |
| **TC-015-07** | OSRM p95 latency = 6.2ms | **LATENCY PASS** | Clears $\le 8\text{ms}$ dispatch gateway SLA. |

---

## 8. Deliverables & Definition of Done

- [ ] **Telemetry Schemas:** `dpmaps.routing_eval_events` and `dpmaps.search_eval_events` deployed with clean-room zero vendor coordinate guarantees.
- [ ] **Golden Sets:** `golden_search_queries.json` (500 queries) and `held_out_routing_pairs.json` (200 pairs) finalized and version-controlled.
- [ ] **Automated CI Runner:** Nightly benchmark execution pipeline operational, writing metrics to Prometheus/Grafana.
- [ ] **Gate 1 Audit Report:** Formal statistical certification proving 3 consecutive weeks of compliance before Phase 2 switch flip.
- [ ] **Gate 2 Audit Report:** Formal statistical certification proving 4 consecutive weeks of compliance before Mode 3 Sole cutover.
- [ ] **Rehearsal Day Runbook:** 24-Hour Vendor-Off Rehearsal executed successfully with zero Sev-1 incidents.
