# Stage 004: OSRM Routing Engine & Dynamic Traffic Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-004 (Revision 2.0 — High-Performance OSRM Routing Engine & Dynamic Traffic)  
**Stage:** 4 of 16 (Routing Core & Traffic Engineering)  
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§4, §15.4, §17.1–17.2, §18)  
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)  
**Current Status:** **NotDone**  

---

## 1. Executive Summary & Objective

In high-concurrency ride-hailing dispatch, route calculation latency is a critical performance bottleneck. Commercial mapping vendor APIs (Google Routes, Barikoi) introduce **150–400ms of external network latency** per calculation, incur steep per-query billing costs, and expose the platform to vendor lock-in. Furthermore, commercial routing algorithms are calibrated for Western traffic models and fail to account for Dhaka’s unique multi-modal mobility: motorbikes weaving through gridlock, CNG auto-rickshaws restricted from VIP arterials, and narrow informal alleyways inaccessible to four-wheelers.

Stage 004 delivers a sovereign, sub-5ms in-memory routing infrastructure utilizing the **Open Source Routing Machine (OSRM)**:
1. **Multi-Instance Container Topology:** Deploys a 3-container architecture serving distinct vehicle profiles (**Car**, **Motorbike**, **CNG Auto-rickshaw**) behind an internal high-throughput routing gateway.
2. **Multi-Level Dijkstra (MLD) Graph Compilation:** Pre-processes the verified 339 MB Geofabrik Bangladesh OpenStreetMap extract into partitioned cell hierarchies supporting dynamic edge-weight customization.
3. **Zero-Downtime Hot-Reloading (`osrm-datastore` & Blue/Green):** Implements shared-memory IPC and blue/green container rotation, allowing hourly traffic updates without service interruption or query drops.
4. **Bangladeshi Vehicle Lua Profiles:** Codifies local traffic rules into Lua profiles: vehicle width thresholds, Dhaka Elevated Expressway restrictions, flyover ramps, and congestion velocity baselines.
5. **First-Party Dynamic Traffic Harvesting:** Derives harmonic mean edge velocities from 10-second driver GPS pings, feeding hourly `osrm-customize` updates while strictly complying with Stage 002 clean-room invariants.
6. **OSM Dhaka Geometry Completeness Audit:** Establishes rigorous test probes across Old Dhaka alleys, median openings, and flyovers to systematically identify and patch map defects prior to cutover.

> [!CAUTION]
> ### MANDATORY LEGAL GATE PREREQUISITE
> In accordance with Stage 002 Rev 2.2 and `000_TOC.md`, Phase 1 shadow benchmarking and driver GPS harvesting cannot commence until **Stage 002 Legal Matrix Items 3, 7, 14, 15, 16, and 17** (specifically Item 17: Driver GPS Consent, and Item 7: Vendor Contract Compliance) are formally signed off by external legal counsel.

---

## 2. Multi-Profile Topology & Hardware Sizing

In OSRM, an `osrm-routed` process serves exactly **one** contracted dataset for **one** vehicle profile. To support Ride’s multi-modal vehicle fleet simultaneously, the routing backend deploys three isolated OSRM engines behind a reverse proxy router:

```
                                [ RIDE BACKEND DISPATCH ]
                                            │
                                            ▼
                          [ NGINX INTERNAL ROUTING GATEWAY ]
                                     (Port 5000)
                   ┌────────────────────────┼────────────────────────┐
                   │ /route/v1/car/...      │ /route/v1/bike/...     │ /route/v1/cng/...
                   ▼                        ▼                        ▼
       ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐
       │   dpmaps-osrm-car    │ │   dpmaps-osrm-bike   │ │   dpmaps-osrm-cng    │
       │     (Port 5001)      │ │     (Port 5002)      │ │     (Port 5003)      │
       │ • car.lua profile    │ │ • bike.lua profile   │ │ • cng.lua profile    │
       │ • Min width: 2.5m    │ │ • Alleys down to 1.2m│ │ • Speed cap: 45 km/h │
       │ • Expressway allowed │ │ • Expressway barred  │ │ • VIP roads barred   │
       │ • RSS: ~2.4 GB       │ │ • RSS: ~2.6 GB       │ │ • RSS: ~2.2 GB       │
       └──────────────────────┘ └──────────────────────┘ └──────────────────────┘
                   │                        │                        │
                   └────────────────────────┼────────────────────────┘
                                            │
                                            ▼
                              [ SHARED STORAGE VOLUME ]
                           /opt/dpmaps/data/bangladesh/
```

### 2.1 Hardware Sizing & Memory Model

| Resource Metric | Staging / Phase 1 Shadow Tier | Scale Production Tier (10k–25k rides/day) |
|---|---|---|
| **Host Instance** | 8 vCPU (Dedicated AMD EPYC / Intel Xeon) | 16 vCPU (Dedicated Compute Optimized) |
| **RAM Allocation** | 16 GB DDR4/DDR5 ECC | 32 GB DDR4/DDR5 ECC |
| **Storage Allocation**| 100 GB NVMe SSD ($> 3,000$ IOPS) | 200 GB NVMe SSD ($> 10,000$ IOPS) |
| **Operating System** | Ubuntu 24.04 LTS (Kernel 6.8+) | Ubuntu 24.04 LTS (Kernel 6.8+) |
| **OSRM Version** | ghcr.io/project-osrm/osrm-backend:v5.27.1 | ghcr.io/project-osrm/osrm-backend:v5.27.1 |
| **Graph Algorithm** | Multi-Level Dijkstra (MLD) | Multi-Level Dijkstra (MLD) |
| **Graph Footprint** | Car: 2.4 GB, Bike: 2.6 GB, CNG: 2.2 GB | Total Graph RSS: ~7.2 GB (14.4 GB during Blue/Green) |
| **Throughput Target** | 1,500–2,500 routes/sec aggregate | 5,000–8,000 routes/sec aggregate |
| **Target Latency** | **Sub-5ms baseline (p95 < 8ms, p99 < 15ms)** | **Sub-4ms baseline (p95 < 6ms, p99 < 10ms)** |

---

## 3. Graph Ingestion & MLD Compilation Pipeline

The pipeline ingests the 339 MB national OpenStreetMap extract for Bangladesh (`bangladesh-latest.osm.pbf`) from Geofabrik. It compiles three distinct MLD graph structures corresponding to each vehicle profile.

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

## 4. Zero-Downtime Hot-Reload Architecture

### 4.1 The Flaw of In-Place Disk Customization
Running `osrm-customize` on disk files while `osrm-routed` is serving queries will corrupt memory-mapped pages, leading to segmentation faults (`SIGSEGV`) or race conditions. OSRM requires an explicit mechanism to swap graph weights without dropping in-flight dispatch queries.

### 4.2 Production Solution: Shared-Memory IPC (`osrm-datastore`)
In Linux environments, OSRM natively supports shared memory blocks (`sysvipc` / POSIX shm). The `osrm-datastore` tool loads new graph weights into an inactive shared memory segment, atomically updates the active segment pointer, and signals `osrm-routed`:

```
                 [ Shared Memory Segment A (ACTIVE) ] ◄─── [ osrm-routed reads ]
                                      ▲
                                      │ Pointer Swap (Atomic IPC)
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

# 3. Reload graph with updated traffic speeds atomically in < 2 seconds
docker run --rm --ipc=host \
  -v /opt/dpmaps/data/car:/data \
  -v /opt/dpmaps/traffic:/traffic \
  ghcr.io/project-osrm/osrm-backend:v5.27.1 \
  sh -c "osrm-customize /data/bangladesh.osrm --segment-speed-file /traffic/speeds-car.csv && osrm-datastore /data/bangladesh.osrm"
```

### 4.3 Containerized Blue/Green Fallback Architecture
For cloud container environments (e.g., Kubernetes, AWS ECS) where shared memory IPC across containers is restricted, Stage 004 implements a **Blue/Green Container Pair**:
- Port 5011 (Blue) and Port 5012 (Green) run identical `car` engines.
- Internal NGINX directs production traffic to Blue.
- `trafficHarvester` runs `osrm-customize` on Green's graph.
- Green is health-checked with a synthetic probe query (`/route/v1/driving/90.4125,23.8103;90.4071,23.7925`).
- NGINX reloads configuration (`nginx -s reload`) to point to Green (0ms downtime).
- Blue becomes the standby target for the next cycle.

---

## 5. Localized Bangladeshi Vehicle Routing Profiles (Lua)

Dhaka traffic cannot be modeled with generic European or American vehicle profiles. Stage 004 implements three specialized profiles:

### 5.1 Motorbike Profile (`profiles/bike.lua`)
Motorbikes represent 60%+ of Ride’s trip volume in Dhaka. They navigate narrow informal settlements and maintain progress even during total gridlock:

```lua
-- profiles/bike.lua (Key excerpts)
local Set = require('lib/set')
local Sequence = require('lib/sequence')
local Handlers = require('lib/way_handlers')

function setup()
  return {
    properties = {
      max_speed_for_map_matching     = 80/3.6, -- 80 km/h
      weight_name                    = 'duration',
      process_call_tagless_node      = false,
      u_turn_penalty                 = 15,     -- Low penalty: bikes turn easily
      continue_straight_at_waypoint  = false,
      use_turn_restrictions          = true,
      left_hand_driving              = true    -- Bangladesh drives on the left
    },
    default_mode              = mode.cycling,
    default_speed             = 25,            -- Average urban speed (km/h)
    
    -- Narrow alleys fully accessible to 2-wheelers
    traffic_alley_min_width   = 1.2,           -- Minimum alley width: 1.2 meters
    
    -- Excluded Infrastructure (Government banned)
    banned_highways = Set {
      'dhaka_elevated_expressway'
    }
  }
end

function process_way(profile, way, result, relations)
  local data = {
    highway = way:get_value_by_key('highway'),
    access  = way:get_value_by_key('access'),
    motorcycle = way:get_value_by_key('motorcycle'),
    name = way:get_value_by_key('name')
  }

  -- Dhaka Elevated Expressway strictly prohibits 2-wheelers
  if data.motorcycle == 'no' or data.access == 'no' or 
     (data.name and string.find(string.lower(data.name), 'elevated expressway')) then
    return
  end

  -- Permit residential, living_street, service, and unclassified alleys
  if data.highway == 'residential' or data.highway == 'living_street' or 
     data.highway == 'service' or data.highway == 'unclassified' then
    result.forward_mode = mode.driving
    result.backward_mode = mode.driving
    result.forward_speed = 22
    result.backward_speed = 22
    return
  end

  Handlers.default_speeds(profile, way, result)
end
```

### 5.2 CNG Auto-Rickshaw Profile (`profiles/cng.lua`)
Three-wheeled motorized auto-rickshaws have distinct mechanical and regulatory bounds:
- **Mechanical Top Speed:** Hard-clamped at 45 km/h.
- **Expressway & Bridge Restrictions:** Prohibited from the Dhaka Elevated Expressway, Mayor Hanif Flyover upper deck express lanes, and Padma Bridge.
- **VIP Road Protocols:** Restricted from entering VIP roads (Mirpur Road near PMO, Manik Mia Ave, Cantonment perimeter) during designated hours:

```lua
-- profiles/cng.lua (Key excerpts)
function setup()
  return {
    properties = {
      max_speed_for_map_matching     = 45/3.6, -- 45 km/h top speed
      weight_name                    = 'duration',
      u_turn_penalty                 = 35,     -- Heavy penalty: 3-wheelers turn slowly
      left_hand_driving              = true
    },
    default_speed = 20
  }
end

function process_way(profile, way, result, relations)
  local highway = way:get_value_by_key('highway')
  local motor_vehicle = way:get_value_by_key('motor_vehicle')
  local name = way:get_value_by_key('name')

  -- Ban 3-wheelers from elevated highways and bridges
  if motor_vehicle == 'no' or 
     (name and (string.find(string.lower(name), 'expressway') or string.find(string.lower(name), 'padma bridge'))) then
    return
  end

  -- Cap maximum speed on primary/trunk roads to 40 km/h
  if highway == 'primary' or highway == 'trunk' then
    result.forward_speed = 35
    result.backward_speed = 35
    result.forward_mode = mode.driving
    result.backward_mode = mode.driving
    return
  end
end
```

### 5.3 Car Profile (`profiles/car.lua`)
- **Alley Filtering:** Strictly blocks alleys where `width < 2.5m` or tagged `motor_vehicle=no`.
- **One-Way Enforcement:** Strictly honors one-way flow in congested commercial cores (Motijheel, Old Dhaka, Banani, Dhanmondi).
- **Expressway Routing:** Encourages Elevated Expressway access for airport-to-south routes by assigning elevated links a positive speed weight (60–80 km/h).

---

## 6. Dynamic Traffic Harvesting & Edge Weight Pipeline

Dhaka speeds vary drastically: a road segment flowing at 45 km/h at midnight crawls at 6 km/h during the evening rush hour. Stage 004 builds a continuous velocity feedback loop from driver telemetry:

```
[ Active Driver Handsets (10s GPS Pings) ]
                     │
                     ▼
[ Ingestion & Noise Filtering (workers/trafficHarvester.ts) ]
  ├── Kalman filter smoothing on raw coordinates
  ├── Drop pings with speed < 2 km/h & duration > 30s (passenger halt filter)
  └── Query OSRM /match?annotations=nodes to extract OSM node pairs
                     │
                     ▼
[ Segment Velocity Aggregator ]
  ├── Map matched points to OSM Node Pairs: (from_osm_node, to_osm_node)
  ├── Group by 30-minute time-of-day buckets
  └── Compute Harmonic Mean Speed: v_h = N / Σ(1/v_i)
                     │
                     ▼
[ speeds-current.csv Output ]
  Format: from_osm_node,to_osm_node,speed_kmh
                     │
                     ▼
[ Hot-Reload Execution (Hourly Schedule) ]
  osrm-customize --segment-speed-file /traffic/speeds-current.csv
```

### 6.1 Node Pair Extraction via `/match` API
The traffic harvester (`workers/trafficHarvester.ts`) submits batches of driver GPS traces to the internal OSRM `/match` endpoint requesting node annotations:

```typescript
// workers/trafficHarvester.ts
import axios from 'axios';

interface NodeSpeedRecord {
  fromNode: number;
  toNode: number;
  speedKmh: number;
}

export async function extractSegmentSpeeds(
  gpsTrace: { lat: number; lng: number; timestamp: number }[]
): Promise<NodeSpeedRecord[]> {
  // Pre-filter: drop stationary halts (pickup/dropoff waiting)
  const movingPoints = filterStationaryHalts(gpsTrace);
  if (movingPoints.length < 3) return [];

  const coords = movingPoints.map(p => `${p.lng},${p.lat}`).join(';');
  const timestamps = movingPoints.map(p => Math.round(p.timestamp / 1000)).join(';');

  const url = `http://localhost:5001/match/v1/driving/${coords}?timestamps=${timestamps}&annotations=nodes,duration,distance&geometries=geojson`;
  
  const response = await axios.get(url, { timeout: 1500 });
  if (response.data.code !== 'Ok') return [];

  const records: NodeSpeedRecord[] = [];

  for (const match of response.data.matchings) {
    for (const leg of match.legs) {
      const nodes: number[] = leg.annotation.nodes;
      const duration: number = leg.duration; // seconds
      const distance: number = leg.distance; // meters

      if (nodes.length >= 2 && duration > 0) {
        const speedKmh = Math.min(100, Math.max(3, (distance / duration) * 3.6));
        for (let i = 0; i < nodes.length - 1; i++) {
          records.push({
            fromNode: nodes[i],
            toNode: nodes[i + 1],
            speedKmh: Math.round(speedKmh)
          });
        }
      }
    }
  }

  return records;
}
```

### 6.2 Harmonic Mean Aggregation & Speed CSV Generation
To prevent a single speeding vehicle from skewing congestion estimates, edge speeds are aggregated using the **harmonic mean**:

$$v_{\text{harmonic}} = \frac{N}{\sum_{i=1}^N \frac{1}{v_i}}$$

The worker compiles `speeds-current.csv`:
```csv
# from_osm_node,to_osm_node,speed
104829102,104829103,14
104829103,104829104,12
839120192,839120193,8
```

---

## 7. OSM Dhaka Road Geometry Completeness & Connectivity Audit

Before OSRM can be promoted to Primary routing (Phase 2), engineering conducts an empirical geometry completeness audit across three known failure modes in Dhaka:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        DHAKA ROAD GEOMETRY AUDIT SUITE                                 │
├─────────────────────┬────────────────────────────────────┬─────────────────────────────┤
│ Target Domain       │ Vulnerability / Failure Mode       │ Verification Test Suite     │
├─────────────────────┼────────────────────────────────────┼─────────────────────────────┤
│ 1. Old Dhaka        │ Disconnected narrow alleyways;     │ Probe 5,000 shortest-path   │
│    Alleys           │ dead ends mapped without turn bays │ routes across Lalbagh and   │
│                     │ in Lalbagh, Chawkbazar, Sutrapur.  │ Chawkbazar. Failure rate    │
│                     │                                    │ must be < 1.5%.             │
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
# Tests routing connectivity across 1,000 random OD pairs in Old Dhaka

TEST_FILE="tests/golden/old_dhaka_probes.json"
FAILURES=0
TOTAL=0

echo "Running Old Dhaka connectivity test..."
while read -r OD; do
  ORIGIN=$(echo "$OD" | jq -r '.origin')
  DEST=$(echo "$OD" | jq -r '.dest')
  
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    "http://localhost:5002/route/v1/bike/${ORIGIN};${DEST}?overview=false")
    
  if [ "$HTTP_STATUS" -ne 200 ]; then
    FAILURES=$((FAILURES + 1))
  fi
  TOTAL=$((TOTAL + 1))
done < "${TEST_FILE}"

FAIL_RATE=$(awk "BEGIN {print ($FAILURES / $TOTAL) * 100}")
echo "Completed ${TOTAL} probes. Failures: ${FAILURES} (${FAIL_RATE}%)"

if (( $(echo "$FAIL_RATE > 1.5" | bc -l) )); then
  echo "FAIL: Routing disconnect rate exceeds 1.5% SLA. JOSM road patching required."
  exit 1
fi
echo "SUCCESS: Connectivity meets SLA."
```

---

## 8. High-Availability, Circuit Breaker & Health Checks

To protect production dispatch from OSRM node degradation or edge-weight corruption, the routing client implements a **Circuit Breaker** and automated health check:

```
[ Dispatch Service ]
        │
        ▼
[ OSRM Client with Circuit Breaker ]
  ├── Request Timeout: 150ms hard threshold
  ├── Fallback: If OSRM fails 3 consecutive calls (5xx or timeout),
  │   trip waterfall immediately falls back to Vendor API (Stage 005)
  └── Health Check: Polls /healthz on 5-second interval
```

### 8.1 Health Check Probe Specification
Every container exposes an HTTP endpoint `/healthz` verifying:
1. Memory segment is attached and accessible.
2. Synthetic test route executes with latency $< 15\text{ms}$.
3. Graph compilation age is $< 36\text{ hours}$.

---

## 9. Deliverables & Definition of Done

- [ ] Dockerized 3-container topology deployed on 16 vCPU / 32 GB RAM production VPS serving Car (5001), Bike (5002), and CNG (5003).
- [ ] Internal NGINX routing gateway deployed on Port 5000 dispatching requests based on vehicle type URL path.
- [ ] Automated download and contraction pipeline (`build-osrm-graphs.sh`) operational on the 339 MB Geofabrik Bangladesh extract.
- [ ] Specialized Lua profiles (`car.lua`, `bike.lua`, `cng.lua`) implemented, tested, and verified against Dhaka road constraints (Elevated Expressway, narrow alleys, speed caps).
- [ ] Shared memory (`osrm-datastore`) and blue/green container rotation tested; demonstrates zero-downtime hot-reloads under load in $< 2\text{ seconds}$.
- [ ] Dynamic traffic harvesting worker (`trafficHarvester.ts`) derives harmonic mean speeds from driver GPS pings and outputs `speeds-current.csv`.
- [ ] Old Dhaka connectivity audit script executed across 1,000 probes; failure rate verified below 1.5%.
- [ ] Health-check probe and circuit breaker operational with 150ms timeout and automatic fallback to vendor dispatch.
- [ ] Route query latency benchmark demonstrates sub-5ms routing baseline (p95 $< 8\text{ms}$) under 2,000 QPS load.
- [ ] **Stage 002 Legal Gate Verified:** Phase 1 shadow benchmarking confirmed to strictly await written legal counsel sign-off on Items 3, 7, 14, 15, 16, and 17.
