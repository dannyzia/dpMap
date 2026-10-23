# dpMaps — Ride Backend Integration Guide

This guide explains how to connect **dpMaps** to your ride-hailing backend (**Ride**).

---

## 1. Architecture Overview

Your mobile apps (Rider and Driver) communicate exclusively with your **Ride Backend**. The Ride Backend sits in front of dpMaps, Barikoi, and Google Maps, acting as the decision gateway.

```text
[ Rider Mobile App ]       [ Driver Mobile App ]
         │                          │
         └───────────┬──────────────┘
                     ▼
             [ Ride Backend ]
  (Express / NestJS / Go / Python / etc.)
                     │
     ┌───────────────┼───────────────┐
     ▼               ▼               ▼
[ Barikoi API ]   [ dpMaps ]    [ Google Maps API ]
 (Default Live)   (In-House)    (Capped Emergency)
```

There are **4 primary integration touchpoints**:
1. **Autocomplete & Search** (Rider destination lookup)
2. **Dispatch & Routing** (Distance, ETA, and fare estimation)
3. **Trip Telemetry Ingestion** (How dpMaps learns from completed rides)
4. **Map Tile Display** (MapLibre vector tiles on mobile handsets)

---

## 2. Touchpoint 1: Autocomplete & Search

When a rider types in the destination field, the Ride backend queries dpMaps (or merges with Barikoi during transition).

### API Request (From Mobile App to Ride Backend)
```http
GET /api/v1/search/autocomplete?q=dhanmondi%2027&lat=23.7785&lng=90.4180
```

### Ride Backend Implementation
```typescript
import { searchMixedAutocomplete } from './services/searchOrchestrator';

export async function handleAutocomplete(req, res) {
  const { q, lat, lng } = req.query;
  const userLanguage = req.headers['accept-language']?.includes('bn') ? 'bn' : 'en';

  // 1. Execute search against dpMaps dual indexes (First-Party + OSM)
  const results = await searchMixedAutocomplete({
    query: q,
    proximity: { lat: Number(lat), lng: Number(lng) },
    language: userLanguage,
    limit: 10,
  });

  // 2. Return clean results with session tokens for selection tracking
  res.json({
    suggestions: results.map((item) => ({
      place_id: item.id,
      title: item.display_name,
      subtitle: item.area_name,
      point_type: item.point_type, // 'entrance' | 'building' | 'area'
      session_token: item.session_token, // 15-min single-use ticket
    })),
  });
}
```

---

## 3. Touchpoint 2: Dispatch Routing & Fare Quote

When calculating the ride fare and estimated time of arrival (ETA), the Ride backend calls `calculateDispatchRoute`.

### API Request
```http
POST /api/v1/dispatch/route-quote
Content-Type: application/json

{
  "pickup": { "lat": 23.7785, "lng": 90.4180 },
  "dropoff": { "lat": 23.7538, "lng": 90.3712 },
  "vehicle_type": "car"
}
```

### Ride Backend Implementation
```typescript
import { calculateDispatchRoute } from './services/dispatchRouter';
import { getSystemConfig } from './services/configService';

export async function handleRouteQuote(req, res) {
  const { pickup, dropoff, vehicle_type } = req.body;
  
  // Read current provider mode from hot-reloadable config: 'off' | 'shadow' | 'primary' | 'sole'
  const mode = await getSystemConfig('ROUTING_PROVIDER_MODE', 'shadow');

  const quote = await calculateDispatchRoute(
    {
      tripId: req.body.tripId || crypto.randomUUID(),
      origin: pickup,
      destination: dropoff,
      vehicleType: vehicle_type, // 'car' | 'bike' | 'cng'
    },
    {
      getModeRaw: () => mode,
      isLegalGateOpen: () => true,
      resolveSelection: async (token) => resolveDestToken(token),
      osrmRoute: async (origin, dest, vehicle) => osrmClient.route(origin, dest, vehicle),
      barikoiRoute: async (origin, dest) => barikoiClient.route(origin, dest),
      googleRoute: async (origin, dest) => googleClient.route(origin, dest),
      recordShadow: async (key, shadowQuote, ttl) => redis.set(key, JSON.stringify(shadowQuote), 'EX', ttl),
    }
  );

  // Return fare calculation to passenger
  const fareBdt = calculateFare(quote.distance_meters, quote.duration_seconds, vehicle_type);

  res.json({
    distance_meters: quote.distance_meters,
    duration_seconds: quote.duration_seconds,
    fare_bdt: fareBdt,
    served_by: quote.provider, // 'osrm' | 'barikoi' | 'google'
  });
}
```

---

## 4. Touchpoint 3: Completed Trip Ingestion (How dpMaps Learns)

When a driver taps **"Complete Ride"**, the Ride backend captures the ground truth and forwards it to dpMaps for learning.

### The Ingestion Rule:
* **Location Truth:** The driver's end-of-trip GPS coordinates (`dropoff_lat`, `dropoff_lng`).
* **Name Truth:** The rider's final typed search query at the moment of selection.
* **Clean Room Invariant:** Never pass vendor coordinates, vendor IDs, or order IDs into the evidence ledger.

### Ride Backend Implementation (Trip Completion Webhook / Event)
```typescript
import { ingestCompletedTrip } from './services/evidenceIngestor';
import { scrubPii } from './utils-server/vendorClientWrapper';

// Called immediately after driver completes the trip in DB
export async function onTripCompleted(order) {
  // 1. Scrub any user personal information (phone numbers, flat numbers)
  const cleanSearchQuery = scrubPii(order.rider_destination_typed_query);
  if (!cleanSearchQuery || cleanSearchQuery.length < 2) return;

  // 2. Ingest telemetry into the dpMaps continuous learning ledger
  await ingestCompletedTrip({
    rider_user_id: order.rider_user_id, // Automatically pseudonymized via keyed HMAC
    driver_user_id: order.driver_user_id,
    typed_query: cleanSearchQuery,
    driver_dropoff_gps: {
      lat: order.driver_final_gps_lat,
      lng: order.driver_final_gps_lng,
    },
    completed_at: order.completed_at,
  });
}
```

---

## 5. Touchpoint 4: Mobile Handset Map Display (Vector Tiles)

For the interactive map on the rider and driver phone screens, use the standard **MapLibre GL** open-source SDK (available for Flutter, React Native, iOS Swift, and Android Kotlin).

### Mobile App Configuration
Point your mobile app's MapLibre view to your dpMaps vector tile endpoint:

```json
{
  "version": 8,
  "name": "dpMaps-Dhaka",
  "sources": {
    "dpmaps_tiles": {
      "type": "vector",
      "url": "https://tiles.yourdomain.com/tiles/bangladesh.json"
    }
  },
  "glyphs": "https://tiles.yourdomain.com/fonts/{fontstack}/{range}.pbf",
  "layers": [ ... ]
}
```

* **Bengali Typography:** Font glyphs are pre-generated with SDF (Signed Distance Fields) for `Noto Sans Bengali` to guarantee proper rendering of Bangla conjuncts (*যুক্তবর্ণ*).

---

## 6. Touchpoint 5: Perimeter Gate Snapping (Gated Communities & Malls)

For mega-destinations (e.g. Jamuna Future Park, Bashundhara R/A, Dhaka Airport, Cantonment), dropping a pin in the middle of the building causes drivers to navigate to expressways or dead ends.

### Usage in Backend:
```typescript
import { snapToGate } from './services/perimeterGateSnapper';

export async function getDropoffTarget(pinLat, pinLng, vehicleType) {
  const result = await snapToGate(gateSnapperDeps, pinLat, pinLng, vehicleType);

  if (result.snapped) {
    return {
      driver_destination: { lat: result.gate.lat, lng: result.gate.lng },
      gate_name: result.gate.canonical_name, // e.g., "North Gate 1 (Kuril Side)"
      walking_distance_m: result.connector.walk_distance_m,
    };
  }

  return { driver_destination: { lat: pinLat, lng: pinLng } };
}
```

---

## 7. Migration Roadmap (From Vendor to In-House)

| Phase | Duration | Action in Ride Backend |
|---|---|---|
| **Phase 0: Launch** | Day 1 | Run in **Mode 1 (Shadow)**. Barikoi serves all live requests. Completed trips feed the dpMaps evidence ledger. |
| **Phase 1: Verification** | Month 1–3 | Run nightly benchmark suites (`npm run benchmark`). Verify Gate 1A (ETA error $\le 12\%$) and Gate 1B (Search Top-1 accuracy $\ge 92\%$). |
| **Phase 2: Primary Cutover** | Month 3–4 | Switch config to **Mode 2 (Primary)**. dpMaps serves all live traffic first; Barikoi acts as backup only on timeout. |
| **Phase 3: Full Sovereignty** | Month 4+ | Switch config to **Mode 3 (Sole)**. Disconnect Barikoi entirely. 100% self-sufficient. |

---

## 8. Summary Checklist for Backend Engineers

- [ ] Import `calculateDispatchRoute` into ride estimation controller.
- [ ] Connect `onTripCompleted` hook to call `ingestCompletedTrip`.
- [ ] Configure `ROUTING_PROVIDER_MODE` environment variable (`shadow` at launch).
- [ ] Point MapLibre client in mobile apps to Cloudflare R2 / PMTiles endpoint.
- [ ] Verify that no vendor-derived coordinates or polylines are saved to `dpmaps.*` tables.

---

## 9. Prompt for the Ride App Orchestrator / Engineering Team

Copy and paste the prompt below directly to the AI agent, orchestrator, or lead developer working on the **Ride App Backend & Admin Panel**:

````markdown
### Task: Integrate dpMaps In-House Mapping Engine with Admin Panel Controls

We need to integrate our in-house mapping, routing, and search engine (**dpMaps**) into the Ride platform.
The integration must be fully configurable through a new **"Maps & Location Engine"** tab in the Ride Admin Panel so operations can dynamically switch between Barikoi, dpMaps shadow mode, primary cutover, and emergency fallback without code redeployments.

---

### Part 1: Admin Panel UI & Config Storage (`Ride Admin`)

Add a new configuration module under **Admin Panel → Settings → Maps & Location Engine** with the following dynamic settings (stored in `system_configs` and cached in Redis with hot-reload):

1. **Routing Provider Mode (`ROUTING_PROVIDER_MODE`)**:
   - `0: Off` — 100% Barikoi vendor routing, zero dpMaps overhead.
   - `1: Shadow (Default at launch)` — Barikoi serves riders live. dpMaps OSRM runs asynchronously in the background and logs benchmark accuracy scorecards.
   - `2: Primary` — dpMaps OSRM serves riders first (300 ms SLA); automatically falls back to Barikoi on timeout/error.
   - `3: Sole` — 100% dpMaps OSRM. Barikoi and Google endpoints severed in code.
2. **Search Provider Mode (`SEARCH_PROVIDER_MODE`)**:
   - `vendor_only` | `mixed_shadow` (Default) | `dpmaps_primary` | `dpmaps_sole`
3. **dpMaps Service Endpoints**:
   - `DPMAPS_OSRM_CAR_URL` (default: `http://dpmaps-osrm-car:5001`)
   - `DPMAPS_OSRM_BIKE_URL` (default: `http://dpmaps-osrm-bike:5002`)
   - `DPMAPS_OSRM_CNG_URL` (default: `http://dpmaps-osrm-cng:5003`)
   - `DPMAPS_MEILISEARCH_URL` (default: `http://dpmaps-meilisearch:7700`)
   - `DPMAPS_TILES_STYLE_URL` (default: `https://tiles.yourdomain.com/style.json`)
4. **Latency Budgets & Circuit Breakers**:
   - OSRM Timeout (ms): default `300`
   - Barikoi Timeout (ms): default `400`
   - Google Fallback Monthly Spend Cap ($): default `50.00`
5. **Telemetry Learning Toggle (`DPMAPS_LEARNING_INGEST_ENABLED`)**:
   - Boolean toggle (Default: `true`). Forwards completed trip drop-off GPS fixes to the dpMaps evidence ledger.
6. **One-Click Emergency Rollback Button**:
   - An immediate administrative button that instantly sets `ROUTING_PROVIDER_MODE = 1 (shadow)` or `0 (off)` and triggers an atomic Redis config purge without restarting servers.

---

### Part 2: Ride Backend Hook Integration (`Ride Backend`)

Implement the following three hooks in the Ride backend:

#### Hook A: Fare & Distance Estimation (`/api/v1/dispatch/route-quote`)
Call dpMaps's `calculateDispatchRoute(req, deps)`:
- In `shadow` mode: return Barikoi's live route to the rider, while firing the dpMaps OSRM shadow quote asynchronously via `setImmediate` to write `shadow:route:<trip_hash>` in Redis.
- In `primary` mode: serve OSRM route. If OSRM times out (>300ms), log a P2 alert and fall back to Barikoi.

#### Hook B: Autocomplete Search (`/api/v1/search/autocomplete`)
Call dpMaps's `searchMixedAutocomplete`:
- Merge results in RAM from dpMaps first-party POIs and OSM POIs.
- Pass the 15-minute `session_token` back to the mobile handset.

#### Hook C: Trip Completion Learning Hook (`onTripCompleted`)
When a trip status transitions to `completed`:
1. Extract the rider's final typed search query and run `scrubPii()` to strip any personal phone numbers or holding numbers.
2. Ingest the cleaned query alongside the **driver's end-of-trip drop-off GPS fix** (`lat`, `lng`) into `ingestCompletedTrip`.
3. **Hard Rule:** NEVER save vendor coordinates, vendor IDs, or order IDs into the dpMaps learning ledger tables.

---

### Part 3: Mobile Apps Handset Map Style (`Rider & Driver Apps`)

Expose the dynamic `map_style_url` from the backend handshake endpoint (`/api/v1/app/config`), pointing to:
`https://tiles.yourdomain.com/style.json`
Configure the MapLibre mobile SDK to use this vector tile endpoint and Noto Sans Bengali SDF glyphs for crisp Bangla script rendering.

---

### Part 4: Verification Checklist

1. Verify changing the mode in the Admin Panel updates routing behavior within 5 seconds without server restart.
2. Verify completed trips write rows to `dpmaps.evidence_ledger` with keyed HMAC pseudonymization and zero `trip_id`.
3. Verify that simulating an OSRM 500 error in `primary` mode triggers automatic zero-downtime fallback to Barikoi.
````
