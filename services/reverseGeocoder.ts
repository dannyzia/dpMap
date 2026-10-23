/**
 * reverseGeocoder.ts — Stage 013 section 2 sovereign reverse geocoder.
 *
 * 4-tier local-first waterfall (all distances geography meters):
 *   Tier 1: public_pois within 50 m (lifecycle_status='active')
 *           → "Near {name}, {area}"            confidence 0.95
 *   Tier 2: osm_road_names centerline within 30 m (ODbL layer)
 *           → "{road_name}, {area}, Dhaka"      confidence 0.85
 *   Tier 3: admin_boundaries ST_Contains (ADM3/ADM4)
 *           → "{ward/area}, {thana}, Dhaka"    confidence 0.80
 *   Tier 4: H3 res-8/9 zone table fallback
 *           → "{thana}, Dhaka"                  confidence 0.50
 *
 * ZERO-HIT RULE (F-013-3): discovery radius is 100 m for BOTH the POI and
 * road tests. Zero hit (no POI AND no road within 100 m) in shadow/primary
 * → vendor lookup as DISPLAY-ONLY enhancement: { display_text } only —
 * no place IDs, no persistence, no DB rows, no telemetry strings
 * (Hard Rule 1, Stage 002 wrapper contract). Tier 3/4 text still returned.
 *
 * Cache: H3 res-10 cells (stack-consistent), dpmaps:reverse_geo:<h3>, 24 h
 * TTL. Zero infra deps: spatial lookups + cache + vendor arrive injected.
 */

export type VendorMode = 'off' | 'shadow' | 'primary' | 'sole';

export interface ReverseGeocodeResult {
  display_text: string;
  tier: 1 | 2 | 3 | 4;
  confidence: number;
  /**
   * Vendor display-only enhancement (F-013-3). Local Tier 3/4 text stays
   * in display_text regardless; this field carries the vendor string for
   * the response ONLY. Callers must never persist or cache it.
   */
  vendor_display_text?: string;
  /** True when vendor_display_text is present (do not persist, do not cache). */
  vendor_sourced: boolean;
}

export interface PoiHit {
  name: string;
  area: string;
  distanceM: number;
}
export interface RoadHit {
  road_name: string;
  area: string;
  distanceM: number;
}
export interface AdminHit {
  ward_area: string;
  thana: string;
}
export interface ZoneHit {
  thana: string;
}

/** Narrow injected spatial/cache/vendor surface. */
export interface ReverseDeps {
  findActivePoiWithin: (lat: number, lng: number, radiusM: number) => Promise<PoiHit | null> | PoiHit | null;
  findRoadWithin: (lat: number, lng: number, radiusM: number) => Promise<RoadHit | null> | RoadHit | null;
  findAdminContaining: (lat: number, lng: number) => Promise<AdminHit | null> | AdminHit | null;
  findZoneFallback: (lat: number, lng: number) => Promise<ZoneHit | null> | ZoneHit | null;
  cacheGet: (key: string) => Promise<string | null> | string | null;
  cacheSet: (key: string, value: string, ttlSeconds: number) => void | Promise<void>;
  h3Res10Of: (lat: number, lng: number) => string;
  /** Vendor display-only resolver (Stage 002 contract: { display_text } only). */
  vendorResolve?: (lat: number, lng: number) => Promise<{ display_text: string } | null> | { display_text: string } | null;
}

export const REVERSE_GEO_CACHE_PREFIX = 'dpmaps:reverse_geo:';
export const REVERSE_GEO_CACHE_TTL_S = 86400;

export const TIER_1_RADIUS_M = 50;
export const TIER_2_RADIUS_M = 30;
export const DISCOVERY_RADIUS_M = 100;

export const TIER_CONFIDENCE = { tier1: 0.95, tier2: 0.85, tier3: 0.8, tier4: 0.5 } as const;

export function reverseCacheKey(h3res10: string): string {
  return `${REVERSE_GEO_CACHE_PREFIX}${h3res10}`;
}

/**
 * Waterfall entry point. Modes:
 * - off/sole: local tiers only, never call vendor.
 * - shadow/primary: vendor display-only ONLY on zero-hit (no POI and no
 *   road within 100 m). Vendor text is returned alongside Tier 3/4 local
 *   text and is never cached under a dpmaps key beyond the response.
 */
export async function reverseGeocode(
  deps: ReverseDeps,
  lat: number,
  lng: number,
  mode: VendorMode = 'primary'
): Promise<ReverseGeocodeResult> {
  const cell = deps.h3Res10Of(lat, lng);
  const cached = await deps.cacheGet(reverseCacheKey(cell));
  if (cached) return JSON.parse(cached) as ReverseGeocodeResult;

  const finish = async (r: ReverseGeocodeResult): Promise<ReverseGeocodeResult> => {
    // Vendor display-only text is NEVER cached (response-only, F-013-3).
    if (!r.vendor_sourced) await deps.cacheSet(reverseCacheKey(cell), JSON.stringify(r), REVERSE_GEO_CACHE_TTL_S);
    return r;
  };

  const poi = await deps.findActivePoiWithin(lat, lng, TIER_1_RADIUS_M);
  if (poi) {
    return finish({
      display_text: `Near ${poi.name}, ${poi.area}`,
      tier: 1,
      confidence: TIER_CONFIDENCE.tier1,
      vendor_sourced: false,
    });
  }
  const road = await deps.findRoadWithin(lat, lng, TIER_2_RADIUS_M);
  if (road) {
    return finish({
      display_text: `${road.road_name}, ${road.area}, Dhaka`,
      tier: 2,
      confidence: TIER_CONFIDENCE.tier2,
      vendor_sourced: false,
    });
  }

  // Zero-hit test uses the WIDER discovery radius for both layers.
  const poiFar = await deps.findActivePoiWithin(lat, lng, DISCOVERY_RADIUS_M);
  const roadFar = await deps.findRoadWithin(lat, lng, DISCOVERY_RADIUS_M);
  const zeroHit = !poiFar && !roadFar;

  const admin = await deps.findAdminContaining(lat, lng);
  const zone = !admin ? await deps.findZoneFallback(lat, lng) : null;
  const local: ReverseGeocodeResult = admin
    ? {
        display_text: `${admin.ward_area}, ${admin.thana}, Dhaka`,
        tier: 3,
        confidence: TIER_CONFIDENCE.tier3,
        vendor_sourced: false,
      }
    : {
        display_text: zone ? `${zone.thana}, Dhaka` : 'Dhaka',
        tier: 4,
        confidence: TIER_CONFIDENCE.tier4,
        vendor_sourced: false,
      };

  const resolved = await finish(local);
  if (zeroHit && (mode === 'shadow' || mode === 'primary') && deps.vendorResolve) {
    const v = await deps.vendorResolve(lat, lng);
    if (v && v.display_text) {
      // Display-only enhancement: Tier 3/4 local text is still returned
      // (and cached) regardless; the vendor string rides alongside in the
      // response only. finish() already cached the LOCAL text above — the
      // vendor string never touches the cache or any table.
      return { ...resolved, vendor_display_text: v.display_text, vendor_sourced: true };
    }
  }
  return resolved;
}
