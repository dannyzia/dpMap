-- ============================================================================
-- migrations/003_storage_schema.sql — Stage 003 Rev 2.6 storage schema.
--
-- Plan: docs/plans/003_storage_schema_and_continuous_evidence_ledger.md
--       (Rev 2.6: Rev 2.2 core + Rev 2.3/2.4/2.5/2.6 additive adoptions)
-- Target: PostgreSQL 16 + PostGIS 3.4 + pg_partman 5.x
-- Execution order (plan §3.1): Phase 1 extensions/schemas (§A) ->
--   Phase 2 operational stubs (§B) -> Phase 3 core DDL (§C–§N) ->
--   Phase 4 roles/grants (§O) -> maintenance procedure (§P).
--
-- HARD RULES: ledger tables carry ZERO trip_id (Hard Rule 8 / A2) — only the
-- key-independent trip_hash. Zero vendor strings/coordinates enter dpmaps.*
-- ============================================================================

-- ==================== §A. Phase 1: extensions & schemas ====================
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE SCHEMA IF NOT EXISTS partman;
CREATE EXTENSION IF NOT EXISTS "pg_partman" SCHEMA partman;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE SCHEMA IF NOT EXISTS dpmaps;

-- ==================== §B. Phase 2: operational stubs (public) ==============
-- Standalone scratchpad stubs; in production these exist in Ride core DB.
-- dropoff_lat/lng MUST be the physical driver handset GPS end-fix (plan §3).
CREATE TABLE IF NOT EXISTS public.orders (
  id UUID PRIMARY KEY,
  status VARCHAR(32) NOT NULL,
  fare_bdt NUMERIC(10, 2),
  dropoff_lat NUMERIC(9, 6) NOT NULL,
  dropoff_lng NUMERIC(9, 6) NOT NULL,
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
  vendor_provider VARCHAR(16) NOT NULL
    CHECK (vendor_provider IN ('barikoi', 'google')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Saved-places stub (plan §4.12 item 3 operates on it additively).
CREATE TABLE IF NOT EXISTS public.user_private_places (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(64) NOT NULL,
  label VARCHAR(255),
  lat NUMERIC(9, 6) NOT NULL,
  lng NUMERIC(9, 6) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Rev 2.6 item 3 (Stage 014 F-014-2/4): sovereign saved-place identity &
-- confirmation state. IF NOT EXISTS: rerunnable against a production table.
ALTER TABLE public.user_private_places
  ADD COLUMN IF NOT EXISTS sovereign_place_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS needs_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS resolution_spread_meters NUMERIC(8,2);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_private_places_sovereign
  ON public.user_private_places (sovereign_place_id);

-- ==================== §C. Active dedup key + enums (plan §4.1) =============
CREATE TABLE IF NOT EXISTS dpmaps.active_dedup_key (
  singleton_id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton_id),
  key_id VARCHAR(16) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  CREATE TYPE dpmaps.point_type_enum AS ENUM (
    'building', 'entrance', 'dropoff_point', 'curb_stop',
    'perimeter_gate', 'area'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE dpmaps.source_type_enum AS ENUM (
    'pin_tool', 'merchant_onboarding', 'post_trip_label', 'trip_cluster'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE dpmaps.poi_status_enum AS ENUM (
    'candidate', 'active', 'demoted', 'retired', 'suppressed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE dpmaps.vote_class_enum AS ENUM (
    'full', 'prefix_only', 'post_trip_label'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE dpmaps.provenance_event_type_enum AS ENUM (
    'publish', 'takedown', 'rollback', 'deprecate'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============ §D. public_pois + synonyms + aliases (plan §4.2, §4.11) ======
CREATE TABLE IF NOT EXISTS dpmaps.public_pois (
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
  confidence_score NUMERIC(5, 4) NOT NULL DEFAULT 0.0000,
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
  CONSTRAINT chk_poi_name_exists CHECK (canonical_name IS NOT NULL OR bangla_name IS NOT NULL),
  -- Stage 010 §3.1 bilingual gate (plan §4.11): candidates may be
  -- single-script; 'active' requires both names.
  CONSTRAINT chk_poi_bilingual_active CHECK (lifecycle_status <> 'active'
         OR (canonical_name IS NOT NULL AND bangla_name IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_public_pois_geom ON dpmaps.public_pois USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_public_pois_entrance ON dpmaps.public_pois USING GIST (entrance_geom) WHERE entrance_geom IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_public_pois_h3_res9 ON dpmaps.public_pois (h3_res9);
CREATE INDEX IF NOT EXISTS idx_public_pois_h3_res10 ON dpmaps.public_pois (h3_res10);
CREATE INDEX IF NOT EXISTS idx_public_pois_category ON dpmaps.public_pois (category);
CREATE INDEX IF NOT EXISTS idx_public_pois_status ON dpmaps.public_pois (lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_public_pois_parent ON dpmaps.public_pois (parent_place_id);
CREATE INDEX IF NOT EXISTS idx_public_pois_superseded ON dpmaps.public_pois (superseded_by);
CREATE INDEX IF NOT EXISTS idx_public_pois_cycle ON dpmaps.public_pois (publication_cycle);

CREATE TABLE IF NOT EXISTS dpmaps.category_synonym_mappings (
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

CREATE TABLE IF NOT EXISTS dpmaps.poi_aliases (
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

CREATE INDEX IF NOT EXISTS idx_poi_aliases_text ON dpmaps.poi_aliases (alias_text);
CREATE INDEX IF NOT EXISTS idx_poi_aliases_poi ON dpmaps.poi_aliases (poi_id);
CREATE INDEX IF NOT EXISTS idx_poi_aliases_status ON dpmaps.poi_aliases (status);

-- ================= §E. Releases & versions (plan §4.3) ====================
CREATE TABLE IF NOT EXISTS dpmaps.releases (
  release_id VARCHAR(32) PRIMARY KEY,
  cutoff_timestamp TIMESTAMPTZ NOT NULL,
  normalizer_version VARCHAR(32) NOT NULL,
  ruleset_version VARCHAR(32) NOT NULL,
  ruleset_hash CHAR(64) NOT NULL,
  gate_config_snapshot JSONB NOT NULL,
  merkle_root CHAR(64) NOT NULL,
  tsa_receipt TEXT,
  published_poi_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dpmaps.poi_versions (
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
  aliases JSONB NOT NULL DEFAULT '[]',
  canonical_payload_hash CHAR(64) NOT NULL,
  audit_hmac CHAR(64) NOT NULL,
  release_id VARCHAR(32) NOT NULL REFERENCES dpmaps.releases(release_id) ON DELETE RESTRICT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_poi_version UNIQUE (poi_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_poi_versions_poi ON dpmaps.poi_versions (poi_id);
CREATE INDEX IF NOT EXISTS idx_poi_versions_release ON dpmaps.poi_versions (release_id);

CREATE TABLE IF NOT EXISTS dpmaps.release_pois (
  release_id VARCHAR(32) NOT NULL REFERENCES dpmaps.releases(release_id) ON DELETE RESTRICT,
  poi_id UUID NOT NULL REFERENCES dpmaps.public_pois(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL,
  PRIMARY KEY (release_id, poi_id)
);

CREATE INDEX IF NOT EXISTS idx_release_pois_lookup ON dpmaps.release_pois (release_id, poi_id);

-- ============ §F. Evidence ledger + partman (plan §4.4, §4.12) =============
-- ZERO trip_id anywhere in this section (Hard Rule 8): idempotency uses the
-- key-independent trip_hash = HMAC-SHA256(trip_id, IngestionSalt).
CREATE TABLE IF NOT EXISTS dpmaps.trip_evidence_ledger (
  id BIGSERIAL,
  query_cluster_id VARCHAR(64) NOT NULL,
  normalized_query VARCHAR(120) NOT NULL,
  typed_len SMALLINT NOT NULL CHECK (typed_len BETWEEN 1 AND 80),
  vote_class dpmaps.vote_class_enum NOT NULL DEFAULT 'full',
  h3_res10 VARCHAR(15) NOT NULL,
  dropoff_geom GEOMETRY(Point, 4326) NOT NULL,
  initial_weight NUMERIC(6, 4) NOT NULL DEFAULT 1.0000,
  point_type dpmaps.point_type_enum NOT NULL DEFAULT 'dropoff_point',
  trip_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (id, created_at),
  CONSTRAINT uq_ledger_trip UNIQUE (trip_hash, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS dpmaps.ledger_pseudonyms (
  ledger_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  key_id VARCHAR(16) NOT NULL,
  pseudonym_hash CHAR(64) NOT NULL,
  driver_pseudonym_hash CHAR(64) NOT NULL,
  PRIMARY KEY (ledger_id, key_id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS dpmaps.ledger_invalidations (
  ledger_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  -- Rev 2.6 vocabulary widening (Stage 012 F-012-1): includes 'driver_bias'.
  reason VARCHAR(64) NOT NULL CHECK (reason IN ('fraud_sybil', 'burst_suppression', 'collusion', 'audit_purge', 'quarantine', 'driver_bias')),
  invalidated_by VARCHAR(64) NOT NULL,
  invalidated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ledger_id, created_at)
);

CREATE INDEX IF NOT EXISTS idx_invalidations_lookup ON dpmaps.ledger_invalidations (ledger_id, created_at);

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

UPDATE partman.part_config
SET retention = '90 days',
    retention_keep_table = false
WHERE parent_table IN ('dpmaps.trip_evidence_ledger', 'dpmaps.ledger_pseudonyms');

CREATE INDEX IF NOT EXISTS idx_ledger_cluster ON dpmaps.trip_evidence_ledger (query_cluster_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_h3 ON dpmaps.trip_evidence_ledger (h3_res10, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_dropoff ON dpmaps.trip_evidence_ledger USING GIST (dropoff_geom);
CREATE INDEX IF NOT EXISTS idx_pseudo_lookup ON dpmaps.ledger_pseudonyms (key_id, pseudonym_hash, created_at);

-- ============ §G. Provenance events + suppressions (plan §4.5) ==============
CREATE TABLE IF NOT EXISTS dpmaps.provenance_events (
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

CREATE INDEX IF NOT EXISTS idx_prov_events_record ON dpmaps.provenance_events (record_id, created_at);
CREATE INDEX IF NOT EXISTS idx_prov_events_cycle ON dpmaps.provenance_events (publication_cycle);

CREATE TABLE IF NOT EXISTS dpmaps.suppressions (
  id BIGSERIAL PRIMARY KEY,
  target_type VARCHAR(16) NOT NULL CHECK (target_type IN ('poi_id', 'osm_poi_id', 'h3_cell', 'name_pattern')),
  target_value VARCHAR(255) NOT NULL,
  reason VARCHAR(64) NOT NULL CHECK (reason IN ('court_order', 'privacy_request', 'security_sensitive', 'copyright_claim', 'sybil_attack')),
  is_auto_hidden BOOLEAN NOT NULL DEFAULT FALSE,
  auto_hide_reason VARCHAR(64),
  reported_at TIMESTAMPTZ NOT NULL,
  suppression_target_sla VARCHAR(16) NOT NULL DEFAULT '1_hour',
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  adjudicated_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  actor_id VARCHAR(64) NOT NULL,
  audit_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_suppressions_target ON dpmaps.suppressions (target_type, target_value);
CREATE INDEX IF NOT EXISTS idx_suppressions_active ON dpmaps.suppressions (applied_at, expires_at);

-- ============== §H. Admin boundaries (plan §4.6) ===========================
CREATE TABLE IF NOT EXISTS dpmaps.admin_boundaries (
  id SERIAL PRIMARY KEY,
  boundary_name VARCHAR(128) NOT NULL,
  boundary_name_bn VARCHAR(128),
  admin_level SMALLINT NOT NULL CHECK (admin_level BETWEEN 0 AND 4),
  parent_id INTEGER REFERENCES dpmaps.admin_boundaries(id) ON DELETE RESTRICT,
  source VARCHAR(64) NOT NULL,
  license VARCHAR(32) NOT NULL,
  capture_date DATE NOT NULL,
  geom GEOMETRY(MultiPolygon, 4326) NOT NULL,
  geom_full GEOMETRY(MultiPolygon, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_boundaries_geom ON dpmaps.admin_boundaries USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_boundaries_geom_full ON dpmaps.admin_boundaries USING GIST (geom_full);
CREATE INDEX IF NOT EXISTS idx_boundaries_level ON dpmaps.admin_boundaries (admin_level);
CREATE INDEX IF NOT EXISTS idx_boundaries_parent ON dpmaps.admin_boundaries (parent_id);

-- ============== §I. Telemetry tables (plan §4.7) ============================
CREATE TABLE IF NOT EXISTS dpmaps.raw_search_events (
  id BIGSERIAL,
  user_id VARCHAR(64) NOT NULL,
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

CREATE TABLE IF NOT EXISTS dpmaps.search_eval_events (
  id BIGSERIAL,
  search_success BOOLEAN NOT NULL,
  exit_distance_delta_m NUMERIC(7, 2),
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

-- Strict clean-room: error percentages vs actual driven ONLY. Zero vendor
-- coordinates, zero raw vendor quotes (plan §4.7).
CREATE TABLE IF NOT EXISTS dpmaps.routing_eval_events (
  id BIGSERIAL,
  vehicle_type VARCHAR(16) NOT NULL CHECK (vehicle_type IN ('car', 'bike', 'cng')),
  tod_bucket VARCHAR(16) NOT NULL CHECK (tod_bucket IN ('morning_peak', 'evening_peak', 'off_peak', 'night')),
  osrm_duration_s INTEGER NOT NULL,
  osrm_distance_m INTEGER NOT NULL,
  actual_driven_duration_s INTEGER NOT NULL,
  actual_driven_distance_m INTEGER NOT NULL,
  vendor_duration_error_pct NUMERIC(5, 2),
  vendor_distance_error_pct NUMERIC(5, 2),
  duration_error_pct NUMERIC(5, 2) NOT NULL,
  distance_error_pct NUMERIC(5, 2) NOT NULL,
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

-- ============ §J. OSM POIs + query clusters (plan §4.8, §4.10) ==============
CREATE TABLE IF NOT EXISTS dpmaps.osm_pois (
  osm_type CHAR(1) NOT NULL,
  osm_id BIGINT NOT NULL,
  snapshot_date DATE NOT NULL,
  name VARCHAR(255) NOT NULL,
  name_en VARCHAR(255),
  name_bn VARCHAR(255),
  primary_script VARCHAR(10) NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_osm_pois_geom ON dpmaps.osm_pois USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_osm_pois_h3_res9 ON dpmaps.osm_pois (h3_res9);
CREATE INDEX IF NOT EXISTS idx_osm_pois_category ON dpmaps.osm_pois (category);

CREATE TABLE IF NOT EXISTS dpmaps.query_clusters (
  cluster_id VARCHAR(64) PRIMARY KEY,
  canonical_query VARCHAR(120) NOT NULL,
  normalized_tokens TEXT[] NOT NULL,
  bengali_phonetic_key VARCHAR(120),
  alias_count INTEGER NOT NULL DEFAULT 1,
  published_poi_id UUID REFERENCES dpmaps.public_pois(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_query_clusters_canonical ON dpmaps.query_clusters (canonical_query);

-- ============== §K. TOD speed tables (plan §4.9) ============================
CREATE TABLE IF NOT EXISTS dpmaps.segment_speeds_tod (
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

CREATE TABLE IF NOT EXISTS dpmaps.h3_edge_speeds_tod (
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

CREATE TABLE IF NOT EXISTS dpmaps.eta_tod_corrections (
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

-- ===== §L. Takedowns, challengers, search feeds (plan §4.10) ================
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS user_id VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_orders_user_created ON public.orders (user_id, created_at);

CREATE TABLE IF NOT EXISTS dpmaps.takedown_reports (
  id BIGSERIAL PRIMARY KEY,
  poi_id UUID NOT NULL REFERENCES dpmaps.public_pois(id) ON DELETE CASCADE,
  reporter_user_id VARCHAR(64) NOT NULL,
  reporter_trust_score SMALLINT NOT NULL,
  traveler_qualified BOOLEAN NOT NULL,
  report_reason VARCHAR(64) NOT NULL,
  report_details TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'auto_hidden', 'confirmed', 'rejected')),
  reported_at TIMESTAMPTZ NOT NULL,
  adjudicated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_takedown_reports_poi ON dpmaps.takedown_reports (poi_id, reported_at);
CREATE INDEX IF NOT EXISTS idx_takedown_reports_user ON dpmaps.takedown_reports (reporter_user_id, reported_at);

CREATE TABLE IF NOT EXISTS dpmaps.provisional_challengers (
  id BIGSERIAL PRIMARY KEY,
  query_cluster_id VARCHAR(64) NOT NULL,
  challenger_h3_res10 VARCHAR(15) NOT NULL,
  challenger_cell_set TEXT[] NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_provisional_challengers_lookup
  ON dpmaps.provisional_challengers (query_cluster_id, challenger_h3_res10, status);

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
LEFT JOIN LATERAL (
  SELECT array_agg(DISTINCT qc.bengali_phonetic_key)
         FILTER (WHERE qc.bengali_phonetic_key IS NOT NULL) AS phonetic_keys
  FROM dpmaps.query_clusters qc WHERE qc.published_poi_id = p.id
) ph ON TRUE
WHERE p.lifecycle_status = 'active';

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

GRANT SELECT, INSERT, UPDATE ON dpmaps.takedown_reports, dpmaps.provisional_challengers TO dpmaps_admin;
GRANT SELECT ON dpmaps.takedown_reports, dpmaps.provisional_challengers TO dpmaps_analyst;
GRANT SELECT ON dpmaps.v_search_feed_first_party, dpmaps.v_search_feed_osm TO dpmaps_worker;

-- ============ §M. Post-trip labels (plan §4.11) ============================
CREATE TABLE IF NOT EXISTS dpmaps.post_trip_labels (
  id BIGSERIAL PRIMARY KEY,
  poi_id UUID REFERENCES dpmaps.public_pois(id) ON DELETE CASCADE,
  h3_res10 VARCHAR(15) NOT NULL,
  submitted_text VARCHAR(120) NOT NULL,
  normalized_text VARCHAR(120) NOT NULL,
  submission_type VARCHAR(16) NOT NULL CHECK (submission_type IN ('text_entry', 'chip_selection')),
  pseudonym_hash CHAR(64) NOT NULL,
  trip_hash CHAR(64) NOT NULL,
  publication_cycle VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_rider_poi_cycle UNIQUE (poi_id, pseudonym_hash, publication_cycle)
);
CREATE INDEX IF NOT EXISTS idx_post_trip_labels_poi ON dpmaps.post_trip_labels (poi_id);
CREATE INDEX IF NOT EXISTS idx_post_trip_labels_h3 ON dpmaps.post_trip_labels (h3_res10);

GRANT SELECT, INSERT ON dpmaps.post_trip_labels TO ride_dispatch;
GRANT SELECT ON dpmaps.post_trip_labels TO dpmaps_analyst;

-- ============ §N. OSM road names (plan §4.12) ===============================
CREATE TABLE IF NOT EXISTS dpmaps.osm_road_names (
  way_id BIGINT NOT NULL,
  name VARCHAR(255),
  name_bn VARCHAR(255),
  highway_class VARCHAR(32) NOT NULL,
  geom GEOMETRY(LineString, 4326) NOT NULL,
  snapshot_date DATE NOT NULL,
  PRIMARY KEY (way_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_osm_road_names_geom ON dpmaps.osm_road_names USING GIST (geom);
GRANT SELECT ON dpmaps.osm_road_names TO dpmaps_worker;
GRANT SELECT ON dpmaps.osm_road_names TO dpmaps_analyst;

-- ============ §O. Decay functions (plan §6.2) ===============================
-- 3-arg core is strictly IMMUTABLE (pure math). 2-arg overload is STABLE.
CREATE OR REPLACE FUNCTION dpmaps.calculate_decayed_weight(
  p_initial_weight NUMERIC,
  p_created_at TIMESTAMPTZ,
  p_as_of TIMESTAMPTZ
) RETURNS NUMERIC AS $$
DECLARE
  v_days NUMERIC;
  v_lambda CONSTANT NUMERIC := 0.0154033;
BEGIN
  v_days := EXTRACT(EPOCH FROM (p_as_of - p_created_at)) / 86400.0;
  IF v_days < 0 THEN
    v_days := 0;
  END IF;
  RETURN ROUND(p_initial_weight * EXP(-v_lambda * v_days), 4);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION dpmaps.calculate_decayed_weight(
  p_initial_weight NUMERIC,
  p_created_at TIMESTAMPTZ
) RETURNS NUMERIC AS $$
BEGIN
  RETURN dpmaps.calculate_decayed_weight(p_initial_weight, p_created_at, CURRENT_TIMESTAMP);
END;
$$ LANGUAGE plpgsql STABLE;

-- ============ §P. Canonical aggregation view (plan §6.3) ====================
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
JOIN dpmaps.active_dedup_key adk
  ON lp.key_id = adk.key_id
LEFT JOIN dpmaps.ledger_invalidations li
  ON li.ledger_id = tel.id
 AND li.created_at = tel.created_at
WHERE li.ledger_id IS NULL
  AND tel.created_at >= NOW() - INTERVAL '90 days'
GROUP BY tel.query_cluster_id, tel.h3_res10, lp.key_id;

CREATE MATERIALIZED VIEW IF NOT EXISTS dpmaps.mv_cluster_evidence_stats AS
SELECT * FROM dpmaps.v_active_cluster_evidence;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_cluster_evidence_stats_pk
ON dpmaps.mv_cluster_evidence_stats (query_cluster_id, h3_res10);

-- ============ §Q. Phase 4: roles & grants (plan §3.1) ======================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dpmaps_worker') THEN
    CREATE ROLE dpmaps_worker WITH LOGIN PASSWORD '***';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ride_dispatch') THEN
    CREATE ROLE ride_dispatch WITH LOGIN PASSWORD '***';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dpmaps_admin') THEN
    CREATE ROLE dpmaps_admin WITH LOGIN PASSWORD '***';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dpmaps_analyst') THEN
    CREATE ROLE dpmaps_analyst WITH LOGIN PASSWORD '***';
  END IF;
END $$;

REVOKE ALL ON SCHEMA public FROM dpmaps_worker;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM dpmaps_worker;

GRANT USAGE ON SCHEMA public TO dpmaps_worker;
GRANT SELECT (id, status, created_at, dropoff_lat, dropoff_lng, elapsed_seconds)
  ON public.orders TO dpmaps_worker;

REVOKE ALL ON public.ride_vendor_data FROM dpmaps_worker;
REVOKE ALL ON public.ride_receipts FROM dpmaps_worker;

GRANT USAGE ON SCHEMA dpmaps TO dpmaps_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA dpmaps TO dpmaps_worker;

GRANT SELECT, INSERT, UPDATE ON dpmaps.public_pois, dpmaps.poi_aliases, dpmaps.query_clusters, dpmaps.suppressions TO dpmaps_worker;

GRANT SELECT, INSERT ON dpmaps.provenance_events, dpmaps.releases, dpmaps.poi_versions, dpmaps.release_pois, dpmaps.ledger_invalidations TO dpmaps_worker;
REVOKE UPDATE, DELETE ON dpmaps.provenance_events, dpmaps.releases, dpmaps.poi_versions, dpmaps.release_pois, dpmaps.ledger_invalidations FROM dpmaps_worker;

GRANT SELECT, DELETE ON dpmaps.trip_evidence_ledger, dpmaps.ledger_pseudonyms TO dpmaps_worker;
REVOKE UPDATE ON dpmaps.trip_evidence_ledger, dpmaps.ledger_pseudonyms FROM dpmaps_worker;

GRANT SELECT ON dpmaps.osm_pois, dpmaps.admin_boundaries, dpmaps.active_dedup_key TO dpmaps_worker;
REVOKE INSERT, UPDATE, DELETE ON dpmaps.osm_pois, dpmaps.admin_boundaries, dpmaps.active_dedup_key FROM dpmaps_worker;

GRANT SELECT, INSERT, UPDATE ON dpmaps.segment_speeds_tod, dpmaps.h3_edge_speeds_tod,
  dpmaps.eta_tod_corrections TO dpmaps_worker;
GRANT SELECT ON dpmaps.segment_speeds_tod, dpmaps.h3_edge_speeds_tod,
  dpmaps.eta_tod_corrections TO dpmaps_analyst;

GRANT USAGE ON SCHEMA dpmaps TO ride_dispatch;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA dpmaps TO ride_dispatch;
GRANT SELECT, INSERT ON dpmaps.trip_evidence_ledger, dpmaps.ledger_pseudonyms TO ride_dispatch;
GRANT INSERT ON dpmaps.raw_search_events, dpmaps.search_eval_events, dpmaps.routing_eval_events TO ride_dispatch;
GRANT SELECT ON dpmaps.public_pois, dpmaps.poi_aliases, dpmaps.osm_pois, dpmaps.admin_boundaries, dpmaps.suppressions, dpmaps.active_dedup_key TO ride_dispatch;

GRANT USAGE ON SCHEMA dpmaps TO dpmaps_analyst;
GRANT SELECT ON dpmaps.public_pois, dpmaps.poi_aliases, dpmaps.releases, dpmaps.admin_boundaries, dpmaps.search_eval_events, dpmaps.routing_eval_events TO dpmaps_analyst;
REVOKE ALL ON dpmaps.ledger_pseudonyms, dpmaps.trip_evidence_ledger, dpmaps.raw_search_events FROM dpmaps_analyst;

-- ============ §R. Maintenance procedure (plan §6.4) ========================
-- Pruning worker runs off-peak 21:00–23:00 UTC (03:00–05:00 Dhaka):
-- weekly partition drops (>90d) + boundary row purge + stats refresh.
CREATE OR REPLACE PROCEDURE dpmaps.run_evidence_maintenance()
LANGUAGE plpgsql AS $$
BEGIN
  CALL partman.run_maintenance_proc();
  DELETE FROM dpmaps.trip_evidence_ledger
  WHERE created_at < NOW() - INTERVAL '90 days';
  DELETE FROM dpmaps.ledger_pseudonyms
  WHERE created_at < NOW() - INTERVAL '90 days';
  DELETE FROM dpmaps.ledger_invalidations
  WHERE created_at < NOW() - INTERVAL '90 days';
  REFRESH MATERIALIZED VIEW CONCURRENTLY dpmaps.mv_cluster_evidence_stats;
END;
$$;