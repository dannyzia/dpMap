/**
 * Stage 014 audit — Saved Places Migration & Decoupling.
 * Executes the REAL TS sources via the repo-pinned tsc (no mirrors).
 * Covers the plan section 7 matrix TC-014-01 through TC-014-08.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage014-'));
const SHIM = path.join(REPO, 'tests', 'stage-005', 'node-shim.d.ts');
const ENTRY = ['workers/savedPlacesMigrator.ts'];
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

const M = require(path.join(tmp, 'workers', 'savedPlacesMigrator.js'));

function cluster(lat, lng, n, jitterM) {
  // Deterministic jitter (~meters) around a center.
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = ((i * 37) % 11) / 11 - 0.5; // deterministic pseudo-spread in [-0.5, 0.5)
    out.push({ lat: lat + (k * jitterM) / 111320, lng: lng + (k * jitterM) / (111320 * Math.cos((lat * Math.PI) / 180)) });
  }
  return out;
}

// ---------- A. Track 1 triangulation TC-014-01/01b/01c ----------
{
  // TC-014-01: 5 trips, 8 m spread, single cluster → migrated, no confirmation.
  const r1 = M.triangulateFromTripHistory([cluster(23.81, 90.41, 5, 8)]);
  check(
    'A1/TC-014-01: tight single cluster migrates clean',
    !r1.needsConfirmation && r1.tripCount === 5 && r1.spreadM <= 30 && r1.confirmationReason === null,
    JSON.stringify(r1)
  );
  check('A2: median near the drop center', Math.abs(r1.medianLat - 23.81) < 0.001 && Math.abs(r1.medianLng - 90.41) < 0.001);

  // TC-014-01b: 3 trips, 45 m spread → migrated WITH needs_confirmation.
  const r1b = M.triangulateFromTripHistory([cluster(23.81, 90.41, 3, 45)]);
  check(
    'A3/TC-014-01b: wide spread forces confirmation card',
    r1b.needsConfirmation && r1b.confirmationReason === 'spread' && r1b.tripCount === 3,
    JSON.stringify(r1b)
  );

  // TC-014-01c: Home + Work strong clusters → needs_confirmation, never silent inference.
  const r1c = M.triangulateFromTripHistory([cluster(23.81, 90.41, 5, 8), cluster(23.75, 90.39, 6, 8)]);
  check(
    'A4/TC-014-01c: two strong clusters force confirmation (no silent Home/Work inference)',
    r1c.needsConfirmation && r1c.confirmationReason === 'ambiguous_clusters',
    JSON.stringify(r1c)
  );

  // Too few trips anywhere → confirmation.
  const r0 = M.triangulateFromTripHistory([cluster(23.81, 90.41, 2, 5)]);
  check('A5: <3 trips → confirmation', r0.needsConfirmation && r0.confirmationReason === 'too_few_trips');
}

// ---------- B. Track 2/3 + SQL shape TC-014-02/03/04 ----------
{
  check(
    'B1: Track 1 candidate SQL orders-conformant (user_id/dropoff, no rider_id/destination_name/dropoff_geom)',
    M.TRACK1_CANDIDATE_SQL.includes('o.user_id = upp.user_id') &&
      M.TRACK1_CANDIDATE_SQL.includes('o.dropoff_lat') &&
      !/rider_id|destination_name|dropoff_geom/.test(M.TRACK1_CANDIDATE_SQL)
  );
  check(
    'B2: Track 1 write keeps user_confirmed FALSE (machine ≠ confirmed)',
    M.TRACK1_UPDATE_SQL.includes('user_confirmed = FALSE') && M.TRACK1_UPDATE_SQL.includes('needs_confirmation = $')
  );
  check(
    'B3/TC-014-03: Track 2 is the ONLY user_confirmed=TRUE path',
    M.TRACK2_CONFIRM_SQL.includes('user_confirmed = TRUE') &&
      M.TRACK2_CONFIRM_SQL.includes("migration_source = 'user_confirmed_pin'") &&
      M.TRACK2_CONFIRM_SQL.includes('WHERE id = $5 AND user_id = $6') &&
      !M.TRACK1_UPDATE_SQL.includes('user_confirmed = TRUE')
  );
  // TC-014-02: unvisited bookmark has no trips → confirmation path (Track 2/3).
  const r2 = M.triangulateFromTripHistory([]);
  check('B4/TC-014-02: unvisited bookmark awaits card (no auto-migration)', r2.needsConfirmation);

  // TC-014-04: H3 cells populated at write time (both resolutions in Track SQL).
  check('B5/TC-014-04: h3_res9 + h3_res10 in Track 1 and Track 2 writes', M.TRACK1_UPDATE_SQL.includes('h3_res9') && M.TRACK1_UPDATE_SQL.includes('h3_res10') && M.TRACK2_CONFIRM_SQL.includes('h3_res9') && M.TRACK2_CONFIRM_SQL.includes('h3_res10'));

  // Track 3: coordinates only, must confirm; non-finite refused.
  const e3 = M.toEphemeralResolution(23.81, 90.41);
  check(
    'B6: Track 3 carries coordinates only + mustConfirm',
    e3.lat === 23.81 && e3.lng === 90.41 && e3.mustConfirm === true && !('place_id' in e3) && !('vendor_text' in e3),
    JSON.stringify(e3)
  );
  let threw = false;
  try {
    M.toEphemeralResolution(NaN, 90.41);
  } catch {
    threw = true;
  }
  check('B7: non-finite coordinates refused', threw);
}

// ---------- C. Class-3 isolation + sovereignty TC-014-05/06/07/08 ----------
{
  let isolationHolds = true;
  for (const sql of M.SHIPPED_STATEMENTS) {
    try {
      M.assertNoDpmapsMerge(sql);
    } catch {
      isolationHolds = false;
    }
  }
  check('C1/TC-014-05: all shipped statements pass Class-3 isolation', isolationHolds);
  let guardFires = false;
  try {
    M.assertNoDpmapsMerge('SELECT * FROM dpmaps.trip_evidence_ledger WHERE user_id = 1');
  } catch {
    guardFires = true;
  }
  check('C2: guard refuses dpmaps.* references', guardFires);

  const cutover = read('migrations/014_decouple_saved_places.sql');
  check(
    'C3/TC-014-06: post-cutover vendor columns dropped (manual step, not auto-executed)',
    /DROP COLUMN IF EXISTS vendor_place_id/.test(cutover) && /DROP COLUMN IF EXISTS vendor_provider/.test(cutover) &&
      !/^ALTER TABLE public.user_private_places\s*\n\s*DROP COLUMN/m.test(cutover)
  );
  check(
    'C4: migration adds sovereign columns rerunnably (IF NOT EXISTS)',
    cutover.includes('ADD COLUMN IF NOT EXISTS geom') && cutover.includes('ADD COLUMN IF NOT EXISTS h3_res9') &&
      cutover.includes('ADD COLUMN IF NOT EXISTS h3_res10') && cutover.includes('ADD COLUMN IF NOT EXISTS migration_source') &&
      cutover.includes('ADD COLUMN IF NOT EXISTS user_confirmed') && cutover.includes('ADD COLUMN IF NOT EXISTS is_migrated')
  );
  check('C5: migration_source CHECK vocabulary exact', cutover.includes("'first_party_trip_history', 'user_confirmed_pin', 'ephemeral_vendor_resolved', 'native_first_party'"));

  // TC-014-07: zero vendor IDs/strings in migrated shapes.
  const shapes = M.TRACK1_UPDATE_SQL + M.TRACK2_CONFIRM_SQL + M.TRACK1_CANDIDATE_SQL + M.CUTOVER_GATE_SQL;
  check(
    'C6/TC-014-07: zero vendor IDs/strings anywhere in migration SQL',
    !/vendor_place_id|vendor_provider|barikoi|google/i.test(shapes) &&
      !/['"]place_id['"]/.test(shapes) // no vendor place-ID column reference (local saved_place_id alias is fine)
  );

  // TC-014-08: sovereign_place_id stable across renames/updates (UUID minted
  // once, never derived — present in Rev 2.6 base + 014 unique index).
  const base = read('migrations/003_storage_schema.sql');
  check(
    'C7/TC-014-08: sovereign_place_id UUID default + unique index',
    base.includes('sovereign_place_id UUID NOT NULL DEFAULT gen_random_uuid()') &&
      cutover.includes('uq_user_private_places_sovereign')
  );

  // Cutover gate shape.
  check(
    'C8: cutover gate counts unmigrated-or-unconfirmed trailing-90d users',
    M.CUTOVER_GATE_SQL.includes('is_migrated = FALSE OR upp.needs_confirmation = TRUE') && M.CUTOVER_GATE_SQL.includes('90 days')
  );

  // Legal framing: no absolute IP claims in new Stage 014 files.
  const src014 = read('workers/savedPlacesMigrator.ts') + cutover;
  check('C9: no absolute IP/copyright claims (F-014-1)', !/nullif|immun|100% compliant|copyrights nullified/i.test(src014));
}

console.log(`\nSTAGE014: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
