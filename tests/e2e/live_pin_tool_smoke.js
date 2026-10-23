/**
 * Live Pin Tool Server Smoke Test.
 * Spawns tools/poi-tool/server.js on an ephemeral port (3005) with a dedicated test SQLite db,
 * exercises public config, contributor pin submission (with mandatory clean-room warranty),
 * duplicate detection, admin basic auth, admin approval, and public_pois SQL/JSON export.
 * Then cleanly terminates the process.
 */
'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 3005;
const ADMIN_PASSWORD = 'smoke-test-secret-password';
const tmpDb = path.join(os.tmpdir(), `pin_tool_smoke_${Date.now()}.db`);

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    fail++;
    console.error(`  [FAIL] ${name}${extra ? ' — ' + extra : ''}`);
  }
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, raw: data, json });
      });
    });
    req.on('error', reject);
    if (body) {
      if (typeof body === 'object') {
        req.setHeader('Content-Type', 'application/json');
        req.write(JSON.stringify(body));
      } else {
        req.write(body);
      }
    }
    req.end();
  });
}

async function main() {
  console.log('=== dpMaps Pin Tool Live Integration & Smoke Test ===');
  console.log(`Port: ${PORT}, Temp DB: ${tmpDb}`);

  // 1. Spawn server
  const child = spawn(process.execPath, [path.join(REPO, 'tools', 'poi-tool', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ADMIN_PASSWORD: ADMIN_PASSWORD,
      DB_PATH: tmpDb,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverReady = false;
  child.stdout.on('data', (d) => {
    // console.log('[Server stdout]:', d.toString().trim());
  });
  child.stderr.on('data', (d) => {
    console.error('[Server stderr]:', d.toString().trim());
  });

  // Wait for server to listen
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const res = await request({ host: '127.0.0.1', port: PORT, path: '/api/config', method: 'GET' });
      if (res.status === 200) {
        serverReady = true;
        break;
      }
    } catch (_) {}
  }

  check('Server up and listening on port ' + PORT, serverReady);
  if (!serverReady) {
    child.kill('SIGKILL');
    process.exit(1);
  }

  try {
    // 2. Probing /api/config
    const confRes = await request({ host: '127.0.0.1', port: PORT, path: '/api/config', method: 'GET' });
    check('GET /api/config returns 200', confRes.status === 200);
    check('Config contains 23 categories', confRes.json && confRes.json.categories && confRes.json.categories.length === 23);
    check('Config contains H3 resolution 10', confRes.json && confRes.json.h3Res === 10);
    check('Config contains warrantyVersion 1.0', confRes.json && confRes.json.warrantyVersion === '1.0');

    // 3. Contributor pin submission without warranty -> MUST FAIL (400)
    const noWarrantyRes = await request(
      { host: '127.0.0.1', port: PORT, path: '/api/pois', method: 'POST' },
      {
        name_bn: 'মডেল মসজিদ',
        name_en: 'Model Mosque',
        category: 'mosque',
        lat: 23.8103,
        lng: 90.4125,
        warranty_checked: false, // Fails warranty check!
      }
    );
    check('POST /api/pois without warranty rejected with 400', noWarrantyRes.status === 400);

    // 4. Contributor pin submission with valid clean-room warranty -> CREATED (201)
    const validPinRes = await request(
      { host: '127.0.0.1', port: PORT, path: '/api/pois', method: 'POST' },
      {
        name_bn: 'ধানমন্ডি ২৭ মডেল মসজিদ',
        name_en: 'Dhanmondi 27 Model Mosque',
        alias_bn: '২৭ নম্বর মসজিদ',
        alias_en: 'Road 27 Mosque',
        category: 'mosque',
        point_type: 'entrance',
        lat: 23.7538,
        lng: 90.3712,
        notes: 'Main prayer hall east entrance gate',
        contributor: 'Surveyor-007',
        warranty_checked: true,
        warranty_version: '1.0',
      }
    );
    check('POST /api/pois with valid warranty returns 201', validPinRes.status === 201);
    const pinId = validPinRes.json && validPinRes.json.id;
    check('Assigned valid numeric pin id', typeof pinId === 'number' && pinId > 0, `id=${pinId}`);

    // 5. Duplicate pin detection (within 50 meters, same name) -> MUST FAIL (409)
    const dupPinRes = await request(
      { host: '127.0.0.1', port: PORT, path: '/api/pois', method: 'POST' },
      {
        name_bn: 'ধানমন্ডি ২৭ মডেল মসজিদ',
        name_en: 'Dhanmondi 27 Model Mosque',
        category: 'mosque',
        lat: 23.7539, // ~11 meters away
        lng: 90.3713,
        warranty_checked: true,
        warranty_version: '1.0',
      }
    );
    check('Duplicate pin within 50m rejected with 409', dupPinRes.status === 409);

    // 6. Admin API: Auth Guard
    const noAuthRes = await request({ host: '127.0.0.1', port: PORT, path: '/api/admin/pois', method: 'GET' });
    check('GET /api/admin/pois without auth returns 401', noAuthRes.status === 401);

    // 7. Admin API: Valid Basic Auth
    const authHeader = 'Basic ' + Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64');
    const adminPoisRes = await request({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/admin/pois',
      method: 'GET',
      headers: { Authorization: authHeader },
    });
    check('GET /api/admin/pois with Basic Auth returns 200', adminPoisRes.status === 200);
    check('Lists pending pin in queue', adminPoisRes.json && adminPoisRes.json.rows.length === 1);
    const queued = adminPoisRes.json.rows[0];
    check('Queued pin has H3 resolution 10 computed', !!queued.h3_res10 && queued.h3_res10.length === 15, queued.h3_res10);
    check('Queued pin has warranty timestamp and version captured', queued.warranty_version === '1.0' && !!queued.warranty_timestamp);

    // 8. Admin Approval (PATCH /api/admin/pois/:id)
    const approveRes = await request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: `/api/admin/pois/${pinId}`,
        method: 'PATCH',
        headers: { Authorization: authHeader },
      },
      { status: 'approved', warranty_released: true }
    );
    check('PATCH /api/admin/pois/:id approves pin', approveRes.status === 200);

    // 9. Public Export: GeoJSON
    const geoJsonRes = await request({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/admin/export.geojson?status=approved',
      method: 'GET',
      headers: { Authorization: authHeader },
    });
    check('Export GeoJSON returns FeatureCollection with 1 feature',
      geoJsonRes.json && geoJsonRes.json.type === 'FeatureCollection' && geoJsonRes.json.features.length === 1);

    // 10. Public Export: Stage 003 public_pois SQL
    const sqlRes = await request({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/admin/export.public_pois.sql?status=approved',
      method: 'GET',
      headers: { Authorization: authHeader },
    });
    check('Export SQL returns 200', sqlRes.status === 200);
    check('Export SQL contains COPY dpmaps.public_pois statement',
      sqlRes.raw.includes('COPY dpmaps.public_pois') && sqlRes.raw.includes('Dhanmondi 27 Model Mosque'));

    // 11. Public Export: Plain JSON
    const jsonRes = await request({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/admin/export.json?status=approved',
      method: 'GET',
      headers: { Authorization: authHeader },
    });
    check('Export JSON returns array with 1 approved POI object', Array.isArray(jsonRes.json) && jsonRes.json.length === 1);

    // 12. Public Export: Stage 003 public_pois JSON
    const publicJsonRes = await request({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/admin/export.public_pois.json?status=approved',
      method: 'GET',
      headers: { Authorization: authHeader },
    });
    check('Export public_pois JSON returns table dpmaps.public_pois with 1 row',
      publicJsonRes.json && publicJsonRes.json.table === 'dpmaps.public_pois' && publicJsonRes.json.total_rows === 1);

  } finally {
    // Cleanup
    child.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 300));
    try {
      if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
      if (fs.existsSync(tmpDb + '-wal')) fs.unlinkSync(tmpDb + '-wal');
      if (fs.existsSync(tmpDb + '-shm')) fs.unlinkSync(tmpDb + '-shm');
    } catch (_) {}
  }

  console.log(`\nPin Tool Smoke Summary: ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal smoke test error:', err);
  process.exit(1);
});
