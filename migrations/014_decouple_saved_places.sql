-- migrations/014_decouple_saved_places.sql — Stage 014 §3.
--
-- Permanent decoupling of public.user_private_places from vendor identifiers.
-- Rerunnable (IF NOT EXISTS throughout). Extends the Rev 2.6 items already
-- in migrations/003_storage_schema.sql (sovereign_place_id, needs_confirmation,
-- resolution_spread_meters, uq index) with the remaining migration columns.
--
-- Privacy invariant (Class 3): user_private_places is NEVER queried by,
-- ingested into, or merged with dpmaps.trip_evidence_ledger /
-- dpmaps.public_pois. Post-cutover vendor columns are dropped by a SEPARATE
-- manual step (§6) only after the cutover gate reads 0 — NOT in this file.

ALTER TABLE public.user_private_places
  ADD COLUMN IF NOT EXISTS geom GEOMETRY(Point, 4326),
  ADD COLUMN IF NOT EXISTS h3_res9 VARCHAR(15),
  ADD COLUMN IF NOT EXISTS h3_res10 VARCHAR(15),
  ADD COLUMN IF NOT EXISTS migration_source VARCHAR(32) CHECK (migration_source IN
    ('first_party_trip_history', 'user_confirmed_pin', 'ephemeral_vendor_resolved', 'native_first_party')),
  ADD COLUMN IF NOT EXISTS user_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS needs_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS resolution_spread_meters NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS is_migrated BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS migrated_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_private_places_sovereign
  ON public.user_private_places (sovereign_place_id);
CREATE INDEX IF NOT EXISTS idx_user_private_places_geom
  ON public.user_private_places USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_user_private_places_unmigrated
  ON public.user_private_places (is_migrated) WHERE is_migrated = FALSE;
CREATE INDEX IF NOT EXISTS idx_user_private_places_user
  ON public.user_private_places (user_id);

-- Cutover gate (§6): must read 0 before Mode 2.
--   SELECT COUNT(*) FROM public.user_private_places upp
--   JOIN public.orders o ON o.user_id = upp.user_id
--    AND o.created_at >= NOW() - INTERVAL '90 days'
--   WHERE upp.is_migrated = FALSE OR upp.needs_confirmation = TRUE;

-- Post-cutover cleanup (MANUAL, after Mode 2 stable — NOT executed here):
--   ALTER TABLE public.user_private_places
--     DROP COLUMN IF EXISTS vendor_place_id,
--     DROP COLUMN IF EXISTS vendor_provider;
