// audit_test.js — Independent Automated Audit Suite for Pin Tool v2
const http = require('http');

const PORT = 3001;
process.env.PORT = String(PORT);
process.env.ADMIN_PASSWORD = 'audit-secret-password';
process.env.CONTRIBUTOR_KEY = 'audit-survey-key';
process.env.DB_PATH = ':memory:'; // Clean isolated in-memory DB for pure test run

const server = require('./server.js');

function req(options, postData) {
  return new Promise((resolve, reject) => {
    const r = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
        } catch (_) {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });
    r.on('error', reject);
    if (postData) {
      r.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    r.end();
  });
}

const authHeader = 'Basic ' + Buffer.from('admin:audit-secret-password').toString('base64');

async function runAudit() {
  console.log('=== STARTING INDEPENDENT PIN TOOL v2 AUDIT ===');
  let failures = 0;

  function assert(desc, condition, details = '') {
    if (condition) {
      console.log(`[PASS] ${desc}`);
    } else {
      console.error(`[FAIL] ${desc} ${details}`);
      failures++;
    }
  }

  // 1. Config endpoint
  const cfg = await req({ host: '127.0.0.1', port: PORT, path: '/api/config', method: 'GET' });
  assert('Config endpoint returns 200', cfg.status === 200);
  assert('Config has exactly 23 categories', cfg.body?.categories?.length === 23, `Got: ${cfg.body?.categories?.length}`);
  assert('Config has 4 point types', cfg.body?.pointTypes?.length === 4);
  assert('Config specifies h3Res = 10', cfg.body?.h3Res === 10);
  assert('Config specifies warrantyVersion = "1.0"', cfg.body?.warrantyVersion === '1.0');
  assert('Config enforces contributor key requirement', cfg.body?.needsKey === true);

  // 2. Contributor Key enforcement
  const pinWithoutKey = await req({
    host: '127.0.0.1', port: PORT, path: '/api/pois', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    name_en: 'Test Mosque', category: 'mosque', lat: 23.8103, lng: 90.4125,
    warranty_checked: true, warranty_version: '1.0'
  });
  assert('Rejects submission without contributor key (401)', pinWithoutKey.status === 401);

  // 3. Clean-Room Warranty enforcement
  const pinWithoutWarranty = await req({
    host: '127.0.0.1', port: PORT, path: '/api/pois', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-contributor-key': 'audit-survey-key' }
  }, {
    name_en: 'Test Mosque', category: 'mosque', lat: 23.8103, lng: 90.4125,
    warranty_checked: false
  });
  assert('Rejects submission without warranty checkbox (400)', pinWithoutWarranty.status === 400);

  // 4. Deprecated category rejection (e.g. 'transit', 'healthcare', 'food')
  const pinWithDeprecatedCategory = await req({
    host: '127.0.0.1', port: PORT, path: '/api/pois', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-contributor-key': 'audit-survey-key' }
  }, {
    name_en: 'Test Station', category: 'transit', lat: 23.8103, lng: 90.4125,
    warranty_checked: true, warranty_version: '1.0'
  });
  assert('Rejects deprecated synonym category "transit" (400)', pinWithDeprecatedCategory.status === 400);

  // 5. Valid submission
  const validPin = await req({
    host: '127.0.0.1', port: PORT, path: '/api/pois', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-contributor-key': 'audit-survey-key' }
  }, {
    name_bn: 'বায়তুল মোকাররম',
    name_en: 'Baitul Mukarram National Mosque',
    alias_bn: 'জাতীয় মসজিদ',
    alias_en: 'National Mosque',
    category: 'mosque',
    point_type: 'entrance',
    lat: 23.7289,
    lng: 90.4125,
    notes: 'North gate entrance curb',
    contributor: 'Surveyor-01',
    warranty_checked: true,
    warranty_version: '1.0'
  });
  assert('Accepts valid pin with warranty (201)', validPin.status === 201 && validPin.body?.id === 1);

  // 6. 50-meter duplicate rejection
  const dupPin = await req({
    host: '127.0.0.1', port: PORT, path: '/api/pois', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-contributor-key': 'audit-survey-key' }
  }, {
    name_en: 'Baitul Mukarram National Mosque',
    category: 'mosque',
    lat: 23.7290, // ~11m away
    lng: 90.4125,
    warranty_checked: true,
    warranty_version: '1.0'
  });
  assert('Rejects duplicate pin within 50m (409)', dupPin.status === 409);

  // 7. Admin Auth protection
  const unauthAdmin = await req({
    host: '127.0.0.1', port: PORT, path: '/api/admin/pois', method: 'GET'
  });
  assert('Protects admin API from unauthenticated access (401)', unauthAdmin.status === 401);

  // 8. Admin review and approval
  const authAdminList = await req({
    host: '127.0.0.1', port: PORT, path: '/api/admin/pois', method: 'GET',
    headers: { 'Authorization': authHeader }
  });
  assert('Admin sees pending pins (200)', authAdminList.status === 200 && authAdminList.body?.rows?.length === 1);
  const pendingPoi = authAdminList.body?.rows?.[0];
  assert('Pin has H3 res-10 populated', Boolean(pendingPoi?.h3_res10 && pendingPoi.h3_res10.length === 15));
  assert('Pin has warranty_version and warranty_timestamp', pendingPoi?.warranty_version === '1.0' && Boolean(pendingPoi?.warranty_timestamp));

  // Approve pin
  const approveRes = await req({
    host: '127.0.0.1', port: PORT, path: '/api/admin/pois/1', method: 'PATCH',
    headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' }
  }, { status: 'approved' });
  assert('Admin approves pin (200)', approveRes.status === 200 && approveRes.body?.ok === true);

  // 9. SQL export (Stage 003 public_pois COPY format)
  const sqlExport = await req({
    host: '127.0.0.1', port: PORT, path: '/api/admin/export.public_pois.sql', method: 'GET',
    headers: { 'Authorization': authHeader }
  });
  assert('SQL export returns 200', sqlExport.status === 200);
  assert('SQL export contains COPY dpmaps.public_pois', sqlExport.raw?.includes('COPY dpmaps.public_pois'));
  assert('SQL export contains approved mosque', sqlExport.raw?.includes('Baitul Mukarram National Mosque'));
  assert('SQL export contains source pin_tool', sqlExport.raw?.includes("'pin_tool'"));

  // 10. JSON export (public_pois format)
  const jsonExport = await req({
    host: '127.0.0.1', port: PORT, path: '/api/admin/export.public_pois.json', method: 'GET',
    headers: { 'Authorization': authHeader }
  });
  assert('Public POIs JSON export returns 200', jsonExport.status === 200);
  assert('Public POIs JSON has 1 approved row', jsonExport.body?.total_rows === 1);
  assert('Public POIs JSON derives H3 res-9 from res-10', Boolean(jsonExport.body?.rows?.[0]?.h3_res9));

  // 11. GeoJSON and CSV exports
  const geojson = await req({
    host: '127.0.0.1', port: PORT, path: '/api/admin/export.geojson', method: 'GET',
    headers: { 'Authorization': authHeader }
  });
  assert('GeoJSON export returns FeatureCollection', geojson.status === 200 && geojson.body?.type === 'FeatureCollection');

  const csv = await req({
    host: '127.0.0.1', port: PORT, path: '/api/admin/export.csv', method: 'GET',
    headers: { 'Authorization': authHeader }
  });
  assert('CSV export returns 200 with UTF-8 BOM', csv.status === 200 && csv.raw?.startsWith('\uFEFF'));

  console.log('=== AUDIT COMPLETE ===');
  console.log(`Total Failures: ${failures}`);
  process.exit(failures > 0 ? 1 : 0);
}

// Give server 100ms to bind, then run
setTimeout(runAudit, 150);
