# SRE Runbooks A–D — dpMaps Production Operations

Parent: Stage 016 (Rev 2.1). Machine-checkable thresholds live in
`services/sreRunbooks.ts` + `services/infrastructureSizing.ts` — this file
is the human procedure. All figures `[ESTIMATE]` until Phase 1 soak replaces
them with measurements.

## Runbook A — OSRM crash / timeout failover

- **Alert:** `osrm_up` probe fails or p95 > 300 ms budget for 2 min.
- **Cutover:** NGINX marks primary down (passive failover, < 300 ms);
  standby serves all 3 profiles (car:5001, bike:5002, cng:5003).
- **Both down:** Stage 005 waterfall absorbs (Barikoi → Google-capped → Haversine × 1.3).
- **Recovery:** restart primary, `osrm-datastore` reload, health check,
  fail back (or keep standby primary until Runbook D).
- **MTTR target:** < 5 min. Post-incident: capture graph version + metrics.

## Runbook B — Emergency landmark takedown (Tier 1 < 1 h SLA)

1. Trigger: Stage 011 auto-hide (3 qualified travelers) or admin/counsel order.
2. Redis Set `dpmaps:suppression:active_place_ids` sAdd (< 5 ms).
3. Meili purge BOTH `first_party_pois` + `osm_pois`.
4. `dpmaps.suppressions` row (§4.5 columns; `reported_at` SLA clock;
   `suppression_target_sla='1_hour'`).
5. Cloudflare Purge by Tag `fp-poi` (< 30 s) + client-side filter.
6. `public_pois.lifecycle_status='suppressed'` + `provenance_events('takedown')`.
7. Verify `applied_at − reported_at < 1 h`; Tier 2 manual review < 4 h.

## Runbook C — Immediate mode rollback

1. Trigger: gate breach, sev-1, or rehearsal abort (Stage 015 §5).
2. `system_config`: `routing_provider_mode` / `search_provider_mode`
   → `1: shadow` (sub-second hot reload); vendor serves live again.
3. Vendor-related/legal incident → `0: off` (bypass dpMaps entirely).
4. Verify: zero OSRM calls in `off`; shadow benchmarking resumes in `shadow`.
5. **The Redis suppression set is NEVER cleared by rollback.**

## Runbook D — Geofabrik graph re-ingestion + MLD rebuild

1. Fetch `bangladesh-latest.osm.pbf`; verify size (~339 MB baseline).
2. `osrm-extract / partition / customize` per profile on the build node.
3. Blue/Green swap with synthetic probe; zero dropped queries.
4. Optional Planetiler rebuild + versioned pointer swap.
5. Stage 007 geometry audit subset + Stage 015 routing golden replay.
6. Record build hash in the release manifest (Stage 009 §11).
7. Cadence: monthly default, configurable; Stage 004 alerts at 2× interval.
