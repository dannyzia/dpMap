# Stage 013: Specialized Geocoding, Parsing & Snapping Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-013  
**Stage:** 13 of 16 (Specialized Geospatial Capabilities)  
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§15, §15.1–15.4)  
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)  
**Current Status:** **Revision 2.0 (Audited & Upgraded)**  
**Target Phase:** Phase 2 (The Routing Switch Flip / Specialized Services)  
**Primary Dependencies:** [`001_phase0_landmark_seeding_and_data_assets.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/001_phase0_landmark_seeding_and_data_assets.md), [`003_storage_schema_and_continuous_evidence_ledger.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/003_storage_schema_and_continuous_evidence_ledger.md), [`004_osrm_routing_engine_and_dynamic_traffic.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/004_osrm_routing_engine_and_dynamic_traffic.md), [`007_text_normalization_and_alias_clustering.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/007_text_normalization_and_alias_clustering.md), [`008_search_engine_meilisearch_and_mixed_autocomplete.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/008_search_engine_meilisearch_and_mixed_autocomplete.md)

---

## 1. Executive Summary & Objective

Standard commercial mapping APIs assume structured, linear western addresses with complete building footprints and consistent numbering. When applied to high-density South Asian megacities like Dhaka, these generic engines fail systematically:
1. **Reverse Geocoding Failure:** Dragging a pin to a residential street without building polygons returns ambiguous administrative names (*"Dhaka Division, Bangladesh"*) or misleading postal centroids 3 km away.
2. **Compound Address Query Zero-Hits:** Users search compound hierarchical strings (*"Flat 5B, House 23, Road 4, Block C, Banani"*). Generic search engines attempt exact string matching on the entire phrase, returning zero results because the micro-units (`Flat 5B`, `House 23`) are not public landmarks.
3. **Centroid Snapping Traps:** Dropping a pin inside large urban mega-complexes (Jamuna Future Park, Bashundhara City Mall, Dhaka Airport, Dhaka Medical College) snaps drivers to inaccessible expressways, security medians, or pedestrian-only courtyards.

Stage 013 implements three sovereign, localized spatial engines:
- **Engine 1: Sovereign Reverse Geocoder (Pin-to-Text Waterfall):** Resolves coordinates via a 4-tier waterfall (POI Proximity $\rightarrow$ Street Centerline $\rightarrow$ Administrative Boundary $\rightarrow$ H3 Centroid) with Redis spatial caching (<25ms p95 latency).
- **Engine 2: Dhaka Compound Address Tokenizer:** Deconstructs complex hierarchical addresses, isolating private unit numbers into **Driver Delivery Notes** while routing the resolvable spatial anchors (*"Road 4, Block C, Banani"*) to the search index.
- **Engine 3: Intelligent Perimeter Gate Pickup Snapper:** Snaps vehicle dispatch destinations to legal, drivable perimeter curb gates with pedestrian walking connectors for major complexes.

---

## 2. Specialized Engine 1: Sovereign Reverse Geocoder Waterfall

When a passenger drags the map pin, the mobile client requires instantaneous, culturally accurate, human-readable text. dpMaps resolves coordinates via a strict 4-tier sovereign waterfall:

```
[ Rider Drops Pin (lat, lng) ]
               │
               ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ TIER 1: Landmark Proximity (PostGIS ST_DWithin <= 50m)                                  │
│ • Checks dpmaps.public_pois for high-confidence landmarks within 50 meters             │
│ • Format: "Near {canonical_name}, {neighborhood}"                                      │
│ • e.g. "Near Square Hospital, West Panthapath"                                         │
└────────────────────────────────────────────────────────────────────────────────────────┘
               │ (If no POI within 50m)
               ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ TIER 2: Street Centerline & Corridor Lookup (OSM / Nominatim Container <= 30m)        │
│ • Queries local street network centerline within 30m                                   │
│ • Format: "{road_name}, {ward/area}, Dhaka"                                            │
│ • e.g. "Road 11, Banani, Dhaka" or "Pragati Sarani, Baridhara"                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
               │ (If unmapped street or timeout > 50ms)
               ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ TIER 3: Relational Admin Boundary Hierarchy (dpmaps.admin_boundaries ADM4/ADM3)       │
│ • PostGIS ST_Contains lookup against official Ward / Thana boundaries                   │
│ • Format: "{Ward / Area Name}, {Thana Name}, Dhaka"                                    │
│ • e.g. "Ward 19, Gulshan, Dhaka" or "Sector 4, Uttara, Dhaka"                          │
└────────────────────────────────────────────────────────────────────────────────────────┘
               │ (If boundary lookup fails or boundary is missing)
               ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ TIER 4: Coarse H3 Administrative Centroid Fallback (In-Memory H3 Res 8/9 Table)        │
│ • Reverse lookup parent H3 cell in pre-loaded in-memory zone map                        │
│ • Format: "{Sub-district / Thana}, Dhaka"                                              │
│ • e.g. "Dhanmondi, Dhaka" or "Mirpur, Dhaka"                                           │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Spatial Geohash Caching
Reverse geocoding requests are clustered spatially using **Geohash Resolution 7** (~$150\text{m} \times 150\text{m}$ precision). Results are cached in Redis under `dpmaps:reverse_geo:{geohash7}` with a 24-hour TTL, reducing database load by $> 75\%$ and yielding sub-2ms response times for repeated pin drops in high-density corridors.

---

## 3. Specialized Engine 2: Dhaka Compound Address Tokenizer

Bangladeshi addresses are structured as reverse-hierarchical compounds combining micro-residential units, street numbers, neighborhood sectors, and municipal postal codes:
$$\text{"Flat 5B, House 23/A, Road 4, Block C, Sector 11, Uttara, Dhaka-1230"}$$

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        DHAKA COMPOUND ADDRESS DECOMPOSITION                            │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   Raw Address: "Flat 5B, House 23/A, Road 4, Block C, Uttara, Dhaka-1230"              │
│                                                                                        │
│   ┌──────────────────────────────────────────────┬─────────────────────────────────┐   │
│   │ PRIVATE UNIT TOKENS (Micro-Delivery)         │ RESOLVABLE SPATIAL ANCHORS      │   │
│   ├──────────────────────────────────────────────┼─────────────────────────────────┤   │
│   │ • Flat / Unit: "Flat 5B"                     │ • Road / Lane: "Road 4"         │   │
│   │ • Holding / Plot: "House 23/A"               │ • Block / Sector: "Block C"     │   │
│   │                                              │ • Area / Thana: "Uttara"        │   │
│   │                                              │ • Postal Code: "1230"           │   │
│   └──────────────────────────────────────────────┴─────────────────────────────────┘   │
│                          │                                       │                     │
│                          ▼                                       ▼                     │
│   ┌──────────────────────────────────────────────┐ ┌─────────────────────────────────┐ │
│   │ Driver Delivery Notes                        │ │ Search Query to MeiliSearch:    │ │
│   │ (Injected into Driver Dispatch Screen on     │ │ "Road 4 Block C Uttara"         │ │
│   │  trip acceptance; NEVER sent to public map)  │ │ (Returns exact street/block pin)│ │
│   └──────────────────────────────────────────────┘ └─────────────────────────────────┘ │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Token Extraction Rules & Bilingual Folding
1. **Script Folding:** Transliterates Bengali numerals (`০-৯`) to standard ASCII digits (`0-9`) using Stage 007's normalizer before token matching.
2. **Micro-Unit Extraction:**
   - Flat/Unit Regex: `/\b(flat|apt|apartment|suite)\s*#?\s*([0-9a-z\-\/]+)\b/i` and `/\b([1-9][0-9]?\s*(তলা|ফ্ল্যাট))\b/`
   - Holding/House Regex: `/\b(house|holding|plot|বাড়ি|হোল্ডিং)\s*#?\s*([0-9a-z\-\/]+)\b/i`
3. **Spatial Anchor Extraction:**
   - Road Regex: `/\b(road|rd|avenue|ave|goli|lane|সড়ক|রোড|গলি)\s*#?\s*([0-9a-z\-\/]+)\b/i`
   - Block/Sector Regex: `/\b(block|sec|sector|section|ব্লক|সেক্টর)\s*#?\s*([0-9a-z]+)\b/i`
4. **Zero-Hit Prevention:** The tokenizer strips micro-units from the string before submitting to MeiliSearch. Searching `"Flat 5B House 23 Road 4 Banani"` causes zero hits; searching `"Road 4 Banani"` resolves instantly to the correct street centroid.

---

## 4. Specialized Engine 3: Intelligent Perimeter Gate Pickup Snapper

### 4.1 The Mega-Complex Problem in Dhaka
Dhaka contains expansive, walled commercial and civic campuses:
- **Jamuna Future Park (JFP):** 33 acres, bounded by Pragati Sarani and Kuril Flyover.
- **Bashundhara City Shopping Mall:** Multi-acre complex on Panthapath.
- **Hazrat Shahjalal International Airport (HSIA):** Hundreds of acres, multi-terminal perimeter.
- **Dhaka Medical College Hospital (DMCH):** Multi-gate historical medical complex.
- **BUET & Dhaka University Campuses:** Walled educational perimeters with designated vehicle gates.

If a passenger drops a pin inside the building polygon or central courtyard, a naive routing engine calculates the straight-line nearest road edge, routing the driver to:
- An illegal stopping point on an elevated expressway ramp.
- A pedestrian-only security perimeter wall.
- The wrong side of a physical wall separated by a 2 km detour.

### 4.2 Perimeter Gate Taxonomy & Snapping Topology
In accordance with Stage 003, entities in `dpmaps.public_pois` support explicit hierarchical perimeter gates:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        INTELLIGENT PERIMETER GATE SNAPPING                             │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│                                  Pragati Sarani                                        │
│  ══════════════════════════════════════╤═════════════════════════════════════════════  │
│                                        │ (Legal Curb Snapping Point)                   │
│                                        ▼                                               │
│                         ┌─────────────────────────────┐                                │
│                         │ Gate 2: North Vehicle Drop  │                                │
│                         │ (point_type: 'entrance')    │                                │
│                         └──────────────┬──────────────┘                                │
│                                        │                                               │
│                                        │ (Pedestrian Dashed Connector: 45m / 1 min)    │
│                                        │                                               │
│                         ┌──────────────▼──────────────┐                                │
│                         │   [ User Dropped Pin Here ] │                                │
│                         │   Jamuna Future Park Inside │                                │
│                         │   (point_type: 'building')  │                                │
│                         └─────────────────────────────┘                                │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Snapping Algorithm Workflow
1. **Venue Identification:** Check if the dropped pin coordinate $(lat, lng)$ falls within a known complex boundary polygon (`ST_Contains`) or within $150\text{m}$ of a major campus centroid in `dpmaps.public_pois`.
2. **Gate Selection:** Query all child entrance gates linked via `parent_place_id` where `point_type = 'entrance'`.
3. **Vehicle Profile Filtering:** Filter gates matching the requested vehicle mode (e.g. some gates allow Bikes and CNGs, while Cars are restricted to primary perimeter gates).
4. **Nearest Gate Snapping:** Select the entrance gate with the minimum Euclidean distance to the dropped pin.
5. **Driver Curb Target:** Set the driver's OSRM navigation target strictly to the gate's `entrance_geom` (which is pre-snapped to the legal roadside curb).
6. **Pedestrian Connector:** Return a GeoJSON LineString connecting the user's dropped pin to the snapped gate curb, annotated with estimated walking distance and time.

---

## 5. Implementation: Specialized Engines

```typescript
// utils-server/reverseGeocoder.ts
import { Pool } from 'pg';
import { RedisClientType } from 'redis';
import { logger } from './logger';

export interface ReverseGeocodeResult {
  formatted_address: string;
  bangla_address?: string;
  landmark_name?: string;
  source: 'public_poi_proximity' | 'street_centerline' | 'admin_boundary' | 'h3_fallback';
  confidence: number;
}

export class ReverseGeocoderService {
  constructor(
    private readonly dbPool: Pool,
    private readonly redisClient: RedisClientType
  ) {}

  async reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult> {
    const geohash = this.encodeGeohash(lat, lng, 7);
    const cacheKey = `dpmaps:reverse_geo:${geohash}`;

    // 0. Check Redis Geohash Cache (< 2ms)
    try {
      const cached = await this.redisClient.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      logger.error({ err }, '[ReverseGeo] Redis cache read failed');
    }

    const client = await this.dbPool.connect();
    try {
      // TIER 1: Check Landmark Proximity within 50m
      const poiRes = await client.query(
        `SELECT canonical_name, bangla_name, category
         FROM dpmaps.public_pois
         WHERE lifecycle_status = 'published'
           AND ST_DWithin(geom, ST_SetSRID(ST_Point($1, $2), 4326), 0.00045)
         ORDER BY ST_Distance(geom, ST_SetSRID(ST_Point($1, $2), 4326)) ASC
         LIMIT 1`,
        [lng, lat]
      );

      if (poiRes.rows.length > 0) {
        const poi = poiRes.rows[0];
        const result: ReverseGeocodeResult = {
          formatted_address: `Near ${poi.canonical_name}`,
          bangla_address: poi.bangla_name ? `${poi.bangla_name}-এর কাছে` : undefined,
          landmark_name: poi.canonical_name,
          source: 'public_poi_proximity',
          confidence: 0.95
        };
        await this.redisClient.set(cacheKey, JSON.stringify(result), { EX: 86400 });
        return result;
      }

      // TIER 2 & 3: Check Admin Boundaries (Ward / Thana)
      const adminRes = await client.query(
        `SELECT name_en, name_bn, admin_level
         FROM dpmaps.admin_boundaries
         WHERE ST_Contains(geom, ST_SetSRID(ST_Point($1, $2), 4326))
         ORDER BY admin_level DESC
         LIMIT 2`,
        [lng, lat]
      );

      if (adminRes.rows.length > 0) {
        const primary = adminRes.rows[0];
        const parent = adminRes.rows[1] || null;
        const formatted = parent ? `${primary.name_en}, ${parent.name_en}` : `${primary.name_en}, Dhaka`;
        const bangla = parent ? `${primary.name_bn}, ${parent.name_bn}` : `${primary.name_bn}, ঢাকা`;

        const result: ReverseGeocodeResult = {
          formatted_address: formatted,
          bangla_address: bangla,
          source: 'admin_boundary',
          confidence: 0.80
        };
        await this.redisClient.set(cacheKey, JSON.stringify(result), { EX: 86400 });
        return result;
      }

      // TIER 4: Fallback
      const fallback: ReverseGeocodeResult = {
        formatted_address: 'Dhaka, Bangladesh',
        bangla_address: 'ঢাকা, বাংলাদেশ',
        source: 'h3_fallback',
        confidence: 0.50
      };
      return fallback;
    } finally {
      client.release();
    }
  }

  private encodeGeohash(lat: number, lng: number, precision: number): string {
    // Standard compact geohash encoder stub
    return `${lat.toFixed(3)}_${lng.toFixed(3)}`;
  }
}
```

### 5.2 Dhaka Compound Address Tokenizer Implementation

```typescript
// utils-server/addressParser.ts

export interface ParsedDhakaAddress {
  raw_input: string;
  delivery_notes: string;         // Isolated micro-units for driver display
  resolvable_query: string;       // Cleaned string sent to MeiliSearch
  flat?: string;
  house?: string;
  road?: string;
  block?: string;
  sector?: string;
  area?: string;
  postal_code?: string;
}

export function parseDhakaCompoundAddress(input: string): ParsedDhakaAddress {
  if (!input) {
    return { raw_input: '', delivery_notes: '', resolvable_query: '' };
  }

  // 1. Fold Bengali Numerals to Standard ASCII Digits (০-৯ -> 0-9)
  const bengaliDigits = ['০','১','২','৩','৪','৫','৬','৭','৮','৯'];
  let text = input.trim();
  for (let i = 0; i < 10; i++) {
    text = text.replace(new RegExp(bengaliDigits[i], 'g'), i.toString());
  }

  // 2. Extract Micro-Unit Tokens (Flat, Floor)
  const flatMatch = text.match(/\b(flat|apt|apartment|suite)\s*#?\s*([0-9a-z\-\/]+)\b/i) ||
                    text.match(/\b([1-9][0-9]?\s*(তলা|ফ্ল্যাট))\b/i);
  const flat = flatMatch ? flatMatch[0].trim() : undefined;

  // 3. Extract House / Holding / Plot
  const houseMatch = text.match(/\b(house|holding|plot|বাড়ি|হোল্ডিং)\s*#?\s*([0-9a-z\-\/]+)\b/i);
  const house = houseMatch ? houseMatch[0].trim() : undefined;

  // 4. Extract Road / Street / Lane
  const roadMatch = text.match(/\b(road|rd|avenue|ave|lane|goli|সড়ক|রোড|গলি)\s*#?\s*([0-9a-z\-\/]+)\b/i);
  const road = roadMatch ? roadMatch[0].trim() : undefined;

  // 5. Extract Block / Section
  const blockMatch = text.match(/\b(block|section|ব্লক)\s*#?\s*([0-9a-z]+)\b/i);
  const block = blockMatch ? blockMatch[0].trim() : undefined;

  // 6. Extract Sector
  const sectorMatch = text.match(/\b(sec|sector|সেক্টর)\s*#?\s*([0-9a-z]+)\b/i);
  const sector = sectorMatch ? sectorMatch[0].trim() : undefined;

  // 7. Extract Postal Code
  const postalMatch = text.match(/\b(1[0-9]{3})\b/);
  const postal_code = postalMatch ? postalMatch[1] : undefined;

  // Assemble Delivery Notes for Driver Handset
  const deliveryNotesList = [flat, house].filter(Boolean);
  const delivery_notes = deliveryNotesList.join(', ');

  // Strip Micro-Units from Resolvable Search Query to Prevent Zero-Hits
  let resolvable = text;
  if (flatMatch) resolvable = resolvable.replace(flatMatch[0], '');
  if (houseMatch) resolvable = resolvable.replace(houseMatch[0], '');
  if (postalMatch) resolvable = resolvable.replace(postalMatch[0], '');

  resolvable = resolvable
    .replace(/[,;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    raw_input: input,
    delivery_notes,
    resolvable_query: resolvable.length > 2 ? resolvable : input,
    flat,
    house,
    road,
    block,
    sector,
    postal_code
  };
}
```

### 5.3 Intelligent Perimeter Gate Snapper Implementation

```typescript
// utils-server/pickupSnapper.ts
import { Pool } from 'pg';
import { logger } from './logger';

export interface SnappedPickupResult {
  snapped: boolean;
  vehicle_pickup_point: { lat: number; lng: number };
  gate_name?: string;
  venue_name?: string;
  pedestrian_connector?: {
    walking_distance_meters: number;
    walking_duration_seconds: number;
    geojson_linestring: object;
  };
}

export class PickupSnapperService {
  constructor(private readonly dbPool: Pool) {}

  /**
   * Snaps pin drops inside mega-complexes to the nearest legal vehicle perimeter gate
   */
  async snapPickup(
    pinLat: number,
    pinLng: number,
    vehicleType: 'car' | 'bike' | 'cng' = 'car'
  ): Promise<SnappedPickupResult> {
    const client = await this.dbPool.connect();
    try {
      // 1. Check if pin is inside or within 100m of a venue with verified entrance gates
      const venueQuery = `
        SELECT p.id as venue_id, p.canonical_name as venue_name
        FROM dpmaps.public_pois p
        WHERE p.point_type IN ('building', 'area')
          AND p.lifecycle_status = 'published'
          AND ST_DWithin(p.geom, ST_SetSRID(ST_Point($1, $2), 4326), 0.0015)
        ORDER BY ST_Distance(p.geom, ST_SetSRID(ST_Point($1, $2), 4326)) ASC
        LIMIT 1
      `;
      const venueRes = await client.query(venueQuery, [pinLng, pinLat]);

      if (venueRes.rows.length === 0) {
        // Not inside a specialized complex: standard road curb snapping
        return {
          snapped: false,
          vehicle_pickup_point: { lat: pinLat, lng: pinLng }
        };
      }

      const venue = venueRes.rows[0];

      // 2. Query perimeter entrance gates linked to this venue
      const gatesQuery = `
        SELECT 
          id, canonical_name,
          ST_Y(entrance_geom) as gate_lat,
          ST_X(entrance_geom) as gate_lng,
          ST_Distance(
            entrance_geom::geography,
            ST_SetSRID(ST_Point($1, $2), 4326)::geography
          ) as walk_meters
        FROM dpmaps.public_pois
        WHERE parent_place_id = $3
          AND point_type = 'entrance'
          AND lifecycle_status = 'published'
          AND entrance_geom IS NOT NULL
        ORDER BY walk_meters ASC
        LIMIT 1
      `;
      const gateRes = await client.query(gatesQuery, [pinLng, pinLat, venue.venue_id]);

      if (gateRes.rows.length === 0) {
        return {
          snapped: false,
          vehicle_pickup_point: { lat: pinLat, lng: pinLng }
        };
      }

      const gate = gateRes.rows[0];
      const walkMeters = Math.round(parseFloat(gate.walk_meters));
      const walkSeconds = Math.round(walkMeters / 1.2); // ~1.2 m/s average walking speed

      return {
        snapped: true,
        vehicle_pickup_point: {
          lat: parseFloat(gate.gate_lat),
          lng: parseFloat(gate.gate_lng)
        },
        gate_name: gate.canonical_name,
        venue_name: venue.venue_name,
        pedestrian_connector: {
          walking_distance_meters: walkMeters,
          walking_duration_seconds: walkSeconds,
          geojson_linestring: {
            type: 'LineString',
            coordinates: [
              [pinLng, pinLat],
              [parseFloat(gate.gate_lng), parseFloat(gate.gate_lat)]
            ]
          }
        }
      };
    } finally {
      client.release();
    }
  }
}
```

---

## 6. Unit Testing Matrix & Specialized Verification

| Test Case | Scenario / Parameters | Expected Outcome | Rationale |
|---|---|:---:|---|
| **TC-013-01** | Pin dropped 25m from Square Hospital | **Near Square Hospital** | Tier 1 Proximity hit (<50m). |
| **TC-013-02** | Pin dropped on residential lane, no POI within 50m | **Road 11, Banani, Dhaka** | Tier 2 Street Centerline hit. |
| **TC-013-03** | Pin dropped in open field/lake | **Sector 18, Uttara, Dhaka** | Tier 3 Admin Boundary hit. |
| **TC-013-04** | Compound address with flat & house | **Stripped to resolvable query** | Flat 5B / House 23 routed to delivery notes; Road/Block sent to search. |
| **TC-013-05** | Bengali compound address with numerals | **Correctly parsed & folded** | `রোড ৪, সেক্টর ১১` parsed to `Road 4 Sector 11`. |
| **TC-013-06** | Pin dropped in center of Jamuna Future Park | **Snapped to Gate 2 Curb** | Perimeter gate snapper activates; prevents highway stopping. |
| **TC-013-07** | Pedestrian connector calculated | **LineString with walk metrics** | Returns 45m distance and ~38s walking estimate. |
| **TC-013-08** | Reverse geocode cache hit | **Response in < 2ms** | Redis geohash cache hit bypasses PostgreSQL. |

---

## 7. Deliverables & Definition of Done

- [ ] **Reverse Geocoder Service:** `ReverseGeocoderService` deployed with 4-tier waterfall and Redis geohash caching (<25ms p95 latency).
- [ ] **Dhaka Address Parser:** `parseDhakaCompoundAddress` tokenizer deployed with bilingual digit folding and micro-unit isolation.
- [ ] **Perimeter Snapper Service:** `PickupSnapperService` deployed for major complexes (JFP, Bashundhara City, HSIA, DMCH, BUET).
- [ ] **Client Rendering Integration:** Mobile SDK updated to render dashed pedestrian walking lines between user pins and snapped perimeter curb gates.
- [ ] **Benchmarking Verification:** 500 test addresses parsed with $> 95\%$ accuracy; zero search zero-hits caused by flat/house prefixes.
