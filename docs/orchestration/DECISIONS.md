# DECISIONS.md — dpMaps Decision Log

Project Key: `DPM`
Maintained by: Orchestrator
Source of truth: Decisions made by Zia (Owner) or documented in project baseline.

| Decision ID | Date | Decided by | Decision / Options | Outcome | Reason |
|---|---|---|---|---|---|
| `DPM-D-001` | 2026-10-22 | Zia | Adoption of Orchestrator v2.0 operating instructions and protocol | Approved | Standardized multi-agent coordination with strict verification and single-relay communications. |
| `DPM-D-002` | 2026-10-22 | Zia | Project key selection (`DPM`) and remote repository (`https://github.com/dannyzia/dpMap.git`) | Approved (`DPM`, `https://github.com/dannyzia/dpMap.git`) | Remote repository confirmed empty and accessible; Git initialization authorized. |
| `DPM-D-003` | 2026-10-22 | Zia | Rhizome MCP Hub activation as primary multi-agent communication channel | Approved | Initialized Rhizome project, created ISSUE-1 hub, authored Orchestrator Protocol into AGENTS.md. |
| `DPM-D-004` | 2026-10-22 | Zia | Dual-tracking protocol: Maintain file-based orchestration (ORCHESTRATOR.md) and Rhizome MCP loop in parallel | Approved | Run both systems in lockstep (briefs/ledger/decisions in docs/orchestration/ AND ISSUE-1 hub comments in Rhizome) to compare workflows before selecting a sole protocol. |
| `DPM-D-005` | 2026-10-22 | Zia | Apply Stage 003 Rev 2.0 patch brief directly via Orchestrator | Approved | Applied verified 120-day key schedule, trip_hash, weekly partitioning, read-time decay, and missing DDL to Stage 003 plan. |
| `DPM-D-006` | 2026-10-22 | Orchestrator (per Audit) | Apply Stage 003 Rev 2.1 patch brief (clean-room evaluation columns, 135d key schedule with 15d jitter slack & cold start, pg_partman 5.x 90d retention with dual-table boundary delete, v_active_cluster_evidence with Kish weights, 37-category CHECK, and dual-tier takedown SLA) | Approved | Fixed all blockers identified in scratchpad Postgres 16 verification and simulation. Plan updated to Rev 2.1. |
| `DPM-D-007` | 2026-10-22 | Orchestrator (per Audit) | Apply Stage 003 Rev 2.2 patch brief (view 5× overcount fix via `active_dedup_key` single-key join, `CALL partman.run_maintenance_proc` procedure syntax, 26 canonical categories CHECK with synonym mapping, `ledger_invalidations` 90d retention prune, `osm_pois` composite PK, immutable index on suppressions, `trip_hash` idempotency UNIQUE constraint, migration sequence & prerequisite operational table stubs) | Approved | Eliminates multi-key fan-out overcounting in evidence aggregation and resolves remaining DDL / procedure syntax defects verified against PostgreSQL 16. |
| `DPM-D-008` | 2026-10-22 | Orchestrator (per Owner) | Retain commit `75c3397` as canonical Stage 0 baseline. Authorize drafting minimal `README.md` and committing it with `docs/orchestration/reports/DPM-R-001.md` as follow-up commit without force-pushing `main` | Approved | Commit `75c3397` was already pushed to `origin/main` matching published hub orders; amending/force-pushing violates repository immutability and hygiene. |
| `DPM-D-009` | 2026-10-22 | Zia | Configure Git author identity to `dannyzia <callzr@gmail.com>` both locally and globally | Approved | Replaces previous machine identity `bibichana13102012` with official project identity `dannyzia`. |
| `DPM-D-010` | 2026-10-22 | Planning Model / Orchestrator | Apply Stage 004 Rev 2.1 patch (TOD-learned speed pipeline with `segment_speeds_tod`, multiplicative correction layer $\hat{T}=k(v,b)\cdot T_{\text{osrm}}$, relative ETA cutover gates $\le 12\%$ median / $\le 25\%$ p95, 300ms timeout, car/bike/cng profiles) | Approved | Resolves day-averaged static speed limitations, implements first-party learning, and formalizes relative ETA cutover gates. |
| `DPM-D-011` | 2026-10-22 | Planning Model / Orchestrator | Apply Stage 005 Rev 2.1 patch (Mode 0 `off`, clean-room Redis shadow payload without vendor quotes, correlation via `trip_hash`, Stage 003 §4.7 DDL alignment, 18 km/h Haversine fix, Gate 1 median & vendor-parity repair) | Approved | Enforces clean-room shadow benchmarking without vendor quote persistence and fixes schema mismatches with Stage 003 Rev 2.2. |



