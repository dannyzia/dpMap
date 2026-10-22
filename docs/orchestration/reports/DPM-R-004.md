# STAGE REPORT — AUDIT & PATCH BATCH 4 (FINAL) (Stages 012, 013, 014, 015, 016)

**Report ID:** DPM-R-004
**Date:** 2026-10-22
**Author:** Lead Planning & Systems Architecture Agent
**Scope:** Audit + complete Revision 2.1 replacement patches for Stages 012–016; Stage 003 Rev 2.6 additive adoption
**Status:** Patch content prepared; application pending (batch-4 plan Parts C–G)

**Applied files:** `docs/plans/012_…`, `013_…`, `014_…`, `015_…`, `016_…` (each `Revision 2.1`), plus additive Stage 003 Rev 2.6 (invalidation CHECK widening, `osm_road_names`, saved-place sovereign identity).

**Findings (summary):** 012 — work-order `invalidation_type_enum` does not exist (schema uses `reason` CHECK); purge SQL mutated the immutable ledger (rewritten to `ledger_invalidations` side-table writes); pair caps conflicted three ways (unified, layered); 5×/48 h burst quarantine added. 013 — `published` enum bug, degree-based radii, missing Tier 2 roads + vendor fallback contract, geohash stub, `pickup_gate` taxonomy mismatch, Class-1 delivery-note boundary. 014 — absolute legal overclaims (Hard Rule 5), `user_confirmed` mis-set on machine resolution, missing `> 30 m` confirmation trigger, nonconformant orders columns. 015 — invented eval DDLs (`time_of_day_bucket`/`midday`, `pre_autocomplete_query` in Tier B) replaced by Stage 003 §4.7 crosswalk (closes batch-1 X-1); Phase A unified with Stage 005; gate ladder reconciled. 016 — Phase-1 OSRM sizing violated Stage 004 RSS physics (raised to 32 GB), missing network rows, missing Meili/PG replication, Runbooks A–D incomplete.

**Deviations:** (1) Work-order F-012-1 enum names corrected via crosswalk to the schema of record (`'driver_bias'` added in Rev 2.6). (2) Work-order F-015-3 gate renumbering rejected in favor of the TOC + concept-paper + file consensus (92 % primary / 96 % + deflection + rehearsal sole); the stricter reading is available as an admin-configurable override. (3) Work-order `pickup_gate` mapped to `perimeter_gate`/`entrance`. (4) All unverified figures labeled `[ESTIMATE]`/`[UNVERIFIED]` per AGENTS.md §10.

**Refinement decisions (pass 2):** burst detector unit-matched (48-h vs 48-h baseline + absolute floor 10 votes); landmark pair-cap defined as publication-time recount SQL (unenforceable at ingestion); reverse-geocode zero-hit radius semantics (100 m discovery vs tier display radii); gate vehicle permissions in `provenance` JSONB; Home/Work multi-cluster disambiguation via confirmation card (never silent time-of-day inference).

**Open:** G-P1/G-P2 mechanical checks; Legal Items 3/15/16; tooling pins (Meili replication, failover); cross-plan patches (002/005 `dest_session`, 009 §9 comment). Full-plan sign-off readiness: all 16 stages now audited.
