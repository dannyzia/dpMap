# Stage 003: Storage Schema & Continuous Evidence Ledger Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-003 (Revision 2.0 — Storage Architecture & Continuous Evidence Ledger)  
**Stage:** 3 of 16 (Database Architecture & Storage Lifecycle)  
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§5, §8.1–8.3, §11.1)  
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)  
**Current Status:** **NotDone**  

---

## 1. Executive Summary & Objective

Legacy mapping architectures rely on static quarterly database dumps that grow obsolete as roads change and businesses move. dpMaps replaces static dumps with a **Continuous Evidence Ledger** paired with **Rolling 90-Day Evidence Windows** and **Query-Time Exponential Decay**. Every completed ride contributes atomic evidence connecting user search queries to physical drop-off coordinates, allowing the map to self-heal and adapt to urban growth automatically.

Stage 003 formalizes the complete persistence layer, aligning directly with the clean-room boundaries and physical table isolations mandated in Stage 002:
1. **Physical Table & Role Isolation:** Implements strict separation between first-party operational ride data (`orders`), vendor-derived transactional data (`ride_vendor_data`), and mapping assets (`dpmaps.*`). Grants the mapping worker role (`dpmaps_worker`) explicit column-level `SELECT` access strictly to first-party operational fields, with zero access (`REVOKE ALL`) to vendor-derived tables and customer receipts.
2. **ODbL vs. First-Party Geometry Separation:** Isolates OpenStreetMap data into `dpmaps.osm_pois` (holding the 49,881 baseline POIs from `bangladesh.poi` under ODbL attribution) while reserving `dpmaps.public_pois` strictly for first-party, clean-room proprietary landmarks.
3. **Mathematically Sound 120-Day Window Key Architecture:** Resolves the multi-key deduplication problem. Keys live **120 days** and rotate every 30 days; each vote is written under every key valid at trip completion. Distinct rider counts over any 90-day window are evaluated under the oldest qualifying key that covers the entire window, preventing overcounting.
4. **Zero-Write-Amplification Decay Model:** Implements exponential time-decay ($\lambda = \frac{\ln(2)}{45} \approx 0.0154033/\text{day}$) calculated dynamically at query and aggregation time. This eliminates destructive nightly `UPDATE` jobs across millions of partitioned rows, reserving the decay worker strictly for weekly partition drops and stats materialization scheduled off-peak at **21:00–23:00 UTC** (03:00–05:00 Dhaka time).
5. **Administrative Hierarchy (ADM0–ADM4):** Deploys national down to Ward/Union administrative boundaries (`dpmaps.admin_boundaries`) with dual full/simplified geometries, enabling first-party receipt generation without commercial vendor text.
6. **Complete Downstream Entity Schemas:** Deploys `releases`, `poi_versions`, `provenance_events`, `poi_aliases`, `query_clusters`, `suppressions`, and Tier A/B operational evaluation tables.

---

## 2. The 5-Tier Data Retention Architecture

Data persistence strictly obeys the multi-tier lifecycle defined in Concept Paper §11.1, enforcing compliance with data minimization, right-to-erasure principles, and vendor isolation:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        FIVE-TIER GEOSPATIAL RETENTION MODEL                            │
├─────────┬──────────────────────────┬───────────┬───────────────────────────────────────┤
│ Tier    │ Data Store / Contents    │ Retention │ Pruning / Deletion Mechanism          │
├─────────┼──────────────────────────┼───────────┼───────────────────────────────────────┤
│ Tier A  │ Raw Operational Logs     │ 30 Days   │ Automated daily partition drop via    │
│         │ (raw_search_events,      │           │ pg_partman / S3 lifecycle rule;       │
│         │ GPS breadcrumb streams)  │           │ zero vendor strings stored.           │
├─────────┼──────────────────────────┼───────────┼───────────────────────────────────────┤
│ Tier B  │ Evaluation Telemetry     │ 30 Days   │ Daily native partitions dropped after │
│         │ (search_eval_events,     │           │ 30 days; rolling statistical summary  │
│         │ routing_eval_events)     │           │ aggregates retained permanently.      │
├─────────┼──────────────────────────┼───────────┼───────────────────────────────────────┤
│ Tier C  │ Rolling Evidence Store   │ Rolling   │ Weekly partitions dropped at >97 days │
│         │ (trip_evidence_ledger &  │ 90 Days   │ with boundary purge; HMAC keys live   │
│         │ ledger_pseudonyms)       │ (120d Key)│ 120 days in KMS then destroyed.       │
├─────────┼──────────────────────────┼───────────┼───────────────────────────────────────┤
│ Tier D  │ Published Gazetteers     │ Permanent │ Versioned releases (pub-YYYY.MM);     │
│         │ (public_pois, osm_pois,  │ (Version) │ status lifecycle; emergency takedown  │
│         │ releases, poi_versions)  │           │ suppression target: < 4 hours.        │
├─────────┼──────────────────────────┼───────────┼───────────────────────────────────────┤
│ Tier V  │ Vendor Transactional     │ Tax / Ops │ Isolated in `public.ride_vendor_data` │
│         │ (quoted distance, fare)  │ Window    │ zero access by mapping workers.       │
└─────────┴──────────────────────────┴───────────┴───────────────────────────────────────┘
```

> [!NOTE]
> **Legal Matrix Synchronization:** As established in §4, window secret keys live for **120 days** to provide unbroken 90-day distinct-rider deduplication. Legal Review Matrix Item 2 (Stage 002) must accordingly evaluate a 120-day key lifetime rather than 90 days.

---

## 3. Physical Database Architecture & Role-Based Access Controls

The database layer runs on **PostgreSQL 16** with **PostGIS 3.4** and **pg_partman 5.x**. To enforce the clean-room legal boundary established in Stage 002, tables are distributed across dedicated schemas with granular, role-based access control (RBAC):

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                      POSTGRESQL 16 LOGICAL ARCHITECTURE & ROLES                        │
├──────────────────────────────────────────┬─────────────────────────────────────────────┤
│ Schema: `public` (Operational Database)  │ Schema: `dpmaps` (Mapping Engine Engine)    │
├──────────────────────────────────────────┼─────────────────────────────────────────────┤
│ • `orders`                               │ • `public_pois` & `poi_aliases`             │
│   (id, status, fare_bdt, dropoff_lat,    │ • `poi_versions` & `releases`               │
│    dropoff_lng, elapsed_seconds, created)│ • `osm_pois` (ODbL Baseline, 49,881 POIs)   │
│ • `ride_vendor_data` (Tier V)            │ • `trip_evidence_ledger` (Weekly Partitions)│
│   (ride_id, vendor_dest_lat,             │ • `ledger_pseudonyms` (Child Table)         │
│    vendor_dest_lng, vendor_quoted_dist_m)│ • `provenance_events` (Append-Only Log)     │
│ • `ride_receipts`                        │ • `suppressions` (Emergency Takedowns)      │
│   (ride_id, dropoff_neighborhood_text)   │ • `query_clusters` (Search Term Mapping)    │
│                                          │ • `admin_boundaries` (ADM0 to ADM4 Polygons)│
│                                          │ • `raw_search_events` (Tier A, Daily Part.) │
│                                          │ • `search_eval_events` (Tier B, Daily Part.)│
│                                          │ • `routing_eval_events` (Tier B, Daily Part)│
└──────────────────────────────────────────┴─────────────────────────────────────────────┘
```

### 3.1 Database Roles & Permission Matrix

| Role Name | Intended Service / Process | Permissions on `public` Schema | Permissions on `dpmaps` Schema |
|---|---|---|---|
| `dpmaps_worker` | Background mapping workers (`evidenceDecayWorker`, `winnerSelectionWorker`, `aliasClusteringWorker`) | `SELECT (id, status, created_at, dropoff_lat, dropoff_lng, elapsed_seconds)` on `orders`; **`REVOKE ALL` on `ride_vendor_data` and `ride_receipts`**. | Full `SELECT`, `INSERT`, `UPDATE` on `public_pois`, `poi_aliases`, `trip_evidence_ledger`, `ledger_pseudonyms`, `query_clusters`, `provenance_events`, `releases`, `poi_versions`; `SELECT` on `osm_pois` & `admin_boundaries`. |
| `ride_dispatch` | Real-time online dispatch & booking API | Full `INSERT`, `UPDATE`, `SELECT` on `orders`, `ride_vendor_data`, `ride_receipts`. | `SELECT` on `public_pois`, `poi_aliases`, `osm_pois`, `admin_boundaries`; `INSERT` on `trip_evidence_ledger` and `ledger_pseudonyms`. |
| `dpmaps_admin` | Schema migrations, DBAs, legal takedown operator | Full administrative access. | Full administrative access, schema management, and manual suppression. |
| `dpmaps_analyst`| Internal business intelligence & data science | `SELECT` on anonymized analytics views. | Read-only access to published gazetteers and aggregated evaluation summaries; barred from pseudonym hashes. |

```sql
-- DDL for Database Roles and Granular Privileges
CREATE ROLE dpmaps_worker WITH LOGIN PASSWORD '***';
CREATE ROLE ride_dispatch WITH LOGIN PASSWORD '***';
CREATE ROLE dpmaps_admin WITH LOGIN PASSWORD '***';
CREATE ROLE dpmaps_analyst WITH LOGIN PASSWORD '***';

-- Enforce zero-access defaults
REVOKE ALL ON SCHEMA public FROM dpmaps_worker;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM dpmaps_worker;

-- Grant explicit column-level whitelist on orders to dpmaps_worker
GRANT USAGE ON SCHEMA public TO dpmaps_worker;
GRANT SELECT (id, status, created_at, dropoff_lat, dropoff_lng, elapsed_seconds) 
  ON public.orders TO dpmaps_worker;

-- Explicitly block access to vendor-derived tables and receipts
REVOKE ALL ON public.ride_vendor_data FROM dpmaps_worker;
REVOKE ALL ON public.ride_receipts FROM dpmaps_worker;

-- Grant mapping schema permissions to dpmaps_worker
GRANT USAGE ON SCHEMA dpmaps TO dpmaps_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA dpmaps TO dpmaps_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA dpmaps TO dpmaps_worker;

-- Read-only restrictions for open-source basemap
REVOKE INSERT, UPDATE, DELETE ON dpmaps.osm_pois FROM dpmaps_worker;
```

---

## 4. Complete PostGIS Database Schemas & DDL

All database migration scripts are managed via Flyway or Sqitch under `migrations/dpmaps/`.

### 4.1 Extensions, Custom Types & Enums
```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pg_partman";

CREATE SCHEMA IF NOT EXISTS dpmaps;

CREATE TYPE dpmaps.point_type_enum AS ENUM (
  'building',         -- Physical structure centroid
  'entrance',         -- Specific vehicle or pedestrian gate / door
  'dropoff_point',    -- Roadside curb where vehicles halt
  'curb_stop',        -- Designated passenger pickup/dropoff bay
  'perimeter_gate',   -- Outer boundary security barrier or barrier gate
  'area'              -- Broad neighborhood, sector, or ward boundary
);

CREATE TYPE dpmaps.source_type_enum AS ENUM (
  'pin_tool',             -- Verified field surveyor with digital warranty
  'merchant_onboarding',  -- Directly onboarded merchant storefront
  'post_trip_label',      -- Passenger naming prompt upon arrival
  'trip_cluster'          -- High-confidence multi-trip evidence cluster
);

CREATE TYPE dpmaps.poi_status_enum AS ENUM (
  'candidate',        -- Evidence accumulating, not yet published
  'active',           -- Published and actively served in primary search
  'demoted',          -- Reduced ranking due to declining vote velocity
  'retired',          -- Permanently closed or replaced
  'suppressed'        -- Emergency takedown or judicial block (<4hr SLA)
);

CREATE TYPE dpmaps.vote_class_enum AS ENUM (
  'full',                 -- Exact query string match
  'prefix_only',          -- Selection made during partial keystroke prefix
  'post_trip_label'       -- Explicit post-trip passenger dropoff confirmation
);

CREATE TYPE dpmaps.provenance_event_type_enum AS ENUM (
  'publish',              -- Initial record inclusion or update
  'takedown',             -- Privacy request or judicial suppression
  'rollback',             -- Defect correction or tainted data quarantine
  'deprecate'             -- Natural staleness or permanent closure
);
```

### 4.2 Published Proprietary POIs (`dpmaps.public_pois`) & Aliases
Holds clean-room proprietary landmarks. Names are nullable with a constraint ensuring at least one exists. Statistics and lifecycle status support Stage 009 candidate selection:

```sql
CREATE TABLE dpmaps.public_pois (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name VARCHAR(255),
  bangla_name VARCHAR(255),
  category VARCHAR(64) NOT NULL CHECK (category IN (
    'transit_station', 'bus_stop', 'airport_terminal', 'ferry_terminal',
    'hospital', 'healthcare', 'pharmacy', 'school', 'university', 'education',
    'government', 'police_station', 'post_office', 'bank_atm',
    'mosque', 'temple', 'religious_site', 'shopping_mall', 'retail', 'market',
    'restaurant', 'hotel', 'residential_complex', 'commercial_building',
    'park', 'sports_facility', 'tourist_attraction', 'other'
  )),
  point_type dpmaps.point_type_enum NOT NULL DEFAULT 'dropoff_point',
  lifecycle_status dpmaps.poi_status_enum NOT NULL DEFAULT 'candidate',
  h3_res9 VARCHAR(15) NOT NULL,
  h3_res10 VARCHAR(15) NOT NULL,
  geom GEOMETRY(Point, 4326) NOT NULL,
  entrance_geom GEOMETRY(Point, 4326),
  parent_place_id UUID REFERENCES dpmaps.public_pois(id) ON DELETE SET NULL,
  confidence_score NUMERIC(5, 4) NOT NULL DEFAULT 1.0000,
  weighted_votes NUMERIC(10, 4) NOT NULL DEFAULT 0.0000,
  distinct_riders INTEGER NOT NULL DEFAULT 0,
  distinct_drivers INTEGER NOT NULL DEFAULT 0,
  active_weeks SMALLINT NOT NULL DEFAULT 0,
  publication_cycle VARCHAR(32) NOT NULL,
  provenance_version VARCHAR(16) NOT NULL DEFAULT 'v2.2',
  canonical_payload_hash CHAR(64) NOT NULL,
  audit_hmac CHAR(64) NOT NULL,
  provenance JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_poi_name_exists CHECK (canonical_name IS NOT NULL OR bangla_name IS NOT NULL)
);

CREATE INDEX idx_public_pois_geom ON dpmaps.public_pois USING GIST (geom);
CREATE INDEX idx_public_pois_entrance ON dpmaps.public_pois USING GIST (entrance_geom) WHERE entrance_geom IS NOT NULL;
CREATE INDEX idx_public_pois_h3_res9 ON dpmaps.public_pois (h3_res9);
CREATE INDEX idx_public_pois_h3_res10 ON dpmaps.public_pois (h3_res10);
CREATE INDEX idx_public_pois_category ON dpmaps.public_pois (category);
CREATE INDEX idx_public_pois_status ON dpmaps.public_pois (lifecycle_status);
CREATE INDEX idx_public_pois_parent ON dpmaps.public_pois (parent_place_id);
CREATE INDEX idx_public_pois_cycle ON dpmaps.public_pois (publication_cycle);
```

#### Search Aliases Table (`dpmaps.poi_aliases`)
Normalized search aliases are decoupled into an explicit relational table with source and audit tracking:

```sql
CREATE TABLE dpmaps.poi_aliases (
  id BIGSERIAL PRIMARY KEY,
  poi_id UUID NOT NULL REFERENCES dpmaps.public_pois(id) ON DELETE CASCADE,
  alias_text VARCHAR(255) NOT NULL,
  alias_type VARCHAR(32) NOT NULL CHECK (alias_type IN ('transliteration', 'colloquial', 'acronym', 'misspelling')),
  source VARCHAR(32) NOT NULL CHECK (source IN ('surveyor', 'merchant', 'rider_typed', 'editorial')),
  support_votes NUMERIC(8, 4) NOT NULL DEFAULT 1.0000,
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'rejected', 'takedown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_poi_alias UNIQUE (poi_id, alias_text)
);

CREATE INDEX idx_poi_aliases_text ON dpmaps.poi_aliases (alias_text);
CREATE INDEX idx_poi_aliases_poi ON dpmaps.poi_aliases (poi_id);
CREATE INDEX idx_poi_aliases_status ON dpmaps.poi_aliases (status);
```

### 4.3 POI Version History & Publication Releases
Supports immutable version history for rollback, Merkle tree verification, and TSA anchoring:

```sql
CREATE TABLE dpmaps.releases (
  release_id VARCHAR(32) PRIMARY KEY,      -- e.g. "pub-2026-11-01"
  cutoff_timestamp TIMESTAMPTZ NOT NULL,
  normalizer_version VARCHAR(32) NOT NULL,
  ruleset_version VARCHAR(32) NOT NULL,
  merkle_root CHAR(64) NOT NULL,
  tsa_receipt TEXT,                         -- RFC 3161 cryptographic receipt
  published_poi_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE dpmaps.poi_versions (
  id BIGSERIAL PRIMARY KEY,
  poi_id UUID NOT NULL REFERENCES dpmaps.public_pois(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  canonical_name VARCHAR(255),
  bangla_name VARCHAR(255),
  category VARCHAR(64) NOT NULL,
  geom GEOMETRY(Point, 4326) NOT NULL,
  entrance_geom GEOMETRY(Point, 4326),
  canonical_payload_hash CHAR(64) NOT NULL,
  audit_hmac CHAR(64) NOT NULL,
  release_id VARCHAR(32) NOT NULL REFERENCES dpmaps.releases(release_id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_poi_version UNIQUE (poi_id, version_number)
);

CREATE INDEX idx_poi_versions_poi ON dpmaps.poi_versions (poi_id);
CREATE INDEX idx_poi_versions_release ON dpmaps.poi_versions (release_id);
```

### 4.4 Continuous Evidence Ledger (`trip_evidence_ledger` & `ledger_pseudonyms`)
Captures raw trip evidence partitioned natively by week. To avoid long-term linking, raw `trip_id` is replaced with `trip_hash` keyed under the window secret:

```sql
CREATE TABLE dpmaps.trip_evidence_ledger (
  id BIGSERIAL,
  query_cluster_id VARCHAR(64) NOT NULL,
  normalized_query VARCHAR(120) NOT NULL,   -- Retained for 90d to enable normalizer replay
  typed_len SMALLINT NOT NULL CHECK (typed_len BETWEEN 1 AND 80),
  vote_class dpmaps.vote_class_enum NOT NULL DEFAULT 'full',
  h3_res10 VARCHAR(15) NOT NULL,             -- Spatial bucket (~15,000 m²)
  dropoff_geom GEOMETRY(Point, 4326) NOT NULL,-- Precise physical handset dropoff coordinate
  initial_weight NUMERIC(6, 4) NOT NULL DEFAULT 1.0000, -- Quality multiplier (odometer, completion)
  point_type dpmaps.point_type_enum NOT NULL DEFAULT 'dropoff_point',
  trip_hash CHAR(64) NOT NULL,              -- HMAC-SHA256(trip_id, WindowSecretKey)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Child table storing pseudonyms under all currently valid keys
CREATE TABLE dpmaps.ledger_pseudonyms (
  ledger_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  key_id VARCHAR(16) NOT NULL,              -- 120-day key identifier (e.g. "wk-2026-10")
  pseudonym_hash CHAR(64) NOT NULL,         -- HMAC-SHA256(rider_user_id, WindowKey)
  driver_pseudonym_hash CHAR(64) NOT NULL,  -- HMAC-SHA256(driver_id, WindowKey)
  PRIMARY KEY (ledger_id, key_id, created_at)
) PARTITION BY RANGE (created_at);

-- pg_partman 5.x native weekly partitioning
-- Note: p_type => 'native' was removed in pg_partman 5.x (native is default) [UNVERIFIED per installed version]
SELECT partman.create_parent(
  p_parent_table => 'dpmaps.trip_evidence_ledger',
  p_control => 'created_at',
  p_interval => '1 week',
  p_premake => 3,
  p_default_retention => '97 days'
);

SELECT partman.create_parent(
  p_parent_table => 'dpmaps.ledger_pseudonyms',
  p_control => 'created_at',
  p_interval => '1 week',
  p_premake => 3,
  p_default_retention => '97 days'
);

CREATE INDEX idx_ledger_cluster ON dpmaps.trip_evidence_ledger (query_cluster_id, created_at);
CREATE INDEX idx_ledger_h3 ON dpmaps.trip_evidence_ledger (h3_res10, created_at);
CREATE INDEX idx_ledger_dropoff ON dpmaps.trip_evidence_ledger USING GIST (dropoff_geom);
CREATE INDEX idx_pseudo_lookup ON dpmaps.ledger_pseudonyms (key_id, pseudonym_hash, created_at);
```

> [!IMPORTANT]
> **Normalizer Replay Policy:** To allow re-clustering when rulesets change without retaining invasive personal logs, the ledger retains the **normalized query string** (`normalized_query`) for the full 90-day ledger lifespan. All raw, unnormalized strings with typos or potential PII are strictly purged at 30 days in Tier A. Rare queries ($< 3$ distinct occurrences system-wide) are pruned before ledger ingestion.

### 4.5 Provenance Events & Emergency Suppressions
```sql
CREATE TABLE dpmaps.provenance_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type dpmaps.provenance_event_type_enum NOT NULL,
  record_id UUID NOT NULL,
  target_record_hash CHAR(64) NOT NULL,
  reason_code VARCHAR(64) NOT NULL,
  publication_cycle VARCHAR(32) NOT NULL,
  actor_id VARCHAR(64) NOT NULL,
  event_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_prov_events_record ON dpmaps.provenance_events (record_id, created_at);
CREATE INDEX idx_prov_events_cycle ON dpmaps.provenance_events (publication_cycle);

CREATE TABLE dpmaps.suppressions (
  id BIGSERIAL PRIMARY KEY,
  target_type VARCHAR(16) NOT NULL CHECK (target_type IN ('poi_id', 'h3_cell', 'name_pattern')),
  target_value VARCHAR(255) NOT NULL,
  reason VARCHAR(64) NOT NULL CHECK (reason IN ('court_order', 'privacy_request', 'security_sensitive', 'copyright_claim')),
  suppression_target_sla VARCHAR(16) NOT NULL DEFAULT '4_hours',
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  actor_id VARCHAR(64) NOT NULL,
  audit_note TEXT
);

CREATE INDEX idx_suppressions_target ON dpmaps.suppressions (target_type, target_value);
```

### 4.6 Administrative Boundaries (`dpmaps.admin_boundaries`)
Stores national boundary polygons down to Ward/Union (ADM0–ADM4) parsed from official sources. To prevent storing millions of array elements, `h3_coverage` is calculated on demand rather than stored as `TEXT[]`:

```sql
CREATE TABLE dpmaps.admin_boundaries (
  id SERIAL PRIMARY KEY,
  boundary_name VARCHAR(128) NOT NULL,
  boundary_name_bn VARCHAR(128),
  admin_level SMALLINT NOT NULL CHECK (admin_level BETWEEN 0 AND 4), -- 0=Nat, 1=Div, 2=Dist, 3=Upazila, 4=Ward
  parent_id INTEGER REFERENCES dpmaps.admin_boundaries(id) ON DELETE CASCADE,
  geom GEOMETRY(MultiPolygon, 4326) NOT NULL,          -- Simplified for high-speed spatial joins
  geom_full GEOMETRY(MultiPolygon, 4326) NOT NULL      -- High-resolution boundary for exact containment
);

CREATE INDEX idx_boundaries_geom ON dpmaps.admin_boundaries USING GIST (geom);
CREATE INDEX idx_boundaries_geom_full ON dpmaps.admin_boundaries USING GIST (geom_full);
CREATE INDEX idx_boundaries_level ON dpmaps.admin_boundaries (admin_level);
CREATE INDEX idx_boundaries_parent ON dpmaps.admin_boundaries (parent_id);
```

### 4.7 Operational & Evaluation Telemetry Tables
```sql
-- Tier A: Raw search events (30-day retention)
CREATE TABLE dpmaps.raw_search_events (
  id BIGSERIAL,
  user_id VARCHAR(64) NOT NULL,              -- Retained strictly within 30-day Tier A boundary
  typed_query VARCHAR(80) NOT NULL,
  selected_source VARCHAR(16) NOT NULL,
  selected_place_id VARCHAR(64),
  latency_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

SELECT partman.create_parent(
  p_parent_table => 'dpmaps.raw_search_events',
  p_control => 'created_at',
  p_interval => 'daily',
  p_premake => 3,
  p_default_retention => '30 days'
);

-- Tier B: Search evaluation metrics
CREATE TABLE dpmaps.search_eval_events (
  id BIGSERIAL,
  selected_source VARCHAR(16) NOT NULL,
  latency_ms INTEGER NOT NULL,
  result_count SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

SELECT partman.create_parent(
  p_parent_table => 'dpmaps.search_eval_events',
  p_control => 'created_at',
  p_interval => 'daily',
  p_premake => 3,
  p_default_retention => '30 days'
);

-- Tier B: Routing evaluation metrics
CREATE TABLE dpmaps.routing_eval_events (
  id BIGSERIAL,
  osrm_duration_s INTEGER NOT NULL,
  osrm_distance_m INTEGER NOT NULL,
  actual_driven_duration_s INTEGER NOT NULL,
  actual_driven_distance_m INTEGER NOT NULL,
  vendor_duration_s INTEGER,                 -- Quoted baseline (coordinates stripped)
  vendor_distance_m INTEGER,
  duration_error_pct NUMERIC(5, 2) NOT NULL,
  distance_error_pct NUMERIC(5, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

SELECT partman.create_parent(
  p_parent_table => 'dpmaps.routing_eval_events',
  p_control => 'created_at',
  p_interval => 'daily',
  p_premake => 3,
  p_default_retention => '30 days'
);

-- Cross-reference Tier V: Vendor data table resides in public schema (Stage 002)
-- public.ride_vendor_data (ride_id UUID PRIMARY KEY, vendor_dest_lat FLOAT, vendor_dest_lng FLOAT, vendor_quoted_dist_m INT, vendor_quoted_dur_s INT)
```

---

## 5. 120-Day Window Key Schedule & Deduplication Architecture

### 5.1 Why 90-Day Keys Fail (The Deduplication Simulation)
A cryptographic key created on day $S$ can only hash votes created on or after day $S$. If keys rotate every 30 days and each vote is hashed only under the newest active key:
- A rider visiting on Day 20 is hashed with `Key_1`.
- The same rider visiting on Day 40 is hashed with `Key_2`.
- When querying distinct riders over a 90-day window, the system cannot match `Hash(User, Key_1)` with `Hash(User, Key_2)`.
- **Result:** The system counts the same rider multiple times, inflating distinct counts by **1.6× to 2.3×** and causing candidate gates ($\ge 15$ riders) to pass spuriously.
- Furthermore, on Day 91, when `Key_1` is destroyed, the oldest surviving key (`Key_2`) has only covered 60 days of history, silently collapsing the evaluation window.

### 5.2 The 120-Day Multi-Key Solution
To evaluate exact distinct counts across an unbroken 90-day rolling window $[t-90, t]$:
1. **120-Day Key Lifetime:** Keys rotate every 30 days and live for **120 days** before destruction.
2. **Multi-Key Ingestion:** When a vote occurs at time $t$, it is hashed and written under **every key currently valid at time $t$** (up to 4 active keys) into `dpmaps.ledger_pseudonyms`.
3. **Oldest Qualifying Key Evaluation:** When evaluating distinct riders across the 90-day window $[t-90, t]$, the aggregation query filters exclusively on the **oldest key that was created at least 90 days before $t$ and remains valid throughout the window**. Because that key was continuously active across the entire 90-day span, every vote in the window was hashed under it, yielding exact ground-truth deduplication:

```
Day:    0     30     60     90    120    150    180
Key 1:  [========================] (Destroyed Day 120)
Key 2:        [========================] (Destroyed Day 150)
Key 3:              [========================]
Key 4:                    [========================]

At Day 100:
Evaluation window: Days 10 to 100 (90 days).
Key 1 was created on Day 0 (covers Days 10-100 completely) -> EVALUATE DISTINCT RIDERS UNDER KEY 1.
```

### 5.3 KMS Lifecycle & Provider HMAC API
- **Provider HMAC API:** To prevent keys from ever residing in application memory, hashing operations should utilize the cloud provider's native HMAC API (e.g., AWS KMS `GenerateMac` / `VerifyMac` with HMAC_256 keys, or HashiCorp Vault Transit engine).
- **Deletion Waiting Period:** Most cloud KMS services enforce a mandatory waiting period of 7 to 30 days before permanent key deletion (`ScheduleKeyDeletion`) `[UNVERIFIED per provider]`. To prevent any cryptographic leakage during this waiting period, the key management daemon immediately disables the key (`kms:DisableKey`) at Day 121, mathematically preventing any further HMAC operations before final destruction.

```typescript
// utils-server/windowKeyManager.ts
import { KMSClient, GenerateMacCommand, DisableKeyCommand } from '@aws-sdk/client-kms';

export interface ActiveWindowKey {
  keyId: string;        // e.g. "wk-2026-08"
  kmsArn: string;
  createdAt: Date;
  expiresAt: Date;      // createdAt + 120 days
}

export class WindowKeyManager {
  private kms = new KMSClient({ region: 'ap-southeast-1' });
  private validKeys: ActiveWindowKey[] = [];

  /**
   * Generates pseudonyms across ALL currently valid keys (up to 4).
   */
  public async hashRiderForIngestion(userId: string): Promise<{ keyId: string; hash: string }[]> {
    const results = [];
    for (const key of this.validKeys) {
      const cmd = new GenerateMacCommand({
        KeyId: key.kmsArn,
        MacAlgorithm: 'HMAC_SHA_256',
        Message: Buffer.from(userId)
      });
      const res = await this.kms.send(cmd);
      results.push({
        keyId: key.keyId,
        hash: Buffer.from(res.Mac!).toString('hex')
      });
    }
    return results;
  }

  /**
   * Returns the oldest key valid across the full [now - 90d, now] window.
   */
  public getDeduplicationKey(asOfDate: Date = new Date()): ActiveWindowKey {
    const windowStart = new Date(asOfDate.getTime() - 90 * 86400000);
    // Find keys created <= windowStart and expiring >= asOfDate
    const qualifying = this.validKeys.filter(
      k => k.createdAt <= windowStart && k.expiresAt >= asOfDate
    );
    if (qualifying.length === 0) {
      throw new Error('No 120-day key covers the complete 90-day window');
    }
    // Return the oldest qualifying key
    return qualifying.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  }
}
```

---

## 6. Zero-Write-Amplification Query-Time Decay & Worker

### 6.1 Mathematical Formulation
Concept Paper §8.3 defines the exponential time-decay formula:
$$w(\Delta t) = w_0 \cdot e^{-\lambda \Delta t}$$
where $\Delta t$ is elapsed days and $\lambda = \frac{\ln(2)}{45} \approx 0.0154033/\text{day}$.

### 6.2 Zero-Write-Amplification Implementation
Rows in `dpmaps.trip_evidence_ledger` are **strictly append-only and immutable**. Decayed weight is calculated dynamically via PostgreSQL SQL expressions at aggregation time, eliminating nightly in-place row mutations:

```sql
CREATE OR REPLACE FUNCTION dpmaps.calculate_decayed_weight(
  p_initial_weight NUMERIC,
  p_created_at TIMESTAMPTZ,
  p_as_of TIMESTAMPTZ DEFAULT NOW()
) RETURNS NUMERIC AS $$
DECLARE
  v_days NUMERIC;
  v_lambda CONSTANT NUMERIC := 0.0154033; -- ln(2) / 45 days
BEGIN
  v_days := EXTRACT(EPOCH FROM (p_as_of - p_created_at)) / 86400.0;
  IF v_days < 0 THEN
    v_days := 0;
  END IF;
  RETURN ROUND(p_initial_weight * EXP(-v_lambda * v_days), 4);
END;
$$ LANGUAGE plpgsql IMMUTABLE;
```

### 6.3 Ground-Truth Aggregation Query (Under Oldest Qualifying Key)
```sql
-- Evaluates cluster evidence under the single oldest qualifying 120-day key
SELECT 
  tel.query_cluster_id,
  tel.h3_res10,
  COUNT(DISTINCT lp.pseudonym_hash) AS distinct_riders,
  COUNT(DISTINCT lp.driver_pseudonym_hash) AS distinct_drivers,
  ROUND(SUM(dpmaps.calculate_decayed_weight(tel.initial_weight, tel.created_at)), 4) AS total_decayed_weight,
  ST_AsGeoJSON(ST_Centroid(ST_Collect(tel.dropoff_geom)))::json AS cluster_centroid
FROM dpmaps.trip_evidence_ledger tel
JOIN dpmaps.ledger_pseudonyms lp 
  ON lp.ledger_id = tel.id 
 AND lp.created_at = tel.created_at
WHERE tel.created_at >= NOW() - INTERVAL '90 days'
  AND lp.key_id = 'wk-2026-08' -- Oldest qualifying key covering the full 90-day span
  AND tel.query_cluster_id = 'cluster_jamuna_future_park'
GROUP BY tel.query_cluster_id, tel.h3_res10
HAVING COUNT(DISTINCT lp.pseudonym_hash) >= 15;
```

### 6.4 The Pruning Worker (`workers/evidenceDecayWorker.ts`)
Scheduled off-peak between **21:00 and 23:00 UTC** (03:00–05:00 AM Dhaka local time):
1. **Partition Drop:** Calls `partman.run_maintenance_proc()` to drop partitions older than 97 days.
2. **Boundary Row Prune:** Executes a targeted delete strictly on the oldest surviving boundary partition for records older than 90 days:
   ```sql
   DELETE FROM dpmaps.trip_evidence_ledger
   WHERE created_at < NOW() - INTERVAL '90 days'
     AND created_at >= NOW() - INTERVAL '97 days';
   ```
3. **Stats Refresh:** Refreshes the cluster evidence summary view `dpmaps.mv_cluster_evidence_stats`.

---

## 7. Automated Test Suite Requirements

Stage 003 mandates the following test validations before Phase 1 deployment:
1. **Deduplication Ground-Truth Verification:** Simulate 300 riders visiting across 120 days. Verify that distinct rider counts match mathematical ground truth exactly at Days 91, 100, and 120 without overcounting.
2. **Irreversible Key Destruction:** Confirm that once a 120-day key is disabled/deleted in KMS, pseudonyms generated under that key can never be reconstructed from user IDs.
3. **Right-to-Erasure Verification:** Assert that when a user requests account deletion, executing `DELETE FROM dpmaps.ledger_pseudonyms WHERE pseudonym_hash IN (...)` across all active keys successfully expunges their voting history while keys remain valid.

---

## 8. Deliverables & Definition of Done

- [ ] PostgreSQL 16 database initialized with PostGIS 3.4 and pg_partman 5.x.
- [ ] Database roles created (`dpmaps_worker`, `ride_dispatch`, `dpmaps_admin`, `dpmaps_analyst`).
- [ ] Explicit column-level whitelist on `orders` and `REVOKE ALL` on `ride_vendor_data` and `ride_receipts` verified via automated permission tests.
- [ ] DDL deployed: `public_pois`, `poi_aliases`, `poi_versions`, `releases`, `osm_pois`, `trip_evidence_ledger`, `ledger_pseudonyms`, `provenance_events`, `suppressions`, `query_clusters`, `admin_boundaries`, and evaluation tables.
- [ ] 120-day key schedule and multi-key ingestion implemented; oldest-qualifying-key aggregation verified against simulated ground truth.
- [ ] Query-time exponential decay function `dpmaps.calculate_decayed_weight` deployed; zero-write-amplification verified.
- [ ] Weekly partitioning active via `pg_partman` with maintenance jobs scheduled at 21:00–23:00 UTC.
- [ ] Emergency takedown mechanism verified against the **<4 hour SLA**.
- [ ] Administrative boundaries ingested for ADM0 to ADM4 with dual `geom` and `geom_full`.
