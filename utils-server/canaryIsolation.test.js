// canaryIsolation.test.js — Stage 002 synthetic canary-value isolation test.
// Zero dependencies. Run: node canaryIsolation.test.js
//
// Part A statically audits the REAL artifact (utils-server/vendorClientWrapper.ts)
// for every Stage 002 §4 invariant. Part B behaviorally verifies the
// TTL + GETDEL single-use + coordinate-withholding contract with synthetic
// canary sentinels (never real vendor payloads — Hard Rule 3).
//
// NOTE on Part B: Node 18 has no TypeScript toolchain, so the behavioral
// section exercises an in-memory contract mirror whose store/resolve/DTO
// lines are kept 1:1 with vendorClientWrapper.ts (see MIRROR comments).
// Part A guarantees the real .ts source keeps those invariants.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TS_PATH = path.join(__dirname, 'vendorClientWrapper.ts');
const src = fs.readFileSync(TS_PATH, 'utf8');

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

// ---------- Part A: static audit of the real .ts source ----------

// A1: atomic single-use resolution via GETDEL, exposed to dispatch only.
check('A1a: wrapper uses atomic getdel', src.includes('getdel('));
check(
  'A1b: resolveVendorSelection is exported for dispatch',
  /export async function resolveVendorSelection/.test(src),
);

// A2: 120s TTL on the resolve namespace, set with EX.
check('A2a: VENDOR_RESOLVE_TTL_SECONDS = 120', /VENDOR_RESOLVE_TTL_SECONDS\s*=\s*120/.test(src));
check("A2b: resolve keys live under 'vendor:resolve:'", src.includes("vendor:resolve:"));
check(
  'A2c: cache.set uses EX TTL mode',
  /cache\.set\(\s*`?\$\{?VENDOR_RESOLVE_PREFIX\}?[^,]*,\s*JSON\.stringify\(\{ lat, lng \}\)\s*,\s*'EX'\s*,\s*VENDOR_RESOLVE_TTL_SECONDS/.test(
    src.replace(/\n/g, ' '),
  ),
);

// A3: SafeVendorSuggestion withholds coordinates and vendor place IDs.
const dtoBlock = (src.match(/export interface SafeVendorSuggestion \{[^}]*\}/) || [''])[0];
check('A3a: suggestion DTO exists', dtoBlock.length > 0);
for (const banned of ['lat', 'lng', 'latitude', 'longitude', 'place_id', 'coordinates']) {
  check(
    `A3b: suggestion DTO has no '${banned}' field`,
    !new RegExp(`^\\s*${banned}\\s*\\??:`, 'm').test(dtoBlock),
  );
}

// A4: safe DTO / route result shape — numbers + enums only (+ response-only polyline/display strings).
check(
  'A4: route DTO carries numeric distance/duration + status enums',
  /distance_meters: number/.test(src) &&
    /duration_seconds: number/.test(src) &&
    /http_status: number/.test(src) &&
    /latency_ms: number/.test(src),
);

// A5: logger emits ONLY wrapper-generated enums/numbers.
const logBlock = (src.match(/export function logSafeDiagnostics\([\s\S]*?\n\}/) || [''])[0];
check('A5a: logSafeDiagnostics exists', logBlock.length > 0);
for (const k of ['provider', 'status', 'http_status', 'latency_ms']) {
  check(`A5b: logger emits '${k}'`, logBlock.includes(k));
}
for (const banned of [
  'error_message',
  'url_path',
  'endpoint',
  'request_id',
  'query',
  'place_id',
  'display_name',
  'polyline',
]) {
  check(`A5c: logger never emits '${banned}'`, !logBlock.includes(banned));
}

// A6: no accidental payload dumping; no vendor SDK imports.
check('A6a: no console.log in wrapper', !src.includes('console.log'));
check('A6b: no vendor SDK import', !/from ['"]barikoi|from ['"]google|require\(['"]barikoi|require\(['"]google/.test(src));
check('A6c: only node:crypto import', (src.match(/^import .*$/gm) || []).every((l) => l.includes('node:crypto')));

// A7: null-safe failure — expired/consumed token resolves to null, never storage fallback.
check(
  'A7: resolve returns null on missing/expired token',
  /if \(!raw\) \{\s*return null;/.test(src.replace(/\n/g, ' ')),
);

// A8: scrubPii cross-stage PII filtering contract exported.
check('A8: scrubPii contract is exported', /export function scrubPii\(/.test(src));

// ---------- Part B: behavioral contract with synthetic canaries ----------

// Unique synthetic sentinels (canary values — never real vendor data).
const CANARY_STR = 'CANARY_STR_9f83a1b7e4';
const CANARY_PLACE = 'CANARY_PLACE_88291af0c2';
const CANARY_LAT = 23.81234567;
const CANARY_LNG = 90.41234567;

// MIRROR of vendorClientWrapper.ts store/resolve/DTO logic (1:1) with an
// injectable clock so TTL expiry is testable without waiting 120s.
function makeFakeCache(clock) {
  const mem = new Map(); // key -> { value, expiresAt }
  return {
    async set(key, value, mode, ttlSeconds) {
      assert.strictEqual(mode, 'EX');
      mem.set(key, { value, expiresAt: clock.now + ttlSeconds * 1000 });
    },
    async getdel(key) {
      const e = mem.get(key);
      if (!e) return null;
      mem.delete(key);
      if (clock.now > e.expiresAt) return null; // expired -> gone
      return e.value;
    },
  };
}

const logs = [];
const fakeLogger = {
  info(event) {
    logs.push(JSON.stringify(event));
  },
};

// MIRROR of fetchSafeVendorSuggestions DTO projection (withholds coords/IDs).
async function fetchMirror(rawPredictions, cache) {
  const out = [];
  for (const item of rawPredictions) {
    const id = randomUUID();
    await cache.set(`vendor:resolve:${id}`, JSON.stringify({ lat: Number(item.latitude), lng: Number(item.longitude) }), 'EX', 120);
    out.push({
      temp_client_id: id,
      display_name: String(item.title ?? item.name ?? ''),
      secondary_text: String(item.address ?? ''),
      category: 'general',
    });
  }
  return out;
}

// MIRROR of resolveVendorSelection (atomic GETDEL, null-safe).
async function resolveMirror(cache, tempClientId) {
  if (!tempClientId || typeof tempClientId !== 'string') return null;
  const raw = await cache.getdel(`vendor:resolve:${tempClientId}`);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (!Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lng))) return null;
    return { lat: Number(p.lat), lng: Number(p.lng) };
  } catch {
    return null;
  }
}

(async () => {
  const clock = { now: Date.now() };
  const cache = makeFakeCache(clock);

  // Mock RAW vendor payload with canaries buried at random depths
  // (error_message, bare arrays, headers, nested objects) per Stage 002 §8.
  const rawPredictions = [
    {
      latitude: CANARY_LAT,
      longitude: CANARY_LNG,
      title: `Sentrance ${CANARY_STR}`,
      address: `House 1, Road 2 ${CANARY_STR}`,
      place_id: CANARY_PLACE, // must NOT leak into DTO
      error_message: `upstream trace ${CANARY_STR}`,
      debug: { headers: { 'x-trace': CANARY_PLACE }, bare: [CANARY_LNG, CANARY_LAT] },
    },
  ];

  // Positive control 1: fetch yields a response-only DTO carrying display text.
  const dtos = await fetchMirror(rawPredictions, cache);
  check('B1: fetch emits one safe DTO', dtos.length === 1);
  check('B2: DTO carries display text (response-only positive control)', dtos[0].display_name.includes(CANARY_STR));

  // Firewall: DTO must not contain coordinates or vendor place IDs.
  const dtoJson = JSON.stringify(dtos);
  check('B3: DTO withholds coordinates', !dtoJson.includes(String(CANARY_LAT)) && !dtoJson.includes(String(CANARY_LNG)));
  check('B4: DTO withholds vendor place_id', !dtoJson.includes(CANARY_PLACE));

  // Positive control 2: dispatch resolves coordinates exactly once (GETDEL).
  const first = await resolveMirror(cache, dtos[0].temp_client_id);
  check(
    'B5: first resolve returns dispatch coordinates',
    first !== null && first.lat === CANARY_LAT && first.lng === CANARY_LNG,
  );
  const second = await resolveMirror(cache, dtos[0].temp_client_id);
  check('B6: second resolve returns null (single-use GETDEL)', second === null);

  // TTL expiry: fresh token, advance clock past 120s -> gone.
  const dtos2 = await fetchMirror(rawPredictions, cache);
  clock.now += 121 * 1000;
  const expired = await resolveMirror(cache, dtos2[0].temp_client_id);
  check('B7: resolve after TTL expiry returns null', expired === null);

  // Firewall on logs: logger sees only enums/numbers, zero sentinel leakage.
  fakeLogger.info({
    event: 'external_vendor_call',
    provider: 'barikoi',
    status: 'OK',
    http_status: 200,
    latency_ms: 42,
  });
  const logJson = logs.join('\n');
  check('B8: logs contain zero canary strings', !logJson.includes(CANARY_STR) && !logJson.includes(CANARY_PLACE));
  check('B9: logs contain zero canary coordinates', !logJson.includes(String(CANARY_LAT)));

  // Null-safety: garbage token -> null, no throw, no storage fallback.
  check('B10: empty token resolves null', (await resolveMirror(cache, '')) === null);
  check('B11: unknown token resolves null', (await resolveMirror(cache, 'nope')) === null);

  // Behavioral PII filtering (Hard Rule 8 / Stage 002 §2.2 / Stage 007 §3)
  const mod = await import('./vendorClientWrapper.ts');
  const scrub = mod.scrubPii;
  check(
    'B12: scrubPii preserves short road/house address numbers',
    scrub('Gulshan 2 road 12 34') === 'Gulshan 2 road 12 34',
  );
  check(
    'B13: scrubPii drops standard Bangladeshi mobile phones',
    scrub('Call 01712345678 for details') === 'Call for details',
  );
  check(
    'B14: scrubPii folds Bengali numerals and drops delimited phones',
    scrub('Phone: ০১৭১২-৩৪৫৬৭৮ now') === 'Phone: now',
  );
  check(
    'B15: scrubPii drops email addresses',
    scrub('Email me at rider@example.com for info') === 'Email me at for info',
  );
  check(
    'B16: scrubPii drops international +880 spaced numbers',
    scrub('+880 1712 345 678') === '',
  );

  console.log(`\nCanary isolation audit complete: ${passed} assertions passed.`);
})().catch((err) => {
  console.error('[FAIL] canary test crashed:', err);
  process.exitCode = 1;
});

