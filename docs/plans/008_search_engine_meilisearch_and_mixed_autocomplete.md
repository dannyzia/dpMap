# Stage 008: Search Engine (MeiliSearch) & Mixed Autocomplete Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-008 (Revision 2.0 — Search Engine (MeiliSearch) & Mixed Autocomplete)  
**Stage:** 8 of 16 (Autocomplete Service & Search Orchestration)  
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§2, §5.4, §13.2, §14.4, §17.2)  
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)  
**Current Status:** **NotDone**  

---

## 1. Executive Summary & Objective

In on-demand ride-hailing, search autocomplete is the primary user interaction funnel. A passenger typing on a smartphone while walking or riding in a vibrating rickshaw makes frequent typographical errors, inputs phonetic Banglish, and expects relevant suggestions within 3–4 keystrokes. If search latency exceeds **50ms**, the mobile interface stutters, leading to user drop-off and booking abandonment.

Furthermore, if the platform relies exclusively on commercial vendor autocomplete during pre-launch and Phase 1, rider destination selections will perpetually mirror the vendor’s proprietary catalog. This creates a severe **exposure bias** (Concept Paper §5.4) that deprives local first-party landmarks of trip votes and keeps the platform permanently dependent on commercial APIs.

Stage 008 delivers an autonomous, high-throughput search infrastructure:
1. **The MeiliSearch In-Memory Cluster:** Delivers sub-10ms prefix and typographic search across both proprietary landmarks and OpenStreetMap baseline POIs, featuring native `_geo` spatial proximity ranking.
2. **Consolidated Search View Ingestion (`dpmaps.v_search_feed`):** Synchronizes ~52,000 initial documents (2,000+ clean-room landmarks from `public_pois` + 49,881 baseline POIs from `osm_pois`) with sub-second incremental updates and instant takedown deletion.
3. **Clean-Room Vendor Client Integration:** Decouples vendor autocomplete from raw SDKs. Vendor suggestions are fetched strictly via `vendorClientWrapper.fetchSafeVendorSuggestions` (Stage 002), enforcing the response-only invariant (zero database persistence, zero telemetry logging).
4. **Integration with Stage 007 Normalizer:** Applies 6-stage orthographic normalization, numeral folding (`০-৯` $\rightarrow$ `0-9`), and digit locking before querying search indexes.
5. **The Mixed Autocomplete Orchestrator:** Breaks vendor exposure bias from Day 1 by interleaving verified dpMaps landmarks at the top of search dropdowns with distinct `"Ride Verified"` UI badging.
6. **Search Telemetry & Failure Gap Runbooks:** Captures clean evaluation telemetry in `dpmaps.search_eval_events` (Tier B, 30-day retention) and establishes fallbacks for residential holding numbers, long-tail venues, and categorical radius searches.

> [!CAUTION]
> ### MANDATORY LEGAL GATE PREREQUISITE
> In accordance with Stage 002 Rev 2.2 and `000_TOC.md`, `system_config.search_provider_mode` is locked to `0: off`. Transitioning to `1: shadow` (Mixed Autocomplete) or `2: primary` is strictly prohibited until **Stage 002 Legal Matrix Items 3, 7, 14, 15, 16, and 17** (specifically Item 3: Keystroke Telemetry Consent, and Item 7: Vendor Contract Compliance) are formally signed off in writing by external legal counsel.

---

## 2. MeiliSearch Cluster Sizing & Index Configuration

MeiliSearch provides an in-memory, C++ / Rust search engine optimized for interactive typeahead search:

| Metric / Resource | Staging & Phase 1 Tier (500–2,000 rides/day) | Scale Production Tier (10,000–25,000 rides/day) |
|---|---|---|
| **Host Instance** | 1× Cloud VPS (2 vCPU / 4 GB RAM) | 2× Cloud VPS High-Availability (4 vCPU / 8 GB RAM) |
| **Peak Search QPS** | 5 – 15 QPS | 50 – 150 QPS |
| **Index Footprint** | ~52,000 POIs (~85 MB RAM in-memory) | 500,000+ POIs & Aliases (~600 MB RAM in-memory) |
| **Storage Allocation**| 40 GB NVMe SSD | 100 GB NVMe SSD |
| **Query Latency SLA** | **Sub-10ms in-memory (p95 < 15ms)** | **Sub-8ms in-memory (p95 < 12ms)** |

### 2.1 Index Configuration (`dpmaps_places`)
```json
{
  "searchableAttributes": [
    "canonical_name",
    "bangla_name",
    "search_aliases",
    "category",
    "point_type"
  ],
  "filterableAttributes": [
    "_geo",
    "category",
    "point_type",
    "h3_res9",
    "is_first_party",
    "license_type"
  ],
  "sortableAttributes": [
    "_geo",
    "confidence_score"
  ],
  "rankingRules": [
    "words",
    "typo",
    "proximity",
    "attribute",
    "sort",
    "exactness"
  ],
  "typoTolerance": {
    "enabled": true,
    "minWordSizeForTypos": {
      "oneTypo": 4,
      "twoTypos": 8
    },
    "disableOnWords": [
      "rd", "road", "sec", "sector", "blk", "block", 
      "gali", "lane", "mor", "gate", "bridge", "bazaar"
    ],
    "disableOnNumbers": true
  },
  "pagination": {
    "maxTotalHits": 20
  }
}
```

> [!IMPORTANT]
> **Digit Preservation Invariant:** Notice that `"disableOnNumbers": true` is enforced in the typo tolerance configuration. In accordance with Stage 007's Hard Digit Locking Rule, numbers in search queries (e.g., *"Road 4"* vs. *"Road 7"*) must never be fuzzy-matched.

---

## 3. PostGIS Search View Synchronization Pipeline

MeiliSearch indexes the unified database view `dpmaps.v_search_feed` (Stage 003 §7), which cleanly separates proprietary landmarks from open-source baseline data:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        SEARCH VIEW SYNCHRONIZATION ARCHITECTURE                        │
├──────────────────────────────┬─────────────────────────────────────────────────────────┤
│ PostgreSQL Source View       │ MeiliSearch Document Mapping                            │
├──────────────────────────────┼─────────────────────────────────────────────────────────┤
│ `dpmaps.v_search_feed`       │ `dpmaps_places` Index                                   │
│ • document_id                │ `id`: "pub_8f92b..." or "osm_1092819_M"                 │
│ • display_name               │ `canonical_name`: "Jamuna Future Park"                  │
│ • bangla_name                │ `bangla_name`: "যমুনা ফিউচার পার্ক"                     │
│ • category                   │ `category`: "shopping_mall"                             │
│ • point_type                 │ `point_type`: "building_entrance"                       │
│ • h3_res9, h3_res10          │ `h3_res9`: "896541...", `h3_res10`: "8a6541..."         │
│ • lat, lng                   │ `_geo`: { "lat": 23.8134, "lng": 90.4242 }             │
│ • search_aliases             │ `search_aliases`: ["JFP", "Jamuna Mall", "Ka-244"]      │
│ • confidence_score           │ `confidence_score`: 0.9850                              │
│ • is_first_party             │ `is_first_party`: true                                  │
│ • license_type               │ `license_type`: "first_party_proprietary"               │
└──────────────────────────────┴─────────────────────────────────────────────────────────┘
```

### 3.1 Synchronization Worker (`workers/meiliSyncWorker.ts`)
```typescript
// workers/meiliSyncWorker.ts
import { MeiliSearch } from 'meilisearch';
import { db } from '../lib/db';
import { logger } from '../utils-server/logger';

const meili = new MeiliSearch({
  host: process.env.MEILI_HOST || 'http://localhost:7700',
  apiKey: process.env.MEILI_MASTER_KEY
});

export async function runFullMeiliSync(): Promise<void> {
  const index = meili.index('dpmaps_places');
  logger.info('[meiliSyncWorker] Starting full sync from dpmaps.v_search_feed...');

  const query = `
    SELECT 
      document_id AS id,
      display_name AS canonical_name,
      bangla_name,
      category,
      point_type,
      h3_res9,
      h3_res10,
      json_build_object('lat', lat, 'lng', lng) AS _geo,
      search_aliases,
      confidence_score,
      is_first_party,
      license_type
    FROM dpmaps.v_search_feed;
  `;

  const { rows } = await db.query(query);
  logger.info({ totalRows: rows.length }, '[meiliSyncWorker] Fetched feed rows; uploading in batches of 5000...');

  const BATCH_SIZE = 5000;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const task = await index.addDocuments(batch);
    logger.info({ batchIndex: i / BATCH_SIZE, taskId: task.taskUid }, '[meiliSyncWorker] Enqueued batch upload');
  }

  logger.info('[meiliSyncWorker] Full sync completed successfully.');
}

/**
 * Instant Takedown Purge Handler:
 * Executes within seconds of judicial or privacy suppression.
 */
export async function purgeSuppressedPoiFromSearch(poiId: string): Promise<void> {
  const index = meili.index('dpmaps_places');
  const documentId = `pub_${poiId}`;
  await index.deleteDocument(documentId);
  logger.info({ documentId }, '[meiliSyncWorker] Purged suppressed POI from MeiliSearch index');
}
```

---

## 4. The Mixed Autocomplete Orchestrator

To break vendor exposure bias from Day 1, the backend client orchestrator queries both local MeiliSearch and external commercial vendors in parallel, applying strict result fusion and badging:

```
                           [ Rider Types in Search Input ]
                                         │
                                         ▼
                     [ 1. Stage 007 Normalizer Pre-Processing ]
                     • Unicode NFC & invisible glyph stripping
                     • Bengali digit folding: [০-৯] -> [0-9]
                     • Dhaka abbreviation expansion: "jfp" -> "jamuna future park"
                                         │
                                         ▼
                     [ utils-server/searchOrchestrator.ts ]
                                         │
                   ┌─────────────────────┴─────────────────────┐
                   ▼                                           ▼
         [ 2. Local MeiliSearch ]                    [ 3. Vendor Client Wrapper ]
         • Port 7700 (in-memory)                     • fetchSafeVendorSuggestions()
         • Sub-10ms query latency                    • 120–250ms external network
         • _geoRadius(user, 35km)                    • Emits SafeVendorSuggestion[]
         • _geoPoint proximity sort                  • Ephemeral temp_client_id
                   │                                           │
                   └─────────────────────┬─────────────────────┘
                                         │
                                         ▼
                         [ 4. Result Fusion & Badging ]
                         ├── Slot 1-2: High-confidence dpMaps verified POIs
                         │   (Badged with "Ride Verified" green tag)
                         ├── Slot 3-6: Safe vendor suggestions
                         │   (Display text response-only; temp_client_id)
                         └── Deduplication: Suppress vendor entry if
                             spatial overlap < 30m with first-party POI
                                         │
                                         ▼
                       [ Return to Mobile Dropdown (<40ms total) ]
```

### 4.1 Orchestrator Implementation (`utils-server/searchOrchestrator.ts`)
```typescript
// utils-server/searchOrchestrator.ts
import { MeiliSearch } from 'meilisearch';
import { getPlatformConfig } from '../lib/platformConfig';
import { normalizeSearchQuery } from './textNormalizer';
import { 
  fetchSafeVendorSuggestions, 
  SafeVendorSuggestion 
} from './vendorClientWrapper';
import { db } from '../lib/db';
import { logger } from './logger';

const meili = new MeiliSearch({
  host: process.env.MEILI_HOST || 'http://localhost:7700',
  apiKey: process.env.MEILI_MASTER_KEY
});

export interface AutocompleteItem {
  id: string;
  title: string;
  subtitle: string;
  category: string;
  source: 'dpmaps_local' | 'vendor';
  is_verified_first_party: boolean;
  temp_client_id?: string;               // Present ONLY for vendor suggestions
  coords?: { lat: number; lng: number }; // Present ONLY for dpmaps_local
}

export async function getMixedAutocomplete(
  rawQuery: string,
  userLat?: number,
  userLng?: number
): Promise<AutocompleteItem[]> {
  const startTime = Date.now();
  const mode = (await getPlatformConfig('search_provider_mode')) ?? 'off';

  // 1. Pre-process query via Stage 007 Normalizer
  const normalized = normalizeSearchQuery(rawQuery);
  const searchString = normalized.normalized_query;

  if (searchString.length < 2) return [];

  // 2. Mode 3: Sole Sovereign Operation (Zero external vendor calls)
  if (mode === 'sole') {
    const localHits = await queryMeili(searchString, userLat, userLng);
    logSearchTelemetry(rawQuery, 'dpmaps', Date.now() - startTime, localHits.length);
    return localHits.map(formatLocalHit);
  }

  // 3. Mode 2: Primary Operation (Local first; vendor fallback only on sparse results)
  if (mode === 'primary') {
    const localHits = await queryMeili(searchString, userLat, userLng);
    if (localHits.length >= 4) {
      logSearchTelemetry(rawQuery, 'dpmaps', Date.now() - startTime, localHits.length);
      return localHits.map(formatLocalHit);
    }

    // Sparse hits (<4): supplement with vendor suggestions
    const vendorSuggestions = await fetchSafeVendorSuggestions(rawQuery, userLat && userLng ? { lat: userLat, lng: userLng } : undefined);
    const combined = [
      ...localHits.map(formatLocalHit),
      ...vendorSuggestions.map(formatVendorSuggestion)
    ];
    logSearchTelemetry(rawQuery, 'dpmaps_primary_mixed', Date.now() - startTime, combined.length);
    return combined.slice(0, 6);
  }

  // 4. Mode 1: Shadow & Mixed Operation (Parallel query, exposure-breaking fusion)
  if (mode === 'shadow') {
    const [localHits, vendorSuggestions] = await Promise.all([
      queryMeili(searchString, userLat, userLng).catch(() => []),
      fetchSafeVendorSuggestions(rawQuery, userLat && userLng ? { lat: userLat, lng: userLng } : undefined).catch(() => [])
    ]);

    // Exposure-breaking fusion:
    // Filter local hits with confidence >= 0.85
    const verifiedLocal = localHits
      .filter(h => h.is_first_party && h.confidence_score >= 0.85)
      .map(formatLocalHit);

    const standardLocal = localHits
      .filter(h => !h.is_first_party || h.confidence_score < 0.85)
      .map(formatLocalHit);

    const vendorItems = vendorSuggestions.map(formatVendorSuggestion);

    // Pin up to 2 verified first-party items at the top
    const results: AutocompleteItem[] = [];
    results.push(...verifiedLocal.slice(0, 2));

    // Interleave remaining local and vendor suggestions
    for (let i = 0; i < Math.max(standardLocal.length, vendorItems.length); i++) {
      if (vendorItems[i]) results.push(vendorItems[i]);
      if (standardLocal[i]) results.push(standardLocal[i]);
      if (results.length >= 6) break;
    }

    logSearchTelemetry(rawQuery, 'shadow_mixed', Date.now() - startTime, results.length);
    return results.slice(0, 6);
  }

  // 5. Mode 0: Off (100% Vendor suggestions)
  const vendorSuggestions = await fetchSafeVendorSuggestions(rawQuery, userLat && userLng ? { lat: userLat, lng: userLng } : undefined);
  logSearchTelemetry(rawQuery, 'vendor', Date.now() - startTime, vendorSuggestions.length);
  return vendorSuggestions.map(formatVendorSuggestion).slice(0, 6);
}

async function queryMeili(searchString: string, userLat?: number, userLng?: number) {
  const index = meili.index('dpmaps_places');
  const searchParams: any = { limit: 6 };

  if (userLat && userLng) {
    searchParams.filter = `_geoRadius(${userLat}, ${userLng}, 35000)`; // 35 km metro radius
    searchParams.sort = [`_geoPoint(${userLat}, ${userLng}):asc`, 'confidence_score:desc'];
  } else {
    searchParams.sort = ['confidence_score:desc'];
  }

  const response = await index.search(searchString, searchParams);
  return response.hits;
}

function formatLocalHit(hit: any): AutocompleteItem {
  return {
    id: hit.id,
    title: hit.canonical_name,
    subtitle: hit.bangla_name || hit.category,
    category: hit.category,
    source: 'dpmaps_local',
    is_verified_first_party: hit.is_first_party === true,
    coords: hit._geo ? { lat: hit._geo.lat, lng: hit._geo.lng } : undefined
  };
}

function formatVendorSuggestion(suggestion: SafeVendorSuggestion): AutocompleteItem {
  return {
    id: `vendor_${suggestion.temp_client_id}`,
    title: suggestion.display_name,
    subtitle: suggestion.secondary_text,
    category: suggestion.category,
    source: 'vendor',
    is_verified_first_party: false,
    temp_client_id: suggestion.temp_client_id
  };
}

/**
 * Logs search evaluation telemetry strictly to Tier B table.
 * Notice: Zero vendor display text or coordinates are persisted.
 */
async function logSearchTelemetry(
  typedQuery: string, 
  source: string, 
  latencyMs: number, 
  resultCount: number
): Promise<void> {
  // Capped at 80 characters per Stage 002
  const sanitizedQuery = typedQuery.substring(0, 80);

  await db.query(
    `INSERT INTO dpmaps.search_eval_events 
      (typed_query, selected_source, latency_ms, result_count)
     VALUES ($1, $2, $3, $4)`,
    [sanitizedQuery, source, latencyMs, resultCount]
  ).catch(err => logger.error({ err }, '[searchOrchestrator] Failed to log search telemetry'));
}
```

---

## 5. Search Failure Gap Mitigations (Sole Mode Runbook)

When operating in Mode 3 (Sole Sovereign), certain query types may yield zero direct matches on the local gazetteer. The search orchestrator implements automated fallbacks:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        SEARCH FAILURE GAP MITIGATION MATRIX                            │
├─────────────────────┬────────────────────────────────────┬─────────────────────────────┤
│ Query Category      │ Failure Mechanism                  │ dpMaps Automated Fallback   │
├─────────────────────┼────────────────────────────────────┼─────────────────────────────┤
│ 1. Exact Holding    │ OSM lacks building-level holding   │ Parse street & road tokens; │
│    Numbers          │ numbers in residential lanes       │ match to road centerline +  │
│    (*"House 14/A,   │ (e.g. Dhanmondi, Banani, Uttara).  │ nearest gate/mor; prompt:   │
│     Road 5"*)       │                                    │ *"Drag pin to exact gate"*. │
├─────────────────────┼────────────────────────────────────┼─────────────────────────────┤
│ 2. Deep Long-Tail   │ Informal tea stalls, niche local   │ Fall back to neighborhood / │
│    Venues           │ shops unmapped in base OpenStreet- │ ward centroid (ADM3/ADM4    │
│    (*"Mama Tea"*)   │ Map without 15-rider vote support. │ boundary) + prompt user.    │
├─────────────────────┼────────────────────────────────────┼─────────────────────────────┤
│ 3. Newly Opened     │ Venues opened <30 days ago absent  │ Onboard directly via Ride   │
│    Businesses       │ from baseline and survey batches.  │ Merchant Portal under       │
│                     │                                    │ clean-room warranty.        │
├─────────────────────┼────────────────────────────────────┼─────────────────────────────┤
│ 4. Categorical      │ Rider searches "hospital near me", │ Execute spatial PostGIS     │
│    Proximity        │ "pharmacy", or "ATM".              │ ST_DWithin query filtered   │
│                     │                                    │ by category in rider H3 r8. │
├─────────────────────┼────────────────────────────────────┼─────────────────────────────┤
│ 5. Inter-District   │ Traveler searches inter-district   │ Match against national      │
│    Destinations     │ destinations (Sylhet, Chittagong,  │ ADM1/ADM2/ADM3 polygons in  │
│                     │ Cox's Bazar) from Dhaka handset.   │ dpmaps.admin_boundaries.    │
└─────────────────────┴────────────────────────────────────┴─────────────────────────────┘
```

---

## 6. Deliverables & Definition of Done

- [ ] MeiliSearch cluster provisioned and running on 4 vCPU / 8 GB RAM VPS with `dpmaps_places` index configured.
- [ ] Index settings verified: `_geo` sortable/filterable attributes, ranking rules, and `"disableOnNumbers": true` active.
- [ ] Ingestion script `workers/meiliSyncWorker.ts` operational; populates ~52,000 initial records from `dpmaps.v_search_feed` in $< 15\text{ seconds}$.
- [ ] Instant takedown purge handler verified: executing `purgeSuppressedPoiFromSearch` expunges documents from MeiliSearch in $< 1\text{ second}$.
- [ ] Clean-room vendor wrapper integration verified: `fetchSafeVendorSuggestions` called exclusively; zero vendor SDK imports outside `vendorClientWrapper.ts`.
- [ ] Response-only invariant enforced: vendor suggestion display text returned exclusively in client HTTP response; zero vendor strings written to logs or databases.
- [ ] Stage 007 text normalizer integrated: queries pre-processed with Unicode NFC, ZWJ/ZWNJ stripping, and Bengali numeral folding (`০-৯` $\rightarrow$ `0-9`).
- [ ] Mixed autocomplete orchestrator (`searchOrchestrator.ts`) deployed supporting all 4 modes (`off`, `shadow`, `primary`, `sole`).
- [ ] Exposure-breaking fusion verified on mobile clients: dpMaps verified landmarks appear in top slots with distinct `"Ride Verified"` green badge.
- [ ] Search telemetry active: queries recorded in `dpmaps.search_eval_events` (Tier B, 30-day retention).
- [ ] Query latency benchmark demonstrates sub-15ms p95 response time under 100 concurrent search queries.
- [ ] **Stage 002 Legal Gate Enforced:** `search_provider_mode` verified to remain locked at `0: off` until written legal counsel clearance on Items 3, 7, 14, 15, 16, and 17.
