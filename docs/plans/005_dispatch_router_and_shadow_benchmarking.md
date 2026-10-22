# Stage 005: Dispatch Router & Shadow Benchmarking Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-005 (Revision 2.0 — Dynamic Dispatch Routing & Shadow Benchmarking)  
**Stage:** 5 of 16 (Routing Orchestration & Migration Framework)  
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§2, §14.1, §18, §18.1)  
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)  
**Current Status:** **NotDone**  

---

## 1. Executive Summary & Objective

Migrating Ride’s mission-critical dispatch routing from external commercial vendors (Barikoi, Google) to local infrastructure cannot be executed as a high-risk "big-bang" cutover. Any routing regression directly jeopardizes vehicle allocation, fare calculation accuracy, driver dispatch acceptance, and customer pickup punctuality.

Stage 005 establishes a deterministic, multi-tier **Dispatch Router Waterfall** paired with a non-blocking **Shadow Benchmarking Engine**:
1. **The 4-State Administrative Routing Toggle:** Governed dynamically via `system_config.routing_provider_mode` (`off`, `shadow`, `primary`, `sole`) with sub-second hot-reload across all dispatch workers.
2. **Strict Clean-Room Isolation:** Decouples the router from all raw vendor SDKs. Third-party vendor calls are routed exclusively through `utils-server/vendorClientWrapper.ts` (Stage 002), emitting safe numbers and enums. Vendor transactional data is isolated into `public.ride_vendor_data` with zero access for `dpmaps_worker`.
3. **Atomic Destination Resolution:** Tapped vendor suggestions pass only ephemeral client tokens (`temp_client_id`); the dispatch router resolves coordinates via atomic Redis `GETDEL` (120s TTL), failing safely with a user reselection prompt on expiry without database fallback.
4. **Two-Phase Shadow Benchmarking:** Separates dispatch-time prediction logging from post-trip ground-truth calibration, recording verified error percentages against physical GPS odometer traces in `dpmaps.routing_eval_events` (Tier B, 30-day retention).
5. **Circuit-Breaker-Protected Commercial Failover:** Hard-caps Google fallback queries to protect business continuity without exposing the company to unbounded third-party billing spikes.
6. **Numeric Gate 1 Verification:** Tracks continuous empirical progress toward the formal Gate 1 cutover thresholds (distance error $\le 3\%$, ETA error $\le 12\%$ for 3 consecutive weeks).

> [!CAUTION]
> ### MANDATORY LEGAL GATE PREREQUISITE
> In accordance with Stage 002 Rev 2.2 and `000_TOC.md`, the routing toggle is hard-locked to `0: off`. Transitioning to `1: shadow` and initiating shadow benchmarking or driver GPS comparisons is strictly prohibited until **Stage 002 Legal Matrix Items 3, 7, 14, 15, 16, and 17** (specifically Item 17: Driver GPS Consent, and Item 7: Vendor Contract Compliance) are signed off in writing by external legal counsel.

---

## 2. The 4-State Routing Migration Framework

The dispatch routing engine transitions through four discrete operational states:

```
                  ┌─────────┐
                  │ 0. OFF  │ (100% Commercial Vendor; OSRM dormant; Legal Gate lock)
                  └────┬────┘
                       │ (Legal Counsel Sign-off on Items 3, 7, 14, 15, 16, 17)
                       ▼
                 ┌───────────┐
                 │ 1. SHADOW │ (Vendor serves live; OSRM evaluates async from launch Day 1)
                 └─────┬─────┘
                       │ (Gate 1 Passed: Dist error <= 3%, ETA error <= 12% for 3 consec wks)
                       ▼
                 ┌───────────┐
                 │2. PRIMARY │ (OSRM serves live; vendor fallback ONLY on timeout/error)
                 └─────┬─────┘
                       │ (Gate 2 Passed: 24hr Vendor-Off Rehearsal Day; 0 dropped orders)
                       ▼
                  ┌──────────┐
                  │ 3. SOLE  │ (OSRM only; ZERO external vendor calls; absolute independence)
                  └──────────┘
```

### 2.1 State Operational Matrix

| Toggle Mode | Live Request Serving | Fallback Waterfall Sequence | Storage & Telemetry Policy |
|---|---|---|---|
| **`0: off`** *(Pre-Launch / Gate Lock)* | 100% Barikoi Vendor | Barikoi $\rightarrow$ Google $\rightarrow$ Haversine $\times 1.3$ | Transactional vendor quotes written to `ride_vendor_data`. Zero vendor strings logged. OSRM dormant. |
| **`1: shadow`** *(Phase 1 Default)* | 100% Barikoi Vendor | Barikoi $\rightarrow$ Google $\rightarrow$ Haversine $\times 1.3$ | Live vendor serves trip. OSRM generates async shadow quote. Post-trip worker records error % vs. driven GPS in `routing_eval_events`. |
| **`2: primary`** *(Phase 2 Cutover)* | 100% Local OSRM | OSRM $\rightarrow$ Barikoi $\rightarrow$ Google $\rightarrow$ Haversine $\times 1.3$ | OSRM primary (timeout 300ms). Vendor fallback triggers P2 warning alert and telemetry gap analysis. |
| **`3: sole`** *(Phase 4 Sovereign)* | 100% Local OSRM | OSRM $\rightarrow$ Haversine $\times 1.3$ | **Absolute vendor independence.** Third-party vendor endpoints completely severed in code. Zero external API calls. |

---

## 3. Production Dispatch Router Waterfall

```
                                [ Incoming Dispatch Route Request ]
                                                 │
                   ┌─────────────────────────────┴─────────────────────────────┐
                   ▼                                                           ▼
      [ Destination: First-Party POI ]                           [ Destination: Vendor Suggestion ]
      • Coordinates known directly                               • Client supplies temp_client_id
                                                                 • resolveVendorSelection(temp_client_id)
                                                                   (Atomic Redis GETDEL, 120s TTL)
                                                                 • If null -> Prompt Rider Reselection
                   │                                                           │
                   └─────────────────────────────┬─────────────────────────────┘
                                                 │
                                                 ▼
                                     [ routing_provider_mode ]
                                                 │
                       ┌─────────────────────────┼─────────────────────────┐
                       │ mode == 'primary'       │ mode == 'shadow'        │ mode == 'sole'
                       ▼                         ▼                         ▼
            [ 1. PRIMARY: OSRM ]      [ 1. LIVE: Barikoi ]      [ 1. SOLE: OSRM ]
            • Multi-profile gateway   • Via vendor wrapper      • Multi-profile gateway
            • Port 5000 (car/bike/cng)• 400ms timeout budget    • 300ms timeout budget
            • 300ms timeout budget               │                         │
                       │                         ▼                         │
             (Timeout or 5xx)         [ Async Shadow Quote ]               │
                       │              • OSRM runs background               │
                       ▼              • Compares vs GPS                    ▼
            [ 2. FALLBACK: Barikoi ]             │                  [ 2. FLOOR: Haversine ]
            • Via vendor wrapper                 │                  • Direct x 1.3
            • 400ms timeout budget               │                  • Zero dropped orders
                       │                         │
             (Timeout or 5xx)                    │
                       │                         │
                       ▼                         │
            [ 3. FALLBACK: Google ] ◄────────────┘ (If Barikoi fails in shadow mode)
            • Circuit-breaker capped
            • Max 500 req / 15 min
            • Ride Sedan tier only
                       │
             (Trip Exceeded / 5xx)
                       │
                       ▼
            [ 4. FLOOR: Haversine x 1.3 ]
            • Pure in-memory math (0ms)
            • 18 km/h baseline urban speed
            • Zero dropped orders
```

### 3.1 Implementation: `utils-server/dispatchRouter.ts`
```typescript
import { getPlatformConfig } from '../lib/platformConfig';
import { getOsrmRoute } from './osrmClient';
import { 
  executeBarikoiRoute, 
  executeGoogleRoute, 
  resolveVendorSelection,
  SafeVendorRouteResult 
} from './vendorClientWrapper';
import { calculateHaversineDistance } from './geoMath';
import { logger } from './logger';
import { recordShadowQuote } from './shadowQuoter';
import { db } from '../lib/db';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteRequest {
  tripId: string;
  origin: LatLng;
  destination: LatLng | { tempClientId: string };
  vehicleType: 'car' | 'bike' | 'cng';
}

export interface ActiveRouteResult {
  distance_meters: number;
  duration_seconds: number;
  polyline?: string;
  provider: 'osrm' | 'barikoi' | 'google' | 'haversine_floor';
  latency_ms: number;
}

export async function calculateDispatchRoute(req: RouteRequest): Promise<ActiveRouteResult> {
  const mode = (await getPlatformConfig('routing_provider_mode')) ?? 'off';

  // 1. Resolve Destination Coordinates
  let destCoords: LatLng;
  if ('tempClientId' in req.destination) {
    const resolved = await resolveVendorSelection(req.destination.tempClientId);
    if (!resolved) {
      logger.warn({ tripId: req.tripId }, '[dispatchRouter] Vendor selection expired or consumed');
      throw new Error('SELECTION_EXPIRED_PLEASE_RESELECT');
    }
    destCoords = resolved;
  } else {
    destCoords = req.destination;
  }

  // 2. Mode 3: Sole Sovereign Operation (Zero vendor calls)
  if (mode === 'sole') {
    const osrm = await getOsrmRoute(req.origin, destCoords, req.vehicleType, { timeoutMs: 300 });
    if (osrm) return osrm;

    logger.error({ tripId: req.tripId }, '[dispatchRouter] OSRM failed in sole mode; dropping to Haversine floor');
    return getHaversineFallback(req.origin, destCoords);
  }

  // 3. Mode 2: Primary Operation (OSRM primary; vendor fallback on error)
  if (mode === 'primary') {
    const osrm = await getOsrmRoute(req.origin, destCoords, req.vehicleType, { timeoutMs: 300 });
    if (osrm) return osrm;

    logger.warn({ tripId: req.tripId }, '[dispatchRouter] OSRM timeout/failure; activating Fallback 1 (Barikoi)');
    const barikoi = await executeBarikoiRoute(req.origin, destCoords, 400);
    if (barikoi && barikoi.status === 'OK') {
      await persistVendorOperationalRecord(req.tripId, destCoords, barikoi);
      return toActiveRoute(barikoi, 'barikoi');
    }

    logger.error({ tripId: req.tripId }, '[dispatchRouter] Barikoi failed; activating Fallback 2 (Google)');
    const google = await executeGoogleRoute(req.origin, destCoords, 600);
    if (google && google.status === 'OK') {
      await persistVendorOperationalRecord(req.tripId, destCoords, google);
      return toActiveRoute(google, 'google');
    }

    return getHaversineFallback(req.origin, destCoords);
  }

  // 4. Mode 1: Shadow Operation (Vendor live; local OSRM evaluated async)
  if (mode === 'shadow') {
    const liveVendor = await executeBarikoiRoute(req.origin, destCoords, 400);
    let activeResult: ActiveRouteResult;

    if (liveVendor && liveVendor.status === 'OK') {
      await persistVendorOperationalRecord(req.tripId, destCoords, liveVendor);
      activeResult = toActiveRoute(liveVendor, 'barikoi');
    } else {
      // Vendor emergency fallback
      const google = await executeGoogleRoute(req.origin, destCoords, 600);
      if (google && google.status === 'OK') {
        await persistVendorOperationalRecord(req.tripId, destCoords, google);
        activeResult = toActiveRoute(google, 'google');
      } else {
        activeResult = getHaversineFallback(req.origin, destCoords);
      }
    }

    // Trigger non-blocking async shadow evaluation
    setImmediate(() => {
      recordShadowQuote({
        tripId: req.tripId,
        origin: req.origin,
        destination: destCoords,
        vehicleType: req.vehicleType,
        vendorDistanceM: activeResult.distance_meters,
        vendorDurationS: activeResult.duration_seconds
      }).catch(err => logger.error({ err }, '[dispatchRouter] Failed to record shadow quote'));
    });

    return activeResult;
  }

  // 5. Mode 0: Off (100% Vendor, Zero OSRM)
  const vendorResult = await executeBarikoiRoute(req.origin, destCoords, 500);
  if (vendorResult && vendorResult.status === 'OK') {
    await persistVendorOperationalRecord(req.tripId, destCoords, vendorResult);
    return toActiveRoute(vendorResult, 'barikoi');
  }

  const google = await executeGoogleRoute(req.origin, destCoords, 600);
  if (google && google.status === 'OK') {
    await persistVendorOperationalRecord(req.tripId, destCoords, google);
    return toActiveRoute(google, 'google');
  }

  return getHaversineFallback(req.origin, destCoords);
}

/**
 * Persists vendor transactional metrics strictly to isolated public.ride_vendor_data.
 * Notice: Zero access by dpmaps_worker.
 */
async function persistVendorOperationalRecord(
  tripId: string,
  dest: LatLng,
  vendor: SafeVendorRouteResult
): Promise<void> {
  await db.query(
    `INSERT INTO public.ride_vendor_data 
      (ride_id, vendor_dest_lat, vendor_dest_lng, vendor_quoted_dist_m, vendor_quoted_dur_s)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (ride_id) DO UPDATE 
     SET vendor_quoted_dist_m = EXCLUDED.vendor_quoted_dist_m,
         vendor_quoted_dur_s = EXCLUDED.vendor_quoted_dur_s`,
    [tripId, dest.lat, dest.lng, vendor.distance_meters, vendor.duration_seconds]
  );
}

function toActiveRoute(vendor: SafeVendorRouteResult, provider: 'barikoi' | 'google'): ActiveRouteResult {
  return {
    distance_meters: vendor.distance_meters,
    duration_seconds: vendor.duration_seconds,
    polyline: vendor.polyline,
    provider,
    latency_ms: vendor.latency_ms
  };
}

function getHaversineFallback(origin: LatLng, dest: LatLng): ActiveRouteResult {
  const directMeters = calculateHaversineDistance(origin.lat, origin.lng, dest.lat, dest.lng);
  const roadMeters = directMeters * 1.3; // Standard urban tortuosity multiplier
  const estSeconds = Math.round((roadMeters / 5000) * 3600); // 18 km/h urban average speed

  return {
    distance_meters: Math.round(roadMeters),
    duration_seconds: estSeconds,
    provider: 'haversine_floor',
    latency_ms: 0
  };
}
```

---

## 4. Two-Phase Shadow Benchmarking & Ground-Truth Calibration

Accurate route evaluation cannot happen at dispatch time because the actual vehicle journey has not yet taken place. Stage 005 establishes a **Two-Phase Calibration Lifecycle**:

```
[ Phase 1: Dispatch Time (Non-Blocking) ]
  ├── Active vendor route serves live trip (e.g. 5.2 km, 18 mins)
  ├── Background worker queries OSRM Gateway on Port 5000:
  │   http://osrm-gateway:5000/route/v1/car/...
  └── Ephemeral quote record cached in Redis (TTL: 24 hours):
      KEY: shadow_quote:<trip_id>
      DATA: { osrm_duration_s, osrm_distance_m, vendor_duration_s, vendor_distance_m }
                        │
                        ▼ (Driver completes trip 25 minutes later)
[ Phase 2: Trip Completion Calibration ]
  ├── Driver arrives at physical dropoff; handset sends completed trip telemetry
  ├── Orders table records first-party truth:
  │   - actual_driven_duration_s = elapsed_seconds
  │   - actual_driven_distance_m = snapped_odometer_meters
  ├── Ground-Truth Calibrator (workers/groundTruthCalibrator.ts) fetches shadow_quote:<trip_id>
  ├── Computes relative error percentages:
  │   - duration_error_pct = |osrm_duration_s - actual_driven_duration_s| / actual_driven_duration_s * 100
  │   - distance_error_pct = |osrm_distance_m - actual_driven_distance_m| / actual_driven_distance_m * 100
  └── Inserts permanent record into dpmaps.routing_eval_events (Tier B, 30-day retention)
```

### 4.1 Phase 1 Worker: `utils-server/shadowQuoter.ts`
```typescript
import { getOsrmRoute } from './osrmClient';
import { redisClient } from '../lib/redis';
import { LatLng } from './dispatchRouter';

export interface ShadowQuoteParams {
  tripId: string;
  origin: LatLng;
  destination: LatLng;
  vehicleType: 'car' | 'bike' | 'cng';
  vendorDistanceM: number;
  vendorDurationS: number;
}

export async function recordShadowQuote(params: ShadowQuoteParams): Promise<void> {
  const osrmResult = await getOsrmRoute(
    params.origin, 
    params.destination, 
    params.vehicleType, 
    { timeoutMs: 500 }
  );

  if (!osrmResult) return;

  const quotePayload = {
    osrm_distance_m: osrmResult.distance_meters,
    osrm_duration_s: osrmResult.duration_seconds,
    vendor_distance_m: params.vendorDistanceM,
    vendor_duration_s: params.vendorDurationS,
    vehicle_type: params.vehicleType,
    dispatched_at: Date.now()
  };

  // Cached ephemerally for 24 hours awaiting trip completion
  await redisClient.set(
    `shadow_quote:${params.tripId}`,
    JSON.stringify(quotePayload),
    'EX',
    86400
  );
}
```

### 4.2 Phase 2 Worker: `workers/groundTruthCalibrator.ts`
```typescript
import { redisClient } from '../lib/redis';
import { db } from '../lib/db';
import { logger } from '../utils-server/logger';

interface TripCompletedEvent {
  tripId: string;
  elapsedSeconds: number;
  drivenOdometerMeters: number;
}

export async function onTripCompleted(event: TripCompletedEvent): Promise<void> {
  const rawQuote = await redisClient.getdel(`shadow_quote:${event.tripId}`);
  if (!rawQuote) return; // Trip had no shadow quote or expired

  const quote = JSON.parse(rawQuote);

  if (event.elapsedSeconds <= 0 || event.drivenOdometerMeters <= 0) return;

  const durationErrorPct = Math.abs(quote.osrm_duration_s - event.elapsedSeconds) / event.elapsedSeconds * 100;
  const distanceErrorPct = Math.abs(quote.osrm_distance_m - event.drivenOdometerMeters) / event.drivenOdometerMeters * 100;

  // Insert into Tier B daily partitioned table (Stage 003 §4.8)
  await db.query(
    `INSERT INTO dpmaps.routing_eval_events (
      trip_id,
      osrm_duration_s,
      osrm_distance_m,
      actual_driven_duration_s,
      actual_driven_distance_m,
      vendor_duration_s,
      vendor_distance_m,
      duration_error_pct,
      distance_error_pct
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      event.tripId,
      quote.osrm_duration_s,
      quote.osrm_distance_m,
      event.elapsedSeconds,
      event.drivenOdometerMeters,
      quote.vendor_duration_s,
      quote.vendor_distance_m,
      Number(durationErrorPct.toFixed(2)),
      Number(distanceErrorPct.toFixed(2))
    ]
  );
}
```

---

## 5. Gate 1 Cutover Tracking & Telemetry Dashboard

To graduate from Mode 1 (Shadow) to Mode 2 (Primary), the routing engine must satisfy the numeric cutover gates defined in Concept Paper §18:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              GATE 1 CUTOVER CRITERIA                                   │
├──────────────────────────┬─────────────────────────────┬───────────────────────────────┤
│ Evaluation Criterion     │ Quantitative Target         │ Evaluation Window & Rigor     │
├──────────────────────────┼─────────────────────────────┼───────────────────────────────┤
│ **Distance Accuracy**    │ OSRM Distance Error <= 3%   │ Evaluated across 95% of trips │
│                          │ versus driven GPS odometer  │ for 3 consecutive weeks.      │
├──────────────────────────┼─────────────────────────────┼───────────────────────────────┤
│ **ETA Accuracy**         │ OSRM ETA Error <= 12% of    │ p95 duration error <= 25%,    │
│                          │ actual trip duration        │ matching or beating vendor.   │
├──────────────────────────┼─────────────────────────────┼───────────────────────────────┤
│ **Query Latency**        │ p95 Latency < 8 ms          │ Sub-5ms average on local host │
│                          │ (p99 < 15 ms)               │ under 2,000 QPS load.         │
├──────────────────────────┼─────────────────────────────┼───────────────────────────────┤
│ **Availability SLA**     │ Availability >= 99.95%      │ Over 30 consecutive days of   │
│                          │                             │ shadow execution.             │
└──────────────────────────┴─────────────────────────────┴───────────────────────────────┘
```

### 5.1 Prometheus Telemetry Metrics

```typescript
// utils-server/metrics.ts
import { Counter, Histogram, Gauge } from 'prom-client';

export const routingRequestsTotal = new Counter({
  name: 'dpmaps_routing_requests_total',
  help: 'Total dispatch routing requests partitioned by provider and mode',
  labelNames: ['provider', 'mode', 'vehicle_type', 'status']
});

export const routingLatencyHistogram = new Histogram({
  name: 'dpmaps_routing_latency_seconds',
  help: 'Routing execution latency in seconds',
  labelNames: ['provider'],
  buckets: [0.002, 0.005, 0.008, 0.015, 0.030, 0.050, 0.100, 0.300, 0.500]
});

export const routingFallbackCounter = new Counter({
  name: 'dpmaps_routing_fallback_total',
  help: 'Count of waterfall fallbacks triggered from primary to secondary engines',
  labelNames: ['from_provider', 'to_provider', 'reason']
});

export const gate1DistanceErrorGauge = new Gauge({
  name: 'dpmaps_gate1_distance_error_pct',
  help: 'Rolling 7-day average OSRM distance error percentage vs. driven GPS odometer',
  labelNames: ['vehicle_type']
});

export const gate1DurationErrorGauge = new Gauge({
  name: 'dpmaps_gate1_duration_error_pct',
  help: 'Rolling 7-day average OSRM duration error percentage vs. actual elapsed trip time',
  labelNames: ['vehicle_type']
});
```

---

## 6. Commercial Google Failover Circuit Breaker

To prevent catastrophic bill spikes during upstream vendor outages:
- **Rolling Volume Cap:** Hard ceiling of 500 Google route queries per rolling 15-minute sliding window.
- **Service Tier Whitelist:** Restricted exclusively to premium four-wheeler trips (`Ride Sedan`); strictly disabled for two-wheelers (`Ride Moto`), CNGs, and parcel delivery.
- **Circuit Tripping Threshold:** If Google API error rate exceeds 15% or the 500-request window cap is breached, the circuit immediately opens for 15 minutes, directing all subsequent failovers directly to the in-memory Haversine floor.

---

## 7. Deliverables & Definition of Done

- [ ] `utils-server/dispatchRouter.ts` implemented using clean-room `vendorClientWrapper.ts` exclusively (zero vendor SDK imports).
- [ ] Server-side `resolveVendorSelection(temp_client_id)` integrated; verified to fail safely on null/expiry with rider reselection prompt.
- [ ] Vendor transactional records isolated into `public.ride_vendor_data` (zero access for `dpmaps_worker`).
- [ ] Multi-profile OSRM client connected to internal Gateway Port 5000 (`car`, `bike`, `cng`) with 300ms timeout budget.
- [ ] Two-phase shadow benchmarking operational: `shadowQuoter.ts` records dispatch quotes in Redis (24h TTL); `groundTruthCalibrator.ts` logs final error percentages into `dpmaps.routing_eval_events`.
- [ ] Google failover circuit breaker verified under simulated rate limit spikes.
- [ ] Prometheus metrics exported: `dpmaps_routing_requests_total`, `dpmaps_routing_latency_seconds`, `dpmaps_routing_fallback_total`, and Gate 1 error gauges.
- [ ] Sub-second hot-reload verified for `routing_provider_mode` toggle in `system_config`.
- [ ] **Stage 002 Legal Gate Enforced:** Confirmed that `routing_provider_mode` is locked to `0: off` and admin toggle rejects transitions to `shadow` until Legal Matrix Items 3, 7, 14, 15, 16, and 17 are signed off by counsel.
