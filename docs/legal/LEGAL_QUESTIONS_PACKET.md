# dpMaps Counsel Packet — Legal Questions & Pre-Shadow Gate

**Parent plan:** `docs/plans/002_provenance_firewall_and_legal_compliance.md` (§10)
**Status:** Pending Review — all items UNVERIFIED until external Bangladeshi counsel confirms in writing.
**Clean-room note:** this packet contains zero vendor payloads, zero vendor coordinates/place IDs, and zero OSM extracts. All test payloads referenced are synthetic canary sentinels (see Stage 002 §8).

## Mandatory legal gate (Phase 1 start blocked)

Phase 1 operations — including OSRM shadow benchmarking (Stages 004/005), which ingest driver GPS and compare against vendor quotes — **cannot commence** until items **3, 7, 14, 15, 16, and 17** are formally reviewed, resolved, and signed off in writing by external Bangladeshi counsel.

## Legal review matrix

| # | Legal domain | Priority | Question for external counsel | Owner | Due | Status |
|---|---|---|---|---|---|---|
| 1 | Data protection law status | P1 | What is the current formal legislative status and enforcement timetable of any enacted or pending Bangladesh data protection legislation? [UNVERIFIED] | Counsel | Pre-Pilot | Pending Review |
| 2 | Pseudonymization vs. personal data | P1 | Under Bangladeshi law (GDPR Art. 4(5) as comparative benchmark only), does HMAC-hashed telemetry with destroyed 90-day window keys qualify as anonymized data? [UNVERIFIED] | Counsel | Pre-Pilot | Pending Review |
| 3 | Keystroke telemetry lawful basis | **P0** | Does capturing pre-autocomplete typed strings at the selection moment require explicit opt-in consent during onboarding under Bangladeshi law? Do not assume "legitimate interest" exists. [UNVERIFIED] | Counsel | **Pre-Shadow Gate** | Pending Review |
| 4 | Account deletion & right to erasure | P1 | How does the platform demonstrate compliance with erasure requests when historical votes exist only as HMAC pseudonyms whose key is destroyed? [UNVERIFIED] | Counsel | Pre-Pilot | Pending Review |
| 5 | Minors & school telemetry | P1 | What telemetry and location restrictions apply to passenger telemetry involving students under 18 traveling to/from educational institutions? [UNVERIFIED] | Counsel | Pre-Pilot | Pending Review |
| 6 | Cross-border cloud hosting | P2 | Does hosting OSRM graph containers and PMTiles on Singapore cloud infrastructure violate domestic data residency mandates? [UNVERIFIED] | Compliance | Pre-GA | Pending Review |
| 7 | Vendor contract compliance | **P0** | Does utilizing Barikoi-assisted trips (capturing rider typed characters and driver physical GPS dropoffs) violate Barikoi's ToS, given that zero Barikoi output is stored? [UNVERIFIED] | Counsel | **Pre-Shadow Gate** | Pending Review |
| 8 | ODbL derivative-database exposure | P1 | Does maintaining OSM road geometry in `dpmaps.osm_pois` create share-alike exposure for proprietary `dpmaps.public_pois` when merged at query time in RAM only? [UNVERIFIED] | Counsel | Pre-Pilot | Pending Review |
| 9 | Barikoi selection learning permission | P2 | Seek Barikoi's formal written permission to store and analyze user-selected vendor suggestions for quality benchmarking (dpMaps operates self-sufficiently without this). [UNVERIFIED] | Business / Legal | Pre-GA | Pending Review |
| 10 | Named private houses & takedowns | P1 | Does publishing names of residential buildings create defamation or privacy liabilities, and does the <4hr takedown policy provide sufficient defense? [UNVERIFIED] | Counsel | Pre-Pilot | Pending Review |
| 11 | Contributor warranty enforceability | P1 | Are the click-through Clean-Room Contributor Agreement and Merchant Warranty enforceable under the Bangladesh Contract Act 1872 and Copyright Act 2000? [UNVERIFIED] | Counsel | Pre-Pilot | Pending Review |
| 12 | Post-trip prompt consent | P2 | Does prompting riders to name an unindexed drop-off point require specific data processing disclosures under consumer protection or digital commerce guidelines? [UNVERIFIED] | Counsel | Pre-Pilot | Pending Review |
| 13 | OSM attribution adequacy | P2 | Does the client footer attribution ("Map data & POIs © OpenStreetMap contributors under ODbL") satisfy ODbL 1.0 §4.3? [UNVERIFIED] | Counsel | Pre-Pilot | Pending Review |
| 14 | Vendor order data retention | **P0** | What is the legally permissible retention period for vendor-derived transactional data (quoted distance, billed coordinates) in order/receipt records post-termination? [UNVERIFIED] | Counsel | **Pre-Shadow Gate** | Pending Review |
| 15 | Vendor contract termination clauses | **P0** | Review Barikoi contract clauses on derived data, competing-database restrictions, reverse-engineering prohibitions, and post-termination survival. [UNVERIFIED] | Counsel | **Pre-Shadow Gate** | Pending Review |
| 16 | Vendor caching rights (24h Redis & client caches) | **P0** | Does caching vendor autocomplete suggestions up to 24h in Redis and ephemeral client caches violate Google/Barikoi terms restricting caching or storing of map data? [UNVERIFIED] | Counsel | **Pre-Shadow Gate** | Pending Review |
| 17 | Driver GPS consent & vehicle telemetry | **P0** | Are driver onboarding agreements and contractor terms sufficient under Bangladeshi law to consent to GPS telemetry for traffic speed models and dropoff clusters? [UNVERIFIED] | Counsel / Ops | **Pre-Shadow Gate** | Pending Review |

## Counsel packet checklist (documents to assemble)

- [ ] 1. Current commercial Barikoi & Google contracts, rate sheets, and amendments.
- [ ] 2. dpMaps system architecture summary.
- [ ] 3. End-to-end data flow diagram (memory isolation + transactional separation).
- [ ] 4. 4-Tier geospatial data retention policy table (Stage 002 §11.1 in plan; concept paper §11).
- [ ] 5. Clean-Room Contributor Agreement and Merchant Onboarding Warranty text.
- [ ] 6. Location takedown & privacy policy.

## Changelog

| Date (UTC) | Change |
|---|---|
| 2026-10-23 | Initial packet created from Stage 002 Rev 2.2 §10. All 17 items pending counsel review. |
