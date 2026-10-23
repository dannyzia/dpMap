/**
 * aliasClusterer.ts — Stage 007 §6 spatial convergence + §7 alias promotion.
 *
 * Text alone cannot merge places: "Star Kabab" branches share 100% text but
 * are distinct places. Every candidate pair must pass ALL THREE gates:
 *   1. Centroid distance ≤ 75 m [ESTIMATE];
 *   2. H3 res-10 1-ring overlap: gridDisk(target.h3_res10, 1) contains the
 *      candidate cell (naive cell-equality fails across boundaries ~5 m apart);
 *   3. Trigram similarity ≥ 0.70 [ESTIMATE] OR exact phonetic-key match.
 *
 * Plus hard anti-merging constraints (§5): short prefixes (≤ 4 chars) never
 * cluster with landmarks (Stage 008 completion pointers only), and merges
 * are pairwise — never transitive.
 *
 * H3's gridDisk is INJECTED (production wires h3-js; same zero-dep pattern
 * as Stages 004/005) so the audit executes real gate logic with a
 * same-semantics fake. Promotion SQL (§7) is embedded verbatim as a string
 * constant so the audit statically verifies Stage 003 join discipline.
 */

export const SPATIAL_MAX_DISTANCE_M = 75; // [ESTIMATE]
export const TRIGRAM_THRESHOLD = 0.70; // [ESTIMATE]
export const SHORT_PREFIX_MAX_LEN = 4; // §5 rule 3: pointer-only, never landmark

export interface SpatialPoint {
  dropoff_lat: number;
  dropoff_lng: number;
  h3_res10: string;
}

export interface TargetPoi {
  lat: number;
  lng: number;
  h3_res10: string;
}

export interface ClusterText {
  /** Raw/scrubbed pre-expansion query — the short-prefix gate reads this. */
  raw_query: string;
  normalized_query: string;
  bengali_phonetic_key: string;
  cluster_id: string;
}

/** Production: (cell, k) => gridDisk(cell, k) from h3-js. */
export type GridDiskFn = (cell: string, k: number) => string[];

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Dice coefficient over padded character trigrams. */
export function trigramSimilarity(a: string, b: string): number {
  const trigrams = (s: string): string[] => {
    const p = `  ${s}  `;
    const out: string[] = [];
    for (let i = 0; i < p.length - 2; i++) out.push(p.slice(i, i + 3));
    return out;
  };
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.length === 0 || tb.length === 0) return a === b ? 1 : 0;
  const counts = new Map<string, number>();
  for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1);
  let inter = 0;
  for (const t of tb) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      inter += 1;
      counts.set(t, c - 1);
    }
  }
  return (2 * inter) / (ta.length + tb.length);
}

/**
 * Plan §6 verbatim: distance gate first, then 1-ring overlap.
 * Never falls back to vendor geometry — there is no such parameter.
 */
export function validateSpatialConvergence(
  candidate: SpatialPoint,
  targetPoi: TargetPoi,
  gridDisk: GridDiskFn,
): boolean {
  const d = haversineMeters(candidate.dropoff_lat, candidate.dropoff_lng, targetPoi.lat, targetPoi.lng);
  if (d > SPATIAL_MAX_DISTANCE_M) return false; // [ESTIMATE]
  return new Set(gridDisk(targetPoi.h3_res10, 1)).has(candidate.h3_res10);
}

/**
 * §5 rule 3: queries ≤ 4 chars are completion pointers, never landmarks.
 * Measured on the RAW query (pre-abbreviation-expansion): 'JFP' is a
 * 3-char typed prefix even though it expands to 'jamuna future park'.
 */
export function isShortPrefix(rawQuery: string): boolean {
  return rawQuery.trim().length <= SHORT_PREFIX_MAX_LEN;
}

/** §6 gate 3: trigram ≥ 0.70 OR exact phonetic-key match. */
export function textGatePass(a: ClusterText, b: ClusterText): boolean {
  if (a.bengali_phonetic_key !== '' && a.bengali_phonetic_key === b.bengali_phonetic_key) return true;
  return trigramSimilarity(a.normalized_query, b.normalized_query) >= TRIGRAM_THRESHOLD;
}

/**
 * Full merge decision: identical cluster identity (phonetic + ORDERED
 * entities/directions) AND spatial convergence AND text gate AND neither
 * side a short prefix. Pairwise only — callers must not chain merges.
 */
export function shouldCluster(
  a: ClusterText,
  locA: SpatialPoint,
  b: ClusterText,
  locB: TargetPoi,
  gridDisk: GridDiskFn,
): boolean {
  if (a.cluster_id !== b.cluster_id) return false;
  if (isShortPrefix(a.raw_query) || isShortPrefix(b.raw_query)) return false;
  if (!textGatePass(a, b)) return false;
  return validateSpatialConvergence(locA, locB, gridDisk);
}

/**
 * Plan §7 verbatim promotion SQL (string constant for static audit).
 * Follows the Stage 003 join discipline: anchor dedup key, decay at read,
 * invalidation exclusion, privacy gate; uq_poi_alias ON CONFLICT.
 */
export const ALIAS_PROMOTION_SQL = `-- Promote candidate aliases with decayed, anchor-key-deduplicated support.
-- (uq_poi_alias UNIQUE (poi_id, alias_text) exists in Stage 003 §4.3.)
INSERT INTO dpmaps.poi_aliases (poi_id, alias_text, alias_type, source, support_votes, status)
SELECT poi.id,
       qc.canonical_query,
       'colloquial',
       'rider_typed',
       SUM(dpmaps.calculate_decayed_weight(tel.initial_weight, tel.created_at)), -- decay at read
       CASE WHEN COUNT(DISTINCT lp.pseudonym_hash) >= 15 THEN 'active' ELSE 'pending' END
FROM dpmaps.query_clusters qc
JOIN dpmaps.trip_evidence_ledger tel ON tel.query_cluster_id = qc.cluster_id
JOIN dpmaps.ledger_pseudonyms lp
  ON lp.ledger_id = tel.id AND lp.created_at = tel.created_at
JOIN dpmaps.active_dedup_key adk ON lp.key_id = adk.key_id          -- 135-day anchor
LEFT JOIN dpmaps.ledger_invalidations li
  ON li.ledger_id = tel.id AND li.created_at = tel.created_at
JOIN dpmaps.public_pois poi ON poi.h3_res10 = tel.h3_res10
WHERE li.ledger_id IS NULL                                          -- invalidations excluded
  AND tel.created_at >= NOW() - INTERVAL '90 days'
  -- privacy gate (F-007-5): never promote PII-bearing canonical queries
  AND qc.canonical_query !~ '(^|[^0-9])01[3-9][0-9]{8}([^0-9]|$)'
  AND qc.canonical_query !~ '@'
GROUP BY poi.id, qc.canonical_query
ON CONFLICT (poi_id, alias_text) DO UPDATE
SET support_votes = dpmaps.poi_aliases.support_votes + EXCLUDED.support_votes;`;
