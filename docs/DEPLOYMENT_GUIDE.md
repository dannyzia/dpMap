# dpMaps — Production & Staging Deployment Guide

**Document Identifier:** RIDE-dpMaps-OPS-001  
**Target:** Production & Staging Infrastructure (Phase 1 Dual-Connected Launch)  
**Parent Document:** [`016_infrastructure_deployment_high_availability_and_runbooks.md`](file:///home/zia/Documents/My%20Projects/dpMaps/docs/plans/016_infrastructure_deployment_high_availability_and_runbooks.md) (Rev 2.1)  
**Last Updated:** October 2026  

---

## 1. System Topology Overview

```
                          [ Internet / Mobile Clients (Ride App) ]
                                            │
                                            ▼
                           [ NGINX Reverse Proxy & Load Balancer ]
                                            │
            ┌───────────────────────────────┼───────────────────────────────┐
            │                               │                               │
            ▼                               ▼                               ▼
    [ OSRM Primary ]              [ MeiliSearch Primary ]            [ PostgreSQL 16 ]
    • Car:   port 5001            • first_party_pois (RAM)           • PostGIS 3.4
    • Bike:  port 5002            • osm_pois (RAM)                   • Schema: dpmaps
    • CNG:   port 5003            • Port: 7700                       • Port: 5432
            │                               │                               │
            ▼ (Hot-Standby)                 ▼ (Async Replica)               ▼ (Streaming Replica)
    [ OSRM Standby ]              [ MeiliSearch Replica ]            [ PostgreSQL Standby ]
    • Ports 5001-5003             • Phase 2+                         • Read-only reporting
                                            │
                                            ▼
                                     [ Redis 7 HA ]
                                     • dpmaps:suppression:*
                                     • dest_session:* (15-min TTL)
                                     • Rate limits & quoter cache
                                     • Port: 6379
                                            │
                                            ▼
                               [ Cloudflare R2 Bucket ]
                               • /fonts/* (Noto Sans Bengali PBF)
                               • /tiles/* (bangladesh.pmtiles)
```

---

## 2. Hardware Sizing Matrix (Phase 1 Baseline)

| Component | CPU | RAM | Disk | Network | Notes |
|---|---|---|---|---|---|
| **OSRM Primary** | 8 vCPU | 32 GB | 200 GB NVMe | 1 Gbps | Holds 3 vehicle graphs (~7.5 GB RSS) + 15 GB Blue/Green reload headroom |
| **OSRM Hot-Standby** | 4 vCPU | 16 GB | 100 GB NVMe | 1 Gbps | Passive standby with 300 ms NGINX failover |
| **PostgreSQL + PostGIS** | 4 vCPU | 16 GB | 250 GB SSD | 1 Gbps | Stores schemas, 90-day evidence ledger, partition pruning |
| **MeiliSearch** | 2 vCPU | 8 GB | 50 GB SSD | 1 Gbps | Holds dual in-memory search indexes (<40 ms budget) |
| **Redis** | 2 vCPU | 4 GB | 20 GB SSD | 1 Gbps | In-memory sets, sliding-window rate limiters, session tokens |
| **Cloudflare R2** | — | — | Object Store | CDN Edge | Static SDF glyphs and PMTiles vector tiles |

*Dev/Staging Alternative:* For staging or development, all services can run on a single 16 GB or 32 GB VPS using Docker Compose.

---

## 3. Step-by-Step Deployment Instructions

### Step 1: Database Provisioning (PostgreSQL 16 + PostGIS)

1. Provision PostgreSQL 16 with the PostGIS extension enabled:
   ```bash
   sudo apt update
   sudo apt install -y postgresql-16 postgresql-16-postgis-3
   ```
2. Create the dpMaps database, users, and extensions:
   ```sql
   CREATE DATABASE dpmaps_prod;
   \c dpmaps_prod
   CREATE EXTENSION IF NOT EXISTS postgis;
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
   CREATE SCHEMA IF NOT EXISTS dpmaps;
   ```
3. Execute the schema migrations in order:
   ```bash
   psql -d dpmaps_prod -f migrations/003_storage_schema.sql
   psql -d dpmaps_prod -f migrations/014_decouple_saved_places.sql
   ```
4. Verify table creation:
   ```sql
   SELECT table_name FROM information_schema.tables WHERE table_schema = 'dpmaps';
   -- Expect 29 tables and views (public_pois, trip_evidence_ledger, suppressions, etc.)
   ```

---

### Step 2: Routing Engine Provisioning (OSRM)

1. On the OSRM server, install Docker and Docker Compose.
2. Download the latest Bangladesh OpenStreetMap extract:
   ```bash
   mkdir -p data/osrm
   curl -L -o data/osrm/bangladesh-latest.osm.pbf https://download.geofabrik.de/asia/bangladesh-latest.osm.pbf
   ```
3. Run the automated graph build script:
   ```bash
   bash tools/scripts/build-osrm-graphs.sh
   ```
   *This extracts and contracts the road network for Car, Bike, and CNG using `profiles/car.lua`, `profiles/bike.lua`, and `profiles/cng.lua`.*
4. Start the multi-container OSRM service:
   ```bash
   docker compose -f docker-compose.osrm.yml up -d
   ```
5. Verify health probes:
   ```bash
   curl -I http://localhost:5001/healthz  # Car
   curl -I http://localhost:5002/healthz  # Bike
   curl -I http://localhost:5003/healthz  # CNG
   # All endpoints must return HTTP 200 OK
   ```

---

### Step 3: Search Engine Provisioning (MeiliSearch)

1. Deploy MeiliSearch (v1.6+):
   ```bash
   docker run -d --name meilisearch -p 7700:7700 \
     -v meili_data:/meili_data \
     getmeili/meilisearch:v1.6 \
     meilisearch --db-path /meili_data --master-key "$MEILI_MASTER_KEY"
   ```
2. Initialize index configurations:
   - Run the initialization script to configure `first_party_pois` and `osm_pois` with the exact searchable, filterable, sortable, and digit-lock ranking rules from `services/searchIndexConfig.ts`.
3. Ingest baseline OpenStreetMap POIs (Phase 0):
   ```bash
   python3 tools/scripts/ingest_open_pois.py
   # Ingests 50,545 baseline clean-room places from docs/resources/bangladesh.poi
   ```

---

### Step 4: Cache & Suppression Provisioning (Redis)

1. Deploy Redis 7:
   ```bash
   docker run -d --name dpmaps-redis -p 6379:6379 redis:7-alpine redis-server --appendonly yes
   ```
2. Initialize suppression key structures:
   - Key: `dpmaps:suppression:active_place_ids` (Redis Set).

---

### Step 5: Static Assets & Fonts (Cloudflare R2)

1. Create a Cloudflare R2 bucket: `dpmaps-assets`.
2. Upload the pre-generated Noto Sans Bengali SDF glyphs:
   ```bash
   # From docs/resources/fonts/
   aws s3 sync docs/resources/fonts/ s3://dpmaps-assets/fonts/ \
     --endpoint-url "https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com"
   ```
3. Point your MapLibre map style glyphs URL to:
   `https://assets.dpmaps.yourdomain.com/fonts/{fontstack}/{range}.pbf`

---

### Step 6: Mode Configuration & Safe Launch

Configure initial operational toggles in `system_config`:
```sql
UPDATE dpmaps.system_config SET value = '1' WHERE key = 'routing_provider_mode'; -- 1 = Shadow Mode
UPDATE dpmaps.system_config SET value = '1' WHERE key = 'search_provider_mode';  -- 1 = Shadow Mode
```
- **Mode 1 (Shadow):** Commercial vendor (Barikoi) continues serving 100% of live ride traffic; dpMaps runs in the background, computing routes and search results, and logs benchmark comparison metrics into `routing_eval_events` without any user disruption.
- **Mode 2 (Primary):** Promoted only when numeric Cutover Gate 1A/1B criteria are sustained for 3 consecutive weeks.

---

## 4. Operational Health & Runbooks

- **Runbook A (OSRM Failover):** If OSRM latency exceeds 300 ms or fails, NGINX switches to the standby node in <300 ms; the fallback waterfall seamlessly absorbs requests via Barikoi/Google.
- **Runbook B (Emergency Takedown):** Auto-hide (3 qualified travelers) or admin command evicts the place from Redis, purges both MeiliSearch indexes, and triggers a Cloudflare `fp-poi` cache purge within the <1 hour SLA.
- **Runbook C (Mode Rollback):** Single SQL update flips `routing_provider_mode` back to `1 (shadow)` or `0 (off)` in <1 second with zero container restarts.
- **Runbook D (Monthly Graph Update):** Re-extracts Geofabrik road networks monthly and executes a zero-downtime Blue/Green container swap.
