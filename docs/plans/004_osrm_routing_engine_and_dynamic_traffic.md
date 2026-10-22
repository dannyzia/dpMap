# Stage 004: OSRM Routing Engine & Dynamic Traffic Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-004 (Revision 2.1 — TOD-Learned ETA Engine, Verified Waterfall Contract & Relative Cutover Gates)
**Stage:** 4 of 16 (Routing Core & Traffic Engineering)
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§4, §14.3, §15.4, §17.1–17.2, §18, §21)
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)
**Current Status:** **NotDone**

---

## 1. Executive Summary & Objective

In high-concurrency ride-hailing dispatch, route calculation latency is a critical performance bottleneck. Commercial mapping vendor APIs (Google Routes, Barikoi) introduce external network latency on the order of **150–400 ms `[ESTIMATE — unverified]`** per calculation, incur per-query billing, and expose the platform to vendor lock-in. Furthermore, commercial routing models are not calibrated for Dhaka's multi-modal mobility: motorbikes weaving through gridlock, CNG auto-rickshaws restricted from certain arterials `[UNVERIFIED — verify regulations before encoding]`, and narrow informal alleyways inaccessible to four-wheelers.

Stage 004 delivers a sovereign routing infrastructure on the **Open Source Routing Machine (OSRM)**:
1. **Multi-Instance Container Topology:** A 3-container architecture serving distinct vehicle profiles (**Car**, **Motorbike**, **CNG Auto-rickshaw**) behind an internal routing gateway.
2. **Multi-Level Dijkstra (MLD) Graph Compilation:** Pre-processes the verified 339 MB Geofabrik Bangladesh extract `[VERIFIED — concept paper §21]` into partitioned cell hierarchies supporting dynamic edge-weight customization.
3. **Near-Zero-Downtime Hot-Reloading (`osrm-datastore` & Blue/Green):** Shared-memory reload and blue/green container rotation allow frequent traffic-weight updates without dropped dispatch queries.
4. **Bangladeshi Vehicle Lua Profiles:** Local access and speed semantics per vehicle class (width thresholds, expressway access `[UNVERIFIED]`, speed caps `[ESTIMATE]`), tag-first with curated way-ID blocklists.
5. **First-Party Time-of-Day (TOD) Speed Harvesting:** Harmonic-mean edge velocities derived from driver GPS pings (10 s cadence, concept paper §15.4), aggregated into 30-minute TOD buckets per vehicle type, applied to the graph at bucket boundaries via `osrm-customize`, and complemented by a **learned multiplicative ETA correction layer** — because static OSRM edge weights alone cannot represent Dhaka congestion (F-004-1).
6. **Relative ETA Cutover Gates:** All ETA acceptance criteria are percentages of real trip duration, benchmarked against driven GPS and against Barikoi's own measured error. **Never flat minutes** (§8.3).
7. **OSM Dhaka Geometry Completeness Audit:** Empirical probes across Old Dhaka alleys, median openings, and flyovers. Dhaka OSM completeness is currently **`[UNVERIFIED — UNMEASURED]`** (concept paper §15.4) and must be measured before sole-mode reliance.

**Ownership split:** Stage 004 owns the OSRM engines, graph pipeline, traffic-speed pipeline, and the OSRM client (timeout + circuit breaker). Stage 005 owns the dispatch fallback waterfall (OSRM → Barikoi → Google → Haversine × 1.3) and shadow benchmarking.

> [!CAUTION]
> ### MANDATORY LEGAL GATE PREREQUISITE
> In accordance with Stage 002 Rev 2.2 and `000_TOC.md`, Phase 1 shadow benchmarking and driver GPS harvesting cannot commence until **Stage 002 Legal Matrix Items 3, 7, 14, 15, 16, and 17** (specifically Item 17: Driver GPS Consent, and Item 7: Vendor Contract Compliance) are formally signed off in writing by external legal counsel.

---

## 2. Multi-Profile Topology & Hardware Sizing

In OSRM, an `osrm-routed` process serves exactly **one** contracted dataset for **one** vehicle profile. To support Ride's multi-modal fleet simultaneously, the routing backend deploys three isolated OSRM engines behind a reverse proxy router:

```
                                [ RIDE BACKEND DISPATCH ]
                                            │
                                            ▼
                          [ NGINX INTERNAL ROUTING GATEWAY ]
                                     (Port 5000)
                   ┌────────────────────────┼────────────────────────┐
                   │ /route/v1/car/...      │ /route/v1/bike/...     │ /route/v1/cng/...      │
                   ▼                        ▼                        ▼
       ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐
       │   dpmaps-osrm-car    │ │   dpmaps-osrm-bike   │ │   dpmaps-osrm-cng    │
       │     (Port 5001)      │ │     (Port 5002)      │ │     (Port 5003)      │
       │ • car.lua profile    │ │ • bike.lua profile   │ │ • cng.lua profile    │
       │ • Min width: 2.5m    │ │ • Alleys down to 1.2m│ │ • Speed cap: 45 km/h │
       │ • Expressway allowed │ │ • Expressway barred  │ │ • VIP roads barred   │
       │   [UNVERIFIED rules] │ │   [UNVERIFIED rules] │ │   [UNVERIFIED rules] │
       │ • RSS: ~2.4 GB [EST] │ │ • RSS: ~2.6 GB [EST] │ │ • RSS: ~2.2 GB [EST] │
       └──────────────────────┘ └──────────────────────┘ └──────────────────────┘
                   │                        │                        │
                   └────────────────────────┼────────────────────────┘
                                            │
                                            ▼
                              [ SHARED STORAGE VOLUME ]
                           /opt/dpmaps/data/bangladesh/
```

The URL profile segment (`car`/`bike`/`cng`) is an NGINX routing key; each `osrm-routed` instance serves its loaded dataset.

### 2.1 Hardware Sizing & Memory Model

All sizing figures below are **`[ESTIMATE — measure on real graph]`**. Per concept paper §21 and AGENTS.md §10, OSRM RAM, throughput, and latency on the real Bangladesh graph are **UNVERIFIED** until measured in Docker.

| Resource Metric | Staging / Phase 1 Shadow Tier | Scale Production Tier (10k–25k rides/day) |
|---|---|---|
| **Host Instance** | 8 vCPU (Dedicated AMD EPYC / Intel Xeon) | 16 vCPU (Dedicated Compute Optimized) |
| **RAM Allocation** | 16 GB DDR4/DDR5 ECC | 32 GB DDR4/DDR5 ECC |
| **Storage Allocation**| 100 GB NVMe SSD ($> 3,000$ IOPS) | 200 GB NVMe SSD ($> 10,000$ IOPS) |
| **Operating System** | Ubuntu 24.04 LTS (Kernel 6.8+) | Ubuntu 24.04 LTS (Kernel 6.8+) |
| **OSRM Version** | ghcr.io/project-osrm/osrm-backend:v5.27.1 | ghcr.io/project-osrm/osrm-backend:v5.27.1 |
| **Graph Algorithm** | Multi-Level Dijkstra (MLD) | Multi-Level Dijkstra (MLD) |
| **Graph Footprint** | Car: 2.4 GB, Bike: 2.6 GB, CNG: 2.2 GB `[ESTIMATE]` (registry range 2.0–3.0 GB `[UNVERIFIED]`) | Total Graph RSS: ~7.2 GB (14.4 GB during Blue/Green) `[ESTIMATE]` |
| **Throughput Target** | 1,500–2,500 routes/sec aggregate `[ESTIMATE]` (registry: 500–1,000 QPS/core) | 5,000–8,000 routes/sec aggregate `[ESTIMATE]` |
| **Target Latency** | Baseline 2–5 ms `[ESTIMATE]` (p95 < 8 ms, p99 < 15 ms `[ESTIMATE]`) | Baseline 2–5 ms `[ESTIMATE]` (p95 < 6 ms, p99 < 10 ms `[ESTIMATE]`) |

---

## 3. Graph Ingestion & MLD Compilation Pipeline

The pipeline ingests the 339 MB national OpenStreetMap extract for Bangladesh (`bangladesh-latest.osm.pbf`) from Geofabrik and compiles three distinct MLD graph structures, one per vehicle profile.

**Provenance:** the PBF is ODbL-licensed OSM data. Contracted graphs live in the isolated OSM attribution layer. First-party proprietary POIs (`public_pois`) are never merged into OSM derivative files (Architectural Invariant 4). Nothing vendor-derived ever enters this pipeline (Hard Rule 1).

```
[ bangladesh-latest.osm.pbf (339 MB) ]
                   │
         ┌─────────┼─────────┐
         ▼         ▼         ▼
    [ car.lua ] [ bike.lua] [ cng.lua ]
         │         │         │
         ▼         ▼         ▼
    [ osrm-extract (Generates .osrm base graph & node mappings) ]
         │         │         │
         ▼         ▼         ▼
    [ osrm-partition (Recursive bisection into MLD cell hierarchy) ]
         │         │         │
         ▼         ▼         ▼
    [ osrm-customize (Initial metric weights & speed bounds) ]
         │         │         │
         ▼         ▼         ▼
  [ car.osrm.* ] [ bike.osrm.* ] [ cng.osrm.* ]
```

### 3.1 Automated Multi-Profile Compilation Script
```bash
#!/usr/bin/env bash
# scripts/build-osrm-graphs.sh
set -eo pipefail

DATA_DIR="/opt/dpmaps/data"
PROFILES_DIR="/opt/dpmaps/profiles"
IMAGE="ghcr.io/project-osrm/osrm-backend:v5.27.1"
EXTRACT_URL="https://download.geofabrik.de/asia/bangladesh-latest.osm.pbf"

mkdir -p "${DATA_DIR}"/{car,bike,cng}

echo "=== [Step 1/4] Downloading Geofabrik Bangladesh OSM PBF ==="
if [ ! -f "${DATA_DIR}/bangladesh-latest.osm.pbf" ]; then
  curl -sSL "${EXTRACT_URL}" -o "${DATA_DIR}/bangladesh-latest.osm.pbf"
else
  echo "Extract already exists. Validating size..."
  stat -c %s "${DATA_DIR}/bangladesh-latest.osm.pbf"
fi

PROFILES=("car" "bike" "cng")

for PROFILE in "${PROFILES[@]}"; do
  echo "=========================================================="
  echo "=== Compiling MLD Graph for Profile: ${PROFILE} ==="
  echo "=========================================================="

  TARGET_DIR="${DATA_DIR}/${PROFILE}"
  cp "${DATA_DIR}/bangladesh-latest.osm.pbf" "${TARGET_DIR}/bangladesh.osm.pbf"

  # Step 2: Extract
  echo "-> Running osrm-extract (${PROFILE})..."
  docker run --rm -t \
    -v "${TARGET_DIR}:/data" \
    -v "${PROFILES_DIR}:/profiles" \
    "${IMAGE}" \
    osrm-extract -p "/profiles/${PROFILE}.lua" /data/bangladesh.osm.pbf

  # Remove duplicate PBF to save disk space
  rm -f "${TARGET_DIR}/bangladesh.osm.pbf"

  # Step 3: Partition
  echo "-> Running osrm-partition (${PROFILE})..."
  docker run --rm -t \
    -v "${TARGET_DIR}:/data" \
    "${IMAGE}" \
    osrm-partition /data/bangladesh.osrm

  # Step 4: Customize
  echo "-> Running osrm-customize (${PROFILE})..."
  docker run --rm -t \
    -v "${TARGET_DIR}:/data" \
    "${IMAGE}" \
    osrm-customize /data/bangladesh.osrm

  echo "=== Profile ${PROFILE} compilation completed successfully ==="
done
```

---

## 4. Near-Zero-Downtime Hot-Reload Architecture

### 4.1 The Flaw of In-Place Disk Customization
Running `osrm-customize` on disk files while `osrm-routed` memory-maps them can corrupt mapped pages, leading to segmentation faults (`SIGSEGV`) or race conditions. OSRM requires an explicit mechanism to swap graph weights without dropping in-flight dispatch queries.

### 4.2 Production Solution: Shared-Memory IPC (`osrm-datastore`)
On Linux, OSRM supports shared memory blocks (`sysvipc` / POSIX shm). `osrm-datastore` loads graph data into shared memory; `osrm-routed --shared-memory=yes` serves from it. Weight updates run `osrm-customize` (rewriting the metric files on disk) followed by `osrm-datastore` (loading the refreshed weights), after which `osrm-routed` re-attaches to the freshly loaded region:

```
                 [ Shared Memory Segment A (ACTIVE) ] ◄─── [ osrm-routed reads ]
                                      ▲
                                      │ Reload (IPC handshake)
                 [ Shared Memory Segment B (PENDING) ] ◄─── [ osrm-datastore loads ]
```

```bash
# 1. Start osrm-datastore to allocate initial shared memory
docker run -d --name dpmaps-osrm-car-shm \
  --ipc=host \
  -v /opt/dpmaps/data/car:/data \
  ghcr.io/project-osrm/osrm-backend:v5.27.1 \
  osrm-datastore /data/bangladesh.osrm

# 2. Run osrm-routed attached to shared memory (zero local file mapping)
docker run -d --name dpmaps-osrm-car \
  --ipc=host \
  -p 5001:5000 \
  ghcr.io/project-osrm/osrm-backend:v5.27.1 \
  osrm-routed --algorithm mld --shared-memory=yes

# 3. Reload graph with updated traffic speeds (typically < 2 seconds [ESTIMATE])
docker run --rm --ipc=host \
  -v /opt/dpmaps/data/car:/data \
  -v /opt/dpmaps/traffic:/traffic \
  ghcr.io/project-osrm/osrm-backend:v5.27.1 \
  sh -c "osrm-customize /data/bangladesh.osrm --segment-speed-file /traffic/speeds-car-<bucket>.csv && osrm-datastore /data/bangladesh.osrm"
```

### 4.3 Containerized Blue/Green Fallback Architecture
For container environments where shared memory IPC across containers is restricted, Stage 004 implements a **Blue/Green Container Pair**:
- Port 5011 (Blue) and Port 5012 (Green) run identical `car` engines.
- Internal NGINX directs production traffic to Blue.
- The traffic pipeline runs `osrm-customize` on Green's graph.
- Green is health-checked with a synthetic probe query (`/route/v1/driving/90.4125,23.8103;90.4071,23.7925`).
- NGINX reloads configuration (`nginx -s reload`) to point to Green (near-zero downtime, in-flight requests drain).
- Blue becomes the standby target for the next cycle.

---

## 5. Localized Bangladeshi Vehicle Routing Profiles (Lua)

Dhaka traffic cannot be modeled with generic European or American vehicle profiles. Stage 004 implements three specialized profiles.

**Encoding rules (all profiles):**
1. **Tag-first access.** Decisions use structured OSM tags (`access`, `motor_vehicle`, `motorcycle`, `width`, `highway`, `motorroad`, `oneway`) before any name matching.
2. **Curated way-ID blocklist.** Verified restrictions are maintained as a reviewed way-ID list (`profiles/restricted_ways_<vehicle>.txt`), not substring name matching. Name regex remains only as a secondary safety net.
3. **`[UNVERIFIED]` regulations.** Traffic regulations (expressway 2-wheeler bans, CNG route restrictions, VIP-road hour rules) are **not established facts** in this repository. They are encoded as configurable lists in `system_config`, **default-off**, and enabled only after written verification. `[UNVERIFIED — verify with counsel/local regulation]`
4. **Time-dependent restrictions** (VIP roads "during designated hours") cannot be expressed in static Lua. They are implemented as **per-bucket weight multipliers** in the TOD customize pipeline (§6.5): restricted segments receive a configurable penalty multiplier during restricted buckets. `[ESTIMATE default multiplier 5×, admin-configurable]`

### 5.1 Motorbike Profile (`profiles/bike.lua`)
Motorbikes are a large share of Dhaka ride-hailing volume `[ESTIMATE/UNVERIFIED — "60%+" not confirmed; measure from orders]`. They navigate narrow informal settlements and maintain progress during gridlock:

```lua
-- profiles/bike.lua (Key excerpts)
local Set = require('lib/set')
local Handlers = require('lib/way_handlers')

function setup()
  return {
    properties = {
      max_speed_for_map_matching     = 80/3.6, -- 80 km/h [ESTIMATE]
      weight_name                    = 'duration',
      process_call_tagless_node      = false,
      u_turn_penalty                 = 15,     -- [ESTIMATE] bikes turn easily
      continue_straight_at_waypoint  = false,
      use_turn_restrictions          = true,
      left_hand_driving              = true    -- Bangladesh drives on the left
    },
    -- Motorbikes are motor vehicles: driving mode throughout (F-004-8 repair)
    default_mode              = mode.driving,
    default_speed             = 25,            -- [ESTIMATE] average urban speed km/h

    -- Narrow alleys accessible to 2-wheelers
    traffic_alley_min_width   = 1.2,           -- [ESTIMATE] minimum alley width meters

    -- Curated restriction set (populated ONLY from verified regulation)
    banned_ways_file          = 'restricted_ways_bike.txt'
  }
end

function process_way(profile, way, result, relations)
  local data = {
    highway = way:get_value_by_key('highway'),
    access  = way:get_value_by_key('access'),
    motorcycle = way:get_value_by_key('motorcycle'),
    motorroad = way:get_value_by_key('motorroad'),
    width   = way:get_value_by_key('width')
  }

  -- Tag-first exclusion; curated way-ID blocklist applied by the loader
  if data.access == 'no' or data.motorcycle == 'no' or data.motorroad == 'yes' then
    return
  end

  -- Permit residential, living_street, service, and unclassified alleys
  if data.highway == 'residential' or data.highway == 'living_street' or
     data.highway == 'service' or data.highway == 'unclassified' then
    result.forward_mode = mode.driving
    result.backward_mode = mode.driving
    result.forward_speed = 22   -- [ESTIMATE]
    result.backward_speed = 22  -- [ESTIMATE]
    return
  end

  Handlers.default_speeds(profile, way, result)
end
```

### 5.2 CNG Auto-Rickshaw Profile (`profiles/cng.lua`)
Three-wheeled motorized auto-rickshaws have distinct mechanical and regulatory bounds:
- **Mechanical top speed:** clamped at 45 km/h `[ESTIMATE — verify with fleet specs]`.
- **Route restrictions** (expressway, flyover upper deck, Padma Bridge): `[UNVERIFIED]` — encoded as configurable curated way-ID lists, default-off until verified.
- **VIP-road hour protocols:** `[UNVERIFIED]` — implemented via §6.5 per-bucket weight multipliers, default-off.

```lua
-- profiles/cng.lua (Key excerpts)
function setup()
  return {
    properties = {
      max_speed_for_map_matching     = 45/3.6, -- 45 km/h top speed [ESTIMATE]
      weight_name                    = 'duration',
      u_turn_penalty                 = 35,     -- [ESTIMATE] 3-wheelers turn slowly
      left_hand_driving              = true
    },
    default_mode = mode.driving,
    default_speed = 20,                        -- [ESTIMATE]
    banned_ways_file = 'restricted_ways_cng.txt'
  }
end

function process_way(profile, way, result, relations)
  local highway = way:get_value_by_key('highway')
  local motor_vehicle = way:get_value_by_key('motor_vehicle')
  local access = way:get_value_by_key('access')

  -- Tag-first exclusion; curated way-ID blocklist (verified restrictions only)
  if motor_vehicle == 'no' or access == 'no' then
    return
  end

  -- Cap maximum speed on primary/trunk roads
  if highway == 'primary' or highway == 'trunk' then
    result.forward_speed = 35    -- [ESTIMATE] within the 45 km/h clamp
    result.backward_speed = 35   -- [ESTIMATE]
    result.forward_mode = mode.driving
    result.backward_mode = mode.driving
    return
  end
end
```

### 5.3 Car Profile (`profiles/car.lua`)
- **Alley Filtering:** blocks alleys where `width < 2.5m` `[ESTIMATE]` or tagged `motor_vehicle=no` (tag-first).
- **One-Way Enforcement:** honors `oneway` in congested commercial cores (Motijheel, Old Dhaka, Banani, Dhanmondi) — OSRM default, explicitly tested.
- **Expressway Routing:** Elevated expressway links (where access-verified) receive higher speed weights (60–80 km/h `[ESTIMATE]`).

---

## 6. Dynamic Traffic Harvesting, TOD Speed Buckets & Learned ETA Correction

Dhaka speeds vary drastically: a segment flowing at 45 km/h at midnight crawls at 6 km/h `[ESTIMATE illustration]` during evening rush hour. Static MLD weights cannot represent this (F-004-1). Stage 004 builds a continuous first-party velocity feedback loop with explicit TOD modeling:

```
[ Active Driver Handsets (10s GPS Pings — concept paper §15.4) ]
                     │
                     ▼
[ Ingestion & Noise Filtering (workers/trafficHarvester.ts) ]
  ├── Kalman filter smoothing on raw coordinates
  ├── Drop pings with speed < 2 km/h sustained > 30s (halt filter)
  └── Map-match against the vehicle's OWN profile engine (car:5001 / bike:5002 / cng:5003)
                     │
                     ▼
[ Per-Edge Speed Extraction (annotation arrays: nodes[N], duration[N-1], distance[N-1]) ]
                     │
        ┌────────────┴─────────────┐
        ▼                          ▼
[ OSM Node-Pair × TOD Bucket ]   [ H3 Res-10 Directed Edge × TOD Bucket ]
  → dpmaps.segment_speeds_tod      → dpmaps.h3_edge_speeds_tod (res-9 rollup)
  (feeds osrm-customize)           (feeds analytics & ETA correction)
                     │
                     ▼
[ Bucket-Boundary Reload (every 30 min, per profile) ]
  speeds-<profile>-<bucket>.csv → osrm-customize → osrm-datastore (or Blue/Green swap)
                     │
                     ▼
[ Learned ETA Correction Layer ]  T_hat = k(v,b) · T_osrm
  k(v,b) = median(actual_driven_duration_s / osrm_duration_s) from dpmaps.routing_eval_events
```

### 6.1 Per-Edge Speed Extraction via `/match` API
Map-matching runs on dpMaps' own OSRM with **first-party GPS** (driver GPS is ground truth). OSM node identifiers are ODbL-derived graph identifiers used in the isolated OSM layer; never merged into `public_pois`.

```typescript
// workers/trafficHarvester.ts
// Runs only when: routing_provider_mode in {shadow, primary, sole}
//   AND system_config.traffic_harvest_enabled = true
//   AND Stage 002 Legal Gate Items 3, 7, 14, 15, 16, 17 signed off.
import axios from 'axios';

interface EdgeSpeedRecord {
  fromNode: number;
  toNode: number;
  speedKmh: number;
  todBucket: 'morning_peak' | 'evening_peak' | 'off_peak' | 'night';
  vehicleType: 'car' | 'bike' | 'cng';
}

export async function extractSegmentSpeeds(
  gpsTrace: { lat: number; lng: number; timestamp: number }[],
  vehicleType: 'car' | 'bike' | 'cng'
): Promise<EdgeSpeedRecord[]> {
  // Pre-filter: drop stationary halts (pickup/dropoff waiting)
  const movingPoints = filterStationaryHalts(gpsTrace);
  if (movingPoints.length < 3) return [];

  // F-004-11 repair: match against the vehicle's own profile graph
  const enginePort = { car: 5001, bike: 5002, cng: 5003 }[vehicleType];
  const coords = movingPoints.map(p => `${p.lng},${p.lat}`).join(';');
  const timestamps = movingPoints.map(p => Math.round(p.timestamp / 1000)).join(';');

  const url = `http://localhost:${enginePort}/match/v1/driving/${coords}`
    + `?timestamps=${timestamps}&annotations=nodes,duration,distance&geometries=geojson`;

  const response = await axios.get(url, { timeout: 1500 });
  if (response.data.code !== 'Ok') return [];

  const records: EdgeSpeedRecord[] = [];
  const todBucket = resolveTodBucket(movingPoints[0].timestamp); // §6.4 boundaries

  for (const match of response.data.matchings) {
    if ((match.confidence ?? 1) < 0.6) continue; // [ESTIMATE] discard low-confidence matches
    for (const leg of match.legs) {
      const nodes: number[] = leg.annotation?.nodes ?? [];      // N entries
      const durations: number[] = leg.annotation?.duration ?? []; // N-1 per-edge seconds
      const distances: number[] = leg.annotation?.distance ?? []; // N-1 per-edge meters

      // F-004-2 repair: per-edge values from parallel annotation arrays
      for (let i = 0; i < nodes.length - 1 && i < durations.length; i++) {
        const t = durations[i];
        const d = distances[i];
        if (t <= 0 || d <= 0) continue;
        const speedKmh = Math.min(100, Math.max(3, (d / t) * 3.6)); // clamp 3–100 [ESTIMATE]
        records.push({
          fromNode: nodes[i],
          toNode: nodes[i + 1],
          speedKmh: Math.round(speedKmh),
          todBucket,
          vehicleType
        });
      }
    }
  }

  return records;
}
```

### 6.2 Harmonic Mean Aggregation & Bucketed Storage
Edge speeds aggregate with the **harmonic mean** so a single speeding vehicle cannot skew congestion estimates:

$$v_{\text{harmonic}} = \frac{N}{\sum_{i=1}^N \frac{1}{v_i}}$$

Aggregation keys: **(from_osm_node, to_osm_node, tod_bucket, vehicle_type)** and, per concept paper §15.4, **H3 directed edge pairs** at res 10 (res 9 rollup) for analytics and correction learning.

```sql
-- Proposed DDL — pending Stage 003 adoption (Rev 2.3 patch); see cross-plan note X-2.
-- First-party measurements keyed by ODbL-derived OSM node identifiers (isolated OSM layer).
CREATE TABLE dpmaps.segment_speeds_tod (
  from_osm_node BIGINT NOT NULL,
  to_osm_node BIGINT NOT NULL,
  tod_bucket VARCHAR(16) NOT NULL
    CHECK (tod_bucket IN ('morning_peak', 'evening_peak', 'off_peak', 'night')),
  vehicle_type VARCHAR(16) NOT NULL CHECK (vehicle_type IN ('car', 'bike', 'cng')),
  harmonic_speed_kmh NUMERIC(5, 2) NOT NULL,
  sample_count INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_osm_node, to_osm_node, tod_bucket, vehicle_type)
);

CREATE TABLE dpmaps.h3_edge_speeds_tod (
  h3_from VARCHAR(15) NOT NULL,
  h3_to VARCHAR(15) NOT NULL,
  tod_bucket VARCHAR(16) NOT NULL
    CHECK (tod_bucket IN ('morning_peak', 'evening_peak', 'off_peak', 'night')),
  vehicle_type VARCHAR(16) NOT NULL CHECK (vehicle_type IN ('car', 'bike', 'cng')),
  harmonic_speed_kmh NUMERIC(5, 2) NOT NULL,
  sample_count INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (h3_from, h3_to, tod_bucket, vehicle_type)
);
```

### 6.3 Bucketed Speed CSV & Fallback Hierarchy
At each bucket boundary the worker emits one CSV per profile for the **active** bucket:

```csv
# from_osm_node,to_osm_node,speed
104829102,104829103,14
104829103,104829104,12
839120192,839120193,8
```

**Fallback hierarchy** when an (edge, bucket) pair has fewer than `min_samples` observations `[ESTIMATE: min_samples = 5]`:
1. Same edge, same bucket, exponentially smoothed across recent days (α `[ESTIMATE: 0.3]`);
2. Same edge, adjacent bucket;
3. Same edge, all-day harmonic mean;
4. Profile default speed from Lua.

### 6.4 TOD Bucket Boundaries
Buckets match the Stage 003 CHECK enumeration (`morning_peak`, `evening_peak`, `off_peak`, `night`). Boundaries are admin-configurable in `system_config` (Asia/Dhaka). Defaults `[ESTIMATE — tune against order/GPS telemetry]`:

| Bucket | Default window (Asia/Dhaka) |
|---|---|
| `morning_peak` | 07:00–11:00 |
| `evening_peak` | 16:00–21:00 |
| `night` | 00:00–05:00 |
| `off_peak` | all remaining hours |

### 6.5 Bucket-Boundary Reload & Restricted-Segment Penalties
- **Reload cadence:** at each 30-minute bucket boundary (and hourly within-bucket refinement), per profile: regenerate `speeds-<profile>-<bucket>.csv`, run `osrm-customize --segment-speed-file`, then `osrm-datastore` (or Blue/Green swap, §4.3).
- **Hour-dependent restrictions** (e.g., VIP-road hour rules `[UNVERIFIED]`): the CSV writer multiplies restricted segments' effective speeds by a configurable penalty (i.e., inflates duration weight) during restricted buckets. `[ESTIMATE default multiplier 5×; default-off until verified]`

### 6.6 Learned ETA Correction Layer (Read-Time, Zero Write Amplification)
OSRM returns raw duration $T_{\text{osrm}}$. The dispatch ETA is corrected per vehicle type $v$ and TOD bucket $b$:

$$\hat{T} = k(v, b) \cdot T_{\text{osrm}}, \qquad k(v, b) = \operatorname{median}_{w \in W} \left( \frac{T_{\text{actual}}(w)}{T_{\text{osrm}}(w)} \right)$$

- $W$ = trailing evaluation window `[ESTIMATE: 14 days]`, recomputed daily from `dpmaps.routing_eval_events` (first-party actuals vs first-party OSRM quotes only — **never vendor values**).
- Clamp $k \in [0.5,\ 2.0]$ `[ESTIMATE]`; if fewer than `[ESTIMATE: 30]` samples exist for $(v,b)$, use $k = 1.0$.
- Persisted factors:

```sql
-- Proposed DDL — pending Stage 003 adoption (Rev 2.3 patch); see cross-plan note X-2.
CREATE TABLE dpmaps.eta_tod_corrections (
  vehicle_type VARCHAR(16) NOT NULL CHECK (vehicle_type IN ('car', 'bike', 'cng')),
  tod_bucket VARCHAR(16) NOT NULL
    CHECK (tod_bucket IN ('morning_peak', 'evening_peak', 'off_peak', 'night')),
  k_factor NUMERIC(6, 4) NOT NULL,
  sample_count INTEGER NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (vehicle_type, tod_bucket, window_end)
);
```

- This layer learns from first-party post-trip reality only, satisfying Hard Rule 1. It does not ingest vendor quotes (those are evaluated separately via `vendor_*_error_pct` percentages in `routing_eval_events`).

---

## 7. OSM Dhaka Road Geometry Completeness & Connectivity Audit

Before OSRM can be promoted to Primary routing (Phase 2), engineering conducts an empirical geometry completeness audit across three known failure modes in Dhaka. Dhaka OSM completeness is currently **UNMEASURED `[UNVERIFIED]`** (concept paper §15.4):

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        DHAKA ROAD GEOMETRY AUDIT SUITE                                 │
├─────────────────────┬────────────────────────────────────┬─────────────────────────────┤
│ Target Domain       │ Vulnerability / Failure Mode       │ Verification Test Suite     │
├─────────────────────┼────────────────────────────────────┼─────────────────────────────┤
│ 1. Old Dhaka        │ Disconnected narrow alleyways;     │ Probe 1,000 OD pairs (run   │
│    Alleys           │ dead ends mapped without turn bays │ expandable to 5,000) across │
│                     │ in Lalbagh, Chawkbazar, Sutrapur.  │ Lalbagh and Chawkbazar, on  │
│                     │                                    │ ALL THREE profiles. Failure │
│                     │                                    │ rate must be < 1.5% [EST].  │
├─────────────────────┼────────────────────────────────────┼─────────────────────────────┤
│ 2. Arterial Median  │ Unmapped physical barrier breaks   │ Inspect 25 major U-turn     │
│    Openings         │ forcing 4 km detour loops along    │ openings on Airport Road,   │
│                     │ Airport Road, Pragati Sarani, etc. │ Pragati Sarani, Mirpur Rd.  │
├─────────────────────┼────────────────────────────────────┼─────────────────────────────┤
│ 3. Flyovers &       │ Missing on-ramp / off-ramp links   │ Validate directional ramps  │
│    Elevated Roads   │ on Mayor Hanif, Moghbazar, and     │ for Kawla, Tejgaon, and     │
│                     │ Dhaka Elevated Expressway.         │ Farmgate interchanges.      │
└─────────────────────┴────────────────────────────────────┴─────────────────────────────┘
```

### 7.1 Automated Connectivity Verification Script
```bash
#!/usr/bin/env bash
# scripts/audit-dhaka-connectivity.sh
# Tests routing connectivity across OD pairs in Old Dhaka on ALL THREE profile engines
# F-004-9 repair: unified 1,000 OD-pair probe set (expandable to 5,000); all profiles

TEST_FILE="tests/golden/old_dhaka_probes.jsonl"   # one JSON object per line
FAILURES=0
TOTAL=0

echo "Running Old Dhaka connectivity test..."
while read -r OD; do
  ORIGIN=$(echo "$OD" | jq -r '.origin')
  DEST=$(echo "$OD" | jq -r '.dest')

  for PORT in 5001 5002 5003; do                 # car, bike, cng
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      "http://localhost:${PORT}/route/v1/driving/${ORIGIN};${DEST}?overview=false")

    if [ "$HTTP_STATUS" -ne 200 ]; then
      FAILURES=$((FAILURES + 1))
    fi
    TOTAL=$((TOTAL + 1))
  done
done < "${TEST_FILE}"

FAIL_RATE=$(awk "BEGIN {print ($FAILURES / $TOTAL) * 100}")
echo "Completed ${TOTAL} probes. Failures: ${FAILURES} (${FAIL_RATE}%)"

if (( $(echo "$FAIL_RATE > 1.5" | bc -l) )); then
  echo "FAIL: Routing disconnect rate exceeds 1.5% SLA [ESTIMATE]. JOSM road patching required."
  exit 1
fi
echo "SUCCESS: Connectivity meets SLA."
```

---

## 8. High-Availability, Circuit Breaker, Fallback Waterfall Contract & Definition of Done

### 8.1 Circuit Breaker & Health Checks
```
[ Dispatch Service (Stage 005 waterfall) ]
        │
        ▼
[ OSRM Client with Circuit Breaker ]
  ├── Request Timeout: 300 ms (canonical contract, concept paper §18; F-004-3 repair)
  ├── Fallback: 3 consecutive failures (5xx or timeout) opens the breaker;
  │   Stage 005 waterfall continues to Barikoi while the breaker is open
  └── Health Check: polls /healthz on a 5-second interval [ESTIMATE]
```

Every container exposes `/healthz` verifying:
1. Shared memory segment attached and accessible;
2. Synthetic test route executes within `[ESTIMATE: 15 ms]`;
3. Graph freshness: alert when graph age exceeds **2× the configured rebuild interval** (default weekly rebuild; Geofabrik update cadence `[UNVERIFIED]`) — replaces the hardcoded 36-hour check (F-004-10).

### 8.2 Canonical Timeout & Fallback Contract (owned by Stage 005)
| Leg | Timeout | Notes |
|---|---|---|
| 1. OSRM (dpMaps) | 300 ms | Circuit breaker above |
| 2. Barikoi (vendor wrapper, Stage 002) | 400 ms | Logged as anomaly |
| 3. Google (spend-capped emergency) | 600 ms | Circuit-breaker + spend cap (Stage 005 §7) |
| 4. Floor: Haversine × 1.3 | 0 ms | Zero dropped orders |

### 8.3 Relative ETA Cutover Gates (never flat minutes)
All ETA criteria are **percentages of real trip duration**, benchmarked against the driver's end-of-trip GPS ground truth and against Barikoi's own measured error on the same trips (concept paper §14.3; AGENTS.md §3). **A threshold like "±5 minutes" is forbidden anywhere in this system.**

Per-trip relative errors:

$$e_T = \frac{|T_{\text{pred}} - T_{\text{actual}}|}{T_{\text{actual}}} \times 100\%, \qquad e_D = \frac{|D_{\text{pred}} - D_{\text{actual}}|}{D_{\text{actual}}} \times 100\%$$

Corridor overlap against the **dpMaps quoted geometry** $\Gamma_{\text{osrm}}$ (never vendor geometry), driven fixes $p_i$:

$$\text{overlap\_pct} = 100 \times \frac{\#\{\, p_i : \mathrm{dist}(p_i, \Gamma_{\text{osrm}}) \le 50\text{ m} \,\}}{\#\{\, p_i \,\}} \qquad [ESTIMATE\ buffer\ radius]$$

| Gate | Criterion (per vehicle type, evaluated weekly) | Threshold |
|---|---|---|
| **Gate 1 → primary** | Median $e_T$ | ≤ 12% of trip duration |
| | p95 $e_T$ | ≤ 25% of trip duration |
| | Vendor parity | median $e_T^{\text{dpMaps}}$ ≤ median $e_T^{\text{Barikoi}}$ on the same trip sample |
| | Median $e_D$ | ≤ 3.0% |
| | Corridor overlap | ≥ 85% |
| | Local OSRM latency | p95 ≤ 8 ms `[ESTIMATE]` |
| | Sustain | 3 consecutive ISO weeks; zero severity-1 crash regressions |
| **Gate 2 → sole** | Median $e_T$ / p95 $e_T$ | ≤ 10% / ≤ 20% of trip duration |
| | Median $e_D$ | ≤ 2.5% |
| | Corridor overlap | ≥ 92% |
| | Vendor parity | sustaining parity or superiority for 4 consecutive weeks |
| | Plus | 24-hour vendor-off rehearsal day (Stage 005/015) |

### 8.4 Deliverables & Definition of Done

- [ ] Dockerized 3-container topology deployed serving Car (5001), Bike (5002), and CNG (5003).
- [ ] Internal NGINX routing gateway on Port 5000 dispatching by vehicle-type path prefix.
- [ ] Automated download and contraction pipeline (`build-osrm-graphs.sh`) operational on the 339 MB Geofabrik Bangladesh extract `[VERIFIED size]`.
- [ ] Lua profiles (`car.lua`, `bike.lua`, `cng.lua`) implemented with tag-first access, curated way-ID blocklists, `mode.driving` semantics for motorbikes, and all `[UNVERIFIED]` regulation lists default-off.
- [ ] TOD speed pipeline operational: per-edge annotation extraction (per-vehicle engine), harmonic-mean aggregation into `segment_speeds_tod` / `h3_edge_speeds_tod`, bucket-boundary `osrm-customize` + reload, fallback hierarchy (§6.3).
- [ ] Learned ETA correction layer $k(v,b)$ recomputed daily from `routing_eval_events`; clamp and min-sample rules enforced (§6.6).
- [ ] Shared memory (`osrm-datastore`) and blue/green rotation tested under load; near-zero-downtime reload demonstrated.
- [ ] Dhaka connectivity audit executed across 1,000 OD probes **on all three profiles**; failure rate verified below 1.5% `[ESTIMATE SLA]`.
- [ ] Circuit breaker (3-strike) and health checks operational with the 300 ms canonical timeout; graph-freshness alert tied to rebuild cadence.
- [ ] Route latency benchmark executed on the real graph; results recorded in the verification registry (replacing `[ESTIMATE]` labels).
- [ ] Relative ETA cutover harness (§8.3) implemented; flat-minute thresholds demonstrably absent.
- [ ] **Stage 002 Legal Gate Verified:** shadow benchmarking and GPS harvesting confirmed to await written counsel sign-off on Items 3, 7, 14, 15, 16, and 17.

---

## 9. Revision Changelog

| Revision | Date | Author / Context | Summary of Major Changes |
|---|---|---|---|
| Rev 2.0 | 2026-10-22 | Orchestrator (audited baseline) | High-performance OSRM MLD baseline: 3-profile topology, `osrm-datastore`/blue-green reload, Lua profiles, traffic harvester, Dhaka geometry audit, circuit breaker. |
| Rev 2.1 | 2026-10-22 | Lead Planning & Systems Architecture (audit 004-005) | **TOD-Learned ETA & Contract Repairs:**<br>1. **§6 TOD pipeline (F-004-1):** Replaced day-averaged `speeds-current.csv` with persisted per-(edge × 30-min bucket × vehicle) harmonic-mean speeds (`segment_speeds_tod`, `h3_edge_speeds_tod`), bucket-boundary `osrm-customize` reload, fallback hierarchy, and a learned multiplicative ETA correction layer $\hat{T}=k(v,b)\cdot T_{\text{osrm}}$ computed from first-party `routing_eval_events` only.<br>2. **Map-match correctness (F-004-2, F-004-11):** Per-edge annotation arrays (`nodes[N]`, `duration[N-1]`, `distance[N-1]`) replace leg-average speeds; matching runs against the vehicle's own profile engine; low-confidence matchings discarded.<br>3. **Timeout contract (F-004-3, X-3):** OSRM client timeout reconciled to 300 ms (concept paper §18); full waterfall delegated to Stage 005 with canonical 300/400/600/0 ms legs.<br>4. **Relative ETA cutover gates (F-004-4):** New §8.3 with $e_T$, $e_D$, corridor-overlap formulas; median ≤ 12% / p95 ≤ 25% of trip duration (Gate 1), ≤ 10% / ≤ 20% (Gate 2), vendor-parity clause; explicit flat-minute prohibition.<br>5. **Profile realism (F-004-6, F-004-7, F-004-8):** Tag-first access, curated way-ID blocklists replace name-substring bans; time-dependent VIP restrictions moved to per-bucket weight multipliers (default-off); regulatory claims labeled `[UNVERIFIED]`; bike profile unified on `mode.driving`.<br>6. **Integrity labeling (F-004-5, F-004-12):** All sizing/latency/throughput/RSS/volume figures labeled `[ESTIMATE]` or `[UNVERIFIED]` per concept paper §21 and AGENTS.md §10; absolute-claim language softened.<br>7. **Audit suite (F-004-9, F-004-10):** Unified 1,000-OD probe set (expandable to 5,000) across all three engines; graph-freshness alert tied to rebuild cadence instead of a hardcoded 36 h. |
