# LEDGER.md — dpMaps Feature & Task Ledger

Project Key: `DPM`
Maintained by: Orchestrator
Source of truth: `AGENTS.md`, `docs/plans/000_TOC.md`, `docs/plans/independent-mapping-engine-concept-paper.md` (Rev 7.3)

---

## 1. Feature Registry

| Feature ID | Stage / Name | Phase | Review / Plan State | Feature Status | Notes |
|---|---|:---:|:---:|:---:|---|
| `DPM-F-000` | Stage 000: Master TOC & Stage Registry | All | Reviewed (Done) | `BUILT` | Audited Baseline v2.0.0 |
| `DPM-F-001` | Stage 001: Phase 0 Landmark Seeding & Ingestion | 0 | Reviewed (Rev 2.2 applied) | `PARTIALLY_BUILT` | Ingestion script verified on 49,881 rows; Pin Tool v2 pending |
| `DPM-F-002` | Stage 002: Provenance Firewall & Legal Compliance | 0–1 | Rev 2.2 patch applied, unverified | `NOT_BUILT` | Legal gate items 3, 7, 14, 15, 16, 17 open |
| `DPM-F-003` | Stage 003: Storage Schemas & 90-Day Evidence Ledger | 1 | Reviewed; Rev 2.0 patch brief pending | `NOT_BUILT` | 120-day key lifecycle, drop trip_id, missing tables |
| `DPM-F-004` | Stage 004: OSRM Routing Engine & Dynamic Traffic | 1 | Unreviewed | `NOT_BUILT` | Docker & Geofabrik 339MB PBF |
| `DPM-F-005` | Stage 005: Dispatch Router & Shadow Benchmarking | 1 | First pass only | `NOT_BUILT` | Mode 0 (off), primary fallback, session cache |
| `DPM-F-006` | Stage 006: Vector Tiles, PMTiles & Bengali Glyphs | 0 & 3 | Unreviewed | `NOT_BUILT` | Planetiler, R2, Noto Sans Bengali |
| `DPM-F-007` | Stage 007: Text Normalization & Alias Clustering | 1 | Unreviewed | `NOT_BUILT` | Unicode folding, direction locking, phonetics |
| `DPM-F-008` | Stage 008: MeiliSearch Engine & Mixed Autocomplete | 1 | First pass only | `NOT_BUILT` | Separate OSM & first-party indexes |
| `DPM-F-009` | Stage 009: Winner Selection & Wilson Confidence | 2 | First pass only | `NOT_BUILT` | Fix random UUIDs, fix gate 5 margin logic |
| `DPM-F-010` | Stage 010: Naming Engine & Post-Trip Verification | 2 | Unreviewed | `NOT_BUILT` | 4-tier naming hierarchy, bilingual names |
| `DPM-F-011` | Stage 011: Privacy Architecture & Takedowns | 1 | First pass only | `NOT_BUILT` | Rename Bloom filter to Redis set, rider traveled check |
| `DPM-F-012` | Stage 012: Anti-Manipulation & Sybil Resistance | 1 | Unreviewed | `NOT_BUILT` | Burst suppression, collusion dampening |
| `DPM-F-013` | Stage 013: Geocoding, Address Parsing & Snapping | 2–3 | Unreviewed | `NOT_BUILT` | Reverse geocoder, perimeter gate snapping |
| `DPM-F-014` | Stage 014: Saved Places Migration & Decoupling | 1–2 | Unreviewed | `NOT_BUILT` | Decouple vendor place IDs |
| `DPM-F-015` | Stage 015: Evaluation Suites & Cutover Gates | 1–4 | Unreviewed | `NOT_BUILT` | Golden test sets, numeric cutover gates |
| `DPM-F-016` | Stage 016: Infrastructure, HA & SRE Runbooks | 0–4 | Unreviewed | `NOT_BUILT` | Sizing model, standby failover, runbooks |

---

## 2. Task Ledger

| Task ID | Feature | Title | Agent | Depends on | Scope files | Status | Evidence | Updated |
|---|---|---|---|---|---|---|---|---|
| `DPM-T-001` | `DPM-F-000` | Initialize Git repository and standard `.gitignore` | `A-OPS-1` | none | `.gitignore` | `IN_PROGRESS` | Brief issued to A-OPS-1 | 2026-10-22 |
| `DPM-T-002` | `DPM-F-003` | Apply Rev 2.0 patch brief to Stage 003 storage plan | `A-PLN-1` | none | `docs/plans/003_storage_schema_and_continuous_evidence_ledger.md` | `QUEUED` | Pending dispatch | 2026-10-22 |
| `DPM-T-003` | `DPM-F-003` | Independent audit of patched Stage 003 storage plan | `A-AUD-1` | `DPM-T-002` | `docs/plans/003_storage_schema_and_continuous_evidence_ledger.md` | `QUEUED` | Awaits T-002 completion | 2026-10-22 |
