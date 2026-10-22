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
| `DPM-F-003` | Stage 003: Storage Schemas & 90-Day Evidence Ledger | 1 | Reviewed (Rev 2.4 applied) | `NOT_BUILT` | 135-day key schedule, cold-start mode, clean-room eval columns, pg_partman 5.x 90d retention, Kish weights view with active_dedup_key join, 26 canonical categories CHECK, additive Stage 004 TOD tables in §4.9, batch-2 objects in §4.10 (takedown_reports, provisional_challengers, query_clusters.published_poi_id, dual search feed views, orders.user_id stub) |
| `DPM-F-004` | Stage 004: OSRM Routing Engine & Dynamic Traffic | 1 | Reviewed (Rev 2.1 applied) | `NOT_BUILT` | TOD-learned speed pipeline, multiplicative correction layer k(v,b), relative ETA gates (never flat minutes), 300ms timeout, car/bike/cng profiles |
| `DPM-F-005` | Stage 005: Dispatch Router & Shadow Benchmarking | 1 | Reviewed (Rev 2.1 applied) | `NOT_BUILT` | Four-mode toggle (mode 0 off), clean-room Redis shadow payload, trip_hash correlation, Stage 003 §4.7 DDL alignment, 18 km/h Haversine fix |
| `DPM-F-006` | Stage 006: Vector Tiles, PMTiles & Bengali Glyphs | 0 & 3 | Unreviewed | `NOT_BUILT` | Planetiler, R2, Noto Sans Bengali |
| `DPM-F-007` | Stage 007: Text Normalization & Alias Clustering | 1 | Unreviewed | `NOT_BUILT` | Unicode folding, direction locking, phonetics |
| `DPM-F-008` | Stage 008: MeiliSearch Engine & Mixed Autocomplete | 1 | Reviewed (Rev 2.1 applied) | `NOT_BUILT` | Dual physical indexes `first_party_pois`/`osm_pois` (RAM-only merge), zero-hit vendor fallback, mixed badges from launch, `dest_session:*` 15-min GETDEL handoff, popularity/bilingual ranking, selection-time telemetry |
| `DPM-F-009` | Stage 009: Winner Selection & Wilson Confidence | 2 | Reviewed (Rev 2.1 applied) | `NOT_BUILT` | UUIDv4 identity (no cell-derived names), Gate 5 on v_active_cluster_evidence cell shares, proved Wilson threshold n_eff >= 25 at p=0.70 (work-order ">= 23" rejected), k=1 ring aggregation, two-cycle demote-not-delete |
| `DPM-F-010` | Stage 010: Naming Engine & Post-Trip Verification | 2 | Unreviewed | `NOT_BUILT` | 4-tier naming hierarchy, bilingual names |
| `DPM-F-011` | Stage 011: Privacy Architecture & Takedowns | 1 | Reviewed (Rev 2.1 applied) | `NOT_BUILT` | Redis Set / sliding-window suppression (no Bloom), traveler-qualified reporting (ride to cell in 90 d), dual-tier SLA <1h/<4h on Stage 003 columns, categorical residential privacy boundary |
| `DPM-F-012` | Stage 012: Anti-Manipulation & Sybil Resistance | 1 | Unreviewed | `NOT_BUILT` | Burst suppression, collusion dampening |
| `DPM-F-013` | Stage 013: Geocoding, Address Parsing & Snapping | 2–3 | Unreviewed | `NOT_BUILT` | Reverse geocoder, perimeter gate snapping |
| `DPM-F-014` | Stage 014: Saved Places Migration & Decoupling | 1–2 | Unreviewed | `NOT_BUILT` | Decouple vendor place IDs |
| `DPM-F-015` | Stage 015: Evaluation Suites & Cutover Gates | 1–4 | Unreviewed | `NOT_BUILT` | Golden test sets, numeric cutover gates |
| `DPM-F-016` | Stage 016: Infrastructure, HA & SRE Runbooks | 0–4 | Unreviewed | `NOT_BUILT` | Sizing model, standby failover, runbooks |

---

## 2. Task Ledger

| Task ID | Feature | Title | Agent | Depends on | Scope files | Status | Evidence | Updated |
|---|---|---|---|---|---|---|---|---|
| `DPM-T-001` | `DPM-F-000` | Initialize Git repository and standard `.gitignore` | `A-OPS-1` | none | `.gitignore` | `DONE` | Baseline commit `75c3397` pushed to `origin/main`; report `DPM-R-001.md` | 2026-10-22 |
| `DPM-T-002` | `DPM-F-003` | Apply Rev 2.0 patch brief to Stage 003 storage plan | `Orchestrator` | none | `docs/plans/003_storage_schema_and_continuous_evidence_ledger.md` | `DONE` | Rev 2.0 patched with changelog | 2026-10-22 |
| `DPM-T-003` | `DPM-F-003` | Independent audit of patched Stage 003 storage plan | `A-AUD-1` | `DPM-T-002` | `docs/plans/003_storage_schema_and_continuous_evidence_ledger.md` | `DONE` | Audit completed against scratch Postgres 16; findings returned | 2026-10-22 |
| `DPM-T-004` | `DPM-F-003` | Apply Rev 2.1 patch brief (clean-room eval columns, 135d keys & cold start, pg_partman 5.x 90d retention, Kish weights view, 37-category CHECK) | `Orchestrator` | `DPM-T-003` | `docs/plans/003_storage_schema_and_continuous_evidence_ledger.md` | `DONE` | Rev 2.1 patched with changelog | 2026-10-22 |
| `DPM-T-005` | `DPM-F-003` | Apply Rev 2.2 patch brief (view 5× overcount fix via active_dedup_key join, CALL partman.run_maintenance_proc syntax, 26 canonical categories CHECK, ledger_invalidations 90d prune, composite PK on osm_pois, trip_hash idempotency UNIQUE constraint) | `Orchestrator` | `DPM-T-004` | `docs/plans/003_storage_schema_and_continuous_evidence_ledger.md` | `DONE` | Rev 2.2 patched with changelog | 2026-10-22 |
| `DPM-T-006` | `DPM-F-004` | Audit and apply Rev 2.1 patch to Stage 004 (OSRM TOD-learned ETA engine & relative gates) | `Planning Model` | none | `docs/plans/004_osrm_routing_engine_and_dynamic_traffic.md` | `DONE` | Rev 2.1 patched with changelog | 2026-10-22 |
| `DPM-T-007` | `DPM-F-005` | Audit and apply Rev 2.1 patch to Stage 005 (Dispatch waterfall, mode 0 off, clean-room shadow benchmarking) | `Planning Model` | none | `docs/plans/005_dispatch_router_and_shadow_benchmarking.md` | `DONE` | Rev 2.1 patched with changelog | 2026-10-22 |
| `DPM-T-008` | `DPM-F-003` | Apply Stage 003 Rev 2.3 additive patch (adopt Stage 004 TOD speed tables §4.9 and vendor_provider in ride_vendor_data) | `Orchestrator` | `DPM-T-005, DPM-T-006, DPM-T-007` | `docs/plans/003_storage_schema_and_continuous_evidence_ledger.md` | `DONE` | Rev 2.3 patched with changelog | 2026-10-22 |
| `DPM-T-009` | `DPM-F-008, DPM-F-009, DPM-F-011` | Audit and apply Rev 2.1 patches to Stages 008/009/011 (batch 2: dual-index search, winner-selection gate repairs, privacy/takedown repairs) | `Planning Model` | `DPM-T-008` | `docs/plans/008_*.md`, `docs/plans/009_*.md`, `docs/plans/011_*.md` | `DONE` | Rev 2.1 applied to all three; static verification passed; report `DPM-R-002.md` | 2026-10-22 |
| `DPM-T-010` | `DPM-F-003` | Apply Stage 003 Rev 2.4 additive patch (orders.user_id stub, takedown_reports, provisional_challengers, query_clusters.published_poi_id, dual search feed views) | `Orchestrator` | `DPM-T-009` | `docs/plans/003_storage_schema_and_continuous_evidence_ledger.md` | `DONE` | Rev 2.4 §4.10 + changelog; Postgres dry-run pending (`DPM-R-002.md` G-P2) | 2026-10-22 |




