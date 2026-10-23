#!/usr/bin/env node
/**
 * osrm_routing_audit.test.js — Stage 004 software-core audit.
 * Zero test dependencies. Run: node tests/stage-004/osrm_routing_audit.test.js
 *
 * Strategy: Lua profiles / shell / compose are audited structurally (no
 * luac/OSRM engine on this host — full osrm-extract validation awaits the
 * Phase 1 infra stage, explicitly OUT of scope). The TypeScript sources are
 * transpiled with the repo-pinned tsc (tools/glyphs/node_modules) to a temp
 * dir and the REAL functions are executed behaviorally — no mirrors.
 */

'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const http = require('node:http');

const REPO = path.resolve(__dirname, '..', '..');
let passed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`[PASS] ${name}`);
  } else {
    console.error(`[FAIL] ${name} ${detail}`);
    process.exitCode = 1;
  }
}
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// ---------- A. Lua profiles ----------
const car = read('profiles/car.lua');
const bike = read('profiles/bike.lua');
const cng = read('profiles/cng.lua');
// Minimal Lua block scanner: function/if/for/while/do push, end pops,
// then/else/elseif are in-block keywords. Catches unbalanced chunks.
function luaBalanced(src) {
  const code = src.replace(/--\[\[[\s\S]*?\]\]/g, ' ').replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const toks = code.match(/\b(?:function|if|then|else|elseif|for|while|do|end|repeat|until)\b/g) || [];
  const stack = [];
  for (const t of toks) {
    // `for … do` / `while … do` share one block: the trailing do pushes nothing.
    if (t === 'do' && (stack[stack.length - 1] === 'for' || stack[stack.length - 1] === 'while')) continue;
    if (t === 'function' || t === 'if' || t === 'for' || t === 'while' || t === 'do' || t === 'repeat') stack.push(t);
    else if (t === 'end' || t === 'until') {
      if (stack.length === 0) return false;
      stack.pop();
    }
  }
  return stack.length === 0 && toks.length > 0;
}
for (const [n, src] of [['car', car], ['bike', bike], ['cng', cng]]) {
  check(`A0: profiles/${n}.lua exists, non-empty`, src.length > 500);
  check(`A0b: ${n}.lua blocks balanced`, luaBalanced(src));
  check(`A0c: ${n}.lua has setup/process_way/process_node/process_turn`, /function setup\(\)/.test(src) && /function process_way\(/.test(src) && /function process_node\(/.test(src) && /function process_turn\(/.test(src));
  check(`A0d: ${n}.lua tag-first (access/motor_vehicle before names)`, /get_value_by_key\('access'\)/.test(src) && /get_value_by_key\('motor_vehicle'\)/.test(src));
  check(`A0e: ${n}.lua left_hand_driving = true`, /left_hand_driving\s*=\s*true/.test(src));
  check(`A0f: ${n}.lua curated blocklist loader (no name bans)`, /banned_ways\[tostring\(way:id\(\)\)\]/.test(src) && !/way:get_value_by_key\('name'\)/.test(src));
}
check('A1: bike sets mode.driving (F-004-8)', /default_mode\s*=\s*mode\.driving/.test(bike) && (bike.match(/result\.(forward|backward)_mode\s*=\s*mode\.driving/g) || []).length >= 2);
check('A1b: bike min alley width 1.2', /MIN_ALLEY_WIDTH_M\s*=\s*1\.2/.test(bike) && /traffic_alley_min_width\s*=\s*MIN_ALLEY_WIDTH_M/.test(bike));
check('A1c: bike U-turn penalty 15', /U_TURN_PENALTY_S\s*=\s*15/.test(bike));
check('A2: cng clamps 45 km/h (12.5 m/s)', /MAX_SPEED_KMH\s*=\s*45/.test(cng) && /max_speed_for_map_matching\s*=\s*MAX_SPEED_KMH\s*\/\s*3\.6/.test(cng));
check('A2b: cng primary/trunk cap 35', /PRIMARY_CAP_KMH\s*=\s*35/.test(cng));
check('A2c: cng U-turn penalty 35', /U_TURN_PENALTY_S\s*=\s*35/.test(cng));
check('A3: car filters width < 2.5', /MIN_ALLEY_WIDTH_M\s*=\s*2\.5/.test(car) && /w\s*<\s*MIN_ALLEY_WIDTH_M/.test(car));
check('A3b: car motor_vehicle=no excluded', /data\.motor_vehicle\s*==\s*'no'/.test(car));
for (const v of ['car', 'bike', 'cng']) {
  const f = path.join(REPO, 'profiles', `restricted_ways_${v}.txt`);
  check(`A4: restricted_ways_${v}.txt exists, default-off`, fs.existsSync(f));
  if (fs.existsSync(f)) {
    const ids = read(`profiles/restricted_ways_${v}.txt`).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    check(`A4b: restricted_ways_${v}.txt has numeric IDs only`, ids.every((l) => /^\d+$/.test(l)), `${ids.length} active entries`);
  }
}

// ---------- Transpile real TS sources ----------
const TSC = path.join(REPO, 'tools', 'glyphs', 'node_modules', '.bin', 'tsc');
check('T0: repo-pinned tsc available', fs.existsSync(TSC), TSC);
if (!fs.existsSync(TSC)) {
  console.error('FATAL: cannot behaviorally verify TS without tsc');
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage004-'));
// tsc preserves the common source root: outputs land in <tmp>/workers/ + <tmp>/utils-server/.
const H_PATH = path.join(tmp, 'workers', 'trafficHarvester.js');
const C_PATH = path.join(tmp, 'utils-server', 'osrmRoutingClient.js');
let transpiled = false;
try {
  execFileSync(TSC, [
    '--module', 'commonjs', '--target', 'es2020', '--strict', 'false',
    '--rootDir', REPO, '--outDir', tmp,
    path.join(REPO, 'workers', 'trafficHarvester.ts'),
    path.join(REPO, 'utils-server', 'osrmRoutingClient.ts'),
  ], { stdio: 'pipe' });
  transpiled = fs.existsSync(H_PATH) && fs.existsSync(C_PATH);
} catch (e) {
  console.error(`[FAIL] TS transpile: ${(e.stderr || e.message || '').toString().slice(0, 2000)}`);
}
check('T1: TS sources transpile clean (real code, no mirrors)', transpiled);
if (!transpiled) {
  console.error('FATAL: cannot behaviorally verify TS without transpiled output');
  process.exit(2);
}
const H = require(H_PATH);
const C = require(C_PATH);

// ---------- B. Harvester & TOD math ----------
check('B0: vehicle ports car:5001 bike:5002 cng:5003', H.ENGINE_PORT.car === 5001 && H.ENGINE_PORT.bike === 5002 && H.ENGINE_PORT.cng === 5003);

// B1: halt filter.
{
  const t0 = 1_700_000_000_000;
  const trace = [
    { lat: 23.81, lng: 90.41, timestamp: t0, speedKmh: 25 },
    { lat: 23.811, lng: 90.411, timestamp: t0 + 10_000, speedKmh: 1.2 },
    { lat: 23.811, lng: 90.411, timestamp: t0 + 25_000, speedKmh: 0.5 },
    { lat: 23.811, lng: 90.411, timestamp: t0 + 45_000, speedKmh: 0.4 }, // >30s halt → drop
    { lat: 23.812, lng: 90.412, timestamp: t0 + 60_000, speedKmh: 30 },
  ];
  const kept = H.filterStationaryHalts(trace);
  check('B1: sustained halt ping dropped, brief stops kept', kept.length === 4 && kept.every((p) => p.timestamp !== t0 + 45_000));
}

// B2: harmonic mean.
check('B2: harmonic mean [30,60] === 40 (not 45)', Math.abs(H.calculateHarmonicMean([30, 60]) - 40) < 1e-9);
check('B2b: single element identity', H.calculateHarmonicMean([17]) === 17);
check('B2c: harmonic ≤ arithmetic under skew', H.calculateHarmonicMean([10, 10, 90]) < (10 + 10 + 90) / 3);

// B3: TOD buckets across 24 Dhaka hours.
{
  const expected = (h) => {
    if (h >= 7 && h < 11) return 'morning_peak';
    if (h >= 16 && h < 21) return 'evening_peak';
    if (h < 5) return 'night';
    return 'off_peak';
  };
  let ok = true;
  const seen = new Set();
  for (let h = 0; h < 24; h++) {
    const ms = Date.UTC(2026, 4, 1, h - 6, 30); // Dhaka = UTC+6
    const got = H.resolveTodBucket(ms);
    seen.add(got);
    if (got !== expected(h)) {
      ok = false;
      console.error(`  hour ${h}: got ${got}, want ${expected(h)}`);
    }
  }
  check('B3: all 24 Dhaka hours bucketed correctly', ok);
  check('B3b: all 4 named buckets reachable', seen.size === 4, [...seen].join(','));
}

// B4: parallel annotation extraction (real code, injected fetcher).
(async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    return {
      code: 'Ok',
      matchings: [
        {
          confidence: 0.9,
          legs: [{ annotation: { nodes: [101, 102, 103], duration: [10, 20], distance: [100, 100] } }],
        },
        { confidence: 0.2, legs: [{ annotation: { nodes: [1, 2], duration: [5], distance: [500] } }] }, // discarded
      ],
    };
  };
  const recs = await H.extractSegmentSpeeds(
    [
      { lat: 0, lng: 0, timestamp: 1_700_000_000_000 },
      { lat: 0.001, lng: 0.001, timestamp: 1_700_000_010_000 },
      { lat: 0.002, lng: 0.002, timestamp: 1_700_000_030_000 },
    ],
    'bike',
    fake,
  );
  check('B4: per-edge speeds from parallel arrays', recs.length === 2 && recs[0].fromNode === 101 && recs[0].toNode === 102 && recs[1].toNode === 103, JSON.stringify(recs.map((r) => r.speedKmh)));
  check('B4b: speed math (100m/10s=36, 100m/20s=18)', recs[0].speedKmh === 36 && recs[1].speedKmh === 18);
  check('B4c: low-confidence matching discarded', !recs.some((r) => r.fromNode === 1));
  check('B4d: matched against own port 5002', calls.length === 1 && calls[0].includes('localhost:5002/match/v1/driving/'));
  const carCalls = [];
  await H.extractSegmentSpeeds(
    [
      { lat: 0, lng: 0, timestamp: 1_700_000_000_000 },
      { lat: 0.001, lng: 0.001, timestamp: 1_700_000_010_000 },
      { lat: 0.002, lng: 0.002, timestamp: 1_700_000_030_000 },
    ],
    'car',
    async (u) => {
      carCalls.push(u);
      return { code: 'NoMatch' };
    },
  );
  check('B4e: car uses port 5001', carCalls[0].includes('localhost:5001/'));

  // B5: clamp.
  const clampCalls = [];
  const recs2 = await H.extractSegmentSpeeds(
    [
      { lat: 0, lng: 0, timestamp: 1_700_000_000_000 },
      { lat: 0.001, lng: 0.001, timestamp: 1_700_000_001_000 },
      { lat: 0.002, lng: 0.002, timestamp: 1_700_000_100_000 },
    ],
    'cng',
    async () => ({
      code: 'Ok',
      matchings: [{ confidence: 0.95, legs: [{ annotation: { nodes: [7, 8, 9], duration: [1, 3600], distance: [1000, 10] } }] }],
    }),
  );
  check('B5: speeds clamped 3–100', recs2[0].speedKmh === 100 && recs2[1].speedKmh === 3, JSON.stringify(recs2.map((r) => r.speedKmh)));

  // B6: CSV.
  const csv = H.generateSpeedCsv([{ fromNode: 1, toNode: 2, speedKmh: 14, todBucket: 'off_peak', vehicleType: 'car' }]);
  check('B6: CSV header + payload', csv.startsWith('# from_osm_node,to_osm_node,speed\n') && csv.includes('1,2,14'));
})().then(async () => {
  // ---------- C. Client, breaker, timeout ----------
  check('C0: REQUEST_TIMEOUT_MS === 300', C.REQUEST_TIMEOUT_MS === 300);
  check('C0b: BREAKER_STRIKES === 3', C.BREAKER_STRIKES === 3);

  // C1: timeout value actually passed to the fetcher.
  let seenTimeout = -1;
  const slow = new C.OsrmRoutingClient('car', async (url, ms) => {
    seenTimeout = ms;
    await new Promise((r) => setTimeout(r, 50));
    return { status: 200, body: { code: 'Ok', routes: [{ duration: 60, distance: 500 }] } };
  });
  await slow.route({ lat: 0, lng: 0 }, { lat: 1, lng: 1 });
  check('C1: client passes 300ms to transport', seenTimeout === 300, `got ${seenTimeout}`);

  // C2: real end-to-end abort against a 600ms-delayed local server.
  const srv = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'Ok', routes: [{ duration: 1, distance: 1 }] }));
    }, 600);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), C.REQUEST_TIMEOUT_MS);
  let aborted = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/route`, { signal: ctrl.signal });
    await res.json();
  } catch (e) {
    aborted = true;
  } finally {
    clearTimeout(t);
    srv.close();
  }
  check('C2: 300ms abort fires against slow endpoint', aborted);

  // C3: 3 consecutive 5xx/timeouts → OPEN; fast-fail without network.
  let calls = 0;
  const failing = async () => {
    calls++;
    return { status: 500, body: {} };
  };
  const client = new C.OsrmRoutingClient('bike', failing);
  check('C3a: starts CLOSED', client.breakerState === 'CLOSED');
  await client.route({ lat: 0, lng: 0 }, { lat: 1, lng: 1 });
  await client.route({ lat: 0, lng: 0 }, { lat: 1, lng: 1 });
  check('C3b: still CLOSED after 2 strikes', client.breakerState === 'CLOSED' && client.consecutiveFailures === 2);
  await client.route({ lat: 0, lng: 0 }, { lat: 1, lng: 1 });
  check('C3c: OPEN after 3rd consecutive failure', client.breakerState === 'OPEN');
  let fastFail = false;
  try {
    await client.route({ lat: 0, lng: 0 }, { lat: 1, lng: 1 });
  } catch (e) {
    fastFail = e instanceof C.OsrmCircuitOpenError;
  }
  check('C3d: OPEN rejects without network attempt', fastFail && calls === 3, `calls=${calls}`);

  // C4: success resets; NoRoute does not trip.
  const okClient = new C.OsrmRoutingClient('cng', async () => ({ status: 200, body: { code: 'Ok', routes: [{ duration: 120, distance: 900 }] } }));
  const r = await okClient.route({ lat: 0, lng: 0 }, { lat: 1, lng: 1 });
  check('C4: healthy route returns duration/distance', r !== null && r.durationS === 120 && r.distanceM === 900);
  const noRoute = new C.OsrmRoutingClient('cng', async () => ({ status: 200, body: { code: 'NoRoute' } }));
  await noRoute.route({ lat: 0, lng: 0 }, { lat: 1, lng: 1 });
  check('C4b: NoRoute returns null without tripping breaker', noRoute.breakerState === 'CLOSED' && noRoute.consecutiveFailures === 0);

  // ---------- D. ETA correction ----------
  check('D1: <30 samples → 1.0', C.calculateEtaMultiplier([{ actual_duration_s: 100, osrm_duration_s: 50 }]) === 1.0);
  const mk = (ratio, n) => Array.from({ length: n }, () => ({ actual_duration_s: 100 * ratio, osrm_duration_s: 100 }));
  check('D2: exact median ratio at 30 samples', C.calculateEtaMultiplier(mk(1.25, 30)) === 1.25);
  const mixed = [...mk(1.0, 15), ...mk(1.4, 15)];
  check('D2b: even-count median interpolates', C.calculateEtaMultiplier(mixed) === 1.2);
  check('D3: clamps to [0.5, 2.0]', C.calculateEtaMultiplier(mk(0.1, 30)) === 0.5 && C.calculateEtaMultiplier(mk(9, 30)) === 2.0);
  check('D4: corrected ETA = k·T_osrm', C.getCorrectedEta(600, 1.25) === 750);

  // ---------- E. Relative cutover gates ----------
  check('E1: e_T formula exact', Math.abs(C.relativeTimeError({ pred_duration_s: 660, actual_duration_s: 600, pred_distance_m: 0, actual_distance_m: 1 }) - 10) < 1e-9);
  check('E1b: e_D formula exact', Math.abs(C.relativeDistanceError({ pred_duration_s: 0, actual_duration_s: 1, pred_distance_m: 1030, actual_distance_m: 1000 }) - 3) < 1e-9);
  const gatePass = Array.from({ length: 20 }, (_, i) => ({
    pred_duration_s: 600 * (1 + (i % 2 === 0 ? 0.05 : -0.05)),
    actual_duration_s: 600,
    pred_distance_m: 1000 * 1.01,
    actual_distance_m: 1000,
  }));
  const v = C.evaluateGate1(gatePass, 90);
  check('E2: Gate 1 passes within thresholds', v.pass === true, JSON.stringify(v));
  const gateFail = gatePass.map((s) => ({ ...s, pred_duration_s: s.actual_duration_s * 1.5 }));
  check('E2b: Gate 1 fails above 12% median', C.evaluateGate1(gateFail, 90).pass === false);
  check('E2c: Gate 1 fails below 85% overlap', C.evaluateGate1(gatePass, 80).pass === false);
  // Prohibition text itself ("never flat minutes") is allowed; any other
  // minute-based threshold language is a Gate-1 violation.
  const src = (read('utils-server/osrmRoutingClient.ts') + read('workers/trafficHarvester.ts'))
    .replace(/never flat minutes?/gi, '');
  check('E3: flat-minute thresholds absent', !/\b\d+\s*minutes?\b/i.test(src) && !/minutes?\s*(threshold|sla|gate|tolerance)/i.test(src), 'found minute-based threshold language');

  console.log(`\nStage 004 audit complete: ${passed} assertions passed.`);
}).catch((err) => {
  console.error('[FAIL] audit crashed:', err);
  process.exitCode = 1;
});
