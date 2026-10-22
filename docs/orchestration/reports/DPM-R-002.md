# STAGE REPORT — AUDIT & PATCH BATCH 2 (Stages 008, 009, 011)

**Report ID:** DPM-R-002
**Date:** 2026-10-22
**Author:** Lead Planning & Systems Architecture Agent
**Scope:** Audit + complete Revision 2.1 replacement patches for Stages 008, 009, 011; Stage 003 Rev 2.4 additive adoption
**Status:** Patch applied and statically verified
**Baseline:** Concept paper RIDE-CP-2026-GEO-01 Rev 7.3; `AGENTS.md`; Stage 003 Rev 2.3 (schema of record); Stages 004/005 Rev 2.1

> **Provenance note:** the batch-2 audit plan first lived at `.kilo/plans/1792662284216-stage-008-009-011-audit-patch.md` (ephemeral agent state) and did not persist. By then the patch content was already applied to the target files in `docs/plans/`. This report is the durable deliverable (Parts A–G per the work order) and records the applied state. Parts C–E of the work order are applied **in full at the target paths** (headers verified at Revision 2.1); this report certifies them rather than duplicating 1,250 lines.

---

## Part A — Audit Findings

### A.1 Stage 008 (pre-patch Rev 2.0)

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| F-008-1 | **Critical (isolation)** | Single physical index `dpmaps_places` co-indexed proprietary and ODbL documents via a union feed `dpmaps.v_search_feed` — violating Hard Rule 1 / Invariant 4. `v_search_feed` was also a phantom object (undefined in Stage 003). | §2.1, §3 vs Stage 003 |
| F-008-2 | **Major (launch contract)** | Mixed autocomplete only in the `shadow` branch; badges wrong ("Ride Verified"); dedupe vendor-only and ambiguously worded. | §4, §4.1 |
| F-008-3 | **Major (fallback rule)** | `primary` mode supplemented vendor on `localHits.length < 4`; must fall back strictly on ZERO local results. | §4.1 |
| F-008-4 | **Major (contract)** | No destination handoff contract for tapped vendor suggestions (`dest_session:<session_token>`, 15 min TTL, atomic `GETDEL` required). | §4 |
| F-008-5 | **Major (ranking)** | Ranking = `_geo` + `confidence_score` only; no query-cluster popularity / vote weights; no bilingual prefix strategy. | §2.1, §4.1 |
| F-008-6 | **Major (schema)** | `logSearchTelemetry` INSERTed `typed_query` into `search_eval_events` (column lives in Tier A `raw_search_events`), with `selected_source` values violating the CHECK `('dpmaps','osm','vendor','history')`. | §4.1 vs Stage 003 §4.7 |
| F-008-7 | Minor | Unlabeled figures (50 ms, sub-10 ms, ~52k docs, QPS tiers) — `[ESTIMATE]`/`[UNVERIFIED]` required. | §1, §2 |
| F-008-8 | Minor | Index names diverged across plans (`dpmaps_places` vs `places` in 011). | vs 011 |

### A.2 Stage 009 (pre-patch Rev 2.0)

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| F-009-1 | **Major (identity residue)** | Worker minted cell-derived display names (`"Learned Place <cell>"`); `superseded_by_id` (actual: `superseded_by`); `lifecycle_status 'published'/'deprecated'` (enum: `candidate/active/demoted/retired/suppressed`). | §9 vs Stage 003 §4.1–4.2 |
| F-009-2 | **Major (Gate 5 logic)** | Margin gate needed evaluation against runner-up **cells** in `dpmaps.v_active_cluster_evidence` (unfiltered). Math: on a single-cell basis Gate 5 is implied by Gate 4 ($\Delta \ge 2s_1-1 \ge 0.40$) and never binds; it binds exactly for consolidated multi-cell candidates (counterexample 44/31/25 with 75 % cluster share → margin 19 pts < 20). | §5.5 vs AGENTS.md §6 |
| F-009-3 | **Contradiction (math — work order)** | The work-order claim "$W_{\text{lower}} > 0.5$ at $p = 0.70$ when $n_{\text{eff}} \ge 23$" is **false**: $W(0.70, 23) = 0.4957$; $W(0.70, 24) = 0.49996 \le 0.5$; $W(0.70, 25) = 0.5040 > 0.5$ → correct threshold **$n_{\text{eff}} \ge 25$** (which the file's own table/TC-009-09 already stated). At $n = 23$ the share must be ≈ 0.7045. | work order vs §5.6.3 |
| F-009-4 | **Major (aggregation)** | No $k=1$ neighbor-ring handling for sprawling landmarks (airports, campuses, hospitals). | §4 |
| F-009-5 | Partial | Two-cycle rule existed but needed demote-not-delete binding (`demoted`/`retired` + `superseded_by`). | §7 |
| F-009-6 | Minor bundle | `trip_hash` salt mismatch (`order_id`/`WindowSecretKey` vs `trip_id`/`IngestionSalt`); stale "120-day" schedule (135-day); inline `EXP()` vs `calculate_decayed_weight`; anti-collusion denominator wrong; missing per-rider cluster caps (1/week, ≤ 3/90 d); phantom objects; anisotropic DBSCAN eps; "Bloom filter" wording; table rows 0.604/0.573 → 0.6023/0.5603. | §1.3, §3, §5.6, §9 |

### A.3 Stage 011 (pre-patch Rev 2.0)

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| F-011-1 | **Major (rename)** | "Redis Bloom filter(s)" → Redis Set / sliding-window counter (TTL + point deletion semantics). | §1, §5 |
| F-011-2 | **Major (sybil)** | Proximity was only a +20 bonus ("searched or rode"); hard qualifier required: completed ride to destination H3 cell within 90 days before counting toward auto-hide. | §4.1, §6.2 |
| F-011-3 | **Major (SLA)** | Dual-tier SLA unreconciled to Stage 003 (`reported_at`/`applied_at`/`adjudicated_at`, `suppression_target_sla`). | §5, §7.1 |
| F-011-4 | **Major (privacy boundary)** | Convergence rule present; residential boundary needed categorical wording (named-house convergence vs permanently barred unit/personal data). | §2, §3 |
| F-011-5 | **Critical (schema)** | §5.1 `suppressions` DDL invented columns (`poi_id/entity_type/.../active/...`); schema of record is `target_type/target_value/reason/is_auto_hidden/auto_hide_reason/reported_at/suppression_target_sla/applied_at/adjudicated_at/expires_at/actor_id/audit_note`. | §5.1 vs Stage 003 §4.5 |
| F-011-6 | **Major (schema)** | `takedown_reports` phantom; `provenance_events` inserts used nonexistent columns. | §5.1, §6 |
| F-011-7 | Minor bundle | Wrong Meili index name; stale "120-day/97-day" pseudonym facts (135/90/30); invented "40 %" figure; trust points `[ESTIMATE]`; counter TTL reset on every add. | §1, §3.4, §6 |

---

## Part B — Required Structural Repairs (applied)

**008 → Rev 2.1:** dual physical indexes + dual source views, RAM-only merge (F-008-1); unified dedupe with `Verified Landmark`/`Open Directory` badges from launch (F-008-2); zero-hit fallback (F-008-3); `dest_session:*` 15-min `GETDEL` contract (F-008-4); popularity + bilingual ranking (F-008-5); selection-time telemetry conformant to Stage 003 §4.7 (F-008-6); labels + index-name unification (F-008-7/8).

**009 → Rev 2.1:** identity residue removed (provisional name = sanitized canonical query; `superseded_by`/enum conformed) (F-009-1); Gate 5 rebuilt on view cell shares with proved binding condition (F-009-2); Gate 6 with proved $n_{\text{eff}} \ge 25$ threshold + corrected table (F-009-3); $k=1$ `gridDisk` ring, zero ledger mutation (F-009-4); two-cycle demote-not-delete (F-009-5); conformance bundle (F-009-6).

**011 → Rev 2.1:** Bloom → Redis Set/sliding-window (F-011-1); traveler-qualified reporting (F-011-2); dual-tier SLA < 1 h / < 4 h on Stage 003 SLA columns (F-011-3); categorical residential boundary (F-011-4); full `suppressions`/`provenance_events` conformance + `takedown_reports` adoption (F-011-5/6); bundle fixes (F-011-7).

---

## Parts C–E — Replacement Files (applied in full at target paths)

| Part | File | Applied revision | Verified header |
|---|---|---|---|
| C | `docs/plans/008_search_engine_meilisearch_and_mixed_autocomplete.md` | **Revision 2.1** — Dual-Index MeiliSearch, Zero-Hit Vendor Fallback & Session Handoff | line 3 verified |
| D | `docs/plans/009_winner_selection_and_statistical_confidence.md` | **Revision 2.1** — UUIDv4 Identity, View-Based Gate Evaluation & Verified Wilson Thresholds | line 3 verified |
| E | `docs/plans/011_privacy_architecture_and_abuse_resistant_takedowns.md` | **Revision 2.1** — Redis-Set Suppression, Traveler-Qualified Reporting & Dual-Tier SLA | line 3 verified |

Each file contains its own Revision Changelog (§9/§13/§10) enumerating every F-item repair. Key invariants now codified: two on-disk Meili indexes merged only in RAM; `primary` fallback strictly on zero local hits; `dest_session:<session_token>` TTL 15 min atomic `GETDEL` with zero persistent vendor coordinates; Gate 6 theorem ($n_{\text{eff}} \ge 25$ at $p = 0.70$, TC-009-09b/09c boundary tests); traveler-qualified auto-hide (TC-011-08/09); Stage 003-column-only writes.

---

## Part F — Cross-Plan Reconciliation & Schema Conformance

| ID | Item | Resolution |
|---|---|---|
| X-1 | Phantom objects (`v_search_feed`, `provisional_challengers`, `query_clusters.published_poi_id`, `takedown_reports`) | Covered by Stage 003 **Rev 2.4** additive patch — **applied** (§4.10 + changelog row). |
| X-2 | Destination handoff namespace: `dest_session:*` (15 min) vs Stage 002 `vendor:resolve:*` (120 s) | Single mechanism adopted: `dest_session:<session_token>`, 15 min, `GETDEL`. Stage 002/005 must be patched at their next audit (`temp_client_id` → `session_token`; optional in-memory `approx_coords`). **Open — queued.** |
| X-3 | Meili index names | Unified to `first_party_pois` / `osm_pois` in 008 and 011 purge paths. |
| X-4 | Work-order Wilson claim ($n \ge 23$) | **Rejected**; Gate 6 encodes proved $n \ge 25$. AGENTS.md §6's "about 23" is superseded by the proof in 009 §5.6.3. |
| X-5 | Lifecycle enum / column names | Conformed (`poi_status_enum`, `superseded_by`, `provenance_event_type_enum`). |
| X-6 | Search telemetry tiers | Impressions = metrics only; selection rows → `raw_search_events` (Tier A); eval rows → `search_eval_events` (Tier B, post-trip evaluator). |
| X-7 | Key schedule / trip_hash facts | 135-day keys, `active_dedup_key`, `HMAC-SHA256(trip_id, IngestionSalt)`, 90/30-day retention. |
| X-8 | Cross-module contracts | `scrubPii` export (Stage 007); `public.orders.user_id` stub (**applied** in Rev 2.4 item 0); h3-pg vs h3-js for the traveler qualifier (implementation choice). |

**Stage 003 Rev 2.4 (applied, additive only):** §4.10 adds `public.orders.user_id` + index, `dpmaps.takedown_reports` (SLA timestamps without defaults, `traveler_qualified`), `dpmaps.provisional_challengers` (with k=1 cell-set snapshot), `query_clusters.published_poi_id`, `v_search_feed_first_party` (aggregated phonetic keys — exactly one row per POI invariant) / `v_search_feed_osm`, staged grants. Rev 2.2/2.3 content unchanged.

---

## Part G — Validation Plan & Open Items

**Static verification (executed 2026-10-22, passed):**
1. Zero `active BOOLEAN`, `superseded_by_id`, `'published'`/`'deprecated'` literals, `logSearchImpression`, live `dpmaps_places`/`index('places')` in the three applied files (grep-verified; only changelog history and explicit negations remain).
2. Required contracts present: `dest_session:<session_token>`, `traveler_qualified`, `bengali_phonetic_keys`, zero-hit rule, `gen_random_uuid()`, Wilson values 0.4957/0.49996/0.5040.
3. "Bloom filter" appears only as historical rename or "NOT a Bloom filter".
4. Rev 2.4 DDL + changelog row present in Stage 003 (grep-verified).

**Pending mechanical checks (blocked in the authoring session — shell denied):**
- G-P1: Re-run the Wilson computation (10-line Python: `z=1.96`, `p=0.70`, `n ∈ {23,24,25}` → 0.4957 / 0.49996 / 0.5040). Values were double hand-computed and cross-anchored to two reproduced table rows; re-verify before Stage 009 implementation.
- G-P2: Postgres 16 dry-run of the Rev 2.4 DDL (same discipline as Stage 003's earlier audits).

**Open items (queued):**
- Stage 002/005 `dest_session` namespace patch (X-2).
- Stage 015 reconciliation: `time_of_day_bucket`/`midday` → `tod_bucket`/`night`.
- MeiliSearch Bengali tokenization/typo tolerance `[UNVERIFIED]` — staging validation.
- H3 cell dimensions at 23.8° N `[UNVERIFIED]`; trust-score weights/burst thresholds/dedupe radius `[ESTIMATE]` — replay on real trip data (Stage 015).
- Stage audits 006, 007, 010, 012–016 remain unreviewed.

---

## Deviations / assumptions / next

1. **Work-order math claim rejected (F-009-3):** the requested proof "≥ 23 effective votes" is false; the plans encode the proved **≥ 25** threshold with the full derivation and boundary tests. Routed to DECISIONS.md as DPM-D-012.
2. **Gate 5 (F-009-2):** implemented exactly as specified (view-based cell margin) plus a proved binding-condition analysis: never binds for single-cell candidates under Gate 4; binds for consolidated multi-cell candidates (TC-009-14).
3. **Deliverable location:** the work order's plan file was ephemeral and lost; this report (`docs/orchestration/reports/DPM-R-002.md`) is the durable record. The drop-in replacement content itself lives at the three `docs/plans/` paths, applied in full.
4. **Next:** Stage 002/005 namespace patch; G-P1/G-P2 mechanical verifications; remaining stage audits (006, 007, 010, 012–016).
