#!/usr/bin/env node
/**
 * bengali_shaping_audit.test.js — Stage 006 Phase-0 gate (DPM-R-008).
 * Zero dependencies. Run: node tests/stage-006/bengali_shaping_audit.test.js
 *
 * Verifies:
 *  A. Coverage: every stack (Regular/Medium/Bold) ships 0-255.pbf and
 *     2304-2559.pbf; every ASSIGNED Bengali codepoint under test renders a
 *     non-empty SDF bitmap (tofu gate, plan §3.1 step 1).
 *  B. Ligature readiness: every component codepoint needed to shape the
 *     reference strings (conjuncts যুক্তক্ষর, matra placement, digits, ৳)
 *     is present — "বিশ্ববিদ্যালয়", "ঢাকা", "মতিঝিল", "ফার্মগেট",
 *     "প্রেসক্লাব", "ক্ষ", "জ্ঞ", "০-৯ ৳ ধানমন্ডি".
 *  C. Fontstack conformance (F-006-4): every `text-font` stack referenced by
 *     any committed style.json resolves to a generated stack directory.
 *  D. Hard Rule 7: zero commercial raster endpoints (Mapbox/Google/Esri/Bing/
 *     Barikoi) in the Pin Tool or any committed style config.
 *
 * SCOPE NOTE (DPM-R-008, Open): headless presence is necessary but NOT
 * sufficient for Indic shaping. Correct conjunct formation (ক্ষ as one cluster,
 * not ক + ্ + ষ) and matra reordering depend on the client HarfBuzz shaper.
 * SDF PBFs carry no shaping logic. The device-level gate — render the
 * reference strings on Android/iOS maplibre-native side-by-side with a native
 * TextView and confirm cluster formation — REMAINS MANUAL (see checklist at
 * the end of this run). This test asserts everything assertable headlessly.
 *
 * Range-name note: MapLibre requests 256-aligned ranges, so U+0980–U+09FF is
 * served by `2304-2559.pbf` (plan §3.1). A file named `2432-2687.pbf` would
 * never be requested; its absence here is correct, not a gap.
 */

'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const FONTS_DIR = path.join(REPO, 'docs', 'resources', 'fonts');
const STACKS = [
  'Noto Sans Bengali Regular',
  'Noto Sans Bengali Medium',
  'Noto Sans Bengali Bold',
];

// --- Minimal protobuf reader for the Mapbox glyph PBF schema ---
// Top-level: { 1: Fontstack{name f1, range f2, glyphs f3[] {...}} }
// Glyph:     { 1: id varint, 2: bitmap bytes, 3: width, 4: height,
//              5: left sint?, 6: top sint?, 7: advance }
function Reader(buf) {
  this.b = buf;
  this.pos = 0;
}
Reader.prototype.varint = function () {
  let shift = 0n;
  let out = 0n;
  for (;;) {
    const c = this.b[this.pos++];
    out |= BigInt(c & 0x7f) << shift;
    shift += 7n;
    if (!(c & 0x80)) break;
  }
  return Number(out);
};
Reader.prototype.skip = function (w) {
  if (w === 0) this.varint();
  else if (w === 1) this.pos += 8;
  else if (w === 2) this.pos += this.varint();
  else if (w === 5) this.pos += 4;
  else throw new Error(`unsupported wire type ${w}`);
};

function parseGlyphPbf(file) {
  const b = fs.readFileSync(file);
  const top = new Reader(b);
  let stackBuf = null;
  while (top.pos < b.length) {
    const t = top.varint();
    const f = t >>> 3;
    const w = t & 7;
    if (f === 1 && w === 2) {
      const l = top.varint();
      stackBuf = b.slice(top.pos, top.pos + l);
      top.pos += l;
    } else top.skip(w);
  }
  assert(stackBuf, `${file}: missing embedded Fontstack`);
  const r = new Reader(stackBuf);
  const glyphs = [];
  let sname = '';
  let srange = '';
  while (r.pos < stackBuf.length) {
    const t = r.varint();
    const f = t >>> 3;
    const w = t & 7;
    if (f === 1 && w === 2) {
      const l = r.varint();
      sname = stackBuf.slice(r.pos, r.pos + l).toString();
      r.pos += l;
    } else if (f === 2 && w === 2) {
      const l = r.varint();
      srange = stackBuf.slice(r.pos, r.pos + l).toString();
      r.pos += l;
    } else if (f === 3 && w === 2) {
      const l = r.varint();
      const end = r.pos + l;
      let id = null;
      let bm = 0;
      while (r.pos < end) {
        const t2 = r.varint();
        const f2 = t2 >>> 3;
        const w2 = t2 & 7;
        if (f2 === 1 && w2 === 0) id = r.varint();
        else if (f2 === 2 && w2 === 2) {
          bm = r.varint();
          r.pos += bm;
        } else r.skip(w2);
      }
      glyphs.push({ id, bm });
    } else r.skip(w);
  }
  return { name: sname, range: srange, glyphs };
}

const hex = (c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;

// Every ASSIGNED Bengali codepoint the audit requires (vowels, consonants,
// nukta/avagraha, matras, virama, khanda-ta, au-length mark, ড় ঢ় য়,
// Assamese ৰ ৱ, digits ০-৯, taka ৳). Unassigned slots (U+0980, U+0984,
// U+098D–U+098E, U+0991–U+0992, U+09A9, U+09B1, …) are excluded by design:
// fontnik only emits cmap-covered codepoints, and MapLibre falls back across
// fontstacks for the rest.
const REQUIRED_BENGALI = [
  0x981, 0x982, 0x983, 0x985, 0x986, 0x987, 0x988, 0x989, 0x98a, 0x98b, 0x98c,
  0x98f, 0x990, 0x993, 0x994, 0x995, 0x996, 0x997, 0x998, 0x999, 0x99a, 0x99b,
  0x99c, 0x99d, 0x99e, 0x99f, 0x9a0, 0x9a1, 0x9a2, 0x9a3, 0x9a4, 0x9a5, 0x9a6,
  0x9a7, 0x9a8, 0x9aa, 0x9ab, 0x9ac, 0x9ad, 0x9ae, 0x9af, 0x9b0, 0x9b2, 0x9b6,
  0x9b7, 0x9b8, 0x9b9, 0x9bc, 0x9bd, 0x9be, 0x9bf, 0x9c0, 0x9c1, 0x9c2, 0x9c3,
  0x9c4, 0x9c7, 0x9c8, 0x9cb, 0x9cc, 0x9cd, 0x9ce, 0x9d7, 0x9dc, 0x9dd, 0x9df,
  0x9e6, 0x9e7, 0x9e8, 0x9e9, 0x9ea, 0x9eb, 0x9ec, 0x9ed, 0x9ee, 0x9ef, 0x9f0,
  0x9f1, 0x9f3,
];

// Reference shaping strings (plan §3.1 + order scope). Each entry lists the
// string and its component codepoints; the audit asserts component presence.
// Cluster FORMATION itself is the manual device gate (see scope note).
const SHAPING_STRINGS = [
  { s: 'ক্ষ', cps: [0x995, 0x9cd, 0x9b7] },
  { s: 'জ্ঞ', cps: [0x99c, 0x9cd, 0x99e] },
  { s: 'বিশ্ববিদ্যালয়', cps: [0x9ac, 0x9bf, 0x9b6, 0x9cd, 0x9ac, 0x9ac, 0x9bf, 0x9a6, 0x9cd, 0x9af, 0x9be, 0x9b2, 0x9df] },
  { s: 'ঢাকা', cps: [0x9a2, 0x9be, 0x995, 0x9be] },
  { s: 'মতিঝিল', cps: [0x9ae, 0x9a4, 0x9bf, 0x99d, 0x9bf, 0x9b2] },
  { s: 'ফার্মগেট', cps: [0x9ab, 0x9be, 0x9b0, 0x9cd, 0x9ae, 0x997, 0x9c7, 0x99f] },
  { s: 'প্রেসক্লাব', cps: [0x9aa, 0x9cd, 0x9b0, 0x9c7, 0x9b8, 0x995, 0x9cd, 0x9b2, 0x9be, 0x9ac] },
  { s: 'ধানমন্ডি', cps: [0x9a7, 0x9be, 0x9a8, 0x9ae, 0x9a3, 0x9cd, 0x9a1, 0x9bf] },
  { s: '০-৯ ৳', cps: [0x9e6, 0x9e7, 0x9e8, 0x9e9, 0x9ea, 0x9eb, 0x9ec, 0x9ed, 0x9ee, 0x9ef, 0x9f3] },
];

// Basic Latin needed for road abbreviations / mixed labels (plan §3).
const REQUIRED_LATIN = [];
for (let c = 0x41; c <= 0x5a; c++) REQUIRED_LATIN.push(c); // A-Z
for (let c = 0x61; c <= 0x7a; c++) REQUIRED_LATIN.push(c); // a-z
for (let c = 0x30; c <= 0x39; c++) REQUIRED_LATIN.push(c); // 0-9
REQUIRED_LATIN.push(0x20, 0x2d, 0x2e); // space, hyphen, period

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

// ---------- A/B: per-stack coverage + shaping-component presence ----------
for (const stack of STACKS) {
  const dir = path.join(FONTS_DIR, stack);
  check(`A0: stack dir exists — ${stack}`, fs.existsSync(dir));
  if (!fs.existsSync(dir)) continue;

  for (const range of ['0-255', '2304-2559']) {
    const file = path.join(dir, `${range}.pbf`);
    const st = fs.existsSync(file) ? fs.statSync(file) : null;
    check(`A1: ${stack}/${range}.pbf exists and non-empty`, !!st && st.size > 0, st ? `${st.size} bytes` : 'missing');
    if (!st || st.size === 0) continue;
    const parsed = parseGlyphPbf(file);
    // Composite ranges carry fontnik's comma-joined provenance name
    // (e.g. "Noto Sans Bengali Regular, Noto Sans Regular") — the MapLibre
    // request URL (directory name) is authoritative, as in openmaptiles/fonts.
    const nameOk =
      range === '0-255'
        ? parsed.name.split(', ').includes(stack)
        : parsed.name === stack;
    check(`A2: ${stack}/${range}.pbf stack name matches dir`, nameOk, `got ${JSON.stringify(parsed.name)}`);
    check(`A3: ${stack}/${range}.pbf range tag matches file`, parsed.range === range, `got ${JSON.stringify(parsed.range)}`);
    check(`A4: ${stack}/${range}.pbf parses with glyphs`, parsed.glyphs.length > 0, `got ${parsed.glyphs.length}`);
    const byId = new Map(parsed.glyphs.map((g) => [g.id, g]));
    const required = range === '2304-2559' ? REQUIRED_BENGALI : REQUIRED_LATIN;
    const missing = required.filter((c) => !byId.has(c));
    check(
      `A5: ${stack}/${range}.pbf covers all ${required.length} required codepoints`,
      missing.length === 0,
      missing.length ? `missing ${missing.map(hex).join(' ')}` : `${parsed.glyphs.length} glyphs total`,
    );
    // Whitespace/control codepoints legitimately carry empty SDF bitmaps
    // (advance width only, no ink): NUL, CR, SPACE, NBSP.
    const INKLESS_OK = new Set([0x00, 0x0d, 0x20, 0xa0]);
    const empty = parsed.glyphs.filter((g) => g.bm === 0 && !INKLESS_OK.has(g.id));
    check(`A6: ${stack}/${range}.pbf has zero empty ink bitmaps`, empty.length === 0, empty.length ? `empty: ${empty.map((g) => hex(g.id)).join(' ')}` : '');
  }

  // B: shaping-string component coverage against the Bengali range.
  const bn = parseGlyphPbf(path.join(dir, '2304-2559.pbf'));
  const ids = new Set(bn.glyphs.map((g) => g.id));
  for (const { s, cps } of SHAPING_STRINGS) {
    const missing = [...new Set(cps)].filter((c) => !ids.has(c));
    check(`B: "${s}" components present in ${stack}`, missing.length === 0, missing.length ? `missing ${missing.map(hex).join(' ')}` : '');
  }
}

// ---------- C: fontstack conformance (F-006-4) ----------
// Any committed style.json's text-font stacks must all be generated stacks.
function* walkJson(dirPath) {
  const skip = new Set(['node_modules', '.git', '.freebuff', '.agents', '.kilo']);
  for (const e of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (e.name === 'fonts' && dirPath.endsWith('resources')) continue; // PBFs aren't JSON
    const p = path.join(dirPath, e.name);
    if (e.isDirectory()) {
      if (!skip.has(e.name)) yield* walkJson(p);
    } else if (e.name.endsWith('.json')) yield p;
  }
}
const generated = new Set(STACKS);
let styleFiles = 0;
for (const f of walkJson(REPO)) {
  let raw;
  try {
    raw = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (!raw.includes('text-font')) continue;
  styleFiles++;
  let stacks = [];
  try {
    const re = /"text-font"\s*:\s*(\[[^\]]*\])/g;
    let m;
    while ((m = re.exec(raw))) stacks.push(...JSON.parse(m[1]));
  } catch {
    check(`C: ${path.relative(REPO, f)} text-font parses`, false);
    continue;
  }
  const unknown = [...new Set(stacks)].filter((s) => !generated.has(s));
  check(
    `C: ${path.relative(REPO, f)} text-font stacks all generated`,
    unknown.length === 0,
    unknown.length ? `unknown: ${unknown.join(', ')}` : `${stacks.length} refs ok`,
  );
}
console.log(`[INFO] style.json files with text-font scanned: ${styleFiles} (plan §7 canonical style ships with the mobile client; none committed yet)`);

// ---------- D: Hard Rule 7 — zero commercial raster endpoints ----------
// Bare vendor-name mentions in clean-room PROHIBITION comments ("No Esri…")
// are compliant documentation, not violations. What is banned is an actual
// tile/API endpoint, so this check extracts URL-like strings and tile-layer
// arguments and matches those against commercial domains.
const RASTER_URL_BANNED = [
  /arcgis\.com/i,
  /server\.arcgisonline/i,
  /esri\.com/i,
  /virtualearth\.net/i,
  /bing\.com\/maps/i,
  /mt[0-9]?\.google\.com/i,
  /maps\.googleapis\.com/i,
  /barikoi\.(com|xyz|net)/i,
  /(api|tiles)\.mapbox\.com/i,
  /mapboxgl/i,
];
function extractUrlLikes(raw) {
  const out = [];
  const urlRe = /https?:\/\/[^\s'"`()]+/g;
  let m;
  while ((m = urlRe.exec(raw))) out.push(m[0]);
  const tlRe = /(?:tileLayer|addProtocol|StyleURL|styleURL)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = tlRe.exec(raw))) out.push(m[1]);
  return out;
}
function* walkText(dirPath) {
  const skip = new Set(['node_modules', '.git', '.freebuff', '.agents', '.kilo', 'fonts', 'docs']);
  for (const e of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const p = path.join(dirPath, e.name);
    if (e.isDirectory()) {
      if (!skip.has(e.name)) yield* walkText(p);
    } else if (/\.(js|ts|html|json|css|xml|java|kt|swift|m|mm)$/.test(e.name)) yield p;
  }
}
let hits = [];
const rule7Files = [...walkText(path.join(REPO, 'tools', 'poi-tool')), ...walkJson(REPO)];
for (const f of rule7Files) {
  if (f.includes(`${path.sep}fonts${path.sep}`)) continue;
  const raw = fs.readFileSync(f, 'utf8');
  for (const u of extractUrlLikes(raw)) {
    for (const re of RASTER_URL_BANNED) {
      if (re.test(u)) hits.push(`${path.relative(REPO, f)}: ${u}`);
    }
  }
}
check('D: Hard Rule 7 — zero commercial raster endpoints in Pin Tool + style configs', hits.length === 0, hits.join('; '));

console.log(`\nBengali shaping audit complete: ${passed} assertions passed.`);
console.log(`
MANUAL DEVICE GATE (DPM-R-008, still OPEN):
[ ] Render "ক্ষ জ্ঞ ০-৯ ৳ ধানমন্ডি / বিশ্ববিদ্যালয় / ঢাকা / মতিঝিল / ফার্মগেট / প্রেসক্লাব"
    on Android + iOS maplibre-native beside a native TextView.
[ ] Confirm ক্ষ/জ্ঞ form single clusters (not decomposed) and matras reorder.
[ ] If decomposed: activate fallback hierarchy (pre-shaped ligatures → platform
    native symbol layer for first-party places → low-zoom Latin prioritization).
`);
