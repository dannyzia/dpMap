#!/usr/bin/env node
/**
 * winner_selection_audit.test.js — Stage 009 learning-engine audit.
 * Zero test dependencies. Run: node tests/stage-009/winner_selection_audit.test.js
 *
 * The real TypeScript sources are transpiled with the repo-pinned tsc and
 * executed behaviorally — no mirrors. (Stages 004/005/007/008 pattern;
 * node-shim.d.ts covers the host's missing @types/node for node:crypto.)
 * No Postgres/h3-js on this host (OUT of scope: Phase 2 infra); view
 * aggregates and gridDisk are same-semantics fakes.
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
const failsWith = (verdict, gate) => verdict.gate_failures.some((f) => f.startsWith(gate));

// ---------- T. Transpile real TS sources ----------
const TSC = path.join(REPO, 'tools', 'glyphs', 'node_modules', '.bin', 'tsc');
check('T0: repo-pinned tsc available', fs.existsSync(TSC), TSC);
if (!fs.existsSync(TSC)) {
  console.error('FATAL: cannot behaviorally verify TS without tsc');
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage009-'));
const G_PATH = path.join(tmp, 'services', 'publicationGates.js');
const W_PATH = path.join(tmp, 'services', 'winnerSelector.js');
const S_PATH = path.join(tmp, 'services', 'sybilGuard.js');
let transpiled = false;
try {
  execFileSync(
    TSC,
    [
      '--module', 'commonjs', '--target', 'es2020', '--strict', 'false',
      '--rootDir', REPO, '--outDir', tmp,
      path.join(REPO, 'services', 'publicationGates.ts'),
      path.join(REPO, 'services', 'winnerSelector.ts'),
      path.join(REPO, 'services', 'sybilGuard.ts'),
      path.join(REPO, 'tests', 'stage-005', 'node-shim.d.ts'),
    ],
    { stdio: 'pipe' },
  );
  transpiled = [G_PATH, W_PATH, S_PATH].every(fs.existsSync);
} catch (e) {
  console.error(`[FAIL] TS transpile: ${(e.stderr || e.message || '').toString().slice(0, 2000)}`);
}
check('T1: TS sources transpile clean (real code, no mirrors)', transpiled);
if (!transpiled) {
  console.error('FATAL: cannot behaviorally verify TS without transpiled output');
  process.exit(2);
}
const GT = require(G_PATH);
const WN = require(W_PATH);
const SY = require(S_PATH);

// Baseline leader passing Gates 1–5 with n_eff = 100 headroom.
function baseLeader(over = {}) {
  return {
    distinct_riders: 20, distinct_drivers: 8, active_weeks: 4,
    cluster_weighted_votes: 72, total_query_weighted_votes: 100,
    total_query_sum_w_sq: 100, anchor_cell_share: 0.72,
    max_driver_share: 0.1, ...over,
  };
}

// ---------- A. Gates 1–4 boundaries (TC-009-01..04) ----------
{
  check('A1: TC-009-01 riders=14 REJECTS Gate 1',
    (() => { const v = GT.evaluateCandidateGates(baseLeader({ distinct_riders: 14 }), 0.28); return !v.passed && failsWith(v, 'Gate 1'); })());
  check('A2: riders=15 boundary passes Gate 1',
    !failsWith(GT.evaluateCandidateGates(baseLeader({ distinct_riders: 15 }), 0.28), 'Gate 1'));
  check('A3: TC-009-02 drivers=4 REJECTS Gate 2',
    (() => { const v = GT.evaluateCandidateGates(baseLeader({ distinct_drivers: 4 }), 0.28); return !v.passed && failsWith(v, 'Gate 2'); })());
  check('A4: TC-009-03 weeks=2 REJECTS Gate 3 (viral suppression)',
    (() => { const v = GT.evaluateCandidateGates(baseLeader({ active_weeks: 2 }), 0.28); return !v.passed && failsWith(v, 'Gate 3'); })());
  check('A5: TC-009-04 share 69.9% REJECTS Gate 4',
    (() => { const v = GT.evaluateCandidateGates(baseLeader({ cluster_weighted_votes: 69.9, anchor_cell_share: 0.699 }), 0.2); return !v.passed && failsWith(v, 'Gate 4'); })());
  check('A6: constants (15/5/3w/0.70/0.20/>0.5)',
    GT.GATE_MIN_RIDERS === 15 && GT.GATE_MIN_DRIVERS === 5 && GT.GATE_MIN_WEEKS === 3 &&
    GT.GATE_MIN_SHARE === 0.7 && GT.GATE_MIN_MARGIN === 0.2 && GT.GATE_WILSON_FLOOR === 0.5);
}

// ---------- B. Gate 5 + integrity (TC-009-05..07) ----------
{
  check('B1: TC-009-05 anchor 72% + runner 54% REJECTS (shares > 1)',
    (() => { const v = GT.evaluateCandidateGates(baseLeader(), 0.54); return !v.passed && failsWith(v, 'Integrity'); })());
  check('B2: TC-009-06 72/28 passes Gates 4+5 (margin 44)',
    (() => { const v = GT.evaluateCandidateGates(baseLeader(), 0.28); return v.passed && v.margin === 0.44; })());
  check('B3: TC-009-07 55/45 REJECTS Gate 5 ambiguity (margin 10)',
    (() => { const v = GT.evaluateCandidateGates(baseLeader({ cluster_weighted_votes: 55, anchor_cell_share: 0.55 }), 0.45); return !v.passed && failsWith(v, 'Gate 5'); })());
  check('B4: single-cell implied (no rival → margin 1)',
    GT.evaluateCandidateGates(baseLeader(), null).margin === 1);
}

// ---------- C. Wilson/Kish table verification (F-009-3) ----------
{
  // Construct (W, T, S) for exact (n_eff, p): S = T²/n_eff.
  const at = (nEff, p) => GT.computeKishWilsonLowerBound(p * 100, 100, 10000 / nEff);
  const approx = (got, want) => Math.abs(got - want) < 0.001;
  check('C1: n=15, p=0.70 → 0.4483 REJECT', approx(at(15, 0.7).w_lower, 0.4483) && at(15, 0.7).w_lower <= 0.5);
  check('C2: TC-009-09b n=23 → 0.4957 REJECT (≥23 claim false)', approx(at(23, 0.7).w_lower, 0.4957));
  check('C3: TC-009-09c n=24 → 0.49996 REJECT', approx(at(24, 0.7).w_lower, 0.49996) && at(24, 0.7).w_lower <= 0.5);
  check('C4: TC-009-09 n=25 → 0.5040 PASS', approx(at(25, 0.7).w_lower, 0.504) && at(25, 0.7).w_lower > 0.5);
  check('C5: (15, 0.85) → 0.6023', approx(at(15, 0.85).w_lower, 0.6023));
  check('C6: (100, 0.55) → 0.4524 REJECT', approx(at(100, 0.55).w_lower, 0.4524));
  check('C7: (8.2, 0.90) → 0.5603', approx(at(8.2, 0.9).w_lower, 0.5603));
  check('C8: strictly increasing in n at p=0.70', at(23, 0.7).w_lower < at(24, 0.7).w_lower && at(24, 0.7).w_lower < at(25, 0.7).w_lower);
  check('C9: degenerate inputs → zero (no NaN)',
    GT.computeKishWilsonLowerBound(0, 0, 0).w_lower === 0 && GT.computeKishWilsonLowerBound(5, 100, 0).n_eff === 0);
}

// ---------- D. Gate 6 end-to-end at the boundary ----------
{
  const mk = (sumSq) => ({
    distinct_riders: 20, distinct_drivers: 8, active_weeks: 4,
    cluster_weighted_votes: 70, total_query_weighted_votes: 100,
    total_query_sum_w_sq: sumSq, anchor_cell_share: 0.7, max_driver_share: 0.1,
  });
  const v25 = GT.evaluateCandidateGates(mk(400), 0.2); // n_eff = 25
  check('D1: n_eff=25, p=0.70 full PASS', v25.passed && v25.w_lower > 0.5);
  const v23 = GT.evaluateCandidateGates(mk(10000 / 23), 0.2);
  check('D2: n_eff=23 fails Gate 6 ONLY',
    !v23.passed && v23.gate_failures.length === 1 && failsWith(v23, 'Gate 6'));
  check('D3: verdict carries n_eff/margin/share',
    typeof v25.n_eff === 'number' && v25.margin === 0.5 && v25.vote_share === 0.7);
}

// ---------- E. Multi-cell binding (TC-009-14/15, F-009-2/F-009-4) ----------
{
  // TC-009-14: candidate cells A44/B31 (cluster 75%), rival C25 → margin 19 REJECT.
  const t14 = GT.evaluateCandidateGates({
    distinct_riders: 30, distinct_drivers: 8, active_weeks: 5,
    cluster_weighted_votes: 75, total_query_weighted_votes: 100,
    total_query_sum_w_sq: 100, anchor_cell_share: 0.44, max_driver_share: 0.1,
  }, 0.25);
  check('E1: TC-009-14 binding REJECT (margin 19 < 20)', !t14.passed && failsWith(t14, 'Gate 5') && t14.margin === 0.19);
  // TC-009-15: sprawling campus, anchor 62%, rival 15% → PASS.
  const t15 = GT.evaluateCandidateGates({
    distinct_riders: 40, distinct_drivers: 10, active_weeks: 6,
    cluster_weighted_votes: 80, total_query_weighted_votes: 100,
    total_query_sum_w_sq: 100, anchor_cell_share: 0.62, max_driver_share: 0.1,
  }, 0.15);
  check('E2: TC-009-15 ring candidate PASSES', t15.passed && t15.margin === 0.47);
  const disk = (c) => [c, `${c}+1`, `${c}+2`, `${c}+3`, `${c}+4`, `${c}+5`, `${c}+6`];
  const before = ['anchor'];
  const set = WN.cellSetFor('anchor', disk);
  check('E3: k=1 CellSet = 7 cells, inputs unmutated',
    set.size === 7 && set.has('anchor') && set.has('anchor+6') && before.length === 1);
  check('E4: RING_K = 1', WN.RING_K === 1);
}

// ---------- F. UUIDv4 permanence (F-009-1) ----------
{
  const ids = new Set(Array.from({ length: 500 }, () => WN.mintPlaceId()));
  check('F1: 500 mints unique + v4 shape', ids.size === 500 && [...ids].every((id) => WN.isUuidV4(id)));
  check('F2: never derived (same context → different IDs)', WN.mintPlaceId() !== WN.mintPlaceId());
  check('F3: rejects non-v4 (v1-ish, cell strings, names)',
    !WN.isUuidV4('6ba7b810-9dad-11d1-80b4-00c04fd430c8') && !WN.isUuidV4('cellA') &&
    !WN.isUuidV4('Star Kabab') && !WN.isUuidV4(''));
  check('F4: zero-arg mint (derivation impossible by construction)', WN.mintPlaceId.length === 0);
  const ws = read('services/winnerSelector.ts');
  check('F5: no UUIDv5 / name-derived identity', !/uuidv5|UUIDv5/.test(ws));
  check('F6: leaf_hash deterministic 64-hex', /^[0-9a-f]{64}$/.test(WN.leafHash('a', 'b', 'c', 'd')) && WN.leafHash('a', 'b', 'c', 'd') === WN.leafHash('a', 'b', 'c', 'd'));
}

// ---------- G. Two-cycle challenger + demote (TC-009-11/12, F-009-5) ----------
{
  const fresh = (over = {}) => ({ challengerClusterId: 'cl_c', incumbentPoiId: WN.mintPlaceId(), provisionalCycle: null, ...over });
  const m1 = WN.evaluateChallenger(fresh(), 'pub-2026-11', true);
  check('G1: TC-009-11 win in M → provisional', m1.outcome === 'provisional' && m1.state.provisionalCycle === 'pub-2026-11');
  const same = WN.evaluateChallenger(m1.state, 'pub-2026-11', true);
  check('G2: same-cycle re-win stays provisional (idempotent)', same.outcome === 'provisional');
  const m2 = WN.evaluateChallenger(m1.state, 'pub-2026-12', true);
  check('G3: TC-009-12 win in M+1 → SUPERSEDE + demote',
    m2.outcome === 'supersede' && m2.demoteIncumbentTo === 'demoted');
  const lost = WN.evaluateChallenger(m1.state, 'pub-2026-12', false);
  check('G4: loss in M+1 → incumbent holds, provisional cleared',
    lost.outcome === 'incumbent_holds' && lost.state.provisionalCycle === null);
  check('G5: fresh loss → rejected',
    WN.evaluateChallenger(fresh(), 'pub-2026-11', false).outcome === 'rejected');
  const inc = WN.mintPlaceId();
  const win = WN.mintPlaceId();
  const dem = WN.demoteIncumbent(inc, win);
  check('G6: demote keeps UUID, sets superseded_by (never deleted)',
    dem.poi_id === inc && dem.superseded_by === win && dem.new_status === 'demoted' && dem.previous_status === 'active');
  check('G7: retired variant', WN.demoteIncumbent(inc, win, true).new_status === 'retired');
  let bad = '';
  try { WN.demoteIncumbent(inc, inc); } catch (e) { bad = e.message; }
  check('G8: self-supersede refused', /must differ/.test(bad), bad);
  let bad2 = '';
  try { WN.demoteIncumbent('cellA', win); } catch (e) { bad2 = e.message; }
  check('G9: non-UUID refused', /UUIDv4/.test(bad2), bad2);
  check('G10: no DELETE path in module', !/DELETE\s+FROM/i.test(read('services/winnerSelector.ts')));
  check('G11: provisional name guard (cell names refused)',
    (() => { try { WN.assertProvisionalName('Learned Place 8f1234', '8f1234'); return false; } catch { return true; } })() &&
    (() => { WN.assertProvisionalName('Star Kabab Mor', '8f1234'); return true; })());
  const vr = WN.buildVersionRecord(inc, 'geometry refined', win);
  check('G12: lineage record (poi_versions shape)', vr.poi_id === inc && vr.superseded_by === win);
}

// ---------- H. Sybil & collusion caps (TC-009-10/16, §3.3) ----------
{
  const v = (rider, week, day, driver = 'd1') => ({ riderKey: rider, driverKey: driver, isoWeek: week, dayIndex: day, initialWeight: 1 });
  const same4 = [v('r1', '2026-W40', 0), v('r1', '2026-W40', 1), v('r1', '2026-W40', 2), v('r1', '2026-W40', 3)];
  const rc1 = SY.applyRiderCap(same4);
  check('H1: 1 vote/rider/week (4 same-week → 1 counted, 3 zero)',
    rc1.counted.length === 1 && rc1.zeroWeighted.length === 3);
  const weeks4 = [v('r1', '2026-W40', 0), v('r1', '2026-W41', 7), v('r1', '2026-W42', 14), v('r1', '2026-W43', 21)];
  const rc2 = SY.applyRiderCap(weeks4);
  check('H2: TC-009-16 4th vote in 90d → zero (3 counted, 1 excess)',
    rc2.counted.length === 3 && rc2.zeroWeighted.length === 1);
  const pair = [v('r1', '2026-W40', 0, 'dx'), v('r1', '2026-W41', 10, 'dx')];
  check('H3: pair 2nd trip within 30d → zero', SY.applyPairCap(pair).zeroWeighted.length === 1);
  const pairFar = [v('r1', '2026-W40', 0, 'dx'), v('r1', '2026-W45', 31, 'dx')];
  check('H4: pair trips 31d apart both counted', SY.applyPairCap(pairFar).counted.length === 2);
  check('H5: TC-009-10 driver 30% REJECTS cohort cap', SY.driverCohortPasses(30, 100) === false);
  check('H6: driver exactly 25% passes', SY.driverCohortPasses(25, 100) === true);
  let threw = '';
  try { SY.driverCohortShare(1, 0); } catch (e) { threw = e.message; }
  check('H7: zero-denominator throws', /totalVotes/.test(threw));
  const burst = [0, 0.2, 0.5, 0.9, 1.1, 1.5, 1.8, 20, 40, 60]; // 7/10 within 48h
  check('H8: >60% in 48h → quarantine', SY.isBurstQuarantined(burst) === true);
  check('H9: spread traffic passes', SY.isBurstQuarantined([0, 10, 20, 30, 40, 50, 60, 70, 80, 89]) === false);
  check('H10: empty → no quarantine', SY.isBurstQuarantined([]) === false);
  const supp = new Set(['cellX', 'pub_dead']);
  check('H11: suppression exact membership (Set, not Bloom)',
    SY.isSuppressed('cellX', supp) === true && SY.isSuppressed('cellY', supp) === false);
  check('H12: constants (1/30d, 1/wk, 3/90d, 25%, 60%/48h)',
    SY.PAIR_MAX_COUNTED === 1 && SY.PAIR_WINDOW_DAYS === 30 && SY.RIDER_WEEKLY_CAP === 1 &&
    SY.RIDER_90D_CAP === 3 && SY.DRIVER_COHORT_CAP === 0.25 &&
    SY.BURST_FRACTION === 0.6 && SY.BURST_WINDOW_HOURS === 48);
}

// ---------- I. Contract scans ----------
{
  const all = read('services/publicationGates.ts') + read('services/winnerSelector.ts') + read('services/sybilGuard.ts');
  check('I1: zero vendor SDKs', !/axios|@barikoi|googlemaps|meilisearch/i.test(all));
  check('I2: join discipline documented (view + anchor key + decay)',
    /v_active_cluster_evidence/.test(all) && /active_dedup_key/.test(all) && /calculate_decayed_weight/.test(all));
  check('I3: no flat-minute thresholds', !/\d+\s*min(ute)?s?\s*(threshold|gate|sla|budget)/i.test(all));
  check('I4: no ledger mutation in ring path', /never mutated/i.test(read('services/winnerSelector.ts')));
  check('I5: constants grep-visible', /GATE_MIN_RIDERS = 15/.test(all) && /n_eff (≥|>=) 25/.test(all));
}

console.log(`\nTOTAL: ${passed} assertions, ${process.exitCode ? 'FAILURES PRESENT' : '0 failures'}`);
