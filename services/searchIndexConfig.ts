/**
 * searchIndexConfig.ts — Stage 008 §2 dual-index schema & settings.
 *
 * Physical isolation invariant (F-008-1): `first_party_pois` (proprietary
 * clean-room landmarks, id `pub_<uuid>`) and `osm_pois` (ODbL open data,
 * id `osm_<osm_type>:<osm_id>`) are two completely separate MeiliSearch
 * indexes in separate data directories. They are merged ONLY at query time
 * in RAM by searchOrchestrator.ts — never co-indexed, never a union index.
 * Suppression (Stage 011) purges each index independently by ID prefix
 * (parseDocumentId routes; assertNoCrossWrite guards the sync layer).
 *
 * Zero dependencies. Production sync workers (meiliSyncWorker, Phase 1
 * infra) import FEEDS + builders + settings from here.
 */

export const INDEX_FIRST_PARTY = 'first_party_pois';
export const INDEX_OSM = 'osm_pois';

export const FIRST_PARTY_ID_PREFIX = 'pub_';
export const OSM_ID_PREFIX = 'osm_';

export type SearchIndexName = typeof INDEX_FIRST_PARTY | typeof INDEX_OSM;

/** `pub_<uuid>` — Stage 003 public_pois place_id (random UUID v4). */
export function makeFirstPartyId(uuid: string): string {
  return `${FIRST_PARTY_ID_PREFIX}${uuid}`;
}

/** `osm_<osm_type>:<osm_id>` e.g. `osm_N:1024`, `osm_W:55821`, `osm_R:77`. */
export function makeOsmId(osmType: string, osmId: number | string): string {
  return `${OSM_ID_PREFIX}${osmType}:${osmId}`;
}

/**
 * Routes a document ID to its owning index (Stage 011 purge paths).
 * Returns null for foreign IDs — never silently assign an index.
 */
export function parseDocumentId(documentId: string): SearchIndexName | null {
  if (documentId.startsWith(FIRST_PARTY_ID_PREFIX)) return INDEX_FIRST_PARTY;
  if (documentId.startsWith(OSM_ID_PREFIX)) return INDEX_OSM;
  return null;
}

/**
 * Sync-layer guard: a document whose ID prefix does not belong to the
 * target index is rejected before any write (zero cross-writes, F-008-1).
 */
export function assertNoCrossWrite(indexName: SearchIndexName, documentId: string): void {
  if (parseDocumentId(documentId) !== indexName) {
    throw new Error(
      `assertNoCrossWrite: document '${documentId}' does not belong to index '${indexName}'`,
    );
  }
}

/**
 * Identical index settings for BOTH indexes (plan §2.2).
 * Digit Preservation Invariant: disableOnNumbers:true enforces Stage 007
 * hard digit locking — "Road 4" vs "Road 7" is never fuzzy-matched.
 * MeiliSearch typo behavior on Bengali script is UNVERIFIED (staging gate).
 */
export const INDEX_SETTINGS = {
  searchableAttributes: [
    'canonical_name',
    'bangla_name',
    'search_aliases',
    'bengali_phonetic_keys',
    'category',
    'point_type',
  ],
  filterableAttributes: ['_geo', 'category', 'point_type', 'h3_res9', 'lifecycle_status'],
  sortableAttributes: ['_geo', 'confidence_score', 'popularity'],
  rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
  typoTolerance: {
    enabled: true,
    minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 },
    disableOnWords: [
      'rd', 'road', 'sec', 'sector', 'blk', 'block',
      'gali', 'lane', 'mor', 'gate', 'bridge', 'bazaar',
    ],
    disableOnNumbers: true,
  },
  pagination: { maxTotalHits: 20 },
} as const;

/** MeiliSearch document shape (both indexes; license differs). */
export interface SearchDocument {
  id: string;
  canonical_name: string;
  bangla_name?: string;
  search_aliases: string[];
  bengali_phonetic_keys: string[];
  category: string;
  point_type: string;
  h3_res9: string;
  h3_res10: string;
  _geo: { lat: number; lng: number };
  confidence_score: number;
  popularity: number;
  lifecycle_status: string;
  license_type: 'first_party_proprietary' | 'osm_odbl_attributed';
}

/** Source-view row (dpmaps.v_search_feed_first_party). */
export interface FirstPartyFeedRow {
  place_id: string;
  canonical_name: string;
  bangla_name?: string | null;
  aliases?: string[] | null;
  phonetic_keys?: string[] | null;
  category: string;
  point_type: string;
  h3_res9: string;
  h3_res10: string;
  lat: number;
  lng: number;
  confidence_score: number;
  popularity: number;
  lifecycle_status: string;
}

/** Source-view row (dpmaps.v_search_feed_osm). */
export interface OsmFeedRow {
  osm_type: string;
  osm_id: number | string;
  name: string;
  name_bn?: string | null;
  aliases?: string[] | null;
  phonetic_keys?: string[] | null;
  category: string;
  h3_res9: string;
  h3_res10: string;
  lat: number;
  lng: number;
  confidence_score: number;
  popularity: number;
  lifecycle_status: string;
}

/** First-party row → first_party_pois document (never to osm_pois). */
export function buildFirstPartyDoc(row: FirstPartyFeedRow): SearchDocument {
  return {
    id: makeFirstPartyId(row.place_id),
    canonical_name: row.canonical_name,
    bangla_name: row.bangla_name ?? undefined,
    search_aliases: row.aliases ?? [],
    bengali_phonetic_keys: row.phonetic_keys ?? [],
    category: row.category,
    point_type: row.point_type,
    h3_res9: row.h3_res9,
    h3_res10: row.h3_res10,
    _geo: { lat: row.lat, lng: row.lng },
    confidence_score: row.confidence_score,
    popularity: row.popularity,
    lifecycle_status: row.lifecycle_status,
    license_type: 'first_party_proprietary',
  };
}

/** OSM row → osm_pois document (never to first_party_pois). */
export function buildOsmDoc(row: OsmFeedRow): SearchDocument {
  return {
    id: makeOsmId(row.osm_type, row.osm_id),
    canonical_name: row.name,
    bangla_name: row.name_bn ?? undefined,
    search_aliases: row.aliases ?? [],
    bengali_phonetic_keys: row.phonetic_keys ?? [],
    category: row.category,
    point_type: 'entrance',
    h3_res9: row.h3_res9,
    h3_res10: row.h3_res10,
    _geo: { lat: row.lat, lng: row.lng },
    confidence_score: row.confidence_score,
    popularity: row.popularity,
    lifecycle_status: row.lifecycle_status,
    license_type: 'osm_odbl_attributed',
  };
}

/** The ONLY legal (index, source-view) pairs — no union feed exists. */
export const FEEDS = [
  { indexName: INDEX_FIRST_PARTY, sourceView: 'dpmaps.v_search_feed_first_party' },
  { indexName: INDEX_OSM, sourceView: 'dpmaps.v_search_feed_osm' },
] as const;
