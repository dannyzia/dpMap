#!/usr/bin/env node
/**
 * normalization_audit.test.js — Stage 007 linguistic-core audit.
 * Zero test dependencies. Run: node tests/stage-007/normalization_audit.test.js
 *
 * The real TypeScript sources are transpiled with the repo-pinned tsc and
 * executed behaviorally — no mirrors. (Stage 004/005 pattern; node-shim.d.ts
 * covers the host's missing @types/node for node:crypto + setImmediate.)
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage007-'));
const N_PATH = path.join(tmp, 'utils-server', 'textNormalizer.js');
const L_PATH = path.join(tmp, 'utils-server', 'entityLocker.js');
const P_PATH = path.join(tmp, 'utils-server', 'bengaliPhonetics.js');
const C_PATH = path.join(tmp, 'services', 'aliasClusterer.js');
const W_PATH = path.join(tmp, 'utils-server', 'vendorClientWrapper.js');
let transpiled = false;
try {
  execFileSync(
    TSC,
    [
      '--module', 'commonjs', '--target', 'es2020', '--strict', 'false',
      '--rootDir', REPO, '--outDir', tmp,
      path.join(REPO, 'utils-server', 'textNormalizer.ts'),
      path.join(REPO, 'utils-server', 'entityLocker.ts'),
      path.join(REPO, 'utils-server', 'bengaliPhonetics.ts'),
      path.join(REPO, 'services', 'aliasClusterer.ts'),
      path.join(REPO, 'utils-server', 'vendorClientWrapper.ts'),
      path.join(REPO, 'tests', 'stage-005', 'node-shim.d.ts'),
    ],
    { stdio: 'pipe' },
  );
  transpiled = [N_PATH, L_PATH, P_PATH, C_PATH, W_PATH].every(fs.existsSync);
} catch (e) {
  console.error(`[FAIL] TS transpile: ${(e.stderr || e.message || '').toString().slice(0, 2000)}`);
}
check('T1: TS sources transpile clean (real code, no mirrors)', transpiled);
if (!transpiled) {
  console.error('FATAL: cannot behaviorally verify TS without transpiled output');
  process.exit(2);
}
const N = require(N_PATH);
const L = require(L_PATH);
const P = require(P_PATH);
const C = require(C_PATH);
const W = require(W_PATH);

// ---------- A. scrubPii runs FIRST (F-007-4, Hard Rule 8) ----------
{
  check('A1: Bengali-digit phone with delimiters dropped',
    W.scrubPii('Star Kabab ০১৭-১১২২-৩৩৪৪').indexOf('017') === -1 &&
    W.scrubPii('Star Kabab ০১৭-১১২২-৩৩৪৪').indexOf('০১৭') === -1);
  check('A2: +880 phone dropped', W.scrubPii('NSU +8801711223344 gate').indexOf('88017') === -1);
  check('A3: email dropped, place text kept',
    (() => { const s = W.scrubPii('Rapa Plaza foo@bar.com mor'); return s.indexOf('@') === -1 && s.indexOf('Rapa') !== -1; })());
  check('A4: road 12 34 untouched', W.scrubPii('road 12 34').indexOf('12') !== -1);
  const once = W.scrubPii('Dhanmondi 27 01711223344');
  check('A5: idempotent + no shared marker token',
    W.scrubPii(once) === once && once.toLowerCase().indexOf('redact') === -1 && once.indexOf('XXX') === -1);
  const out = N.normalizeSearchQuery('JFP 01711223344');
  check('A6: normalizer scrubs before clustering (phone absent downstream)',
    out.scrubbed_query.indexOf('017') === -1 && out.normalized_query.indexOf('017') === -1 &&
    out.bengali_phonetic_key.indexOf('017') === -1);
}

// ---------- B. Six-stage normalizer ----------
{
  const n = (q) => N.normalizeSearchQuery(q);
  check('B1: NFC composes Nukta pairs (ড+◌় → ড়)',
    n('ড\u09BCaka').normalized_query.indexOf('ড়') !== -1);
  check('B2: ZWJ/ZWNJ stripped', n('a\u200Db\u200Cc').normalized_query === 'abc');
  check('B3: Dari stripped', n('ধানমন্ডি। ২৭').normalized_query.indexOf('।') === -1);
  check('B4: Ta+Hasant → Khanda-Ta (ত্ → ৎ)', n('ত্').normalized_query === 'ৎ');
  check('B5: Chandrabindu folded', n('চাঁদ').normalized_query.indexOf('ঁ') === -1);
  check('B6: Bengali digits folded', n('ধানমন্ডি ২৭').normalized_tokens.includes('27'));
  check('B7: elongation 3+ → 1 (jammmuuuna → jamuna)', n('jammmuuuna').normalized_query === 'jamuna');
  check('B8: genuine doubles preserved', /(^|\s)ss(\s|$)/.test(` ${n('Hasssan class').normalized_query} `) || n('pass').normalized_query.indexOf('ss') !== -1);
  check('B9: casefold + punctuation', n('Dhanmondi, Road-27!').normalized_query === 'dhanmondi road 27');
  check('B10: Dhaka abbreviations (jfp/nsu/du)',
    n('JFP').normalized_query === 'jamuna future park' &&
    n('NSU Gate 8').normalized_query === 'north south university gate 8' &&
    n('DU').normalized_query === 'dhaka university');
  check('B11: versions embedded', n('Banani').normalizer_version === 'norm-v2.1.0' && n('Banani').ruleset_version === 'rule-2026.11');
  check('B12: 80-char bound', n('x'.repeat(200)).raw_query.length === 80);
  check('B13: cluster_id format cl_<16hex>',
    /^cl_[0-9a-f]{16}$/.test(n('Star Kabab Banani').cluster_id));
  check('B14: deterministic + version-pinned',
    n('Banani 11').cluster_id === n('Banani 11').cluster_id);
}

// ---------- C. Ordered entity locking (F-007-2) ----------
{
  const n = (q) => N.normalizeSearchQuery(q);
  const sig = (q) => n(q).structured_entities.map((e) => `${e.headword}:${e.value}`).join(',');
  check('C1: road 4 vs road 7 never merge', n('Road 4').cluster_id !== n('Road 7').cluster_id);
  check('C2: ordered pairs — gate 1 road 2 vs road 1 gate 2 never merge',
    sig('Gate 1 Road 2') === 'gate:1,road:2' && sig('Road 1 Gate 2') === 'road:1,gate:2' &&
    n('Gate 1 Road 2').cluster_id !== n('Road 1 Gate 2').cluster_id);
  check('C3: encounter order kept (sector 3 road 11)', sig('Road 11 Sector 3') === 'road:11,sector:3');
  check('C4: Purbo vs Poshchim Badda never merge',
    n('Purbo Badda').cluster_id !== n('Poshchim Badda').cluster_id);
  check('C5: directions bound to anchors (badda:east vs badda:west)',
    JSON.stringify(n('Purbo Badda').bound_directions) === JSON.stringify([{ anchor: 'badda', direction: 'east' }]) &&
    JSON.stringify(n('Poshchim Badda').bound_directions) === JSON.stringify([{ anchor: 'badda', direction: 'west' }]));
  check('C6: word-order variants MERGE (Star Kabab Banani ↔ Banani Star Kabab)',
    n('Star Kabab Banani').cluster_id === n('Banani Star Kabab').cluster_id);
  check('C7: sameEntityIdentity ordered (unit)',
    L.sameEntityIdentity(
      { structuredEntities: [{ headword: 'road', value: '1' }], boundDirections: [] },
      { structuredEntities: [{ headword: 'road', value: '1' }], boundDirections: [] },
    ) && !L.sameEntityIdentity(
      { structuredEntities: [{ headword: 'road', value: '1' }], boundDirections: [] },
      { structuredEntities: [{ headword: 'road', value: '2' }], boundDirections: [] },
    ));
}

// ---------- D. Phonetic engine (F-007-3) ----------
{
  check('D1: Dhanmondi ↔ ধানমন্ডি → DNMND',
    P.generateBengaliPhoneticKey(['dhanmondi']) === 'DNMND' &&
    P.generateBengaliPhoneticKey(['ধানমন্ডি']) === 'DNMND');
  check('D2: cross-script cluster merge (dhanmondi 27 ↔ ধানমন্ডি ২৭)',
    N.normalizeSearchQuery('dhanmondi 27').cluster_id ===
    N.normalizeSearchQuery('ধানমন্ডি ২৭').cluster_id);
  check('D3: aspiration folding (ph→P, th→T)', P.generateBengaliPhoneticKey(['pharmgate']) === P.generateBengaliPhoneticKey(['farmgate']));
  check('D4: key length ≤ 120', N.normalizeSearchQuery('a '.repeat(40)).bengali_phonetic_key.length <= 120);
  check('D5: digits skipped in key (ride in entities)',
    P.generateBengaliPhoneticKey(['road', '27']) === P.generateBengaliPhoneticKey(['road']));
  check('D6: live initial-vowel marker (agargaon → AGRGN)',
    P.generateBengaliPhoneticKey(['agargaon']) === 'AGRGN');
  check('D6b: plan-code repair documented in source (see STAGE REPORT)',
    /firstVowelRetained/.test(read('utils-server/bengaliPhonetics.ts')));
}

// ---------- E. Spatial convergence + anti-merging (§5–§6) ----------
{
  // Fake gridDisk with real semantics: 7-cell ring containing the center.
  const disk = (cell) => [cell, `${cell}+1`, `${cell}+2`, `${cell}+3`, `${cell}+4`, `${cell}+5`, `${cell}+6`];
  const banani = { dropoff_lat: 23.7937, dropoff_lng: 90.4045, h3_res10: 'cellA' };
  const bananiGate = { lat: 23.7938, dropoff_lng: 0, lng: 90.4046, h3_res10: 'cellA+1' };
  const dhanmondi = { lat: 23.7461, lng: 90.3928, h3_res10: 'cellZ' };
  const T = (q) => {
    const o = N.normalizeSearchQuery(q);
    return { raw_query: o.raw_query, normalized_query: o.normalized_query, bengali_phonetic_key: o.bengali_phonetic_key, cluster_id: o.cluster_id };
  };
  const star = T('Star Kabab');
  check('E1: same branch converges (≤75 m + ring + text)',
    C.shouldCluster(star, banani, star, { lat: 23.7937, lng: 90.4045, h3_res10: 'cellA' }, disk) === true);
  check('E2: identical brand 6 km away stays separate (Star Kabab Banani vs Dhanmondi)',
    C.shouldCluster(star, banani, star, dhanmondi, disk) === false);
  check('E3: cross-boundary ring overlap accepted (neighbor cell in disk)',
    C.validateSpatialConvergence(banani, bananiGate, (c) => [c, 'cellA', 'x', 'y', 'z', 'w', 'v']) === true);
  check('E4: short prefixes never cluster (raw ≤4 chars, pre-expansion)',
    C.isShortPrefix('jfp') === true && C.isShortPrefix('jamuna future park') === false &&
    C.shouldCluster(T('JFP'), banani, T('JFP'), { lat: 23.7937, lng: 90.4045, h3_res10: 'cellA' }, disk) === false);
  // Non-transitivity: A~B and B~C pass spatially, A~C fails on distance.
  const mid = { dropoff_lat: 23.7937, dropoff_lng: 90.4052, h3_res10: 'cellA+2' }; // ~72 m east
  const far = { lat: 23.7937, lng: 90.4059, h3_res10: 'cellA+3' }; // ~143 m east of A, ~72 m east of mid
  const txt = T('Aarong Banani');
  const ab = C.shouldCluster(txt, banani, txt, { lat: 23.7937, lng: 90.4052, h3_res10: 'cellA+2' }, (c) => [c, 'cellA', 'cellA+2', 'x', 'y', 'z', 'w']);
  const bc = C.shouldCluster(txt, mid, txt, far, (c) => [c, 'cellA+2', 'cellA+3', 'x', 'y', 'z', 'w']);
  const ac = C.shouldCluster(txt, banani, txt, far, disk);
  check('E5: no transitive clustering (A~B, B~C pass; A~C fails)', ab === true && bc === true && ac === false,
    `ab=${ab} bc=${bc} ac=${ac}`);
  check('E6: headword digits lock (road 27 vs road 28 diverge; trigram still passes)',
    C.textGatePass(T('road 27'), T('road 28')) === true &&
    N.normalizeSearchQuery('road 27').cluster_id !== N.normalizeSearchQuery('road 28').cluster_id);
  check('E7: constants (75 m / 0.70 / 4-char)',
    C.SPATIAL_MAX_DISTANCE_M === 75 && C.TRIGRAM_THRESHOLD === 0.70 && C.SHORT_PREFIX_MAX_LEN === 4);
}

// ---------- F. Promotion SQL contract (§7) ----------
{
  const sql = C.ALIAS_PROMOTION_SQL;
  check('F1: anchor dedup join', /JOIN dpmaps\.active_dedup_key adk ON lp\.key_id = adk\.key_id/.test(sql));
  check('F2: decay at read', /calculate_decayed_weight\(tel\.initial_weight, tel\.created_at\)/.test(sql));
  check('F3: invalidations excluded', /li\.ledger_id IS NULL/.test(sql));
  check('F4: privacy gate (phone + email)', /01\[3-9\]\[0-9\]\{8\}/.test(sql) && /!~ '@'/.test(sql));
  check('F5: uq_poi_alias conflict target', /ON CONFLICT \(poi_id, alias_text\)/.test(sql));
  check('F6: zero trip_id / trip_hash columns', !/trip_id|trip_hash/.test(sql));
  check('F7: distinct pseudonym_hash (no multi-key double count)', /COUNT\(DISTINCT lp\.pseudonym_hash\)/.test(sql));
}

// ---------- G. Cross-cutting contract scans ----------
{
  const tn = read('utils-server/textNormalizer.ts');
  const ph = read('utils-server/bengaliPhonetics.ts');
  const el = read('utils-server/entityLocker.ts');
  const ac = read('services/aliasClusterer.ts');
  check('G1: scrubPii imported from Stage 002 wrapper (not reimplemented)',
    /import \{ scrubPii \} from '\.\/vendorClientWrapper'/.test(tn) &&
    !/function scrubPii/.test(tn));
  check('G2: no Western phonetics implementations', !/soundex\s*\(|metaphone\s*\(|new\s+Soundex/i.test(ph + tn + el));
  check('G3: zero vendor SDK imports (node:crypto stdlib import only)',
    !/axios|@barikoi|googlemaps/i.test(tn + ph + el + ac) && /from 'node:crypto'/.test(tn));
  check('G4: phonetic key bound ≤ 120', /PHONETIC_KEY_MAX_LEN = 120/.test(ph) && /\.slice\(0, PHONETIC_KEY_MAX_LEN\)/.test(ph));
  check('G5: versions pinned (norm-v2.1.0 / rule-2026.11)',
    /norm-v2\.1\.0/.test(tn) && /rule-2026\.11/.test(tn));
  check('G6: elongation semantics 3+ → 1', tn.includes('(.)\\1{2,}'));
  check('G7: ordered extraction (i+1 lookahead, i-1 anchor)',
    /tokens\[i \+ 1\]/.test(el) && /tokens\[i - 1\]/.test(el));
  check('G8: h3 gridDisk injected, never imported', /GridDiskFn/.test(ac) && !/from 'h3-js'|require\(['\"]h3/.test(ac));
}

console.log(`\nTOTAL: ${passed} assertions, ${process.exitCode ? 'FAILURES PRESENT' : '0 failures'}`);
