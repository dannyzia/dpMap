# Stage 016: Infrastructure Deployment, High Availability & SRE Runbooks Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-016  
**Stage:** 16 of 16 (Production Infrastructure & Operational Reliability)  
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§17.1–17.5, §18, §21)  
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)  
**Current Status:** **Revision 2.0 (Audited & Upgraded)**  
**Target Phase:** Phase 0–4 (Staging Setup to Full Sovereign Operations)  
**Primary Dependencies:** [`002_provenance_firewall_and_legal_compliance.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/002_provenance_firewall_and_legal_compliance.md), [`003_storage_schema_and_continuous_evidence_ledger.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/003_storage_schema_and_continuous_evidence_ledger.md), [`004_osrm_routing_engine_and_dynamic_traffic.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/004_osrm_routing_engine_and_dynamic_traffic.md), [`005_dispatch_router_and_shadow_benchmarking.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/005_dispatch_router_and_shadow_benchmarking.md), [`006_vector_tiles_pmtiles_and_bengali_glyphs.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/006_vector_tiles_pmtiles_and_bengali_glyphs.md), [`008_search_engine_meilisearch_and_mixed_autocomplete.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/008_search_engine_meilisearch_and_mixed_autocomplete.md)

---

## 1. Executive Summary & Objective

Commercial mapping vendors operate as opaque black boxes whose unexpected outages, rate limit throttles, or API price increases directly disrupt fleet dispatches and paralyze ride-hailing operations. True geospatial sovereignty requires self-hosted, deterministic, highly available infrastructure with predictable resource consumption, zero-downtime hot reloads, and automated failover.

Stage 016 establishes the complete **Production Infrastructure Deployment, High Availability Topology & SRE Runbooks**:
1. **The Comprehensive Workload Capacity Model:** Derived from 20.4 functional geospatial requests per completed order across 4 scaling tiers (500 to 25,000 orders/day).
2. **Multi-Node Production Topology:** 6 decoupled subsystems (Primary OSRM, Standby OSRM, MeiliSearch Cluster, PostGIS Database, Redis State Cluster, and Cloudflare R2 CDN).
3. **Multi-Profile OSRM Container Architecture:** Parallel instances for Car (5001), Bike (5002), and CNG (5003) behind an internal NGINX Gateway (5000), utilizing shared-memory IPC (`osrm-datastore`) for zero-downtime live graph swaps.
4. **Automated Hot Failover (<300ms SLA):** Upstream health polling with active standby redundancy ensuring uninterrupted fleet dispatch during hardware failure or container restarts.
5. **Standardized SRE Incident Runbooks:** Exhaustive step-by-step procedures covering latency degradation, emergency takedowns, node crashes, graph updates, and one-step release rollbacks.

---

## 2. Production Workload & Capacity Model

Every completed ride-hailing or delivery trip generates a deterministic sequence of internal geospatial operations across client and dispatch layers:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        GEOSPATIAL REQUEST MULTIPLIER DERIVATION                        │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Routing & Distance Queries: 4.4 requests/order                                      │
│    • 1.0 req: Upfront fare quote & ETA estimation (Origin -> Destination)             │
│    • 1.4 req: Dispatch matchmaking driver candidate distance matrix (Driver -> Pickup)│
│    • 1.0 req: Driver turn-by-turn navigation route generation                          │
│    • 1.0 req: In-trip dynamic rerouting & post-trip distance reconciliation            │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 2. Search & Autocomplete Queries: 8.0 requests/order                                   │
│    • 6.0 req: Keystroke prefix autocomplete lookups during destination entry           │
│    • 1.0 req: Pickup point reverse geocoding pin drop resolution                       │
│    • 1.0 req: Final candidate entity resolution and coordinate snapping                │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 3. Vector Map Tiles & Glyphs: 8.0 requests/order                                       │
│    • 8.0 req: Viewport tile chunks loaded from edge cache during booking flow          │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ TOTAL FUNCTIONAL WORKLOAD: Exactly 20.4 Requests per Completed Order                   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Concurrency & Peak Throughput Derivation
- **Peak Hour Concentration:** 15% of daily trip volume occurs during the single busiest morning or evening peak hour.
- **Micro-Burst Factor:** Peak-hour queries arrive with a 1.5× Poisson surge factor:
  $$\text{Peak RPS} = \left( \frac{\text{Daily Orders} \times 0.15 \times 20.4}{3600 \text{ seconds}} \right) \times 1.5 = \frac{\text{Daily Orders} \times 20.4}{16000}$$

| Parameter / Volume Tier | Tier 1: Launch (500/day) | Tier 2: Growth (2,000/day) | Tier 3: Scale (10,000/day) | Tier 4: Mature (25,000/day) |
|---|:---:|:---:|:---:|:---:|
| **Monthly Completed Orders** | 15,000 | 60,000 | 300,000 | 750,000 |
| **Daily Requests (20.4/order)** | ~10,200 | ~40,800 | ~204,000 | ~510,000 |
| **Peak Routing Throughput (4.4 req)** | **0.14 QPS** | **0.55 QPS** | **2.75 QPS** | **6.88 QPS** |
| **Peak Search Throughput (8.0 req)** | **0.25 QPS** | **1.00 QPS** | **5.00 QPS** | **12.50 QPS** |
| **Peak Vector Tile Egress (8.0 req)** | **0.25 RPS** | **1.00 RPS** | **5.00 RPS** | **12.50 RPS** |
| **Aggregate Peak Infrastructure RPS** | **0.64 RPS** | **2.55 RPS** | **12.75 RPS** | **31.88 RPS** |

### 2.2 Critical Infrastructure Sizing Insight
Even at **25,000 completed orders per day** (750,000 orders/month), peak routing demand requires only **~6.88 queries per second**. Because a single modern CPU core running OSRM MLD processes **500 to 1,000 QPS**, compute capacity is never the infrastructure bottleneck. Sizing is strictly dictated by:
1. **RAM Footprint:** Resident Memory (RSS) required to hold contracted routing graphs and MeiliSearch indexes entirely in memory.
2. **Redundancy & High Availability:** Multi-node active/standby topologies to ensure zero dispatch interruptions during hardware crashes or updates.

---

## 3. Multi-Node Production Topology

```
                                [ Cloudflare Edge / CDN ]
                      (Vector Tiles PMTiles & Noto Sans Bengali Glyphs)
                                            │
                                            ▼
                           [ NGINX Edge / Host-Only Ingress ]
                                            │
               ┌────────────────────────────┴────────────────────────────┐
               ▼                                                         ▼
  [ Node A: Primary Routing Cluster ]                       [ Node B: Standby Routing Cluster ]
  • 8 vCPU / 16 GB RAM / 100 GB NVMe                        • 8 vCPU / 16 GB RAM / 100 GB NVMe
  • NGINX Gateway Port 5000                                 • Identical hot-standby topology
  • Car OSRM (Port 5001)                                    • Failover SLA: < 300ms
  • Bike OSRM (Port 5002)                                   • Automatic upstream rerouting
  • CNG OSRM (Port 5003)                                    • Pre-loaded MLD graph in memory
  • Shared Memory IPC (osrm-datastore)                      • Shared Memory IPC (osrm-datastore)
               │                                                         │
               └────────────────────────────┬────────────────────────────┘
                                            ▼
                          [ Node C: Search & In-Memory Index ]
                          • 4 vCPU / 8 GB RAM / 50 GB NVMe
                          • MeiliSearch v1.6+ Cluster (52,000 POIs, ~120 MB RSS)
                          • Sub-10ms prefix search & _geo proximity ranking
                                            │
                                            ▼
                       [ Node D: PostgreSQL / PostGIS Database ]
                       • 8 vCPU / 32 GB RAM / 250 GB NVMe
                       • PostgreSQL 16 + PostGIS 3.4
                       • pg_partman 5.x native weekly partitioning on ledger
                       • Read replica for analytics & shadow calibration
                                            │
                                            ▼
                       [ Node E: Redis In-Memory State Cluster ]
                       • 2 vCPU / 4 GB RAM
                       • Emergency suppression sets, rate limits, ephemeral quote cache
```

---

## 4. Hardware Sizing & Provisioning Matrix

| Component | Launch (Tier 1: 500/day) | Growth (Tier 2: 2k/day) | Scale (Tier 3: 10k/day) | Mature (Tier 4: 25k/day) | Recommended Cloud Spec |
|---|---|---|---|---|---|
| **OSRM Primary Node** | 4 vCPU / 8 GB RAM | 4 vCPU / 8 GB RAM | 8 vCPU / 16 GB RAM | 8 vCPU / 16 GB RAM | Dedicated VPS (Compute-Optimized) |
| **OSRM Standby Node** | 2 vCPU / 4 GB RAM | 4 vCPU / 8 GB RAM | 4 vCPU / 8 GB RAM | 8 vCPU / 16 GB RAM | Dedicated VPS (Hot Standby) |
| **MeiliSearch Node** | 2 vCPU / 4 GB RAM | 2 vCPU / 4 GB RAM | 4 vCPU / 8 GB RAM | 4 vCPU / 8 GB RAM | General Purpose VPS |
| **PostgreSQL / PostGIS** | 4 vCPU / 16 GB RAM | 4 vCPU / 16 GB RAM | 8 vCPU / 32 GB RAM | 8 vCPU / 32 GB RAM | High-Memory NVMe Storage VPS |
| **Redis State Cluster** | 1 vCPU / 2 GB RAM | 2 vCPU / 4 GB RAM | 2 vCPU / 4 GB RAM | 4 vCPU / 8 GB RAM | Managed Redis / Cluster VPS |
| **Cloudflare R2 Bucket** | ~$0.15 / month | ~$0.60 / month | ~$3.00 / month | ~$7.50 / month | Zero Egress CDN Storage |

---

## 5. Multi-Profile OSRM Deployment & Shared-Memory Hot Reload

### 5.1 Docker Compose Deployment Configuration
```yaml
# deploy/docker-compose.osrm.yml
version: '3.8'

services:
  osrm-gateway:
    image: nginx:1.25-alpine
    container_name: osrm-gateway
    restart: always
    ports:
      - "5000:5000"
    volumes:
      - ./nginx/osrm-gateway.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - osrm-car
      - osrm-bike
      - osrm-cng

  osrm-car:
    image: osrm/osrm-backend:v5.27.1
    container_name: osrm-car
    restart: always
    ipc: host
    command: osrm-routed --algorithm mld --shared-memory=yes --port 5001
    ports:
      - "5001:5001"

  osrm-bike:
    image: osrm/osrm-backend:v5.27.1
    container_name: osrm-bike
    restart: always
    ipc: host
    command: osrm-routed --algorithm mld --shared-memory=yes --port 5002
    ports:
      - "5002:5002"

  osrm-cng:
    image: osrm/osrm-backend:v5.27.1
    container_name: osrm-cng
    restart: always
    ipc: host
    command: osrm-routed --algorithm mld --shared-memory=yes --port 5003
    ports:
      - "5003:5003"
```

### 5.2 Zero-Downtime Live Graph Reload (`scripts/hot-reload-osrm.sh`)
```bash
#!/usr/bin/env bash
set -euo pipefail

# Hot-reloads contracted OSM graph into shared memory without restarting containers
DATA_DIR="/opt/dpmaps/data/graphs"
NEW_PBF="${DATA_DIR}/bangladesh-latest.osm.pbf"

echo "[dpMaps SRE] Initiating MLD pipeline on new graph..."
docker run --rm -v "${DATA_DIR}:/data" osrm/osrm-backend:v5.27.1 osrm-extract -p /data/profiles/car.lua /data/bangladesh-latest.osm.pbf
docker run --rm -v "${DATA_DIR}:/data" osrm/osrm-backend:v5.27.1 osrm-partition /data/bangladesh-latest.osrm
docker run --rm -v "${DATA_DIR}:/data" osrm/osrm-backend:v5.27.1 osrm-customize /data/bangladesh-latest.osrm

echo "[dpMaps SRE] Loading new graph into IPC shared memory segment..."
docker run --rm --ipc=host -v "${DATA_DIR}:/data" osrm/osrm-backend:v5.27.1 osrm-datastore /data/bangladesh-latest.osrm

echo "[dpMaps SRE] Signaling live osrm-routed containers to switch memory pointers..."
docker kill --signal=HUP osrm-car osrm-bike osrm-cng

echo "[dpMaps SRE] Live graph reload completed successfully with zero dropped requests!"
```

---

## 6. High Availability & Automated Failover Runbook

### 6.1 NGINX Upstream Configuration with Hot Standby
```nginx
# /etc/nginx/conf.d/osrm_upstream.conf
upstream osrm_car_backend {
    server osrm-primary.internal:5001 max_fails=2 fail_timeout=2s;
    server osrm-standby.internal:5001 backup;
}

upstream osrm_bike_backend {
    server osrm-primary.internal:5002 max_fails=2 fail_timeout=2s;
    server osrm-standby.internal:5002 backup;
}

upstream osrm_cng_backend {
    server osrm-primary.internal:5003 max_fails=2 fail_timeout=2s;
    server osrm-standby.internal:5003 backup;
}

server {
    listen 5000;
    
    location /route/v1/car/ {
        proxy_pass http://osrm_car_backend/route/v1/driving/;
        proxy_connect_timeout 150ms;
        proxy_read_timeout 300ms;
    }

    location /route/v1/bike/ {
        proxy_pass http://osrm_bike_backend/route/v1/driving/;
        proxy_connect_timeout 150ms;
        proxy_read_timeout 300ms;
    }

    location /route/v1/cng/ {
        proxy_pass http://osrm_cng_backend/route/v1/driving/;
        proxy_connect_timeout 150ms;
        proxy_read_timeout 300ms;
    }
}
```

### 6.2 Failover Mechanics & SLA Verification
1. **Health Polling:** NGINX edge gateway continuously probes `osrm-primary` every 1000ms.
2. **Failure Detection:** If `osrm-primary` returns 2 consecutive connection failures or timeouts (>150ms):
   - NGINX routes incoming dispatches to `osrm-standby` within **<300ms**.
   - Standby node is active and pre-loaded in memory, eliminating cold-start latency.
3. **Automated Recovery:** Docker restart policy restarts failed primary containers automatically. Once healthy, traffic seamlessly returns to primary.

---

## 7. Standardized SRE Incident Runbooks

### Runbook 1: Routing Query Latency Degradation (p95 > 15ms)
- **Symptoms:** Alertmanager fires `OSRMHighLatency`; dispatch quotes experience latency spikes.
- **Diagnostic Steps:**
  1. Inspect container CPU utilization: `docker stats osrm-car osrm-bike osrm-cng`.
  2. Verify IPC lock contention in shared memory: `ipcs -m`.
  3. Inspect NGINX upstream error log: `tail -f /var/log/nginx/error.log | grep upstream_timed_out`.
- **Resolution:**
  - If CPU saturated, scale read replicas or toggle temporary mode back to Primary with Fallback.
  - If memory thrashing detected, run `scripts/hot-reload-osrm.sh` to refresh memory segments.

### Runbook 2: Emergency Location Takedown (<60s Execution)
- **Symptoms:** High-priority privacy complaint, court order, or compromised landmark requiring instant removal.
- **Resolution:**
  ```bash
  # Execute emergency CLI takedown
  npm run dpmaps:takedown -- --poi-id 8f4e2b10-6c9a-412d-98e3-0c1a9f0e4b88 \
    --reason court_order --admin-user admin-ops-01
  ```
  - Verifies key added to Redis `dpmaps:suppression:active_place_ids` (<5ms).
  - Deletes document from MeiliSearch (`meilisearch.deleteDocument`) (<100ms).
  - Purges Cloudflare tile cache tag: `curl -X POST .../purge_cache -d '{"tags":["tile-z14-123-456"]}'` (<30s).

### Runbook 3: One-Step Monthly Release Rollback (<5 min Execution)
- **Symptoms:** Alertmanager fires `SearchAccuracyRegression` or `HighCancellationRate` following a new monthly release.
- **Resolution:**
  ```bash
  npm run dpmaps:release -- --rollback-to pub-2026-10-01 --reason "Regression in Old Dhaka autocomplete"
  ```
  1. Database switches active manifest pointer in `dpmaps.releases`.
  2. MeiliSearch re-points index alias to the previous release snapshot.
  3. Redis suppression set is **preserved** to prevent resurrecting deleted locations.
  4. Vector tile cache tag purged on Cloudflare CDN.

---

## 8. Prometheus Metrics & Alertmanager Rules

```yaml
# /etc/prometheus/alert_rules.dpmaps.yml
groups:
  - name: dpmaps_infrastructure_alerts
    rules:
      - alert: OSRMHighLatency
        expr: histogram_quantile(0.95, sum(rate(dpmaps_osrm_request_duration_seconds_bucket[5m])) by (le)) > 0.015
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "OSRM p95 latency exceeded 15ms SLA"

      - alert: OSRMPrimaryNodeDown
        expr: up{job="osrm-primary"} == 0
        for: 30s
        labels:
          severity: critical
        annotations:
          summary: "Primary OSRM container offline; traffic diverted to standby"

      - alert: MeiliSearchClusterDegraded
        expr: rate(dpmaps_search_errors_total[2m]) > 0.01
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "MeiliSearch error rate > 1%; checking Redis fallback"

      - alert: HighVendorFallbackRate
        expr: (sum(rate(dpmaps_search_requests_total{source="vendor_fallback"}[5m])) / sum(rate(dpmaps_search_requests_total[5m]))) > 0.15
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Vendor fallback rate > 15% in Primary mode; audit local coverage"
```

---

## 9. Deliverables & Definition of Done

- [ ] **Infrastructure Provisioning:** Dedicated production and standby VPS provisioned with Docker Compose orchestration.
- [ ] **NGINX Multi-Profile Gateway:** Gateway active on Port 5000 routing Car (5001), Bike (5002), and CNG (5003).
- [ ] **Automated Standby Failover:** Hot failover tested and verified with $<300\text{ms}$ cutover latency on container termination.
- [ ] **Shared-Memory Hot Reload:** `scripts/hot-reload-osrm.sh` deployed and benchmarked on 339 MB PBF, proving zero dropped dispatches.
- [ ] **Monitoring & Dashboards:** Prometheus Alertmanager rules and Grafana dashboards tracking QPS, p95 latencies, RAM RSS, and fallback rates.
- [ ] **Emergency Runbooks Tested:** Verified sub-60s emergency takedown and one-step release rollback in staging.
