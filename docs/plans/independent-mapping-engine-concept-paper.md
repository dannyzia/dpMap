# Concept Paper: Autonomous Geospatial & Routing Engine Architecture for Ride ("dpMaps")

**Document Identifier:** RIDE-CP-2026-GEO-01 (Revision 7.3 — Reconciled Technical Specification)  
**Target Platform:** Ride (Multi-Vertical Ride-Hailing, Food Delivery & Shop Logistics in Bangladesh)  
**Status:** Architectural Specification & Strategic Proposal  
**Classification:** Core Systems Engineering / Sovereign Infrastructure  
**Date:** October 2026  

---

## 1. Executive Summary & Strategic Context

### 1.1 The Primary Mandate: Sovereign Self-Sufficiency
The primary objective of the **dpMaps** architecture is **operational self-sufficiency**: ensuring Ride continues uninterrupted dispatch, routing, and passenger search operations if commercial mapping vendors (specifically Barikoi or Google) become unavailable, raise prices prohibitively, or experience catastrophic upstream outages. 

**Cost is not a driver of this technical specification**; operational continuity, data sovereignty, and deterministic system availability take precedence over commercial considerations. If an architecture leaves the business exposed to sudden vendor cutoffs, network partition outages, or licensing disputes, it fails. dpMaps is designed from the ground up as a resilient, sovereign mapping stack owned and operated directly by Ride.

```
                              [ THE STRATEGIC GOAL ]
                        Infrastructure Self-Sufficiency
                     (Platform survives vendor cutoffs/outages)
                                    ▲
                                   / \
                                  /   \
                                 /     \
                                /       \
           [ Secondary: Operational Control ] ◄─► [ Legal & IP Sovereignty ]
           Predictable compute footprint          100% clean-room first-party
           and local edge caching                 evidence; zero vendor scraping
```

### 1.2 The Emerging Market Geospatial Trilemma
Ride-hailing, courier delivery, and on-demand logistics platforms operating in high-density South Asian megacities (e.g., Dhaka, Chittagong, Sylhet) face an engineering constraint known as the **Geospatial Trilemma**:

1. **Vendor Dependency & Availability:** Commercial mapping APIs introduce external network latency, rate limits, and single-point-of-failure exposure into core dispatch loops. An upstream outage, routing engine regression, or domestic network peering disruption halts order creation and driver assignment. External vendor APIs cannot match the low latency profile of a local-network graph service (target: sub-5ms `[ESTIMATE – measure on real graph]`).
2. **Data Hyper-Locality:** Western and global map datasets (including raw OpenStreetMap) fail in Dhaka. Local users navigate using colloquial landmarks (*"LabAid er pichon er goli"*), historical naming conventions (*"Old 27, Dhanmondi"*), named residential buildings (*"Swapno Neer"*, *"Baitul Aman"*), and multi-tier sub-district hierarchies. Without high-quality local gazetteers, autocomplete failure rates cause immediate rider churn.
3. **Infrastructure Control & Operational Throttling:** Relying entirely on third-party commercial vendors limits architectural freedom. Call-rate quotas, rigid endpoint interfaces, and lack of direct road graph modification prevent platform optimizations such as custom two-wheeler routing profiles, real-time fleet speed integration, and offline dispatch survivability.

### 1.3 The Failure of Pure "Build" vs. Pure "Buy"
* **The Pure "Buy" Failure (Commercial Vendor Dependency):** Relying solely on commercial mapping vendors ties core dispatch availability to third-party SLAs, introduces network hops into millisecond-sensitive matching loops, and provides no control over underlying road graph customization or colloquial address interpretation.
* **The Pure "Build from Scratch" Failure (Raw OSM + Photon):** Raw OpenStreetMap (OSM) in Bangladesh has solid road geometry, but is virtually devoid of residential holding numbers and colloquial search terms. Launching a pure self-hosted Photon stack on raw OSM without a curated gazetteer results in widespread search failures on colloquial Banglish destinations.

### 1.4 The Strategic Solution: The Pragmatic Hybrid Model
This paper presents the architecture for **dpMaps**, an autonomous geospatial infrastructure for Ride that implements a **Pragmatic Hybrid Model** controlled by dynamic administrative state machines:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        TWO-TOGGLE INDEPENDENT MIGRATION PLAYBOOK                       │
├──────────────────────────────────────────┬─────────────────────────────────────────────┤
│       ROUTING TOGGLE (Modes 0–3)         │         SEARCH TOGGLE (Modes 0–3)           │
├──────────────────────────────────────────┼─────────────────────────────────────────────┤
│ • Mode 0: Off (Vendor only)              │ • Mode 0: Off (Vendor only)                 │
│ • Mode 1: Shadow (OSRM runs async; Day 1)│ • Mode 1: Shadow (dpMaps runs async & logs) │
│ • Mode 2: Primary (OSRM first; vendor    │ • Mode 2: Primary (dpMaps first; vendor     │
│   fallback on miss/error)                │   fallback on miss/zero-hits)               │
│ • Mode 3: Sole (Zero vendor calls)       │ • Mode 3: Sole (Zero vendor calls)          │
├──────────────────────────────────────────┴─────────────────────────────────────────────┤
│ • Day 1 Provisioning: OSRM container running in shadow mode from launch Day 1          │
│ • Target Cutover: Month 3–4 is an engineering target, NOT a rigid schedule.             │
│ • Cutover Decision: Controlled strictly by admin toggle based on numeric evaluation    │
│   gates, not arbitrary calendar dates.                                                 │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. The Dual-Admin Toggle Framework

To eliminate operational risk, routing and search are decoupled into **two independent administrative toggles** stored in the database configuration table ([`system_config`](file:///D:/My%20Projects/Current%20Project/Ride/lib/platformConfig.ts)). Each toggle operates a 4-state engine:

```
                  ┌─────────┐
                  │ 0. OFF  │ (100% Vendor; local engine disabled)
                  └────┬────┘
                       │
                       ▼
                 ┌───────────┐
                 │ 1. SHADOW │ (Vendor serves live; dpMaps evaluates async)
                 └─────┬─────┘
                       │
                       ▼
                 ┌───────────┐
                 │2. PRIMARY │ (dpMaps serves live; vendor fallback on miss)
                 └─────┬─────┘
                       │
                       ▼
                  ┌──────────┐
                  │ 3. SOLE  │ (dpMaps only; ZERO external vendor calls)
                  └──────────┘
```

### 2.1 State Definitions

| Toggle Mode | Live Request Behavior | Fallback Chain | Vendor Ingestion / Logging Policy |
|---|---|---|---|
| **`0: off`** | Request routed 100% to commercial vendor (Barikoi). Local engine is dormant. | Vendor $\rightarrow$ Google $\rightarrow$ Haversine | Vendor responses consumed by client. Zero vendor strings persisted. |
| **`1: shadow`** *(Launch Default)* | Live trip served 100% by commercial vendor. Local engine runs asynchronously in background. | Vendor $\rightarrow$ Google $\rightarrow$ Haversine | Async benchmark compares local execution against physical GPS reality. Zero user impact. |
| **`2: primary`** | Live trip served 100% by local dpMaps engine. External vendor called **only on a miss or error**. | dpMaps $\rightarrow$ Barikoi $\rightarrow$ Google $\rightarrow$ Haversine | Every vendor fallback event is logged with full telemetry for gap analysis. |
| **`3: sole`** | Live trip served 100% by local dpMaps engine. External vendor endpoints are **completely disconnected**. | dpMaps $\rightarrow$ Haversine $\times$ 1.3 | **Absolute vendor independence.** Zero third-party network dependency. Continuous sovereign operation. |

### 2.2 Operational Sovereignty Rules
1. **Independent Evolution:** The Routing toggle can advance to `primary` while the Search toggle remains in `shadow` (or vice-versa).
2. **Reversible Hot Reload:** Any state transition can be reverted in <1 second via an admin dashboard action without redeploying application containers.
3. **Target vs. Rule:** Month 3–4 is a planning milestone for shadow burn-in, not an automatic deadline. The admin advances a toggle **only when empirical evaluation gates are satisfied** (see Section 14).

---

## 3. Provenance Firewall & Legal Compliance

A fundamental requirement of dpMaps is strict intellectual property clean-room execution. Commercial mapping vendor terms are likely to restrict storing vendor responses to train a competing database (confirm in the contract).

```
                                [ RIDE BACKEND ]
                                        │
             ┌──────────────────────────┴──────────────────────────┐
             ▼                                                     ▼
┌──────────────────────────┐                             ┌──────────────────────────┐
│   PROPRIETARY VENDOR     │                             │    FIRST-PARTY CLIENT    │
│      ORCHESTRATOR        │                             │        TELEMETRY         │
│ • Barikoi / Google SDK   │                             │ • Rider typed characters │
│ • Ephemeral transit only │                             │ • Driver exit GPS fix    │
│ • Field-level Allowlist: │                             │ • Snapped odometer trace │
│   - allowed telemetry    │                             │ • Real elapsed minutes   │
│   - all names/IDs dropped│                             │ • Pin Tool survey data   │
│   - nested parsing safe  │                             │ • Merchant storefronts   │
└────────────┬─────────────┘                             └────────────┬─────────────┘
             │                                                        │
             │ (Strictly Dropped at Memory Boundary)                   │ (Permitted Ingestion)
             ▼                                                        ▼
       [ LOG / DISK ] ◄────────────── [ FIREWALL ] ─────────────► [ dpMaps LEDGER ]
         (BLOCKED)                                                (100% Clean-Room Asset)
```

### 3.1 The First-Party Data Isolation Boundary
To significantly reduce intellectual property exposure and ensure audits are fully answerable with clean-room provenance, Ride enforces a strict physical and architectural boundary (formal legal outcomes remain unverified and subject to counsel opinion):

```
┌───────────────────────────────────────────────┬───────────────────────────────────────────────┐
│        STRICTLY BANNED (Third-Party IP)       │        PERMISSIBLE FIRST-PARTY ASSETS         │
├───────────────────────────────────────────────┼───────────────────────────────────────────────┤
│ ❌ Storing vendor-returned address strings or  │ ✅ Raw user search query string typed into    │
│    formatted names in a persistent gazetteer. │    Ride's mobile client before autocomplete.  │
│ ❌ Storing vendor place IDs, categories, or   │ ✅ Physical GPS coordinates recorded by the   │
│    administrative boundary polygons.          │    driver's handset at trip completion.       │
│ ❌ Storing vendor destination coordinates      │ ✅ Vehicle telemetry (speed, heading, route   │
│    provided to the rider.                     │    duration, and real odometer distance).     │
│ ❌ Storing vendor quoted distance or duration; │ ✅ Clean-room Landmark Pin Tool field data.  │
│    store only computed error percentages.     │ ✅ Onboarded merchant physical storefronts.   │
│ ❌ Copying coordinates or names from Google,  │ ✅ Selections of dpMaps' own first-party      │
│    Barikoi, or Pathao into the Pin Tool.      │    suggestions (owned by Ride).               │
└───────────────────────────────────────────────┴───────────────────────────────────────────────┘
```

### 3.2 Field-Level Logging Allowlist (Recursive Sanitization)
Vendor API payloads exist exclusively in memory inside an isolated orchestrator client. The application logger rejects all vendor fields by default, enforcing a strict **recursive allowlist** that inspects both top-level and deeply nested structures:

```typescript
// utils-server/provenanceFirewall.ts
const ALLOWED_VENDOR_FIELDS = new Set([
  'status', 'status_code', 'http_status', 'latency_ms', 'duration_ms',
  'timestamp', 'request_id', 'error_code', 'error_type', 'error_message',
  'method', 'url_path', 'endpoint', 'vehicle_type', 'provider',
  'computed_relative_error_pct', 'corridor_overlap_pct',
  'vendor_suggestion_selected'
]);

/**
 * Recursively filters arbitrary vendor payloads against the strict allowlist.
 * Ensures zero vendor-returned text, IDs, coordinates, or geometry enter logs or disk.
 */
export function sanitizeVendorPayloadForLogging(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') {
    return typeof payload === 'number' || typeof payload === 'boolean' ? payload : undefined;
  }
  if (Array.isArray(payload)) {
    return payload.map(sanitizeVendorPayloadForLogging).filter(v => v !== undefined);
  }
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(payload as Record<string, any>)) {
    if (ALLOWED_VENDOR_FIELDS.has(key.toLowerCase())) {
      sanitized[key] = typeof value === 'object' && value !== null 
        ? sanitizeVendorPayloadForLogging(value) 
        : value;
    }
  }
  return sanitized;
}
```

**Allowed Fields Inventory:**
* **HTTP & Status:** `status`, `status_code`, `http_status`, `method`, `url_path`, `endpoint`
* **Timing & Diagnostics:** `latency_ms`, `duration_ms`, `timestamp`, `request_id`, `provider`, `vehicle_type`
* **Error Telemetry:** `error_code`, `error_type`, `error_message`
* **Computed Metrics:** `computed_relative_error_pct` (relative % error vs. real GPS), `corridor_overlap_pct`, `vendor_suggestion_selected` (boolean flag)

*All vendor coordinates (`lat`, `lng`, `location`, `coordinates`), place names (`name`, `address`, `formatted_address`), place identifiers (`place_id`, `id`), and raw quoted distances/durations are unconditionally dropped at all nesting depths.*

### 3.3 Field-Level Provenance Tracking
Every entity and attribute published in dpMaps carries an immutable provenance record:
```typescript
export interface FieldProvenance {
  source_type: 'pin_tool' | 'merchant_onboarding' | 'post_trip_label' | 'trip_cluster';
  source_id?: string;             // Contributor ID or merchant store ID (internal)
  normalizer_version: string;     // e.g. "norm-v2.4.0"
  ruleset_version: string;        // e.g. "rule-2026.11"
  publication_cycle: string;      // e.g. "pub-2026-11-01"
  vote_count?: number;            // Total weighted votes in cluster
  unique_riders?: number;         // Count of distinct pseudonyms
  confidence_score: number;       // Wilson lower bound score (0.00 - 1.00)
  license_classification: 'first_party_proprietary' | 'osm_odbl_attributed';
  audit_hash: string;             // SHA-256 HMAC of raw input lineage
}
```

### 3.4 Defense Against Vendor Canary Traps & Audit Readiness
Commercial map providers often inject fictitious entries ("canary entries" or "trap streets") into their databases to detect and litigate unauthorized scraping.

Because dpMaps:
1. Never saves vendor-returned strings, place IDs, or coordinates,
2. Requires physical driver GPS completion to register a location,
3. Generates display names exclusively from clean-room surveys, merchant onboarding, and rider post-trip confirmations, and
4. Carries a cryptographically verifiable `audit_hash` linking every published entity back to internal first-party telemetry,

the architecture substantially **reduces exposure to vendor canary traps and provides verifiable records to support audit answers**. In the event of an intellectual property dispute or vendor audit, Ride can produce full internal execution traces proving every coordinate and string was derived without ingesting vendor outputs (formal legal determinations remain unverified and belong to counsel).

---

## 4. The Learning Engine Architecture

The core of dpMaps' search autonomy is its **Three-Layer Learning Engine**. In conventional naive designs, query strings and places are conflated into a single flat database. In dpMaps, search is decomposed into three strictly separated layers:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        THE THREE-LAYER LEARNING ENGINE                                 │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Layer 1: Query-to-Place Association (Relevance Engine)                                 │
│ • Maps what riders type ("dhan 27", "dhanmondi shonchita") to Place IDs.               │
│ • Governed by rider trip votes and phonetic prefix trees.                              │
│ • Answers: "Which candidate entities match this search intent?"                        │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Layer 2: Place Identity (Spatial Entity Engine)                                        │
│ • Defines distinct physical locations in the real world via H3 spatial clustering.     │
│ • Stores coordinates, point_type (building, entrance, drop-off, area), and bounding H3.│
│ • Answers: "Is there a distinct, recurring destination here?"                          │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Layer 3: Display Name (Publication & Presentation Engine)                              │
│ • Formats what is publicly shown in the client autocomplete list.                      │
│ • Decided by strict authority hierarchy (Pin Tool -> Merchant -> Post-Trip -> Formatted)│
│ • Answers: "What is the canonical, verified, culturally correct name for this place?"  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**Crucial Architectural Rule:**
* **Trip votes primarily power Layer 1 (Relevance), partly power Layer 2 (Identity), and NEVER alone decide Layer 3 (Display Name).**
* Rider drop-offs tell the system *where* people travel; they cannot authoritatively determine *how a place should be named or published*.

---

## 5. Vote Definition & Spatial Aggregation

### 5.1 The Atomic Vote Unit
A **Vote** is defined strictly as:
$$\text{Vote} = \langle \text{Normalized Query Cluster } Q, \text{Driver Final GPS Fix } (lat, lng), \text{Trip Context } C \rangle$$

* **One Vote = One Completed Trip:** A vote is registered only upon successful physical trip completion where the passenger was transported to the destination.
* **Captured Before Autocomplete:** The query string $Q$ is captured directly from the rider's typed keystrokes *prior* to autocomplete selection.
* **Prefix-Only Votes:** If a rider types 3 characters (e.g., *"dha"*) and taps a suggestion, this prefix vote counts with a **reduced weight (0.35×)** towards Layer 1 relevance and **cannot establish place identity or naming**.
* **Driver End Fix:** The spatial location is anchored to the **driver's physical GPS coordinates at trip completion**, filtered for noise and snapped to the nearest road curb.

### 5.2 Mandatory Vote Exclusions
A trip is immediately disqualified and discarded from the voting ledger if it meets any of the following conditions:
1. **Trip Cancellation:** Any ride cancelled by rider or driver before arrival.
2. **In-Trip Destination Change:** The destination was updated or rerouted after driver dispatch.
3. **Non-Navigational Text:** Queries containing phone numbers, personal names, price notes, or obscenities.
4. **Structured Alphanumeric Address Text:** Queries formatted as raw unit numbers (e.g., *"Flat 4B, House 12"*) are routed to personal private history, never to the public voting pool.
5. **Anomalous Driving Telemetry:** Trips where duration was <2 minutes, distance was <200 meters, or average speed exceeded 120 km/h in Dhaka city.

### 5.3 Spatial Indexing: H3 Resolutions & Point Types
* **Clustering Granularity:**
  - **Resolution 10:** Used for precise entrance and drop-off clustering `[UNVERIFIED - confirm average cell area (~15,000 m²) against official Uber H3 table]`.
  - **Resolution 9:** Used for areal places, markets, and neighborhood centroid bounding `[UNVERIFIED - confirm average cell area (~0.1 km²) against official Uber H3 table]`.
  - **Neighbor Rings:** Neighboring cells ($k=1$ ring) are evaluated during density aggregation to prevent artificial boundary splitting across adjacent hexagonal edges.
* **Point Type Taxonomy (`point_type`):**
  A drop-off point is not a building centroid. Every spatial entity in Layer 2 is explicitly typed:
  ```sql
  CREATE TYPE point_type_enum AS ENUM (
    'building',      -- Physical structure centroid (from survey or OSM)
    'entrance',      -- Specific vehicle or pedestrian gate / door
    'dropoff_point', -- Roadside curb where vehicles halt
    'area'           -- Broad neighborhood or sector boundary
  );
  ```

### 5.4 Exposure Bias & Vendor Feedback Loop Mitigation
When Ride operates in shadow or hybrid mode, rider destination selections are inherently shaped by the suggestions surfaced in the mobile autocomplete list. If Barikoi supplies the primary autocomplete suggestions, passenger drop-offs will disproportionately reflect Barikoi's existing catalog. This creates an **exposure bias** that risks locking dpMaps into merely replicating Barikoi's known coverage while starving unmapped or long-tail locations of trip votes.

dpMaps actively breaks this self-reinforcing feedback loop through four architectural counter-measures:
1. **Pre-Launch Clean-Room Seed Data:** Ingesting 2,000 independent landmarks and area centroids collected via the Landmark Pin Tool under strict clean-room protocols (§13).
2. **Prominent Mixed Autocomplete Display:** Surfacing dpMaps first-party suggestions alongside vendor results from Day 1, ensuring sovereign entities receive direct rider impressions and selections (§13.2).
3. **Direct Merchant Onboarding:** Ingesting physical storefront coordinates directly from merchants via the Ride Merchant Portal, establishing high-trust destinations completely independent of vendor search.
4. **Post-Trip Verification Prompts:** Eliciting organic landmark names directly from passengers upon arrival at unindexed destination clusters (§9.2).

---

## 6. Text Normalization & Alias Clustering Pipeline

Rider search queries in Bangladesh exhibit extreme linguistic diversity: classical Bangla, phonetic Banglish, English, abbreviations, and informal landmark nicknames. dpMaps implements a **deterministic, versioned, and replayable normalization pipeline**.

```
[ Raw Rider Input ] ──► [ 1. Unicode NFC & Digit Folding ] ──► [ 2. Script Segmentation ]
                                                                       │
┌──────────────────────────────────────────────────────────────────────┴────────────────┐
▼                                      ▼                                                ▼
[ Bangla Stream ]               [ Banglish Stream ]                              [ English Stream ]
• Preserve matras               • Casefold & whitespace strip                    • Casefold & trim
• Abbreviation expansion        • Strip redundant double consonants              • Expand "Rd" -> "Road"
• Retain hard digits            • Retain hard directions (Purbo/Poshchim)        • Retain "Sec", "Blk"
└──────────────────────────────────────┬────────────────────────────────────────────────┘
                                       ▼
                       [ 3. Candidate Matching & Hard Gates ]
                       • Trigram similarity >= 0.75
                       • Hard Constraint: Exact digit and direction match required!
                       • Merged ONLY if spatial drop-off distributions overlap (H3 r10)
                                       ▼
                        [ 4. Normalized Query Cluster ID ]
```

### 6.1 Normalization Steps
1. **Unicode NFC Normalization:** Eliminates decomposed glyph anomalies in Bengali script.
2. **Digit Folding:** Transliterates Bengali numerals (`০-৯`) into standard ASCII digits (`0-9`).
3. **Casefolding & Trimming:** Lowercases Latin strings; collapses multiple whitespace characters.
4. **Abbreviation Expansion:** Expands standard local abbreviations (*"Rd"* $\rightarrow$ *"Road"*, *"Sec"* $\rightarrow$ *"Sector"*, *"H"* $\rightarrow$ *"Hospital"*, *"JFP"* $\rightarrow$ *"Jamuna Future Park"*).

### 6.2 Hard Linguistic & Spatial Constraints
* **Digit & Direction Locking:** Digits and directional markers are **hard constraints**. Under no circumstance will *"Road 4"* and *"Road 7"*, or *"Uttara Sector 3"* and *"Uttara Sector 11"*, or *"Purbo Badda"* and *"Poshchim Badda"* be merged into the same query cluster, regardless of high trigram similarity.
* **Short Prefix Isolation:** Queries $\le 4$ characters are never automatically merged into longer strings.
* **Spatial Alignment Prerequisite:** Two query variants are merged into an alias cluster **only if their historical drop-off spatial distributions also converge on the same H3 resolution 10 cells**. High textual similarity with diverging spatial drop-offs prevents clustering.
* **No Unrestricted Transitive Clustering:** If Query A clusters with Query B, and Query B clusters with Query C, Query A is **not** transitively clustered with Query C unless direct spatial and textual evidence satisfies the candidate threshold independently.
* **Phonetic Limitations:** Standard English phonetic algorithms (Soundex, Metaphone, Double Metaphone) are designed for Anglo-Saxon phonemes and are **not authoritative for Bengali**. dpMaps relies on custom Bengali phonetic rules supplemented by curated alias lookup tables.

---

## 7. Winner Selection & Statistical Confidence

To determine when an association between a query cluster and a physical place is strong enough to publish, dpMaps uses rigorous statistical rules rather than naive majority voting.

### 7.1 Minimum Publication Thresholds
All parameters are admin-configurable. Initial defaults represent conservative starting baselines to be replayed on historical trip logs before production activation. **All diversity thresholds are evaluated on DISTINCT entity counts, not time-decayed weights:**

1. **Unique Rider Diversity:** At least **15 distinct rider pseudonyms** (distinct count across the rolling 90-day window, not decayed weights) must have voted for the association.
2. **Driver Diversity:** Trips must involve at least **5 distinct drivers** (distinct driver accounts, not decayed weights; prevents collusive farming).
3. **Temporal Spread:** Trip activity must span at least **3 separate calendar weeks** (distinct calendar weeks; eliminates single-day viral anomalies).
4. **Vote Share Dominance:** The leading spatial cluster must capture at least **70% of total weighted votes** for that query cluster.
5. **Margin of Victory:** The leader must hold at least a **20 percentage point lead** over the runner-up cluster.
6. **Wilson Score Confidence:** The lower bound of a **95% Wilson Score Interval** for the candidate's vote proportion must exceed **50%**, calculated using the **effective sample size** ($n_{\text{eff}} = \frac{(\sum w_i)^2}{\sum w_i^2}$ to mathematically account for decay weighting):
   $$W_{\text{lower}} = \frac{\hat{p} + \frac{z^2}{2n_{\text{eff}}} - z \sqrt{\frac{\hat{p}(1-\hat{p})}{n_{\text{eff}}} + \frac{z^2}{4n_{\text{eff}}^2}}}{1 + \frac{z^2}{n_{\text{eff}}}} > 0.50 \quad (\text{with } z = 1.96)$$

### 7.2 Tie-Breaking & The Long Tail
* **Ambiguity Rule:** If two competing spatial clusters fail to establish the 20-point margin of victory, **dpMaps publishes nothing and retains the incumbent (or passes through to vendor fallback)**.
* **Tail Integrity:** The long tail of infrequent queries is classified as **"Not Yet Verified"**, not guessed. Publishing a low-confidence false positive destroys rider trust faster than falling back to a vendor search.

---

## 8. Continuous Evidence Ledger & Publication Rounds

dpMaps replaces static quarterly database dumps with a **Continuous Evidence Ledger** paired with **Versioned Publication Cycles**.

```
[ Live Completed Trips ] ──► [ Continuous Append-Only Evidence Ledger ]
                                          │
                                          ▼
                            [ Rolling 90-Day Evidence Window ]
                      (Exponential Time-Decay: λ = ln(2)/45 ≈ 0.0154/day)
                                          │
                     ┌────────────────────┴────────────────────┐
                     ▼                                         ▼
         [ Monthly Publication Gate ]             [ Emergency Suppression Layer ]
         • Ruleset validation                     • Takedown within <1 hour
         • Challenger 2-cycle rule                • Instant cache invalidation
         • Immutable Release Manifest             • One-step release rollback
                     │
                     ▼
          [ Release v2026.11.01 ]
          (Stable Place IDs preserved)
```

### 8.1 Continuous Ledger & Time Decay
* **Continuous Ingestion:** Evidence accumulates continuously in an append-only ledger.
* **Rolling 90-Day Window:** Candidates are evaluated against the trailing 90 days of operational data.
* **Exponential Vote Decay:** Votes decay over time using a half-life of 45 days ($\lambda = \frac{\ln(2)}{45} \approx 0.0154/\text{day}$). A vote cast yesterday carries more weight than a vote cast 60 days ago, allowing the system to naturally adapt to road closures and venue relocations.

### 8.2 Publication Cycles & Challenger Stability
* **Cadence:** Releases are published on a scheduled cadence (default: monthly), triggered manually or automatically by the admin.
* **Release Manifest:** Every publication is immutable and versioned (`vYYYY.MM.BUILD`), recording:
  - Input data cutoff timestamp
  - Normalizer software version
  - Ruleset configuration hash
* **Challenger Rule:** To prevent oscillation, an incumbent place association can only be replaced if a challenger candidate satisfies all winner criteria across **two consecutive publication cycles**.
* **Demotion vs. Deletion:** Stale places that lose vote velocity are **demoted in search ranking**, not deleted from the database.
* **Stable Place IDs:** Place IDs (`UUIDv5` derived from namespace and stable canonical entity attributes) remain permanent across releases, ensuring rider bookmarks, "Saved Places", and trip histories never break.

### 8.3 Operational Controls & Rapid Rollback
* **Early-Close Control:** The admin can trigger an out-of-band publication freeze at any time.
* **Emergency Suppression Layer:** A dedicated Redis bloom filter and suppression table allows taking down any compromised, incorrect, or legally contested place across all live client search endpoints within **<1 hour**, completely bypassing the monthly release cycle.
* **One-Step Rollback:** If an updated release exhibits regressions, the admin dashboard executes an instant one-step rollback to the previous release manifest, invalidating client and edge caches simultaneously.

---

## 9. Naming Engine & Post-Trip Verification

Layer 3 of the learning engine governs how physical locations are displayed to riders in the mobile application.

### 9.1 Display Name Authority Hierarchy
Canonical display names are determined strictly through a 4-tier hierarchy:

```
[ Tier 1: Survey & Merchant ] (Highest Trust)
└── Pin Tool clean-room field surveys & verified merchant onboarded names.
      │ (If unmapped, check Tier 2)
      ▼
[ Tier 2: Post-Trip Verification ]
└── High-confidence rider submissions via the post-trip verification prompt.
      │ (If unmapped, check Tier 3)
      ▼
[ Tier 3: Canonical Formatted Query ]
└── Canonical, formatted version of the leading normalized rider query.
      │ (If ambiguous, check Tier 4)
      ▼
[ Tier 4: Vendor Passthrough / Coarse Centroid ]
└── Retain vendor suggestion (display-only in client UI; NEVER persisted) or neighborhood centroid.
```

* **No Raw Majority Strings:** The system never publishes raw rider-typed strings. Display names must pass automated casing formatting, spellcheck correction, and a strict profanity/abuse filter.
* **Bilingual Dual Names:** Every published place maintains exactly one canonical English name (`display_name`) and one canonical Bengali script name (`bangla_name`). All alternate colloquial spellings are stored as `search_aliases`.
* **Tier 4 Ephemeral Passthrough:** When dpMaps operates in Mode 2 (Primary) and falls back to a vendor suggestion on a local miss, that vendor text is delivered to the mobile client for immediate trip dispatch display only. It is **never persisted in `public_pois`, never indexed in the gazetteer, and never stored in trip history** (§3.1).

### 9.2 The Post-Trip Label Prompt
When a rider completes a trip to a high-density cluster that lacks an authoritative Tier 1 name, Ride activates the **Post-Trip Verification Prompt**:
* **Sampling Trigger:** Triggered selectively on <10% of qualifying completed trips where dpMaps knows the spatial entity but lacks a high-trust display name.
* **UI Design:** A single optional text input field (*"What is this place called?"*) accompanied by 2–3 selectable chip suggestions generated from dpMaps' own candidate query cluster.
* **Non-Incentivized:** To prevent fraudulent farming, post-trip prompts are **never paid or incentivized with wallet credits**.
* **One Label Per Rider:** Exactly one submission per rider per place per publication cycle.
* **Instrumentation:** The client instruments prompt impression, dismissal, text entry, and chip selection rates from Day 1 to monitor organic user engagement.

---

## 10. Privacy Architecture & Named Building Landmarks

### 10.1 Bangladeshi Cultural Reality vs. Western Assumptions
In Bangladesh, individual residential buildings and houses are frequently assigned proper names (e.g., *"Baitul Aman"*, *"Swapno Neer"*, *"Khan Mansion"*, *"Rashid Bhaban"*). These named buildings serve as vital navigational landmarks for entire neighborhoods and rickshaw pullers. 

Under Western geospatial conventions, every residential structure is classified as private personal data. In Bangladesh, however, **a named building achieves public spatial identity when its name converges across multiple independent, unrelated citizens**.

### 10.2 The Public Landmark Convergence Rule
A named residential building or commercial holding is permitted into `public_pois` **only when its name converges organically across the same rigorous statistical criteria as public landmarks**:
- At least 15 independent, non-affiliated riders
- Spanning at least 3 separate weeks
- With spatial drop-off convergence on the building entrance

### 10.3 Strict Privacy Guardrails (Absolute Prohibitions)
Under no circumstance will dpMaps publish or index:
1. **Unit-Level Specifics:** Apartment numbers, floor levels, or suite identifiers (e.g., *"Flat 4B"*, *"Floor 3"*).
2. **Generic Personal Residence Labels:** Queries indicating personal relationships (e.g., *"Rahim er basha"*, *"Mamur bari"*, *"Uncle's apartment"*).
3. **Saved Personal Places:** Private bookmarks saved in user profiles (*"Home"*, *"Work"*, *"In-laws"*).
4. **Trip History Linkage:** Any public exposure of who traveled to, lives in, or visits any building.

### 10.4 Reporting & Takedown Runbook
1. **In-App Reporting:** Client search results and trip receipts include a *"Report location issue / Privacy concern"* button.
2. **Abuse-Resistant Auto-Hide Criteria:** To prevent competitor vandalism, commercial sabotage, or malicious mass reporting:
   - **Verified Accounts Only:** Only phone-verified rider or driver accounts that are at least 30 days old and have completed at least 5 verified trips are eligible to contribute toward takedown thresholds.
   - **Per-Account Rate Limits:** Each verified account can submit at most 1 location report per 24 hours across the entire platform.
   - **Per-Account Reporting Cap:** An account cannot submit reports against multiple locations in a single day to orchestrate coordinated takedowns.
   - **Auto-Hide Trigger:** When $\ge 3$ distinct, verified, rate-compliant accounts file privacy/location reports against the same entity within 24 hours, the entity is temporarily hidden by the Emergency Suppression Layer pending human review.
3. **Hours-Scale Human Review:** Flagged entities enter a high-priority administrative exception queue operated under a strict **<4 hour SLA** to review and either confirm permanent suppression or restore legitimate places.

---

## 11. Data Retention & Legal Checklist for Counsel

### 11.1 The Rolling 90-Day Evidence Tuple & Retention Policy
To comply with emerging data protection principles, publication rounds do **not** store persistent raw user query strings or precise GPS breadcrumbs. The voting ledger stores anonymized tuples valid across the rolling 90-day evidence window:
$$\text{Ledger Entry} = \langle Q_{\text{cluster\_id}}, K_{\text{pseudonym}}, H3_{\text{cell\_res10}}, \text{timestamp} \rangle$$

* **90-Day Key Lifetime with Overlap:** Pseudonyms are hashed using HMAC-SHA256 with a secret key whose lifetime matches the **rolling 90-day evidence window**:
  $$K_{\text{pseudonym}} = \text{HMAC-SHA256}(\text{user\_id}, \text{WindowSecretKey})$$
  Keys are rotated on a fixed 30-day schedule with overlapping 90-day validity windows. This guarantees that an active rider maintains a consistent pseudonym across the trailing 90 days, ensuring that distinct-rider counts ($\ge 15$ distinct riders) do not overcount across monthly cycles, and per-rider voting caps (max 1 vote/week, max 3 votes/90 days) remain mathematically enforceable.
* **Key Destruction:** When an evidence window expires (>90 days), its associated secret key is permanently deleted from KMS and memory. The expired pseudonyms become cryptographically irreversible, preventing historical cross-round profiling.
* **Minimum-Rider Threshold Requirement:** No candidate place or association is ever promoted to publication unless it satisfies the minimum-rider threshold ($\ge 15$ distinct pseudonyms). Sub-threshold clusters remain quarantined or are pruned.

#### Data Retention Policy Table
The platform establishes a strict, tiered retention policy across all geospatial stores:

| Data Store / Tier | Contents Stored | Retention Period | Deletion / Pruning Mechanism |
|---|---|---|---|
| **Tier A: Raw Operational Trip Logs** | User ID, raw pre-autocomplete typed text, precise GPS breadcrumbs, driver timestamp | **30 Days** | Automated PostgreSQL pg_partman / TTL worker hard purge every 24 hours. |
| **Tier B: Evaluation Telemetry (`SearchEvaluationEvent` & `RoutingEvaluationEvent`)** | Trip ID, typed query, driver exit coords, driven duration/distance, error metrics | **30 Days** | Hard purge after 30 days via automated TTL partition drop; summary statistical aggregates retained only. |
| **Tier C: Rolling Evidence Store** | $\langle Q_{\text{cluster\_id}}, K_{\text{pseudonym}}, H3_{\text{cell\_res10}}, \text{ts} \rangle$ | **Rolling 90 Days** | HMAC keys rotated on 30-day cadence with 90-day lifetime; expired keys destroyed; entries older than 90 days pruned by decay worker. |
| **Tier D: Published Gazetteers (`public_pois`)** | Canonical names, aliases, category, H3 cell, Entrance GPS, aggregate vote count, provenance record | **Permanent (Versioned)** | Demoted when vote velocity drops; emergency suppression or legal takedown within <1 hour. Zero PII stored. |

### 11.2 Legal & Regulatory Checklist for External Counsel
All legal points in this paper are **`[UNVERIFIED - confirm before relying on it]`**. The following 9 specific operational questions must be formally submitted to external legal counsel for written legal opinion:

| Legal Domain | Specific Question for Counsel | Risk / Implication |
|---|---|---|
| **1. Data Protection Act Status** | What is the current formal legislative status and enforcement timetable of the proposed Bangladesh Data Protection Act 2023 / 2026? `[UNVERIFIED - confirm status]` | Determines formal registration, Data Protection Officer (DPO) appointment, and statutory compliance timelines. |
| **2. Pseudonymization vs. Personal Data** | Under Bangladeshi law and international standards (GDPR Art. 4(5)), does HMAC-hashed telemetry with destroyed window keys legally qualify as fully anonymized data or remain personal data? | Dictates whether historical window ledgers remain subject to statutory data protection regulations. |
| **3. Lawful Basis & Consent** | Does capturing raw pre-autocomplete keystrokes for search relevance require explicit opt-in consent, or does it qualify under legitimate business interest / contractual necessity? | Determines whether an explicit consent toggle must be presented during mobile app onboarding. |
| **4. Deletion Requests (Right to Erasure)** | When a user requests account deletion, how does the platform demonstrate compliance if their historical votes exist only as HMAC pseudonyms whose key has already been destroyed? | Ensures audit compliance for subject erasure requests without corrupting historical spatial aggregates. |
| **5. Minors & School Telemetry** | What specific telemetry and location tracking restrictions apply to student riders under the age of 18 travelling to and from schools and colleges? | Establishes mandatory automated exclusion filters for educational institution passenger telemetry. |
| **6. Cross-Border Cloud Infrastructure** | Does hosting OSRM graph containers, Planetiler PMTiles, and font glyphs on Singapore Cloud instances (AWS/DigitalOcean/Cloudflare) violate domestic data residency mandates? | Dictates the architectural timeline for migrating container infrastructure to domestic BDIX-peered datacenters. |
| **7. Vendor Contract Compliance** | Does utilizing Barikoi-assisted trips (capturing rider typed characters and driver physical GPS dropoffs) to calibrate an independent index violate Barikoi's Terms of Service, given that **zero Barikoi output is stored**? | Essential for assessing breach-of-contract risk and reducing commercial litigation exposure. |
| **8. ODbL Derivative-Database Exposure** | If OpenStreetMap road network geometry is used for OSRM graphs and base vector PMTiles, does ODbL 1.0 share-alike exposure contaminate Ride's proprietary POI gazetteer? | **Strict Rule:** Maintain OSM data in a strictly separate, attributed layer; never merge proprietary trip tables into OSM derivative files. |
| **9. Barikoi Selection Learning Permission (Open Item)** | Seek Barikoi's formal written permission to store and analyze user-selected vendor suggestions for internal quality benchmarking and learning. | Clarify that the dpMaps architecture functions completely and self-sufficiently without this permission (learning solely from typed characters, physical GPS drop-offs, post-trip confirmations, and clean-room Pin Tool surveys). |

---

## 12. Anti-Manipulation & Sybil Resistance

Because search rankings influence real-world dispatch and commercial foot traffic, malicious actors (e.g. competitor drivers, fraudulent merchants) may attempt to manipulate search rankings through artificial trips.

```
Incoming Trip ──► [ Anti-Manipulation Filter Pipeline ]
                        ├── Sybil Check: Distinct riders, drivers, handsets
                        ├── Burst Suppression: Max 1 vote/user/week for same cluster
                        ├── Collusion Shield: Downweight repeated driver-rider pairs (>2x)
                        ├── Velocity Check: Discard circular & sub-200m trips
                        └── Anomaly Isolation: New account swarms quarantined
                                 │
                                 ▼
                     [ Validated Vote Ledger ]
```

### 12.1 Fraud Guardrails
1. **Per-Rider Voting Cap:** A rider can cast a maximum of **1 vote per query cluster per week**, and at most **3 votes per query cluster per 90-day window**, regardless of trip frequency.
2. **Driver-Rider Collusion Shield:** Trips between the same rider-driver pair occurring more than twice in 30 days have their vote weight reduced by **90%**.
3. **Burst Suppression:** Rapid spikes in search volume or drop-offs originating from newly registered accounts (<14 days old) are placed in a **Quarantine Review State** and excluded from active publication rounds.
4. **Merchant Integrity:** Merchant storefront names submitted via Ride's merchant onboarding program are tracked in a dedicated `merchant_verified` provenance tier. Merchant portals **cannot purchase search rank or alter search candidate ordering**.
5. **Retroactive Vote Invalidation:** The admin console maintains a one-click audit tool to purge all votes associated with identified fraud rings, triggering an immediate recalculation of the affected candidate clusters.

---

## 13. Pre-Launch Landmark Seeding Campaign (Phase 0)

To resolve the cold-start problem, Ride conducts a pre-launch field campaign to seed the database with **2,000 Verified Dhaka Landmarks & Neighborhood Areas** using the internal Landmark Pin Tool under strict clean-room licensing.

```
Target Collection Quotas (2,000 Points):
├── 🏙️ Neighborhood Areas & Sectors (Target: 250 Points)
│    ├── Primary Wards & Areas: Banani, Gulshan 1/2, Dhanmondi, Wari, Badda, Niketan
│    ├── Planned Township Sectors: Uttara Sectors 1–18, Mirpur Sections 1–14
│    └── Historic Neighborhoods: Lalbagh, Armanitola, Sutrapur, Shantinagar
│
├── 🚇 Transit Hubs & Gates (Target: 250 Points)
│    ├── MRT Line 6: All 16 stations and their 64 individual concourse/gate exits
│    ├── Airport: Hazrat Shahjalal International Airport (T1, T2, Cargo, Hajj Camp)
│    ├── Railway Terminals: Kamalapur, Airport Station, Tejgaon, Cantonment
│    └── Inter-District Bus Terminals: Gabtoli, Sayedabad, Mohakhali, Fulbaria
│
├── 🏥 Healthcare (Target: 250 Points)
│    ├── Tertiary Hospitals: Dhaka Medical, BSMMU, Square, United, Evercare, Labaid
│    └── Specialized Clinics & Diagnostic Centers (Ibn Sina, Popular, Medinova)
│
├── 🛍️ Retail & Commercial Markets (Target: 350 Points)
│    ├── Modern Malls (150 Points): Jamuna Future Park, Bashundhara City, Shimanto Square
│    └── Traditional Markets (200 Points): New Market, Gausia, Karwan Bazar, Chawkbazar
│
├── 🎓 Educational Institutions (Target: 250 Points)
│    ├── Universities (150 Points): DU, BUET, DMC, NSU, IUB, BRACU, AIUB, UIU
│    └── Schools & Colleges (100 Points): Notre Dame, Dhaka College, Viqarunnisa
│
├── 🏢 Commercial, Financial & Government (Target: 350 Points)
│    ├── Government & Embassies (150 Points): Secretariat, City Corp, US Embassy
│    └── Corporate Towers & Bank Hubs (200 Points): Motijheel C/A, Gulshan Circle 2
│
└── 🚪 Residential Society Gates & Intersections (Target: 300 Points)
     ├── DOHS Checkpoints: Mohakhali DOHS, Mirpur DOHS, Baridhara DOHS Gates
     └── Major Intersections: Bata Signal, Farmgate Mor, Nilkhet Mor, Shahbagh Mor
```

### 13.1 Complete Category Mapping (Pin Tool to `public_pois`)
The Pin Tool standardizes on the following complete category mapping covering all field surveyor inputs:

| Pin Tool Category | `public_pois.category` | Description & Target Examples |
|---|---|---|
| `area` | `area` | Neighborhoods, sectors, wards, thanas (*Banani*, *Uttara Sector 3*, *Mirpur 10*) |
| `station` | `transit` | MRT Line 6 stations, Kamalapur Railway, Gabtoli/Sayedabad bus terminals |
| `airport` | `transit` | Airport terminals, departures/arrivals concourses, cargo village |
| `hospital` | `hospital` | Tertiary hospitals (Square, Labaid), clinics, diagnostic hubs |
| `market` | `market` | Traditional bazaars, kacha bazaars, wholesale markets (*New Market*, *Gausia*) |
| `mall` | `mall` | Modern shopping malls (*Jamuna Future Park*, *Bashundhara City*, *Rapa Plaza*) |
| `school` | `school` | Primary & high schools, colleges (*Notre Dame*, *Viqarunnisa*, *Dhaka College*) |
| `university` | `university` | Higher education (*Dhaka University*, *BUET*, *NSU*, *BRACU*) |
| `hotel` | `hotel` | Hotels, international hospitality chains (*Radisson*, *Westin*, *InterCon*) |
| `mosque` / `worship` | `religious` | Major mosques (*Baitul Mukarram*), shrines, temples, churches |
| `restaurant` | `food` | Iconic restaurants, food clusters (*Star Kabab*, *Sultan's Dine*, *Baily Road*) |
| `bank` | `financial` | Bank branches, financial centers (*Bangladesh Bank*, *Dutch-Bangla Hub*) |
| `office` | `commercial` | Corporate headquarters, commercial towers (*IDB Bhaban*, *UTC Building*) |
| `government` | `government` | Ministries, secretariats, city corporations, embassies, passport offices |
| `park` | `recreation` | Public parks, stadiums (*Ramna Park*, *Mirpur Stadium*, *Chandrima Udyan*) |
| `society_gate` | `society_gate` | DOHS security checkpoints, Bashundhara R/A gates, Uttara sector barriers |
| `intersection` | `landmark` | Named traffic circles, roundabouts (*Bata Signal*, *Farmgate Mor*, *Shahbagh*) |
| `other` | `other` | General uncategorized public points of interest |

### 13.2 Mixed Autocomplete Display from Launch
* **Blended Candidate Serving:** From Day 1, the mobile client autocomplete interface queries both local dpMaps landmarks and commercial Barikoi endpoints in parallel.
* **Display Priority:** Verified dpMaps first-party landmarks appear at the top of the search result dropdown with a distinct high-trust badge.
* **Contractual Verification Item:** Seek written confirmation from commercial vendors regarding mixed UI autocomplete display `[UNVERIFIED - confirm Barikoi terms allow mixed display]`. If prohibited, fall back to sequential serving (query local dpMaps first; query vendor only if local search yields zero matches).

---

## 14. Evaluation Metrics & Cutover Gates

The decision to advance either admin toggle from `shadow` $\rightarrow$ `primary` $\rightarrow$ `sole` is strictly governed by **objective numeric gates**.

### 14.1 The Search Success Metric & Event Schema
A search event is formally classified as a **Success** if and only if:
1. The rider inputs a query and selects a dpMaps-generated suggestion,
2. The dispatch engine successfully matches and completes the trip,
3. The driver's final physical GPS exit fix is within **Radius $R$** of the selected landmark coordinate (where $R = 50\text{ meters}$ for urban centers, $100\text{ meters}$ for sprawling suburban complexes), and
4. Zero mid-trip destination changes occurred.

#### Evaluation Telemetry Event Schemas
Before activating shadow mode, Ride standardizes the logging event schemas:
```typescript
export interface SearchEvaluationEvent {
  event_id: string;
  trip_id: string;
  timestamp: string;
  pre_autocomplete_query: string;
  query_cluster_id: string;
  selected_source: 'dpmaps_local' | 'barikoi_vendor';
  vendor_suggestion_selected: boolean; // true if rider picked a vendor-supplied suggestion
  selected_entity_id: string | null;   // null when selected_source === 'barikoi_vendor'
  selected_coords: { lat: number; lng: number } | null; // null when selected_source === 'barikoi_vendor'
  driver_exit_coords: { lat: number; lng: number };
  exit_distance_delta_meters: number;
  radius_threshold_meters: number;     // 50m or 100m
  in_trip_dest_changed: boolean;
  trip_completed: boolean;
  search_success: boolean;             // exit_delta <= R && !dest_changed && completed
}

export interface RoutingEvaluationEvent {
  event_id: string;
  trip_id: string;
  timestamp: string;
  vehicle_type: 'bike' | 'car' | 'cng';
  time_of_day_bucket: 'morning_peak' | 'evening_peak' | 'off_peak';
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  driven_odometer_meters: number;
  driven_duration_seconds: number;
  osrm_quoted_meters: number;
  osrm_quoted_seconds: number;
  osrm_distance_error_pct: number;
  osrm_duration_error_pct: number;
  vendor_error_pct?: number;           // Relative error % vs. driven, zero raw vendor values stored
  corridor_overlap_pct: number;        // Fréchet corridor intersection (0 - 100%)
  driver_deviation_detected: boolean;   // Driver diverged significantly from suggested route
}
```

* **Zero Vendor Data in Events:** In strict accordance with §3.1, whenever `selected_source === 'barikoi_vendor'`, the fields `selected_entity_id` and `selected_coords` **must be null**. The system records only first-party signals: the rider's typed text before autocomplete, the driver's physical GPS end fix, and the boolean `vendor_suggestion_selected`. Zero vendor names, IDs, or coordinates are retained in telemetry logs.

### 14.2 Golden Benchmark Test Sets & Held-Out Routing Suite
Prior to enabling shadow mode, engineering curates two static evaluation suites:
1. **Golden Search Query Set (500 Queries):** Segmented across:
   - **Script:** Bangla (30%), Banglish (50%), English (20%)
   - **Query Length:** Short prefix 3–4 chars (25%), Mid 5–8 chars (50%), Full name (25%)
   - **Place Types:** Transit (20%), Areas (25%), Hospitals (15%), Malls/Markets (25%), Society Gates (15%)
   - **Wards:** Old Dhaka (tight alleys), Mirpur (high density), Dhanmondi (mixed holding), Gulshan/Banani (planned)
2. **Held-Out Routing Benchmark Set (200 OD Pairs):** Fixed origin-destination pairs benchmarked across off-peak midnight, morning peak (09:00), and evening peak (18:30).
   - **Multi-Leg Comparison:** Routing tests run in shadow mode compare three legs across each sample: (1) Vendor route, (2) Local OSRM route, and (3) Real driven vehicle trajectory.
   - **Evaluation Metrics:**
     - Distance error percentage (median and p95 vs. real driven odometer)
     - Duration error percentage (median and p95 error relative to real elapsed trip duration)
     - Path spatial corridor overlap (Fréchet distance and buffer intersection)
     - Driver route deviations (frequency and magnitude of drivers taking alternate streets from the OSRM suggestion)

### 14.3 Numeric Cutover Gates
All cutover gates are **strictly numeric, written before launch, and require consecutive weeks of sustained passing performance**. ETA duration error gates are expressed as percentages of real trip duration and are benchmarked against Barikoi's own measured error versus real driven GPS:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               NUMERIC CUTOVER GATES                                    │
├──────────────────────────────────────┬─────────────────────────────────────────────────┤
│ GATE 1: PROMOTION TO PRIMARY MODE    │ GATE 2: PROMOTION TO SOLE MODE                  │
├──────────────────────────────────────┼─────────────────────────────────────────────────┤
│ • Search Success Rate: >= 92% on     │ • Search Success Rate: >= 96% on                │
│   Golden Query Set for 3 consec. wks │   Golden Query Set for 4 consec. wks            │
│ • Routing Distance Parity: Within    │ • Routing Distance Parity: Median error <= 2.5% │
│   3.0% of driven GPS odometer        │   vs. real driven GPS for 4 consec. wks         │
│ • Routing Duration Error: Median     │ • Routing Duration Error: Median ETA error      │
│   ETA error <= 12% of trip duration  │   <= 10% of trip duration (p95 <= 20%),         │
│   (p95 <= 25%), matching or beating  │   sustaining parity or superiority against      │
│   Barikoi's measured error vs. GPS   │   Barikoi's measured error for 4 consec. wks    │
│ • Routing Overlap: >= 85% corridor   │ • Routing Overlap: >= 92% corridor overlap vs.  │
│   overlap vs. driven trajectories    │   driven trajectories for 4 consec. wks         │
│ • Fallback Deflection: N/A (Shadow)  │ • Fallback Deflection: > 85% of live production │
│                                      │   queries resolved without vendor fallback      │
│ • Latency Gate: Local OSRM p95 <= 8ms│ • Vendor-Off Rehearsal Day: 24-hour drill in    │
│ • Zero Severity-1 crash regressions  │   production with zero vendor calls passing SLA │
└──────────────────────────────────────┴─────────────────────────────────────────────────┘
```

### 14.4 Search Failure Gap Analysis (Life Without Barikoi)
When operating in `sole` mode, specific query classes will initially fail on an internal gazetteer. dpMaps implements explicit mitigations for each:

| Query Class | Failure Mechanism | dpMaps Mitigation & Fallback Plan |
|---|---|---|
| **Exact Residential Holding Numbers** (*"House 14/A, Road 5"*) | OSM lacks building-level holding numbers in residential lanes. | Match to road centerline + nearest society gate; prompt rider: *"Drag pin to exact house entrance"*. |
| **Deep Long-Tail Entities** (Niche local stores, small tea stalls) | Unmapped in OSM; insufficient trip volume to cross 15-rider threshold. | Fall back to parent neighborhood centroid (*"Near Banani Block D"*); prompt rider to confirm curb pin. |
| **Newly Opened Businesses** (Cafes/restaurants opened <30 days ago) | Not yet in field surveys or OSM releases. | Onboard directly via Ride Merchant Portal with verified physical GPS coordinates. |
| **Categorical Search** (*"Pharmacy near me"*, *"ATM"*) | Requires spatial radius search over tagged POI taxonomy. | Query internal PostGIS spatial index filtered by category tags within rider's H3 resolution 8 cell. |
| **Inter-District Destinations Outside Dhaka** (*Chittagong, Sylhet*) | Launch gazetteer focuses primarily on Greater Dhaka metro. | Fall back to Geofabrik national town/highway gazetteer for district/thana-level resolution. |

---

## 15. Specialized Capability Workstreams

Achieving complete geospatial sovereignty requires expanding beyond basic point search and routing into four specialized technical workstreams:

```
                         [ dpMaps CORE SOVEREIGNTY ]
                                      │
         ┌────────────────┬───────────┴────┬────────────────┐
         ▼                ▼                ▼                ▼
   [ WORKSTREAM 1 ] [ WORKSTREAM 2 ] [ WORKSTREAM 3 ] [ WORKSTREAM 4 ]
    Reverse Geocode  Address Parser   Pickup Snapping   ETA Predictor
     (Pin to Text)   (Tokenization)    (Walk-up Gates)  (Speed Vectors)
```

### 15.1 Workstream 1: Reverse Geocoding (Pin Drop to Address Text)
* **The Challenge:** When a user drops a map pin, the app must display human-readable text. OpenStreetMap lacks granular house holding polygons for Dhaka residential lanes.
* **The Architecture:**
  1. Primary: Match pin coordinate against nearest `public_pois` within 100 meters (*"Near Square Hospital, West Panthapath"*).
  2. Secondary: If no landmark exists, query local **Nominatim** container for street centerline and ward (*"Road 11, Banani, Dhaka"*).
  3. Fallback: Reverse H3 cell centroid lookup to return administrative zone (*"Sector 4, Uttara"*).

### 15.2 Workstream 2: Dhaka Compound Address Parsing
* **The Challenge:** Dhaka addresses are unstructured hierarchical compounds: *"Flat 5B, House 23, Road 4, Block C, Banani, Dhaka-1213"*.
* **The Architecture:** Implement a deterministic rule-based tokenizer:
  $$\text{Input} \longrightarrow [\text{Holding: } 23] \rightarrow [\text{Road: } 4] \rightarrow [\text{Block: } C] \rightarrow [\text{Area: } \text{Banani}]$$
  The parser isolates the coarse resolvable entity (*"Road 4, Block C, Banani"*) and queries the spatial index, routing the granular holding number to driver delivery notes.

### 15.3 Workstream 3: Intelligent Pickup-Point Snapping
* **The Challenge:** Passengers frequently place map pins inside the center of large building polygons (e.g. Jamuna Future Park) or on physical expressways where cars cannot stop.
* **The Architecture:**
  - Build an inventory of **Verified Pickup Curbs** (`point_type = 'entrance'`).
  - When a rider drops a pin inside a known major venue polygon, the client snaps the pickup marker to the nearest designated physical perimeter gate (e.g. *"North Gate 2"*, *"South Parking Drop"*), generating a dashed pedestrian walking route from pin to curb.

### 15.4 Workstream 4: Dynamic Speed Profiles & Live ETA Engine
* **The Challenge:** Static OSRM graphs calculate travel times using fixed highway speed limits. In Dhaka, Mirpur to Motijheel takes 25 minutes at midnight and 100 minutes at 18:00.
* **The Architecture:**
  - **OSRM Dynamic Edge Weighting:** Utilize OSRM Multi-Level Dijkstra (MLD) with `osrm-customize`.
  - **Fleet Speed Harvesting:** Extract observed velocities from 10-second driver WebSocket pings (`utils-server/h3Index.ts`). Group historical velocities by H3 edge pairs across 30-minute time-of-day buckets.
  - **OSM Geometry Audit:** Dhaka OSM road geometry completeness is currently **UNMEASURED** and must be measured first via high-resolution satellite imagery comparison and field verification before relying on it for sole-mode routing. A formal pre-launch benchmark will measure alley connectivity in Old Dhaka and median barrier openings across primary arterials. `[UNVERIFIED - confirm completeness metrics before sole cutover]`

---

## 16. Saved Places Migration Architecture

Riders rely heavily on saved destinations (*"Home"*, *"Work"*, *"Gym"*, *"Parents' House"*). If these bookmarks contain proprietary Barikoi Place IDs or coordinates, vendor cutover would corrupt user profiles.

### 16.1 Decoupling Workflow
1. **Pre-Cutover Audit:** Scan `user_private_places` to identify records referencing vendor IDs.
2. **Reverse Resolution:** While Barikoi remains active in Phase 1, resolve every vendor place ID to its underlying first-party coordinates $(lat, lng)$ and associate it with an internal H3 resolution 9 cell.
3. **One-Time Confirmation UI:** On the mobile client, prompt the rider with a lightweight confirmation card during app open:
   > *"Confirm your Home location on the map"* (showing the pinned map curb).
4. **Permanent Vendor Independence:** Once confirmed, user bookmarks are anchored permanently to internal H3 cells and first-party coordinates. Future vendor cutovers have zero impact on saved places.

---

## 17. Deployment Sizing & Estimated Run Cost

### 17.1 Workload & Capacity Model Across Scaling Tiers
The compute requirements for dpMaps are derived directly from Ride's operational order volume and request patterns. In ride-hailing and on-demand logistics, each completed booking generates a predictable sequence of geospatial interactions:

* **Geospatial Request Profile Per Completed Order (Total: 20.4 req/order):**
  - **Routing & Distance Calculations (4.4 req/order):** Initial multi-tier quote generation, driver candidate dispatch evaluation, driver pickup navigation, and in-trip route updates.
  - **Search & Autocomplete (8.0 req/order):** Keystroke prefix and candidate lookups as rider enters destination intent.
  - **Map Vector Tiles (8.0 req/order):** Vector tile chunk requests loaded from edge cache into client MapLibre session across booking lifecycle.
  - **Total Functional Requests:** Exactly **20.4 requests per completed order** ($4.4 + 8.0 + 8.0 = 20.4$).

* **Peak-Hour Concurrency & Throughput Derivation:**
  - **Peak-Hour Concentration Factor:** **15%** of daily completed trips occur during the peak operating hour `[ASSUMPTION - requires validation against live operational telemetry]`.
  - **Second-by-Second Burst Factor:** A **1.5× surge multiplier** is applied over average peak-hour volume to account for traffic micro-bursts and concurrent driver dispatch pings `[ASSUMPTION]`.
  - $$\text{Peak Hour Volume} = \text{Daily Orders} \times 0.15$$
  - $$\text{Peak QPS / RPS} = \left(\frac{\text{Peak Hour Volume} \times \text{ReqPerOrder}}{3600 \text{ seconds}}\right) \times 1.5 = \frac{\text{Daily Orders} \times \text{ReqPerOrder}}{16000}$$

The resulting peak throughput requirements across volume tiers are summarized below:

| Parameter / Volume Tier | Tier 1: Launch (500 orders/day) | Tier 2: Growth (2,000 orders/day) | Tier 3: Scale (10,000 orders/day) | Tier 4: Mature (25,000 orders/day) |
|---|:---:|:---:|:---:|:---:|
| **Monthly Completed Orders** | **15,000** orders/mo | **60,000** orders/mo | **300,000** orders/mo | **750,000** orders/mo |
| **Daily Functional Requests (20.4 req/order)** | ~10,200 req/day | ~40,800 req/day | ~204,000 req/day | ~510,000 req/day |
| **Peak Hour Requests (15%)** | ~1,530 req/hr | ~6,120 req/hr | ~30,600 req/hr | ~76,500 req/hr |
| **Peak Routing QPS (4.4 req/order)** | **0.14 req/sec** | **0.55 req/sec** | **2.75 req/sec** | **6.88 req/sec** |
| **Peak Search QPS (8.0 req/order)** | **0.25 req/sec** | **1.00 req/sec** | **5.00 req/sec** | **12.50 req/sec** |
| **Peak Map Tile RPS (8.0 req/order)** | **0.25 req/sec** | **1.00 req/sec** | **5.00 req/sec** | **12.50 req/sec** |
| **Aggregate Peak RPS (20.4 req/order)** | **0.64 req/sec** | **2.55 req/sec** | **12.75 req/sec** | **31.88 req/sec** |

*Key Architectural Finding:* Even at mature scale (25,000 orders/day), peak routing throughput requires only **~6.88 queries/sec** (and aggregate geospatial throughput requires **~31.88 req/sec**). Because an in-memory OSRM MLD instance can process 500–1,000 shortest-path queries per second per CPU core `[ESTIMATE – measure on real graph]`, compute throughput is not the sizing bottleneck. Deployment sizing is dictated primarily by **memory capacity (RAM to hold graphs and indices in cache)** and **high availability redundancy**.

---

### 17.2 Architecture Components & Sizing per Tier
The sovereign dpMaps infrastructure consists of six decoupled component subsystems:

| Component | Tier 1 & 2 (Launch / Growth: 500–2K orders/day) | Tier 3 & 4 (Scale / Mature: 10K–25K orders/day) | Sizing & Architectural Rationale |
|---|---|---|---|
| **OSRM Primary (Routing Engine)** | 1× Cloud VPS<br>• 4 vCPU / 8 GB RAM<br>• 50 GB NVMe SSD | 1× Cloud VPS<br>• 8 vCPU / 16 GB RAM<br>• 100 GB NVMe SSD | Must fit entire contracted Bangladesh road graph in RAM (~2.0–3.0 GB `[UNVERIFIED - confirm in Docker]`). Scale tier provides extra headroom for dynamic traffic speed updates (`osrm-customize`). |
| **OSRM Standby (Hot Failover)** | 1× Cloud VPS<br>• 2 vCPU / 4 GB RAM<br>• 50 GB NVMe SSD | 1× Cloud VPS<br>• 4 vCPU / 8 GB RAM<br>• 50 GB NVMe SSD | Hot standby instance in distinct availability zone. Ingests updated graphs concurrently; takes over via load balancer health check within <300ms if primary node fails. |
| **Search & POI Cluster (MeiliSearch)** | 1× Search Node<br>• 2 vCPU / 4 GB RAM<br>• 40 GB NVMe SSD | 1× Search Node<br>• 4 vCPU / 8 GB RAM<br>• 80 GB NVMe SSD | In-memory indexing of 2,000 pre-launch seed landmarks + rolling colloquial aliases. Sub-10ms typographic and phonetic prefix matching. |
| **Spatial Database (PostGIS / Postgres)** | Existing Ride Managed Database Cluster (Dedicated Schema) | Existing Ride Managed Database Cluster (Dedicated Schema) | Stores continuous trip evidence ledger, evaluation telemetry, and `public_pois`. Partitioned via `pg_partman` (30-day raw logs, 30-day evaluation telemetry, 90-day evidence window). |
| **Cache & State Store (Redis)** | Existing Ride Redis Cluster (Shared / Dedicated Namespace) | Dedicated Redis Instance<br>• 2 GB RAM | Handles autocomplete prefix result caching, Emergency Suppression bloom filters, and rate-limiting counters. |
| **Vector Tiles & Font Glyphs (Cloudflare R2)** | Global Edge Object Storage<br>(Cloudflare R2) | Global Edge Object Storage<br>(Cloudflare R2) | Serves `bangladesh.pmtiles` (~350–390 MB `[UNVERIFIED]`), Bengali font glyph ranges (Noto Sans Bengali, ~1.5 MB), and sprite sheets with global edge caching and zero egress fees. |
| **Monitoring & Telemetry Exporter** | Prometheus Node Exporter + Grafana Dashboard | Prometheus Node Exporter + Grafana Dashboard | Collects p50/p95/p99 query latencies, fallback trigger rates, RAM saturation, and container CPU load. |

#### Empirical Measurements to Conduct on Bangladesh Extract
The following technical metrics are currently **`[UNVERIFIED - measure on build]`** and must be empirically measured using the 339 MB Geofabrik Bangladesh extract:
1. **OSRM MLD Resident Memory Footprint:** Measure exact resident set size (RSS) in Docker after `osrm-extract`, `osrm-partition`, and `osrm-customize` run on the raw PBF.
2. **Planetiler PMTiles Build Time & Archive Size:** Measure total build duration on a 4-core worker and verify output `.pmtiles` archive size at zoom 0–14.
3. **Graph Contraction Wall-Clock Time:** Measure pipeline contraction time to establish maximum staging container runtime for bi-weekly OSM synchronization.
4. **Alleyway Connectivity & Road Topology:** Conduct automated graph connectivity audits for Old Dhaka narrow lanes and median opening restrictions on primary Dhaka thoroughfares.

---

### 17.3 Estimated Monthly Infrastructure Deployment Cost
*The figures below represent infrastructure operational estimates only, labeled **`[ESTIMATE]`**. Cloud VPS and storage provider prices are **`[UNVERIFIED - confirm current rate sheets before provisioning]`**. These estimates do not include third-party commercial vendor comparisons.*

| Infrastructure Subsystem / Resource | Launch & Growth (500–2,000 orders/day) | Scale & Mature (10,000–25,000 orders/day) | Notes & Assumptions |
|---|:---:|:---:|---|
| **Primary OSRM Routing VPS** | ~$35 USD (~৳3,850 BDT) `[ESTIMATE]` | ~$60 USD (~৳6,600 BDT) `[ESTIMATE]` | 4 vCPU / 8 GB RAM upgrading to 8 vCPU / 16 GB RAM at scale. `[UNVERIFIED]` |
| **Standby OSRM Failover VPS** | ~$20 USD (~৳2,200 BDT) `[ESTIMATE]` | ~$35 USD (~৳3,850 BDT) `[ESTIMATE]` | 2 vCPU / 4 GB RAM upgrading to 4 vCPU / 8 GB RAM at scale. `[UNVERIFIED]` |
| **Search Engine Node (MeiliSearch)** | ~$15 USD (~৳1,650 BDT) `[ESTIMATE]` | ~$30 USD (~৳3,300 BDT) `[ESTIMATE]` | 2 vCPU / 4 GB RAM upgrading to 4 vCPU / 8 GB RAM at scale. `[UNVERIFIED]` |
| **Cloudflare R2 (PMTiles & Glyphs)** | ~$5 USD (~৳550 BDT) `[ESTIMATE]` | ~$15 USD (~৳1,650 BDT) `[ESTIMATE]` | Storage (<1 GB) + Class B read operations across edge locations. `[UNVERIFIED]` |
| **Database & Cache Overhead** | Co-located on existing platform cluster | ~$15 USD (~৳1,650 BDT) `[ESTIMATE]` | Marginal allocated storage and IOPS on managed Postgres/Redis. `[ESTIMATE]` |
| **TOTAL ESTIMATED INFRASTRUCTURE RUN COST** | **~$75 USD / mo (~৳8,250 BDT/mo)** `[ESTIMATE]` | **~$155 USD / mo (~৳17,050 BDT/mo)** `[ESTIMATE]` | Pure server infrastructure cost for complete autonomous geospatial stack. |

---

### 17.4 Sovereign Operating Model, Responsibilities & Governance
Maintaining high data quality and system reliability across an autonomous mapping engine requires dedicated operational responsibilities and governance workflows:

| Role / Operational Function | Core Responsibilities & Workflows | SLA & Cadence | Estimated Monthly Budget Allocation |
|---|---|:---:|:---:|
| **1. On-Call Infrastructure SRE** | Monitor OSRM container health, RAM pressure, query latency percentiles (p50, p95, p99), and fallback trigger rates. Maintain failover automation. | 24/7 incident response;<br><15 min response to Sev-1 | **~৳25,000 BDT / mo** `[ESTIMATE]` |
| **2. Automated OSM Pipeline Engineer** | Oversee bi-weekly Geofabrik `.osm.pbf` ingestion, run MLD contraction in staging, execute automated regression tests on 200 Golden OD pairs, and manage zero-downtime blue-green container cutover. | Bi-weekly release cycle;<br>automated pipeline | **~৳20,000 BDT / mo** `[ESTIMATE]` |
| **3. Data Moderation & Privacy Specialist** | Review flagged location reports and contested merchant entries; audit linguistic alias mappings; execute emergency privacy suppressions and takedowns. | Daily review queue;<br><4 hr SLA on takedowns | **~৳30,000 BDT / mo** `[ESTIMATE]` |
| **4. Field Surveyor Program Coordinator** | Coordinate Pin Tool field verification tasks for newly constructed transit gates, major commercial hubs, and hospital entrances; review merchant self-onboarded GPS markers. | Continuous weekly field survey sprints | **~৳25,000 BDT / mo** `[ESTIMATE]` |
| **5. License Ownership & ODbL Governance** | Enforce strict architectural and database separation between Ride's proprietary assets (`public_pois`, first-party telemetry, post-trip confirmations) and open-source assets (OSM road geometry, Planetiler vector tiles). Designed to keep separate; subject to counsel. | Continuous architectural enforcement | Embedded in engineering governance |
| **TOTAL ESTIMATED OPERATIONAL STAFFING** | **Comprehensive operational maintenance and data governance program** | **Continuous** | **~৳100,000 BDT / mo** `[ESTIMATE]` |

---

### 17.5 Infrastructure Scaling Triggers
To avoid over-provisioning while maintaining strict latency SLAs, infrastructure scaling is driven by concrete numeric operational triggers:

1. **CPU Saturation Trigger:** Sustained CPU utilization exceeding **60% over a 15-minute window** on the primary OSRM or search container triggers vertical core scaling or spinning up an additional read replica behind the load balancer.
2. **Query Latency (p95) Degradation:** Routing query p95 latency exceeding **15 milliseconds** (normal baseline: 2–5ms `[ESTIMATE – measure on real graph]`) or search p95 latency exceeding **30 milliseconds** triggers an automatic capacity alert and replica expansion.
3. **Container Memory (RAM) High-Water Mark:** Memory consumption exceeding **75% of container RAM limits** triggers immediate instance resizing to prevent out-of-memory (OOM) process termination of the in-memory road graph.
4. **Fallback Anomaly Threshold:** In Primary mode, if vendor fallback rates exceed **5% of total live routing queries over 1 hour**, an automated incident is declared to investigate road graph disconnects or routing profile regressions.
5. **Ledger Ingestion Queue Lag:** If background Redis evidence queue depth exceeds **10,000 pending trip events**, background worker concurrency is scaled dynamically to eliminate processing delay.

---

## 18. Routing Engine Waterfall & Production Topology

```
                                [ Dispatch / Route Request ]
                                              │
                                              ▼
                                 [ 1. PRIMARY: Local OSRM ]
                                 • Sub-5ms query latency [ESTIMATE – measure on real graph]
                                 • Local network service (separate OSRM host)
                                 • Multi-Level Dijkstra (MLD)
                                              │
                                   (Timeout >300ms or 5xx)
                                              │
                                              ▼
                                 [ 2. FALLBACK 1: Barikoi ]
                                 • Commercial SLA fallback
                                 • High-availability network
                                 • Automatically logged as anomaly
                                              │
                                   (Timeout >400ms or 5xx)
                                              │
                                              ▼
                                 [ 3. FALLBACK 2: Google ]
                                 • Circuit-breaker capped (configurable limit)
                                 • Emergency corporate continuity
                                              │
                                      (Hard Outage)
                                              │
                                              ▼
                                 [ 4. FLOOR: Haversine × 1.3 ]
                                 • Pure in-memory math (0ms)
                                 • Zero dropped orders
```

### 18.1 Implementation Code
The routing client is implemented in [`utils-server/dispatchRouter.ts`](file:///D:/My%20Projects/Current%20Project/Ride/utils-server/barikoiRoute.ts):

```typescript
// utils-server/dispatchRouter.ts
export async function getActiveRoute(
  origin: LatLng, 
  dest: LatLng, 
  vehicleType: string
): Promise<RouteResult> {
  const mode = await getPlatformConfig('routing_provider_mode') ?? 'shadow';

  if (mode === 'sole') {
    // Mode 3: Sole Sovereign Operation (Zero vendor calls)
    const osrm = await getOsrmRoute(origin, dest, vehicleType, { timeoutMs: 300 });
    if (osrm) return osrm;
    logger.error('[dispatchRouter] OSRM failed in sole mode; dropping to Haversine floor');
    return getHaversineFallback(origin, dest);
  }

  if (mode === 'primary') {
    // Mode 2: Primary Operation (OSRM first; vendor fallback on failure)
    const osrm = await getOsrmRoute(origin, dest, vehicleType, { timeoutMs: 300 });
    if (osrm) return osrm;

    logger.warn('[dispatchRouter] OSRM timeout; executing Fallback 1 (Barikoi)');
    const barikoi = await getBarikoiRoute(origin, dest, vehicleType, { timeoutMs: 400 });
    if (barikoi) return barikoi;

    logger.error('[dispatchRouter] Barikoi failed; executing Fallback 2 (Google)');
    const google = await getGoogleRouteWithCircuitBreaker(origin, dest);
    if (google) return google;

    return getHaversineFallback(origin, dest);
  }

  // Mode 1: Shadow Operation (Vendor live; local OSRM evaluated async from launch)
  const liveResult = await getBarikoiRoute(origin, dest, vehicleType);
  
  // Asynchronous non-blocking shadow benchmark
  setImmediate(async () => {
    await logShadowBenchmark(origin, dest, vehicleType, liveResult);
  });

  if (liveResult) return liveResult;
  return getHaversineFallback(origin, dest);
}
```

---

## 19. Execution Roadmap: 5-Phase Implementation Plan

```
Phase 0: Pre-Launch Seeding & Pin Tool Campaign (Pre-Launch)
├── Execute clean-room landmark collection campaign (target: 2,000 points & areas)
├── Enhance Pin Tool: aliases field, full 18-category mapping, IP warranty, public_pois export
├── Pre-generate Bengali font glyphs (Noto Sans Bengali) & upload to Cloudflare R2
└── Ingest curated landmarks into public_pois with search_aliases

Phase 1: Dual-Connected Launch & Hardening (Months 1–3)
├── Deploy OSRM container in shadow mode from Day 1 launch
├── Run Ground-Truth Calibrator using stored quote data and snapped GPS traces
├── Enforce lean quote-time routing; cap Google failover with configurable circuit breaker
└── Deliverable: Calibrated routing baseline and empirical shadow telemetry

Phase 2: The Routing Switch Flip (Target: Month 4)
├── Verify Gate 1 criteria (OSRM distance error <= 3% vs. real GPS for 3 consecutive weeks)
├── Update system_config: Promote routing_provider_mode to 'primary'
├── Retain Barikoi Places API for commercial search and reverse geocoding
└── Deliverable: Primary local OSRM dispatch with commercial vendor fallback on error

Phase 3: Autonomous Tile Hosting & Vector Assets (Months 5–6)
├── Generate bangladesh.pmtiles via Planetiler from Geofabrik extract (~350–390 MB)
├── Deploy PMTiles, Bengali glyphs, and sprites on Cloudflare R2
└── Update mobile client MapLibre style to direct R2 endpoints

Phase 4: Sovereign POI Search Engine & Sole Mode (Months 7–12)
├── Verify 5,000+ public landmarks (combining Pin Tool points, merchants, arrival clusters)
├── Satisfy Gate 2 criteria (search success >= 96% on Golden Set; 24-hour rehearsal drill)
├── Promote search_provider_mode and routing_provider_mode to 'sole'
└── Deliverable: Complete sovereign operation across routing, search, and map tiles
```

---

## 20. Risk Analysis & Mitigation Matrix

| Identified Risk | Severity | Probability | Mitigation Strategy |
|---|:---:|:---:|---|
| **Vendor ToS Infringement** (Scraping vendor geocoding strings) | Critical | Low (with safeguards) | **Hard Architectural Rule:** Never store Barikoi's returned text strings in `public_pois`. Ingest only Ride's first-party data: raw user search queries, physical driver drop-off GPS fixes, and clean-room Pin Tool landmarks. |
| **Contributor IP Contamination** (Surveyors copying from Google/Barikoi) | Critical | Medium | Enforce a digital Clean-Room Contributor Agreement on the Pin Tool. Prohibit copy-pasting from proprietary apps; permit only physical survey, OSM, and open imagery. |
| **Exposure Bias / Vendor Feedback Loop** (Trip votes merely replicating vendor's catalog) | High | Medium | Ingest 2,000 clean-room seed landmarks (§13), surface dpMaps suggestions in mixed autocomplete list from Day 1 (§13.2), direct merchant onboarding portal, and post-trip passenger verification prompts (§9.2). |
| **Privacy Breach / Stalker Risk** (Exposing residential home addresses) | Critical | Medium | Maintain strict database separation between `public_pois` (public venues, society gates, commercial hubs) and `user_private_places` (scoped to individual `user_id`, encrypted at rest). Apply a 30-day rolling purge to raw query logs. |
| **Missing Font Glyphs** (Bengali text rendering as tofu boxes in MapLibre) | High | Medium | Host pre-generated font glyph ranges for *Noto Sans Bengali* (Unicode `0980–09FF`) on Cloudflare R2 alongside PMTiles before cutting over tile styles. |
| **Noisy Phone GPS Drift** (Inaccurate ground-truth distance calculations) | High | High | Filter raw driver GPS breadcrumbs with Kalman filtering and snap coordinates to road geometry using OSRM `/match` before logging real driven distance. |
| **VPS Outage / Container Failure** | Critical | Low | Maintain multi-tier fallback waterfall in `dispatchRouter.ts`: OSRM $\rightarrow$ Barikoi $\rightarrow$ Google $\rightarrow$ Haversine. Automatic failover within 300ms. |

---

## 21. Appendix: Verified vs. Unverified Registry

In strict adherence to engineering integrity, the following registry classifies every parameter and assumption used in this specification:

| Parameter / Assumption | Metric Value | Verification Status | Source / Verification Method |
|---|---|:---:|---|
| **Geofabrik Bangladesh PBF Size** | **339 MB** | **`[VERIFIED]`** | `https://download.geofabrik.de/asia/bangladesh.html` (Captured: 2026-10-15; re-verified live). |
| **Planetiler PMTiles Size** | **~350–390 MB** | `[UNVERIFIED - confirm]` | Estimated from Planetiler OpenMapTiles zoom 14 builds on 339 MB PBF. Must verify on build. |
| **OSRM MLD Memory Footprint** | **~2.0–3.0 GB RAM** | `[UNVERIFIED - confirm]` | Estimated from standard MLD graph contraction on 339 MB extract. Must verify in Docker. |
| **Barikoi Mixed Autocomplete Display** | Permitted in UI | `[UNVERIFIED - confirm]` | Requires formal written confirmation from Barikoi account representative. |
| **H3 Cell Resolution Dimensions** | Res 10 (~15,000 m²), Res 9 (~0.1 km²) | `[UNVERIFIED - confirm]` | General spherical projection estimate. Must verify against Uber H3 official table for 23.8° N latitude. |
| **Dhaka OSM Geometry Completeness** | Connectivity of lanes | `[UNVERIFIED - confirm]` | Known structural gaps in Old Dhaka and informal settlements. Formal audit required before Sole mode. |
| **Bangladesh Data Protection Law** | Draft / Enacted 2026 | `[UNVERIFIED - confirm]` | Status of proposed Act requires formal legal opinion from local counsel. |
| **Peak-Hour Order Concentration** | **15% of daily completed trips** | `[ASSUMPTION]` | Concentration of trips occurring during the single peak operating hour. Validate against live platform order telemetry. |
| **Peak-Hour Surge Burst Factor** | **1.5× multiplier** | `[ASSUMPTION]` | Multiplier over average peak-hour volume to account for traffic micro-bursts and concurrent driver dispatch pings. Validate via telemetry. |
| **Geospatial Requests Per Completed Order** | **20.4 req/order** (4.4 routing, 8.0 search, 8.0 tiles) | `[ASSUMPTION]` | User and driver interaction profile across booking lifecycle. Validate against production API gateway access logs. |
| **OSRM Shortest-Path Throughput Per Core** | **500–1,000 queries/sec/core** | `[ESTIMATE – measure on real graph]` | In-memory MLD throughput benchmark on modern x86 cores. Must measure empirically in Docker on 339 MB Bangladesh graph. |
| **OSRM Route Query Latency** | **Sub-5ms (baseline 2–5ms)** | `[ESTIMATE – measure on real graph]` | Local network service latency. Depends on path length and response options; must benchmark on local network service. |
| **Cloud VPS Monthly Node Pricing** | **~$15–$60 USD / node / mo** | `[UNVERIFIED - confirm]` | Estimated from standard cloud VPS hosting tiers (Hetzner, DigitalOcean, Linode). Confirm current rate sheets before provisioning. |
| **Cloudflare R2 Storage & Egress** | **~$5–$15 USD / mo** | `[UNVERIFIED - confirm]` | Based on <1 GB storage and zero egress fee tier with standard Class A/B operation limits. Verify against Cloudflare billing terms. |

---

## 22. Revision Changelog

| Revision | Date | Author / Context | Summary of Major Changes |
|:---:|:---:|---|---|
| **v1.0** | Oct 2026 | Core Systems Architecture | Initial concept draft proposing dual-connected OSRM migration. |
| **v2.0** | Oct 2026 | Architecture Review | Added multi-tier volume breakdown (500 to 25K/day); added privacy separation between public and private drop-offs; specified Bengali glyph pipeline. |
| **v3.0** | Oct 2026 | Legal & Field Audit | Replaced third-party reverse geocode harvesting with clean-room first-party telemetry; added zero-billing calibrator; added phone GPS Kalman/snapping. |
| **v4.0** | Oct 2026 | Financial Audit | Replaced continuous routing baseline with honest Barikoi Lean baseline; reconciled POI counts with residential privacy rules. |
| **v5.0** | Oct 2026 | Tool Alignment | Expanded to complete 18-category taxonomy including `area` centroids. |
| **v6.0** | Oct 2026 | Ground-Truth Audit | Removed unverified 50-query benchmark claim; verified Geofabrik 339 MB national extract size; adjusted title to "Reconciled Draft". |
| **v7.0** | Oct 2026 | Sovereign Specification | **Owner-mandated complete architecture upgrade:**<br>• Established self-sufficiency as primary mandate, cost as secondary.<br>• Designed 4-mode administrative toggles (`off`, `shadow`, `primary`, `sole`).<br>• Formalized 3-layer Learning Engine (Relevance, Identity, Display Name).<br>• Defined atomic Vote Unit, H3 res 10/9 spatial indexing, and `point_type`.<br>• Built versioned normalization pipeline with hard digit/direction constraints.<br>• Established Wilson score intervals and winner thresholds (15+ riders, 5+ drivers, 3+ wks).<br>• Created continuous evidence ledger with 45-day half-life decay and two-cycle challenger rule.<br>• Designed Naming Engine with post-trip verification prompt.<br>• Formulated cultural landmark convergence rule for named residential buildings.<br>• Enforced window-scoped HMAC pseudonyms with key destruction and 30-day raw purge.<br>• Engineered anti-manipulation Sybil defenses and Provenance Firewall.<br>• Defined numeric Cutover Gates, Golden Test Sets, and 24-hr vendor-off rehearsal drill.<br>• Added specialized workstreams: Reverse Geocoding, Address Parsing, Pickup Snapping, ETA.<br>• Added Saved Places migration off vendor IDs.<br>• Added Appendix of Verified vs. Unverified Registry. |
| **v7.1** | Oct 2026 | Architecture Review Patch | **Prompt C Audit Reconciliations:**<br>• Vendor Data Isolation in Telemetry: Nullified entity IDs and coordinates in SearchEvaluationEvent for vendor selections; added vendor_suggestion_selected boolean; clarified Tier 4 vendor passthrough is display-only and never persisted.<br>• Tone & Legal Posture: Replaced all claims of absolute legal/audit immunity with exposure reduction and audit-readiness posture; marked all legal matters as subject to counsel.<br>• Rolling 90-Day Pseudonym Key: Replaced per-round key with 90-day window lifetime rotated on 30-day schedule with overlap to ensure distinct-rider counts and voting caps are preserved.<br>• Decay Math & Thresholds: Corrected 45-day half-life decay to λ = ln(2)/45 ≈ 0.0154/day; anchored thresholds on distinct entity counts; applied effective sample size (n_eff) to Wilson interval.<br>• Recursive Logging Allowlist: Replaced denylist with recursive allowlist of explicitly safe fields handling nested vendor payloads.<br>• Anti-Vandalism Takedown Controls: Protected auto-hide with verified account status, 1 report/day limit, and human review.<br>• Duration-Relative ETA Cutover Gate: Replaced flat 4-minute gate with percentage of trip duration (median ≤ 12%, p95 ≤ 25%) benchmarked against vendor error.<br>• Exposure Bias & Feedback Mitigations: Analyzed vendor coverage feedback loop and detailed 4-part architectural mitigation; added to risk matrix. |
| **v7.2** | Oct 2026 | Technical Re-Alignment | **Technical Paper Restructuring (Non-Commercial Framing):**<br>• Executive Summary Re-Framing: Removed commercial pricing framing, Google/Barikoi bills, and remittance references in §1.2 & §1.3; replaced with technical availability, latency, and vendor dependency analysis.<br>• Section 17 Replaced: Transitioned from vendor pricing comparison and break-even economics to "Deployment Sizing & Estimated Run Cost" (Capacity Model deriving peak RPS from 20.4 req/order; 6-component subsystem specs and sizing rationale; empirical measurements list; infrastructure-only cost estimates labeled [ESTIMATE]; full operating model; and concrete scaling triggers).<br>• Roadmap Budget Removal: Removed monetary figures from §19 Phase 1–4 boxes, retaining concrete technical deliverables.<br>• Appendix Streamlining: Removed vendor rate-card and pricing rows from §21; retained technical parameters (Geofabrik extract size verified live, PMTiles size, OSRM RAM, H3 dimensions, OSM completeness, legal items, mixed autocomplete permission).<br>• Evaluation Telemetry Retention Tier: Added dedicated Tier B in §11.1 for SearchEvaluationEvent and RoutingEvaluationEvent (30-day retention with partition drop; summary statistics retained only).<br>• Lexicon and Claim Moderation: Standardized to "window keys" and "90-day window" in §11.2 and §12.1; removed "immune" claims in §17.4 ("designed to keep separate; subject to counsel") and qualified vendor terms in §3.<br>• Terminology Sanitization: Removed all references to "savings", "margin expansion", and "cost premium" platform-wide. |
| **v7.3** | Oct 2026 | Technical Paper Finalization | **Reconciliation & Mathematical Alignment (Prompt E):**<br>• Workload Model Mathematical Consistency (§17.1): Aligned per-order breakdown to 4.4 routing, 8.0 search, 8.0 tiles summing to exactly 20.4 requests/order; recomputed peak throughput across all four tiers using the paper's formula (Aggregate: 0.64, 2.55, 12.75, 31.88 RPS; Routing: 0.14, 0.55, 2.75, 6.88 QPS); preserved finding that compute is not the bottleneck.<br>• Empirical Estimates Labeling (§1.2, §17.1, §17.5, §18): Explicitly marked OSRM throughput (500–1,000 QPS/core) and latency targets (sub-5ms, normal baseline 2–5ms) as `[ESTIMATE – measure on real graph]`.<br>• Host Topology Clarification (§18): Replaced "Local in-process execution" with "Local network service (separate OSRM host)" in waterfall diagram.<br>• Anti-Manipulation Alignment (§12 Diagram): Corrected burst suppression to "Max 1 vote/user/week for same cluster" matching §12.1 rule.<br>• Component Consistency (§17.5): Replaced Kafka reference with Redis evidence queue matching the §17.2 component architecture.<br>• Strategic Framing (§1.1): Affirmed that cost is not a driver of this paper; operational continuity and data sovereignty take precedence.<br>• Appendix Registry Expansion (§21): Added unverified/assumption registry entries for peak-hour share (15%), burst factor (1.5×), requests per completed order (20.4), OSRM throughput and latency estimates, Cloud VPS pricing, and Cloudflare R2 storage/egress costs. |

---
*Authored for the Ride Core Systems Architecture Group.*  
*Cross-Reference:* [`docs/reports/map-api-cost-report.md`](file:///D:/My%20Projects/Current%20Project/Ride/docs/reports/map-api-cost-report.md) | [`docs/reports/map-api-cost-report.html`](file:///D:/My%20Projects/Current%20Project/Ride/docs/reports/map-api-cost-report.html)
