# Stage 013: Specialized Geocoding, Parsing & Snapping Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-013 (Revision 2.1 — Clean-Room Dhaka Parsing, Sovereign Reverse Geocode & Gate Snapping)
**Stage:** 13 of 16 (Specialized Geospatial Capabilities)
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§15, §15.1–15.4)
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)
**Current Status:** **NotDone**
**Target Phase:** Phase 2 (Specialized Services)
**Primary Dependencies:** Stages 001, 002, 003 (Rev 2.5), 004, 007, 008

---

## 1. Executive Summary & Objective

Generic geocoders fail in Dhaka: pin-drag returns "Dhaka Division", compound addresses (*"Flat 5B, House 23/A, Road 4, Block C, Uttara"*) zero-hit exact matching, and pins inside mega-complexes snap to expressway ramps or the wrong side of a wall. Stage 013 delivers three sovereign engines:

1. **Sovereign Reverse Geocoder (F-013-2/3):** 4-tier local-first waterfall (POI → OSM road → admin boundary → H3 zone), vendor reverse-geocode **only** in `shadow`/`primary` when no first-party POI **and** no named road resolves within 100 m — response-only display, never stored (Hard Rule 1).
2. **Clean-Room Dhaka Address Parser (F-013-1):** deconstructs compound addresses with Stage 007 entities; private micro-units become ephemeral **Driver Delivery Notes** (Stage 011 Class 1: never persisted in `dpmaps.*`, purged with trip data); resolvable anchors go to search.
3. **Perimeter Gate Snapper (F-013-2):** pins inside campuses snap to legal curb gates (`perimeter_gate`/`entrance`/`curb_stop` per `dpmaps.point_type_enum`) with pedestrian connectors.

> [!CAUTION]
> Vendor fallback flows through `vendorClientWrapper` (Stage 002); vendor strings/coordinates are display-only and never written to any persistent table (Hard Rule 1).

---

## 2. Engine 1: Reverse Geocode Waterfall

```
Pin (lat,lng) → H3 res-10 cache lookup (dpmaps:reverse_geo:<h3>, 24 h TTL)
  TIER 1  public_pois within 50 m (geography meters; lifecycle_status='active')
          → "Near {name}, {area}"                     confidence 0.95
  TIER 2  osm_road_names centerline within 30 m (Rev 2.6, ODbL layer)
          → "{road_name}, {area}, Dhaka"               confidence 0.85
  TIER 3  admin_boundaries ST_Contains (ADM3/ADM4)
          → "{ward/area}, {thana}, Dhaka"              confidence 0.80
  TIER 4  H3 res-8/9 zone table fallback
          → "{thana}, Dhaka"                           confidence 0.50
ZERO-HIT RULE (F-013-3, refinement: radius semantics clarified):
  Discovery radius = 100 m for BOTH the POI and road tests — "zero hit" means no
  public_pois row AND no osm_road_names segment within 100 m. The tier display radii
  (Tier 1 ≤ 50 m, Tier 2 ≤ 30 m) only rank formatting preference inside a hit.
  → shadow: vendor lookup for benchmarking only (Stage 005 eval discipline)
  → primary: vendor lookup as display-only enhancement (never stored; no DB fallback)
  (Tier 3/4 text still returned regardless — admin boundaries always resolve)
```

### 2.1 Implementation notes
- All distance predicates use **geography meters** (`ST_DWithin(geom::geography, point::geography, 50)`), not degree approximations (F-013-1).
- Cache keys are **H3 res-10 cells** (stack-consistent) — not geohash stubs (F-013-4).
- `lifecycle_status = 'active'` (schema enum; F-013-1).
- Tier 2 source: `dpmaps.osm_road_names` (way_id, name, name_bn, highway class, geom) built from the Geofabrik extract into the isolated ODbL layer (Rev 2.6). Nominatim is **not** required `[UNVERIFIED alternative]`.
- Vendor fallback result shape: `{ display_text }` only — no place IDs, no persistence, no telemetry strings (Stage 002 wrapper contract).

---

## 3. Engine 2: Dhaka Compound Address Parser (F-013-1)

$$\text{"Flat 5B, House 23/A, Road 4, Block C, Sector 11, Uttara, Dhaka-1230"}$$

| PRIVATE (Driver Delivery Notes — ephemeral) | RESOLVABLE (search / geocode anchors) |
|---|---|
| Flat/Unit *"Flat 5B"*, *"৪র্থ তলা"* | Road/Lane *"Road 4"*, *"গলি"* |
| Holding/House *"House 23/A"*, *"বাড়ি"* | Block/Sector *"Block C"*, *"Sector 11"* |
| | Area/Thana *"Uttara"*; postal *"1230"* |

- **Stage 007 hand-off:** Bengali digit folding via `scrubPii` first; entity extraction reuses the ordered `(headword, value)` pairs so "Road 4" ≠ "Road 7" survives parsing.
- **Zero-hit prevention:** micro-units stripped before MeiliSearch submission (`"Road 4 Block C Uttara"`).
- **Class 1 boundary (F-013-4):** delivery notes are per-trip operational display on the driver handset only — never in `dpmaps.*`, never in public search, purged with trip records (Stage 011 §3).

```typescript
export function parseDhakaCompoundAddress(input: string): ParsedDhakaAddress {
  const text = scrubPii(input);                       // Stage 007 — phones/emails out first
  // micro-unit extraction: flat/holding regexes (bn+en) → delivery_notes
  // anchor extraction: road/block/sector/area/postal → resolvable_query (ordered entities)
  // … (regexes per Rev 2.0 §3.1, unchanged)
}
```

---

## 4. Engine 3: Perimeter Gate Snapper (F-013-2)

1. **Venue detection:** pin inside/within 150 m `[ESTIMATE]` of a `building`/`area` venue (geography).
2. **Gate selection:** child rows via `parent_place_id` with `point_type IN ('perimeter_gate','entrance','curb_stop')` — the taxonomy of record (`pickup_gate` in the work order maps to `perimeter_gate`/`entrance`; no schema change).
3. **Vehicle filtering:** gate vehicle permissions live in `public_pois.provenance` JSONB (refinement — no DDL): `provenance->'gate'->'vehicles'` = `["car","bike","cng"]` subset, default = all. Cars prefer `perimeter_gate`; bikes/CNG may use secondary `entrance`/`curb_stop`.
4. **Snap:** nearest gate by distance; driver target = `entrance_geom` (pre-snapped legal curb).
5. **Pedestrian connector:** GeoJSON LineString pin→gate with walk distance/time.
6. OSRM destination = gate coordinates; in-app pin keeps the user's original drop with connector overlay.

```sql
SELECT g.id, g.canonical_name, g.entrance_geom, g.point_type
FROM dpmaps.public_pois g
WHERE g.parent_place_id = $1
  AND g.point_type IN ('perimeter_gate', 'entrance', 'curb_stop')
ORDER BY ST_Distance(g.entrance_geom::geography, ST_SetSRID(ST_Point($2,$3),4326)::geography) ASC
LIMIT 1;
```

---

## 5. Tests

| TC | Scenario | Expected |
|---|---|:---:|
| TC-013-01 | *"Flat 5B House 23/A Road 4 Block C Uttara"* | delivery_notes=`Flat 5B, House 23/A`; query=`Road 4 Block C Uttara` |
| TC-013-02 | Bengali digits in holding number | folded, extracted (scrubPii first) |
| TC-013-03 | pin 20 m from Square Hospital | Tier 1 *"Near Square Hospital"* |
| TC-013-04 | pin on unnamed lane | Tier 2/3 road or admin; **no vendor call** |
| **TC-013-05** | pin with no POI/road ≤ 100 m (primary) | vendor display-only text; **zero rows written** (F-013-3) |
| TC-013-06 | pin inside JFP courtyard | snapped to perimeter gate + connector |
| TC-013-07 | vehicle=car vs bike at campus | car → primary gate only |
| TC-013-08 | delivery note content | absent from every `dpmaps.*` table & public response |

---

## 6. Deliverables

- [ ] Reverse geocoder: 4-tier waterfall, H3 cache, geography radii, `active` enum (F-013-1).
- [ ] `dpmaps.osm_road_names` populated from Geofabrik (Rev 2.6) — Tier 2 live without Nominatim.
- [ ] Vendor fallback contract verified response-only on zero-hit ≤ 100 m in shadow/primary (F-013-2/3).
- [ ] Parser with Stage 007 hand-off; Class-1 ephemeral delivery notes (F-013-4).
- [ ] Gate snapper with `perimeter_gate`/`entrance`/`curb_stop` taxonomy + vehicle filtering.
- [ ] All radii/thresholds `[ESTIMATE]`-labeled; area tokens list shared with Stage 010 Road-N heuristic.

---

## 7. Revision Changelog

| Revision | Date | Author / Context | Summary |
|---|---|---|---|
| Rev 2.0 | 2026-10-22 | Orchestrator (audited baseline) | Reverse waterfall, compound tokenizer, gate snapper. |
| Rev 2.1 | 2026-10-22 | Lead Planning & Systems Architecture (batch-4 audit) | **Clean-Room Contract & Schema Conformance:** 1. `active` enum + geography radii (F-013-1). 2. Tier 2 via `osm_road_names` (Rev 2.6); vendor reverse-geocode strictly shadow/primary on zero-hit ≤ 100 m, response-only (F-013-2/3). 3. H3 cache keys; `pickup_gate`→`perimeter_gate` crosswalk; Class-1 ephemeral delivery notes (F-013-4). |
