const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const h3 = require('h3-js');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const CONTRIBUTOR_KEY = process.env.CONTRIBUTOR_KEY || '';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'pois.db');

// ── 23-category canonical taxonomy (Stage 003 §4.2 aligned) ──────────────────
// Maps directly to dpmaps.public_pois.category CHECK constraint values.
// Deprecated synonyms (healthcare, transit, food) are NOT used here; the old
// 'landmark' catch-all is replaced by specific kinds (fuel, atm, supermarket,
// pharmacy, society_gate, intersection, other).
const CATEGORIES = [
  ['mosque',           'Mosque'],
  ['school',           'School'],
  ['restaurant',       'Restaurant / cafe'],
  ['bank',             'Bank'],
  ['pharmacy',         'Pharmacy'],
  ['hospital',         'Hospital / clinic'],
  ['transit_station',  'Metro / bus / rail station'],
  ['government',       'Government office'],
  ['worship',          'Other place of worship'],
  ['fuel',             'Fuel station'],
  ['hotel',            'Hotel / guest house'],
  ['university',       'University / college'],
  ['area',             'Neighborhood / area name'],
  ['supermarket',      'Supermarket'],
  ['park',             'Park / playground'],
  ['shopping_mall',    'Shopping mall'],
  ['atm',              'ATM'],
  ['market',           'Market / bazaar'],
  ['airport',          'Airport / launch ghat'],
  ['office',           'Office / business park'],
  ['society_gate',     'Residential society gate'],
  ['intersection',     'Intersection / mor'],
  ['other',            'Other'],
];

const CATEGORY_KEYS = new Set(CATEGORIES.map(([k]) => k));

// Point types mirror the Stage 003 public_pois.point_type vocabulary.
const POINT_TYPES = [
  ['building',       'Building (centroid)'],
  ['entrance',       'Entrance / gate'],
  ['dropoff_point',  'Drop-off point'],
  ['area',           'Area / polygon centroid'],
];
const POINT_TYPE_KEYS = new Set(POINT_TYPES.map(([k]) => k));

// ── Geography ──────────────────────────────────────────────────────────────────
const BBOX = { minLat: 20.5, maxLat: 26.7, minLng: 88.0, maxLng: 92.8 };
const DUP_RADIUS_M = 50;
const H3_RES = 10; // Pin Tool stores H3 res-10 for each pin (used by ingestion).

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ── Schema (v2): warranty fields, aliases, H3, parent_venue, point_type ──────
db.exec(`
CREATE TABLE IF NOT EXISTS pois (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name_bn         TEXT    NOT NULL DEFAULT '',
  name_en         TEXT    NOT NULL DEFAULT '',
  alias_bn        TEXT    NOT NULL DEFAULT '',
  alias_en         TEXT    NOT NULL DEFAULT '',
  category        TEXT    NOT NULL,
  point_type      TEXT    NOT NULL DEFAULT 'entrance',
  lat             REAL    NOT NULL,
  lng             REAL    NOT NULL,
  h3_res10        TEXT,
  notes           TEXT    NOT NULL DEFAULT '',
  contributor      TEXT    NOT NULL DEFAULT '',
  status          TEXT    NOT NULL DEFAULT 'pending',
  warranty_version   TEXT    NOT NULL DEFAULT '',
  warranty_timestamp TEXT,
  parent_place_id    INTEGER,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pois_status   ON pois(status);
CREATE INDEX IF NOT EXISTS idx_pois_latlng   ON pois(lat, lng);
CREATE INDEX IF NOT EXISTS idx_pois_category ON pois(category);
CREATE INDEX IF NOT EXISTS idx_pois_parent   ON pois(parent_place_id);
`);

// ── Express setup ──────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

// ---------- helpers ----------
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function safeEqual(a, b) { return crypto.timingSafeEqual(sha(a), sha(b)); }

function requireAdmin(req, res, next) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    const user = decoded.slice(0, i);
    const pass = decoded.slice(i + 1);
    if (i >= 0 && safeEqual(user, 'admin') && safeEqual(pass, ADMIN_PASSWORD)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="dpMaps admin"');
  res.status(401).send('Authentication required');
}

function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const clean = (s, max) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').slice(0, max ?? -1);

function h3FromCoords(lat, lng) {
  try { return h3.latLngToCell(lat, lng, H3_RES); }
  catch (_) { return null; }
}

function findDuplicate(lat, lng, name_bn, name_en, excludeId = 0) {
  const d = 0.001; // about 110 m
  const rows = db.prepare(
    `SELECT * FROM pois WHERE status != 'rejected' AND id != ?
     AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`
  ).all(excludeId, lat - d, lat + d, lng - d, lng + d);
  const nb = norm(name_bn), ne = norm(name_en);
  return rows.find(r =>
    distanceM(lat, lng, r.lat, r.lng) <= DUP_RADIUS_M &&
    ((nb && norm(r.name_bn) === nb) || (ne && norm(r.name_en) === ne))
  );
}

// ---------- rate limiter (contributor saves) ----------
const hits = new Map();
function rateLimit(req, res, next) {
  const key = req.ip, now = Date.now(), windowMs = 60 * 60 * 1000, max = 200;
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) return res.status(429).json({ error: 'Too many saves. Try again later.' });
  arr.push(now); hits.set(key, arr); next();
}

// ---------- validation ----------
function validatePoi(body, partial = false) {
  const out = {};
  if (!partial || 'name_bn' in body)  out.name_bn  = clean(body.name_bn, 120);
  if (!partial || 'name_en' in body)  out.name_en  = clean(body.name_en, 120);
  if (!partial || 'alias_bn' in body) out.alias_bn = clean(body.alias_bn, 200);
  if (!partial || 'alias_en' in body) out.alias_en = clean(body.alias_en, 200);
  if (!partial || 'category' in body) out.category = clean(body.category, 30);
  if (!partial || 'point_type' in body) out.point_type = clean(body.point_type, 20) || 'entrance';
  if (!partial || 'notes' in body)    out.notes    = clean(body.notes, 500);
  if (!partial || 'lat' in body)      out.lat      = Number(body.lat);
  if (!partial || 'lng' in body)      out.lng      = Number(body.lng);
  if (!partial || 'parent_place_id' in body) out.parent_place_id = body.parent_place_id == null ? null : Number(body.parent_place_id);

  if ('category' in out && !CATEGORY_KEYS.has(out.category)) return { error: 'Pick a category.' };
  if ('point_type' in out && !POINT_TYPE_KEYS.has(out.point_type)) return { error: 'Pick a point type.' };
  if ('lat' in out || 'lng' in out) {
    if (!Number.isFinite(out.lat) || !Number.isFinite(out.lng) ||
        out.lat < BBOX.minLat || out.lat > BBOX.maxLat ||
        out.lng < BBOX.minLng || out.lng > BBOX.maxLng) {
      return { error: 'Pin is outside Bangladesh. Tap the map to place it again.' };
    }
  }
  if ('parent_place_id' in out && out.parent_place_id != null) {
    const parent = db.prepare('SELECT id, status FROM pois WHERE id = ?').get(out.parent_place_id);
    if (!parent || parent.status === 'rejected') {
      return { error: 'Parent venue not found or rejected.' };
    }
  }
  return { value: out };
}

// ---------- public API ----------
app.get('/api/config', (req, res) => {
  res.json({
    categories: CATEGORIES.map(([key, label]) => ({ key, label })),
    pointTypes: POINT_TYPES.map(([key, label]) => ({ key, label })),
    h3Res: H3_RES,
    needsKey: !!CONTRIBUTOR_KEY,
    warrantyVersion: '1.0',
  });
});

app.get('/api/pois', (req, res) => {
  const rows = db.prepare(
    `SELECT id, name_bn, name_en, alias_bn, alias_en, category, point_type,
            lat, lng, h3_res10, status, parent_place_id
     FROM pois WHERE status != 'rejected'`
  ).all();
  res.json(rows);
});

app.post('/api/pois', rateLimit, (req, res) => {
  if (CONTRIBUTOR_KEY && !safeEqual(req.headers['x-contributor-key'] || '', CONTRIBUTOR_KEY)) {
    return res.status(401).json({ error: 'Wrong access key.' });
  }

  // Mandatory clean-room warranty checkbox: both fields must be present and the
  // warranty version must be non-empty. (Frontend sends warranty_checked = true
  // only when the contributor accepts the checkbox.)
  const warrantyChecked = req.body && req.body.warranty_checked;
  if (!warrantyChecked) {
    return res.status(400).json({ error: 'Clean-room warranty must be accepted to submit a pin.' });
  }
  if (!req.body.warranty_version) {
    return res.status(400).json({ error: 'Missing warranty version.' });
  }

  const { value, error } = validatePoi(req.body || {});
  if (error) return res.status(400).json({ error });
  if (!value.name_bn && !value.name_en) {
    return res.status(400).json({ error: 'Enter the place name in Bangla or English.' });
  }

  const dup = findDuplicate(value.lat, value.lng, value.name_bn, value.name_en);
  if (dup) {
    return res.status(409).json({
      error: `"${dup.name_bn || dup.name_en}" is already pinned within ${DUP_RADIUS_M} m.`,
      duplicate: { id: dup.id, lat: dup.lat, lng: dup.lng },
    });
  }

  const contributor = clean(req.body.contributor, 60);
  const h3 = h3FromCoords(value.lat, value.lng);
  const warranty_version = clean(req.body.warranty_version, 20);
  const warranty_timestamp = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO pois (name_bn, name_en, alias_bn, alias_en, category, point_type,
                       lat, lng, h3_res10, notes, contributor,
                       warranty_version, warranty_timestamp, parent_place_id)
     VALUES (@name_bn, @name_en, @alias_bn, @alias_en, @category, @point_type,
             @lat, @lng, @h3_res10, @notes, @contributor,
             @warranty_version, @warranty_timestamp, @parent_place_id)`
  ).run({
    ...value,
    h3_res10: h3 ?? '',
    contributor,
    warranty_version,
    warranty_timestamp,
    parent_place_id: value.parent_place_id,
  });
  res.status(201).json({ id: info.lastInsertRowid });
});

// ---------- admin ----------
app.get(['/admin', '/admin.html'], requireAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, 'private', 'admin.html')));

app.get('/api/admin/pois', requireAdmin, (req, res) => {
  const status = req.query.status;
  const rows = status && status !== 'all'
    ? db.prepare('SELECT * FROM pois WHERE status = ? ORDER BY id DESC').all(String(status))
    : db.prepare('SELECT * FROM pois ORDER BY id DESC').all();
  const counts = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS n FROM pois GROUP BY status').all().map(r => [r.status, r.n])
  );
  res.json({ rows, counts });
});

app.patch('/api/admin/pois/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM pois WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const body = req.body || {};
  const { value, error } = validatePoi(body, true);
  if (error) return res.status(400).json({ error });

  if ('status' in body) {
    if (!['pending', 'approved', 'rejected'].includes(body.status)) {
      return res.status(400).json({ error: 'Bad status' });
    }
    value.status = body.status;
  }
  if ('warranty_released' in body) {
    // Admin can mark the warranty as "released to public_pois export" without
    // changing the original warranty_timestamp.
    if (body.warranty_released) {
      value.warranty_timestamp = existing.warranty_timestamp || new Date().toISOString();
    }
  }

  const keys = Object.keys(value);
  if (!keys.length) return res.json({ ok: true });
  const sets = keys.map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE pois SET ${sets}, updated_at = datetime('now') WHERE id = @id`).run({ ...value, id });
  res.json({ ok: true });
});

app.delete('/api/admin/pois/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM pois WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- export: GeoJSON, CSV, JSON (v1 format), JSON (Stage 003 public_pois) ----------
function exportRows(req) {
  const status = req.query.status || 'approved';
  return status === 'all'
    ? db.prepare('SELECT * FROM pois ORDER BY id').all()
    : db.prepare('SELECT * FROM pois WHERE status = ? ORDER BY id').all(String(status));
}

app.get('/api/admin/export.geojson', requireAdmin, (req, res) => {
  const rows = exportRows(req);
  res.set('Content-Disposition', 'attachment; filename="pois.geojson"');
  res.json({
    type: 'FeatureCollection',
    features: rows.map(r => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
      properties: {
        id: r.id,
        name_bn: r.name_bn,
        name_en: r.name_en,
        alias_bn: r.alias_bn,
        alias_en: r.alias_en,
        category: r.category,
        point_type: r.point_type,
        h3_res10: r.h3_res10,
        notes: r.notes,
        contributor: r.contributor,
        status: r.status,
        warranty_version: r.warranty_version,
        warranty_timestamp: r.warranty_timestamp,
        parent_place_id: r.parent_place_id,
        created_at: r.created_at,
      },
    })),
  });
});

app.get('/api/admin/export.csv', requireAdmin, (req, res) => {
  const rows = exportRows(req);
  const cols = [
    'id', 'name_bn', 'name_en', 'alias_bn', 'alias_en', 'category', 'point_type',
    'lat', 'lng', 'h3_res10', 'notes', 'contributor', 'status',
    'warranty_version', 'warranty_timestamp', 'parent_place_id', 'created_at',
  ];
  const cell = v => {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // block spreadsheet formula injection
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const lines = [cols.join(',')].concat(rows.map(r => cols.map(c => cell(r[c])).join(',')));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="pois.csv"');
  res.send('\uFEFF' + lines.join('\r\n')); // BOM for Bangla in Excel
});

// Plain JSON dump in the original tool format (for the paper schema / ad-hoc use).
app.get('/api/admin/export.json', requireAdmin, (req, res) => {
  const rows = exportRows(req);
  res.set('Content-Disposition', 'attachment; filename="pois.json"');
  res.json(rows.map(r => ({
    id: r.id,
    name_bn: r.name_bn,
    name_en: r.name_en,
    alias_bn: r.alias_bn,
    alias_en: r.alias_en,
    category: r.category,
    point_type: r.point_type,
    lat: r.lat,
    lng: r.lng,
    h3_res10: r.h3_res10,
    notes: r.notes,
    contributor: r.contributor,
    status: r.status,
    warranty_version: r.warranty_version,
    warranty_timestamp: r.warranty_timestamp,
    parent_place_id: r.parent_place_id,
    created_at: r.created_at,
  })));
});

// Stage 003-aligned SQL and JSON export for dpmaps.public_pois.
// public_pois schema (Stage 003 §4.2): id UUID PK, name TEXT, name_en TEXT, name_bn TEXT,
// category TEXT, point_type TEXT, lat DOUBLE, lng DOUBLE, h3_res9 TEXT, h3_res10 TEXT,
// alias TEXT, alias_bn TEXT, alias_en TEXT, parent_place_id UUID, source TEXT,
// created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ.
// The Pin Tool stores h3_res10 only; h3_res9 is derived here on export.
app.get('/api/admin/export.public_pois.sql', requireAdmin, (req, res) => {
  const rows = exportRows(req).filter(r => r.status === 'approved');
  const lines = [];
  lines.push('-- dpMaps public_pois export from Pin Tool (approved pins only)');
  lines.push('-- Schema: dpmaps.public_pois (Stage 003 §4.2)');
  lines.push('-- Point IDs are minted as UUIDv4 on insert; this dump omits them so the');
  lines.push('-- receiving loader can mint its own stable IDs.');
  lines.push('-- H3 res-9 is derived from the Pin Tool res-10 cell at export time.');
  lines.push('');
  lines.push("COPY dpmaps.public_pois (name, name_en, name_bn, category, point_type,");
  lines.push('       lat, lng, h3_res9, h3_res10, alias, alias_bn, alias_en,');
  lines.push('       parent_place_id, source, created_at, updated_at)');
  lines.push('FROM stdin;');
  for (const r of rows) {
    const h3_9 = h3 ? h3.cellToParent(r.h3_res10, 9) : null;
    const alias  = [r.alias_bn, r.alias_en].filter(Boolean).join(' / ') || '';
    const alias_bn  = r.alias_bn  || '';
    const alias_en  = r.alias_en  || '';
    const parent_place_id = r.parent_place_id != null ? String(r.parent_place_id) : '\\N';
    const created = r.created_at ? r.created_at.replace(' ', ' ') : '\\N';
    lines.push(
      formatCopyValue(r.name_en || r.name_bn || '') + ',' +
      formatCopyValue(r.name_en) + ',' +
      formatCopyValue(r.name_bn) + ',' +
      formatCopyValue(r.category) + ',' +
      formatCopyValue(r.point_type) + ',' +
      (r.lat != null ? String(r.lat) : '\\N') + ',' +
      (r.lng != null ? String(r.lng) : '\\N') + ',' +
      formatCopyValue(h3_9) + ',' +
      formatCopyValue(r.h3_res10) + ',' +
      formatCopyValue(alias) + ',' +
      formatCopyValue(alias_bn) + ',' +
      formatCopyValue(alias_en) + ',' +
      parent_place_id + ',' +
      '\'pin_tool\',' +
      formatCopyValue(created) + ',' +
      formatCopyValue(created)
    );
  }
  lines.push('\\.');
  lines.push('');
  lines.push('-- End of public_pois dump.');
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="public_pois.sql"');
  res.send(lines.join('\n'));
});

app.get('/api/admin/export.public_pois.json', requireAdmin, (req, res) => {
  const rows = exportRows(req).filter(r => r.status === 'approved');
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="public_pois.json"');
  res.json({
    table: 'dpmaps.public_pois',
    source: 'pin_tool',
    snapshot_date: new Date().toISOString(),
    h3_res: H3_RES,
    total_rows: rows.length,
    rows: rows.map(r => {
      const h3_9 = h3 ? h3.cellToParent(r.h3_res10, 9) : null;
      return {
        name:       r.name_bn || r.name_en || '',
        name_en:    r.name_en  || '',
        name_bn:    r.name_bn  || '',
        category:   r.category,
        point_type: r.point_type,
        lat:        r.lat,
        lng:        r.lng,
        h3_res9:    h3_9,
        h3_res10:   r.h3_res10,
        alias:      [r.alias_bn, r.alias_en].filter(Boolean).join(' / ') || '',
        alias_bn:   r.alias_bn  || '',
        alias_en:   r.alias_en  || '',
        parent_place_id: r.parent_place_id != null ? String(r.parent_place_id) : null,
        source:     'pin_tool',
        created_at: r.created_at,
        updated_at: r.created_at,
      };
    }),
  });
});

function formatCopyValue(v) {
  if (v == null) return '\\N';
  const s = String(v);
  // COPY wants backslash-escaped \ and quoted fields. Keep it simple and safe.
  if (s.includes(',') || s.includes('"') || s.includes('\\') || s.includes('\n')) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}

// ---------- static (contributor page) ----------
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`dpMaps POI tool (v2) running:  http://localhost:${PORT}`);
  console.log(`Admin review page:             http://localhost:${PORT}/admin  (user: admin)`);
  console.log(`Public_pois export:            /api/admin/export.public_pois.sql  +  .json`);
  if (ADMIN_PASSWORD === 'change-me') {
    console.log('WARNING: using the default admin password. Set ADMIN_PASSWORD before sharing.');
  }
  if (!CONTRIBUTOR_KEY) {
    console.log('Note: no CONTRIBUTOR_KEY set, so anyone with the link can add pins.');
  }
});
