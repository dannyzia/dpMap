#!/usr/bin/env node
/**
 * generate_bengali_glyphs.js — Stage 006 Phase-0 glyph pipeline.
 *
 * Generates MapLibre SDF glyph PBFs for the composite fontstacks
 *   "Noto Sans Bengali Regular" / "Noto Sans Bengali Medium" / "Noto Sans Bengali Bold"
 * (Noto Sans Bengali + Noto Sans Latin merged per stack), ranges:
 *   0-255.pbf        — Basic Latin / ASCII (numerals, road abbreviations)
 *   2304-2559.pbf    — Devanagari+Bengali block range U+0900–U+09FF, which
 *                      fully contains the Bengali block U+0980–U+09FF.
 *
 * RANGE-NAME NOTE (deviation from the Stage 006 task order, deliberate):
 * the order asked for `2432-2687.pbf`. That filename is NOT a valid MapLibre
 * glyph range: MapLibre requests 256-aligned ranges computed as
 * floor(codepoint/256)*256, so U+0995 resolves to `2304-2559.pbf`. A
 * `2432-2687.pbf` file would never be requested by any client and the
 * Bengali block would 404. The normative plan (§3.1, F-006-4) specifies
 * `2304-2559.pbf`; this script follows the plan.
 *
 * Fonts are SIL Open Font License build-time inputs (NOT map data, Hard Rule 1
 * unaffected). Resolution order: --fonts-dir (default below) → ./fonts cache
 * next to tools/glyphs → download from googlefonts/noto-fonts (verified
 * 2026-10-23). At runtime the client loads zero Google endpoints (plan §2).
 *
 * Usage:
 *   node tools/scripts/generate_bengali_glyphs.js [--fonts-dir DIR] [--out DIR]
 *                                                  [--weights Regular,Medium,Bold]
 * Requires the `fontnik` package (see tools/glyphs/package.json).
 */

'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SYSTEM_FONTS = '/usr/share/fonts/truetype/noto';
const CACHE_DIR = path.join(REPO_ROOT, 'tools', 'glyphs', 'fonts');
const DEFAULT_OUT = path.join(REPO_ROOT, 'docs', 'resources', 'fonts');

const GF_BASE =
  'https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf';

const STACKS = [
  {
    stack: 'Noto Sans Bengali Regular',
    bengali: 'NotoSansBengali-Regular.ttf',
    latin: 'NotoSans-Regular.ttf',
    gfBengali: `${GF_BASE}/NotoSansBengali/NotoSansBengali-Regular.ttf`,
    gfLatin: `${GF_BASE}/NotoSans/NotoSans-Regular.ttf`,
  },
  {
    stack: 'Noto Sans Bengali Medium',
    bengali: 'NotoSansBengali-Medium.ttf',
    latin: 'NotoSans-Medium.ttf',
    gfBengali: `${GF_BASE}/NotoSansBengali/NotoSansBengali-Medium.ttf`,
    gfLatin: `${GF_BASE}/NotoSans/NotoSans-Medium.ttf`,
  },
  {
    stack: 'Noto Sans Bengali Bold',
    bengali: 'NotoSansBengali-Bold.ttf',
    latin: 'NotoSans-Bold.ttf',
    gfBengali: `${GF_BASE}/NotoSansBengali/NotoSansBengali-Bold.ttf`,
    gfLatin: `${GF_BASE}/NotoSans/NotoSans-Bold.ttf`,
  },
];

const RANGES = [
  [0, 255],
  [2304, 2559],
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([^=]+)(=(.*))?$/);
    if (m) out[m[1]] = m[3] !== undefined ? m[3] : true;
  }
  return out;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'dpMaps-glyph-pipeline' } },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          download(res.headers.location, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const w = fs.createWriteStream(dest);
        res.pipe(w);
        w.on('finish', () => w.close(resolve));
        w.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
  });
}

async function resolveFont(fileName, gfUrl, fontsDir) {
  const candidates = [
    path.join(fontsDir, fileName),
    path.join(CACHE_DIR, fileName),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  console.log(`  fetching ${fileName} (SIL OFL, build-time input)…`);
  const dest = path.join(CACHE_DIR, fileName);
  await download(gfUrl, dest);
  return dest;
}

function rangeAsync(fontnik, font, start, end) {
  return new Promise((resolve, reject) => {
    fontnik.range({ font, start, end }, (err, zdata) => {
      if (err) reject(err);
      else resolve(zdata);
    });
  });
}

function compositeAsync(fontnik, pbfs) {
  return new Promise((resolve, reject) => {
    fontnik.composite(pbfs, (err, out) => {
      if (err) reject(err);
      else resolve(out);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fontsDir = args['fonts-dir'] || DEFAULT_SYSTEM_FONTS;
  const outDir = args.out || DEFAULT_OUT;
  const weights = String(args.weights || 'Regular,Medium,Bold').split(',');

  let fontnik;
  try {
    fontnik = require('fontnik');
  } catch {
    fontnik = require(path.join(REPO_ROOT, 'tools', 'glyphs', 'node_modules', 'fontnik'));
  }

  console.log(`fonts-dir: ${fontsDir}\nout-dir:    ${outDir}`);

  for (const spec of STACKS) {
    if (!weights.includes(spec.stack.split(' ').pop())) continue;
    console.log(`\n== ${spec.stack} ==`);
    const bnPath = await resolveFont(spec.bengali, spec.gfBengali, fontsDir);
    const latPath = await resolveFont(spec.latin, spec.gfLatin, fontsDir);
    console.log(`  bengali: ${bnPath}\n  latin:   ${latPath}`);
    const bnFont = fs.readFileSync(bnPath);
    const latFont = fs.readFileSync(latPath);
    const target = path.join(outDir, spec.stack);
    fs.mkdirSync(target, { recursive: true });

    for (const [start, end] of RANGES) {
      const file = path.join(target, `${start}-${end}.pbf`);
      if (start === 0) {
        // Composite: Bengali + Latin merged (plan §3.2 arg order).
        const [pbfBn, pbfLat] = await Promise.all([
          rangeAsync(fontnik, bnFont, start, end),
          rangeAsync(fontnik, latFont, start, end),
        ]);
        fs.writeFileSync(file, await compositeAsync(fontnik, [pbfBn, pbfLat]));
      } else {
        fs.writeFileSync(file, await rangeAsync(fontnik, bnFont, start, end));
      }
      const size = fs.statSync(file).size;
      if (size === 0) throw new Error(`empty output: ${file}`);
      console.log(`  wrote ${start}-${end}.pbf (${size} bytes)`);
    }
  }
  console.log('\nGlyph generation completed.');
}

main().catch((err) => {
  console.error('FATAL:', err && err.message ? err.message : err);
  process.exit(1);
});
