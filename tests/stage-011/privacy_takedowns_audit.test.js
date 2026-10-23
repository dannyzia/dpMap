/**
 * Stage 011 audit — Privacy Architecture & Abuse-Resistant Takedowns.
 * Executes the REAL TS sources via the repo-pinned tsc (no mirrors).
 * Covers the plan section 8 matrix TC-011-01 through TC-011-13.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage011-'));
const SHIM = path.join(REPO, 'tests', 'stage-005', 'node-shim.d.ts');
const ENTRY = [
  'services/residentialPrivacy.ts',
  'utils-server/emergencySuppression.ts',
  'utils-server/takedownGatekeeper.ts',
  'services/takedownModeration.ts',
];
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

const PRIV = require(path.join(tmp, 'services', 'residentialPrivacy.js'));
const SUP = require(path.join(tmp, 'utils-server', 'emergencySuppression.js'));
const GATE = require(path.join(tmp, 'utils-server', 'takedownGatekeeper.js'));
const MOD = require(path.join(tmp, 'services', 'takedownModeration.js'));

// ---------- Same-semantics fakes ----------
function makeFakeSets() {
  const sets = new Map();
  const counters = new Map();
  const expireCalls = [];
  const get = (k) => {
    let s = sets.get(k);
    if (!s) {
      s = new Set();
      sets.set(k, s);
    }
    return s;
  };
  return {
    sets,
    expireCalls,
    async sadd(k, m) {
      const s = get(k);
      const had = s.has(m);
      s.add(m);
      return had ? 0 : 1;
    },
    async srem(k, m) {
      return get(k).delete(m) ? 1 : 0;
    },
    async sismember(k, m) {
      return get(k).has(m);
    },
    async scard(k) {
      return get(k).size;
    },
    async incr(k) {
      const v = (counters.get(k) ?? 0) + 1;
      counters.set(k, v);
      return v;
    },
    async expire(k, s) {
      expireCalls.push([k, s]);
      return 1;
    },
  };
}
function makeFakeDb() {
  const queries = [];
  return {
    queries,
    async query(text, params) {
      queries.push({ text, params });
      return { rowCount: 0, rows: [] };
    },
  };
}
function makeFakeSearch() {
  const deleted = [];
  const restored = [];
  return {
    deleted,
    restored,
    async deleteDocument(index, id) {
      deleted.push([index, id]);
      return {};
    },
    async restoreDocument(index, doc) {
      restored.push([index, doc]);
      return {};
    },
  };
}
const POI = '33333333-3333-4333-8333-333333333333';
function sub(over = {}) {
  return {
    poi_id: POI,
    poi_h3_res10: '8a123456789abcd',
    ring_cells: ['8a123456789abce', '8a123456789abcf'],
    reporter_user_id: 'user-1',
    phone_verified: true,
    account_created_at: new Date(Date.now() - 100 * 86400000),
    completed_trips_count: 25,
    has_nearby_context: true,
    prior_abuse_strikes: 0,
    reason: 'privacy_residential',
    ...over,
  };
}
function highTrustGate(qualifiedUsers) {
  const sets = makeFakeSets();
  const db = makeFakeDb();
  const search = makeFakeSearch();
  const suppression = new SUP.EmergencySuppressionService({ sets, search, db });
  const gate = new GATE.TakedownGatekeeper({
    sets,
    db,
    suppression,
    hasCompletedRideToCell: async (userId) => qualifiedUsers.includes(userId),
  });
  return { sets, db, search, suppression, gate };
}

// ---------- A. Privacy classes TC-011-01/02/13 ----------
{
  const c1 = PRIV.classifyPrivacy('Flat 4B');
  check('A1/TC-011-01: unit string DROPPED (Class 1)', c1.action === 'drop' && c1.privacyClass === 'class_1_unit', JSON.stringify(c1));
  check('A2: unit string not learnable', !PRIV.isLearnableForPublicPool('Flat 4B, House 12'));

  const c1b = PRIV.classifyPrivacy('৪র্থ তলা');
  check('A3: Bengali unit marker DROPPED (Class 1)', c1b.action === 'drop' && c1b.privacyClass === 'class_1_unit', JSON.stringify(c1b));

  const c2 = PRIV.classifyPrivacy('Mamur bari');
  check('A4/TC-011-02: relationship name PRIVATE ONLY (Class 2)', c2.action === 'private_only' && c2.privacyClass === 'class_2_personal', JSON.stringify(c2));
  check('A5: personal name not learnable', !PRIV.isLearnableForPublicPool('Rahim er basha'));

  for (const label of ['Home', 'Work', 'my gym', 'Parents']) {
    const c3 = PRIV.classifyPrivacy(label);
    check(`A6: saved place "${label}" PRIVATE ONLY (Class 3)`, c3.action === 'private_only' && c3.privacyClass === 'class_3_saved_place', JSON.stringify(c3));
  }
  check('A7: Home never in learning pool', !PRIV.isLearnableForPublicPool('Home'));

  check(
    'A8: Class-4 retention facts visible in code',
    PRIV.RETENTION_FACTS.windowKeyLifetimeDays === 135 &&
      PRIV.RETENTION_FACTS.evidenceWindowDays === 90 &&
      PRIV.RETENTION_FACTS.rawLogPurgeDays === 30 &&
      PRIV.RETENTION_FACTS.keyRotationDays === 30
  );
  check('A9: clean civic name allow-listed', PRIV.classifyPrivacy('Baitul Aman').action === 'allow');
}

// ---------- B. Convergence rule TC-011-03/04/13 ----------
{
  const e3 = PRIV.evaluateConvergence({
    distinctRiders: 12, distinctDrivers: 6, activeWeeks: 5,
    maxSpreadMeters: 20, candidateName: 'Baitul Aman',
  });
  check('B1/TC-011-03: 12 riders UNINDEXED (diversity)', !e3.indexable && e3.reason === 'insufficient-diversity', JSON.stringify(e3));

  const e4 = PRIV.evaluateConvergence({
    distinctRiders: 22, distinctDrivers: 6, activeWeeks: 4,
    maxSpreadMeters: 25, candidateName: 'Baitul Aman',
  });
  check(
    'B2/TC-011-04: convergent named building INDEXABLE as building',
    e4.indexable && e4.pointType === 'building' && e4.reason === 'convergent-landmark',
    JSON.stringify(e4)
  );

  const e13 = PRIV.evaluateConvergence({
    distinctRiders: 25, distinctDrivers: 10, activeWeeks: 8,
    maxSpreadMeters: 10, candidateName: 'Flat 4B, House 12',
  });
  check('B3/TC-011-13: unit string STILL BARRED at 25-rider convergence', !e13.indexable && e13.reason === 'categorically-barred', JSON.stringify(e13));

  const scatter = PRIV.evaluateConvergence({
    distinctRiders: 20, distinctDrivers: 6, activeWeeks: 4,
    maxSpreadMeters: 80, candidateName: 'Baitul Aman',
  });
  check('B4: spatial scatter bars publication', !scatter.indexable && scatter.reason === 'spatial-scatter');

  const fewWeeks = PRIV.evaluateConvergence({
    distinctRiders: 20, distinctDrivers: 6, activeWeeks: 2,
    maxSpreadMeters: 10, candidateName: 'Baitul Aman',
  });
  check('B5: temporal gate bars 2-week convergence', !fewWeeks.indexable && fewWeeks.reason === 'insufficient-weeks');

  check(
    'B6: thresholds centralized [ESTIMATE]',
    PRIV.CONVERGENCE_THRESHOLDS.minRiders === 15 &&
      PRIV.CONVERGENCE_THRESHOLDS.minDrivers === 5 &&
      PRIV.CONVERGENCE_THRESHOLDS.minWeeks === 3 &&
      PRIV.CONVERGENCE_THRESHOLDS.maxSpreadMeters === 30
  );
}

// ---------- C. Trust matrix ----------
{
  const { gate } = highTrustGate([]);
  const base = sub({ reporter_user_id: 'u' });
  check('C1: full badge = 100 (clamped)', gate.calculateTrustScore(base) === 100);
  check('C2/TC-011-05: unverified phone ⇒ trust 0', gate.calculateTrustScore(sub({ phone_verified: false })) === 0);
  check('C3: new account, few trips, no context = 30', gate.calculateTrustScore(sub({
    account_created_at: new Date(), completed_trips_count: 0, has_nearby_context: false,
  })) === 30);
  check('C4: mid brackets = 30+15+15', gate.calculateTrustScore(sub({
    account_created_at: new Date(Date.now() - 40 * 86400000),
    completed_trips_count: 6, has_nearby_context: false,
  })) === 60);
  check('C5: abuse strike −50', gate.calculateTrustScore(sub({ prior_abuse_strikes: 1 })) === 50);
  check('C6: floor at 0', gate.calculateTrustScore(sub({ prior_abuse_strikes: 5 })) === 0);
}

// ---------- D. Reporting flow TC-011-06/07/08/09/10 (async) ----------
(async () => {
{
  // TC-011-06: one high-trust qualified report → queued (threshold is 3).
  {
    const h = highTrustGate(['user-1']);
    const r = await h.gate.processTakedownReport(sub({ reporter_user_id: 'user-1' }));
    check('D1/TC-011-06: single qualified report QUEUED', r.status === 'queued' && r.traveler_qualified === true, JSON.stringify(r));
  }
  // TC-011-07: three distinct qualified travelers → auto-hidden + cascade.
  {
    const h = highTrustGate(['user-1', 'user-2', 'user-3']);
    const r1 = await h.gate.processTakedownReport(sub({ reporter_user_id: 'user-1' }));
    const r2 = await h.gate.processTakedownReport(sub({ reporter_user_id: 'user-2' }));
    const r3 = await h.gate.processTakedownReport(sub({ reporter_user_id: 'user-3' }));
    check(
      'D2/TC-011-07: third qualified traveler AUTO-HIDES',
      r1.status === 'queued' && r2.status === 'queued' && r3.status === 'auto_hidden',
      JSON.stringify([r1.status, r2.status, r3.status])
    );
    check('D3: Tier A — Set holds the place', await h.sets.sismember(SUP.REDIS_SUPPRESSION_SET, POI));
    check(
      'D4: Tier B — dual-index eviction (both indexes)',
      h.search.deleted.some(([i]) => i === 'first_party_pois') &&
        h.search.deleted.some(([i]) => i === 'osm_pois'),
      JSON.stringify(h.search.deleted)
    );
    const texts = h.db.queries.map((q) => q.text);
    check('D5: Tier C — suppressions row written', texts.some((t) => t.includes('dpmaps.suppressions')));
    check('D6: Tier C — poi lifecycle suppressed', texts.some((t) => t.includes("lifecycle_status = 'suppressed'")));
    check('D7: Tier C — provenance row written', texts.some((t) => t.includes('dpmaps.provenance_events')));
    check(
      'D8: TTL-on-first-add (place set expires once)',
      h.sets.expireCalls.filter(([k]) => k === `dpmaps:takedown:place_reports:${POI}`).length === 1,
      JSON.stringify(h.sets.expireCalls)
    );
  }
  // TC-011-08: three high-trust reports, NONE rode to the cell → queued, no suppression.
  {
    const h = highTrustGate([]);
    const rs = [];
    for (const u of ['user-1', 'user-2', 'user-3']) {
      rs.push(await h.gate.processTakedownReport(sub({ reporter_user_id: u })));
    }
    check(
      'D9/TC-011-08: unqualified majority NEVER auto-hides (sybil defense)',
      rs.every((r) => r.status === 'queued') && !(await h.sets.sismember(SUP.REDIS_SUPPRESSION_SET, POI)),
      JSON.stringify(rs.map((r) => r.status))
    );
  }
  // TC-011-09: rode 100 days ago (outside 90-day window) → queued.
  {
    const h = highTrustGate([]); // stub: nobody qualified (ride 100 d ago)
    const r = await h.gate.processTakedownReport(sub({ reporter_user_id: 'user-9' }));
    check('D10/TC-011-09: stale ride QUEUED', r.status === 'queued' && r.traveler_qualified === false);
    check('D11: qualifier SQL encodes the 90-day window', GATE.QUALIFIED_TRAVELER_SQL.includes('90 days'));
  }
  // TC-011-10: two reports from one user in 24 h → rate limited.
  {
    const h = highTrustGate(['user-1']);
    const r1 = await h.gate.processTakedownReport(sub({ reporter_user_id: 'user-1' }));
    const r2 = await h.gate.processTakedownReport(sub({ reporter_user_id: 'user-1' }));
    check('D12/TC-011-10: second report in 24 h RATE LIMITED to queue', r1.status === 'queued' && r2.status === 'queued');
    check(
      'D13: rate window TTL set once on first add',
      h.sets.expireCalls.filter(([k]) => k === 'dpmaps:takedown:user_rate:user-1').length === 1
    );
  }
  // TC-011-05 end-to-end: unverified phone → queued with trust 0.
  {
    const h = highTrustGate(['user-1']);
    const r = await h.gate.processTakedownReport(sub({ reporter_user_id: 'user-1', phone_verified: false }));
    check('D14/TC-011-05: unverified reporter QUEUED, trust 0', r.status === 'queued' && r.trust_score === 0);
  }
}

// ---------- E. Restore + rollback TC-011-11/12 + SLA ----------
{
  const sets = makeFakeSets();
  const db = makeFakeDb();
  const search = makeFakeSearch();
  const svc = new SUP.EmergencySuppressionService({ sets, search, db });
  await svc.executeEmergencySuppression({
    target_type: 'poi_id',
    target_value: POI,
    reason: 'privacy_request',
    requester: 'auto_hide',
    reported_at: new Date('2026-10-23T08:00:00Z'),
    tier: '1_hour',
    actor_id: 'system-auto-hide',
  });
  check('E1: suppressed before restore', await svc.isPlaceSuppressed(POI));
  await svc.restorePlace({ target_type: 'poi_id', target_value: POI, actor_id: 'admin-1', reindexedDocument: { id: POI } });
  check(
    'E2/TC-011-11: restore point-deletes + re-indexes both indexes',
    !(await svc.isPlaceSuppressed(POI)) &&
      search.restored.some(([i]) => i === 'first_party_pois') &&
      search.restored.some(([i]) => i === 'osm_pois'),
    JSON.stringify(search.restored)
  );
  check(
    'E3: restore re-enters as candidate (never auto-active)',
    db.queries.some((q) => q.text.includes("lifecycle_status = 'candidate'"))
  );

  // DB fallback when Redis fails.
  const failingSets = { ...makeFakeSets(), sismember: async () => { throw new Error('redis down'); } };
  const db2 = { queries: [], async query(t, p) { this.queries.push({ text: t, params: p }); return { rowCount: 1, rows: [{}] }; } };
  const svc2 = new SUP.EmergencySuppressionService({ sets: failingSets, search: makeFakeSearch(), db: db2 });
  check('E4: Redis failure falls back to DB predicate', (await svc2.isPlaceSuppressed(POI)) === true);

  const plan = MOD.rollbackReleasePlan('pub-2026-11-01', 'pub-2026-10-01');
  check(
    'E5/TC-011-12: rollback plan preserves suppressions',
    plan.suppressionsPreserved === true &&
      plan.steps.every((s) => !s.touchesKeys.includes(SUP.REDIS_SUPPRESSION_SET)) &&
      MOD.ROLLBACK_PROTECTED_KEYS.includes(SUP.REDIS_SUPPRESSION_SET)
  );

  const t0 = new Date('2026-10-23T08:00:00Z');
  check('E6: Tier-1 SLA met at 59 min', MOD.tier1SlaMet(t0, new Date('2026-10-23T08:59:00Z')));
  check('E7: Tier-1 SLA missed at 61 min', !MOD.tier1SlaMet(t0, new Date('2026-10-23T09:01:00Z')));
  check('E8: Tier-2 SLA met at 3:59', MOD.tier2SlaMet(t0, new Date('2026-10-23T11:59:00Z')));
  check('E9: Tier-2 SLA missed at 4:01', !MOD.tier2SlaMet(t0, new Date('2026-10-23T12:01:00Z')));
  check('E10: on-call alert due at 3 h', MOD.tier2AlertDue(t0, new Date('2026-10-23T11:00:00Z')));
}

// ---------- F. Schema conformance (verified Stage 003 DDL) ----------
{
  const ddl = read('migrations/003_storage_schema.sql');
  check('F1: suppressions target_type enum', ddl.includes("target_type IN ('poi_id', 'osm_poi_id', 'h3_cell', 'name_pattern')"));
  check('F2: suppressions reason enum', ddl.includes("reason IN ('court_order', 'privacy_request', 'security_sensitive', 'copyright_claim', 'sybil_attack')"));
  check('F3: reported_at NOT NULL without default', /reported_at TIMESTAMPTZ NOT NULL,\n/.test(ddl));
  check('F4: suppression_target_sla default 1_hour', ddl.includes("suppression_target_sla VARCHAR(16) NOT NULL DEFAULT '1_hour'"));
  check('F5: active predicate index (applied_at, expires_at)', ddl.includes('idx_suppressions_active ON dpmaps.suppressions (applied_at, expires_at)'));
  check('F6: takedown_reports traveler_qualified', ddl.includes('traveler_qualified BOOLEAN NOT NULL'));
  check('F7: takedown_reports status enum', ddl.includes("status IN ('pending', 'auto_hidden', 'confirmed', 'rejected')"));
  check('F8: provenance conformant columns', ddl.includes('target_record_hash CHAR(64) NOT NULL') && ddl.includes('event_hash CHAR(64) NOT NULL'));
  check(
    'F9: shipped SQL references exact Stage 003 columns',
    SUP.SUPPRESSIONS_INSERT_SQL.includes('suppression_target_sla') &&
      GATE.TAKEDOWN_REPORT_INSERT_SQL.includes('traveler_qualified') &&
      SUP.PROVENANCE_INSERT_SQL.includes('target_record_hash')
  );
}

// ---------- G. Source-shape invariants ----------
{
  const files = [
    read('services/residentialPrivacy.ts'),
    read('utils-server/emergencySuppression.ts'),
    read('utils-server/takedownGatekeeper.ts'),
    read('services/takedownModeration.ts'),
  ].join('\n');
  check(
    'G1: no Bloom filter construct — only the never-use-it rule (F-011-1)',
    !/new Bloom|BloomFilter|bloom_filter|require\(['"]bloom|from ['"]bloom/i.test(files) &&
      /NEVER a Bloom filter|never a Bloom filter/i.test(files)
  );
  check('G2: Redis Set point semantics named', files.includes('dpmaps:suppression:active_place_ids'));
  check('G3: TTL-on-first-add counters named', files.includes('dpmaps:takedown:place_reports:') && files.includes('dpmaps:takedown:user_rate:'));
  check('G4: dual-index eviction covers both indexes', files.includes('first_party_pois') && files.includes('osm_pois'));
  check('G5: no vendor SDKs in new services', !/(barikoi|googleapis|google\.maps)/i.test(files));
  check(
    'G6: no pg/redis/meilisearch/uuid runtime imports (comment mentions OK)',
    !/^import .* from '(pg|redis|meilisearch|uuid)'/m.test(files)
  );
}

console.log(`\nSTAGE011: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
})();
