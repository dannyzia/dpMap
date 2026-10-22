# dpMaps POI Tool (v2)

Field-surveyor tool for pinning clean-room landmarks on the dpMaps platform.

**Stack:** Node.js + Express 4.19, better-sqlite3, h3-js, Leaflet 1.9.4 on OpenStreetMap raster tiles.

**Clean-room rule (Hard Rule 7):** this tool only uses OpenStreetMap raster tiles. No Esri, Bing, or Google imagery is offered or loaded.

## Run (Windows)

```
cd tools\poi-tool
npm install
npm test          ← automated verification (25 assertions, in-memory DB)
edit start.bat    ← set ADMIN_PASSWORD (and, if needed, CONTRIBUTOR_KEY)
start.bat
```

Then open `http://localhost:3000`.

- **Contributor page:** `http://localhost:3000/` (public pins, reviewed).
- **Admin review:** `http://localhost:3000/admin` (user `admin`, password from `ADMIN_PASSWORD`).

## Configuration

- `PORT` — listen port (default 3000).
- `ADMIN_PASSWORD` — admin HTTP Basic auth password. Set it before sharing.
- `CONTRIBUTOR_KEY` — shared contributor access key (header `x-contributor-key`). If empty, anyone with the link can submit.

## Database

A local SQLite database `pois.db` is created automatically with WAL mode. The v2 schema includes:

- `name_bn`, `name_en`, `alias_bn`, `alias_en`
- `category` (23 canonical categories — no deprecated synonyms)
- `point_type` (`building`, `entrance`, `dropoff_point`, `area`)
- `lat`, `lng`, `h3_res10`
- `notes`, `contributor`, `status` (`pending`, `approved`, `rejected`)
- `warranty_version`, `warranty_timestamp` (mandatory on submit)
- `parent_place_id` (nullable FK to another pin for gate/entrance linkage)
- `created_at`, `updated_at`

## Endpoints

| Method | Path | Access | Notes |
|--------|------|--------|-------|
| GET | `/api/config` | public | categories, pointTypes, h3Res, warrantyVersion, needsKey |
| GET | `/api/pois` | public | non-rejected pins (contributor view) |
| POST | `/api/pois` | contributor | Save a pin. Requires `warranty_checked: true` and `warranty_version`. |
| GET | `/admin` | admin | Admin review page |
| GET | `/api/admin/pois` | admin | All pins, with counts by status |
| PATCH | `/api/admin/pois/:id` | admin | Edit fields + status; `warranty_released` marks warranty timestamp as released |
| DELETE | `/api/admin/pois/:id` | admin | Remove a pin |
| GET | `/api/admin/export.geojson` | admin | Approved pins as GeoJSON |
| GET | `/api/admin/export.csv` | admin | Approved pins as CSV (BOM for Bangla) |
| GET | `/api/admin/export.json` | admin | Approved pins as JSON (tool schema) |
| GET | `/api/admin/export.public_pois.sql` | admin | `COPY dpmaps.public_pois FROM stdin;` (Stage 003 §4.2, approved pins only) |
| GET | `/api/admin/export.public_pois.json` | admin | JSON envelope for `dpmaps.public_pois` (approved pins only, h3_res9 derived from res-10) |

## Categories (v2, 23 total)

`mosque`, `school`, `restaurant`, `bank`, `pharmacy`, `hospital`, `transit_station`,
`government`, `worship`, `fuel`, `hotel`, `university`, `area`, `supermarket`,
`park`, `shopping_mall`, `atm`, `market`, `airport`, `office`, `society_gate`,
`intersection`, `other`.

These map directly to `dpmaps.public_pois.category` (Stage 003 §4.2). Deprecated synonyms
(`healthcare`, `transit`, `food`, old `landmark`) are not used here.

## Warranty and provenance

Every pin submission requires the contributor to accept the clean-room warranty
checkbox (frontend sends `warranty_checked: true` plus a non-empty `warranty_version`).
The server records `warranty_version` and `warranty_timestamp` (ISO timestamp) on the row.
The admin "Approve" action additionally sets `warranty_released: true` so the warranty
timestamp is carried into the public_pois export.

## Duplicate rejection

Same normalized name within 50 m is rejected with HTTP 409 and the existing pin's id.

## License on data

Pin Tool contributions are first-party, clean-room field surveys — not OSM and not vendor data.
OSM-derived POIs live in `dpmaps.osm_pois` and are exported separately from the PBF pipeline.

## Backlog (not in v2)

- Per-surveyor tokens and audit hash (shared key still used in v2).
- OSM candidate import ("confirm / move pin").
- `parent_venue` dropdown currently lists approved building/area pins; true venue
  hierarchy (`parent_venue` table) is a later stage.

## Distributable resources ZIP

The archive under `docs/resources/dpmaps-poi-tool.zip` is the v2 distributable package with root folder `poi-tool/`.
To update the archive after changes:
```bash
cd tools && zip -r ../docs/resources/dpmaps-poi-tool.zip poi-tool/ -x "poi-tool/node_modules/*" "poi-tool/*.db*" "poi-tool/*.log"
```
