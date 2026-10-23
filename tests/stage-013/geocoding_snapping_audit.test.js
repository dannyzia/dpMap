/**
 * Stage 013 audit — Specialized Geocoding, Parsing & Snapping.
 * Executes the REAL TS sources via the repo-pinned tsc (no mirrors).
 * Covers the plan section 5 matrix TC-013-01 through TC-013-08.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`[FAIL] ${name}${extra ? ' — ' + extra : ''}`);
  }
}
function read(p) {
  return fs.readFileSync(path.join(REPO, p), 'utf8');
}

// ---------- Transpile real TS ----------
const TSC = path.join(REPO, 'tools', 'glyphs', 'node_modules', '.bin', 'tsc');
check('T0: repo-pinned tsc available', fs.existsSync(TSC), TSC);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage013-'));
const SHIM = path.join(REPO, 'tests', 'stage-005', 'node-shim.d.ts');
const ENTRY = [
  'utils-server/dhakaAddressParser.ts',
  'services/reverseGeocoder.ts',
  'services/perimeterGateSnapper.ts',
];
let transpiled = false;
try {
  execFileSync(
    TSC,
    [
      '--module', 'commonjs', '--target', 'es2020', '--strict', 'false',
      '--rootDir', REPO, '--outDir', tmp,
      SHIM,
      ...ENTRY.map((e) => path.join(REPO, e)),
    ],
    { stdio: 'pipe' }
  );
  transpiled = ENTRY.every((e) => fs.existsSync(path.join(tmp, e.replace(/\.ts$/, '.js'))));
} catch (e) {
  console.error(`[FAIL] TS transpile: ${(e.stderr || e.message || '').toString().slice(0, 2000)}`);
}
check('T1: TS sources transpile clean (real code, no mirrors)', transpiled);
if (!transpiled) {
  console.error(`FATAL: cannot verify without transpiled output (${pass} pass, ${fail} failed)`);
  process.exit(2);
}

const PAR = require(path.join(tmp, 'utils-server', 'dhakaAddressParser.js'));
const REV = require(path.join(tmp, 'services', 'reverseGeocoder.js'));
const SNAP = require(path.join(tmp, 'services', 'perimeterGateSnapper.js'));

// Haversine (test-side geography-meter stand-in for injected distance fns).
function havM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const dLa = ((bLat - aLat) * Math.PI) / 180;
  const dLn = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLa / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ---------- A. Parser TC-013-01/02/08 ----------
{
  const p1 = PAR.parseDhakaCompoundAddress('Flat 5B, House 23/A, Road 4, Block C, Uttara');
  check(
    'A1/TC-013-01: micro-units → delivery_notes',
    p1.delivery_notes.some((n) => /flat 5b/i.test(n)) && p1.delivery_notes.some((n) => /house 23\/a/i.test(n)),
    JSON.stringify(p1.delivery_notes)
  );
  check(
    'A2/TC-013-01: resolvable_query keeps ordered anchors, strips units',
    /road 4/i.test(p1.resolvable_query) && /block c/i.test(p1.resolvable_query) && /uttara/i.test(p1.resolvable_query) &&
      !/flat|house/i.test(p1.resolvable_query),
    JSON.stringify(p1.resolvable_query)
  );
  check(
    'A3: Road 4 ≠ Road 7 survives as ordered entity',
    p1.structured_entities.some((e) => e.headword === 'road' && e.value === '4'),
    JSON.stringify(p1.structured_entities)
  );

  const p2 = PAR.parseDhakaCompoundAddress('বাড়ি নং ২৩, রোড ৪, উত্তরা');
  check(
    'A4/TC-013-02: Bengali digits folded + extracted (scrubPii first)',
    p2.delivery_notes.length > 0 && /road/i.test(p2.resolvable_query) === false && /রোড/.test(p2.resolvable_query),
    JSON.stringify(p2)
  );
  check('A5: scrubbed_input has ASCII digits only', !/[০-৯]/.test(p2.scrubbed_input));

  // TC-013-08: delivery notes absent from every dpmaps surface.
  const notes = p1.delivery_notes.join(' | ');
  check(
    'A6/TC-013-08: notes never leak into the public query',
    !p1.delivery_notes.some((n) => p1.resolvable_query.toLowerCase().includes(n.toLowerCase())),
    notes
  );
  const src013 = read('utils-server/dhakaAddressParser.ts') + read('services/reverseGeocoder.ts') + read('services/perimeterGateSnapper.ts');
  check('A7: zero INSERT/UPDATE into dpmaps.* in new geocoding modules', !/(INSERT|UPDATE)\s+(INTO\s+)?dpmaps\./i.test(src013));
  check('A8: ephemeral contract documented in source', /ephemeral|never in dpmaps/i.test(src013));
}

// ---------- B. Waterfall TC-013-03/04/05 (async) ----------
(async () => {
  function baseDeps(over = {}) {
    const cache = new Map();
    return {
      calls: { vendor: 0 },
      cache,
      deps: {
        findActivePoiWithin: async () => null,
        findRoadWithin: async () => null,
        findAdminContaining: async () => ({ ward_area: 'Ward 12', thana: 'Mirpur' }),
        findZoneFallback: async () => ({ thana: 'Dhaka' }),
        cacheGet: async (k) => cache.get(k) ?? null,
        cacheSet: async (k, v) => {
          cache.set(k, v);
        },
        h3Res10Of: () => '8a123456789abcd',
        vendorResolve: null,
        ...over,
      },
    };
  }

  // TC-013-03: pin 20 m from Square Hospital → Tier 1.
  {
    const h = baseDeps({
      findActivePoiWithin: async (la, ln, r) => (r >= 20 ? { name: 'Square Hospital', area: 'Dhanmondi', distanceM: 20 } : null),
    });
    const r = await REV.reverseGeocode(h.deps, 23.751, 90.377, 'primary');
    check(
      'B1/TC-013-03: Tier 1 "Near Square Hospital" @0.95',
      r.tier === 1 && r.display_text === 'Near Square Hospital, Dhanmondi' && r.confidence === 0.95 && !r.vendor_sourced,
      JSON.stringify(r)
    );
  }
  // TC-013-04: unnamed lane → Tier 2 road; vendor NEVER called.
  {
    let vendorCalls = 0;
    const h = baseDeps({
      findRoadWithin: async (la, ln, r) => (r >= 12 ? { road_name: 'Road 11', area: 'Banani', distanceM: 12 } : null),
      vendorResolve: async () => {
        vendorCalls++;
        return { display_text: 'Vendor Road' };
      },
    });
    const r = await REV.reverseGeocode(h.deps, 23.791, 90.407, 'primary');
    check(
      'B2/TC-013-04: Tier 2 road, no vendor call',
      r.tier === 2 && /Road 11/.test(r.display_text) && r.confidence === 0.85 && vendorCalls === 0,
      JSON.stringify(r)
    );
  }
  // TC-013-05: zero POI/road within 100 m in primary → vendor display-only; zero rows.
  {
    let vendorCalls = 0;
    const h = baseDeps({
      vendorResolve: async () => {
        vendorCalls++;
        return { display_text: 'Vendor Lane Display' };
      },
    });
    const r = await REV.reverseGeocode(h.deps, 23.0, 90.0, 'primary');
    check(
      'B3/TC-013-05: zero-hit → vendor display-only + local Tier 3 kept',
      r.vendor_sourced === true && r.vendor_display_text === 'Vendor Lane Display' && r.tier === 3 &&
        r.display_text === 'Ward 12, Mirpur, Dhaka' && vendorCalls === 1,
      JSON.stringify(r)
    );
    const cachedRaw = h.cache.get(REV.reverseCacheKey('8a123456789abcd'));
    check(
      'B4: vendor string never cached; local Tier 3 text cached',
      !!cachedRaw && !cachedRaw.includes('Vendor Lane Display') && cachedRaw.includes('Mirpur'),
      cachedRaw
    );
  }
  // off/sole never call vendor even on zero-hit.
  {
    let vendorCalls = 0;
    for (const mode of ['off', 'sole']) {
      const h = baseDeps({
        vendorResolve: async () => {
          vendorCalls++;
          return { display_text: 'V' };
        },
      });
      const r = await REV.reverseGeocode(h.deps, 23.0, 90.0, mode);
      check(`B5: mode=${mode} never calls vendor`, vendorCalls === 0 && !r.vendor_sourced, JSON.stringify(r));
    }
  }
  // Cache hit short-circuits spatial lookups.
  {
    let spatial = 0;
    const h = baseDeps({
      findActivePoiWithin: async () => {
        spatial++;
        return { name: 'P', area: 'A', distanceM: 5 };
      },
    });
    await REV.reverseGeocode(h.deps, 23.751, 90.377, 'primary');
    await REV.reverseGeocode(h.deps, 23.751, 90.377, 'primary');
    check('B6: H3 res-10 cache hit skips spatial on repeat', spatial === 1);
  }

  // ---------- C. Gate snapper TC-013-06/07 ----------
  const JFP = { id: 'venue-jfp', name: 'Jamuna Future Park', distanceM: 40 };
  function gateDeps(gates) {
    return {
      findVenueWithin: async () => JFP,
      listChildGates: async () => gates,
      distanceM: havM,
    };
  }
  // TC-013-06: pin inside JFP courtyard snaps to a gate + connector.
  {
    const r = await SNAP.snapToGate(
      gateDeps([
        { id: 'g1', canonical_name: 'JFP Gate 1', point_type: 'perimeter_gate', lng: 90.421, lat: 23.813 },
        { id: 'g2', canonical_name: 'JFP Service Entry', point_type: 'entrance', lng: 90.423, lat: 23.815 },
      ]),
      23.8135,
      90.4215,
      'car'
    );
    check(
      'C1/TC-013-06: courtyard pin snaps to gate + LineString connector',
      r.snapped && !!r.gate && r.connector.type === 'LineString' && r.connector.coordinates.length === 2 &&
        r.connector.walk_distance_m > 0 && r.connector.walk_time_s > 0,
      JSON.stringify(r)
    );
  }
  // TC-013-07: car → primary gate only; bike may use secondary entrance.
  {
    const gates = [
      { id: 'gp', canonical_name: 'Main Gate', point_type: 'perimeter_gate', lng: 90.43, lat: 23.82, vehicles: ['car', 'bike', 'cng'] },
      { id: 'gs', canonical_name: 'Side Entry', point_type: 'entrance', lng: 90.4205, lat: 23.8136, vehicles: ['bike', 'cng'] },
    ];
    const car = await SNAP.snapToGate(gateDeps(gates), 23.8135, 90.4204, 'car');
    const bike = await SNAP.snapToGate(gateDeps(gates), 23.8135, 90.4204, 'bike');
    check('C2/TC-013-07: car → primary perimeter gate', car.snapped && car.gate.id === 'gp', JSON.stringify(car.gate));
    check('C3: bike → nearest legal secondary entrance', bike.snapped && bike.gate.id === 'gs', JSON.stringify(bike.gate));
  }
  // No venue / no gates paths.
  {
    const r1 = await SNAP.snapToGate(
      { findVenueWithin: async () => null, listChildGates: async () => [], distanceM: havM },
      23.0, 90.0, 'car'
    );
    check('C4: open-road pin does not snap', !r1.snapped && r1.reason === 'no_venue');
    const r2 = await SNAP.snapToGate(
      { findVenueWithin: async () => JFP, listChildGates: async () => [], distanceM: havM },
      23.8135, 90.4215, 'car'
    );
    check('C5: venue without gates does not snap', !r2.snapped && r2.reason === 'no_gate');
  }

  // ---------- D. Schema + source-shape invariants ----------
  {
    const ddl = read('migrations/003_storage_schema.sql');
    check('D1: point_type taxonomy incl. gates', ddl.includes("'perimeter_gate'") && ddl.includes("'entrance'") && ddl.includes("'curb_stop'"));
    check('D2: osm_road_names ODbL layer columns', ddl.includes('CREATE TABLE IF NOT EXISTS dpmaps.osm_road_names') && ddl.includes('highway_class'));
    check('D3: admin_boundaries containment-ready', ddl.includes('CREATE TABLE IF NOT EXISTS dpmaps.admin_boundaries') && ddl.includes('admin_level'));
    check('D4: gate SQL exact shape (parent + taxonomy + geography order)', SNAP.GATE_SELECT_SQL.includes('parent_place_id') && SNAP.GATE_SELECT_SQL.includes('perimeter_gate') && SNAP.GATE_SELECT_SQL.includes('ST_Distance'));
    check('D5: radii 50/30/100 named', REV.TIER_1_RADIUS_M === 50 && REV.TIER_2_RADIUS_M === 30 && REV.DISCOVERY_RADIUS_M === 100);
    check('D6: confidence ladder 0.95/0.85/0.80/0.50', REV.TIER_CONFIDENCE.tier1 === 0.95 && REV.TIER_CONFIDENCE.tier2 === 0.85 && REV.TIER_CONFIDENCE.tier3 === 0.8 && REV.TIER_CONFIDENCE.tier4 === 0.5);
    check('D7: H3 cache key + 24h TTL', REV.reverseCacheKey('abc') === 'dpmaps:reverse_geo:abc' && REV.REVERSE_GEO_CACHE_TTL_S === 86400);
    const src = read('services/reverseGeocoder.ts');
    check('D8: no vendor SDKs; vendor path response-only documented', !/(barikoi|googleapis)/i.test(src) && /never stored|response-only|NEVER cached/i.test(src));
  }

  console.log(`\nSTAGE013: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
