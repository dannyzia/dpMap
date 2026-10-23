/**
 * Master dpMaps Test Suite Runner.
 * Executes:
 *   1. Stage 001 Pin Tool Audit (tools/poi-tool/audit_test.js)
 *   2. Stage 002 Clean-Room Canary Isolation (utils-server/canaryIsolation.test.js)
 *   3. Stages 003–016 Complete Architectural Audit Suites (tests/stage-XXX/)
 *   4. Live Pin Tool Server Integration Smoke Test (tests/e2e/live_pin_tool_smoke.js)
 *   5. Master End-to-End Production Readiness Suite (tests/e2e/production_readiness_e2e.test.js)
 */
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

const SUITES = [
  { name: 'Stage 001 — Pin Tool Unit Audit', file: 'tools/poi-tool/audit_test.js' },
  { name: 'Stage 002 — Clean-Room Canary Isolation', file: 'utils-server/canaryIsolation.test.js' },
  { name: 'Stage 003 — Storage Schema & Ledger', file: 'tests/stage-003/storage_schema_audit.test.js' },
  { name: 'Stage 004 — OSRM Routing & Dynamic Speeds', file: 'tests/stage-004/osrm_routing_audit.test.js' },
  { name: 'Stage 005 — Dispatch Router & Shadow Modes', file: 'tests/stage-005/dispatch_router_audit.test.js' },
  { name: 'Stage 006 — Vector Tiles & Bengali Glyphs', file: 'tests/stage-006/bengali_shaping_audit.test.js' },
  { name: 'Stage 007 — Text Normalizer & Entity Locker', file: 'tests/stage-007/normalization_audit.test.js' },
  { name: 'Stage 008 — MeiliSearch Autocomplete Engine', file: 'tests/stage-008/meilisearch_autocomplete_audit.test.js' },
  { name: 'Stage 009 — Winner Selection & Wilson Score', file: 'tests/stage-009/winner_selection_audit.test.js' },
  { name: 'Stage 010 — Naming Engine & Bilingual Gate', file: 'tests/stage-010/naming_engine_audit.test.js' },
  { name: 'Stage 011 — Privacy Architecture & Takedowns', file: 'tests/stage-011/privacy_takedowns_audit.test.js' },
  { name: 'Stage 012 — Anti-Manipulation & Sybil Filter', file: 'tests/stage-012/anti_manipulation_audit.test.js' },
  { name: 'Stage 013 — Geocoding & Gate Snapping', file: 'tests/stage-013/geocoding_snapping_audit.test.js' },
  { name: 'Stage 014 — Saved Places Migration Engine', file: 'tests/stage-014/saved_places_audit.test.js' },
  { name: 'Stage 015 — Evaluation Suites & Cutover Gates', file: 'tests/stage-015/cutover_gates_audit.test.js' },
  { name: 'Stage 016 — Infrastructure Sizing & Runbooks', file: 'tests/stage-016/infrastructure_runbooks_audit.test.js' },
  { name: 'Live E2E — Pin Tool Server Live Smoke Test', file: 'tests/e2e/live_pin_tool_smoke.js' },
  { name: 'Master E2E — Production Readiness Full Lifecycle', file: 'tests/e2e/production_readiness_e2e.test.js' },
];

console.log('================================================================');
console.log('            dpMaps Master Production Test Runner               ');
console.log('================================================================\n');

let passedSuites = 0;
let failedSuites = 0;
const startTotal = Date.now();

for (const s of SUITES) {
  process.stdout.write(`• Running: ${s.name.padEnd(52)} `);
  const start = Date.now();
  try {
    const out = execFileSync(process.execPath, [path.join(REPO, s.file)], {
      cwd: REPO,
      stdio: 'pipe',
      timeout: 60000,
    }).toString();
    const duration = ((Date.now() - start) / 1000).toFixed(2);

    // Extract assertion counts if present
    const match = out.match(/(\d+)\s+assertions/i) ||
                  out.match(/(\d+)\s+tests passed/i) ||
                  out.match(/passed:\s*(\d+)/i) ||
                  out.match(/Passed\s*:\s*(\d+)/i);
    const countInfo = match ? `(${match[1]} checks, ${duration}s)` : `(${duration}s)`;
    console.log(`[PASS] ${countInfo}`);
    passedSuites++;
  } catch (err) {
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[FAIL] (${duration}s)`);
    console.error(`  Error in ${s.file}:\n`, (err.stdout || err.stderr || err.message).toString().slice(0, 1000));
    failedSuites++;
  }
}

const totalDuration = ((Date.now() - startTotal) / 1000).toFixed(2);
console.log('\n================================================================');
console.log(`Test Execution Summary:`);
console.log(`  Suites Executed : ${SUITES.length}`);
console.log(`  Suites Passed   : ${passedSuites}`);
console.log(`  Suites Failed   : ${failedSuites}`);
console.log(`  Total Time      : ${totalDuration}s`);
console.log('================================================================');

if (failedSuites > 0) {
  console.error('\nOVERALL RESULT: FAILED (Some test suites did not pass).');
  process.exit(1);
} else {
  console.log('\nOVERALL RESULT: 100% PASSING. SYSTEM IS VERIFIED PRODUCTION READY.');
  process.exit(0);
}
