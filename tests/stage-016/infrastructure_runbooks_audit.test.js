/**
 * Stage 016 audit — Infrastructure Deployment, HA & SRE Runbooks.
 * Executes the REAL TS sources via the repo-pinned tsc (no mirrors).
 * Covers the order scope: sizing physics, runbooks A–D guarantees + SLAs,
 * mode rollback with suppression preservation.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage016-'));
const SHIM = path.join(REPO, 'tests', 'stage-005', 'node-shim.d.ts');
const ENTRY = ['services/infrastructureSizing.ts', 'services/sreRunbooks.ts'];
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

const SZ = require(path.join(tmp, 'services', 'infrastructureSizing.js'));
const RB = require(path.join(tmp, 'services', 'sreRunbooks.js'));

// ---------- A. Sizing physics ----------
{
  check('A1: steady footprint 3 × 2.5 GB', Math.abs(SZ.osrmSteadyGb() - 7.5) < 1e-9);
  check('A2: Blue/Green reload ≈ 15 GB', Math.abs(SZ.osrmReloadGb() - 15) < 1e-9);
  check('A3: Phase-1 OSRM 32 GB holds reload with headroom', SZ.osrmPrimaryFitsReload('phase1') === true);
  check('A4: dev 16 GB holds reload (tier floor)', SZ.osrmPrimaryFitsReload('dev') === true);
  check('A5: every tier ≥ 16 GB on OSRM primary', ['dev', 'phase1', 'phase2', 'scale'].every((t) => SZ.SIZING_MATRIX[t].osrmPrimary.ramGb >= 16));
  check('A6: Phase-1 spec 8 vCPU / 32 GB / 200 GB NVMe / 1 Gbps', (() => {
    const n = SZ.SIZING_MATRIX.phase1.osrmPrimary;
    return n.vcpu === 8 && n.ramGb === 32 && n.nvmeGb === 200 && n.networkGbps === 1;
  })());
  check('A7: HA duplication from phase2 (meili/pg/redis ×2)', SZ.haDuplicated('phase2') && SZ.haDuplicated('scale') && !SZ.haDuplicated('phase1'));
  check('A8: network rows present on every node', Object.values(SZ.SIZING_MATRIX.phase1).every((n) => n.networkGbps >= 1));
  check('A9: engine ports car:5001 bike:5002 cng:5003', SZ.OSRM_ENGINE_PORTS.car === 5001 && SZ.OSRM_ENGINE_PORTS.bike === 5002 && SZ.OSRM_ENGINE_PORTS.cng === 5003);
  check('A10: cutover budget 300 ms + 3-strike breaker', SZ.FAILOVER_CUTOVER_BUDGET_MS === 300 && SZ.CIRCUIT_BREAKER_STRIKES === 3);
}

// ---------- B. Runbooks A–D ----------
{
  // Runbook A.
  const a1 = RB.runbookAFailover({ consecutiveStrikes: 3, measuredCutoverMs: 120, standbyHealthy: true });
  check('B1: 3 strikes + healthy standby → promote', a1.failover && a1.reason === 'standby-promoted');
  check('B2: 2 strikes → hold', RB.runbookAFailover({ consecutiveStrikes: 2, measuredCutoverMs: 50, standbyHealthy: true }).failover === false);
  const a3 = RB.runbookAFailover({ consecutiveStrikes: 5, measuredCutoverMs: 120, standbyHealthy: false });
  check('B3: standby down → waterfall absorbs', !a3.failover && a3.absorbViaWaterfall);
  check('B4: over-budget cutover escalates', RB.runbookAFailover({ consecutiveStrikes: 3, measuredCutoverMs: 900, standbyHealthy: true }).reason === 'cutover-over-budget-escalate');
  check('B5: MTTR < 5 min', RB.runbookAMttrMet(4) && !RB.runbookAMttrMet(6));

  // Runbook B constants.
  check('B6: Tier-1 SLA 1 h + 60 s engineering target + fp-poi tag + 30 s purge', RB.RUNBOOK_B_SLA_MS === 3600000 && RB.RUNBOOK_B_ENGINEERING_TARGET_S === 60 && RB.RUNBOOK_B_CACHE_TAG === 'fp-poi' && RB.RUNBOOK_B_PURGE_BUDGET_S === 30);

  // Runbook C.
  check('B7: rollback primary→shadow→off', RB.runbookCNextMode(2, 'down') === 1 && RB.runbookCNextMode(1, 'down') === 0 && RB.runbookCNextMode(0, 'down') === 0);
  check('B8: rollback NEVER clears suppression set', RB.runbookCPreservesSuppressions(['some:other:key']) && !RB.runbookCPreservesSuppressions(['dpmaps:suppression:active_place_ids']));
  check('B9: runbook C doc names the invariant', /NEVER cleared/.test(read('docs/runbooks/RUNBOOKS_A_D.md')));

  // Runbook D.
  check('B10: rebuild overdue at 2× cadence', RB.runbookDRebuildOverdue(60) && !RB.runbookDRebuildOverdue(59));
  check(
    'B11: D complete only when all six steps done',
    RB.runbookDComplete({ extractVerified: true, profilesBuilt: true, blueGreenSwapped: true, geometryAuditSubset: true, goldenReplayPassed: true, manifestHashRecorded: true }) &&
      !RB.runbookDComplete({ extractVerified: true, profilesBuilt: true, blueGreenSwapped: true, geometryAuditSubset: true, goldenReplayPassed: false, manifestHashRecorded: true })
  );
  check('B12: D cadence monthly default', RB.RUNBOOK_D_CADENCE_DAYS === 30 && RB.RUNBOOK_D_REBUILD_ALERT_MULTIPLE === 2);
}

// ---------- C. Cross-links to built stages ----------
{
  const mod = read('services/sreRunbooks.ts');
  check('C1: runbook C references the Stage 011 suppression set (shared constant)', mod.includes('REDIS_SUPPRESSION_SET'));
  check('C2: no infra SDK imports (docs + pure guards)', !/^import .* from '(pg|ioredis|redis|aws-sdk|@aws-sdk)'/m.test(mod));
  check('C3: docs cover all four runbooks', ['Runbook A', 'Runbook B', 'Runbook C', 'Runbook D'].every((h) => read('docs/runbooks/RUNBOOKS_A_D.md').includes(h)));
}

console.log(`\nSTAGE016: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
