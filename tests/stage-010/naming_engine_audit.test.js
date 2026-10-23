/**
 * Stage 010 audit — Naming Engine & Post-Trip Verification.
 * Executes the REAL TS sources via the repo-pinned tsc (no mirrors).
 * Covers the plan §7 TC-010 matrix + hierarchy / bilingual / staging /
 * lineage / Tier-4 invariants.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage010-'));
const SHIM = 'tests/stage-005/node-shim.d.ts';
const ENTRY = [
  'utils-server/bilingualCivicDictionary.ts',
  'utils-server/namingSanitizer.ts',
  'services/namingHierarchy.ts',
  'services/bilingualEngine.ts',
  'services/postTripLabeler.ts',
  'services/namingAggregator.ts',
];
let transpiled = false;
try {
  execFileSync(
    TSC,
    [
      '--module', 'commonjs', '--target', 'es2020', '--strict', 'false',
      '--rootDir', REPO, '--outDir', tmp,
      path.join(REPO, SHIM),
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
  console.error(`FATAL: cannot verify without transpiled output (${pass} pass, ${fail} fail)`);
  process.exit(2);
}

const CIV = require(path.join(tmp, 'utils-server', 'bilingualCivicDictionary.js'));
const SAN = require(path.join(tmp, 'utils-server', 'namingSanitizer.js'));
const HIER = require(path.join(tmp, 'services', 'namingHierarchy.js'));
const BIL = require(path.join(tmp, 'services', 'bilingualEngine.js'));
const LBL = require(path.join(tmp, 'services', 'postTripLabeler.js'));
const AGG = require(path.join(tmp, 'services', 'namingAggregator.js'));

// Deterministic 64-hex pseudonyms/hashes.
const PH = (i) => (i.toString(16).padStart(64, '0'));
const TH = (i) => ((i * 7919).toString(16).padStart(64, '0'));

// ---------- A. Sanitizer TC-010-01..08 ----------
{
  const r1 = SAN.sanitizeAndFormatDisplayName('Flat 4B, House 12, Road 7');
  check('A1/TC-010-01: residential rejected', !r1.valid && r1.rejection_reason === 'residential', JSON.stringify(r1));

  const r2 = SAN.sanitizeAndFormatDisplayName('Dhanmondi 27 er samne');
  check(
    'A2/TC-010-02: clutter strip + Road-N → "Dhanmondi Road 27"',
    r2.valid && r2.canonical_name === 'Dhanmondi Road 27',
    JSON.stringify(r2)
  );

  const r3 = SAN.sanitizeAndFormatDisplayName('01711223344');
  check('A3/TC-010-03: ASCII phone rejected', !r3.valid, JSON.stringify(r3));
  const r4 = SAN.sanitizeAndFormatDisplayName('০১৭১১২২৩৩৪৪');
  check('A4/TC-010-04: Bengali-digit phone rejected', !r4.valid, JSON.stringify(r4));
  const r4b = SAN.sanitizeAndFormatDisplayName('017-1122-3344');
  check('A4b/TC-010-04b: delimited phone rejected (scrubPii-first)', !r4b.valid, JSON.stringify(r4b));

  const r5 = SAN.sanitizeAndFormatDisplayName('Baitul Aman Jame Masjid');
  check(
    'A5/TC-010-05: clean title-casing passes',
    r5.valid && r5.canonical_name === 'Baitul Aman Jame Masjid',
    JSON.stringify(r5)
  );
  const r6 = SAN.sanitizeAndFormatDisplayName('Square Hosp er pashe');
  check(
    'A6/TC-010-06: abbreviation + clutter → "Square Hospital"',
    r6.valid && r6.canonical_name === 'Square Hospital',
    JSON.stringify(r6)
  );

  const r7 = SAN.sanitizeAndFormatDisplayName('fuck bazar');
  check('A7/TC-010-07: obscenity rejected', !r7.valid && r7.rejection_reason === 'profanity', JSON.stringify(r7));
  const r8 = SAN.sanitizeAndFormatDisplayName('To-let 3 room call now');
  check('A8/TC-010-08: commercial spam rejected', !r8.valid && r8.rejection_reason === 'spam', JSON.stringify(r8));
}

// ---------- B. Bilingual counterpart + gates ----------
{
  const g1 = CIV.generateBilingualCounterpart('Hospital Road', 'en');
  check(
    'B1: fully-mapped tokens → dictionary quality',
    g1.quality === 'dictionary' && g1.generated === 'হাসপাতাল রোড',
    JSON.stringify(g1)
  );
  const g2 = CIV.generateBilingualCounterpart('Baitul Aman Jame Masjid', 'en');
  check('B2: unmapped tokens → phonetic quality', g2.quality === 'phonetic', JSON.stringify(g2));

  check('B3/TC-010-14: single-script blocked from active', !BIL.canPublishAsActive({ canonical_name: 'Jamuna Future Park' }));
  check(
    'B4/TC-010-14: dual-script passes active gate',
    BIL.canPublishAsActive({ canonical_name: 'Jamuna Future Park', bangla_name: 'যমুনা ফিউচার পার্ক' })
  );
  check('B5: candidate needs ≥1 name', BIL.canExistAsCandidate({ bangla_name: 'যমুনা' }) && !BIL.canExistAsCandidate({}));

  const c1 = BIL.completeBilingualPair({ canonical_name: 'Hospital Road' });
  check(
    'B6: dictionary counterpart auto-fills bangla_name',
    c1.bangla_name === 'হাসপাতাল রোড' && !c1.pendingAlias,
    JSON.stringify(c1)
  );
  const c2 = BIL.completeBilingualPair({ canonical_name: 'Baitul Aman Jame Masjid' });
  check(
    'B7: phonetic counterpart → pending alias, never display columns',
    c2.bangla_name === undefined &&
      !!c2.pendingAlias &&
      c2.pendingAlias.alias_type === 'transliteration' &&
      c2.pendingAlias.status === 'pending',
    JSON.stringify(c2)
  );
  check(
    'B8: display formatter joins both scripts',
    BIL.formatBilingualDisplay({ canonical_name: 'A', bangla_name: 'ব' }) === 'A / ব'
  );
}

// ---------- C. Hierarchy ----------
{
  check('C1: pin_tool → tier_1', HIER.tierForSource('pin_tool') === 'tier_1');
  check('C2: post_trip_consensus → tier_2', HIER.tierForSource('post_trip_consensus') === 'tier_2');
  check('C3: canonical_query → tier_3', HIER.tierForSource('canonical_query') === 'tier_3');
  check('C4: vendor_passthrough → tier_4 display-only', HIER.tierForSource('vendor_passthrough') === 'tier_4_display_only');

  const won = HIER.resolveDisplayName([
    { source: 'vendor_passthrough', text: 'Vendor Suggestion' },
    { source: 'canonical_query', text: 'Tier Three Name' },
    { source: 'post_trip_consensus', text: 'Tier Two Name' },
    { source: 'pin_tool', text: 'Survey Name' },
  ]);
  check('C5: tier 1 overrides all crowdsourced tiers', won.text === 'Survey Name' && won.tier === 'tier_1', JSON.stringify(won));

  const t4only = HIER.resolveDisplayName([{ source: 'vendor_passthrough', text: 'Vendor X' }]);
  check('C6: tier-4-only result stays display-only', t4only.tier === 'tier_4_display_only', JSON.stringify(t4only));

  let threw = false;
  try {
    HIER.assertTier4NeverPersists('Vendor Suggestion', 'vendor_passthrough');
  } catch { threw = true; }
  check('C7/TC-010-15: tier-4 persist guard throws', threw);
  check('C8: empty list → none', HIER.resolveDisplayName([]).tier === 'none');

  let indThrew = false;
  try {
    HIER.assertConsensusPromotion(undefined);
  } catch { indThrew = true; }
  check('C9: individual label (no proof) never promotes', indThrew);
}

// ---------- D. Post-trip staging ----------
{
  const ok = LBL.stagePostTripLabel({
    poi_id: '11111111-1111-4111-8111-111111111111',
    h3_res10: '8a123456789abcd',
    submitted_text_raw: 'Dhanmondi 27 er samne',
    submission_type: 'text_entry',
    sourceKind: 'rider_typed',
    pseudonym_hash: PH(1),
    trip_hash: TH(1),
    publication_cycle: '2026-11',
  });
  check('D1: clean label stages with scrubbed + normalized text', ok.staged && !!ok.row && ok.row.submitted_text.length > 0 && ok.row.normalized_text.length > 0, JSON.stringify(ok).slice(0, 200));

  const vendor = LBL.stagePostTripLabel({
    poi_id: '11111111-1111-4111-8111-111111111111',
    h3_res10: '8a123456789abcd',
    submitted_text_raw: 'Some Vendor Place Name',
    submission_type: 'text_entry',
    sourceKind: 'vendor_passthrough',
    pseudonym_hash: PH(2),
    trip_hash: TH(2),
    publication_cycle: '2026-11',
  });
  check('D2/TC-010-15: vendor text rejected at ingest', !vendor.staged && vendor.rejection_reason === 'vendor_text');

  const bad = LBL.stagePostTripLabel({
    poi_id: '11111111-1111-4111-8111-111111111111',
    h3_res10: '8a123456789abcd',
    submitted_text_raw: '01711223344',
    submission_type: 'text_entry',
    sourceKind: 'rider_typed',
    pseudonym_hash: PH(3),
    trip_hash: TH(3),
    publication_cycle: '2026-11',
  });
  check('D3: phone-only label stages empty → rejected', !bad.staged);

  const unindexed = LBL.stagePostTripLabel({
    poi_id: null,
    h3_res10: '8a123456789abcd',
    submitted_text_raw: 'Notun Polli Moshjid',
    submission_type: 'text_entry',
    sourceKind: 'rider_typed',
    pseudonym_hash: PH(4),
    trip_hash: TH(4),
    publication_cycle: '2026-11',
  });
  check('D4: unindexed-cell label stages with poi_id NULL', unindexed.staged && unindexed.row.poi_id === null);

  // TC-010-12 uniqueness.
  const rows = [
    { poi_id: '11111111-1111-4111-8111-111111111111', h3_res10: 'h', pseudonym_hash: PH(5), publication_cycle: '2026-11' },
  ];
  check(
    'D5/TC-010-12: same rider+poi+cycle is a duplicate',
    LBL.isDuplicateSubmission(rows, { poi_id: '11111111-1111-4111-8111-111111111111', h3_res10: 'h', pseudonym_hash: PH(5), publication_cycle: '2026-11' })
  );
  check(
    'D6: new cycle is not a duplicate',
    !LBL.isDuplicateSubmission(rows, { poi_id: '11111111-1111-4111-8111-111111111111', h3_res10: 'h', pseudonym_hash: PH(5), publication_cycle: '2026-12' })
  );
  const nullRows = [{ poi_id: null, h3_res10: 'cell-A', pseudonym_hash: PH(6), publication_cycle: '2026-11' }];
  check(
    'D7: NULL-poi dedupe enforced on h3 in code',
    LBL.isDuplicateSubmission(nullRows, { poi_id: null, h3_res10: 'cell-A', pseudonym_hash: PH(6), publication_cycle: '2026-11' }) &&
      !LBL.isDuplicateSubmission(nullRows, { poi_id: null, h3_res10: 'cell-B', pseudonym_hash: PH(6), publication_cycle: '2026-11' })
  );

  check('D8: sampling gate (tier1 / weak-evidence / roll)', 
    !LBL.shouldPromptForLabel({ hasStrongLayer2Evidence: true, hasTier1Name: true, sampleRoll: 0.01 }) &&
      !LBL.shouldPromptForLabel({ hasStrongLayer2Evidence: false, hasTier1Name: false, sampleRoll: 0.01 }) &&
      LBL.shouldPromptForLabel({ hasStrongLayer2Evidence: true, hasTier1Name: false, sampleRoll: 0.05 }) &&
      !LBL.shouldPromptForLabel({ hasStrongLayer2Evidence: true, hasTier1Name: false, sampleRoll: 0.5 }));
}

// ---------- E. Aggregation: TC-010-09/10/11 ----------
function stagedRows(texts, opts) {
  // texts: array of [normalized_text, riderIndex]
  return texts.map(([t, i]) => ({
    poi_id: opts.poiId === undefined ? '22222222-2222-4222-8222-222222222222' : opts.poiId,
    h3_res10: opts.h3 === undefined ? '8a123456789abcd' : opts.h3,
    normalized_text: t,
    pseudonym_hash: PH(i),
    publication_cycle: opts.cycle ?? '2026-11',
  }));
}
{
  // TC-010-09: 4 submissions → IGNORED (no quorum).
  const few = stagedRows([['jamuna future park', 11], ['jamuna future park', 12], ['jamuna future park', 13], ['jamuna future park', 14]], {});
  const e9 = AGG.aggregateForPoi('22222222-2222-4222-8222-222222222222', few, '2026-11');
  check('E1/TC-010-09: 4 submissions ignored (no quorum)', !e9.promoted && e9.reason === 'no_quorum', JSON.stringify(e9));

  // TC-010-10: 55% agreement → IGNORED (no consensus). 6/11 = 0.545.
  const split = stagedRows(
    [['jamuna future park', 21], ['jamuna future park', 22], ['jamuna future park', 23], ['jamuna future park', 24], ['jamuna future park', 25], ['jamuna future park', 26],
     ['gulshan avenue', 27], ['gulshan avenue', 28], ['gulshan avenue', 29], ['gulshan avenue', 30], ['gulshan avenue', 31]],
    {}
  );
  const e10 = AGG.aggregateForPoi('22222222-2222-4222-8222-222222222222', split, '2026-11');
  check('E2/TC-010-10: 55% agreement ignored', !e10.promoted && e10.reason === 'no_consensus', JSON.stringify(e10));

  // TC-010-11: 70% agreement → PROMOTED. 7/10 with runner-up 3/10=30% ≥20%.
  const win = stagedRows(
    [['jamuna future park', 41], ['jamuna future park', 42], ['jamuna future park', 43], ['jamuna future park', 44], ['jamuna future park', 45], ['jamuna future park', 46], ['jamuna future park', 47],
     ['gulshan avenue', 48], ['gulshan avenue', 49], ['gulshan avenue', 50]],
    {}
  );
  const e11 = AGG.aggregateForPoi('22222222-2222-4222-8222-222222222222', win, '2026-11');
  check(
    'E3/TC-010-11: 70% consensus promotes with both names',
    e11.promoted && e11.sanitizedCanonical === 'Jamuna Future Park' && !!e11.sanitizedBangla,
    JSON.stringify(e11)
  );
  check(
    'E4: runner-up ≥20% becomes alias',
    e11.runnerUpAliases.includes('gulshan avenue'),
    JSON.stringify(e11.runnerUpAliases)
  );

  // TC-010-14 path: quorum met but single-script winner → bilingual block.
  const single = stagedRows(
    [['dhanmondi road 27', 61], ['dhanmondi road 27', 62], ['dhanmondi road 27', 63], ['dhanmondi road 27', 64], ['dhanmondi road 27', 65]],
    {}
  );
  const e14 = AGG.aggregateForPoi('22222222-2222-4222-8222-222222222222', single, '2026-11');
  check('E5/TC-010-14: single-script winner blocked by bilingual gate', !e14.promoted && e14.reason === 'bilingual_gate_block', JSON.stringify(e14));

  // Unindexed path seeds Stage 009, never names/mints.
  const cell = stagedRows(
    [['jamuna future park', 71], ['jamuna future park', 72], ['jamuna future park', 73], ['jamuna future park', 74], ['jamuna future park', 75], ['jamuna future park', 76], ['jamuna future park', 77],
     ['other place', 78], ['other place', 79], ['other place', 80]],
    { poiId: null, h3: 'cell-X' }
  );
  const ux = AGG.aggregateUnindexedCell('cell-X', cell, '2026-11');
  check(
    'E6: unindexed pass seeds Stage 009 without naming/minting',
    !!ux.seed && ux.seed.seedCandidateForStage009 === true && ux.seed.writesDisplayName === false && ux.seed.mintsPlace === false,
    JSON.stringify(ux.seed)
  );
  const uxFail = AGG.aggregateUnindexedCell('cell-X', stagedRows([['jamuna future park', 81]], { poiId: null, h3: 'cell-X' }), '2026-11');
  check('E7: unindexed no-quorum → no seed', !uxFail.promoted && uxFail.seed === null);

  check(
    'E8: thresholds are admin-centralized [ESTIMATE]',
    AGG.NAMING_THRESHOLDS.quorumRiders === 5 && AGG.NAMING_THRESHOLDS.consensusShare === 0.6 && AGG.NAMING_THRESHOLDS.aliasRunnerUpShare === 0.2
  );
}

// ---------- F. Lineage TC-010-13 ----------
{
  const sql = AGG.buildLineageFirstUpdateSql();
  check(
    'F1/TC-010-13: conformant lineage SQL carries full row (category/geom/release)',
    sql.versionInsert.includes('dpmaps.poi_versions') &&
      sql.versionInsert.includes('p.category') &&
      sql.versionInsert.includes('p.geom') &&
      sql.versionInsert.includes('release_id') &&
      sql.nameUpdate.includes('UPDATE dpmaps.public_pois') &&
      sql.nameUpdate.includes('tier_2'),
    sql.versionInsert.slice(0, 160)
  );
  check('F2: plan verbatim retained for audit traceability', AGG.PLAN_VERBATIM_LINEAGE_INSERT.includes('INSERT INTO dpmaps.poi_versions'));

  let okId = true;
  try {
    AGG.assertIdUnchanged('a', 'a');
  } catch { okId = false; }
  let badId = false;
  try {
    AGG.assertIdUnchanged('a', 'b');
  } catch { badId = true; }
  check('F3/TC-010-13: UUID stability enforced', okId && badId);

  const alias = AGG.buildAliasUpsertSql();
  check('F4: alias upsert honors uq (ON CONFLICT DO NOTHING)', alias.includes('ON CONFLICT (poi_id, alias_text) DO NOTHING'));
}

// ---------- G. Schema conformance (verified Stage 003 DDL) ----------
{
  const ddl = read('migrations/003_storage_schema.sql');
  check('G1: post_trip_labels staging table adopted', ddl.includes('CREATE TABLE IF NOT EXISTS dpmaps.post_trip_labels'));
  check('G2: cycle-bounded uniqueness uq_rider_poi_cycle', ddl.includes('uq_rider_poi_cycle'));
  check('G3: bilingual gate chk_poi_bilingual_active', ddl.includes('chk_poi_bilingual_active'));
  check('G4: poi_versions lineage table', ddl.includes('CREATE TABLE IF NOT EXISTS dpmaps.poi_versions'));
  check('G5: Tier 1 source enum (pin_tool/merchant_onboarding)', ddl.includes("'pin_tool', 'merchant_onboarding'"));
}

// ---------- H. Source-shape invariants ----------
{
  const sanSrc = read('utils-server/namingSanitizer.ts');
  const sanBody = sanSrc.slice(sanSrc.indexOf('export function sanitizeAndFormatDisplayName'));
  check(
    'H1: scrubPii runs FIRST (F-010-5)',
    sanBody.indexOf('scrubPii(rawInput)') !== -1 &&
      sanBody.indexOf('scrubPii(rawInput)') < sanBody.indexOf('stripClutter(')
  );
  check('H2: scrubPii imported from the real contract location', sanSrc.includes("from './vendorClientWrapper'"));
  check('H3: Road-N heuristic has admin disable flag', sanSrc.includes('setRoadNHeuristicEnabled'));
  check('H4: Tier-4 zero-retention guard referenced at promotion', read('services/namingAggregator.ts').includes('assertTier4NeverPersists'));
  check('H5: no vendor SDKs / no raw vendor retention in new services', !/(barikoi|googleapis|google\.maps)/i.test(
    read('services/namingHierarchy.ts') + read('services/bilingualEngine.ts') + read('services/postTripLabeler.ts') + read('services/namingAggregator.ts')
  ));
}

console.log(`\nSTAGE010: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
