/**
 * perimeterGateSnapper.ts — Stage 013 section 4 perimeter gate snapper.
 *
 * Pins inside mega-complexes snap to legal curb gates instead of
 * expressway ramps or the wrong side of a wall:
 *   1. Venue detection: pin inside/within 150 m [ESTIMATE] of a
 *      building/area venue (geography meters).
 *   2. Gate selection: child rows via parent_place_id with point_type IN
 *      ('perimeter_gate', 'entrance', 'curb_stop') — the taxonomy of record
 *      (work-order 'pickup_gate' maps here; no schema change).
 *   3. Vehicle filtering: gate permissions in public_pois.provenance JSONB
 *      (no DDL): provenance->'gate'->'vehicles' subset of car/bike/cng,
 *      default = all vehicles. Cars prefer 'perimeter_gate'; bikes/CNG may
 *      use secondary 'entrance'/'curb_stop'.
 *   4. Snap: nearest legal gate by distance; driver target = entrance_geom.
 *   5. Pedestrian connector: GeoJSON LineString pin→gate + walk distance/time.
 *
 * OSRM destination = gate coordinates; the in-app pin keeps the user's
 * original drop with the connector overlay. Zero infra deps: venue/gate
 * lookups and distance arrive injected; the plan §4 SQL is kept as a
 * documented constant.
 */

export type VehicleType = 'car' | 'bike' | 'cng';
export type GatePointType = 'perimeter_gate' | 'entrance' | 'curb_stop';

export const GATE_POINT_TYPES: GatePointType[] = ['perimeter_gate', 'entrance', 'curb_stop'];
export const VENUE_DETECTION_RADIUS_M = 150;
export const WALK_SPEED_M_PER_S = 1.2;

export interface VenueHit {
  id: string;
  name: string;
  distanceM: number;
}

export interface GateRow {
  id: string;
  canonical_name: string;
  point_type: GatePointType;
  /** Legal curb coordinates (entrance_geom). */
  lng: number;
  lat: number;
  /** Subset of ['car','bike','cng']; absent = all vehicles allowed. */
  vehicles?: VehicleType[];
}

export interface PedestrianConnector {
  type: 'LineString';
  coordinates: [number, number][];
  walk_distance_m: number;
  walk_time_s: number;
}

export interface GateSnapResult {
  snapped: boolean;
  gate?: GateRow;
  connector?: PedestrianConnector;
  reason: 'snapped' | 'no_venue' | 'no_gate' | 'no_vehicle_gate';
}

/** Narrow injected venue/gate surface. */
export interface GateSnapperDeps {
  findVenueWithin: (lat: number, lng: number, radiusM: number) => Promise<VenueHit | null> | VenueHit | null;
  listChildGates: (venueId: string) => Promise<GateRow[]> | GateRow[];
  /** Geography-meter distance (production: ST_Distance on geography). */
  distanceM: (aLat: number, aLng: number, bLat: number, bLng: number) => number;
}

/** Plan §4 gate-selection SQL (exact shape, production execution). */
export const GATE_SELECT_SQL =
  'SELECT g.id, g.canonical_name, g.entrance_geom, g.point_type\n' +
  'FROM dpmaps.public_pois g\n' +
  "WHERE g.parent_place_id = $1\n" +
  "  AND g.point_type IN ('perimeter_gate', 'entrance', 'curb_stop')\n" +
  'ORDER BY ST_Distance(g.entrance_geom::geography, ST_SetSRID(ST_Point($2,$3),4326)::geography) ASC\n' +
  'LIMIT 1;';

function gateAllows(gate: GateRow, vehicle: VehicleType): boolean {
  if (!gate.vehicles || gate.vehicles.length === 0) return true;
  return gate.vehicles.includes(vehicle);
}

/**
 * Snap a pin to the nearest vehicle-legal gate. Cars prefer
 * 'perimeter_gate' (primary gates); bikes/CNG accept any legal gate.
 */
export async function snapToGate(
  deps: GateSnapperDeps,
  pinLat: number,
  pinLng: number,
  vehicle: VehicleType
): Promise<GateSnapResult> {
  const venue = await deps.findVenueWithin(pinLat, pinLng, VENUE_DETECTION_RADIUS_M);
  if (!venue) return { snapped: false, reason: 'no_venue' };

  const gates = await deps.listChildGates(venue.id);
  const legal = gates.filter((g) => GATE_POINT_TYPES.includes(g.point_type) && gateAllows(g, vehicle));
  if (legal.length === 0) {
    return { snapped: false, reason: gates.length === 0 ? 'no_gate' : 'no_vehicle_gate' };
  }

  // Cars prefer primary perimeter gates; bikes/CNG take the nearest legal gate.
  const pool =
    vehicle === 'car' && legal.some((g) => g.point_type === 'perimeter_gate')
      ? legal.filter((g) => g.point_type === 'perimeter_gate')
      : legal;
  let best = pool[0];
  let bestD = deps.distanceM(pinLat, pinLng, best.lat, best.lng);
  for (const g of pool.slice(1)) {
    const d = deps.distanceM(pinLat, pinLng, g.lat, g.lng);
    if (d < bestD) {
      best = g;
      bestD = d;
    }
  }

  const walkTimeS = bestD / WALK_SPEED_M_PER_S;
  return {
    snapped: true,
    gate: best,
    connector: {
      type: 'LineString',
      coordinates: [
        [pinLng, pinLat],
        [best.lng, best.lat],
      ],
      walk_distance_m: Math.round(bestD * 10) / 10,
      walk_time_s: Math.round(walkTimeS),
    },
    reason: 'snapped',
  };
}
