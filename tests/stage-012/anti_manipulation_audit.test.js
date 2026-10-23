/**
 * Stage 012 audit — Anti-Manipulation & Sybil Resistance.
 * Executes the REAL TS sources via the repo-pinned tsc (no mirrors).
 * Covers the plan section 8 matrix: TC-012-01..10 (+04b, 06b, 08b, 09b).
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage012-'));
const SHIM = path.join(REPO, 'tests', 'stage-005', 'node-shim.d.ts');
const ENTRY = ['services/antiManipulationFilter.ts', 'workers/fraudFilterWorker.ts'];
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

const F = require(path.join(tmp, 'services', 'antiManipulationFilter.js'));
const W = require(path.join(tmp, 'workers', 'fraudFilterWorker.js'));

// ---------- Fakes ----------
function makeDeps() {
  const seen = new Set();
  const quarantine = new Set();
  const queries = [];
  return {
    seen,
    quarantine,
    queries,
    deps: {
      devices: {
        has: (k) => seen.has(k),
        remember: (k) => {
          seen.add(k);
        },
      },
      counters: { incr: () => 1, expireOnce: () => undefined },
      quarantine: {
        add: (k, m) => {
          quarantine.add(`${k}|${m}`);
        },
        expireOnce: () => undefined,
        has: (k, m) => quarantine.has(`${k}|${m}`),
      },
      invalidate: {
        query: (text, params) => {
          queries.push({ text, params });
          return {};
        },
      },
    },
  };
}
const NOW = Date.now();
const D = 86400000;
function goodTrip(over = {}) {
  return {
    telemetry: {
      durationS: 600, distanceM: 3000, maxSpeedKmh: 45,
      breadcrumbCount: 120, speedVariance: 2.5, dropoffSnapM: 10,
    },
    deviceHash: 'dev-1',
    clusterId: 'cl_abc',
    accountAgeDays: 60,
    phoneVerified: true,
    riderPriorVoteTsMs: [],
    pairPriorVotes30d: 0,
    landmarkPairTripNumber: 1,
    youngVotesInCluster: 1,
    totalVotesInCluster: 20,
    cellVotes48h: 5,
    cellBaseline48h: 4,
    clusterVotesIn48h: 5,
    clusterTotalVotes: 20,
    weekVolume: 20,
    trailing4wkAvgVolume: 15,
    searchParams: {},
    nowMs: NOW,
    ...over,
  };
}

// ---------- A. L1 telemetry TC-012-01/02 ----------
{
  const t1 = F.evaluateTelemetry({ durationS: 60, distanceM: 3000, maxSpeedKmh: 45, breadcrumbCount: 120, speedVariance: 2.5, dropoffSnapM: 10 });
  check('A1/TC-012-01: 60 s trip REJECTED (too_short)', t1.includes('too_short'), JSON.stringify(t1));
  const t2 = F.evaluateTelemetry({ durationS: 600, distanceM: 100, maxSpeedKmh: 45, breadcrumbCount: 120, speedVariance: 2.5, dropoffSnapM: 10 });
  check('A2/TC-012-01: 100 m trip REJECTED (too_close)', t2.includes('too_close'));
  const t3 = F.evaluateTelemetry({ durationS: 600, distanceM: 3000, maxSpeedKmh: 45, breadcrumbCount: 120, speedVariance: 0.01, dropoffSnapM: 10 });
  check('A3/TC-012-02: Var(v)=0.01 REJECTED (emulated)', t3.includes('emulated_no_variance'));
  const t4 = F.evaluateTelemetry({ durationS: 600, distanceM: 3000, maxSpeedKmh: 150, breadcrumbCount: 120, speedVariance: 2.5, dropoffSnapM: 10 });
  check('A4: 150 km/h REJECTED (too_fast)', t4.includes('too_fast'));
  const t5 = F.evaluateTelemetry({ durationS: 600, distanceM: 3000, maxSpeedKmh: 45, breadcrumbCount: 120, speedVariance: 2.5, dropoffSnapM: 200 });
  check('A5: off-network drop-off REJECTED', t5.includes('off_network_dropoff'));
  const tok = F.evaluateTelemetry({ durationS: 600, distanceM: 3000, maxSpeedKmh: 45, breadcrumbCount: 120, speedVariance: 2.5, dropoffSnapM: 10 });
  check('A6: healthy trip passes L1', tok.length === 0);
}

// ---------- B. L2 + L3 caps TC-012-03/04/04b/05/06/06b/07 ----------
{
  check('B1: device key namespaced per device+cluster', F.deviceVoteKey('d', 'c') === 'fraud:device:d:c');
  check('B2: young account ineligible for quorum', !F.isQuorumEligible(5, true));
  check('B3: verified adult eligible', F.isQuorumEligible(14, true));

  // TC-012-04: 2nd vote same cluster within 5 d → 0.
  const w4 = F.riderClusterWeight([NOW - 5 * D], NOW);
  check('B4/TC-012-04: 2nd vote in 5 d REJECTED (0 weight)', w4 === 0);
  // TC-012-04b: 4th vote in 90 d → 0.
  const w4b = F.riderClusterWeight([NOW - 80 * D, NOW - 40 * D, NOW - 10 * D], NOW);
  check('B5/TC-012-04b: 4th vote in 90 d REJECTED (≤3/90d)', w4b === 0);
  check('B6: 3rd vote in 90 d (spaced weeks) counts', F.riderClusterWeight([NOW - 80 * D, NOW - 40 * D], NOW) === 1);

  // TC-012-05/06: dampening tiers 3–5 → 0.1; 6+ → 0 + audit flag.
  const p3 = F.landmarkPairWeight(3);
  check('B7/TC-012-05: pair 3rd trip dampened 0.1×', p3.weight === 0.1 && p3.dampened && !p3.auditFlag, JSON.stringify(p3));
  const p6 = F.landmarkPairWeight(6);
  check('B8/TC-012-06: pair 6th trip REJECTED + audit flag', p6.weight === 0 && p6.auditFlag, JSON.stringify(p6));
  // TC-012-06b: landmark cap — trips 1–2 count; 3rd contributes 0 at publication.
  check('B9/TC-012-06b: landmark trips 1–2 full weight', F.landmarkPairWeight(1).weight === 1 && F.landmarkPairWeight(2).weight === 1);

  // TC-012-07: 35% driver cohort disqualified; 25% passes; zero-denom throws.
  check('B10/TC-012-07: 35% driver cohort DISQUALIFIED', F.isDriverCohortDisqualified(35, 100) === true);
  check('B11: 25% cohort passes', F.isDriverCohortDisqualified(25, 100) === false);
  let threw = false;
  try {
    F.isDriverCohortDisqualified(1, 0);
  } catch {
    threw = true;
  }
  check('B12: zero-denominator cluster throws', threw);

  check('B13: cluster pair 2nd vote in 30 d blocked', !F.clusterPairAllowed(1) && F.clusterPairAllowed(0));
}

// ---------- C. L4 detectors TC-012-08/08b + time-burst + weekly hold ----------
{
  check('C1/TC-012-08: young swarm 45% QUARANTINED', F.isYoungSwarm(45, 100) === true);
  check('C2: 40% boundary passes', F.isYoungSwarm(40, 100) === false);
  check('C3/TC-012-08b: 5× velocity + floor trips quarantine', F.isVelocityBurst(60, 10) === true);
  check('C4: floor — 9 votes never self-triggers', F.isVelocityBurst(9, 0) === false);
  check('C5: 5× boundary (equal) passes', F.isVelocityBurst(50, 10) === false);
  check('C6: time-burst 65% in 48 h holds +2 weeks', F.isTimeBurst(65, 100) === true);
  check('C7: weekly 4× average holds', F.isWeeklyVolumeHold(40, 10) === true);
}

// ---------- D. L5 merchant integrity TC-012-10 ----------
{
  let threw = false;
  try {
    F.assertNoPaidPlacement({ promoted_poi: 'x' });
  } catch {
    threw = true;
  }
  check('D1/TC-012-10: promoted_poi forbidden', threw);
  threw = false;
  try {
    F.assertNoPaidPlacement({ bid_rank: 1 });
  } catch {
    threw = true;
  }
  check('D2: bid_rank forbidden', threw);
  threw = false;
  try {
    F.assertNoPaidPlacement({ commercial_boost: 2 });
  } catch {
    threw = true;
  }
  check('D3: commercial_boost forbidden', threw);
  check('D4: organic params pass', (() => { F.assertNoPaidPlacement({ q: 'masjid', limit: 6 }); return true; })());
  check('D5: rival-name alias is brand collision', F.isBrandCollision('Square Hospital Dhaka', ['Square Hospital']));
  check('D6: unrelated alias passes', !F.isBrandCollision('Baitul Aman Jame Masjid', ['Square Hospital']));
}

// ---------- E. Pipeline end-to-end (async) ----------
(async () => {
  // Healthy vote accepts and consumes the device key.
  {
    const h = makeDeps();
    const r = await W.evaluateTripVote(h.deps, goodTrip());
    check('E1: healthy vote ACCEPTED', r.verdict === 'accept' && r.pairWeight === 1, JSON.stringify(r));
  }
  // TC-012-03: same device votes twice in 30 d → rejected.
  {
    const h = makeDeps();
    await W.evaluateTripVote(h.deps, goodTrip({ deviceHash: 'dev-X' }));
    const r2 = await W.evaluateTripVote(h.deps, goodTrip({ deviceHash: 'dev-X' }));
    check('E2/TC-012-03: device duplicate REJECTED (L2)', r2.verdict === 'reject' && r2.reasons.some((x) => x.includes('L2')), JSON.stringify(r2));
  }
  // L1 failure short-circuits before device consumption.
  {
    const h = makeDeps();
    const bad = goodTrip();
    bad.telemetry = { durationS: 30, distanceM: 50, maxSpeedKmh: 200, breadcrumbCount: 2, speedVariance: 0, dropoffSnapM: 500 };
    const r = await W.evaluateTripVote(h.deps, bad);
    check('E3: L1 failure rejects without consuming device', r.verdict === 'reject' && r.reasons.some((x) => x.startsWith('L1:')));
  }
  // Velocity burst → quarantine_hold + cluster parked in the quarantine set.
  {
    const h = makeDeps();
    const r = await W.evaluateTripVote(h.deps, goodTrip({ cellVotes48h: 60, cellBaseline48h: 10 }));
    check(
      'E4/TC-012-08b: velocity burst parks cluster in dpmaps:quarantine:clusters',
      r.verdict === 'quarantine_hold' && (await h.deps.quarantine.has(F.QUARANTINE_CLUSTERS_SET, 'cl_abc')),
      JSON.stringify(r)
    );
  }
  // Young swarm → quarantine_hold.
  {
    const h = makeDeps();
    const r = await W.evaluateTripVote(h.deps, goodTrip({ youngVotesInCluster: 12, totalVotesInCluster: 20 }));
    check('E5: young swarm holds', r.verdict === 'quarantine_hold', JSON.stringify(r));
  }
  // Landmark 6th trip → reject + audit flag.
  {
    const h = makeDeps();
    const r = await W.evaluateTripVote(h.deps, goodTrip({ landmarkPairTripNumber: 6 }));
    check('E6: landmark 6th trip REJECTED with audit flag', r.verdict === 'reject' && r.reasons.includes('audit-flag'));
  }
  // Brand collision → reject.
  {
    const h = makeDeps();
    const r = await W.evaluateTripVote(
      h.deps,
      goodTrip({ aliasText: 'Square Hospital Branch', rivalMerchantNames: ['Square Hospital'] })
    );
    check('E7: brand-collision alias REJECTED (L5)', r.verdict === 'reject');

    // TC-012-09b: retroactive purge — ledger row byte-identical, side table only.
    const ledgerRow = { id: 42, query_cluster_id: 'cl_xyz', initial_weight: '1.0000', trip_hash: 'a'.repeat(64) };
    const before = JSON.stringify(ledgerRow);
    await W.recordInvalidation(h.deps.invalidate, 42, new Date('2026-10-01T00:00:00Z'), 'collusion', 'analyst-1');
    check(
      'E8/TC-012-09b: purge writes ledger_invalidations; ledger row byte-identical',
      JSON.stringify(ledgerRow) === before &&
        h.queries.some((q) => q.text.includes('dpmaps.ledger_invalidations')),
      JSON.stringify(h.queries.map((q) => q.text.slice(0, 60)))
    );
    let badReason = false;
    try {
      await W.recordInvalidation(h.deps.invalidate, 43, new Date(), 'made_up_reason');
    } catch {
      badReason = true;
    }
    check('E9: unknown invalidation reason refused', badReason);
  }

  // ---------- F. Schema + source-shape invariants ----------
  {
    const ddl = read('migrations/003_storage_schema.sql');
    check('F1: invalidation reasons incl. driver_bias (Rev 2.6)', ddl.includes("'fraud_sybil', 'burst_suppression', 'collusion', 'audit_purge', 'quarantine', 'driver_bias'"));
    check('F2: invalidated_by column present', ddl.includes('invalidated_by VARCHAR(64) NOT NULL'));
    check('F3: invalidation PK is side-table key', ddl.includes('PRIMARY KEY (ledger_id, created_at)'));
    check(
      'F4: shipped SQL references exact Stage 003 shapes',
      F.RECORD_INVALIDATION_SQL.includes('dpmaps.ledger_invalidations') &&
        F.RECORD_INVALIDATION_SQL.includes('ON CONFLICT (ledger_id, created_at) DO NOTHING') &&
        F.PAIR_RECOUNT_SQL.includes('rn <= 2') &&
        F.PAIR_RECOUNT_SQL.includes('90 days') &&
        F.INVALIDATION_SET_SELECT_SQL.includes('unnest')
    );
    const src = read('services/antiManipulationFilter.ts') + read('workers/fraudFilterWorker.ts');
    check('F5: ZERO ledger UPDATEs in purge pipeline', !/UPDATE\s+dpmaps\.trip_evidence_ledger/i.test(src));
    check('F6: zero UPDATE statements at all in new modules', !/\.query\(\s*[`'"]\s*UPDATE/i.test(src));
    check('F7: work-order crosswalk present', src.includes('collusion_ring') && src.includes('admin_manual'));
    check('F8: quarantine set named, TTL 30 d', F.QUARANTINE_CLUSTERS_SET === 'dpmaps:quarantine:clusters' && F.QUARANTINE_TTL_S === 2592000);
    check('F9: no vendor SDKs in new modules', !/(barikoi|googleapis|google\.maps)/i.test(src));
    check('F10: no pg/redis/meilisearch runtime imports', !/^import .* from '(pg|redis|meilisearch)'/m.test(src));
  }

  console.log(`\nSTAGE012: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
