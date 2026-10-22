# Stage 003: Storage Schema & Continuous Evidence Ledger Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-003 (Revision 2.6 — Audited PostGIS Storage Architecture, Clean-Room Evidence Ledger & Cross-Stage Adoptions)  
**Stage:** 3 of 16 (Database Architecture & Storage Lifecycle)  
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§5, §8.1–8.3, §11.1)  
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)  
**Current Status:** **NotDone**  

---

## 1. Executive Summary & Objective

Legacy mapping architectures rely on static quarterly database dumps that grow obsolete as roads change and businesses move. dpMaps replaces static dumps with a **Continuous Evidence Ledger** paired with **Rolling 90-Day Evidence Windows** and **Query-Time Exponential Decay**. Every completed ride contributes atomic evidence connecting user search queries to physical drop-off coordinates, allowing the map to self-heal and adapt to urban growth automatically.

Stage 003 formalizes the complete persistence layer, aligning directly with the clean-room boundaries and physical table isolations mandated in Stage 002:
1. **Physical Table & Role Isolation:** Implements strict separation between first-party operational ride data (`orders`), vendor-derived transactional data (`ride_vendor_data`), and mapping assets (`dpmaps.*`). Grants the mapping worker role (`dpmaps_worker`) explicit column-level `SELECT` access strictly to first-party operational fields, with zero access (`REVOKE ALL`) to vendor-derived tables and customer receipts.
2. **ODbL vs. First-Party Geometry Separation:** Isolates OpenStreetMap data into `dpmaps.osm_pois` (holding the 50,545 baseline POIs from `bangladesh.poi` under ODbL attribution) while reserving `dpmaps.public_pois` strictly for first-party, clean-room proprietary landmarks.
3. **Cryptographically Mitigated 135-Day Window Key Architecture:** Resolves the multi-key deduplication problem with operational rotation margin. Keys live **135 days** and rotate every 30 days (providing 15 days of rotation jitter slack); each vote is written under every key valid at trip completion. Distinct rider counts over any 90-day window are evaluated under the oldest qualifying key that covers the entire window, preventing overcounting while defining an explicit partial-window mode at launch.
4. **Zero-Write-Amplification Decay Model:** Implements exponential time-decay ($\lambda = \frac{\ln(2)}{45} \approx 0.0154033/\text{day}$) calculated dynamically at query and aggregation time. This eliminates destructive nightly `UPDATE` jobs across millions of partitioned rows, reserving the decay worker strictly for weekly partition drops and stats materialization scheduled off-peak at **21:00–23:00 UTC** (03:00–05:00 Dhaka time).
5. **Administrative Hierarchy (ADM0–ADM4):** Deploys national down to Ward/Union administrative boundaries (`dpmaps.admin_boundaries`) with dual full/simplified geometries, enabling first-party receipt generation without commercial vendor text (with explicit warnings against clipping land to crude ADM0 coastlines).
6. **Complete Downstream Entity Schemas:** Deploys `releases`, `release_pois`, `poi_versions`, `provenance_events`, `poi_aliases`, `query_clusters`, `suppressions`, `ledger_invalidations`, and clean-room evaluation telemetry tables (zero vendor raw quotes stored).

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
│ Tier C  │ Rolling Evidence Store   │ Rolling   │ Weekly partitions dropped at >90 days │
│         │ (trip_evidence_ledger &  │ 90 Days   │ with boundary purge on both tables;   │
│         │ ledger_pseudonyms)       │ (135d Key)│ HMAC keys live 135d then destroyed.   │
├─────────┼──────────────────────────┼───────────┼───────────────────────────────────────┤
│ Tier D  │ Published Gazetteers     │ Permanent │ Versioned releases (pub-YYYY.MM);     │
│         │ (public_pois, osm_pois,  │ (Version) │ status lifecycle; emergency takedown  │
│         │ releases, poi_versions)  │           │ suppression: <1hr auto, <4hr review.  │
├─────────┼──────────────────────────┼───────────┼───────────────────────────────────────┤
│ Tier V  │ Vendor Transactional     │ Tax / Ops │ Isolated in `public.ride_vendor_data` │
│         │ (quoted distance, fare)  │ Window    │ zero access by mapping workers.       │
└─────────┴──────────────────────────┴───────────┴───────────────────────────────────────┘
```

> [!NOTE]
> **Legal Matrix Synchronization:** As established in §5, window secret keys live for **135 days** (rotated every 30 days) to provide unbroken 90-day distinct-rider deduplication with 15 days of operational rotation jitter. Legal Review Matrix Item 2 (Stage 002) must accordingly evaluate a 135-day key lifetime rather than 90 days.

---

## 3. Physical Database Architecture & Role-Based Access Controls

The database layer runs on **PostgreSQL 16** with **PostGIS 3.4** and **pg_partman 5.x**. To enforce the clean-room legal boundary established in Stage 002, tables are distributed across dedicated schemas with granular, role-based access control (RBAC):

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                      POSTGRESQL 16 LOGICAL ARCHITECTURE & ROLES                        │
├──────────────────────────────────────────┬─────────────────────────────────────────────┤
│ Schema: `public` (Operational Database)  │ Schema: `dpmaps` (Mapping Engine Engine)    │
├──────────────────────────────────────────┼─────────────────────────────────────────────┤
│ • `orders` [ASSUMPTION on Ride backend]  │ • `public_pois` & `poi_aliases`             │
│   (id, status, fare_bdt, dropoff_lat,    │ • `poi_versions`, `releases`, `release_pois`│
│    dropoff_lng [DRIVER GPS FIX], created)│ • `osm_pois` (ODbL Baseline, 50,545 POIs)   │
│ • `ride_vendor_data` (Tier V)            │ • `trip_evidence_ledger` (Weekly Partitions)│
│   (ride_id, vendor_dest_lat,             │ • `ledger_pseudonyms` (Child Table)         │
│    vendor_dest_lng, vendor_quoted_dist_m)│ • `ledger_invalidations` (Fraud Purge Table)│
│ • `ride_receipts`                        │ • `provenance_events` (Append-Only Log)     │
│   (ride_id, dropoff_neighborhood_text)   │ • `suppressions` (Emergency Takedowns)      │
│                                          │ • `query_clusters` (Search Term Mapping)    │
│                                          │ • `admin_boundaries` (ADM0 to ADM4 Polygons)│
│                                          │ • `raw_search_events` (Tier A, Daily Part.) │
│                                          │ • `search_eval_events` (Tier B, Daily Part.)│
│                                          │ • `routing_eval_events` (Tier B, Daily Part)│
└──────────────────────────────────────────┴─────────────────────────────────────────────┘
```

> [!CAUTION]
> **Operational Backend Schema Assumptions:** Table names and column names on `public.orders` (`dropoff_lat`, `dropoff_lng`) are `[ASSUMPTION]` representations of the Ride production backend. In all cases, `dropoff_lat` and `dropoff_lng` MUST represent the physical handset driver GPS end-fix. Whitelisting a vendor-returned destination coordinate to mapping workers violates Clean-Room Hard Rule 1.

### 3.1 Migration Execution Sequence & Database Roles

To guarantee successful automated migrations without dependency failures, deployment scripts must execute in strict document order:
1. **Migration Phase 1 (Extensions & Schemas):** Install PostGIS and pg_partman extensions; initialize schemas `dpmaps` and `partman` (§4.1).
2. **Migration Phase 2 (Prerequisite Operational Stubs):** Ensure prerequisite operational tables in schema `public` (`orders`, `ride_receipts`, `ride_vendor_data`) exist.
3. **Migration Phase 3 (Core DDL, Partitions & Views):** Create tables, partitioning schemes, indexes, and views (§4.2–§4.8, §6.3).
4. **Migration Phase 4 (RBAC Provisioning & Grants):** Provision database roles and apply granular, per-table privileges (below).

```sql
-- Phase 2 Prerequisite Operational Stubs (public schema)
-- Provided for standalone scratchpad testing; in production these exist in the core Ride database
CREATE TABLE IF NOT EXISTS public.orders (
  id UUID PRIMARY KEY,
  status VARCHAR(32) NOT NULL,
  fare_bdt NUMERIC(10, 2),
  dropoff_lat NUMERIC(9, 6) NOT NULL, -- Physical driver handset GPS end-fix
  dropoff_lng NUMERIC(9, 6) NOT NULL, -- Physical driver handset GPS end-fix
  elapsed_seconds INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.ride_receipts (
  ride_id UUID PRIMARY KEY REFERENCES public.orders(id),
  dropoff_neighborhood_text VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.ride_vendor_data (
  ride_id UUID PRIMARY KEY REFERENCES public.orders(id),
  vendor_dest_lat NUMERIC(9, 6) NOT NULL,
  vendor_dest_lng NUMERIC(9, 6) NOT NULL,
  vendor_quoted_dist_m INTEGER NOT NULL,
  vendor_quoted_dur_s INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 4 DDL for Database Roles and Granular Privileges
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

-- Granular mapping schema permissions to dpmaps_worker
GRANT USAGE ON SCHEMA dpmaps TO dpmaps_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA dpmaps TO dpmaps_worker;

-- Mutable entities
GRANT SELECT, INSERT, UPDATE ON dpmaps.public_pois, dpmaps.poi_aliases, dpmaps.query_clusters, dpmaps.suppressions TO dpmaps_worker;

-- Append-Only Entities (STRICT ENFORCEMENT: Zero UPDATE or DELETE)
GRANT SELECT, INSERT ON dpmaps.provenance_events, dpmaps.releases, dpmaps.poi_versions, dpmaps.release_pois, dpmaps.ledger_invalidations TO dpmaps_worker;
REVOKE UPDATE, DELETE ON dpmaps.provenance_events, dpmaps.releases, dpmaps.poi_versions, dpmaps.release_pois, dpmaps.ledger_invalidations FROM dpmaps_worker;

-- Evidence ledger (Pruning worker only deletes expired partitions/rows)
GRANT SELECT, DELETE ON dpmaps.trip_evidence_ledger, dpmaps.ledger_pseudonyms TO dpmaps_worker;
REVOKE UPDATE ON dpmaps.trip_evidence_ledger, dpmaps.ledger_pseudonyms FROM dpmaps_worker;

-- Read-only references
GRANT SELECT ON dpmaps.osm_pois, dpmaps.admin_boundaries, dpmaps.active_dedup_key TO dpmaps_worker;
REVOKE INSERT, UPDATE, DELETE ON dpmaps.osm_pois, dpmaps.admin_boundaries, dpmaps.active_dedup_key FROM dpmaps_worker;

-- Permissions for online ride_dispatch API
GRANT USAGE ON SCHEMA dpmaps TO ride_dispatch;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA dpmaps TO ride_dispatch;
GRANT SELECT, INSERT ON dpmaps.trip_evidence_ledger, dpmaps.ledger_pseudonyms TO ride_dispatch;
GRANT INSERT ON dpmaps.raw_search_events, dpmaps.search_eval_events, dpmaps.routing_eval_events TO ride_dispatch;
GRANT SELECT ON dpmaps.public_pois, dpmaps.poi_aliases, dpmaps.osm_pois, dpmaps.admin_boundaries, dpmaps.suppressions, dpmaps.active_dedup_key TO ride_dispatch;

-- Permissions for dpmaps_analyst
GRANT USAGE ON SCHEMA dpmaps TO dpmaps_analyst;
GRANT SELECT ON dpmaps.public_pois, dpmaps.poi_aliases, dpmaps.releases, dpmaps.admin_boundaries, dpmaps.search_eval_events, dpmaps.routing_eval_events TO dpmaps_analyst;
REVOKE ALL ON dpmaps.ledger_pseudonyms, dpmaps.trip_evidence_ledger, dpmaps.raw_search_events FROM dpmaps_analyst;
```

---

## 4. Complete PostGIS Database Schemas & DDL

All database migration scripts are managed via Flyway or Sqitch under `migrations/dpmaps/`.

### 4.1 Extensions, Custom Types & Enums
```sql
CREATE EXTENSION IF NOT EXISTS "postgis";

-- Ensure pg_partman schema is explicitly provisioned
CREATE SCHEMA IF NOT EXISTS partman;
CREATE EXTENSION IF NOT EXISTS "pg_partman" SCHEMA partman;

CREATE SCHEMA IF NOT EXISTS dpmaps;
CREATE TABLE IF NOT EXISTS dpmaps.active_dedup_key (
  singleton_id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton_id),
  key_id VARCHAR(16) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
  'suppressed'        -- Emergency takedown (<1hr auto, <4hr review)
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

### 4.2 Published Proprietary POIs (`dpmaps.public_pois`), Category Synonyms & Aliases
Holds clean-room proprietary landmarks. Place IDs are minted once using `gen_random_uuid()` (random UUIDv4) and are NEVER derived from cell or name (preventing re-identification and ID churn). Names are nullable with a constraint ensuring at least one exists.

```sql
-- Canonical category set: single unified taxonomy without redundant synonym pairs
CREATE TABLE dpmaps.public_pois (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name VARCHAR(255),
  bangla_name VARCHAR(255),
  category VARCHAR(64) NOT NULL CHECK (category IN (
    'transit_station', 'bus_stop', 'ferry_terminal', 'airport',
    'hospital', 'pharmacy',
    'school', 'university',
    'government', 'police_station', 'post_office',
    'bank', 'atm',
    'mosque', 'temple', 'worship',
    'shopping_mall', 'market', 'supermarket',
    'restaurant', 'hotel', 'fuel',
    'residential_complex', 'commercial_building',
    'park', 'sports_facility', 'tourist_attraction', 'landmark',
    'society_gate', 'intersection', 'area', 'other'
  )),
  point_type dpmaps.point_type_enum NOT NULL DEFAULT 'dropoff_point',
  lifecycle_status dpmaps.poi_status_enum NOT NULL DEFAULT 'candidate',
  h3_res9 VARCHAR(15) NOT NULL,
  h3_res10 VARCHAR(15) NOT NULL,
  geom GEOMETRY(Point, 4326) NOT NULL,
  entrance_geom GEOMETRY(Point, 4326),
  parent_place_id UUID REFERENCES dpmaps.public_pois(id) ON DELETE SET NULL,
  superseded_by UUID REFERENCES dpmaps.public_pois(id) ON DELETE SET NULL,
  confidence_score NUMERIC(5, 4) NOT NULL DEFAULT 0.0000, -- Candidates default to 0.0 until published
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
CREATE INDEX idx_public_pois_superseded ON dpmaps.public_pois (superseded_by);
CREATE INDEX idx_public_pois_cycle ON dpmaps.public_pois (publication_cycle);

-- Category Synonym Mapping Table (maps OSM tags, legacy terms, and surveyor aliases to canonical categories)
CREATE TABLE dpmaps.category_synonym_mappings (
  synonym_category VARCHAR(64) PRIMARY KEY,
  canonical_category VARCHAR(64) NOT NULL
);

INSERT INTO dpmaps.category_synonym_mappings (synonym_category, canonical_category) VALUES
  ('station', 'transit_station'),
  ('transit', 'transit_station'),
  ('airport_terminal', 'airport'),
  ('healthcare', 'hospital'),
  ('education', 'school'),
  ('bank_atm', 'atm'),
  ('financial', 'bank'),
  ('religious_site', 'worship'),
  ('religious', 'worship'),
  ('mall', 'shopping_mall'),
  ('retail', 'shopping_mall'),
  ('food', 'restaurant'),
  ('commercial', 'commercial_building'),
  ('recreation', 'park'),
  ('gas_station', 'fuel'),
  ('filling_station', 'fuel')
ON CONFLICT (synonym_category) DO NOTHING;
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
Supports immutable version history for rollback, Merkle tree verification, and TSA anchoring (strictly append-only; foreign keys use `ON DELETE RESTRICT`):

```sql
CREATE TABLE dpmaps.releases (
  release_id VARCHAR(32) PRIMARY KEY,      -- e.g. "pub-2026-11-01"
  cutoff_timestamp TIMESTAMPTZ NOT NULL,
  normalizer_version VARCHAR(32) NOT NULL,
  ruleset_version VARCHAR(32) NOT NULL,
  ruleset_hash CHAR(64) NOT NULL,          -- SHA-256 of active normalization and publication rules
  gate_config_snapshot JSONB NOT NULL,     -- Snapshot of the 6 publication gate thresholds
  merkle_root CHAR(64) NOT NULL,
  tsa_receipt TEXT,                         -- RFC 3161 cryptographic receipt
  published_poi_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE dpmaps.poi_versions (
  id BIGSERIAL PRIMARY KEY,
  poi_id UUID NOT NULL REFERENCES dpmaps.public_pois(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL,
  canonical_name VARCHAR(255),
  bangla_name VARCHAR(255),
  category VARCHAR(64) NOT NULL,
  lifecycle_status dpmaps.poi_status_enum NOT NULL DEFAULT 'active',
  geom GEOMETRY(Point, 4326) NOT NULL,
  entrance_geom GEOMETRY(Point, 4326),
  parent_place_id UUID,
  aliases JSONB NOT NULL DEFAULT '[]',     -- Snapshot of active aliases at time of release
  canonical_payload_hash CHAR(64) NOT NULL,
  audit_hmac CHAR(64) NOT NULL,
  release_id VARCHAR(32) NOT NULL REFERENCES dpmaps.releases(release_id) ON DELETE RESTRICT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_poi_version UNIQUE (poi_id, version_number)
);

CREATE INDEX idx_poi_versions_poi ON dpmaps.poi_versions (poi_id);
CREATE INDEX idx_poi_versions_release ON dpmaps.poi_versions (release_id);

-- Explicit Release Membership Junction Table (Append-only; RESTRICT deletion)
CREATE TABLE dpmaps.release_pois (
  release_id VARCHAR(32) NOT NULL REFERENCES dpmaps.releases(release_id) ON DELETE RESTRICT,
  poi_id UUID NOT NULL REFERENCES dpmaps.public_pois(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL,
  PRIMARY KEY (release_id, poi_id)
);

CREATE INDEX idx_release_pois_lookup ON dpmaps.release_pois (release_id, poi_id);
```

### 4.4 Continuous Evidence Ledger & Invalidation Architecture

Captures raw trip evidence partitioned natively by week. To avoid long-term linking, raw `trip_id` is replaced with `trip_hash` computed independently of window secret keys using a static operational ingestion salt.

> [!NOTE]
> **Ledger Field Justifications & Mitigations:**
> - `dropoff_geom`: Justified strictly as the physical location ground-truth needed to compute curb centroids and drop-off clusters. Re-identification is mitigated by hashing `trip_id` and driver identity, isolating user identity to 30-day Tier A logs, and applying k-anonymity gates before publication.
> - `trip_hash`: `HMAC-SHA256(trip_id, IngestionSalt)` provides key-independent collision detection. Because `created_at` represents the deterministic handset trip completion timestamp (`trip_completed_at`) rather than ingestion time, `CONSTRAINT uq_ledger_trip UNIQUE (trip_hash, created_at)` allows dispatch retries to execute `ON CONFLICT (trip_hash, created_at) DO NOTHING` safely across network partitions.
> - `normalized_query`: Retained for 90 days to allow normalizer ruleset replays; raw search queries with typos or potential PII are purged at 30 days in Tier A.
> - **Rare-Query Mechanism ($\ge 3$ queries) & Commit Timing:** Query frequency classification is evaluated by `ride_dispatch` at booking time using a fast, ephemeral Redis counter (`query_freq:{cluster_id}` with 7-day TTL) and cached on the booking session. The actual evidence record is committed to `dpmaps.trip_evidence_ledger` **strictly at trip completion** when the physical driver handset GPS fix (`dropoff_geom`) and handset completion timestamp (`created_at`) are captured. If `query_freq < 3`, the record is committed with `vote_class = 'prefix_only'`. Mapping workers (`dpmaps_worker`) do not read raw search events.

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
  trip_hash CHAR(64) NOT NULL,              -- Key-independent token: HMAC-SHA256(trip_id, IngestionSalt)
  created_at TIMESTAMPTZ NOT NULL,          -- Deterministic trip completion timestamp from dispatch
  PRIMARY KEY (id, created_at),
  CONSTRAINT uq_ledger_trip UNIQUE (trip_hash, created_at)
) PARTITION BY RANGE (created_at);

-- Child table storing pseudonyms under all currently valid keys
CREATE TABLE dpmaps.ledger_pseudonyms (
  ledger_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  key_id VARCHAR(16) NOT NULL,              -- 135-day key identifier (e.g. "wk-2026-10")
  pseudonym_hash CHAR(64) NOT NULL,         -- HMAC-SHA256(rider_user_id, WindowKey)
  driver_pseudonym_hash CHAR(64) NOT NULL,  -- HMAC-SHA256(driver_id, WindowKey)
  PRIMARY KEY (ledger_id, key_id, created_at)
) PARTITION BY RANGE (created_at);

-- Side table for Sybil/collusion invalidations without mutating immutable ledger rows
CREATE TABLE dpmaps.ledger_invalidations (
  ledger_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  reason VARCHAR(64) NOT NULL CHECK (reason IN ('fraud_sybil', 'burst_suppression', 'collusion', 'audit_purge', 'quarantine')),
  invalidated_by VARCHAR(64) NOT NULL,
  invalidated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ledger_id, created_at)
);

CREATE INDEX idx_invalidations_lookup ON dpmaps.ledger_invalidations (ledger_id, created_at);

-- pg_partman 5.x native weekly partitioning setup
SELECT partman.create_parent(
  p_parent_table => 'dpmaps.trip_evidence_ledger',
  p_control => 'created_at',
  p_interval => '1 week',
  p_premake => 3
);

SELECT partman.create_parent(
  p_parent_table => 'dpmaps.ledger_pseudonyms',
  p_control => 'created_at',
  p_interval => '1 week',
  p_premake => 3
);

-- Configure strict 90-day retention and force table purge (retention_keep_table = false)
UPDATE partman.part_config
SET retention = '90 days',
    retention_keep_table = false
WHERE parent_table IN ('dpmaps.trip_evidence_ledger', 'dpmaps.ledger_pseudonyms');

CREATE INDEX idx_ledger_cluster ON dpmaps.trip_evidence_ledger (query_cluster_id, created_at);
CREATE INDEX idx_ledger_h3 ON dpmaps.trip_evidence_ledger (h3_res10, created_at);
CREATE INDEX idx_ledger_dropoff ON dpmaps.trip_evidence_ledger USING GIST (dropoff_geom);
CREATE INDEX idx_pseudo_lookup ON dpmaps.ledger_pseudonyms (key_id, pseudonym_hash, created_at);
```

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
  target_type VARCHAR(16) NOT NULL CHECK (target_type IN ('poi_id', 'osm_poi_id', 'h3_cell', 'name_pattern')),
  target_value VARCHAR(255) NOT NULL, -- UUID for poi_id, 'osm_type:osm_id' (e.g. 'M:1024') for osm_poi_id
  reason VARCHAR(64) NOT NULL CHECK (reason IN ('court_order', 'privacy_request', 'security_sensitive', 'copyright_claim', 'sybil_attack')),
  is_auto_hidden BOOLEAN NOT NULL DEFAULT FALSE,
  auto_hide_reason VARCHAR(64),       -- Trigger reason (e.g. 'threshold_rider_flags', 'residential_house_complaint')
  reported_at TIMESTAMPTZ NOT NULL,   -- Timestamp when complaint was logged (no default; enables SLA measurement)
  suppression_target_sla VARCHAR(16) NOT NULL DEFAULT '1_hour', -- <1hr automated, <4hr editorial review
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  adjudicated_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  actor_id VARCHAR(64) NOT NULL,
  audit_note TEXT
);

CREATE INDEX idx_suppressions_target ON dpmaps.suppressions (target_type, target_value);
-- Evaluated without mutable predicate to ensure valid PostgreSQL index creation
CREATE INDEX idx_suppressions_active ON dpmaps.suppressions (applied_at, expires_at);
```

### 4.6 Administrative Boundaries (`dpmaps.admin_boundaries`)
Stores national boundary polygons down to Ward/Union (ADM0–ADM4) parsed from official sources. To prevent storing millions of array elements, `h3_coverage` is calculated on demand rather than stored as `TEXT[]`. 

> [!WARNING]
> **Coastline & Coastal Places Caution:** Per AGENTS.md §7, the ADM0 file is a crude coastline (1,513 vertices). Clipping land boundaries or places against it deletes approximately 676 real coastal and island places. Do NOT clip against ADM0. ADM3 (upazila/thana) and ADM4 (ward/union) are `[UNVERIFIED — requires BBS ingestion]`.

```sql
CREATE TABLE dpmaps.admin_boundaries (
  id SERIAL PRIMARY KEY,
  boundary_name VARCHAR(128) NOT NULL,
  boundary_name_bn VARCHAR(128),
  admin_level SMALLINT NOT NULL CHECK (admin_level BETWEEN 0 AND 4), -- 0=Nat, 1=Div, 2=Dist, 3=Upazila, 4=Ward
  parent_id INTEGER REFERENCES dpmaps.admin_boundaries(id) ON DELETE RESTRICT,
  source VARCHAR(64) NOT NULL,                         -- Explicit source attribution (no invented defaults)
  license VARCHAR(32) NOT NULL,                        -- Specific verified license
  capture_date DATE NOT NULL,                          -- Acquisition/ingestion date
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
  selected_source VARCHAR(16) NOT NULL CHECK (selected_source IN ('dpmaps', 'osm', 'vendor', 'history')),
  selected_place_id VARCHAR(64),
  latency_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at),
  CONSTRAINT chk_raw_vendor_place_null CHECK (selected_source != 'vendor' OR selected_place_id IS NULL)
) PARTITION BY RANGE (created_at);

SELECT partman.create_parent(
  p_parent_table => 'dpmaps.raw_search_events',
  p_control => 'created_at',
  p_interval => '1 day',
  p_premake => 3
);

UPDATE partman.part_config
SET retention = '30 days',
    retention_keep_table = false
WHERE parent_table = 'dpmaps.raw_search_events';

-- Tier B: Search evaluation metrics (supports Gate 1 & Gate 2 cutover calculations)
CREATE TABLE dpmaps.search_eval_events (
  id BIGSERIAL,
  search_success BOOLEAN NOT NULL,
  exit_distance_delta_m NUMERIC(7, 2),        -- Distance between selected pin and physical driver drop-off
  search_radius_m INTEGER,
  vendor_suggestion_selected BOOLEAN NOT NULL DEFAULT FALSE,
  query_cluster_id VARCHAR(64),
  selected_source VARCHAR(16) NOT NULL CHECK (selected_source IN ('dpmaps', 'osm', 'vendor', 'history')),
  selected_place_id VARCHAR(64),
  latency_ms INTEGER NOT NULL,
  result_count SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at),
  CONSTRAINT chk_search_eval_vendor_null CHECK (
    (selected_source != 'vendor' AND vendor_suggestion_selected = FALSE) OR 
    (vendor_suggestion_selected = TRUE AND selected_place_id IS NULL)
  )
) PARTITION BY RANGE (created_at);

SELECT partman.create_parent(
  p_parent_table => 'dpmaps.search_eval_events',
  p_control => 'created_at',
  p_interval => '1 day',
  p_premake => 3
);

UPDATE partman.part_config
SET retention = '30 days',
    retention_keep_table = false
WHERE parent_table = 'dpmaps.search_eval_events';

-- Tier B: Routing evaluation metrics (Strict Clean-Room: zero vendor coordinates or quotes stored)
CREATE TABLE dpmaps.routing_eval_events (
  id BIGSERIAL,
  vehicle_type VARCHAR(16) NOT NULL CHECK (vehicle_type IN ('car', 'bike', 'cng')),
  tod_bucket VARCHAR(16) NOT NULL CHECK (tod_bucket IN ('morning_peak', 'evening_peak', 'off_peak', 'night')),
  osrm_duration_s INTEGER NOT NULL,
  osrm_distance_m INTEGER NOT NULL,
  actual_driven_duration_s INTEGER NOT NULL,
  actual_driven_distance_m INTEGER NOT NULL,
  vendor_duration_error_pct NUMERIC(5, 2),   -- Calculated error percentage vs actual driven (raw quote omitted)
  vendor_distance_error_pct NUMERIC(5, 2),   -- Calculated error percentage vs actual driven (raw quote omitted)
  duration_error_pct NUMERIC(5, 2) NOT NULL, -- OSRM error vs actual driven
  distance_error_pct NUMERIC(5, 2) NOT NULL, -- OSRM error vs actual driven
  corridor_overlap_pct NUMERIC(5, 2),
  route_deviation_flag BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

SELECT partman.create_parent(
  p_parent_table => 'dpmaps.routing_eval_events',
  p_control => 'created_at',
  p_interval => '1 day',
  p_premake => 3
);

UPDATE partman.part_config
SET retention = '30 days',
    retention_keep_table = false
WHERE parent_table = 'dpmaps.routing_eval_events';
```

### 4.8 Baseline POIs, Search Term Clusters & Vendor Data Isolation

#### OpenStreetMap Baseline Gazetteers (`dpmaps.osm_pois`)
Holds 50,545 baseline places imported from `bangladesh.poi` under ODbL license attribution. Note that Mapsforge IDs are snapshot-specific sequential numbers ('M', id), anchored to the snapshot date:

```sql
CREATE TABLE dpmaps.osm_pois (
  osm_type CHAR(1) NOT NULL, -- 'N' (node), 'W' (way), 'R' (relation), 'M' (Mapsforge baseline)
  osm_id BIGINT NOT NULL,
  snapshot_date DATE NOT NULL,
  name VARCHAR(255) NOT NULL,
  name_en VARCHAR(255),
  name_bn VARCHAR(255),
  primary_script VARCHAR(10) NOT NULL, -- 'bengali', 'latin', 'mixed'
  category VARCHAR(64) NOT NULL,
  tags JSONB NOT NULL DEFAULT '{}',
  h3_res9 VARCHAR(15) NOT NULL,
  h3_res10 VARCHAR(15) NOT NULL,
  geom GEOMETRY(Point, 4326) NOT NULL,
  license_classification VARCHAR(32) NOT NULL DEFAULT 'osm_odbl_attributed',
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (osm_type, osm_id, snapshot_date)
);

CREATE INDEX idx_osm_pois_geom ON dpmaps.osm_pois USING GIST (geom);
CREATE INDEX idx_osm_pois_h3_res9 ON dpmaps.osm_pois (h3_res9);
CREATE INDEX idx_osm_pois_category ON dpmaps.osm_pois (category);
```

#### Query Clusters Table (`dpmaps.query_clusters`)
Maintains normalized query representations generated by the Stage 007 text normalization pipeline:

```sql
CREATE TABLE dpmaps.query_clusters (
  cluster_id VARCHAR(64) PRIMARY KEY,
  canonical_query VARCHAR(120) NOT NULL,
  normalized_tokens TEXT[] NOT NULL,
  bengali_phonetic_key VARCHAR(120),
  alias_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_query_clusters_canonical ON dpmaps.query_clusters (canonical_query);
```

#### Tier V Vendor Data Table (`public.ride_vendor_data`)
Stores third-party vendor transactional data strictly isolated in the operational `public` schema (mandated by Stage 002). Mapping workers possess zero access:

```sql
CREATE TABLE public.ride_vendor_data (
  ride_id UUID PRIMARY KEY,
  vendor_dest_lat NUMERIC(9, 6) NOT NULL,
  vendor_dest_lng NUMERIC(9, 6) NOT NULL,
  vendor_quoted_dist_m INTEGER NOT NULL,
  vendor_quoted_dur_s INTEGER NOT NULL,
  vendor_provider VARCHAR(16) NOT NULL
    CHECK (vendor_provider IN ('barikoi', 'google')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Zero access for mapping workers (enforced via Stage 002 provenance firewall)
REVOKE ALL ON public.ride_vendor_data FROM dpmaps_worker;
```

### 4.9 TOD Speed & ETA Correction Tables (Stage 004 Consumers)
First-party measurements keyed by ODbL-derived OSM node identifiers (isolated OSM layer). Zero vendor data, zero pseudonymous vote data. Written by `workers/trafficHarvester.ts` and the ETA correction job (Stage 004 §6). Nothing merges into `public_pois` (Architectural Invariant 4).

```sql
CREATE TABLE dpmaps.segment_speeds_tod (
  from_osm_node BIGINT NOT NULL,
  to_osm_node BIGINT NOT NULL,
  tod_bucket VARCHAR(16) NOT NULL
    CHECK (tod_bucket IN ('morning_peak', 'evening_peak', 'off_peak', 'night')),
  vehicle_type VARCHAR(16) NOT NULL CHECK (vehicle_type IN ('car', 'bike', 'cng')),
  harmonic_speed_kmh NUMERIC(5, 2) NOT NULL,
  sample_count INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_osm_node, to_osm_node, tod_bucket, vehicle_type)
);

CREATE TABLE dpmaps.h3_edge_speeds_tod (
  h3_from VARCHAR(15) NOT NULL,
  h3_to VARCHAR(15) NOT NULL,
  tod_bucket VARCHAR(16) NOT NULL
    CHECK (tod_bucket IN ('morning_peak', 'evening_peak', 'off_peak', 'night')),
  vehicle_type VARCHAR(16) NOT NULL CHECK (vehicle_type IN ('car', 'bike', 'cng')),
  harmonic_speed_kmh NUMERIC(5, 2) NOT NULL,
  sample_count INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (h3_from, h3_to, tod_bucket, vehicle_type)
);

CREATE TABLE dpmaps.eta_tod_corrections (
  vehicle_type VARCHAR(16) NOT NULL CHECK (vehicle_type IN ('car', 'bike', 'cng')),
  tod_bucket VARCHAR(16) NOT NULL
    CHECK (tod_bucket IN ('morning_peak', 'evening_peak', 'off_peak', 'night')),
  k_factor NUMERIC(6, 4) NOT NULL,
  sample_count INTEGER NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (vehicle_type, tod_bucket, window_end)
);

-- First-party derived aggregates: read/write for the pipeline worker, read for analysts.
GRANT SELECT, INSERT, UPDATE ON dpmaps.segment_speeds_tod, dpmaps.h3_edge_speeds_tod,
  dpmaps.eta_tod_corrections TO dpmaps_worker;
GRANT SELECT ON dpmaps.segment_speeds_tod, dpmaps.h3_edge_speeds_tod,
  dpmaps.eta_tod_corrections TO dpmaps_analyst;
```

### 4.10 Takedown Reports, Challengers & Search Feed Views (Rev 2.4 — batch-2 adoption, additive only)

Consumers: Stage 011 (traveler-qualified takedown reports), Stage 009 (two-cycle challenger tracking, incumbent pointer), Stage 008 (dual physically-isolated search feed views — replaces the phantom `dpmaps.v_search_feed`).

```sql
-- 0. Operational stub completion: the traveler qualifier (Stage 011) needs rider identity
--    on orders. The Stage 003 §3.1 stub lists no user_id column; add it additively.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS user_id VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_orders_user_created ON public.orders (user_id, created_at);

-- 1. Traveler-qualified takedown reports (Stage 011)
CREATE TABLE dpmaps.takedown_reports (
  id BIGSERIAL PRIMARY KEY,
  poi_id UUID NOT NULL REFERENCES dpmaps.public_pois(id) ON DELETE CASCADE,
  reporter_user_id VARCHAR(64) NOT NULL,
  reporter_trust_score SMALLINT NOT NULL,
  traveler_qualified BOOLEAN NOT NULL,        -- F-011-2: rode to destination cell in 90 d
  report_reason VARCHAR(64) NOT NULL,
  report_details TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'auto_hidden', 'confirmed', 'rejected')),
  reported_at TIMESTAMPTZ NOT NULL,           -- NO default: SLA clock start (Stage 003 discipline)
  adjudicated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_takedown_reports_poi ON dpmaps.takedown_reports (poi_id, reported_at);
CREATE INDEX idx_takedown_reports_user ON dpmaps.takedown_reports (reporter_user_id, reported_at);

-- 2. Two-cycle challenger tracking (Stage 009 §7)
CREATE TABLE dpmaps.provisional_challengers (
  id BIGSERIAL PRIMARY KEY,
  query_cluster_id VARCHAR(64) NOT NULL,
  challenger_h3_res10 VARCHAR(15) NOT NULL,
  challenger_cell_set TEXT[] NOT NULL,        -- anchor + k=1 ring snapshot for the cycle
  incumbent_poi_id UUID NOT NULL REFERENCES dpmaps.public_pois(id),
  cycle_1_score NUMERIC(6, 4) NOT NULL,
  cycle_1_cycle VARCHAR(32) NOT NULL,
  cycle_2_score NUMERIC(6, 4),
  cycle_2_cycle VARCHAR(32),
  status VARCHAR(16) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'promoted', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_provisional_challengers_lookup
  ON dpmaps.provisional_challengers (query_cluster_id, challenger_h3_res10, status);

-- 3. Incumbent association for query clusters (Stage 009 §9)
ALTER TABLE dpmaps.query_clusters
  ADD COLUMN published_poi_id UUID REFERENCES dpmaps.public_pois(id);

-- 4. Dual search feed views (Stage 008 §3) — replaces the phantom dpmaps.v_search_feed
CREATE OR REPLACE VIEW dpmaps.v_search_feed_first_party AS
SELECT
  'pub_' || p.id::text AS id,
  p.canonical_name, p.bangla_name, p.category, p.point_type,
  p.h3_res9, p.h3_res10,
  ST_Y(p.geom) AS lat, ST_X(p.geom) AS lng,
  COALESCE(a.aliases, '{}') AS search_aliases,
  COALESCE(ph.phonetic_keys, '{}') AS bengali_phonetic_keys,
  p.confidence_score, p.lifecycle_status
FROM dpmaps.public_pois p
LEFT JOIN LATERAL (
  SELECT array_agg(alias_text) AS aliases
  FROM dpmaps.poi_aliases al WHERE al.poi_id = p.id AND al.status = 'active'
) a ON TRUE
LEFT JOIN LATERAL (  -- aggregated: a plain JOIN on published_poi_id would multiply rows
  SELECT array_agg(DISTINCT qc.bengali_phonetic_key)
         FILTER (WHERE qc.bengali_phonetic_key IS NOT NULL) AS phonetic_keys
  FROM dpmaps.query_clusters qc WHERE qc.published_poi_id = p.id
) ph ON TRUE
WHERE p.lifecycle_status = 'active';  -- INVARIANT: exactly one row per POI (sync dedupe)

CREATE OR REPLACE VIEW dpmaps.v_search_feed_osm AS
SELECT
  'osm_' || o.osm_type || ':' || o.osm_id::text AS id,
  o.name AS canonical_name, o.name_bn AS bangla_name, o.category, 'dropoff_point' AS point_type,
  o.h3_res9, o.h3_res10,
  ST_Y(o.geom) AS lat, ST_X(o.geom) AS lng,
  '{}'::text[] AS search_aliases,
  NULL::text[] AS bengali_phonetic_keys,
  0.0000 AS confidence_score,
  'active' AS lifecycle_status
FROM dpmaps.osm_pois o
WHERE o.is_deleted = FALSE;

-- Grants (staged roles)
GRANT SELECT, INSERT, UPDATE ON dpmaps.takedown_reports, dpmaps.provisional_challengers TO dpmaps_admin;
GRANT SELECT ON dpmaps.takedown_reports, dpmaps.provisional_challengers TO dpmaps_analyst;
GRANT SELECT ON dpmaps.v_search_feed_first_party, dpmaps.v_search_feed_osm TO dpmaps_worker;
```

### 4.11 Post-Trip Label Staging & Bilingual Publication Gate (Rev 2.5 — batch-3 adoption, additive only)

Consumers: Stage 010 (post-trip label staging with cycle-bounded uniqueness; bilingual requirement at publication time). Candidates remain single-script; `active` requires both names.

```sql
-- 1. Post-trip label staging (Stage 010 §4)
CREATE TABLE dpmaps.post_trip_labels (
  id BIGSERIAL PRIMARY KEY,
  poi_id UUID REFERENCES dpmaps.public_pois(id) ON DELETE CASCADE,
  h3_res10 VARCHAR(15) NOT NULL,
  submitted_text VARCHAR(120) NOT NULL,
  normalized_text VARCHAR(120) NOT NULL,
  submission_type VARCHAR(16) NOT NULL CHECK (submission_type IN ('text_entry', 'chip_selection')),
  pseudonym_hash CHAR(64) NOT NULL,           -- Deterministic: computed via active_dedup_key.key_id for the cycle
  trip_hash CHAR(64) NOT NULL,
  publication_cycle VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_rider_poi_cycle UNIQUE (poi_id, pseudonym_hash, publication_cycle)
);
CREATE INDEX idx_post_trip_labels_poi ON dpmaps.post_trip_labels (poi_id);
CREATE INDEX idx_post_trip_labels_h3 ON dpmaps.post_trip_labels (h3_res10);

-- 2. Bilingual publication gate (Stage 010 §3.1) — candidates stay single-script
ALTER TABLE dpmaps.public_pois
  ADD CONSTRAINT chk_poi_bilingual_active
  CHECK (lifecycle_status <> 'active'
         OR (canonical_name IS NOT NULL AND bangla_name IS NOT NULL));

-- Grants (staged roles)
GRANT SELECT, INSERT ON dpmaps.post_trip_labels TO ride_dispatch;
GRANT SELECT ON dpmaps.post_trip_labels TO dpmaps_analyst;
```

### 4.12 Invalidation Vocabulary, OSM Road Names & Saved-Place Identity (Rev 2.6 — batch-4 adoption, additive only)

Consumers: Stage 012 (`driver_bias` invalidation reason), Stage 013 (reverse-geocode Tier 2 roads), Stage 014 (sovereign saved-place identity & confirmation state).

```sql
-- 1. Invalidation vocabulary widening (F-012-1): add 'driver_bias'
ALTER TABLE dpmaps.ledger_invalidations DROP CONSTRAINT ledger_invalidations_reason_check;
ALTER TABLE dpmaps.ledger_invalidations ADD CONSTRAINT ledger_invalidations_reason_check
  CHECK (reason IN ('fraud_sybil','burst_suppression','collusion','audit_purge','quarantine','driver_bias'));

-- 2. OSM road names for reverse geocoder Tier 2 (F-013-2) — isolated ODbL layer
CREATE TABLE dpmaps.osm_road_names (
  way_id BIGINT NOT NULL,
  name VARCHAR(255),
  name_bn VARCHAR(255),
  highway_class VARCHAR(32) NOT NULL,
  geom GEOMETRY(LineString, 4326) NOT NULL,
  snapshot_date DATE NOT NULL,
  PRIMARY KEY (way_id, snapshot_date)
);
CREATE INDEX idx_osm_road_names_geom ON dpmaps.osm_road_names USING GIST (geom);
GRANT SELECT ON dpmaps.osm_road_names TO dpmaps_worker;
GRANT SELECT ON dpmaps.osm_road_names TO dpmaps_analyst;

-- 3. Saved-places sovereign identity & confirmation state (F-014-2/4; public schema,
--    mirrors Rev 2.4 item-0 precedent for operational stubs)
ALTER TABLE public.user_private_places
  ADD COLUMN IF NOT EXISTS sovereign_place_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS needs_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS resolution_spread_meters NUMERIC(8,2);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_private_places_sovereign
  ON public.user_private_places (sovereign_place_id);
```

---

## 5. 135-Day Window Key Schedule & Deduplication Architecture

### 5.1 Why 90-Day Keys Fail (The Deduplication Simulation)
A cryptographic key created on day $S$ can only hash votes created on or after day $S$. If keys rotate every 30 days and each vote is hashed only under the newest active key:
- A rider visiting on Day 20 is hashed with `Key_1`.
- The same rider visiting on Day 40 is hashed with `Key_2`.
- When querying distinct riders over a 90-day window, the system cannot match `Hash(User, Key_1)` with `Hash(User, Key_2)`.
- **Result:** The system counts the same rider multiple times, inflating distinct counts by **1.6× to 2.3×** and causing candidate gates ($\ge 15$ riders) to pass spuriously.
- Furthermore, on Day 91, when `Key_1` is destroyed, the oldest surviving key (`Key_2`) has only covered 60 days of history, silently collapsing the evaluation window.

### 5.2 The 135-Day Multi-Key Solution & Operational Slack
In an ideal 120-day schedule ($90 + 30 = 120$), keys have **zero operational margin**. If scheduled key rotation is delayed by even 1 day due to job queue latency, deployment locks, or maintenance, there is a 1-to-3 day window where no key covers the complete 90-day span, causing aggregation queries to fail or discard historical votes.

To provide operational robustness, dpMaps specifies a **135-day key lifetime**:
1. **135-Day Key Lifetime:** Keys rotate every 30 days and live for **135 days** before destruction ($90\text{ days window} + 30\text{ days rotation cadence} + 15\text{ days jitter tolerance}$).
2. **Multi-Key Ingestion:** When a vote occurs at time $t$, it is hashed and written under **every key currently valid at time $t$** (up to 5 active keys: $\lceil 135 / 30 \rceil = 5$) into `dpmaps.ledger_pseudonyms`.
3. **Oldest Qualifying Key Evaluation:** When evaluating distinct riders across the 90-day window $[t-90, t]$, the aggregation query selects the **oldest key created at least 90 days before $t$ and remaining valid throughout the window**. With 15 days of buffer, rotation jitter between 0 and 14 days causes zero gaps in coverage.
4. **Cold-Start Launch Rule (Strict Privacy Floor):** During the initial 89 days following launch ($t < 90\text{ days}$), `wk-launch-01` serves as the active evaluation key. To uphold the privacy and consensus baseline required by Concept Paper §11.1, publication gates **MUST NOT scale down** the required thresholds (15 distinct riders, 5 distinct drivers, 70% share, 20-point margin). Places must either achieve the full un-scaled 15-rider / 5-driver thresholds on available data or remain in candidate review until Day 90. Privacy and consensus floors are never relaxed.

```
Day:    0     30     60     90    120   135    150    165    180
Key 1:  [===================================] (Destroyed Day 135)
Key 2:        [===================================] (Destroyed Day 165)
Key 3:              [===================================]
Key 4:                    [===================================]
Key 5:                          [===================================]

At Day 100:
Evaluation window: Days 10 to 100 (90 days).
Key 1 created at Day 0 covers Days 10-100 completely -> EVALUATE DISTINCT RIDERS UNDER KEY 1.
(Even if Key 2 rotation had slipped 5 days, Key 1 still covers up to Day 135 with 35 days of safety margin).
```

### 5.3 KMS Lifecycle, Provider-Agnostic Interface & Failure Resiliency

#### Provider-Agnostic Key Management Interface
To maintain clean-room independence and prevent locking dpMaps to proprietary cloud vendor features (supporting both cloud KMS and on-premise/VPS Vault deployments per Stage 016), the key manager conforms to an abstract provider interface:

```typescript
// utils-server/windowKeyManager.ts
export interface ActiveWindowKey {
  keyId: string;        // e.g. "wk-2026-10"
  keyUri: string;       // Provider ARN or Vault key path
  createdAt: Date;
  expiresAt: Date;      // createdAt + 135 days
}

export interface IKeyManagementProvider {
  generateHmac(keyUri: string, message: Buffer): Promise<string>;
  disableKey(keyUri: string): Promise<void>;
  scheduleKeyDeletion(keyUri: string, waitingPeriodDays: number): Promise<void>;
}
```

#### Key Management Service Implementation & KMS Call Volume
Each completed trip produces up to 7 cryptographic operations (1 rider HMAC per active key [up to 5 keys] + 1 driver HMAC + 1 key-independent trip_hash):

```typescript
export class WindowKeyManager {
  private provider: IKeyManagementProvider;
  private validKeys: ActiveWindowKey[] = [];
  private staticIngestionSalt: string;
  private launchDate: Date;

  constructor(provider: IKeyManagementProvider, launchDate: Date, staticIngestionSalt: string) {
    this.provider = provider;
    this.launchDate = launchDate;
    this.staticIngestionSalt = staticIngestionSalt;
  }

  /**
   * Generates pseudonyms across ALL currently valid keys in parallel.
   * Produces rider pseudonyms, driver pseudonym, and key-independent trip_hash.
   */
  public async hashTripEvidenceForIngestion(
    riderUserId: string,
    driverId: string,
    tripId: string
  ): Promise<{
    pseudonyms: { keyId: string; riderHash: string; driverHash: string }[];
    tripHash: string;
  }> {
    if (this.validKeys.length === 0) {
      throw new Error('Key rotation error: Zero active window keys available for ingestion');
    }

    // Parallel execution across active keys (up to 5 keys)
    const pseudonymPromises = this.validKeys.map(async (key) => {
      const [riderHash, driverHash] = await Promise.all([
        this.provider.generateHmac(key.keyUri, Buffer.from(riderUserId)),
        this.provider.generateHmac(key.keyUri, Buffer.from(driverId))
      ]);
      return { keyId: key.keyId, riderHash, driverHash };
    });

    const pseudonyms = await Promise.all(pseudonymPromises);

    // Key-independent trip_hash uses static ingestion salt to ensure retry idempotency across rotations
    const crypto = await import('crypto');
    const tripHash = crypto
      .createHmac('sha256', this.staticIngestionSalt)
      .update(`trip-idempotency:${tripId}`)
      .digest('hex');

    return { pseudonyms, tripHash };
  }

  /**
   * Returns the qualifying key for distinct-rider aggregation.
   * Handles Cold-Start phase (t < 90 days) and 135-day rolling evaluation.
   */
  public getDeduplicationKey(asOfDate: Date = new Date()): { key: ActiveWindowKey; isColdStart: boolean; windowDays: number } {
    const elapsedSinceLaunchDays = (asOfDate.getTime() - this.launchDate.getTime()) / 86400000;

    // Cold-Start Mode: launch phase (<90 days)
    if (elapsedSinceLaunchDays < 90) {
      const launchKey = this.validKeys[0];
      if (!launchKey) throw new Error('Launch key missing during cold start');
      return {
        key: launchKey,
        isColdStart: true,
        windowDays: Math.max(1, Math.floor(elapsedSinceLaunchDays))
      };
    }

    // Steady-State: Find keys covering [asOfDate - 90d, asOfDate]
    const windowStart = new Date(asOfDate.getTime() - 90 * 86400000);
    const qualifying = this.validKeys.filter(
      k => k.createdAt <= windowStart && k.expiresAt >= asOfDate
    );

    if (qualifying.length === 0) {
      throw new Error(`Key schedule error: No active key spans the full 90-day window [${windowStart.toISOString()} - ${asOfDate.toISOString()}]`);
    }

    // Return the oldest qualifying key spanning the entire 90-day window
    qualifying.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return { key: qualifying[0], isColdStart: false, windowDays: 90 };
  }
}
```

#### Cryptographic Lifecycle & Right-to-Erasure Boundary
- **KMS Failure & Ephemeral RAM-Only Buffer:** If the KMS provider experiences temporary unresponsiveness or network partition, trip evidence events are routed to an ephemeral Redis stream instance configured strictly with `save ""` (RDB snapshots disabled) and `appendonly no` (AOF disabled), operating purely in volatile RAM. The buffered payload preserves the original `trip_completed_at` timestamp. If KMS remains unreachable at 24 hours, events are dropped with an alert metric `dpmaps_kms_dlq_dropped_total` and an emergency incident log. Under no circumstances are raw customer user IDs written unhashed to persistent disk.
- **Key Disablement & Provider Deletion Waiting Period:** Cloud KMS providers enforce a mandatory waiting period of 7 to 30 days before permanent key destruction `[UNVERIFIED per provider]`. At Day 136, the rotation daemon executes `disableKey()`, preventing any subsequent HMAC operations. Permanent deletion is scheduled following the provider-mandated delay.
- **Right-to-Erasure Boundary (Legal Matrix Items 2 & 4):**
  - While keys are active ($<135$ days), a GDPR / Bangladesh draft DPA right-to-erasure request computes the user's active HMACs across current keys and executes `DELETE FROM dpmaps.ledger_pseudonyms WHERE pseudonym_hash IN (...)`.
  - Once a key is disabled and deleted after 135 days, past pseudonyms generated under that key can no longer be derived from user IDs. Past votes remain mutually grouped under the orphaned hash until purged by the natural 90-day partition drop, but can no longer be linked back to the user's real-world identity.

---

## 6. Query-Time Decay, Canonical Aggregation View & Pruning Worker

### 6.1 Mathematical Formulation
Concept Paper §8.3 defines the continuous exponential time-decay formula:
$$w(\Delta t) = w_0 \cdot e^{-\lambda \Delta t}$$
where $\Delta t$ is elapsed time in days and $\lambda = \frac{\ln(2)}{45} \approx 0.0154033/\text{day}$.
- At $\Delta t = 0$ days: $w = 1.0000$
- At $\Delta t = 45$ days: $w = 0.5000$
- At $\Delta t = 90$ days: $w = 0.2500$

### 6.2 Zero-Write-Amplification Implementation
Rows in `dpmaps.trip_evidence_ledger` are **strictly append-only and immutable**. Decayed weight is calculated dynamically via PostgreSQL SQL expressions at read and aggregation time, eliminating destructive nightly `UPDATE` operations:

```sql
-- Core 3-argument function is strictly IMMUTABLE (pure math, no hidden volatile defaults)
CREATE OR REPLACE FUNCTION dpmaps.calculate_decayed_weight(
  p_initial_weight NUMERIC,
  p_created_at TIMESTAMPTZ,
  p_as_of TIMESTAMPTZ
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

-- Convenient 2-argument overload for current evaluation is STABLE (evaluates CURRENT_TIMESTAMP once per query)
CREATE OR REPLACE FUNCTION dpmaps.calculate_decayed_weight(
  p_initial_weight NUMERIC,
  p_created_at TIMESTAMPTZ
) RETURNS NUMERIC AS $$
BEGIN
  RETURN dpmaps.calculate_decayed_weight(p_initial_weight, p_created_at, CURRENT_TIMESTAMP);
END;
$$ LANGUAGE plpgsql STABLE;
```

### 6.3 Canonical Aggregation View & Kish Effective Sample Size
To strictly prevent application queries from accidentally querying `dpmaps.ledger_pseudonyms` without filtering on the active deduplication key (which would result in 4×–5× inflated vote counts and weights due to multi-key ingestion fan-out), and to encapsulate Sybil/fraud invalidation filtering, evidence is queried through a canonical view that joins `dpmaps.active_dedup_key`:

```sql
-- Aggregation view for candidate gate evaluation
-- Encapsulates invalidation filtering, multi-key deduplication via active_dedup_key, and Kish effective sample size weights
CREATE OR REPLACE VIEW dpmaps.v_active_cluster_evidence AS
SELECT 
  tel.query_cluster_id,
  tel.h3_res10,
  lp.key_id,
  COUNT(DISTINCT lp.pseudonym_hash) AS distinct_riders,
  COUNT(DISTINCT lp.driver_pseudonym_hash) AS distinct_drivers,
  COUNT(DISTINCT DATE_TRUNC('week', tel.created_at)) AS active_weeks,
  ROUND(SUM(dpmaps.calculate_decayed_weight(tel.initial_weight, tel.created_at)), 4) AS sum_weights,
  ROUND(SUM(POWER(dpmaps.calculate_decayed_weight(tel.initial_weight, tel.created_at), 2)), 4) AS sum_weight_sq,
  ST_AsGeoJSON(ST_Centroid(ST_Collect(tel.dropoff_geom)))::json AS cluster_centroid_geojson,
  COUNT(tel.id) AS total_vote_count
FROM dpmaps.trip_evidence_ledger tel
JOIN dpmaps.ledger_pseudonyms lp 
  ON lp.ledger_id = tel.id 
 AND lp.created_at = tel.created_at
-- Single-key join eliminates 4x-5x multi-key fan-out inflation
JOIN dpmaps.active_dedup_key adk
  ON lp.key_id = adk.key_id
-- Exclude invalidated fraudulent, collusive, or quarantined votes
LEFT JOIN dpmaps.ledger_invalidations li
  ON li.ledger_id = tel.id
 AND li.created_at = tel.created_at
WHERE li.ledger_id IS NULL
  AND tel.created_at >= NOW() - INTERVAL '90 days'
GROUP BY tel.query_cluster_id, tel.h3_res10, lp.key_id;

-- Materialized view for rapid query-time search scoring and monthly publication gate candidate ranking
CREATE MATERIALIZED VIEW IF NOT EXISTS dpmaps.mv_cluster_evidence_stats AS
SELECT * FROM dpmaps.v_active_cluster_evidence;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_cluster_evidence_stats_pk 
ON dpmaps.mv_cluster_evidence_stats (query_cluster_id, h3_res10);
```

> [!IMPORTANT]
> **Margin Gate & Spatial Ring Aggregation:**
> 1. `v_active_cluster_evidence` does NOT include a `HAVING COUNT(...) >= 15` clause. Preserving all candidate and runner-up H3 cells in the cluster is mandatory so that Stage 009 candidate evaluation can verify Gate 5: **20-point percentage margin over the runner-up cell**.
> 2. For major landmarks and transport hubs that span multiple adjacent cells, Stage 009 candidate ranking can evaluate $k=1$ H3 neighbor rings dynamically using `h3_grid_disk(h3_res10, 1)` without mutating raw ledger rows.
> 3. `sum_weights` ($\sum w$) and `sum_weight_sq` ($\sum w^2$) allow direct computation of the **Kish effective sample size**:
> $$n_{\text{eff}} = \frac{\left(\sum w_i\right)^2}{\sum w_i^2}$$
> used in Gate 6 to calculate the 95% Wilson score continuity interval.

### 6.4 The Pruning Worker (`workers/evidenceDecayWorker.ts`)
Scheduled off-peak between **21:00 and 23:00 UTC** (03:00–05:00 AM Dhaka local time):
1. **Partition Drop:** Executes `CALL partman.run_maintenance_proc()` (mandatory procedure call syntax in pg_partman 5.x) to drop partitions older than 90 days.
2. **Boundary Row Prune:** Executes a targeted delete strictly for records older than 90 days across parent tables and invalidations:
   ```sql
   -- Purge expired boundary rows from both parent tables and invalidations
   DELETE FROM dpmaps.trip_evidence_ledger
   WHERE created_at < NOW() - INTERVAL '90 days';

   DELETE FROM dpmaps.ledger_pseudonyms
   WHERE created_at < NOW() - INTERVAL '90 days';

   DELETE FROM dpmaps.ledger_invalidations
   WHERE created_at < NOW() - INTERVAL '90 days';
   ```
3. **Stats Materialization Refresh:**
   ```sql
   REFRESH MATERIALIZED VIEW CONCURRENTLY dpmaps.mv_cluster_evidence_stats;
   ```

---

## 7. Automated Test Suite Requirements

Stage 003 mandates the following automated test verifications prior to Phase 1 deployment:
1. **Deduplication Ground-Truth Verification:** Simulate 300 riders visiting across 135 days with 0–14 days of rotation jitter. Verify that distinct rider counts match ground truth exactly at Days 91, 100, and 130 without overcounting or null-key exceptions.
2. **Cold-Start Launch Verification:** Verify that during Days 1 to 89, `getDeduplicationKey` returns `isColdStart = true` using `wk-launch-01` without throwing coverage errors, preserving the 15-rider and 5-driver threshold floors.
3. **Irreversible Key Disablement Verification:** Confirm that once a 135-day key is disabled in KMS/Vault, subsequent HMAC attempts fail.
4. **Right-to-Erasure Verification:** Assert that when a user requests deletion, executing `DELETE FROM dpmaps.ledger_pseudonyms WHERE pseudonym_hash IN (...)` across all active keys expunges their voting history while keys remain valid.
5. **Clean-Room Egress & Absence Verification:** Automated unit test asserting that zero vendor duration or distance values exist in `dpmaps.routing_eval_events` and verifying that `dpmaps_worker` receives permission denied when attempting to access `public.ride_vendor_data`.
6. **Append-Only Immutability Verification:** Test asserting that `dpmaps_worker` is denied `UPDATE` and `DELETE` on `provenance_events`, `releases`, `poi_versions`, `release_pois`, and `ledger_invalidations`.
7. **Retention & Partman Alignment:** Test confirming that `pg_partman` configuration has `retention = '90 days'` and `retention_keep_table = false`, and that rows older than 90 days are purged from `trip_evidence_ledger`, `ledger_pseudonyms`, and `ledger_invalidations`.
8. **Aggregation Overcounting Test:** Assert that joining `v_active_cluster_evidence` produces exactly 1 vote per trip and identical weights to raw ledger rows, preventing multi-key fan-out overcounting.

---

## 8. Deliverables & Definition of Done

- [ ] PostgreSQL 16 database initialized with PostGIS 3.4 and pg_partman 5.x in dedicated `partman` schema.
- [ ] Database roles created (`dpmaps_worker`, `ride_dispatch`, `dpmaps_admin`, `dpmaps_analyst`) with granular per-table privileges.
- [ ] Explicit column-level whitelist on `orders` and `REVOKE ALL` on `ride_vendor_data` and `ride_receipts` verified via automated permission tests.
- [ ] Append-only immutability enforced (`REVOKE UPDATE, DELETE`) on `provenance_events`, `releases`, `poi_versions`, `release_pois`, and `ledger_invalidations`.
- [ ] DDL deployed: `public_pois` (with 32 canonical categories CHECK constraint, category synonym mappings, nullable names, and random UUIDs), `poi_aliases`, `poi_versions`, `releases`, `release_pois` (with `ON DELETE RESTRICT`), `osm_pois` (with composite PK `(osm_type, osm_id, snapshot_date)`), `trip_evidence_ledger` (with `uq_ledger_trip` idempotency), `ledger_pseudonyms`, `ledger_invalidations`, `active_dedup_key`, `segment_speeds_tod`, `h3_edge_speeds_tod`, `eta_tod_corrections` (Stage 004 consumers), `provenance_events`, `suppressions` (immutable partial index without `NOW()`, SLA duration tracking), `query_clusters`, `admin_boundaries` (with `geom` and `geom_full`, no cascade delete), and evaluation tables.
- [ ] 135-day key schedule and multi-key ingestion implemented; single-key aggregation view `dpmaps.v_active_cluster_evidence` and materialized view `dpmaps.mv_cluster_evidence_stats` verified against simulated ground truth.
- [ ] Launch cold-start partial-window mode ($t < 90\text{ days}$) verified with strict privacy threshold floor.
- [ ] Query-time exponential decay function `dpmaps.calculate_decayed_weight` deployed; zero-write-amplification verified.
- [ ] Weekly partitioning active via `pg_partman 5.x` with `retention = '90 days'`, `retention_keep_table = false`, and maintenance procedure scheduled at 21:00–23:00 UTC via `CALL partman.run_maintenance_proc()`.
- [ ] Boundary purge job deleting `< NOW() - INTERVAL '90 days'` across `trip_evidence_ledger`, `ledger_pseudonyms`, and `ledger_invalidations`.
- [ ] Clean-room evaluation tables deployed storing only error percentages (`vendor_duration_error_pct`, `vendor_distance_error_pct`) and full cutover gate metrics.

---

## 9. Revision History & Changelog

| Revision | Date | Author / Reviewer | Scope of Changes |
|---|---|---|---|
| Rev 1.0 | 2026-09-15 | System Architect | Initial Draft: Storage schemas, 90-day ledger, monthly partitioning, in-place decay worker. |
| Rev 2.0 | 2026-10-22 | Orchestrator (per Audit Brief) | **Audited Architectural Baseline Upgrades:**<br>1. **120-Day Key Schedule (§5):** Replaced flawed 90-day key schedule with 120-day key lifetime and multi-key ingestion (`dpmaps.ledger_pseudonyms`), eliminating 1.6×–2.3× distinct-rider overcounting.<br>2. **Evidence Ledger Hygiene (§4.4):** Removed raw `trip_id` in favor of `trip_hash`; retained `normalized_query` for 90 days to permit deterministic normalizer replay while purging raw keystrokes at 30 days.<br>3. **Zero-Write-Amplification Decay (§6):** Replaced row-mutating nightly decay with read-time dynamic evaluation function `dpmaps.calculate_decayed_weight`.<br>4. **Partitioning & Pruning (§4.4, §6.4):** Migrated from monthly to weekly native partitions (`pg_partman 5.x`); scheduled off-peak pruning worker at 21:00–23:00 UTC.<br>5. **Schema Gaps Resolved (§4.2–§4.8):** Added DDL for `public_pois`, `poi_aliases`, `releases`, `poi_versions`, `provenance_events`, `suppressions`, `admin_boundaries`, evaluation tables, `query_clusters`, `osm_pois`, and `ride_vendor_data`. |
| Rev 2.1 | 2026-10-22 | Orchestrator (per Scratchpad Audit Verification) | **Strict Clean-Room, Ingestion Privileges & 135-Day Rotation Upgrades:**<br>1. **Clean-Room Evaluation Compliance (§4.7):** Dropped `vendor_duration_s` and `vendor_distance_m` from `dpmaps.routing_eval_events`; added `vendor_duration_error_pct` and `vendor_distance_error_pct`. Added missing Gate 1 & 2 fields to `search_eval_events` (`search_success`, `exit_distance_delta_m`, `vendor_suggestion_selected`, `query_cluster_id`) and routing fields (`vehicle_type`, `tod_bucket`, `corridor_overlap_pct`, `route_deviation_flag`). Added CHECK constraint enforcing `selected_place_id IS NULL` for vendor selections.<br>2. **Granular RBAC & Ingestion Privileges (§3.1):** Removed blanket permissions for `dpmaps_worker`. Granted explicit per-table privileges; enforced append-only immutability (`REVOKE UPDATE, DELETE`) on `provenance_events`, `releases`, `poi_versions`, `release_pois`, and `ledger_invalidations`. Granted `ride_dispatch` sequence `USAGE` and `SELECT` on ledger tables for `RETURNING` clauses and vote-cap checks.<br>3. **Retention & pg_partman 5.x Alignment (§4.4, §6.4):** Fixed `pg_partman 5.x` syntax (`part_config.retention = '90 days'`, `part_config.retention_keep_table = false`). Aligned partition drop and daily boundary delete strictly to `< NOW() - INTERVAL '90 days'` across **both** `trip_evidence_ledger` and `ledger_pseudonyms`.<br>4. **135-Day Window Key Schedule with Operational Slack (§5.2):** Expanded key lifetime from 120 days to 135 days (rotated every 30 days), providing 15 days of jitter slack to eliminate missing-key exceptions. Added formal **Cold-Start Launch Mode** ($t < 90\text{ days}$) using `wk-launch-01`.<br>5. **Provider-Agnostic KMS & Resilience (§5.3):** Defined provider-neutral interface `IKeyManagementProvider` supporting AWS KMS and HashiCorp Vault. Added dead-letter queuing on KMS failure; documented right-to-erasure lifecycle and provider scheduled deletion waiting period.<br>6. **Canonical Aggregation View & Kish Weights (§6.3):** Created `dpmaps.v_active_cluster_evidence` view encapsulating key filtering, fraud invalidation exclusion (`dpmaps.ledger_invalidations`), and calculation of $\sum w$ and $\sum w^2$ for Kish effective sample size $n_{\text{eff}}$. Removed restrictive `HAVING >= 15` from underlying aggregation to preserve runner-up cells for margin gate calculation.<br>7. **POI Schema Refinements (§4.2, §4.3, §4.5, §4.6):** Expanded category CHECK to 37 values matching Concept Paper §13.1 and `AGENTS.md` §7. Added `dpmaps.release_pois` membership table; added `ruleset_hash` and `gate_config_snapshot` to `releases`; added `superseded_by` to `public_pois`; added snapshot date to `osm_pois`; removed cascade delete from `admin_boundaries` and documented crude ADM0 coastline clipping prohibition; updated emergency suppression dual-tier SLA (<1hr automated, <4hr review). |
| Rev 2.2 | 2026-10-22 | Orchestrator (per Postgres 16 Audit Verification) | **Strict DDL Verification, Aggregation Overcounting Fix & Category Canonicalization:**<br>1. **View 5× Overcounting Elimination (§4.1, §6.3):** Added `dpmaps.active_dedup_key` single-row table containing the active 90-day oldest qualifying key. Joined `dpmaps.v_active_cluster_evidence` on `lp.key_id = adk.key_id`, eliminating 5× weight and vote inflation caused by multi-key pseudonym fan-out.<br>2. **Procedure Call & Retention Syntax (§6.4):** Corrected `SELECT partman.run_maintenance_proc()` to procedure call `CALL partman.run_maintenance_proc()` (mandatory in `pg_partman 5.x`). Added 90-day retention prune for `dpmaps.ledger_invalidations`. Added materialized view `dpmaps.mv_cluster_evidence_stats`.<br>3. **Category Canonicalization (§4.2):** Consolidated POI categories from 37 into 26 disjoint canonical categories (e.g. `fuel`, `airport`, `worship`; removing overlapping synonyms `food`, `station`, `mall`). Added `dpmaps.category_synonym_mappings` lookup table.<br>4. **Index Immutability Fix (§4.5):** Dropped mutable `NOW()` function from `idx_suppressions_active` predicate (`CREATE INDEX idx_suppressions_active ON dpmaps.suppressions (applied_at, expires_at)`). Removed `DEFAULT NOW()` from `reported_at` to enable true SLA duration measurement.<br>5. **Ledger Idempotency & Ingestion Timestamp (§4.4):** Enforced deterministic trip completion time (`created_at TIMESTAMPTZ NOT NULL` without `DEFAULT NOW()`), key-independent `trip_hash` token (`HMAC-SHA256(trip_id, IngestionSalt)`), and unique constraint `CONSTRAINT uq_ledger_trip UNIQUE (trip_hash, created_at)` for `ON CONFLICT DO NOTHING` idempotency.<br>6. **Migration Execution Sequence (§3.1):** Documented 4-phase execution sequence and added operational table prerequisite stubs (`public.orders`, `public.ride_receipts`, `public.ride_vendor_data`) for standalone deployment.<br>7. **Foreign Key Immutability (§4.3) & Composite OSM PK (§4.8):** Enforced `ON DELETE RESTRICT` on `poi_versions` and `release_pois`. Changed `osm_pois` primary key to composite `(osm_type, osm_id, snapshot_date)`. Fixed `admin_boundaries` defaults and `chk_search_eval_vendor_null`. |
| Rev 2.3 | 2026-10-22 | Lead Planning & Systems Architecture (audit 004-005; X-2 adoption) | **TOD Speed Pipeline & Vendor Provenance Schema (additive only):**<br>1. Added `dpmaps.segment_speeds_tod`, `dpmaps.h3_edge_speeds_tod`, `dpmaps.eta_tod_corrections` (§4.9): first-party TOD speed aggregates and learned ETA correction factors consumed by Stage 004 §6; keyed by ODbL-derived OSM node identifiers / H3 cells; no vendor data.<br>2. Added `vendor_provider` to `public.ride_vendor_data` (§4.8): operational provenance enum (`barikoi`/`google`) enabling the Gate 1 Barikoi-only vendor-parity statistic (concept paper §14.3).<br>3. Grants: `dpmaps_worker` read/write on the three §4.9 tables; `dpmaps_analyst` read. Existing Rev 2.2 constraints, views, and retention rules unchanged. |
| Rev 2.4 | 2026-10-22 | Lead Planning & Systems Architecture (batch-2 audit; X-1 adoption) | **Takedown, Challenger & Search-Feed Objects (additive only):** 0. `public.orders.user_id` stub completion (traveler-qualifier rider key). 1. `dpmaps.takedown_reports` (traveler-qualified reporting, SLA timestamps without defaults). 2. `dpmaps.provisional_challengers` (two-cycle challenger tracking with k=1 cell-set snapshot). 3. `query_clusters.published_poi_id` incumbent pointer. 4. `v_search_feed_first_party` / `v_search_feed_osm` views feeding the physically isolated MeiliSearch indexes (Stage 008); first-party view aggregates phonetic keys per POI — exactly one row per POI by invariant. Grants staged. Rev 2.2/2.3 content unchanged. |
| Rev 2.5 | 2026-10-22 | Lead Planning & Systems Architecture (batch-3 audit) | **Post-Trip Staging & Bilingual Gate (additive only):** 1. `dpmaps.post_trip_labels` staging table (cycle-bounded uniqueness; scrubbed writes). 2. `chk_poi_bilingual_active` — both names required at `lifecycle_status='active'`. Grants staged. Rev 2.2–2.4 content unchanged. |
| Rev 2.6 | 2026-10-22 | Lead Planning & Systems Architecture (batch-4 audit) | **Invalidation Vocabulary, OSM Road Names & Saved-Place Identity (additive only):** 1. `ledger_invalidations.reason` CHECK widened with `'driver_bias'`. 2. `dpmaps.osm_road_names` (ODbL layer for Stage 013 Tier 2). 3. `public.user_private_places` gains `sovereign_place_id` (UUID, unique), `needs_confirmation`, `resolution_spread_meters`. Rev 2.2–2.5 content unchanged. |



