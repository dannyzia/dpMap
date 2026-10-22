# AGENTS.md — dpMaps

Instructions for any AI agent (coding, planning, or reviewing) working in this repository.
Read this file first, then `docs/plans/000_TOC.md`, then the concept paper.

Last updated: 2026-10-22, from review sessions through Stage 003.
Anything marked UNVERIFIED, ESTIMATE, or ASSUMPTION has not been confirmed. Do not turn it into fact.

---

## Orchestrator Protocol (dpMaps)

> **Activation:** active while Rhizome ISSUE-1 ("ORCHESTRATOR LOOP — dpMaps build-out") is open.
> On its closure this section retires and normal single-agent workflow applies.

Roles: **orchestrator** (instructs, answers, verifies — skill: `rhizome-orchestrator`)
and **builder** (builds, reports, asks — skill: `rhizome-builder`). Load your skill
at session start.

- Hub: ISSUE-1 (Rhizome project_ref: `01M5H6TECHRC07PB2PJX1PAB9D`). All coordination is comments there.
- Builder tags: `STEP <n>:` after every build step (even small), `STAGE REPORT:`
  at stage end, `QUESTION:` for clarifications and follow-ups.
- Orchestrator tags: stage orders, `ANSWER:`, `OWNER-DECISION:`, `VERIFIED:`.
- The builder never contacts the owner; business/risk/money/irreversible items
  route through the orchestrator.
- Both roles check Rhizome intermittently; silence never means approval.
- Verification rule: a stage advances only after three-pillar verification
  (repo, CI on the exact head SHA, and runtime endpoint/dataset verification:
  OSRM `/route/v1/driving`, MeiliSearch `/health`, or verified POI database
  row counts; "healthy" is not "current").
- Project standing rules: clean-room isolation (zero vendor data/coordinates
  stored or learned from), driver GPS is ground truth, no map scraping,
  synthetic canary payloads, Stage 002 legal gate clearance before shadow
  telemetry, privacy by default (no raw keystrokes, no trip_id in pseudonymous tables).

---

## 1. What this project is

dpMaps is an in-house maps engine for **Ride**, a ride-hailing app for Bangladesh (Dhaka first).

- **Barikoi** (a Bangladeshi maps and location API vendor) is the default provider at launch.
- dpMaps runs beside it, learns only from Ride's own first-party trip data, and must be able to take over if Barikoi becomes unavailable.
- Primary goal: **self-sufficiency** (survive vendor loss). Cost saving is not a driver.
  The documents are technical. Do not argue from vendor price comparisons.
  Deployment sizing and estimated run cost are fine.

Owner: Zia (Indigo Bangladesh). Dev machine: Windows (PowerShell). Also a Debian-based ChromeBox.
Project folder: `D:\My Projects\Current Project\dpMaps`

---

## 2. Repository map

| Path | What it is |
|---|---|
| `docs/plans/independent-mapping-engine-concept-paper.md` | Source of truth. Concept paper RIDE-CP-2026-GEO-01. Last revision reviewed: 7.2 (plan set refers to 7.3; check the file header). |
| `docs/plans/000_TOC.md` | Stage registry and status matrix. |
| `docs/plans/001_…` to `016_…` | One implementation plan per stage. |
| `docs/resources/bangladesh.poi` | Mapsforge POI database built from OpenStreetMap. Snapshot 2026-02-25, 101,884 rows, 24,276,992 bytes. Tables: `poi_data(id, data)`, `poi_index(id, lat, lon)`, `poi_categories`, `poi_category_map`, `metadata`. Tags in `data` are separated by `\r`. IDs are sequential row numbers, not OSM IDs. |
| `docs/resources/geoBoundaries-BGD-ADM*.geojson` | Administrative boundaries (ADM0 and ADM2 present; ADM3 thana/upazila needed). |
| `docs/resources/dpmaps-poi-tool.zip` | **Stale v1** of the Pin Tool. Replace with the latest build (see §8). |

The Ride backend itself is not in this repo. Plans mention paths such as `utils-server/…` and `workers/…`. Do not assume anything else about its structure.

---

## 3. Architecture decisions (current)

**Provider modes.** Routing and search each have an admin-controlled mode, hot-reloadable:
`off` (vendor only) → `shadow` (vendor serves, dpMaps runs in the background and is benchmarked) → `primary` (dpMaps first, vendor only on a miss or failure, logged) → `sole` (zero vendor calls).
The admin decides when to switch. Month 3 to 4 is a target, not a rule. Gates are numeric and written before launch (Stage 015).

**Routing.** OSRM (MLD) on a Geofabrik Bangladesh extract, with custom car, bike, and CNG profiles. ETA must be learned from time-of-day speeds (OSRM weights are static). Fallback chain: OSRM → Barikoi → Google (spend-capped) → straight-line estimate. ETA gates are relative (% of trip duration), not flat minutes. Run OSRM in shadow from launch.

**Search.** MeiliSearch. Two separate indexes (first-party and OSM), merged at query time, never physically combined. Mixed autocomplete from launch.

**Tiles.** Planetiler → PMTiles → Cloudflare R2, MapLibre on the client, Noto Sans Bengali glyphs.

**Storage.** PostgreSQL + PostGIS, schema `dpmaps`, H3 resolutions 9 and 10, pg_partman.

**Learning (voting).**
- A vote is one completed trip: the rider's final typed string at the moment of selection (max 80 characters, no keystroke stream) plus the driver's end-of-trip GPS fix, aggregated into an H3 res-10 cluster (res 9 for areas).
- Prefix-only votes carry reduced weight (0.35) and can locate a place but never name it.
- Evidence window: rolling 90 days, exponential decay with half-life 45 days (λ = ln2/45 ≈ 0.0154/day), computed at read time.
- Publication gates (starting values, admin-editable, must be replayed on real trip data first): at least 15 distinct riders, 5 distinct drivers, 3 separate weeks, 70% weighted share, 20-point margin over the runner-up, and a 95% Wilson lower bound above 0.5 using Kish effective sample size.
- Caps: one counted vote per rider per query cluster per week, at most 3 per 90 days.
- Publication cadence is admin-set (default monthly). Releases are immutable and versioned. A challenger must win two consecutive cycles. Stale entries are demoted, not deleted. One-step rollback. Emergency suppression.
- **Place IDs are minted once** (random UUID) and never derived from name or cell.

**Naming.** Display-name order: Pin Tool or merchant name → post-trip rider label → canonical form of the most common normalized rider-typed variant (never the raw majority string). One display name per script. Aliases carry provenance.

**Named houses.** In Bangladesh people name their houses, and such houses can be landmarks. A named house or building may become public when the **name** converges across many unrelated riders. Never publish unit-level addresses, "someone's flat" strings, saved Home/Work places, or any rider's history. A report-wrong-location button and a takedown process exist. No routine per-place admin approval, but a flag-driven exception queue handles abuse reports and takedowns.

**Pseudonyms and keys.** Keyed HMAC pseudonyms. A key can only hash votes made after it was created, so a 90-day window needs keys that live **135 days** (90 days + 30 days rotation + 15 days jitter buffer), rotated every 30 days, with each vote written under every currently valid key (up to 5 keys). Distinct riders are counted under the oldest key created at least 90 days before the window end (with a cold-start partial-window mode for the first 90 days). (A simulation of the Stage 003 original, 90-day validity with the newest key only, overcounted riders by about 1.6 to 2.3 times; 120 days had zero operational margin for rotation delays). Raw logs purge at 30 days. The ledger must not contain `trip_id`.

**Seeding.** About 2,000 field-surveyed landmarks via the Pin Tool (clean-room), plus OSM POIs in a **separate** `osm_pois` table (ODbL, never merged into `public_pois`).

---

## 4. Hard rules

1. **Clean room.** Never store, log, cache beyond its TTL, or learn from anything Barikoi or Google returns: names, addresses, place IDs, coordinates, polylines, formatted strings. Location truth is the driver's GPS fix. Vendor-derived transactional data (fare distance, receipts) lives only in `ride_vendor_data`, with column-level grants and no access for `dpmaps_worker`.
2. **No copying from map apps.** Never scrape or copy places from Google Maps, Barikoi, or any other map app, by script or by hand. Do not write scrapers for this. Contributors certify this on every save.
3. **No vendor payloads** in logs, tickets, chats, or AI prompts. Use synthetic payloads with unique canary values.
4. **Legal.** Nothing about law is established in these documents. Mark it UNVERIFIED and route it to counsel (Stage 002 §10). No shadow-mode learning or telemetry ingestion until the legal-gate items (3, 7, 14, 15, 16, 17) are resolved in writing.
5. **No absolute claims.** Do not write "immune", "unbreachable", "mathematically impossible", or "100% compliant". Write "reduces exposure" and "subject to audit".
6. **Do not invent figures, prices, vendor terms, or laws.** Label ESTIMATE, UNVERIFIED, or ASSUMPTION. When a figure is verified, record the source URL and capture date.
7. **Pin Tool imagery:** OpenStreetMap raster tiles only. No Esri, Bing, or Google imagery.
8. **Privacy by default:** no raw keystroke streams, no `trip_id` in pseudonymous tables, k-anonymity before publishing, discard phone-number and email-like strings in typed text (normalize Bengali digits and strip separators first).

---

## 5. Conventions

- Plan files: `docs/plans/NNN_snake_case_name.md`. Header fields: Plan Identifier, Stage, Parent Document, Current Status. Status values are exactly `Done`, `partiallydone`, or `NotDone`.
- Every revision adds a changelog entry and a revision number. Do not rewrite sections you were not asked to change.
- Windows paths and PowerShell in commands.
- Languages: TypeScript for the Ride backend, Python 3 for ingestion (`h3>=4`, `shapely`, stdlib `sqlite3`), Node for the Pin Tool.
- Test with real data from `docs/resources` whenever possible. Do not trust a script you have not run.

---

## 6. Stage status and open findings

| Stage | Status | Review state |
|---|---|---|
| 000 TOC | Done | |
| 001 Phase 0 seeding and data assets | partiallydone | Rev 2.3 applied per audit (composite PK, canonical categories, 50,545 post-dedupe baseline on real bangladesh.poi). |
| 002 Provenance firewall and legal | NotDone | Rev 2.1 verified. Rev 2.2 patch (fuzz-test scoping, egress logging, hash coverage, phone regex, `GETDEL`, receipts, quarantine, legal gate) applied per owner, not re-read. |
| 003 Storage schema and evidence ledger | NotDone | Rev 2.6 applied per Stage 004/005, 008/009/011, 006/007/010, and 012–016 audit adoptions (additive: segment_speeds_tod, h3_edge_speeds_tod, eta_tod_corrections in §4.9; vendor_provider in ride_vendor_data in §4.8; takedown_reports, provisional_challengers, query_clusters.published_poi_id, dual search feed views, orders.user_id in §4.10; post_trip_labels, chk_poi_bilingual_active in §4.11; ledger_invalidations reason widening, osm_road_names, user_private_places sovereign identity in §4.12; Rev 2.2 core verified). |
| 004 OSRM routing engine and dynamic traffic | NotDone | Rev 2.1 applied per audit (TOD-learned speed pipeline with segment_speeds_tod, multiplicative correction k(v,b), per-edge map-matching, 300ms timeout, relative ETA cutover gates ≤ 12% median / ≤ 25% p95, car/bike/cng profiles). |
| 005 Dispatch router and shadow benchmarking | NotDone | Rev 2.1 applied per audit (first-class mode 0 off, clean-room Redis shadow payload without vendor quotes, correlation via trip_hash, Stage 003 §4.7 DDL alignment, 18 km/h Haversine fix, Gate 1 median & vendor-parity repair). |
| 006 Vector tiles, PMTiles & Bengali glyphs | NotDone | Rev 2.1 applied per audit (Hard Rule 7 raster policy + CI test, labeled Planetiler sizing, R2 purge tags [Stage 011 Tier D], fontstack conformance, first_party.pmtiles overlay [Invariant 4], ODbL attribution footer). |
| 007 Text normalization & alias clustering | NotDone | Rev 2.1 applied per audit (`scrubPii` contract cross-stage, ordered entity/direction locking, order-insensitive phonetic name tokens, schema-conformant alias promotion). |
| 008 MeiliSearch engine and mixed autocomplete | NotDone | Rev 2.1 applied per audit (dual physical indexes first_party_pois/osm_pois with RAM-only merge, zero-hit vendor fallback, dest_session:* 15-min GETDEL handoff, popularity/bilingual ranking, selection-time telemetry). |
| 009 Winner selection and Wilson confidence | NotDone | Rev 2.1 applied per audit (UUIDv4 identity, Gate 5 cell margin on v_active_cluster_evidence, proved Wilson threshold n_eff ≥ 25 at p=0.70 [rejecting work order's false ≥ 23 claim; DPM-D-012], k=1 ring aggregation, two-cycle demote-not-delete). |
| 010 Naming engine & post-trip verification | NotDone | Rev 2.1 applied per audit (4-tier hierarchy, bilingual publication gate [chk_poi_bilingual_active], post_trip_labels staging [cycle-bounded], poi_versions lineage, unindexed-cluster seeding). |
| 011 Privacy architecture and takedowns | NotDone | Rev 2.1 applied per audit (Redis Set/sliding-window suppression [no Bloom filter], traveler-qualified reporting [completed ride to cell in 90 d], dual-tier SLA <1h/<4h on Stage 003 columns, categorical residential privacy boundary). |
| 012 Anti-manipulation & Sybil resistance | NotDone | Rev 2.1 applied per audit (side-table invalidation only [ledger immutable], layered caps [rider/driver/pair], 5×/48h res-10 burst quarantine, work-order enum crosswalk). |
| 013 Geocoding, parsing & snapping | NotDone | Rev 2.1 applied per audit (4-tier reverse waterfall with osm_road_names Tier 2, zero-hit ≤ 100m vendor fallback [response-only], clean-room Dhaka address parser, perimeter gate snapping). |
| 014 Saved places migration & decoupling | NotDone | Rev 2.1 applied per audit (3-track migration, >30m needs_confirmation card, Home/Work disambiguation [no silent inference], sovereign_place_id UUID, legal overclaims removed). |
| 015 Evaluation suites & cutover gates | NotDone | Rev 2.1 applied per audit (Stage 003 §4.7 column crosswalk [closes X-1], golden suites w/ monsoon, gate ladder 1A/1B/2 [TOC consensus + configurable override]). |
| 016 Infrastructure, HA & SRE runbooks | NotDone | Rev 2.1 applied per audit (Stage 004 RSS-matched sizing [Phase-1 32GB] + network rows, Meili/PG replication, Runbooks A–D [crash failover, <1h takedown, mode rollback, graph re-ingestion]). |

**Stage 003 status:** Rev 2.6 applied (Rev 2.2 core verified; Rev 2.3–2.6 additively adopt Stages 004–016 objects). Ready for implementation.

**Audit Status:** All 16 stages audited and upgraded to Revision 2.1+. Entire plan set is aligned to clean-room invariants, Stage 003 schemas, and mathematical proofs. Ready for full-plan sign-off and Phase 0/1 implementation.


---

## 7. Data facts (measured)

- `bangladesh.poi`: 77.5% of rows named; `name:bn` 6.2%; `name:en` 11.2%; about 16% have Bangla script in `name`.
- Noise: about 12,780 rows are chimneys, works, toilets, wells, playgrounds; 4,543 are villages; about 1,874 near-duplicate pairs (same name within 25 m).
- No traffic-signal nodes: intersections (for example "Bata Signal") are absent. The 300-point intersection and gate quota depends entirely on field survey.
- Stage 001 tag-based mapping stores 50,545 places (mosque 10,867, school 7,752, restaurant 5,458, bank 3,912, pharmacy 3,788, hospital 3,090, transit_station 2,956, government 2,312, worship 1,830, fuel 1,740, hotel 1,516, university 1,503, area 757, supermarket 728, park 720, shopping_mall 611, atm 500, market 473, airport 32).
- The ADM0 file is a crude coastline (1,513 vertices). Clipping to it deletes about 676 real coastal and island places, so do not clip to it.

---

## 8. Pin Tool (field contributors)

Latest build: Express + better-sqlite3 + h3-js, Leaflet on OSM raster tiles, shared access key (`CONTRIBUTOR_KEY`), admin review at `/admin` (user `admin`, password from `ADMIN_PASSWORD`).
Features: Bangla and English names, aliases, 19 categories, mandatory clean-room warranty checkbox (version and timestamp stored), 50 m same-name duplicate rejection, exports for `public_pois` (SQL and JSON, paper schema), GeoJSON, and CSV.

The zip in `docs/resources` is still v1. Replace it with the latest build before relying on it. Extract to `tools\` (the zip root is `poi-tool\`).

Run: `cd tools\poi-tool`, `npm install`, edit `start.bat` (set `ADMIN_PASSWORD`), run `start.bat`, open `http://localhost:3000`.

Backlog: 23 categories (add pharmacy, fuel, supermarket, atm), `parent_venue` linkage for gates, per-surveyor tokens and audit hash, OSM candidate import (confirm or move a pin), export aligned to the Stage 003 schema.

---

## 9. Working with the owner

- Be blunt and concise. Say what is wrong. Push back when something is wrong.
- Step-by-step instructions with a verification step before moving on.
- Deliver complete, ready-to-use files, not partial snippets.
- Review one stage at a time. Ask at most one question per message.
- The review loop: the reviewer reads the file, runs any code against real data, and writes a patch brief; the plan-writing agent applies only that brief and adds a changelog entry; the reviewer re-reads and verifies before moving on.

---

## 10. Still UNVERIFIED (do not state as fact)

OSRM RAM, throughput, and latency on the real graph; tile size and build time; H3 cell sizes (check the official table); Dhaka's OSM completeness; MRT Line 6 station and gate counts; Barikoi contract terms (storage, caching, derived data, competing database, post-termination, mixed autocomplete display, permission to store selected suggestions); the status of any Bangladeshi data-protection law; whether tax rules require verbatim vendor address text on receipts; provider prices for hosting and R2; the number of Dhaka thanas in ADM3.
