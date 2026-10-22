# Stage 014: Saved Places Migration & Decoupling Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-014 (Revision 2.1 — First-Party Triangulation, Confirmation Protocol & Vendor Decoupling)
**Stage:** 14 of 16 (User Data Decoupling & Account Migration)
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§16, §16.1)
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)
**Current Status:** **NotDone**
**Target Phase:** Phase 1–2 (Dual-Connected Launch to Routing Switch Flip)
**Primary Dependencies:** Stages 002, 003 (Rev 2.5), 011, Mobile Client

> [!CAUTION]
> ### LEGAL FRAMING (Hard Rule 5)
> This migration **reduces vendor-dependency exposure** and is **subject to audit**. User confirmation transforms pins into user-authored first-party data; whether this fully addresses third-party database rights is a **counsel question (Items 15/16) `[UNVERIFIED]`** — never claim "copyrights nullified" or "immunized from IP claims" (F-014-1).

---

## 1. Executive Summary & Objective

Passengers tap saved bookmarks (*Home*, *Work*, *Parents' House*). Legacy bookmarks carry vendor place IDs (`barikoi_place_id`, Google `place_id`); a hard vendor cutover without decoupling breaks millions of foreign keys on Day 1. Bulk vendor geocoding to scrape coordinates would breach the Stage 002 clean room. Stage 014's 3-track migration:

1. **Track 1 — First-Party Trip History Triangulation (100 % clean-room):** resolve bookmarks from the user's own completed-order drop-off GPS (median cluster). Zero vendor calls.
2. **Track 2 — On-Demand User Confirmation:** a confirmation card on next selection turns the pin into user-authored first-party geometry; also the resolution path when Track 1 is ambiguous (F-014-2).
3. **Track 3 — Ephemeral Wrapper Resolution:** unvisited bookmarks resolve coordinates on an active transaction through `vendorClientWrapper` — coordinates only, never IDs/strings (F-014-3), immediately routed to Track 2 confirmation.
4. **Permanent Decoupling:** native `GEOMETRY(Point,4326)` + H3 cells + `sovereign_place_id UUID` (Rev 2.6); vendor columns dropped post-cutover.

**Table of record:** `public.user_private_places` (concept paper §16, Stage 011 Class 3 — per-user private, never merged into `dpmaps.*`).

---

## 2. Migration Flow

```
[ user_private_places (vendor_place_id present) ]
   → Pre-cutover audit (workers/savedPlacesAuditor.ts): visited (A) vs unvisited (B)
   A → Track 1 median drop-off triangulation (≥ 1 completed trip, order text/cluster match)
       • spread = max pairwise distance among matched drop-offs
       • spread > 30 m [ESTIMATE] OR < 3 qualifying trips ⇒ needs_confirmation = TRUE (F-014-2)
       • user_confirmed stays FALSE until the rider acts
   B → Track 2 card on next bookmark tap (Track 3 may prefill the pin display-only)
   → columns: geom, h3_res9, h3_res10, sovereign_place_id, migration_source,
     user_confirmed, needs_confirmation, resolution_spread_meters, is_migrated, migrated_at
   → post-cutover: DROP vendor_place_id, vendor_provider (§6)
```

---

## 3. Schema Migration (`migrations/014_decouple_saved_places.sql` — public schema; see Rev 2.6 brief)

```sql
ALTER TABLE public.user_private_places
  ADD COLUMN IF NOT EXISTS sovereign_place_id UUID NOT NULL DEFAULT gen_random_uuid(), -- F-014-4
  ADD COLUMN IF NOT EXISTS geom GEOMETRY(Point, 4326),
  ADD COLUMN IF NOT EXISTS h3_res9 VARCHAR(15),
  ADD COLUMN IF NOT EXISTS h3_res10 VARCHAR(15),
  ADD COLUMN IF NOT EXISTS migration_source VARCHAR(32) CHECK (migration_source IN
    ('first_party_trip_history', 'user_confirmed_pin', 'ephemeral_vendor_resolved', 'native_first_party')),
  ADD COLUMN IF NOT EXISTS user_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS needs_confirmation BOOLEAN NOT NULL DEFAULT FALSE,   -- F-014-2
  ADD COLUMN IF NOT EXISTS resolution_spread_meters NUMERIC(8,2),               -- F-014-2
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
```

**Privacy invariant (Class 3):** `user_private_places` is never queried by, ingested into, or merged with `dpmaps.trip_evidence_ledger` / `dpmaps.public_pois` (Stage 011 §3). Never store vendor place IDs or vendor display strings in migrated rows (F-014-3).

---

## 4. Migration Service (conformant triangulation — F-014-3)

```typescript
// workers/savedPlacesMigrator.ts — Track 1 (schema of record: orders has user_id,
// dropoff_lat/lng, status, created_at — NOT rider_id/destination_name/dropoff_geom)
export class SavedPlacesMigrationService {
  async migrateViaTripHistory(batchSize = 500): Promise<number> {
    // Match the user's completed trips by drop-off habit clustering (refinement):
    // candidate clusters = the user's frequent drop-off H3 res-10 cells over trailing
    // 180 d [ESTIMATE], ranked by trip count. DISAMBIGUATION RULE: Track 1 auto-resolves
    // ONLY when exactly one strong cluster exists (≥ 3 trips, spread ≤ 30 m). Two or
    // more strong clusters (the Home/Work case — label text cannot disambiguate them
    // because orders carry no destination label of record) ⇒ needs_confirmation = TRUE
    // with the top-2 candidates attached to the confirmation card ("Which is your
    // Home?"). Never infer Home-vs-Work silently from time-of-day heuristics.
    const candidates = await this.dbPool.query(
      `SELECT upp.id AS saved_place_id,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY o.dropoff_lat) AS median_lat,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY o.dropoff_lng) AS median_lng,
              COUNT(*) AS trip_count,
              -- spread proxy: max distance from median (computed per row below)
              MAX(o.dropoff_lat) - MIN(o.dropoff_lat) AS lat_span,
              MAX(o.dropoff_lng) - MIN(o.dropoff_lng) AS lng_span
       FROM public.user_private_places upp
       JOIN public.orders o ON o.user_id = upp.user_id AND o.status = 'completed'
       WHERE upp.is_migrated = FALSE
       GROUP BY upp.id
       HAVING COUNT(*) >= 3                            -- F-014-2 confidence floor [ESTIMATE]
       LIMIT $1`, [batchSize]);

    for (const row of candidates.rows) {
      const spreadM = approxSpreadMeters(row.lat_span, row.lng_span); // geography max-pairwise at build
      const needsConfirmation = spreadM > 30 || row.trip_count < 3;   // F-014-2 (> 30 m [ESTIMATE])
      await this.dbPool.query(
        `UPDATE public.user_private_places SET
           geom = ST_SetSRID(ST_Point($1, $2), 4326), h3_res9 = $3, h3_res10 = $4,
           migration_source = 'first_party_trip_history',
           user_confirmed = FALSE,                     -- F-014-2: machine-resolved ≠ confirmed
           needs_confirmation = $5, resolution_spread_meters = $6,
           is_migrated = TRUE, migrated_at = NOW()
         WHERE id = $7`,
        [row.median_lng, row.median_lat, h3_9, h3_10, needsConfirmation, spreadM, row.saved_place_id]);
    }
    return candidates.rows.length;
  }

  /** Track 2: the ONLY path that sets user_confirmed = TRUE (F-014-2). */
  async confirmUserSavedPlace(savedPlaceId: string, userId: string, lat: number, lng: number) {
    await this.dbPool.query(
      `UPDATE public.user_private_places SET
         geom = ST_SetSRID(ST_Point($1,$2),4326), h3_res9 = $3, h3_res10 = $4,
         migration_source = 'user_confirmed_pin', user_confirmed = TRUE,
         needs_confirmation = FALSE, is_migrated = TRUE, migrated_at = NOW()
       WHERE id = $5 AND user_id = $6`, [lng, lat, h3_9, h3_10, savedPlaceId, userId]);
  }

  /** Track 3: wrapper returns {lat,lng} only (Stage 002) — never IDs/strings; result is
   *  display-only until the user confirms (immediate Track 2 card, F-014-3). */
}
```

---

## 5. Confirmation Card UX (F-014-2)

Non-blocking card on bookmark tap whenever `needs_confirmation = TRUE` or `user_confirmed = FALSE`:
> *"We've upgraded our mapping engine for faster pickups. Please confirm your Home pin."* — map canvas with suggested pin; **[ Confirm Pin ] [ Adjust & Confirm ] [ Later ]**. A `> 30 m` machine suggestion is never silently applied.

**Legal framing:** user-confirmed coordinates are user-authored first-party preference data; this **reduces** vendor-derived-data exposure (Hard Rule 1) and is **subject to counsel review (Items 15/16)** — no absolute IP claims (F-014-1).

---

## 6. Cutover Verification & Cleanup

```sql
-- Gate: zero active users (trailing 90 d) with unmigrated or unconfirmed-ambiguous places
SELECT COUNT(*) FROM public.user_private_places upp
JOIN public.orders o ON o.user_id = upp.user_id AND o.created_at >= NOW() - INTERVAL '90 days'
WHERE upp.is_migrated = FALSE OR upp.needs_confirmation = TRUE;   -- must be 0 before Mode 2
```

Post-cutover (after Mode 2 stable): `ALTER TABLE public.user_private_places DROP COLUMN IF EXISTS vendor_place_id, DROP COLUMN IF EXISTS vendor_provider;` — vendor identifiers leave the schema permanently (F-014-3).

---

## 7. Tests

| TC | Scenario | Expected |
|---|---|:---:|
| TC-014-01 | 5 trips to Home, spread 8 m, single cluster | MIGRATED Track 1, `user_confirmed=FALSE`, `needs_confirmation=FALSE` |
| **TC-014-01c** | user has 2 strong clusters (Home + Work) | **`needs_confirmation=TRUE` with 2 candidates on the card** — never silent inference |
| **TC-014-01b** | 3 trips, spread 45 m | MIGRATED + **`needs_confirmation=TRUE`** (F-014-2) |
| TC-014-02 | unvisited bookmark | AWAITS card (Track 2/3) |
| TC-014-03 | user drags pin & confirms | `user_confirmed_pin`, `user_confirmed=TRUE` |
| TC-014-04 | H3 cells | res 9/10 populated |
| TC-014-05 | public map queries saved places | REJECTED (Class 3 isolation) |
| TC-014-06 | post-cutover | vendor columns gone; dispatch works on `geom`/H3 |
| **TC-014-07** | grep migrated table | zero vendor IDs/strings anywhere (F-014-3) |
| **TC-014-08** | sovereign id | `sovereign_place_id` stable across renames/updates (F-014-4) |

---

## 8. Deliverables

- [ ] Migration DDL applied (Rev 2.6 items); `sovereign_place_id` UUIDs minted for all rows.
- [ ] Track 1 triangulation with spread/ambiguity flags; `user_confirmed` only via Track 2 (F-014-2).
- [ ] Orders-stub conformant SQL (user_id/dropoff_lat/lng) (F-014-3).
- [ ] Confirmation card deployed; `> 30 m` silent-snap demonstrably impossible.
- [ ] Clean-room warranty: zero bulk vendor scraping; Track 3 response-only, counsel Item 15 routed (F-014-1/3).
- [ ] Cutover gate (§6) green before Mode 2; vendor columns dropped post-stabilization.

---

## 9. Revision Changelog

| Revision | Date | Author / Context | Summary |
|---|---|---|---|
| Rev 2.0 | 2026-10-22 | Orchestrator (audited baseline) | 3-track strategy, migration DDL, confirmation card, cutover gate. |
| Rev 2.1 | 2026-10-22 | Lead Planning & Systems Architecture (batch-4 audit) | **Confirmation Semantics & Legal Framing:** 1. Absolute IP claims removed; counsel routing Items 15/16 (F-014-1). 2. `user_confirmed` only on user action; `> 30 m` spread ⇒ `needs_confirmation` + card (F-014-2). 3. Triangulation SQL conformed to the orders stub (F-014-3). 4. `sovereign_place_id` UUID discipline; on-demand-only vendor resolution stance (F-014-4). |
