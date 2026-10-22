# Stage 015: Evaluation Suites, Telemetry & Cutover Gates Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-015 (Revision 2.1 — Schema-of-Record Telemetry, Golden Suites & Reconciled Cutover Gates)
**Stage:** 15 of 16 (Evaluation, Telemetry & Gate Governance)
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§14, §14.1–14.4)
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)
**Current Status:** **NotDone**
**Primary Dependencies:** Stages 003 (Rev 2.5 schema of record), 004, 005, 008, 009, 011, 016

---

## 1. Executive Summary & Objective

Mode promotion (off → shadow → primary → sole) is governed exclusively by objective numeric gates computed from clean-room telemetry. Stage 015 delivers:

1. **Golden evaluation sets (F-015-1):** 500-query search suite (Bangla 30 % / Banglish 50 % / English 20 %) and 200 held-out OD pairs stratified by corridor, topology stress, TOD buckets, **and season (dry vs monsoon)**.
2. **Telemetry conformance (F-015-2):** evaluators write **only** the Stage 003 §4.7 columns — relative error percentages, zero vendor quotes, zero `trip_id`/`order_id`, typed text only in Tier A `raw_search_events`.
3. **Reconciled cutover gates (F-015-3):** the two-gate ladder of TOC Phase 2 + concept paper §14.3 (92 %/3 wks at primary; 96 %/4 wks + deflection + rehearsal at sole), expressed as an operational Gate 0/1/2 checklist with 1A/1B routing/search split.

> [!IMPORTANT]
> **Gate placement deviation (documented):** the batch-4 work order placed "≥ 96 % / 4 weeks + deflection > 85 %" at search-primary. TOC Phase 2, concept paper §14.3, and Rev 2.0 of this file all place them at **sole**. The three-source consensus is authoritative; the stricter reading is available as an admin-configurable override in `system_config` (`gate_search_primary_min_success_pct`).

---

## 2. Telemetry Lifecycle (conformant — F-015-2)

```
PHASE A (pre-trip): Stage 005 shadowQuoter — shadow_quote:<trip_hash> (24 h TTL,
  first-party OSRM quote + geometry only). Stage 005 owns this contract; there is no
  separate "routing:shadow:{order_id}" store.
PHASE B (post-trip): Stage 005 groundTruthCalibrator (role ride_dispatch) computes
  percentages and inserts into dpmaps.routing_eval_events / dpmaps.search_eval_events
  using the EXACT Stage 003 §4.7 columns below.
```

### 2.1 Schema of record (Stage 003 §4.7 — do not re-declare)

`dpmaps.routing_eval_events(id, vehicle_type, tod_bucket, osrm_duration_s, osrm_distance_m, actual_driven_duration_s, actual_driven_distance_m, vendor_duration_error_pct, vendor_distance_error_pct, duration_error_pct, distance_error_pct, corridor_overlap_pct, route_deviation_flag, created_at)` — `tod_bucket ∈ ('morning_peak','evening_peak','off_peak','night')`.

`dpmaps.search_eval_events(id, search_success, exit_distance_delta_m, search_radius_m, vendor_suggestion_selected, query_cluster_id, selected_source ∈ ('dpmaps','osm','vendor','history'), selected_place_id, latency_ms, result_count, created_at)` + CHECK `chk_search_eval_vendor_null`.

**Column crosswalk (old draft → schema of record):** `time_of_day_bucket` → **`tod_bucket`** (+`night`, not `midday`); `order_id` → **dropped** (no trip correlation in eval tables); `origin_geom/destination_geom/driver_exit_geom` → **dropped** (geometry stays operational); `osrm_quoted_meters/seconds` → `osrm_distance_m/osrm_duration_s`; `osrm_distance_error_pct/osrm_duration_error_pct` → `distance_error_pct/duration_error_pct`; `vendor_relative_error_pct` → `vendor_duration_error_pct` + `vendor_distance_error_pct` (percentages only); `driver_deviation_detected` → `route_deviation_flag`; `pre_autocomplete_query` → **Tier A `raw_search_events.typed_query` only** (never Tier B); `selected_source ('dpmaps_local','vendor_fallback')` → `('dpmaps','osm','vendor','history')`; `selected_poi_id` → `selected_place_id`; `radius_threshold_meters` → `search_radius_m`; `exit_distance_delta_meters` → `exit_distance_delta_m`; `in_trip_dest_changed` → folded into `search_success` computation.

**Relative errors only (never flat minutes):**
$$e_T = \frac{|T_{pred}-T_{actual}|}{T_{actual}}\times 100\%,\qquad e_D = \frac{|D_{pred}-D_{actual}|}{D_{actual}}\times 100\%$$

---

## 3. Golden Suites (F-015-1)

**Search (500):** scripts Banglish 50 % / Bengali 30 % / English 20 %; lengths short-prefix 25 % / medium 50 % / compound 25 %; taxonomy transit 20 %, residential 25 %, medical 15 %, commercial 25 %, gates 15 % (Rev 2.0 §3.1 retained). Metrics: Top-1 accuracy ≥ 92 % (Gate 1) / ≥ 96 % (Gate 2); MRR ≥ 0.88 / ≥ 0.94 `[ESTIMATE]`; p95 ≤ 15 ms `[ESTIMATE]`.

**Routing (200 OD pairs):** corridors + topology stress (river crossings, flyovers, Old Dhaka alleys — bike vs car profiles) + TOD buckets (02:00, 08:30, 18:00 windows) **+ season stratification (F-015-4):** each pair replayed in dry and monsoon windows (waterlogging closures `[UNVERIFIED frequency]`); ≥ 60 pairs per TOD window `[ESTIMATE]`.

---

## 4. Numeric Cutover Gates (F-015-3 — reconciled)

| | **Gate 1A: routing → primary** | **Gate 1B: search → primary** | **Gate 2: → sole** |
|---|---|---|---|
| Distance | median $e_D \le 3.0\%$ vs GPS, 3 wks | — | median $\le 2.5\%$, 4 wks |
| ETA | median $e_T \le 12\%$ (p95 $\le 25\%$), vendor parity, 3 wks | — | $\le 10\%$ (p95 $\le 20\%$), 4 wks |
| Corridor | $\ge 85\%$, 3 wks | — | $\ge 92\%$, 4 wks |
| Search | — | Top-1 $\ge 92\%$, MRR $\ge 0.88$, 3 wks | Top-1 $\ge 96\%$, MRR $\ge 0.94$, 4 wks |
| Deflection | — | — | $> 85\%$ queries resolved locally (TOC) |
| Latency | OSRM p95 ≤ 8 ms; Meili ≤ 15 ms | same | same |
| Legal | Stage 002 items signed | same | same |
| Rehearsal | — | — | **24 h vendor-off drill: zero vendor HTTP, dispatch ≥ 99.5 % `[ESTIMATE]`, wrong-location cancels ≤ 1.5 % `[ESTIMATE]`, zero sev-1** |
| Stability | zero sev-1 regressions | same | same |

All thresholds admin-configurable in `system_config` (defaults above). Medians/percentiles computed weekly per `vehicle_type`/`tod_bucket` from the schema-of-record tables (Stage 009-style `percentile_disc`).

---

## 5. 24-Hour Vendor-Off Rehearsal (Gate 2 final step)

T-7 notice + staging dry-run → T-0 both modes → `sole`, wrapper breaker forced OPEN → 24 h evaluation (§4 requirements) → pass ⇒ Gate 2 certified; any breach ⇒ auto-revert to `primary` (Runbook C, Stage 016).

---

## 6. Benchmark Runner & Scorecard

`workers/benchmarkRunner.ts` executes golden suites nightly against stage-tagged endpoints, computes §4 statistics from `routing_eval_events`/`search_eval_events`, and emits a versioned scorecard (release-manifest hash chaining per Stage 009 §11). No vendor quotes appear in scorecards (percentages only).

---

## 7. Tests

| TC | Scenario | Expected |
|---|---|:---:|
| TC-015-01 | golden search eval | Top-1 ≥ 92 % (Gate 1B) |
| **TC-015-02** | eval INSERT column list | exactly Stage 003 §4.7 columns; zero `order_id`/`pre_autocomplete_query` |
| **TC-015-03** | `tod_bucket` values | 4-value enum incl. `night`; never `midday` |
| TC-015-04 | relative errors | no flat-minute thresholds anywhere |
| TC-015-05 | rehearsal abort on 1 vendor HTTP call | auto-revert to primary (Runbook C) |
| **TC-015-06** | monsoon window replay | suite executes with season tag |

---

## 8. Deliverables

- [ ] Golden sets version-controlled (500/200) with dry/monsoon stratification (F-015-1/4).
- [ ] Evaluators conformant to Stage 003 §4.7 via crosswalk; typed text only in Tier A (F-015-2).
- [ ] Phase A uses Stage 005 `shadow_quote:<trip_hash>` (F-015-2).
- [ ] Gate ladder (1A/1B/2) implemented with admin-configurable thresholds; deviation documented (F-015-3).
- [ ] Rehearsal-day automation + auto-revert wired to Stage 016 Runbook C.
- [ ] Weekly gate scorecards with vendor-parity gauges (Stage 005 metrics).

---

## 9. Revision Changelog

| Revision | Date | Author / Context | Summary |
|---|---|---|---|
| Rev 2.0 | 2026-10-22 | Orchestrator (audited baseline) | Golden suites, telemetry DDL, gate table, rehearsal protocol, runner. |
| Rev 2.1 | 2026-10-22 | Lead Planning & Systems Architecture (batch-4 audit) | **Schema-of-Record Conformance & Gate Reconciliation:** 1. Invented DDLs replaced by Stage 003 §4.7 + full column crosswalk (`tod_bucket`/`night`, percentages-only, `selected_source` enum, no raw text in Tier B) — closes batch-1 X-1 (F-015-1). 2. Phase A unified with Stage 005 `shadow_quote:<trip_hash>` (F-015-2). 3. Gate ladder kept at the TOC/concept-paper consensus with the work-order deviation documented and thresholds admin-configurable (F-015-3). 4. Monsoon stratification + labels (F-015-4). |
