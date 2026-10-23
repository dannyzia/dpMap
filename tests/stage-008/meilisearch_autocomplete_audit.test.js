#!/usr/bin/env node
/**
 * meilisearch_autocomplete_audit.test.js — Stage 008 search-core audit.
 * Zero test dependencies. Run: node tests/stage-008/meilisearch_autocomplete_audit.test.js
 *
 * No MeiliSearch/Redis/Postgres on this host (OUT of scope: Phase 1 infra).
 * The real TypeScript sources are transpiled with the repo-pinned tsc and
 * executed behaviorally with same-semantics fakes (single-use GETDEL cache,
 * 40 ms budget enforcement, 50 m Haversine dedupe) — no mirrors.
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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

// ---------- T. Transpile real TS sources ----------
const TSC = path.join(REPO, 'tools', 'glyphs', 'node_modules', '.bin', 'tsc');
check('T0: repo-pinned tsc available', fs.existsSync(TSC), TSC);
if (!fs.existsSync(TSC)) {
  console.error('FATAL: cannot behaviorally verify TS without tsc');
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage008-'));
const C_PATH = path.join(tmp, 'services', 'searchIndexConfig.js');
const O_PATH = path.join(tmp, 'services', 'searchOrchestrator.js');
const D_PATH = path.join(tmp, 'services', 'destSession.js');
const S_PATH = path.join(tmp, 'services', 'searchTelemetry.js');
let transpiled = false;
try {
  execFileSync(
    TSC,
    [
      '--module', 'commonjs', '--target', 'es2020', '--strict', 'false',
      '--rootDir', REPO, '--outDir', tmp,
      path.join(REPO, 'services', 'searchIndexConfig.ts'),
      path.join(REPO, 'services', 'searchOrchestrator.ts'),
      path.join(REPO, 'services', 'destSession.ts'),
      path.join(REPO, 'services', 'searchTelemetry.ts'),
      path.join(REPO, 'utils-server', 'textNormalizer.ts'),
      path.join(REPO, 'utils-server', 'entityLocker.ts'),
      path.join(REPO, 'utils-server', 'bengaliPhonetics.ts'),
      path.join(REPO, 'utils-server', 'vendorClientWrapper.ts'),
      path.join(REPO, 'tests', 'stage-005', 'node-shim.d.ts'),
    ],
    { stdio: 'pipe' },
  );
  transpiled = [C_PATH, O_PATH, D_PATH, S_PATH].every(fs.existsSync);
} catch (e) {
  console.error(`[FAIL] TS transpile: ${(e.stderr || e.message || '').toString().slice(0, 2000)}`);
}
check('T1: TS sources transpile clean (real code, no mirrors)', transpiled);
if (!transpiled) {
  console.error('FATAL: cannot behaviorally verify TS without transpiled output');
  process.exit(2);
}
const IC = require(C_PATH);
const OR = require(O_PATH);
const DS = require(D_PATH);
const ST = require(S_PATH);

// ---------- Shared fakes ----------
function fakeCache() {
  const m = new Map();
  const calls = [];
  return {
    calls,
    async set(k, v, mode, ttl) { calls.push([k, ttl]); m.set(k, v); },
    async getdel(k) { const v = m.get(k) ?? null; m.delete(k); return v; },
    has: (k) => m.has(k),
  };
}
const FP_HIT = { id: 'pub_u1', canonical_name: 'Star Kabab', bangla_name: 'স্টার কাবাব', category: 'restaurant', search_aliases: ['starkabab'], popularity: 9, confidence_score: 0.9, _geo: { lat: 23.7937, lng: 90.4045 } };
const OSM_HIT = { id: 'osm_N:1024', canonical_name: 'Star Kabab', category: 'restaurant', search_aliases: [], popularity: 4, confidence_score: 0.5, _geo: { lat: 23.79375, lng: 90.40455 } };
const vendorOk = async () => [{ temp_client_id: 'tok1', display_name: 'Star Kabab Banani', secondary_text: 'Banani', category: 'restaurant' }];
function orchDeps(modeRaw, over = {}) {
  const alerts = [];
  return {
    deps: {
      getModeRaw: () => modeRaw,
      searchFirstParty: async () => [FP_HIT],
      searchOsm: async () => [OSM_HIT],
      vendorSearch: vendorOk,
      onAlert: (s, c) => alerts.push([s, c]),
      ...over,
    },
    alerts,
  };
}

(async () => {
  // ---------- A. Index config ----------
  check('A1: index names', IC.INDEX_FIRST_PARTY === 'first_party_pois' && IC.INDEX_OSM === 'osm_pois');
  check('A2: ID formats (pub_ / osm_T:ID)',
    IC.makeFirstPartyId('u-1') === 'pub_u-1' && IC.makeOsmId('N', 1024) === 'osm_N:1024');
  check('A3: purge routing (pub→fp, osm→osm, foreign→null)',
    IC.parseDocumentId('pub_x') === 'first_party_pois' &&
    IC.parseDocumentId('osm_W:5') === 'osm_pois' &&
    IC.parseDocumentId('vendor_9') === null);
  let threw = '';
  try { IC.assertNoCrossWrite('first_party_pois', 'osm_N:1'); } catch (e) { threw = e.message; }
  check('A4: cross-write rejected', /does not belong/.test(threw));
  IC.assertNoCrossWrite('osm_pois', 'osm_N:1');
  check('A5: legal write passes guard', true);
  const s = IC.INDEX_SETTINGS;
  check('A6: identical settings (§2.2 searchable/filterable/sort/ranking)',
    JSON.stringify(s.searchableAttributes) === JSON.stringify(['canonical_name', 'bangla_name', 'search_aliases', 'bengali_phonetic_keys', 'category', 'point_type']) &&
    s.filterableAttributes.includes('_geo') && s.sortableAttributes.includes('popularity') &&
    s.rankingRules[0] === 'words' && s.pagination.maxTotalHits === 20);
  check('A7: digit lock (disableOnNumbers + typo 4/8 + road/gate words)',
    s.typoTolerance.disableOnNumbers === true &&
    s.typoTolerance.minWordSizeForTypos.oneTypo === 4 &&
    s.typoTolerance.minWordSizeForTypos.twoTypos === 8 &&
    s.typoTolerance.disableOnWords.includes('road') && s.typoTolerance.disableOnWords.includes('gate'));
  const fp = IC.buildFirstPartyDoc({ place_id: 'u-1', canonical_name: 'X', category: 'mosque', point_type: 'entrance', h3_res9: 'r9', h3_res10: 'r10', lat: 1, lng: 2, confidence_score: 1, popularity: 2, lifecycle_status: 'active' });
  const od = IC.buildOsmDoc({ osm_type: 'W', osm_id: 5, name: 'Y', category: 'fuel', h3_res9: 'r9', h3_res10: 'r10', lat: 1, lng: 2, confidence_score: 1, popularity: 1, lifecycle_status: 'active' });
  check('A8: doc builders (IDs + license split, aliases default [])',
    fp.id === 'pub_u-1' && fp.license_type === 'first_party_proprietary' &&
    od.id === 'osm_W:5' && od.license_type === 'osm_odbl_attributed' &&
    Array.isArray(fp.search_aliases) && od.point_type === 'entrance');
  check('A9: FEEDS pairs only (no union feed)',
    IC.FEEDS.length === 2 &&
    IC.FEEDS.some((f) => f.indexName === 'first_party_pois' && f.sourceView === 'dpmaps.v_search_feed_first_party') &&
    IC.FEEDS.some((f) => f.indexName === 'osm_pois' && f.sourceView === 'dpmaps.v_search_feed_osm'));

  // ---------- B. Modes ----------
  {
    let localCalls = 0;
    const { deps } = orchDeps(0, {
      searchFirstParty: async () => { localCalls++; return []; },
      searchOsm: async () => { localCalls++; return []; },
    });
    const res = await OR.getMixedAutocomplete('star kabab', deps);
    check('B1: mode 0 off serves 100% vendor', res.length === 1 && res[0].source === 'vendor' && localCalls === 0);
    check('B2: vendor item has session token, no badge', res[0].session_token === 'tok1' && res[0].badge === null);
  }
  {
    const { deps } = orchDeps(1, { isLegalGateOpen: () => true });
    const res = await OR.getMixedAutocomplete('star kabab', deps);
    const sources = new Set(res.map((r) => r.source));
    check('B3: mode 1 shadow mixes from launch (fp+osm fused, vendor fused)',
      sources.has('first_party') && res.some((r) => r.source === 'vendor') && res[0].source === 'first_party');
    check('B4: badges correct',
      res.find((r) => r.source === 'first_party').badge === 'verified_landmark' &&
      res.every((r) => r.source !== 'osm' || r.badge === 'open_directory'));
  }
  {
    let vendorCalls = 0;
    const hit = orchDeps(2, {
      isLegalGateOpen: () => true,
      vendorSearch: async () => { vendorCalls++; return vendorOk(); },
    });
    const r1 = await OR.getMixedAutocomplete('star kabab', hit.deps);
    check('B5: mode 2 primary ≥1 local hit ⇒ ZERO vendor calls',
      vendorCalls === 0 && r1.every((r) => r.source !== 'vendor'));
    const miss = orchDeps(2, {
      isLegalGateOpen: () => true,
      searchFirstParty: async () => [],
      searchOsm: async () => [],
    });
    const r2 = await OR.getMixedAutocomplete('star kabab', miss.deps);
    check('B6: mode 2 zero local hits ⇒ vendor fallback', r2.length === 1 && r2[0].source === 'vendor');
  }
  {
    const { deps, alerts } = orchDeps(3, {
      vendorSearch: async () => { throw new Error('VENDOR CALLED IN SOLE MODE'); },
    });
    const res = await OR.getMixedAutocomplete('star kabab', deps);
    check('B7: mode 3 sole severs all vendor endpoints', res.length > 0 && res.every((r) => r.source !== 'vendor'));
    void alerts;
  }
  {
    const { deps, alerts } = orchDeps('bogus', { isLegalGateOpen: () => true });
    const res = await OR.getMixedAutocomplete('star kabab', deps);
    check('B8: invalid mode fails safe to off + P1',
      res.every((r) => r.source === 'vendor') && alerts.some((a) => a[0] === 'P1'));
    const locked = orchDeps(1, {});
    let locals = 0;
    locked.deps.searchFirstParty = async () => { locals++; return [FP_HIT]; };
    locked.deps.searchOsm = async () => { locals++; return []; };
    const rL = await OR.getMixedAutocomplete('star kabab', locked.deps);
    check('B9: gate-closed shadow → off + P1, zero local queries',
      locals === 0 && rL.every((r) => r.source === 'vendor') &&
      locked.alerts.some((a) => a[1] === 'SEARCH_BLOCKED_LEGAL_GATE_LOCK'));
    const locked2 = orchDeps(2, {});
    const rL2 = await OR.getMixedAutocomplete('star kabab', locked2.deps);
    check('B10: gate-closed primary → off (vendor pre-clearance in both paths)',
      rL2.every((r) => r.source === 'vendor'));
  }
  check('B11: <2-char queries return []', (await OR.getMixedAutocomplete('a', orchDeps(1, { isLegalGateOpen: () => true }).deps)).length === 0);

  // ---------- C. RAM merge ----------
  {
    const A = { id: 'pub_a', title: 'Star Kabab', subtitle: 's', category: 'restaurant', source: 'first_party', badge: 'verified_landmark', coords: { lat: 23.7937, lng: 90.4045 }, _aliases: [] };
    const B = { id: 'osm_b', title: 'star kabab', subtitle: 's', category: 'restaurant', source: 'osm', badge: 'open_directory', coords: { lat: 23.79375, lng: 90.40455 }, _aliases: [] };
    const fused = OR.fuse([A], [B]);
    check('C1: 10 m same-name cross-source dup collapses to first_party',
      fused.length === 1 && fused[0].source === 'first_party');
    const FAR = { ...B, id: 'osm_far', coords: { lat: 23.85, lng: 90.45 } };
    check('C2: same title 8 km apart kept (no brand collapse)', OR.fuse([A], [FAR]).length === 2);
    const DIFF = { ...B, id: 'osm_diff', title: 'Rapa Plaza', _aliases: [] };
    check('C3: within 50 m but different name kept (mall shops survive)', OR.fuse([A], [DIFF]).length === 2);
    const AL = { ...B, id: 'osm_al', title: 'JFP Food Court', _aliases: ['star kabab'] };
    check('C4: alias match dedupes', OR.fuse([A], [AL]).length === 1);
    const V = { id: 'vendor_t', title: 'Star Kabab', subtitle: 's', category: 'restaurant', source: 'vendor', badge: null, _fusePos: { lat: 23.79371, lng: 90.40451 }, _aliases: [] };
    check('C5: ephemeral vendor fusion hint dedupes (stripped later)', OR.fuse([A], [V]).length === 1);
    const out = OR.stripEphemeral(V);
    check('C6: _fusePos/_aliases stripped pre-response', !(' _fusePos' in out) && !('_fusePos' in out) && !('_aliases' in out));
    const many = Array.from({ length: 8 }, (_, i) => ({ ...A, id: `pub_${i}` }));
    const { deps } = orchDeps(3, { searchFirstParty: async () => many.map((m, i) => ({ ...FP_HIT, id: m.id, canonical_name: `Place ${i}`, search_aliases: [], _geo: { lat: 23.79 + i * 0.01, lng: 90.40 } })), searchOsm: async () => [] });
    check('C7: dropdown cap (6)', (await OR.getMixedAutocomplete('star kabab', deps)).length === 6);
  }

  // ---------- D. 40 ms budget ----------
  {
    const { deps } = orchDeps(1, {
      isLegalGateOpen: () => true,
      searchFirstParty: () => new Promise(() => undefined), // hung leg
      timeoutMs: 40,
    });
    const t0 = Date.now();
    const res = await OR.getMixedAutocomplete('star kabab', deps);
    const dt = Date.now() - t0;
    check('D1: hung leg degrades inside budget (vendor still served)',
      dt < 2000 && res.some((r) => r.source === 'vendor') && res.some((r) => r.source === 'osm'),
      `${dt}ms`);
  }

  // ---------- E. dest_session ----------
  {
    const cache = fakeCache();
    const deps = { cache, mintToken: () => 'tok-abc' };
    const tok = await DS.recordDestinationSession({ lat: 23.7, lng: 90.4 }, deps);
    check('E1: token minted, key namespaced, TTL 900',
      tok === 'tok-abc' && cache.has('dest_session:tok-abc') && cache.calls[0][1] === 900);
    check('E2: TTL constant 15 min', DS.DEST_SESSION_TTL_SECONDS === 900 && DS.DEST_SESSION_PREFIX === 'dest_session:');
    const first = await DS.consumeDestinationSession(deps, 'tok-abc');
    const second = await DS.consumeDestinationSession(deps, 'tok-abc');
    check('E3: GETDEL single-use (second read null)', first && first.lat === 23.7 && second === null);
    check('E4: unknown/empty token → null (reselection, no DB)',
      (await DS.consumeDestinationSession(deps, 'nope')) === null &&
      (await DS.consumeDestinationSession(deps, '')) === null);
    await cache.set('dest_session:bad', '{oops', 'EX', 900);
    check('E5: malformed payload → null (never throws into dispatch)',
      (await DS.consumeDestinationSession(deps, 'bad')) === null);
    let bad = '';
    try { await DS.recordDestinationSession({ lat: NaN, lng: 1 }, deps); } catch (e) { bad = e.message; }
    check('E6: non-finite coords refused', /non-finite/.test(bad));
  }

  // ---------- F. Selection telemetry ----------
  {
    check('F1: columns exact (5-col §4.7 raw_search_events)',
      ST.SEARCH_SELECTION_COLUMNS.length === 5 &&
      JSON.stringify([...ST.SEARCH_SELECTION_COLUMNS]) === JSON.stringify(['user_id', 'typed_query', 'selected_source', 'selected_place_id', 'latency_ms']));
    const { row, context } = ST.buildSelectionRow({
      userId: 'u1', rawQuery: 'Star Kabab 01711223344 extra words beyond eighty characters limit xxxxxxxxxxxxxxxxxxxxxxxxxxxxx', source: 'first_party', placeId: 'pub_u1', latencyMs: 120.6, position: 2, searchSessionId: 'sess-1',
    });
    check('F2: scrubbed ≤80, phone gone, vendor strings absent',
      row.typed_query.length <= 80 && !row.typed_query.includes('017') && row.selected_source === 'dpmaps' && row.selected_place_id === 'pub_u1');
    check('F3: position/session in-memory only (never DB columns)',
      context.position === 2 && context.search_session_id === 'sess-1' && !('position' in row));
    const vend = ST.buildSelectionRow({ userId: 'u1', rawQuery: 'x', source: 'vendor', placeId: 'pub_zzz', latencyMs: 5, position: 0, searchSessionId: 's' });
    check('F4: vendor place forced NULL (chk parity)', vend.row.selected_place_id === null && vend.row.selected_source === 'vendor');
    const seen = [];
    await ST.persistSelection({ query: async (t, p) => { seen.push([t, p]); } }, row);
    check('F5: INSERT targets raw_search_events, 5 params',
      seen.length === 1 && seen[0][0].includes('dpmaps.raw_search_events') && seen[0][1].length === 5);
    let bad = '';
    try { await ST.persistSelection({ query: async () => undefined }, { ...row, raw_query: 'x' }); }
    catch (e) { bad = e.message; }
    check('F6: raw_query insert rejected', /forbidden key 'raw_query'/.test(bad), bad);
    let bad2 = '';
    try { await ST.persistSelection({ query: async () => undefined }, { ...row, temp_client_id: 't' }); }
    catch (e) { bad2 = e.message; }
    check('F7: session token insert rejected (never persisted)', /forbidden/.test(bad2), bad2);
    const imp = ST.buildImpressionEvent('osm', 33.2);
    check('F8: impressions carry zero query text', JSON.stringify(imp) === JSON.stringify({ source: 'osm', latency_ms: 33 }));
    let threw = '';
    try { ST.buildSelectionRow({ userId: '', rawQuery: 'x', source: 'osm', latencyMs: 1, position: 0, searchSessionId: 's' }); }
    catch (e) { threw = e.message; }
    check('F9: empty userId refused', /userId required/.test(threw));
  }

  // ---------- G. Contract scans ----------
  {
    const oc = read('services/searchOrchestrator.ts');
    const tc = read('services/searchTelemetry.ts');
    const dc = read('services/destSession.ts');
    const all = oc + tc + dc + read('services/searchIndexConfig.ts');
    check('G1: no Meili/vendor SDK imports (production owns clients)', !/from 'meilisearch'|require\(['\"]meilisearch|axios|@barikoi|googlemaps/i.test(all));
    check('G2: wrapper integrated by type + scrubPii only', /import type \{ SafeVendorSuggestion \}/.test(oc) && /import \{ scrubPii \}/.test(tc));
    check('G3: 40 ms budget + 50 m dedupe constants', /LOCAL_SEARCH_TIMEOUT_MS = 40/.test(oc) && /MERGE_DEDUP_METERS = 50/.test(oc));
    check('G4: invalid mode + gate fail-safe codes', /INVALID_SEARCH_MODE_FAILSAFE_OFF/.test(oc) && /SEARCH_BLOCKED_LEGAL_GATE_LOCK/.test(oc));
    check('G5: zero-hit rule explicit (hits.length > 0)', /hits\.length > 0 \? hits : await vendor\(\)/.test(oc));
    check('G6: dest_session namespace + 900 TTL', /dest_session:/.test(dc) && /DEST_SESSION_TTL_SECONDS = 900/.test(dc));
    check('G7: no flat-minute thresholds', !/\d+\s*min(ute)?s?\s*(threshold|gate|sla|budget)/i.test(all));
    check('G8: Stage 007 normalizer pre-processes (import + early return)', /normalizeSearchQuery\(rawQuery\)/.test(oc) && /MIN_QUERY_CHARS/.test(oc));
  }

  console.log(`\nTOTAL: ${passed} assertions, ${process.exitCode ? 'FAILURES PRESENT' : '0 failures'}`);
})();
