# STAGE REPORT — AUDIT & PATCH BATCH 3 (Stages 006, 007, 010)

**Report ID:** DPM-R-003
**Date:** 2026-10-22
**Author:** Lead Planning & Systems Architecture Agent
**Scope:** Audit + complete Revision 2.1 replacement patches for Stages 006, 007, 010; Stage 003 Rev 2.5 additive adoption
**Status:** Patch content prepared; application pending (batch-3 plan Part C–E)

**Applied files:** `docs/plans/006_vector_tiles_pmtiles_and_bengali_glyphs.md`, `docs/plans/007_text_normalization_and_alias_clustering.md`, `docs/plans/010_naming_engine_and_post_trip_verification.md` (each at `Revision 2.1`), plus additive Stage 003 Rev 2.5 (§ post-trip staging + bilingual gate).

**Findings (summary):** F-006-1…7 — Hard Rule 7 raster policy absent, unlabeled Planetiler sizing, missing R2 purge tags (Stage 011 Tier D dependency), fontstack mismatch, no first-party overlay (Invariant 4 gap), missing ODbL attribution element, invented pricing/absolute claims. F-007-1…6 — `scrubPii` contract missing despite being imported cross-stage (critical), elongation semantics mismatch, set-based cluster IDs falsely merge permuted entities (`gate 1 road 2` vs `road 1 gate 2`), phonetic bounds, promotion SQL references nonexistent `pseudonym_hash` column. F-010-1…6 — bilingual OR/AND contradiction, post-trip staging phantom + non-cycle uniqueness, missing `poi_versions` lineage, duplicate DDL drift, delimited-phone gap, unindexed-cluster label dead-end.

**Deviations:** (1) "Geopolitical Filter / Riverine Intelligence" language from early working notes verified absent from the repo and deliberately not invented. (2) Work-order F-006-2/3/4 and F-007-2/4 and F-010-2/3/4 repairs are encoded exactly as specified; set-based cluster identity replaced by ordered entity signatures as the minimal fix for F-007-2's no-collapse requirement. (3) Thresholds labeled `[ESTIMATE]`; Planetiler figures `[ESTIMATE]` per AGENTS.md §10 UNVERIFIED status. (4) Refinement decisions recorded: phonetic name-token sorting (order-insensitive name tokens, user decision 2026-10-22); `scrubPii` drops phones outright (no shared marker token) and strips separators only inside phone-like digit runs; Stage 009 mints `candidate` / Stage 010 flips `active` (bilingual gate ownership, X-9).

**Open:** G-P1 Postgres dry-run of Rev 2.5; G-P2 normalizer harness; Legal Items 12/13; Stage 013/015 coordination; audits 012–016 queued.
