# Stage 014: Saved Places Migration & Decoupling Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-014  
**Stage:** 14 of 16 (User Data Decoupling & Account Migration)  
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§16, §16.1)  
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)  
**Current Status:** **Revision 2.0 (Audited & Upgraded)**  
**Target Phase:** Phase 1–2 (Dual-Connected Launch to Routing Switch Flip)  
**Primary Dependencies:** [`002_provenance_firewall_and_legal_compliance.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/002_provenance_firewall_and_legal_compliance.md), [`003_storage_schema_and_continuous_evidence_ledger.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/003_storage_schema_and_continuous_evidence_ledger.md), [`011_privacy_architecture_and_abuse_resistant_takedowns.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/011_privacy_architecture_and_abuse_resistant_takedowns.md), Mobile Client App

---

## 1. Executive Summary & Objective

Passengers rely heavily on personal saved bookmarks (*"Home"*, *"Work"*, *"Gym"*, *"Parents' House"*) to book dispatches with a single tap. In legacy ride-hailing architectures, these bookmarks are frequently coupled to external vendor proprietary keys (e.g. `barikoi_place_id` or Google `place_id`). If the platform executes a hard vendor cutover without systematically decoupling user bookmarks:
- Millions of passenger bookmarks become broken foreign keys.
- Booking attempts to "Home" throw dispatch geocoding exceptions.
- Mass rider churn occurs on Day 1 of sovereign operation.

Furthermore, a naive batch script that bulk-queries commercial vendor geocoding APIs to scrape and store coordinates into a permanent database violates commercial Terms of Service and breaches the Stage 002 Clean-Room Legal Firewall.

Stage 014 implements a legally compliant, **3-Track Sovereign Migration Architecture**:
1. **Track 1: First-Party Trip History Triangulation (100% Clean-Room):** Resolves saved bookmarks directly from the user's historical completed order drop-off GPS coordinates. Zero vendor API calls required.
2. **Track 2: On-Demand Interactive User Confirmation:** Prompts users opening bookmarks to confirm or micro-adjust their pin on the native map canvas, transforming coordinates into **user-authored first-party geometry**.
3. **Track 3: Ephemeral Wrapper Resolution Fallback:** For unvisited bookmarks, resolves coordinates strictly through `vendorClientWrapper.ts` on an active user transaction, immediately requesting user confirmation.
4. **Permanent Vendor Decoupling:** Replaces external IDs with native PostGIS `GEOMETRY(Point, 4326)` and H3 resolution 9 cells, permanently severing third-party database dependencies.

---

## 2. The 3-Track Sovereign Migration Strategy

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        3-TRACK SAVED PLACES MIGRATION STRATEGY                         │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   [ Legacy user_private_places ] (Contains legacy vendor_place_id)                    │
│                 │                                                                      │
│                 ▼                                                                      │
│   [ Step 1: Pre-Cutover Audit (workers/savedPlacesAuditor.ts) ]                        │
│   • Scans 100% of user bookmarks across production database                            │
│   • Segregates into: (A) Visited via completed rides vs. (B) Unvisited bookmarks       │
│                 │                                                                      │
│        ┌────────┴──────────────────────────────────────────┐                           │
│        ▼ (Track 1: Has Completed Trip History)             ▼ (Track 2/3: Unvisited)    │
│   ┌────────────────────────────────────────┐ ┌───────────────────────────────────────┐ │
│   │ First-Party History Triangulation      │ │ On-Demand In-App Pin Confirmation Card│ │
│   │ • Extracts driver GPS drop-off fixes   │ │ • User opens bookmark in app          │ │
│   │   from first-party orders table        │ │ • Native map displays suggested pin   │ │
│   │ • Calculates median curb coordinate    │ │ • User confirms / adjusts pin to curb │ │
│   │ • 100% Sovereign Clean-Room Data       │ │ • Generates user-authored geometry    │ │
│   │ • Zero Vendor API Calls Required!      │ │ • Immunized from vendor IP claims     │ │
│   └────────────────────────────────────────┘ └───────────────────────────────────────┘ │
│        │                                                   │                           │
│        └────────────────────┬──────────────────────────────┘                           │
│                             │                                                          │
│                             ▼                                                          │
│   [ Permanent Schema Migration: Drop Legacy Vendor Columns ]                           │
│   • Updates geom, h3_res9, h3_res10, migration_source                                  │
│   • Sets is_migrated = TRUE                                                            │
│   • DROP COLUMN vendor_place_id, vendor_provider                                       │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Database Schema & Migration Specification

### 3.1 Migration DDL: `migrations/014_decouple_saved_places.sql`
Modifies `public.user_private_places` to store native geometries, audit lineage, and H3 spatial indices:

```sql
-- Step 1: Add sovereign first-party spatial columns
ALTER TABLE public.user_private_places
  ADD COLUMN IF NOT EXISTS geom GEOMETRY(Point, 4326),
  ADD COLUMN IF NOT EXISTS h3_res9 VARCHAR(15),
  ADD COLUMN IF NOT EXISTS h3_res10 VARCHAR(15),
  ADD COLUMN IF NOT EXISTS migration_source VARCHAR(32) CHECK (
    migration_source IN ('first_party_trip_history', 'user_confirmed_pin', 'ephemeral_vendor_resolved', 'native_first_party')
  ),
  ADD COLUMN IF NOT EXISTS user_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_migrated BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS migrated_at TIMESTAMPTZ;

-- Step 2: Spatial index on native geometry
CREATE INDEX IF NOT EXISTS idx_user_private_places_geom 
  ON public.user_private_places USING GIST (geom);

-- Step 3: Fast index for migration worker backlog
CREATE INDEX IF NOT EXISTS idx_user_private_places_unmigrated 
  ON public.user_private_places (is_migrated) 
  WHERE is_migrated = FALSE;

CREATE INDEX IF NOT EXISTS idx_user_private_places_user 
  ON public.user_private_places (user_id);
```

### 3.2 Privacy Invariant (Class 3 Data Segregation)
In accordance with Stage 011 (Section 3.3):
- User saved places (*"Home"*, *"Work"*) contain sensitive personal habit data.
- Under **no circumstance** will records from `public.user_private_places` be queried by, ingested into, or merged with `dpmaps.trip_evidence_ledger` or `dpmaps.public_pois`.
- Saved places are private to the individual authenticated user session.

---

## 4. Implementation: Migration Service & Track 1 Triangulator

```typescript
// workers/savedPlacesMigrator.ts
import { Pool, PoolClient } from 'pg';
import { latLngToCell } from 'h3-js';
import { logger } from '../utils-server/logger';

export interface MigrationSummary {
  total_unmigrated: number;
  migrated_via_history: number;
  migrated_via_ondemand: number;
  failed: number;
}

export class SavedPlacesMigrationService {
  constructor(private readonly dbPool: Pool) {}

  /**
   * Track 1: First-Party Trip History Triangulator
   * Scans unmigrated saved places and resolves coordinates from first-party orders table
   */
  async migrateViaTripHistory(batchSize = 500): Promise<number> {
    const client: PoolClient = await this.dbPool.connect();
    let migratedCount = 0;

    try {
      // Find unmigrated bookmarks where the user completed trips matching the destination label
      const candidatesQuery = `
        SELECT 
          upp.id as saved_place_id,
          upp.user_id,
          upp.label,
          upp.custom_name,
          -- Triangulate median dropoff GPS from completed orders
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ST_Y(o.dropoff_geom)) as median_lat,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ST_X(o.dropoff_geom)) as median_lng,
          COUNT(o.id) as trip_count
        FROM public.user_private_places upp
        JOIN public.orders o 
          ON o.rider_id = upp.user_id 
         AND o.status = 'completed'
         AND (
           LOWER(o.destination_name) LIKE '%' || LOWER(upp.label) || '%'
           OR LOWER(o.destination_name) LIKE '%' || LOWER(COALESCE(upp.custom_name, '')) || '%'
         )
        WHERE upp.is_migrated = FALSE
        GROUP BY upp.id, upp.user_id, upp.label, upp.custom_name
        HAVING COUNT(o.id) >= 1
        LIMIT $1
      `;

      const res = await client.query(candidatesQuery, [batchSize]);

      for (const row of res.rows) {
        const lat = parseFloat(row.median_lat);
        const lng = parseFloat(row.median_lng);
        const h3_9 = latLngToCell(lat, lng, 9);
        const h3_10 = latLngToCell(lat, lng, 10);

        await client.query(
          `UPDATE public.user_private_places SET
            geom = ST_SetSRID(ST_Point($1, $2), 4326),
            h3_res9 = $3,
            h3_res10 = $4,
            migration_source = 'first_party_trip_history',
            user_confirmed = TRUE,
            is_migrated = TRUE,
            migrated_at = NOW()
           WHERE id = $5`,
          [lng, lat, h3_9, h3_10, row.saved_place_id]
        );
        migratedCount++;
      }

      logger.info({ migratedCount, batchSize }, '[SavedPlaces] Track 1 trip history batch completed');
      return migratedCount;
    } catch (err) {
      logger.error({ err }, '[SavedPlaces] Track 1 triangulation error');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Track 2: Handles interactive user confirmation from mobile app
   */
  async confirmUserSavedPlace(
    savedPlaceId: string,
    userId: string,
    lat: number,
    lng: number
  ): Promise<void> {
    const h3_9 = latLngToCell(lat, lng, 9);
    const h3_10 = latLngToCell(lat, lng, 10);

    await this.dbPool.query(
      `UPDATE public.user_private_places SET
        geom = ST_SetSRID(ST_Point($1, $2), 4326),
        h3_res9 = $3,
        h3_res10 = $4,
        migration_source = 'user_confirmed_pin',
        user_confirmed = TRUE,
        is_migrated = TRUE,
        migrated_at = NOW()
       WHERE id = $5 AND user_id = $6`,
      [lng, lat, h3_9, h3_10, savedPlaceId, userId]
    );

    logger.info({ savedPlaceId, userId }, '[SavedPlaces] User confirmed sovereign pin location');
  }
}
```

---

## 5. Mobile Client In-App Confirmation Card UI

When an unconfirmed user launches the mobile client during Phase 1–2, a non-blocking confirmation card surfaces upon tapping a saved bookmark:

```
┌────────────────────────────────────────────────────────┐
│                   Verify Saved Place                   │
│                                                        │
│   We've upgraded our mapping engine for faster pickups!│
│   Please confirm your "Home" pin on the map:           │
│                                                        │
│   ┌────────────────────────────────────────────────┐   │
│   │                                                │   │
│   │               📍 Home (Road 4 Gate)            │   │
│   │                                                │   │
│   └────────────────────────────────────────────────┘   │
│                                                        │
│           [ Drag map pin to adjust curb gate ]         │
│                                                        │
│      [ Confirm Pin ]                 [ Keep Existing ] │
└────────────────────────────────────────────────────────┘
```

### 5.1 Legal Significance of User Confirmation
By prompting the user to interactively confirm or adjust the pin location:
1. The resulting coordinate is transformed into **user-authored input**.
2. Third-party vendor database copyrights are completely nullified because the coordinates represent first-party user preference data, not scraped vendor database extracts.
3. Dispatch routing achieves immediate curb-level accuracy.

---

## 6. Pre-Cutover Verification & Final Column Dropping

### 6.1 Cutover Verification Gate
Before Phase 2 switch flip (Routing Provider Mode 2), the following verification assertion must pass:

```sql
-- Cutover Audit Script
SELECT 
  COUNT(*) as total_unmigrated,
  COUNT(*) FILTER (WHERE migration_source IS NULL) as unmigrated_count,
  COUNT(*) FILTER (WHERE is_migrated = TRUE) as migrated_count,
  COUNT(*) FILTER (WHERE user_confirmed = TRUE) as confirmed_count
FROM public.user_private_places;
```

**Cutover Requirement:** `total_unmigrated` must equal `0` for all users active within the trailing 90 days.

### 6.2 Post-Cutover Cleanup DDL
Once Phase 2 switch flip is complete:
```sql
-- Permanently drop vendor columns
ALTER TABLE public.user_private_places
  DROP COLUMN IF EXISTS vendor_place_id,
  DROP COLUMN IF EXISTS vendor_provider;
```

---

## 7. Unit Testing Matrix & Migration Verification

| Test Case | Scenario / Parameters | Expected Outcome | Rationale |
|---|---|:---:|---|
| **TC-014-01** | User has 5 trips to "Home" in `orders` | **MIGRATED (Track 1)** | Median GPS coordinates extracted; zero vendor calls. |
| **TC-014-02** | User has unvisited bookmark | **AWAITS CONFIRMATION (Track 2)** | Surfaced in confirmation card on next app launch. |
| **TC-014-03** | User drags pin 10m to curb and confirms | **USER_CONFIRMED** | Stored as `user_confirmed_pin`; legal clean-room warranty. |
| **TC-014-04** | H3 resolution 9 and 10 generated | **CELLS POPULATED** | Spatial indices populated for rapid geofencing. |
| **TC-014-05** | Public map tries to query saved places | **REJECTED (Schema Isolation)** | Saved places strictly decoupled from `public_pois` and search. |
| **TC-014-06** | Vendor columns dropped post-cutover | **NO REGRESSIONS** | App dispatches purely via `geom` and H3 cells. |

---

## 8. Deliverables & Definition of Done

- [ ] **Database Migration:** `migrations/014_decouple_saved_places.sql` executed adding native spatial columns and indices.
- [ ] **Track 1 Triangulation:** `SavedPlacesMigrationService` deployed, resolving $\ge 70\%$ of active user bookmarks from first-party trip history.
- [ ] **Track 2 Confirmation UI:** Mobile client confirmation card deployed in production app.
- [ ] **Cutover Verification:** Verification script confirms zero active users retain unmigrated vendor place IDs prior to Phase 2 launch.
- [ ] **Clean-Room Warranty:** Certified that bulk vendor scraping was never performed; all migrations sourced from first-party trips or direct user confirmation.
- [ ] **Final Cleanup:** Post-cutover migration drops legacy `vendor_place_id` and `vendor_provider` columns.
