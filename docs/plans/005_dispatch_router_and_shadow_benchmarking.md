# Stage 005: Dispatch Router & Shadow Benchmarking Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-005 (Revision 2.1 — Four-Mode Dispatch Waterfall & Clean-Room Shadow Benchmarking)
**Stage:** 5 of 16 (Routing Orchestration & Migration Framework)
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§2, §14.1, §14.3, §18, §18.1)
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)
**Current Status:** **NotDone**

---

## 1. Executive Summary & Objective

Migrating Ride's mission-critical dispatch routing from external commercial vendors (Barikoi, Google) to local infrastructure cannot be executed as a high-risk "big-bang" cutover. Any routing regression directly jeopardizes vehicle allocation, fare calculation accuracy, driver dispatch acceptance, and customer pickup punctuality.

Stage 005 establishes a deterministic, multi-tier **Dispatch Router Waterfall** paired with a non-blocking **Clean-Room Shadow Benchmarking Engine**:
1. **The 4-State Administrative Routing Toggle:** `system_config.routing_provider_mode` (`off`, `shadow`, `primary`, `sole`) with sub-second hot-reload. **Mode 0 (`off`) is an explicit first-class state**: the dpMaps routing engine is fully bypassed — zero OSRM calls, zero shadow overhead — for maintenance windows and while the legal gate is locked.
2. **Strict Clean-Room Isolation:** All vendor calls go exclusively through `utils-server/vendorClientWrapper.ts` (Stage 002). Raw vendor quotes live only in `public.ride_vendor_data` (Tier V). `dpmaps.*` evaluation tables store **computed error percentages only** — zero vendor quotes, zero vendor polylines, zero vendor coordinates (Stage 003 Rev 2.1 contract).
3. **Atomic Destination Resolution:** Tapped vendor suggestions pass only ephemeral `temp_client_id` tokens; dispatch resolves coordinates via atomic Redis `GETDEL` (`vendor:resolve:*`, 120 s TTL, Stage 002), failing safely to rider reselection with zero database fallback.
4. **Clean-Room Two-Phase Shadow Benchmarking:** Dispatch-time OSRM quotes are cached keyed by `trip_hash = HMAC-SHA256(trip_id, IngestionSalt)` (Stage 003 §4.4); post-trip calibration reads first-party actuals and Tier V vendor quotes once each, and persists only error percentages into `dpmaps.routing_eval_events` under the operational `ride_dispatch` role.
5. **Circuit-Breaker-Protected Commercial Failover:** Google fallback is hard-capped by rolling request window **and** a configurable monetary spend cap `[ESTIMATE defaults]`.
6. **Numeric Gate 1 Tracking:** Continuous empirical progress toward the relative cutover gates (distance error ≤ 3%, ETA error ≤ 12% of trip duration with p95 ≤ 25%, vendor parity, corridor overlap ≥ 85%, 3 consecutive weeks) — percentages of trip duration only, **never flat minutes**.

> [!CAUTION]
> ### MANDATORY LEGAL GATE PREREQUISITE
> In accordance with Stage 002 Rev 2.2 and `000_TOC.md`, the routing toggle is hard-locked to `0: off`. Transitioning to `1: shadow` and initiating shadow benchmarking or driver GPS comparisons is strictly prohibited until **Stage 002 Legal Matrix Items 3, 7, 14, 15, 16, and 17** (specifically Item 17: Driver GPS Consent, and Item 7: Vendor Contract Compliance) are signed off in writing by external legal counsel.

---

## 2. The 4-State Routing Migration Framework

The dispatch routing engine transitions through four discrete operational states:

```
                  ┌─────────┐
                  │ 0. OFF  │ (100% Commercial Vendor; OSRM fully bypassed; Legal Gate lock;
                  └────┬────┘   maintenance mode: zero shadow overhead)
                       │ (Legal Counsel Sign-off on Items 3, 7, 14, 15, 16, 17)
                       ▼
                 ┌───────────┐
                 │ 1. SHADOW │ (Vendor serves live; OSRM evaluates async from launch Day 1)
                 └─────┬─────┘
                       │ (Gate 1 Passed: median ETA err <= 12%, p95 <= 25%, dist <= 3%,
                       │  vendor parity, corridor >= 85%, 3 consec weeks)
                       ▼
                 ┌───────────┐
                 │2. PRIMARY │ (OSRM serves live; vendor fallback ONLY on timeout/error)
                 └─────┬─────┘
                       │ (Gate 2 Passed: 24hr Vendor-Off Rehearsal Day; 0 dropped orders)
                       ▼
                  ┌──────────┐
                  │ 3. SOLE  │ (OSRM only; ZERO external vendor calls)
                  └──────────┘
```

Transitions are hot-reloadable via `system_config` in < 1 second cluster-wide (concept paper §2.2), reversible at any time, and gated on numeric criteria — never calendar dates. An unknown/invalid `routing_provider_mode` value **fails safe to `off`** and raises a P1 alert (it never silently behaves as another mode).

### 2.1 State Operational Matrix

| Toggle Mode | Live Request Serving | Fallback Waterfall Sequence | Storage & Telemetry Policy |
|---|---|---|---|
| **`0: off`** *(Pre-Launch / Gate Lock / Maintenance)* | 100% Barikoi Vendor | Barikoi (400 ms) $\rightarrow$ Google (600 ms, capped) $\rightarrow$ Haversine $\times 1.3$ | Vendor quotes to `ride_vendor_data` (Tier V). **Zero OSRM calls of any kind**: no shadow quotes, no `/match` traffic harvesting, no eval writes. |
| **`1: shadow`** *(Phase 1 Default)* | 100% Barikoi Vendor | Barikoi (400 ms) $\rightarrow$ Google (600 ms, capped) $\rightarrow$ Haversine $\times 1.3$ | Live vendor serves trip. OSRM async shadow quote cached by `trip_hash` (24 h TTL, first-party numbers only). Post-trip worker records **error percentages only** in `routing_eval_events`. |
| **`2: primary`** *(Phase 2 Cutover)* | 100% Local OSRM | OSRM (300 ms) $\rightarrow$ Barikoi (400 ms) $\rightarrow$ Google (600 ms, capped) $\rightarrow$ Haversine $\times 1.3$ | OSRM primary. Every vendor fallback triggers P2 warning alert and telemetry gap analysis. |
| **`3: sole`** *(Phase 4 Sovereign)* | 100% Local OSRM | OSRM (300 ms) $\rightarrow$ Haversine $\times 1.3$ | Third-party vendor endpoints severed in code. Zero external API calls. |

---

## 3. Production Dispatch Router Waterfall & Destination Resolution

```
                                [ Incoming Dispatch Route Request ]
                                                 │
                   ┌─────────────────────────────┴─────────────────────────────┐
                   ▼                                                           ▼
      [ Destination: First-Party POI ]                           [ Destination: Vendor Suggestion ]
      • Coordinates known directly                               • Client supplies temp_client_id
                                                                 • resolveVendorSelection(temp_client_id)
                                                                   (Atomic Redis GETDEL, key
                                                                   vendor:resolve:<id>, TTL 120s)
                                                                 • If null -> Prompt Rider Reselection
                   │                                                           │
                   └─────────────────────────────┬─────────────────────────────┘
                                                 │
                                     [ routing_provider_mode ]
                                                 │
        ┌────────────────────┬───────────────────┼───────────────────┬──────────────────┐
        │ mode == 'off'      │ mode == 'shadow'  │ mode == 'primary' │ mode == 'sole'   │
        ▼                    ▼                   ▼                   ▼
[ LIVE: Barikoi ]   [ LIVE: Barikoi ]   [ 1. OSRM 300ms ]     [ 1. OSRM 300ms ]
• 400ms budget      • 400ms budget      • circuit breaker       • circuit breaker
• NO OSRM calls      │                   │ (3-strike)            │ (3-strike)
        │            │ (async shadow     │                       ▼
        │            │  quote, keyed     ▼              [ FLOOR: Haversine x 1.3 ]
        │            │  trip_hash)  [ Fallback 1: Barikoi 400ms ]
        ▼            │              │        │
[ Fallback 2:        │              ▼        │
 Google 600ms        │    [ Fallback 2:      │
 circuit + spend cap ]     Google 600ms ]    │
        │            │              │        │
        ▼            ▼              ▼        ▼
[ FLOOR: Haversine x 1.3 — 0ms, 18 km/h baseline [ESTIMATE], zero dropped orders ]
```

### 3.1 Destination Resolution Contract (Stage 002 alignment)
- Key namespace: `vendor:resolve:<temp_client_id>`; `temp_client_id` is a server-minted ephemeral UUID v4 (Stage 002).
- Retrieval is **single-use** via Redis `GETDEL` (Redis ≥ 6.2; ioredis `getdel` / node-redis `getDel` — pin the client API).
- TTL 120 s. On miss/expiry: throw `SELECTION_EXPIRED_PLEASE_RESELECT`; the client prompts rider reselection. **No database fallback, no re-derivation, no vendor re-query.**
- Returned payload is coordinates only, consumed exclusively by dispatch navigation. Never logged, never written to `dpmaps.*`.

### 3.2 Implementation: `utils-server/dispatchRouter.ts`
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
  tripId: string;               // Operational order UUID (ride_id). Logs only; 30-day purge.
  origin: LatLng;
  destination: LatLng | { tempClientId: string };
  vehicleType: 'car' | 'bike' | 'cng';
}

export interface ActiveRouteResult {
  distance_meters: number;
  duration_seconds: number;
  polyline?: string;            // Vendor polyline: LIVE PASS-THROUGH ONLY. Never logged,
                                // persisted, benchmarked, or copied into dpmaps.* (F-005-9).
  provider: 'osrm' | 'barikoi' | 'google' | 'haversine_floor';
  latency_ms: number;
}

type RoutingMode = 'off' | 'shadow' | 'primary' | 'sole';

function normalizeMode(raw: unknown): RoutingMode {
  const valid: RoutingMode[] = ['off', 'shadow', 'primary', 'sole'];
  if (valid.includes(raw as RoutingMode)) return raw as RoutingMode;
  logger.error({ raw }, '[dispatchRouter] Invalid routing_provider_mode; failing safe to off');
  return 'off'; // fail-safe (F-005-8)
}

export async function calculateDispatchRoute(req: RouteRequest): Promise<ActiveRouteResult> {
  const mode = normalizeMode(await getPlatformConfig('routing_provider_mode') ?? 'off');

  // 1. Resolve Destination Coordinates (Stage 002 ephemeral contract)
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

  // 2. Mode 3: Sole Sovereign Operation (zero vendor calls)
  if (mode === 'sole') {
    const osrm = await getOsrmRoute(req.origin, destCoords, req.vehicleType, { timeoutMs: 300 });
    if (osrm) return osrm;
    logger.error({ tripId: req.tripId }, '[dispatchRouter] OSRM failed in sole mode; Haversine floor');
    return getHaversineFallback(req.origin, destCoords);
  }

  // 3. Mode 2: Primary Operation (OSRM first; vendor fallback on error)
  if (mode === 'primary') {
    const osrm = await getOsrmRoute(req.origin, destCoords, req.vehicleType, { timeoutMs: 300 });
    if (osrm) return osrm;

    logger.warn({ tripId: req.tripId }, '[dispatchRouter] OSRM timeout/failure; Fallback 1 (Barikoi)');
    const barikoi = await executeBarikoiRoute(req.origin, destCoords, 400);
    if (barikoi && barikoi.status === 'OK') {
      await persistVendorOperationalRecord(req.tripId, destCoords, barikoi);
      return toActiveRoute(barikoi, 'barikoi');
    }

    logger.error({ tripId: req.tripId }, '[dispatchRouter] Barikoi failed; Fallback 2 (Google)');
    const google = await executeGoogleRoute(req.origin, destCoords, 600);
    if (google && google.status === 'OK') {
      await persistVendorOperationalRecord(req.tripId, destCoords, google);
      return toActiveRoute(google, 'google');
    }

    return getHaversineFallback(req.origin, destCoords);
  }

  // 4. Mode 1: Shadow Operation (vendor live; OSRM evaluated async)
  if (mode === 'shadow') {
    const liveVendor = await executeBarikoiRoute(req.origin, destCoords, 400);
    let activeResult: ActiveRouteResult;

    if (liveVendor && liveVendor.status === 'OK') {
      await persistVendorOperationalRecord(req.tripId, destCoords, liveVendor);
      activeResult = toActiveRoute(liveVendor, 'barikoi');
    } else {
      const google = await executeGoogleRoute(req.origin, destCoords, 600);
      if (google && google.status === 'OK') {
        await persistVendorOperationalRecord(req.tripId, destCoords, google);
        activeResult = toActiveRoute(google, 'google');
      } else {
        activeResult = getHaversineFallback(req.origin, destCoords);
      }
    }

    // Non-blocking async shadow evaluation (first-party OSRM quote only)
    setImmediate(() => {
      recordShadowQuote({
        tripId: req.tripId,
        origin: req.origin,
        destination: destCoords,
        vehicleType: req.vehicleType
      }).catch(err => logger.error({ err }, '[dispatchRouter] Failed to record shadow quote'));
    });

    return activeResult;
  }

  // 5. Mode 0: Off — vendor only, ZERO dpMaps/OSRM involvement, no shadow overhead
  const vendorResult = await executeBarikoiRoute(req.origin, destCoords, 400);
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
 * Persists vendor transactional metrics strictly to isolated public.ride_vendor_data (Tier V).
 * Zero access by dpmaps_worker (Stage 003: REVOKE ALL). Destination coordinates stored here
 * are vendor-derived and quarantined to this table — never propagated to dpmaps.*.
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
    polyline: vendor.polyline, // pass-through only (F-005-9)
    provider,
    latency_ms: vendor.latency_ms
  };
}

function getHaversineFallback(origin: LatLng, dest: LatLng): ActiveRouteResult {
  const directMeters = calculateHaversineDistance(origin.lat, origin.lng, dest.lat, dest.lng);
  const roadMeters = directMeters * 1.3; // Standard urban tortuosity multiplier
  // F-005-6 repair: 18 km/h = 18,000 m/h -> seconds = roadMeters / 5
  const estSeconds = Math.round((roadMeters / 18000) * 3600); // 18 km/h baseline [ESTIMATE]

  return {
    distance_meters: Math.round(roadMeters),
    duration_seconds: estSeconds,
    provider: 'haversine_floor',
    latency_ms: 0
  };
}
```

---

## 4. Clean-Room Two-Phase Shadow Benchmarking & Ground-Truth Calibration

Accurate route evaluation cannot happen at dispatch time — the journey has not taken place. Stage 005 separates dispatch-time prediction logging from post-trip ground-truth calibration. **Clean-room rule (Stage 003 Rev 2.1 contract):** raw vendor quotes live only in `public.ride_vendor_data`; `dpmaps.routing_eval_events` receives computed error percentages only.

```
[ Phase 1: Dispatch Time (Non-Blocking, Mode 1 shadow only) ]
  ├── Active vendor route serves live trip
  ├── Background worker queries OSRM Gateway (Port 5000) — FIRST-PARTY output only
  └── Ephemeral quote cached in Redis (TTL 24 hours):
      KEY: shadow_quote:<trip_hash>        trip_hash = HMAC-SHA256(trip_id, IngestionSalt)
      DATA: { osrm_duration_s, osrm_distance_m, osrm_geometry, vehicle_type, dispatched_at }
      (ZERO vendor values in Redis — vendor quote already lives in ride_vendor_data, Tier V)
                    │
                    ▼ (Driver completes trip)
[ Phase 2: Trip Completion Calibration — runs as role `ride_dispatch` ]
  ├── Driver arrives at physical dropoff; handset sends completed trip telemetry
  ├── orders table records first-party truth:
  │   - actual_driven_duration_s = elapsed_seconds
  │   - actual_driven_distance_m = snapped_odometer_meters
  ├── Calibrator GETDELs shadow_quote:<trip_hash> (first-party OSRM quote + geometry)
  ├── Reads vendor quote ONCE from public.ride_vendor_data (operational role only)
  ├── Computes percentages in memory:
  │   - duration_error_pct = |osrm_duration_s - actual| / actual * 100
  │   - distance_error_pct = |osrm_distance_m - actual| / actual * 100
  │   - vendor_duration_error_pct = |vendor_dur - actual| / actual * 100
  │   - vendor_distance_error_pct = |vendor_dist - actual| / actual * 100
  ├── corridor_overlap_pct: driven fixes within 50 m of OSRM geometry (never vendor geometry)
  └── Inserts PERCENTAGES ONLY into dpmaps.routing_eval_events (Tier B, 30-day retention)
```

### 4.1 Phase 1 Worker: `utils-server/shadowQuoter.ts`
```typescript
import { getOsrmRoute } from './osrmClient';
import { redisClient } from '../lib/redis';
import { computeTripHash } from '../lib/tripHash'; // HMAC-SHA256(trip_id, IngestionSalt)
import { LatLng } from './dispatchRouter';

export interface ShadowQuoteParams {
  tripId: string;
  origin: LatLng;
  destination: LatLng;
  vehicleType: 'car' | 'bike' | 'cng';
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
    osrm_distance_m: osrmResult.distance_meters,   // first-party
    osrm_duration_s: osrmResult.duration_seconds,  // first-party
    osrm_geometry: osrmResult.polyline,            // first-party (OSM-derived geometry)
    vehicle_type: params.vehicleType,
    dispatched_at: Date.now()
    // F-005-2 repair: NO vendor_distance_m / vendor_duration_s here.
  };

  // Keyed by trip_hash — pseudonymous correlation (Stage 003 §4.4)
  await redisClient.set(
    `shadow_quote:${computeTripHash(params.tripId)}`,
    JSON.stringify(quotePayload),
    'EX',
    86400 // 24 h TTL
  );
}
```

### 4.2 Phase 2 Worker: `workers/groundTruthCalibrator.ts`
**Role boundary (F-005-4):** runs in the operational domain under `ride_dispatch` (Stage 003 §3.1 grants `INSERT` on `dpmaps.routing_eval_events`; the role holds column-level `SELECT` on `public.orders` first-party columns and `public.ride_vendor_data`). It must **not** run as `dpmaps_worker` (`REVOKE ALL ON public.ride_vendor_data FROM dpmaps_worker`). Only computed percentages ever cross into `dpmaps.*`.

```typescript
import { redisClient } from '../lib/redis';
import { db } from '../lib/db';
import { logger } from '../utils-server/logger';
import { computeTripHash } from '../lib/tripHash';
import { resolveTodBucket } from '../lib/todBuckets'; // §4.3

interface TripCompletedEvent {
  tripId: string;
  elapsedSeconds: number;
  drivenOdometerMeters: number;
  drivenGpsTrace: { lat: number; lng: number }[]; // first-party, in-memory only
}

export async function onTripCompleted(event: TripCompletedEvent): Promise<void> {
  const rawQuote = await redisClient.getdel(`shadow_quote:${computeTripHash(event.tripId)}`);
  if (!rawQuote) return;

  const quote = JSON.parse(rawQuote);
  if (event.elapsedSeconds <= 0 || event.drivenOdometerMeters <= 0) return;

  // Vendor quote: read ONCE from Tier V, compute percentages, discard raw values
  const vendorRow = await db.query(
    `SELECT vendor_quoted_dist_m, vendor_quoted_dur_s
       FROM public.ride_vendor_data WHERE ride_id = $1`,
    [event.tripId]
  );
  const vendorDistM = vendorRow.rows[0]?.vendor_quoted_dist_m ?? null;
  const vendorDurS = vendorRow.rows[0]?.vendor_quoted_dur_s ?? null;

  const pct = (pred: number, actual: number) =>
    Number((Math.abs(pred - actual) / actual * 100).toFixed(2));

  const corridorOverlapPct = computeCorridorOverlapPct(quote.osrm_geometry, event.drivenGpsTrace);
  const routeDeviationFlag = corridorOverlapPct < 70; // [ESTIMATE] threshold

  // F-005-1 repair: exact Stage 003 §4.7 column list. NO trip_id. NO raw vendor quotes.
  await db.query(
    `INSERT INTO dpmaps.routing_eval_events (
       vehicle_type,
       tod_bucket,
       osrm_duration_s,
       osrm_distance_m,
       actual_driven_duration_s,
       actual_driven_distance_m,
       vendor_duration_error_pct,
       vendor_distance_error_pct,
       duration_error_pct,
       distance_error_pct,
       corridor_overlap_pct,
       route_deviation_flag
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      quote.vehicle_type,
      resolveTodBucket(Date.now()),
      quote.osrm_duration_s,
      quote.osrm_distance_m,
      event.elapsedSeconds,
      event.drivenOdometerMeters,
      vendorDurS !== null ? pct(vendorDurS, event.elapsedSeconds) : null,
      vendorDistM !== null ? pct(vendorDistM, event.drivenOdometerMeters) : null,
      pct(quote.osrm_duration_s, event.elapsedSeconds),
      pct(quote.osrm_distance_m, event.drivenOdometerMeters),
      corridorOverlapPct,
      routeDeviationFlag
    ]
  );
}

/**
 * corridor_overlap_pct (F-005-11): percentage of driven GPS fixes within
 * `buffer_m` of the dpMaps/OSRM quoted geometry. Vendor geometry is NEVER used.
 */
function computeCorridorOverlapPct(
  encodedOsrmPolyline: string,
  drivenTrace: { lat: number; lng: number }[],
  bufferM = 50 // [ESTIMATE]
): number {
  if (!drivenTrace.length) return 0;
  const geometry = decodePolyline(encodedOsrmPolyline);
  const inside = drivenTrace.filter(p => distanceToPolylineMeters(p, geometry) <= bufferM).length;
  return Number((inside / drivenTrace.length * 100).toFixed(2));
}
```

### 4.3 TOD Bucket Resolution
Enumeration of record is the Stage 003 CHECK: `('morning_peak', 'evening_peak', 'off_peak', 'night')` (column `tod_bucket`; F-005-10, cross-plan note X-1). Boundaries are admin-configurable in `system_config` (Asia/Dhaka), defaults `[ESTIMATE]`: morning_peak 07:00–11:00, evening_peak 16:00–21:00, night 00:00–05:00, off_peak otherwise. Stage 004 §6.4 consumes the same boundaries.

### 4.4 Evaluation Formulas

$$e_T = \frac{|T_{\text{pred}} - T_{\text{actual}}|}{T_{\text{actual}}} \times 100\%, \qquad e_D = \frac{|D_{\text{pred}} - D_{\text{actual}}|}{D_{\text{actual}}} \times 100\%$$

$$\text{vendor\_duration\_error\_pct} = \frac{|T_{\text{vendor}} - T_{\text{actual}}|}{T_{\text{actual}}} \times 100\%, \qquad \text{corridor\_overlap\_pct} = 100 \times \frac{\#\{p_i : \mathrm{dist}(p_i, \Gamma_{\text{osrm}}) \le 50\,\text{m}\}}{\#\{p_i\}}$$

All gate comparisons are relative (percentages of trip duration). **No flat-minute thresholds are permitted.**

---

## 5. Evaluation Schema Contract (`dpmaps.routing_eval_events`)

The schema of record is **Stage 003 §4.7 (Rev 2.2)** — daily-partitioned, 30-day retention, `PRIMARY KEY (id, created_at)`:

```sql
CREATE TABLE dpmaps.routing_eval_events (
  id BIGSERIAL,
  vehicle_type VARCHAR(16) NOT NULL CHECK (vehicle_type IN ('car', 'bike', 'cng')),
  tod_bucket VARCHAR(16) NOT NULL CHECK (tod_bucket IN ('morning_peak', 'evening_peak', 'off_peak', 'night')),
  osrm_duration_s INTEGER NOT NULL,
  osrm_distance_m INTEGER NOT NULL,
  actual_driven_duration_s INTEGER NOT NULL,
  actual_driven_distance_m INTEGER NOT NULL,
  vendor_duration_error_pct NUMERIC(5, 2),   -- percentage only; raw quote omitted
  vendor_distance_error_pct NUMERIC(5, 2),   -- percentage only; raw quote omitted
  duration_error_pct NUMERIC(5, 2) NOT NULL,
  distance_error_pct NUMERIC(5, 2) NOT NULL,
  corridor_overlap_pct NUMERIC(5, 2),
  route_deviation_flag BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
```

**Hard insert contract:** zero `trip_id`/`trip_hash` columns; zero raw vendor quotes; zero vendor coordinates or polylines. Correlation lives outside this table (operational `ride_id` ↔ `trip_hash` mapping in the operational domain; Redis `shadow_quote:<trip_hash>` expires at 24 h).

**Role grants (Stage 003 §3.1):** `GRANT INSERT ON dpmaps.routing_eval_events TO ride_dispatch;` `GRANT SELECT ... TO dpmaps_analyst;` `REVOKE ALL ON public.ride_vendor_data FROM dpmaps_worker;`

**Absence verification (Stage 003 §7):** automated test asserts zero vendor duration/distance raw values exist in `dpmaps.routing_eval_events`, and that `dpmaps_worker` receives permission-denied on `public.ride_vendor_data`. Raw operational logs containing `trip_id` purge at ≤ 30 days.

---

## 6. Gate 1 Cutover Tracking & Telemetry Dashboard

To graduate from Mode 1 (Shadow) to Mode 2 (Primary), the routing engine must satisfy the numeric cutover gates of Concept Paper §14.3 (relative ETA errors, vendor parity included):

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              GATE 1 CUTOVER CRITERIA                                   │
├──────────────────────────┬─────────────────────────────┬───────────────────────────────┤
│ Evaluation Criterion     │ Quantitative Target         │ Evaluation Window & Rigor     │
├──────────────────────────┼─────────────────────────────┼───────────────────────────────┤
│ **Distance Accuracy**    │ Median distance error <=    │ vs. driven GPS odometer, per  │
│                          │ 3.0% of driven distance     │ vehicle type, 3 consec. ISO   │
│                          │                             │ weeks.                        │
├──────────────────────────┼─────────────────────────────┼───────────────────────────────┤
│ **ETA Accuracy (rel.)**  │ Median ETA error <= 12% of  │ p95 <= 25% of trip duration;  │
│                          │ actual trip duration        │ NEVER flat minutes.           │
├──────────────────────────┼─────────────────────────────┼───────────────────────────────┤
│ **Vendor Parity**        │ median(e_T^dpMaps) <=       │ Measured on the same trip     │
│                          │ median(e_T^Barikoi)         │ sample ("matching or beating  │
│                          │                             │ Barikoi's measured error").   │
├──────────────────────────┼─────────────────────────────┼───────────────────────────────┤
│ **Corridor Overlap**     │ >= 85% overlap vs driven    │ 50 m buffer of OSRM geometry  │
│                          │ trajectories                │ [ESTIMATE radius].            │
├──────────────────────────┼─────────────────────────────┼───────────────────────────────┤
│ **Query Latency**        │ Local OSRM p95 <= 8 ms      │ [ESTIMATE] on local host;     │
│                          │                             │ measure on real graph.        │
├──────────────────────────┼─────────────────────────────┼───────────────────────────────┤
│ **Stability**            │ Zero severity-1 crash       │ Plus internal availability    │
│                          │ regressions                 │ SLO >= 99.95% [ESTIMATE —     │
│                          │                             │ internal metric, not a gate]. │
└──────────────────────────┴─────────────────────────────┴───────────────────────────────┘
```

Weekly medians/percentiles are computed from `dpmaps.routing_eval_events` (`percentile_disc(0.5)`, `percentile_disc(0.95)`), per `vehicle_type` and `tod_bucket`, with a minimum sample floor `[ESTIMATE: 200 completed trips per vehicle type per week]`. Gate advancement remains an admin action gated on these numbers — never a calendar date (concept paper §2.2).

### 6.1 Prometheus Telemetry Metrics

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
  help: 'Rolling 7-day median OSRM distance error percentage vs. driven GPS odometer',
  labelNames: ['vehicle_type']
});

export const gate1DurationErrorGauge = new Gauge({
  name: 'dpmaps_gate1_duration_error_pct',
  help: 'Rolling 7-day median OSRM duration error percentage vs. actual elapsed trip time',
  labelNames: ['vehicle_type']
});

export const vendorParityGauge = new Gauge({
  name: 'dpmaps_vendor_parity_error_gap_pct',
  help: 'median(e_T dpMaps) minus median(e_T vendor) on the same trip sample; negative = beating vendor',
  labelNames: ['vehicle_type']
});

export const shadowSampleCountGauge = new Gauge({
  name: 'dpmaps_shadow_eval_sample_count',
  help: 'Count of completed calibration samples in the current weekly gate window',
  labelNames: ['vehicle_type', 'tod_bucket']
});
```

---

## 7. Commercial Google Failover Circuit Breaker & Spend Cap

To prevent bill spikes during upstream vendor outages:
- **Rolling Volume Cap:** hard ceiling of 500 Google route queries per rolling 15-minute sliding window `[ESTIMATE starting default; admin-configurable in system_config]`.
- **Monetary Spend Cap:** configurable daily spend ceiling in `system_config` `[UNVERIFIED — Google pricing not established in this repository]`. When the ceiling is reached, the breaker stays open for the remainder of the day and failovers drop to the Haversine floor.
- **Service Tier Whitelist:** restricted to premium four-wheeler trips (`Ride Sedan`); disabled for two-wheelers (`Ride Moto`), CNGs, and parcel delivery.
- **Circuit Tripping Threshold:** if Google error rate exceeds 15% `[ESTIMATE]` or the window cap is breached, the circuit opens for 15 minutes `[ESTIMATE]`, directing all subsequent failovers to the in-memory Haversine floor.

---

## 8. Deliverables & Definition of Done

- [ ] `utils-server/dispatchRouter.ts` implemented using clean-room `vendorClientWrapper.ts` exclusively (zero vendor SDK imports); mode values validated with fail-safe `off`; unified timeouts OSRM 300 ms / Barikoi 400 ms / Google 600 ms / floor 0 ms.
- [ ] **Mode 0 (`off`) verified:** zero OSRM calls, zero shadow-quote writes, zero eval writes during maintenance; `traffic_harvest_enabled` independently gated (Stage 004 §6.1).
- [ ] `resolveVendorSelection(temp_client_id)` on `vendor:resolve:*` via atomic `GETDEL` (Redis ≥ 6.2), 120 s TTL, single-use, fails safe to rider reselection with zero database fallback.
- [ ] Vendor transactional records isolated in `public.ride_vendor_data` (zero access for `dpmaps_worker`); vendor polyline annotated pass-through-only and demonstrably absent from all logs and `dpmaps.*` tables.
- [ ] Two-phase clean-room benchmarking operational: `shadowQuoter.ts` caches first-party OSRM quote + geometry keyed `shadow_quote:<trip_hash>` (24 h TTL, zero vendor values); `groundTruthCalibrator.ts` runs as `ride_dispatch`, computes percentages, inserts the exact Stage 003 §4.7 column list (no `trip_id`, no raw vendor quotes).
- [ ] `tod_bucket` resolution (4-value Stage 003 enumeration, configurable boundaries) and `corridor_overlap_pct` / `route_deviation_flag` definitions implemented (§4.3, §4.2).
- [ ] Haversine floor verified at 18 km/h baseline (regression test guards the `/ 18000` factor).
- [ ] Google failover circuit breaker + spend cap verified under simulated rate-limit and spend-ceiling trips.
- [ ] Prometheus metrics exported: `dpmaps_routing_requests_total`, `dpmaps_routing_latency_seconds`, `dpmaps_routing_fallback_total`, Gate 1 gauges, `dpmaps_vendor_parity_error_gap_pct`, `dpmaps_shadow_eval_sample_count`.
- [ ] Gate 1 dashboard computes weekly medians/p95 from `routing_eval_events` with vendor-parity and corridor-overlap criteria; flat-minute thresholds absent.
- [ ] Sub-second hot-reload verified for `routing_provider_mode`; unknown values fail safe to `off` with P1 alert.
- [ ] **Stage 002 Legal Gate Enforced:** `routing_provider_mode` locked to `0: off`; admin toggle rejects transitions to `shadow` until Legal Matrix Items 3, 7, 14, 15, 16, 17 are signed off in writing by counsel.

---

## 9. Revision Changelog

| Revision | Date | Author / Context | Summary of Major Changes |
|---|---|---|---|
| Rev 2.0 | 2026-10-22 | Orchestrator (audited baseline) | Four-mode toggle, dispatch waterfall, `GETDEL` destination resolution, two-phase shadow benchmarking, Gate 1 tracking, Google circuit breaker. |
| Rev 2.1 | 2026-10-22 | Lead Planning & Systems Architecture (audit 004-005) | **Clean-Room Calibration & Schema Repairs:**<br>1. **Schema contract (F-005-1):** Rewrote `groundTruthCalibrator.ts` to the exact Stage 003 §4.7 column list — dropped nonexistent `trip_id`, `vendor_duration_s`, `vendor_distance_m`; added required `vehicle_type`, `tod_bucket`, `vendor_duration_error_pct`, `vendor_distance_error_pct`, `corridor_overlap_pct`, `route_deviation_flag`.<br>2. **Clean-room benchmarking (F-005-2):** Removed raw vendor quotes from the Redis shadow payload; vendor quotes are read once from Tier V `public.ride_vendor_data`; only computed error percentages enter `dpmaps.routing_eval_events`.<br>3. **Correlation (F-005-3):** Shadow quotes keyed `shadow_quote:<trip_hash>` with `trip_hash = HMAC-SHA256(trip_id, IngestionSalt)` (Stage 003 §4.4); raw `trip_id` confined to 30-day-purge operational logs.<br>4. **Role boundary (F-005-4):** Calibrator runs as `ride_dispatch` with explicit grants; `dpmaps_worker` retains `REVOKE ALL` on vendor data.<br>5. **Gate 1 repair (F-005-5):** Median statistics; added vendor-parity clause and corridor overlap ≥ 85%; demoted availability to internal SLO `[ESTIMATE]`; removed invented "95% of trips" wording.<br>6. **Haversine bug (F-005-6):** Fixed duration factor from `/ 5000` to `/ 18000` (18 km/h baseline).<br>7. **Mode 0 & timeouts (F-005-7, F-005-8):** Explicit first-class `off` semantics (zero OSRM/shadow/harvest overhead); unified 300/400/600/0 ms budgets; invalid mode values fail safe to `off` with alert.<br>8. **Definitions (F-005-9 … F-005-12):** Vendor polyline pass-through-only contract; `tod_bucket` boundaries and 4-value enumeration of record; `corridor_overlap_pct` (50 m buffer of OSRM geometry only) and `route_deviation_flag`; Redis ≥ 6.2 `GETDEL` client note. |
