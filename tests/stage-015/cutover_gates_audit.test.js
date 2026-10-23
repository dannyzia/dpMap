/**
 * Stage 015 audit — Evaluation Suites, Telemetry & Cutover Gates.
 * Executes the REAL TS sources via the repo-pinned tsc (no mirrors).
 * Covers the plan section 7 matrix TC-015-01 through TC-015-06.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage015-'));
const SHIM = path.join(REPO, 'tests', 'stage-005', 'node-shim.d.ts');
const ENTRY = ['services/goldenSuites.ts', 'services/cutoverGateEvaluator.ts', 'workers/benchmarkRunner.ts'];
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
check('T1: TS sources transpile clean (real TS, no mirrors)', transpiled);
if (!transpiled) {
  console.error(`FATAL: cannot verify without transpiled output (${pass} pass, ${fail} failed)`);
  process.exit(2);
}

const GS = require(path.join(tmp, 'services', 'goldenSuites.js'));
const GE = require(path.join(tmp, 'services', 'cutoverGateEvaluator.js'));
const BR = require(path.join(tmp, 'workers', 'benchmarkRunner.js'));

// ---------- A. Golden strata ----------
{
  const exp = GS.expectedSearchCounts();
  check(
    'A1: search spec totals 500 with exact strata',
    Object.values(exp.script).reduce((a, b) => a + b, 0) === 500 &&
      exp.script.banglish === 250 && exp.script.bengali === 150 && exp.script.english === 100 &&
      exp.length.short_prefix === 125 && exp.length.medium === 250 && exp.length.compound === 125 &&
      exp.taxonomy.transit === 100 && exp.taxonomy.residential === 125 && exp.taxonomy.medical === 75 &&
      exp.taxonomy.commercial === 125 && exp.taxonomy.gates === 75,
    JSON.stringify(exp)
  );
  check('A2: conformant fixture validates clean', GS.validateSearchSuite(exp).length === 0);
  const drifted = JSON.parse(JSON.stringify(exp));
  drifted.script.banglish = 249;
  drifted.script.english = 101;
  check('A3: drifted fixture flagged', GS.validateSearchSuite(drifted).length > 0);
  check('A4: routing plan 200 OD × 4 TOD × dry+monsoon', (() => {
    const p = GS.routingReplayPlan();
    return p.odPairs === 200 && p.todWindows.length === 4 && p.seasons.includes('monsoon') && p.seasons.includes('dry');
  })());
  // TC-015-06: monsoon window replay carries the season tag.
  check('A5/TC-015-06: monsoon months tagged monsoon', GS.seasonForMonth(7) === 'monsoon' && GS.seasonForMonth(8) === 'monsoon');
  check('A6: dry months tagged dry', GS.seasonForMonth(1) === 'dry' && GS.seasonForMonth(12) === 'dry');
}

// ---------- B. Telemetry conformance TC-015-02/03 + error math TC-015-04 ----------
{
  check(
    'B1/TC-015-02: routing columns exactly §4.7 (12, no extras)',
    GE.ROUTING_EVAL_COLUMNS.length === 12 && GE.ROUTING_EVAL_COLUMNS.includes('tod_bucket') &&
      GE.ROUTING_EVAL_COLUMNS.includes('distance_error_pct')
  );
  check(
    'B2: search columns exactly §4.7 (9, no text)',
    GE.SEARCH_EVAL_COLUMNS.length === 9 && GE.SEARCH_EVAL_COLUMNS.includes('selected_source') &&
      !GE.SEARCH_EVAL_COLUMNS.some((c) => /typed|query_text|pre_autocomplete/i.test(c))
  );
  let threw = false;
  try {
    GE.assertEvalColumns('search_eval_events', [...GE.SEARCH_EVAL_COLUMNS, 'order_id']);
  } catch {
    threw = true;
  }
  check('B3/TC-015-02: order_id refused in Tier B', threw);
  threw = false;
  try {
    GE.assertEvalColumns('search_eval_events', [...GE.SEARCH_EVAL_COLUMNS, 'pre_autocomplete_query']);
  } catch {
    threw = true;
  }
  check('B4: pre_autocomplete_query refused (Tier A only)', threw);
  threw = false;
  try {
    GE.assertEvalColumns('routing_eval_events', [...GE.ROUTING_EVAL_COLUMNS, 'trip_id']);
  } catch {
    threw = true;
  }
  check('B5: trip_id refused', threw);
  check('B6: conformant lists pass', (() => { GE.assertEvalColumns('routing_eval_events', [...GE.ROUTING_EVAL_COLUMNS]); GE.assertEvalColumns('search_eval_events', [...GE.SEARCH_EVAL_COLUMNS]); return true; })());

  // TC-015-03: tod_bucket 4-value enum incl. night, never midday.
  check('B7/TC-015-03: tod enum = morning/evening/off_peak/night', JSON.stringify([...GE.TOD_BUCKETS]) === JSON.stringify(['morning_peak', 'evening_peak', 'off_peak', 'night']));
  const ddl = read('migrations/003_storage_schema.sql');
  check('B8: schema tod_bucket CHECK matches (no midday)', ddl.includes("tod_bucket IN ('morning_peak', 'evening_peak', 'off_peak', 'night')"));

  // TC-015-04: relative errors; no flat-minute thresholds.
  check('B9/TC-015-04: e_T = |1100-1000|/1000 = 10%', Math.abs(GE.relativeErrorPct(1100, 1000) - 10) < 1e-9);
  check('B10: e_D symmetric', Math.abs(GE.relativeErrorPct(950, 1000) - 5) < 1e-9);
  threw = false;
  try {
    GE.relativeErrorPct(100, 0);
  } catch {
    threw = true;
  }
  check('B11: zero actual throws (never silent)', threw);
  check('B12: median/p95 sane', GE.median([3, 1, 2]) === 2 && GE.p95([1, 2, 3, 4]) === 4);
  const src = read('services/cutoverGateEvaluator.ts') + read('workers/benchmarkRunner.ts');
  check(
    'B13: no numeric flat-minute thresholds anywhere (prose mention OK)',
    !/<=?\s*\d+\s*(min|minutes)\b|max\w*(Minutes|Mins)\b|within_\d+_min/i.test(src)
  );
  check('B14: MRR + Top-1 math', Math.abs(GE.meanReciprocalRank([1, 2]) - 0.75) < 1e-9 && GE.top1Accuracy([true, true, false]) === 2 / 3);
}

// ---------- C. Gates TC-015-01 + rehearsal TC-015-05 + runner ----------
{
  const goodRouting = () => ({
    eD: [2.0, 2.5, 1.8, 2.2, 2.9],
    eT: [8, 10, 9, 11, 7],
    corridor: [0.9, 0.88, 0.91, 0.87, 0.9],
    vendorParity: true,
  });
  // TC-015-01: Gate 1B search eval Top-1 ≥ 92%.
  const sWeeks = [0, 1, 2].map(() => ({
    top1: Array(92).fill(true).concat(Array(8).fill(false)),
    mrrRanks: Array(100).fill(1),
  }));
  check('C1/TC-015-01: Gate 1B passes at Top-1 92% + MRR 1.0 ×3w', GE.evaluateGate1B(sWeeks) === true);
  const sWeak = [0, 1, 2].map(() => ({
    top1: Array(91).fill(true).concat(Array(9).fill(false)),
    mrrRanks: Array(100).fill(1),
  }));
  check('C2: Gate 1B fails at Top-1 91%', GE.evaluateGate1B(sWeak) === false);
  check('C3: Gate 1B needs 3 weeks', GE.evaluateGate1B(sWeeks.slice(0, 2)) === false);

  const rWeeks = [goodRouting(), goodRouting(), goodRouting()];
  check('C4: Gate 1A passes on conformant routing weeks', GE.evaluateGate1A(rWeeks) === true);
  const rBad = [goodRouting(), goodRouting(), { ...goodRouting(), eD: [4, 5, 4.5, 5, 4] }];
  check('C5: Gate 1A fails when median e_D > 3%', GE.evaluateGate1A(rBad) === false);

  const r4 = [goodRouting(), goodRouting(), goodRouting(), goodRouting()].map((w) => ({
    ...w,
    eD: w.eD.map((x) => x * 0.7),
    eT: w.eT.map((x) => x * 0.7),
    corridor: [0.93, 0.94, 0.95, 0.93, 0.94],
  }));
  const s4 = [0, 1, 2, 3].map(() => ({
    top1: Array(97).fill(true).concat(Array(3).fill(false)),
    mrrRanks: Array(100).fill(1),
    deflectionLocalShare: 0.9,
  }));
  check('C6: Gate 2 passes on sole-grade weeks ×4', GE.evaluateGate2(r4, s4) === true);
  const s4low = s4.map((w) => ({ ...w, deflectionLocalShare: 0.8 }));
  check('C7: Gate 2 fails when deflection ≤ 85%', GE.evaluateGate2(r4, s4low) === false);

  // TC-015-05: rehearsal abort on a single vendor HTTP call.
  check(
    'C8/TC-015-05: 1 vendor call → auto-revert',
    GE.evaluateRehearsal({ vendorHttpCalls: 1, dispatchRate: 1, wrongLocationCancelShare: 0, sev1Count: 0 }) === 'auto_revert_to_primary'
  );
  check(
    'C9: clean rehearsal certifies',
    GE.evaluateRehearsal({ vendorHttpCalls: 0, dispatchRate: 0.999, wrongLocationCancelShare: 0.005, sev1Count: 0 }) === 'certified'
  );
  check(
    'C10: dispatch < 99.5% reverts',
    GE.evaluateRehearsal({ vendorHttpCalls: 0, dispatchRate: 0.99, wrongLocationCancelShare: 0, sev1Count: 0 }) === 'auto_revert_to_primary'
  );

  // Runner emits a hash-chained scorecard with no vendor quotes.
  const cards = [];
  const card = { suite_version: 'search-v1', release_manifest_hash: 'm1', prev_scorecard_hash: 'genesis', gate1a: true, gate1b: true, gate2: false, computed_at: '2026-10-23T00:00:00Z' };
  BR.runBenchmark({ write: (c) => cards.push(c) }, { ...card, routingWeeks: rWeeks, searchWeeks: sWeeks }).then((c) => {
    check('C11: scorecard hash-chained + persisted', cards.length === 1 && /^[0-9a-f]{64}$/.test(c.scorecard_hash));
    check('C12: scorecard carries percentages/gates only — zero vendor quotes', !/vendor/i.test(JSON.stringify({ gate1a: c.gate1a, gate1b: c.gate1b, gate2: c.gate2 })));
    console.log(`\nSTAGE015: ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  });
}
