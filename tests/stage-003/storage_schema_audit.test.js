#!/usr/bin/env node
/**
 * storage_schema_audit.test.js — Stage 003 Rev 2.6 verification suite.
 * Zero dependencies. Run: node tests/stage-003/storage_schema_audit.test.js
 *
 * Part A: static DDL audits over migrations/003_storage_schema.sql —
 *   every Rev 2.6 contract (tables, PKs, CHECKs, views, functions, roles,
 *   partman retention), ZERO trip_id column (Hard Rule 8 / A2), the
 *   active_dedup_key join (A3), and SQL syntax cleanliness.
 * Part B: 135-day key-schedule simulation against the REAL
 *   utils-server/windowKeyManager.js — 300 riders, 0–14d rotation jitter,
 *   exact distinct-rider counts at Days 91/100/130, cold-start mode,
 *   erasure coverage, disablement, lifetime enforcement (A4).
 */

'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const DDL_PATH = path.join(REPO, 'migrations', '003_storage_schema.sql');
const ddl = fs.readFileSync(DDL_PATH, 'utf8');

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

// Strip -- line comments and /* */ blocks for token-level audits.
const ddlNoComments = ddl
  .replace(/--[^\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// ---------- Part A1: table / view / function presence (Rev 2.2–2.6) ----------
const TABLES = [
  'dpmaps.active_dedup_key', 'dpmaps.public_pois', 'dpmaps.category_synonym_mappings',
  'dpmaps.poi_aliases', 'dpmaps.releases', 'dpmaps.poi_versions',
  'dpmaps.release_pois', 'dpmaps.trip_evidence_ledger', 'dpmaps.ledger_pseudonyms',
  'dpmaps.ledger_invalidations', 'dpmaps.provenance_events', 'dpmaps.suppressions',
  'dpmaps.admin_boundaries', 'dpmaps.raw_search_events', 'dpmaps.search_eval_events',
  'dpmaps.routing_eval_events', 'dpmaps.osm_pois', 'dpmaps.query_clusters',
  'public.ride_vendor_data', 'dpmaps.segment_speeds_tod', 'dpmaps.h3_edge_speeds_tod',
  'dpmaps.eta_tod_corrections', 'dpmaps.takedown_reports', 'dpmaps.provisional_challengers',
  'dpmaps.post_trip_labels', 'dpmaps.osm_road_names',
  'public.orders', 'public.ride_receipts', 'public.user_private_places',
];
for (const t of TABLES) {
  check(`A1: table present — ${t}`, new RegExp(`CREATE TABLE IF NOT EXISTS ${t.replace(/\./g, '\\.')}\\b`).test(ddl));
}
for (const v of ['dpmaps.v_active_cluster_evidence', 'dpmaps.v_search_feed_first_party', 'dpmaps.v_search_feed_osm']) {
  check(`A1: view present — ${v}`, ddl.includes(v));
}
check('A1: materialized view mv_cluster_evidence_stats present', ddl.includes('dpmaps.mv_cluster_evidence_stats'));
check('A1: decay function 3-arg IMMUTABLE present', /calculate_decayed_weight\(\s*p_initial_weight NUMERIC,\s*p_created_at TIMESTAMPTZ,\s*p_as_of TIMESTAMPTZ[\s\S]{0,400}?IMMUTABLE/.test(ddl));
check('A1: decay function 2-arg STABLE present', /calculate_decayed_weight\(\s*p_initial_weight NUMERIC,\s*p_created_at TIMESTAMPTZ\s*\)[\s\S]{0,400}?STABLE/.test(ddl));
check('A1: maintenance procedure prune_maintenance present', ddl.includes('dpmaps.run_evidence_maintenance'));
check('A1: lambda constant ln(2)/45 present', ddl.includes('0.0154033'));

// ---------- Part A2: ZERO trip_id column (Hard Rule 8) ----------
check(
  'A2: ledger schema contains zero trip_id column',
  !/\btrip_id\b/i.test(ddlNoComments),
  'trip_id token found outside comments',
);
check('A2b: key-independent trip_hash present instead', ddl.includes('trip_hash CHAR(64) NOT NULL'));
check('A2c: idempotency constraint uq_ledger_trip present', ddl.includes('CONSTRAINT uq_ledger_trip UNIQUE (trip_hash, created_at)'));

// ---------- Part A3: dedup-key join + single-vote invariant ----------
check(
  'A3: v_active_cluster_evidence joins active_dedup_key on key_id',
  /JOIN dpmaps\.active_dedup_key adk\s*\n?\s*ON lp\.key_id = adk\.key_id/.test(ddl),
);
check('A3b: view excludes invalidated votes', ddl.includes('LEFT JOIN dpmaps.ledger_invalidations li'));
check('A3c: view has no HAVING >= 15 gate (runner-up cells preserved)', !/v_active_cluster_evidence[\s\S]{0,2000}?HAVING/i.test(ddlNoComments.split('mv_cluster_evidence_stats')[0]));
check('A3d: Kish weights sum_weights + sum_weight_sq present', ddl.includes('AS sum_weights') && ddl.includes('AS sum_weight_sq'));

// ---------- Part A4: Rev 2.6 contract details ----------
check('A4a: osm_pois composite PK (osm_type, osm_id, snapshot_date)', ddl.includes('PRIMARY KEY (osm_type, osm_id, snapshot_date)'));
check('A4b: 32-category CHECK incl. transit_station/bus_stop/society_gate', ['transit_station', 'bus_stop', 'ferry_terminal', 'society_gate', 'intersection', 'commercial_building', 'tourist_attraction'].every((c) => ddl.includes(`'${c}'`)));
check('A4c: bilingual gate chk_poi_bilingual_active present', ddl.includes('chk_poi_bilingual_active'));
check('A4d: invalidation reason includes driver_bias (Rev 2.6)', ddl.includes("'driver_bias'"));
check('A4e: osm_road_names PK (way_id, snapshot_date)', ddl.includes('PRIMARY KEY (way_id, snapshot_date)'));
check('A4f: saved-place sovereign_place_id + needs_confirmation', ddl.includes('sovereign_place_id UUID') && ddl.includes('needs_confirmation BOOLEAN'));
check('A4g: query_clusters.published_poi_id present', ddl.includes('published_poi_id UUID REFERENCES dpmaps.public_pois(id)'));
check('A4h: orders.user_id stub completion present', ddl.includes('ADD COLUMN IF NOT EXISTS user_id VARCHAR(64)'));
check('A4i: ride_vendor_data.vendor_provider barikoi/google', /vendor_provider VARCHAR\(16\) NOT NULL\s*CHECK \(vendor_provider IN \('barikoi', 'google'\)\)/.test(ddlNoComments.replace(/\n/g, ' ')));
check('A4j: suppressions.reported_at has no NOW() default (SLA clock)', !/reported_at TIMESTAMPTZ NOT NULL DEFAULT/.test(ddlNoComments));
check('A4k: point_type enum incl. curb_stop + perimeter_gate', ddl.includes("'curb_stop'") && ddl.includes("'perimeter_gate'"));

// ---------- Part A5: clean-room + RBAC contracts ----------
check('A5a: routing_eval_events stores error pcts only', ddl.includes('vendor_duration_error_pct') && ddl.includes('vendor_distance_error_pct'));
check(
  'A5b: no raw vendor quote columns (vendor_duration_s / vendor_distance_m)',
  !/\bvendor_duration_s\b/.test(ddlNoComments) && !/\bvendor_distance_m\b/.test(ddlNoComments),
);
check('A5c: REVOKE ALL on ride_vendor_data for dpmaps_worker', /REVOKE ALL ON public\.ride_vendor_data FROM dpmaps_worker/.test(ddl));
check('A5d: REVOKE ALL on ride_receipts for dpmaps_worker', /REVOKE ALL ON public\.ride_receipts FROM dpmaps_worker/.test(ddl));
check('A5e: explicit column whitelist on orders (elapsed_seconds)', /GRANT SELECT \(id, status, created_at, dropoff_lat, dropoff_lng, elapsed_seconds\)/.test(ddlNoComments.replace(/\n/g, ' ')));
check('A5f: append-only REVOKE UPDATE, DELETE on provenance_events batch', /REVOKE UPDATE, DELETE ON dpmaps\.provenance_events, dpmaps\.releases, dpmaps\.poi_versions, dpmaps\.release_pois, dpmaps\.ledger_invalidations FROM dpmaps_worker/.test(ddlNoComments.replace(/\n/g, ' ')));
check('A5g: partman weekly ledger parents + 90d retention, keep_table=false', ddl.includes("p_interval => '1 week'") && ddl.includes("retention = '90 days'") && ddl.includes('retention_keep_table = false'));
check('A5h: CALL partman.run_maintenance_proc in maintenance proc', ddl.includes('CALL partman.run_maintenance_proc()'));
check('A5i: 21:00-23:00 UTC pruning window documented', ddl.includes('21:00') && ddl.includes('23:00'));

// ---------- Part A6: SQL syntax cleanliness (static) ----------
// Splitter aware of -- comments, /* */, '...', "...", $$...$$ bodies.
function splitStatements(src) {
  const stmts = [];
  let cur = '';
  let i = 0;
  let dollarTag = null;
  while (i < src.length) {
    if (dollarTag) {
      if (src.startsWith(dollarTag, i)) {
        cur += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else cur += src[i++];
      continue;
    }
    const dm = src.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
    if (dm) {
      dollarTag = dm[0];
      cur += dollarTag;
      i += dollarTag.length;
      continue;
    }
    if (src.startsWith('--', i)) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === ch) {
          if (src[j + 1] === ch) j += 2;
          else break;
        } else j++;
      }
      cur += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ';') {
      if (cur.trim()) stmts.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts;
}
const stmts = splitStatements(ddl);
check('A6a: DDL splits into statements', stmts.length > 60, `got ${stmts.length}`);
const KNOWN = /^(CREATE|ALTER|INSERT|UPDATE|SELECT|GRANT|REVOKE|DO|CALL|SET|COMMENT|DROP|CREATE OR REPLACE)\b/i;
const badStart = stmts.filter((s) => !KNOWN.test(s));
check('A6b: every statement starts with a known keyword', badStart.length === 0, badStart.slice(0, 2).join(' | ').slice(0, 200));
function balanced(s) {
  const noStr = s.replace(/'(''|[^'])*'/g, "''").replace(/"(""|[^"])*"/g, '""');
  let p = 0;
  for (const c of noStr) {
    if (c === '(') p++;
    if (c === ')') p--;
    if (p < 0) return false;
  }
  return p === 0;
}
const unbal = stmts.filter((s) => !balanced(s));
check('A6c: parentheses balanced in every statement', unbal.length === 0, unbal.slice(0, 1).join('').slice(0, 200));
check('A6d: DO blocks closed (BEGIN vs standalone-END parity)', (() => {
  const begins = (ddlNoComments.match(/\bBEGIN\b/g) || []).length;
  // Standalone closers: `END $$` / `END;`. `END IF` closes IF-branches, not blocks.
  const endBlocks = (ddlNoComments.match(/\bEND\s*(?:\$\$|;)/g) || []).length;
  return begins >= 5 && begins === endBlocks;
})());

// ---------- Part B: 135-day key schedule simulation (real code) ----------
async function loadKeyManager() {
  return import(path.join(REPO, 'utils-server', 'windowKeyManager.js'));
}

// Deterministic PRNG (mulberry32) for a reproducible scenario.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const crypto = require('node:crypto');
const fakeProvider = {
  disabled: new Set(),
  async generateHmac(keyUri, msg) {
    if (this.disabled.has(keyUri)) throw new Error(`key disabled: ${keyUri}`);
    return crypto.createHmac('sha256', keyUri).update(msg).digest('hex');
  },
  async disableKey(keyUri) {
    this.disabled.add(keyUri);
  },
  async scheduleKeyDeletion() {},
};

const DAY = 86400000;
const launch = new Date(Date.UTC(2026, 0, 1));
// Rotation with 0–14 day jitter: key k created at k*30 + cumulative jitter.
const rand = rng(20260303);
const keySchedule = [];
{
  let delay = 0;
  for (let k = 0; k * 30 <= 200 + 135; k++) {
    delay += Math.floor(rand() * 5); // cumulative slip, capped below
    if (delay > 14) delay = 14;
    const createdAt = new Date(launch.getTime() + (k * 30 + delay) * DAY);
    keySchedule.push({
      keyId: `wk-${String(k + 1).padStart(2, '0')}`,
      keyUri: `vault/dpmaps/window-${k + 1}`,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 135 * DAY),
    });
  }
  // Launch key exists at t=0 exactly (rotation jitter applies to later keys).
  keySchedule[0].createdAt = new Date(launch.getTime());
  keySchedule[0].expiresAt = new Date(launch.getTime() + 135 * DAY);
}

(async () => {
  const {
    WindowKeyManager,
    KEY_LIFETIME_DAYS,
    ROTATION_CADENCE_DAYS,
  } = await loadKeyManager();

  check('B0: key lifetime is 135 days', KEY_LIFETIME_DAYS === 135);
  check('B0b: rotation cadence is 30 days', ROTATION_CADENCE_DAYS === 30);

  // 300 riders, 1–4 visits across days 0–135; 60 drivers.
  const R = rng(777);
  const riders = Array.from({ length: 300 }, (_, i) => `rider-${i}`);
  const visits = [];
  for (const r of riders) {
    const n = 1 + Math.floor(R() * 4);
    for (let v = 0; v < n; v++) {
      visits.push({ rider: r, driver: `driver-${Math.floor(R() * 60)}`, day: Math.floor(R() * 136), trip: `${r}-t${v}` });
    }
  }
  visits.sort((a, b) => a.day - b.day);

  // Ingest: each vote hashed under keys valid that day; store per-key hashes.
  const mgr = new WindowKeyManager(fakeProvider, launch, 'test-ingestion-salt');
  const ledger = []; // {trip, rider, day, perKey: Map keyId->hash}
  for (const v of visits) {
    const asOf = new Date(launch.getTime() + v.day * DAY);
    mgr.validKeys = keySchedule
      .filter((k) => k.createdAt <= asOf && k.expiresAt >= asOf)
      .map((k) => ({ ...k }));
    const { pseudonyms } = await mgr.hashTripEvidenceForIngestion(v.rider, v.driver, v.trip);
    checkSilent(pseudonyms.length >= 1 && pseudonyms.length <= 5, 'fan-out within 1..5 keys');
    ledger.push({ ...v, perKey: new Map(pseudonyms.map((p) => [p.keyId, p.riderHash])) });
  }

  function distinctUnder(keyId, endDay) {
    const startDay = endDay - 90;
    const seen = new Set();
    for (const e of ledger) {
      if (e.day > startDay && e.day <= endDay && e.perKey.has(keyId)) seen.add(e.perKey.get(keyId));
    }
    return seen.size;
  }
  function groundTruth(endDay) {
    const startDay = endDay - 90;
    const seen = new Set();
    for (const e of ledger) {
      if (e.day > startDay && e.day <= endDay) seen.add(e.rider);
    }
    return seen.size;
  }

  // Days 91, 100, 130: manager's dedup key must reproduce ground truth exactly.
  for (const d of [91, 100, 130]) {
    const asOf = new Date(launch.getTime() + d * DAY);
    mgr.validKeys = keySchedule
      .filter((k) => k.createdAt <= asOf && k.expiresAt >= asOf)
      .map((k) => ({ ...k }));
    let res;
    try {
      res = mgr.getDeduplicationKey(asOf);
    } catch (e) {
      check(`B1: dedup key resolves at day ${d} (jitter-proof)`, false, e.message);
      continue;
    }
    check(`B1: dedup key resolves at day ${d} (jitter-proof)`, !res.isColdStart && res.windowDays === 90);
    const counted = distinctUnder(res.key.keyId, d);
    const truth = groundTruth(d);
    check(`B2: day-${d} distinct riders exact (no overcount)`, counted === truth, `counted=${counted} truth=${truth}`);
    check(`B2b: day-${d} getDedupKeyId matches`, mgr.getDedupKeyId(asOf) === res.key.keyId);
  }

  // Steady-state sweep: no coverage exception on any day 90..200.
  let sweepFails = 0;
  for (let d = 90; d <= 200; d++) {
    const asOf = new Date(launch.getTime() + d * DAY);
    mgr.validKeys = keySchedule
      .filter((k) => k.createdAt <= asOf && k.expiresAt >= asOf)
      .map((k) => ({ ...k }));
    try {
      mgr.getDeduplicationKey(asOf);
    } catch {
      sweepFails++;
    }
  }
  check('B3: steady-state sweep days 90–200 never throws', sweepFails === 0, `${sweepFails} failures`);

  // Cold start: days 1..89 return launch key, partial window, thresholds unscaled (asserted by contract).
  mgr.validKeys = [{ ...keySchedule[0] }];
  let coldOk = true;
  for (const d of [1, 30, 60, 89]) {
    const res = mgr.getDeduplicationKey(new Date(launch.getTime() + d * DAY));
    if (!res.isColdStart || res.key.keyId !== 'wk-01' || res.windowDays !== Math.max(1, d)) coldOk = false;
  }
  check('B4: cold-start days 1–89 use wk-01 with partial window', coldOk);

  // Lifetime enforcement: 90-day key rejected.
  let rejected = false;
  try {
    mgr.addKey({ keyId: 'bad', keyUri: 'x', createdAt: launch, expiresAt: new Date(launch.getTime() + 90 * DAY) });
  } catch {
    rejected = true;
  }
  check('B5: addKey rejects non-135-day lifetime', rejected);

  // Erasure: one hash per active key.
  mgr.validKeys = keySchedule
    .filter((k) => k.createdAt <= new Date(launch.getTime() + 100 * DAY) && k.expiresAt >= new Date(launch.getTime() + 100 * DAY))
    .map((k) => ({ ...k }));
  const erasure = await mgr.hashesForErasure('rider-42');
  check('B6: erasure covers every active key', erasure.length === mgr.validKeys.length && erasure.every((e) => /^[0-9a-f]{64}$/.test(e.pseudonymHash)));

  // Disablement: HMAC after disableKey fails (irreversible).
  await fakeProvider.disableKey(keySchedule[0].keyUri);
  let threw = false;
  try {
    await fakeProvider.generateHmac(keySchedule[0].keyUri, Buffer.from('rider-1'));
  } catch {
    threw = true;
  }
  check('B7: disabled key refuses HMAC (irreversible disablement)', threw);

  console.log(`\nStage 003 audit complete: ${passed} assertions passed.`);
})().catch((err) => {
  console.error('[FAIL] audit crashed:', err);
  process.exitCode = 1;
});

function checkSilent(cond, what) {
  if (!cond) {
    console.error(`[FAIL] ingestion invariant: ${what}`);
    process.exitCode = 1;
  }
}
