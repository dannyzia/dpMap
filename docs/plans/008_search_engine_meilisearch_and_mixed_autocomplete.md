# Stage 008: Search Engine (MeiliSearch) & Mixed Autocomplete Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-008 (Revision 2.1 — Dual-Index MeiliSearch, Zero-Hit Vendor Fallback & Session Handoff)
**Stage:** 8 of 16 (Autocomplete Service & Search Orchestration)
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§2, §5.4, §13.2, §14.4, §17.2)
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)
**Current Status:** **NotDone**

---

## 1. Executive Summary & Objective

In on-demand ride-hailing, search autocomplete is the primary user interaction funnel. A passenger typing on a smartphone while walking or riding in a vibrating rickshaw makes frequent typographical errors, inputs phonetic Banglish, and expects relevant suggestions within 3–4 keystrokes. If search latency exceeds **50 ms `[ESTIMATE]`**, the mobile interface stutters, leading to user drop-off.

If the platform relies exclusively on commercial vendor autocomplete during pre-launch and Phase 1, rider destination selections will perpetually mirror the vendor's proprietary catalog — a severe **exposure bias** (concept paper §5.4) that deprives first-party landmarks of trip votes.

Stage 008 delivers an autonomous search infrastructure:
1. **Physically Isolated Dual Indexes:** `first_party_pois` (proprietary clean-room landmarks) and `osm_pois` (ODbL open data) are **two completely separate MeiliSearch indexes on disk**. They are merged **only at query time in RAM** by the search API — never physically combined or co-indexed (Hard Rule 1, Architectural Invariant 4).
2. **Mixed Autocomplete from Launch:** the client receives a unified, deduplicated suggestion list with provenance badges — `Verified Landmark` (first-party) and `Open Directory` (OSM) — from the first day of Phase 1.
3. **Zero-Hit Vendor Fallback:** in `primary` mode, vendor search is called **strictly when local search returns zero results**. One valid local result ⇒ zero vendor calls.
4. **Atomic Session Handoff:** a tapped vendor suggestion hands its coordinates to dispatch via Redis `dest_session:<session_token>` (TTL 15 min, atomic `GETDEL`); vendor coordinates never persist in Ride mapping tables.
5. **Clean-Room Vendor Integration:** vendor suggestions flow exclusively through `vendorClientWrapper.fetchSafeVendorSuggestions` (Stage 002) — response-only, zero persistence, zero telemetry logging of vendor strings.
6. **Popularity & Bilingual Ranking:** query-cluster popularity and decayed historical vote weights (aggregated only — **never raw keystrokes**) feed ranking; Bangla-script and transliterated prefixes both resolve.

> [!CAUTION]
> ### MANDATORY LEGAL GATE PREREQUISITE
> In accordance with Stage 002 Rev 2.2 and `000_TOC.md`, `system_config.search_provider_mode` is locked to `0: off`. Transitioning to `1: shadow` (Mixed Autocomplete) or `2: primary` is strictly prohibited until **Stage 002 Legal Matrix Items 3, 7, 14, 15, 16, and 17** (specifically Item 3: Keystroke Telemetry Consent, and Item 7: Vendor Contract Compliance) are formally signed off in writing by external legal counsel.

---

## 2. Cluster Sizing & Dual-Index Configuration

| Metric / Resource | Staging & Phase 1 Tier (500–2,000 rides/day) | Scale Production Tier (10,000–25,000 rides/day) |
|---|---|---|
| **Host Instance** | 1× Cloud VPS (2 vCPU / 4 GB RAM) `[ESTIMATE]` | 2× Cloud VPS HA (4 vCPU / 8 GB RAM) `[ESTIMATE]` |
| **Peak Search QPS** | 5 – 15 QPS `[ESTIMATE]` | 50 – 150 QPS `[ESTIMATE]` |
| **Index Footprint** | ~52,500 POIs total `[ESTIMATE: 2,000+ first-party + 50,545 OSM per Stage 001]` | 500,000+ docs & aliases `[ESTIMATE]` |
| **Storage Allocation**| 40 GB NVMe SSD | 100 GB NVMe SSD |
| **Query Latency SLA** | p95 < 15 ms `[ESTIMATE — measure]` | p95 < 12 ms `[ESTIMATE — measure]` |

### 2.1 The Physical Isolation Invariant (F-008-1)

> [!IMPORTANT]
> **Two indexes, two disks, one RAM merge.**
> - `first_party_pois` — proprietary `dpmaps.public_pois` + `dpmaps.poi_aliases` documents (`id: "pub_<uuid>"`). License: first-party proprietary.
> - `osm_pois` — ODbL `dpmaps.osm_pois` documents (`id: "osm_<osm_type>:<osm_id>"`, e.g. `osm_M:1024`). License: ODbL attribution required.
> - The two indexes live in separate MeiliSearch data directories. No document from one index may ever be written to the other; no union index may exist in any environment. Measured merge happens **only in the search API process, in memory, per request** (§4).
> - Suppression (Stage 011) purges each index independently.

### 2.2 Index Settings (identical schema for both indexes)

```json
{
  "searchableAttributes": [
    "canonical_name",
    "bangla_name",
    "search_aliases",
    "bengali_phonetic_keys",
    "category",
    "point_type"
  ],
  "filterableAttributes": [
    "_geo",
    "category",
    "point_type",
    "h3_res9",
    "lifecycle_status"
  ],
  "sortableAttributes": [
    "_geo",
    "confidence_score",
    "popularity"
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
    "minWordSizeForTypos": { "oneTypo": 4, "twoTypos": 8 },
    "disableOnWords": [
      "rd", "road", "sec", "sector", "blk", "block",
      "gali", "lane", "mor", "gate", "bridge", "bazaar"
    ],
    "disableOnNumbers": true
  },
  "pagination": { "maxTotalHits": 20 }
}
```

> [!IMPORTANT]
> **Digit Preservation Invariant:** `"disableOnNumbers": true` enforces Stage 007 Hard Digit Locking — *"Road 4"* vs *"Road 7"* is never fuzzy-matched. MeiliSearch typo behavior on Bengali script is `[UNVERIFIED — verify in staging before launch]`.

---

## 3. Dual-Source Synchronization Pipeline

Each index is fed by its own PostGIS source view (additive views defined in the Stage 003 Rev 2.4 brief, Part F of the batch-2 audit plan):

```
┌──────────────────────────────────┬───────────────────────────────────────────┐
│ PostgreSQL Source View           │ MeiliSearch Document Mapping              │
├──────────────────────────────────┼───────────────────────────────────────────┤
│ dpmaps.v_search_feed_first_party │ INDEX first_party_pois                    │
│  (public_pois + poi_aliases)     │  id: "pub_<uuid>"                         │
│                                  │  license_type: "first_party_proprietary"  │
├──────────────────────────────────┼───────────────────────────────────────────┤
│ dpmaps.v_search_feed_osm         │ INDEX osm_pois                            │
│  (dpmaps.osm_pois, ODbL)         │  id: "osm_<osm_type>:<osm_id>"            │
│                                  │  license_type: "osm_odbl_attributed"      │
└──────────────────────────────────┴───────────────────────────────────────────┘
  Document fields (both): canonical_name, bangla_name, search_aliases,
  bengali_phonetic_keys, category, point_type, h3_res9, h3_res10,
  _geo {lat,lng}, confidence_score, popularity, lifecycle_status
```

### 3.1 Synchronization Workers (`workers/meiliSyncWorker.ts`)

```typescript
// workers/meiliSyncWorker.ts — writes ONE index per worker call; no cross-writes.
import { MeiliSearch } from 'meilisearch';
import { db } from '../lib/db';
import { logger } from '../utils-server/logger';

const meili = new MeiliSearch({
  host: process.env.MEILI_HOST || 'http://localhost:7700',
  apiKey: process.env.MEILI_MASTER_KEY
});

type FeedSpec = {
  indexName: 'first_party_pois' | 'osm_pois'; // F-008-1: physical isolation
  sourceView: 'dpmaps.v_search_feed_first_party' | 'dpmaps.v_search_feed_osm';
};

const FEEDS: FeedSpec[] = [
  { indexName: 'first_party_pois', sourceView: 'dpmaps.v_search_feed_first_party' },
  { indexName: 'osm_pois', sourceView: 'dpmaps.v_search_feed_osm' }
];

export async function runFullMeiliSync(): Promise<void> {
  for (const feed of FEEDS) {
    const index = meili.index(feed.indexName);
    const { rows } = await db.query(`SELECT * FROM ${feed.sourceView}`);
    logger.info({ index: feed.indexName, totalRows: rows.length }, '[meiliSync] upserting');
    const BATCH_SIZE = 5000; // [ESTIMATE]
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const task = await index.addDocuments(rows.slice(i, i + BATCH_SIZE));
      logger.info({ batch: i / BATCH_SIZE, taskId: task.taskUid }, '[meiliSync] enqueued');
    }
  }
}

/**
 * Instant Takedown Purge (Stage 011 integration): evicts from BOTH indexes by ID prefix.
 * "pub_*" -> first_party_pois; "osm_*" -> osm_pois. Seconds-level, bypasses monthly releases.
 */
export async function purgeSuppressedFromSearch(documentId: string): Promise<void> {
  const target = documentId.startsWith('pub_') ? 'first_party_pois'
    : documentId.startsWith('osm_') ? 'osm_pois' : null;
  if (!target) return;
  await meili.index(target).deleteDocument(documentId);
  logger.info({ documentId, target }, '[meiliSync] purged suppressed document');
}
```

---

## 4. The Mixed Autocomplete Orchestrator (query-time RAM merge)

```
              [ Rider Types in Search Input ]
                            │
                            ▼
            [ 1. Stage 007 Normalizer Pre-Processing ]
            • Unicode NFC, invisible glyph stripping
            • Bengali digit folding [০-৯] -> [0-9]; digit locking preserved
            • Abbreviation & transliteration expansion (Stage 007)
                            │
                            ▼
            [ utils-server/searchOrchestrator.ts ]
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
 [ first_party_pois ]  [ osm_pois ]   [ Vendor Wrapper (mode-dependent) ]
  (Meili, port 7700)   (Meili)        fetchSafeVendorSuggestions()
        │                   │                   │
        └───────────────────┴───────────────────┘
                            │
                            ▼
            [ 4. RAM Merge, Dedupe & Badging ]   ◄── the ONLY merge point
            • Precedence: first_party > osm > vendor
            • Cross-source dedupe: keep the higher-precedence hit when
              a competitor lies within 30 m [ESTIMATE radius]
            • Badges: "Verified Landmark" (first_party),
                      "Open Directory" (osm), vendor rows unbaged/display-only
            • Sort: popularity + _geo proximity + confidence
                            │
                            ▼
          [ Return unified list to mobile dropdown (< 40 ms total) [ESTIMATE] ]
```

**Mode semantics:**
- `0: off` — vendor only (legal lock / maintenance). No local indexes queried; Tier A rows only on rider selection, impressions metrics-only.
- `1: shadow` (launch default) — parallel local + vendor; fused mixed list **from launch** (F-008-2).
- `2: primary` — local first; **vendor called strictly on zero local results** (F-008-3). If local returns ≥ 1 valid hit, zero vendor calls.
- `3: sole` — local only; zero external calls.

### 4.1 Orchestrator Implementation (`utils-server/searchOrchestrator.ts`)

```typescript
// utils-server/searchOrchestrator.ts
import { MeiliSearch } from 'meilisearch';
import { getPlatformConfig } from '../lib/platformConfig';
import { normalizeSearchQuery, scrubPii } from './textNormalizer';
import { fetchSafeVendorSuggestions, SafeVendorSuggestion } from './vendorClientWrapper';
import { recordDestinationSession } from './destinationSession'; // §5
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
  source: 'first_party' | 'osm' | 'vendor';
  badge: 'verified_landmark' | 'open_directory' | null;
  session_token?: string;              // vendor suggestions only (F-008-4; renamed from temp_client_id)
  coords?: { lat: number; lng: number }; // local hits only
  _fusePos?: { lat: number; lng: number }; // ephemeral vendor fusion hint; stripped before HTTP response
}

export async function getMixedAutocomplete(
  rawQuery: string, userLat?: number, userLng?: number
): Promise<AutocompleteItem[]> {
  const started = Date.now();
  const mode = (await getPlatformConfig('search_provider_mode')) ?? 'off';
  const normalized = normalizeSearchQuery(rawQuery);
  const q = normalized.normalized_query;
  if (q.length < 2) return [];

  const local = async () => mergeLocalIndexes(q, userLat, userLng); // RAM merge of 2 indexes
  const vendor = async () =>
    fetchSafeVendorSuggestions(rawQuery,
      userLat !== undefined && userLng !== undefined ? { lat: userLat, lng: userLng } : undefined);

  let items: AutocompleteItem[];

  if (mode === 'sole') {
    items = await local();
  } else if (mode === 'primary') {
    const hits = await local();
    // F-008-3: vendor strictly on ZERO local results
    if (hits.length > 0) {
      items = hits;
    } else {
      items = (await vendor()).map(formatVendorSuggestion);
    }
  } else if (mode === 'shadow') {
    const [hits, vend] = await Promise.all([
      local().catch(() => [] as AutocompleteItem[]),
      vendor().catch(() => [] as SafeVendorSuggestion[])
    ]);
    items = fuse(hits, vend.map(formatVendorSuggestion)); // unified dedupe + badges
  } else {
    items = (await vendor()).map(formatVendorSuggestion);
  }

  // Refinement (F-008-6): raw_search_events is written at SELECTION time (the rider tap) —
  // its columns record the actual selection. Unselected impressions feed only Prometheus
  // counters (dpmaps_search_impressions_total / latency histogram in metrics.ts); no guessed
  // selected_source is ever persisted. Evaluation rows (search_success etc.) are written
  // post-trip by the Stage 015 evaluator into dpmaps.search_eval_events — never here.
  return items.slice(0, 6).map(stripEphemeral);
}

/** Rider tap → Tier A selection row (Stage 003 §4.7 raw_search_events). */
export async function recordSearchSelection(
  userId: string,
  rawQuery: string,
  item: AutocompleteItem,
  latencyMs: number
): Promise<void> {
  const selectedSource = item.source === 'vendor' ? 'vendor'
    : item.source === 'osm' ? 'osm' : 'dpmaps';
  await db.query(
    `INSERT INTO dpmaps.raw_search_events (user_id, typed_query, selected_source, selected_place_id, latency_ms)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, scrubPii(rawQuery).substring(0, 80), selectedSource,
     selectedSource === 'vendor' ? null : item.id, latencyMs] // chk_raw_vendor_place_null
  ).catch(err => logger.error({ err }, '[searchOrchestrator] selection log failed'));
}

/** Query-time RAM merge of the two physical indexes (F-008-1). */
async function mergeLocalIndexes(q: string, userLat?: number, userLng?: number): Promise<AutocompleteItem[]> {
  const params: Record<string, unknown> = { limit: 10 };
  if (userLat !== undefined && userLng !== undefined) {
    params.filter = `_geoRadius(${userLat}, ${userLng}, 35000)`; // [ESTIMATE] 35 km metro
    params.sort = [`_geoPoint(${userLat}, ${userLng}):asc`, 'popularity:desc', 'confidence_score:desc'];
  } else {
    params.sort = ['popularity:desc', 'confidence_score:desc'];
  }
  const [fp, osm] = await Promise.all([
    meili.index('first_party_pois').search(q, params).then(r => r.hits),
    meili.index('osm_pois').search(q, params).then(r => r.hits)
  ]);
  return fuse([
    ...fp.map(h => formatLocalHit(h, 'first_party')),
    ...osm.map(h => formatLocalHit(h, 'osm'))
  ], []);
}

/** Precedence first_party > osm > vendor; 30 m cross-source dedupe (F-008-2).
 *  Refinement: vendor rows carry an EPHEMERAL in-memory fusion position (`approx_coords`
 *  from the wrapper) used only here — never persisted, logged, or returned to the client
 *  (stripped by `stripEphemeral`). Without it, a vendor row previously could never be
 *  deduped against local hits. Fallback when absent: normalized-title equality. */
function fuse(local: AutocompleteItem[], vendorItems: AutocompleteItem[]): AutocompleteItem[] {
  const rank = (i: AutocompleteItem) => i.source === 'first_party' ? 0 : i.source === 'osm' ? 1 : 2;
  const pos = (i: AutocompleteItem): { lat: number; lng: number } | undefined =>
    i.coords ?? i._fusePos;
  const ordered = [...local, ...vendorItems].sort((a, b) => rank(a) - rank(b));
  const kept: AutocompleteItem[] = [];
  for (const item of ordered) {
    const p2 = pos(item);
    const dup = kept.some(k => {
      const p1 = pos(k);
      if (p1 && p2) return haversineMeters(p1, p2) < 30; // [ESTIMATE]
      return k.title.trim().toLowerCase() === item.title.trim().toLowerCase();
    });
    if (!dup) kept.push(item);
  }
  return kept;
}

function formatLocalHit(hit: any, source: 'first_party' | 'osm'): AutocompleteItem {
  return {
    id: hit.id,
    title: hit.canonical_name ?? hit.bangla_name,
    subtitle: hit.bangla_name ?? hit.category,
    category: hit.category,
    source,
    badge: source === 'first_party' ? 'verified_landmark' : 'open_directory',
    coords: hit._geo ? { lat: hit._geo.lat, lng: hit._geo.lng } : undefined
  };
}

function formatVendorSuggestion(s: SafeVendorSuggestion): AutocompleteItem {
  return {
    id: `vendor_${s.session_token}`,
    title: s.display_name,        // response-only; never persisted (Stage 002)
    subtitle: s.secondary_text,
    category: s.category,
    source: 'vendor',
    badge: null,
    session_token: s.session_token, // renamed from temp_client_id (Part F X-2)
    _fusePos: s.approx_coords       // ephemeral in-memory fusion hint (refinement); stripped pre-response
  };
}

/** Strips the ephemeral fusion hint before the HTTP response (vendor positions never leave memory). */
function stripEphemeral(i: AutocompleteItem): AutocompleteItem {
  const pub = { ...i } as Record<string, unknown>;
  delete pub._fusePos;
  return pub as AutocompleteItem;
}
```

---

## 5. Destination Session Handoff Contract (F-008-4)

When a rider taps a **vendor** suggestion, dispatch later needs its coordinates. The contract:

| Element | Value |
|---|---|
| Key | `dest_session:<session_token>` (`session_token` = server-minted ephemeral UUID v4) |
| Value | `{ lat, lng }` only — vendor coordinates, never names/IDs/polylines |
| TTL | **15 minutes** (single session handoff window) |
| Read | **atomic `GETDEL`** (Redis ≥ 6.2; ioredis `getdel` / node-redis `getDel`) by Ride dispatch — single use |
| On miss/expiry | fail safe: prompt rider reselection; **no database fallback, no vendor re-query** |
| Persistence | **none** — vendor coordinates never enter `public_pois`, `osm_pois`, or any Ride core table (Hard Rule 1) |

```typescript
// utils-server/destinationSession.ts
import { redisClient } from '../lib/redis';
import { randomUUID } from 'crypto';

export async function recordDestinationSession(coords: { lat: number; lng: number }): Promise<string> {
  const sessionToken = randomUUID();
  await redisClient.set(`dest_session:${sessionToken}`, JSON.stringify(coords), 'EX', 900); // 15 min
  return sessionToken;
}

export async function consumeDestinationSession(sessionToken: string): Promise<{ lat: number; lng: number } | null> {
  const raw = await redisClient.getdel(`dest_session:${sessionToken}`); // atomic single-use
  return raw ? JSON.parse(raw) : null;
}
```

**Cross-plan note (single mechanism):** the search-side write path is authoritative: `dest_session:<session_token>`, TTL 15 min, atomic `GETDEL`. Stage 005's dispatch resolver consumes that same key; Stage 002's `vendor:resolve:<temp_client_id>` (120 s) is **superseded** and must be renamed/retired in its next audit (Part F X-2). Two Stage 002 wrapper contract changes ride along: `SafeVendorSuggestion.temp_client_id` → `session_token`, and an optional `approx_coords` field used **in memory only** for the §4 fusion dedupe (never persisted, logged, or returned to the client).

---

## 6. Query Popularity & Bilingual Ranking (F-008-5)

The `popularity` sortable attribute is computed at sync time from **aggregated first-party signals only**:

$$\text{popularity} = \ln\!\left(1 + \sum_c \text{decayed\_cluster\_weight}(c)\right) + \alpha \cdot \ln(1 + \text{selections}_{30d}) \qquad [\alpha = 0.5\ ESTIMATE]$$

- `decayed_cluster_weight` comes from `dpmaps.mv_cluster_evidence_stats.sum_weights` (Stage 003 §6.3 — read-time decay, zero write amplification) via the place's `query_clusters` association.
- `selections_{30d}` is an **aggregated count** from evaluation tables. **No raw keystroke streams** ever enter ranking (Hard Rule 8); typed text exists only in Tier A `raw_search_events` for 30 days.
- **Bilingual prefixes:** `bangla_name` and `bengali_phonetic_keys` (aggregated Stage 007 phonetic keys from `dpmaps.query_clusters.bengali_phonetic_key`) are searchable; English transliteration aliases live in `search_aliases`. A Bangla-script prefix and its Latin transliteration must return overlapping candidate sets `[UNVERIFIED — validate MeiliSearch Bengali tokenization in staging]`.

---

## 7. Search Failure Gap Mitigations (Sole Mode Runbook)

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        SEARCH FAILURE GAP MITIGATION MATRIX                            │
├─────────────────────┬────────────────────────────────────┬─────────────────────────────┤
│ Query Category      │ Failure Mechanism                  │ dpMaps Automated Fallback   │
├─────────────────────┼────────────────────────────────────┼─────────────────────────────┤
│ 1. Exact Holding    │ OSM lacks building-level holding   │ Parse street & road tokens; │
│    Numbers          │ numbers in residential lanes.      │ match road centerline +     │
│                     │                                    │ nearest gate; prompt pin.   │
├─────────────────────┼────────────────────────────────────┼─────────────────────────────┤
│ 2. Deep Long-Tail   │ Informal venues unmapped without   │ Neighborhood/ward centroid  │
│    Venues           │ 15-rider vote support.             │ (admin_boundaries) + prompt.│
├─────────────────────┼────────────────────────────────────┼─────────────────────────────┤
│ 3. Newly Opened     │ Venues <30 days old absent from    │ Ride Merchant Portal,       │
│    Businesses       │ baseline/survey batches.           │ clean-room warranty.        │
├─────────────────────┼────────────────────────────────────┼─────────────────────────────┤
│ 4. Categorical      │ "hospital near me", "ATM".         │ PostGIS ST_DWithin by       │
│    Proximity        │                                    │ category in rider H3 r8.    │
├─────────────────────┼────────────────────────────────────┼─────────────────────────────┤
│ 5. Inter-District   │ Sylhet, Chittagong, Cox's Bazar   │ admin_boundaries ADM1–ADM3  │
│    Destinations     │ from Dhaka handsets.               │ (ADM3/4 [UNVERIFIED]).      │
└─────────────────────┴────────────────────────────────────┴─────────────────────────────┘
```

---

## 8. Deliverables & Definition of Done

- [ ] **Dual physical indexes** `first_party_pois` + `osm_pois` provisioned in separate data directories; automated test asserts zero cross-writes and zero union indexes in all environments (F-008-1).
- [ ] Source views `dpmaps.v_search_feed_first_party` / `dpmaps.v_search_feed_osm` deployed (Stage 003 Rev 2.4 brief); sync workers populate ~52,000 documents `[ESTIMATE]`.
- [ ] **Mixed autocomplete from launch** with `Verified Landmark` / `Open Directory` badges; cross-source 30 m dedupe verified on device (F-008-2).
- [ ] **Zero-hit fallback verified**: in `primary` mode, 1 local hit ⇒ zero vendor calls (instrumented counter test) (F-008-3).
- [ ] **Session handoff** (`dest_session:*`, 15 min, `GETDEL`) implemented; expiry → rider reselection; zero vendor coordinates in any persistent table (F-008-4).
- [ ] Popularity ranking + bilingual prefix behavior validated in staging (MeiliSearch Bengali tokenization `[UNVERIFIED]`) (F-008-5).
- [ ] Telemetry conformant: selection rows in `raw_search_events` (scrubbed, ≤ 80 chars) written at tap time; `search_eval_events` written only by the post-trip evaluator with CHECK-valid `selected_source`; impressions metrics-only (F-008-6).
- [ ] Digit-lock `"disableOnNumbers": true` active; Stage 007 normalizer integrated (NFC, ZWJ/ZWNJ, `০-৯` folding).
- [ ] Vendor integration exclusively via `fetchSafeVendorSuggestions`; zero vendor SDK imports outside `vendorClientWrapper.ts`; zero vendor strings in logs/DB.
- [ ] Index names consistent with Stage 011 purge paths (`first_party_pois` / `osm_pois`).
- [ ] Latency benchmark executed on real hardware; `[ESTIMATE]` labels replaced with measurements.
- [ ] **Stage 002 Legal Gate Enforced:** `search_provider_mode` locked at `0: off` until written counsel clearance on Items 3, 7, 14, 15, 16, 17.

---

## 9. Revision Changelog

| Revision | Date | Author / Context | Summary of Major Changes |
|---|---|---|---|
| Rev 2.0 | 2026-10-22 | Orchestrator (audited baseline) | MeiliSearch cluster, `v_search_feed` sync, mixed orchestrator, gap matrix, Tier B telemetry. |
| Rev 2.1 | 2026-10-22 | Lead Planning & Systems Architecture (batch-2 audit) | **Dual-Index Isolation & Contract Repairs:**<br>1. **Physical index isolation (F-008-1):** replaced single `dpmaps_places` index and phantom `v_search_feed` with two physically separate indexes (`first_party_pois`, `osm_pois`) and two source views; RAM-only query-time merge; suppression purges both.<br>2. **Mixed autocomplete from launch (F-008-2):** unified deduplicated list with `Verified Landmark` / `Open Directory` badges; precedence first_party > osm > vendor; 30 m cross-source dedupe.<br>3. **Zero-hit fallback (F-008-3):** `primary` mode calls the vendor strictly when local returns zero results.<br>4. **Session handoff (F-008-4):** `dest_session:<session_token>`, 15-min TTL, atomic `GETDEL`, no persistence (Stage 002/005 namespace reconciliation tracked cross-plan).<br>5. **Ranking (F-008-5):** query-cluster popularity + decayed vote weights (aggregated only), bilingual Bangla/transliteration prefix support.<br>6. **Telemetry conformance (F-008-6):** selection events → `raw_search_events` (scrubbed, CHECK-valid `selected_source`) at tap time; impressions → Prometheus metrics only; eval rows → `search_eval_events` by the post-trip evaluator.<br>7. **Integrity (F-008-7/8):** `[ESTIMATE]`/`[UNVERIFIED]` labels on all figures; index names unified with Stage 011. |
