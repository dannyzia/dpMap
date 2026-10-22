# Stage 016: Infrastructure Deployment, High Availability & SRE Runbooks Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-016 (Revision 2.1 — Physics-Matched Sizing, HA Failover & Runbooks A–D)
**Stage:** 16 of 16 (Infrastructure, SRE & Operational Runbooks)
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§19–21)
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)
**Current Status:** **NotDone**
**Primary Dependencies:** Stages 003–011 (deployed services), 004 (OSRM physics), 006 (R2/CDN), 011 (takedown SLA), 015 (gates)

---

## 1. Executive Summary & Objective

Sovereignty requires self-hosted, deterministic, highly available infrastructure. Stage 016 delivers the production topology, physics-matched sizing, automated failover, and the SRE runbooks (A–D):

1. **Capacity model** by scale tier with RAM/NVMe/CPU/**network** rows (F-016-1), sized to Stage 004's measured-graph expectations.
2. **HA topology (F-016-2):** OSRM Active/Hot-Standby (3-profile), MeiliSearch replica, PostgreSQL streaming replication, Redis HA.
3. **Runbooks A–D (F-016-3):** crash failover, emergency takedown (< 1 h SLA), mode rollback, Geofabrik graph re-ingestion.

> [!NOTE]
> All figures are **`[ESTIMATE]`** — AGENTS.md §10 marks OSRM RAM/throughput/latency on the real graph **UNVERIFIED** until measured.

---

## 2. Capacity & Sizing Matrix (F-016-1)

Per Stage 004 §2.1: each OSRM profile ≈ 2.4–2.6 GB RSS `[ESTIMATE]`; **3 profiles ≈ 7.2 GB**; **Blue/Green reload ≈ 14.4 GB**. Nodes hosting all three profiles need ≥ 16 GB RAM in every tier.

| Node | Dev/CI | Phase 1 (500–2k rides/d) | Phase 2 (5–10k) | Scale (10–25k) |
|---|---|---|---|---|
| **OSRM Primary (3 profiles)** | 4 vCPU / 16 GB / 100 GB NVMe | **8 vCPU / 32 GB** / 200 GB NVMe `[ESTIMATE]` | 16 vCPU / 32 GB / 200 GB | 16 vCPU / 32 GB / 200 GB |
| **OSRM Hot-Standby** | 2 vCPU / 8 GB | 4 vCPU / 16 GB | 8 vCPU / 32 GB | 8 vCPU / 32 GB |
| **MeiliSearch (+ replica from Phase 2)** | 2 vCPU / 4 GB | 2 vCPU / 8 GB / 50 GB | 4 vCPU / 8 GB ×2 | 8 vCPU / 16 GB ×2 |
| **PostgreSQL/PostGIS (primary + streaming replica from Phase 2)** | 4 vCPU / 16 GB / 100 GB | 4 vCPU / 16 GB / 250 GB | 8 vCPU / 32 GB / 500 GB ×2 | 8 vCPU / 32 GB / 1 TB ×2 |
| **Redis (HA/sentinel from Phase 2)** | 1 vCPU / 2 GB | 2 vCPU / 4 GB | 2 vCPU / 4 GB ×2 | 4 vCPU / 8 GB ×2 |
| **Network (per node)** | 1 Gbps `[ESTIMATE]` | 1 Gbps | 2 Gbps | 2 Gbps+; CDN absorbs tiles (Stage 006) |

Rationale: Phase-1 OSRM raised to 32 GB because 8–16 GB cannot hold 3 graphs + reload headroom (F-016-1). Splitting profiles across nodes is the alternative at Scale tier.

---

## 3. Topology (F-016-2)

```
                 [ Cloudflare CDN — tiles/glyphs (Stage 006) ]
[ Clients ] ──► [ LB / NGINX ] ──► OSRM PRIMARY (car:5001, bike:5002, cng:5003)
                     │        └──► OSRM HOT-STANDBY (same profiles; §6 failover)
                     ├─► MeiliSearch primary ──async replica──► MeiliSearch replica
                     ├─► PostgreSQL primary ──streaming replication──► replica (reads)
                     └─► Redis (sentinel/managed HA)
```

- **Failover semantics (F-016-2):** NGINX upstream with `max_fails` + passive health; target cutover **< 300 ms** `[ESTIMATE]` aligned to the canonical 300 ms OSRM budget (004/005); Stage 004 circuit breaker (3-strike, `/healthz` poll) is the service-level complement. On primary failure: standby promoted, `osrm-datastore` re-pointed.
- **PostgreSQL:** synchronous_commit on primary; replica serves analytics/eval reads (gate scorecards); failover manual-or-patroni `[UNVERIFIED tooling]`.
- **MeiliSearch:** async replica from Phase 2; dual indexes (`first_party_pois`/`osm_pois`) replicated together (008 isolation preserved).

---

## 4. OSRM Deployment & Hot Reload (kept from Rev 2.0 §5)

Docker Compose per-profile with `--shared-memory=yes`, `osrm-datastore` reload flow (004 §4.2), and Blue/Green fallback (004 §4.3). Reload script re-contracts only the TOD speed layer (`osrm-customize`) at bucket boundaries; full rebuilds are Runbook D.

---

## 5. Runbooks (F-016-3)

### Runbook A — OSRM crash/timeout failover (< 5 min MTTR `[ESTIMATE]`)
1. Alert: `osrm_up` probe fails or p95 > 300 ms budget for 2 min. 2. NGINX marks primary down (passive failover, < 300 ms cutover `[ESTIMATE]`); standby serves all 3 profiles. 3. If standby also fails → Stage 005 waterfall absorbs (Barikoi → Google-capped → Haversine × 1.3); dispatch continues. 4. Restart primary container, `osrm-datastore` reload, health check, fail back (or keep standby primary until Runbook D). 5. Post-incident: capture graph version + metrics.

### Runbook B — Emergency landmark takedown (Tier 1 **< 1 h SLA**, engineering target < 60 s `[ESTIMATE]`)
1. Trigger: Stage 011 auto-hide threshold (3 qualified travelers) or admin/counsel order. 2. Redis Set `dpmaps:suppression:active_place_ids` add (< 5 ms). 3. Meili purge **both** `first_party_pois` + `osm_pois` (008 names). 4. `dpmaps.suppressions` row (Stage 003 §4.5 columns; `reported_at` SLA clock; `suppression_target_sla='1_hour'`). 5. **Cloudflare Purge by Tag `fp-poi`** (006 §6.3, < 30 s) + client-side filter. 6. `public_pois.lifecycle_status='suppressed'` + `provenance_events('takedown')`. 7. SLA verified `applied_at - reported_at < 1 h`; Tier 2 manual review < 4 h (011 §7).

### Runbook C — Immediate mode rollback (primary → shadow → off)
1. Trigger: gate breach, sev-1, or rehearsal abort (015 §5). 2. `system_config`: `routing_provider_mode`/`search_provider_mode` → `1: shadow` (sub-second hot reload, 005 §2); vendor serves live again. 3. If the incident is vendor-related/legal → `0: off` (bypass dpMaps entirely; Barikoi → Google → Haversine). 4. Verify: zero OSRM calls in `off`, shadow benchmarking resumes in `shadow`. 5. The Redis suppression set is **never** cleared by rollback (011 §7.2).

### Runbook D — Geofabrik graph re-ingestion + MLD build (monthly default `[ESTIMATE]; configurable — Stage 004 alerts at 2× rebuild interval]`)
1. Fetch `bangladesh-latest.osm.pbf`; verify size (~339 MB `[VERIFIED baseline]`). 2. `osrm-extract/partition/customize` per profile (004 §3.1) on the build node. 3. Blue/Green swap with synthetic probe (004 §4.3); zero dropped queries. 4. Optional Planetiler tile rebuild + versioned `bangladesh-<hash>.pmtiles` pointer swap (006). 5. Run Stage 007 geometry audit subset (004 §7) + Stage 015 routing golden replay before declaring done. 6. Record build hash in the release manifest (009 §11).

---

## 6. Monitoring & Clean-Room Posture (F-016-4)

Prometheus/Alertmanager: QPS, p95 latency per provider, RSS, fallback rates (`dpmaps_routing_fallback_total`), gate gauges (005 §6.1), suppression SLA timers, replica lag. **Egress control:** all vendor egress flows through `vendorClientWrapper` with egress logging (Stage 002); network policy denies direct vendor endpoints from workers (clean-room firewall).

---

## 7. Deliverables

- [ ] Sizing matrix provisioned per tier; Phase-1 OSRM ≥ 32 GB verified against real-graph RSS (F-016-1).
- [ ] Meili replica + PG streaming replication deployed from Phase 2 (F-016-2).
- [ ] Failover drill: kill primary container → < 300 ms cutover `[ESTIMATE]` measured (F-016-2).
- [ ] Runbooks A–D in `docs/orchestration/` runbook set, each drill-tested; Runbook B end-to-end with a real suppression (Stage 011 + 006 purge tags) (F-016-3).
- [ ] Egress policy + wrapper logging verified (F-016-4).
- [ ] All `[ESTIMATE]` figures replaced by measurements after Phase 1 soak.

---

## 8. Revision Changelog

| Revision | Date | Author / Context | Summary |
|---|---|---|---|
| Rev 2.0 | 2026-10-22 | Orchestrator (audited baseline) | Topology, sizing matrix, hot reload, failover, 3 runbooks, Prometheus. |
| Rev 2.1 | 2026-10-22 | Lead Planning & Systems Architecture (batch-4 audit) | **Sizing Physics, HA & Runbook Completion:** 1. Sizing matched to Stage 004 RSS (Phase-1 OSRM 32 GB; blue/green headroom) + network bandwidth rows (F-016-1). 2. Meili replica + PG streaming replication + failover semantics aligned to the 300 ms budget (F-016-2). 3. Runbooks A–D completed per work order (crash failover; takedown with < 1 h SLA + dual-index purge + `fp-poi` tag; mode rollback primary→shadow→off; Geofabrik re-ingestion with configurable cadence) (F-016-3). 4. Clean-room egress posture (F-016-4). |
