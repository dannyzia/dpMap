/**
 * savedPlacesMigrator.ts — Stage 014 §4 3-track migration engine.
 *
 * Track 1 — First-party trip-history triangulation (100% clean-room):
 *   median of the user's completed drop-offs; spread = max pairwise
 *   distance. Disambiguation (F-014-2): spread > 30 m OR < 3 trips OR
 *   multiple strong clusters (the Home/Work case — orders carry no
 *   destination label, so label text can NEVER disambiguate) ⇒
 *   needs_confirmation = TRUE with candidates attached to the card.
 *   Machine resolution NEVER sets user_confirmed = TRUE.
 * Track 2 — User confirmation: the ONLY path setting user_confirmed = TRUE.
 * Track 3 — Ephemeral vendor wrapper: coordinates ONLY ({lat,lng}), never
 *   IDs/strings; immediately routed to a Track 2 card (F-014-3).
 *
 * Privacy invariant (Class 3): NOTHING here queries dpmaps.* — the
 * migration reads public.orders + public.user_private_places only.
 * assertNoDpmapsMerge() structurally guards every shipped statement.
 *
 * Legal framing (F-014-1): user confirmation reduces vendor-dependency
 * exposure; whether it addresses third-party database rights is counsel
 * Items 15/16 [UNVERIFIED] — no absolute IP claims anywhere here.
 *
 * Zero infra deps: DB + H3 cell derivation arrive injected.
 */

export type MigrationSource =
  | 'first_party_trip_history'
  | 'user_confirmed_pin'
  | 'ephemeral_vendor_resolved'
  | 'native_first_party';

export interface DropOff {
  lat: number;
  lng: number;
}

export interface TriangulationResult {
  medianLat: number;
  medianLng: number;
  tripCount: number;
  /** Max pairwise distance among matched drop-offs, meters. */
  spreadM: number;
  needsConfirmation: boolean;
  confirmationReason: 'spread' | 'too_few_trips' | 'ambiguous_clusters' | null;
}

/** F-014-2 disambiguation thresholds [ESTIMATE]. */
export const SPREAD_CONFIRM_M = 30;
export const MIN_TRIPS_FOR_AUTO = 3;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function havM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLa = ((bLat - aLat) * Math.PI) / 180;
  const dLn = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLa / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Max pairwise spread (plan §4: computed per row at build; haversine here). */
export function spreadMeters(drops: DropOff[]): number {
  let max = 0;
  for (let i = 0; i < drops.length; i++) {
    for (let j = i + 1; j < drops.length; j++) {
      max = Math.max(max, havM(drops[i].lat, drops[i].lng, drops[j].lat, drops[j].lng));
    }
  }
  return Math.round(max * 100) / 100;
}

/**
 * Track 1 triangulation. `clusters` = the user's frequent drop-off H3
 * res-10 cells (trailing 180 d), each with its drop-offs. Auto-resolves
 * ONLY on exactly one strong cluster (≥3 trips, spread ≤30 m).
 */
export function triangulateFromTripHistory(clusters: DropOff[][]): TriangulationResult {
  const strong = clusters.filter((c) => c.length >= MIN_TRIPS_FOR_AUTO);
  if (strong.length === 0) {
    return {
      medianLat: 0, medianLng: 0, tripCount: 0, spreadM: 0,
      needsConfirmation: true, confirmationReason: 'too_few_trips',
    };
  }
  if (strong.length > 1) {
    // Home/Work ambiguity: label text cannot disambiguate (orders carry no
    // destination label) — never infer silently from time-of-day.
    const all = strong.flat();
    return {
      medianLat: median(all.map((d) => d.lat)),
      medianLng: median(all.map((d) => d.lng)),
      tripCount: all.length,
      spreadM: spreadMeters(all),
      needsConfirmation: true,
      confirmationReason: 'ambiguous_clusters',
    };
  }
  const drops = strong[0];
  const spread = spreadMeters(drops);
  const needs = spread > SPREAD_CONFIRM_M || drops.length < MIN_TRIPS_FOR_AUTO;
  return {
    medianLat: median(drops.map((d) => d.lat)),
    medianLng: median(drops.map((d) => d.lng)),
    tripCount: drops.length,
    spreadM: spread,
    needsConfirmation: needs,
    confirmationReason: needs ? (spread > SPREAD_CONFIRM_M ? 'spread' : 'too_few_trips') : null,
  };
}

/** Track 1 candidate query (orders-stub conformant: user_id/dropoff_lat/lng). */
export const TRACK1_CANDIDATE_SQL =
  'SELECT upp.id AS saved_place_id,\n' +
  '       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY o.dropoff_lat) AS median_lat,\n' +
  '       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY o.dropoff_lng) AS median_lng,\n' +
  '       COUNT(*) AS trip_count,\n' +
  '       MAX(o.dropoff_lat) - MIN(o.dropoff_lat) AS lat_span,\n' +
  '       MAX(o.dropoff_lng) - MIN(o.dropoff_lng) AS lng_span\n' +
  'FROM public.user_private_places upp\n' +
  'JOIN public.orders o ON o.user_id = upp.user_id AND o.status = \'completed\'\n' +
  'WHERE upp.is_migrated = FALSE\n' +
  'GROUP BY upp.id\n' +
  'HAVING COUNT(*) >= 3\n' +
  'LIMIT $1';

/** Track 1 write: machine sets user_confirmed = FALSE, always. */
export const TRACK1_UPDATE_SQL =
  'UPDATE public.user_private_places SET\n' +
  '  geom = ST_SetSRID(ST_Point($1, $2), 4326), h3_res9 = $3, h3_res10 = $4,\n' +
  "  migration_source = 'first_party_trip_history',\n" +
  '  user_confirmed = FALSE,\n' +
  '  needs_confirmation = $5, resolution_spread_meters = $6,\n' +
  '  is_migrated = TRUE, migrated_at = NOW()\n' +
  'WHERE id = $7';

/** Track 2: the ONLY statement that sets user_confirmed = TRUE. */
export const TRACK2_CONFIRM_SQL =
  'UPDATE public.user_private_places SET\n' +
  '  geom = ST_SetSRID(ST_Point($1,$2),4326), h3_res9 = $3, h3_res10 = $4,\n' +
  "  migration_source = 'user_confirmed_pin', user_confirmed = TRUE,\n" +
  '  needs_confirmation = FALSE, is_migrated = TRUE, migrated_at = NOW()\n' +
  'WHERE id = $5 AND user_id = $6';

/** Cutover gate (§6): must read 0 before Mode 2. */
export const CUTOVER_GATE_SQL =
  'SELECT COUNT(*) FROM public.user_private_places upp\n' +
  'JOIN public.orders o ON o.user_id = upp.user_id AND o.created_at >= NOW() - INTERVAL \'90 days\'\n' +
  'WHERE upp.is_migrated = FALSE OR upp.needs_confirmation = TRUE;';

/**
 * Track 3 ephemeral wrapper result: coordinates ONLY. The shape enforces
 * F-014-3 by construction — there is no field for IDs or strings — and
 * mustConfirm routes every resolution to a Track 2 card.
 */
export interface EphemeralResolution {
  lat: number;
  lng: number;
  mustConfirm: true;
}

export function toEphemeralResolution(lat: number, lng: number): EphemeralResolution {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('STAGE014-T3: non-finite coordinates');
  return { lat, lng, mustConfirm: true };
}

/**
 * Class-3 isolation guard (TC-014-05): saved-place statements must never
 * reference dpmaps.* tables. Run over every shipped statement.
 */
const DPMAPS_TABLE_REF = /\b(dpmaps\.\w+|trip_evidence_ledger|public_pois|poi_aliases)\b/i;
export function assertNoDpmapsMerge(sql: string): void {
  if (DPMAPS_TABLE_REF.test(sql)) {
    throw new Error('STAGE014-CLASS3: user_private_places must never merge with dpmaps.*');
  }
}

/** All statements this module ships (audited for Class-3 isolation). */
export const SHIPPED_STATEMENTS = [TRACK1_CANDIDATE_SQL, TRACK1_UPDATE_SQL, TRACK2_CONFIRM_SQL, CUTOVER_GATE_SQL];
