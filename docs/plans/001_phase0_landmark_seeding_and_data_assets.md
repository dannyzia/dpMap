# Stage 001: Phase 0 Landmark Seeding & Data Assets Implementation Plan

**Plan Identifier:** RIDE-dpMaps-PLAN-001 (Revision 2.2 — Pipeline-Calibrated & Asset-Reconciled)  
**Stage:** 1 of 16 (Phase 0 Pre-Launch)  
**Parent Document:** [`independent-mapping-engine-concept-paper.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/independent-mapping-engine-concept-paper.md) (§13, §13.1, §5.4, §14.4)  
**TOC Link:** [`000_TOC.md`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/plans/000_TOC.md)  
**Current Status:** **partiallydone** (Base assets exist in `docs/resources/`; Pin Tool v1 in resources [v2 pending replacement]; ingestion pipeline, tool updates, and field campaign pending execution)  

---

## 1. Executive Summary & Objective

The primary challenge of an autonomous search and geocoding engine is the **cold-start dilemma**: until vehicles drive and passengers complete trips, the voting ledger contains zero empirical drop-off evidence. If the platform launches with an empty gazetteer, 100% of initial rider searches fall through to commercial vendor APIs, reinforcing vendor exposure bias (§5.4).

To resolve cold start with absolute clean-room provenance and empirical accuracy, Stage 001 implements:
1. **Source Data Asset Accounting:** Full technical accounting of the verified 101,884 POIs in `docs/resources/bangladesh.poi` and establishing the direct-from-PBF production pipeline.
2. **Strict Physical & Index ODbL Separation:** Storing open POIs in a distinct `dpmaps.osm_pois` table and maintaining **two separate physical search indexes** (first-party vs. OSM) merged only at query time.
3. **23-Category Pin Tool Taxonomy:** Supporting 23 granular Pin Tool categories (mapping to standard `public_pois` categories including `healthcare` and `retail`) to fulfill the categorical queries promised in §14.4.
4. **Landmark Pin Tool Architecture & Status:** Accurate documentation of the Leaflet/Express/better-sqlite3 Pin Tool, correct extraction path (`tools/`), status of v1 vs. v2 build items, and the remaining backlog (including OSM candidate import).
5. **Venue & Perimeter Gate Linkage:** Introducing `parent_place_id` so that individual station and mall gates link directly to parent venues for pickup snapping (Stage 013).
6. **Granular Administrative Boundaries:** Ingesting geoBoundaries ADM3 (Thana/Upazila) boundaries and simplifying geometries while preserving `geom_full`.
7. **Empirically Calibrated Field Survey Plan:** Pilot-derived staffing and compensation, OSM candidate seeding, and visual curb-check QA auditing.

---

## 2. Source Data Assets & Ground-Truth Inventory

The project repository contains the following base assets in `docs/resources/`:

| Asset File | Size | Format / Structure | Empirical Characteristics & Ground-Truth Status |
|---|:---:|:---:|---|
| [`docs/resources/bangladesh.poi`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/resources/bangladesh.poi) | 24,276,992 bytes | SQLite 3 (Mapsforge POI DB; writer: `mapsforge-poi-writer`) | **101,884 POI records** derived from OpenStreetMap (`© OpenStreetMap contributors`).<br>• Snapshot Date: **25 Feb 2026** (Stale relative to current road PBF).<br>• Table Structure: `poi_data` (columns: `id`, `data`), `poi_index` (columns: `id`, `lat`, `lon`). Column `data` contains `\r`-separated key-values.<br>• IDs: Sequential row indices (0 to 101,883), **not real OSM IDs**.<br>• Script Profile: 77.5% named; only 6.2% have `name:bn`; 11.2% have `name:en`; ~16% have Bengali script in `name`; ~3,169 mixed-script names have neither an English nor a Bangla tag (searchable on `name`).<br>• Dhaka Bounding Box: 26,619 POIs, 77.1% named, 1,883 with `name:bn`.<br>• Ingestion Reality: **49,881 named places stored** across 19 mapped categories post-deduplication; 28,661 named places are unmapped niche shops/amenities; ~17,323 are dropped noise.<br>• Near-Duplicates: ~1,874 near-duplicate pairs (same name within 25m).<br>• Gap: Zero traffic signal/intersection nodes. |
| [`docs/resources/dpmaps-poi-tool.zip`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/resources/dpmaps-poi-tool.zip) | 12,319 bytes (27,671 uncompressed) | ZIP archive (Node.js/Express) | **Landmark Pin Tool (v1 Baseline in resources):**<br>• Architecture: Express 4.19, `better-sqlite3`, Leaflet 1.9.4 on OpenStreetMap raster tiles.<br>• Auth: Shared contributor key (`x-contributor-key`), basic auth for `/admin`.<br>• Schema: `pois` table (`id`, `name_bn`, `name_en`, `category`, `lat`, `lng`, `notes`, `contributor`, `status`).<br>• Note: v1 ZIP does not yet include v2 features (aliases, warranty, public_pois export). Status detailed in §5.3. |
| [`docs/resources/geoBoundaries-BGD-ADM0.geojson`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/resources/geoBoundaries-BGD-ADM0.geojson) | 66,748 bytes | GeoJSON FeatureCollection | National boundary polygon for Bangladesh (1,513 vertices; coarse coastline). |
| [`docs/resources/geoBoundaries-BGD-ADM1.geojson`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/resources/geoBoundaries-BGD-ADM1.geojson) | 102,643 bytes | GeoJSON FeatureCollection | 8 administrative division boundaries (Dhaka, Chittagong, Sylhet, etc.). |
| [`docs/resources/geoBoundaries-BGD-ADM2.geojson`](file:///D:/My%20Projects/Current%20Project/dpMaps/docs/resources/geoBoundaries-BGD-ADM2.geojson) | 46,554,183 bytes | GeoJSON FeatureCollection | 64 district boundaries. High-vertex geometry (46.5 MB) requiring polygon simplification for low-latency spatial indexing. |

### 2.1 POI Rebuild & Ingestion Architecture: PBF vs. Mapsforge
In `bangladesh.poi`, IDs are arbitrary SQLite row numbers (0 to 101,883). If a new Mapsforge file is built, row IDs shift, breaking incremental reconciliation and making `ON CONFLICT (id) DO NOTHING` preserve stale records. Furthermore, `osmium` cannot write Mapsforge binary format.

**Production Ingestion Strategy:**
1. **Day-1 Baseline Asset:** `bangladesh.poi` is used exclusively for immediate local development, testing, and offline baseline comparisons. Baseline rows are ingested with `osm_type = 'M'` (Mapsforge baseline).
2. **Production Extraction Pipeline (`scripts/extract-osm-pois.sh`):** Open POIs will be extracted directly from `bangladesh-latest.osm.pbf` using `osmium tags-filter` and exported via GeoJSON / JSONL.
3. **Stable Natural Primary Keys:** Every ingested OSM entity uses its real OpenStreetMap identity:
   $$\text{Primary Key} = (\text{osm\_type}, \text{osm\_id}) \quad \text{e.g. } ('N', 12345678), ('W', 98765432)$$
4. **Cutover Purge & Reconciliation:** When the PBF pipeline goes live, all temporary baseline rows are purged (`DELETE FROM dpmaps.osm_pois WHERE osm_type = 'M'`). Rebuilds run on the bi-weekly OSRM schedule with upserts on `(osm_type, osm_id)` and soft deletion (`is_deleted = TRUE`) on missing rows.

---

## 3. The 23-Category Pin Tool Taxonomy & Database Mapping

The Pin Tool standardizes on **23 discrete categories** to capture urban destinations accurately. These map into `dpmaps.public_pois.category` (which requires Stage 003's schema to include `healthcare` and `retail`):

| Pin Tool Category (23 total) | `public_pois.category` | `point_type` | OSM Ingestion Matching Rule | Measured Stored POIs (Post-Dedupe) |
|---|---|---|---|:---:|
| `mosque` | `religious` | `entrance` | `amenity=place_of_worship` AND `religion=muslim` | **10,702** |
| `school` | `school` | `entrance` | `amenity=school` | **7,600** |
| `restaurant` | `food` | `building` | `amenity=restaurant\|cafe\|fast_food` | **5,388** |
| `bank` | `financial` | `building` | `amenity=bank` | **3,893** |
| `pharmacy` | `healthcare` | `building` | `amenity=pharmacy` OR `healthcare=pharmacy` | **3,772** |
| `hospital` | `hospital` | `entrance` | `amenity=hospital\|clinic\|doctors` | **3,051** |
| `station` | `transit` | `entrance` | `railway=station` OR `highway=bus_stop` | **2,945** |
| `government` | `government` | `entrance` | `office=government` | **2,281** |
| `worship` | `religious` | `entrance` | `amenity=place_of_worship` AND `religion!=muslim` | **1,805** |
| `fuel` | `transit` | `entrance` | `amenity=fuel` | **1,737** |
| `university` | `university` | `entrance` | `amenity=university\|college` | **1,495** |
| `hotel` | `hotel` | `entrance` | `tourism=hotel\|guest_house\|hostel` | **1,420** |
| `area` | `area` | `area` | `place=suburb\|neighbourhood\|quarter` | **749** |
| `supermarket` | `retail` | `entrance` | `shop=supermarket` | **727** |
| `park` | `recreation` | `entrance` | `leisure=park\|stadium` | **709** |
| `mall` | `mall` | `entrance` | `shop=mall` | **610** |
| `atm` | `financial` | `dropoff_point` | `amenity=atm` | **497** |
| `market` | `market` | `entrance` | `amenity=marketplace` OR `shop=convenience` | **473** |
| `airport` | `transit` | `entrance` | `aeroway=terminal\|aerodrome` | **27** |
| `office` | `commercial` | `entrance` | `office=company`, `building=commercial` | *(Ingested from PBF)* |
| `society_gate` | `society_gate` | `entrance` | `barrier=gate\|lift_gate` | *(Field survey / PBF)* |
| `intersection` | `landmark` | `dropoff_point` | *(Zero in OSM; 100% field survey)* | **0** |
| `other` | `other` | `dropoff_point` | Fallback for verified custom entries | **0** *(Unmapped dropped)* |
| **TOTAL STORED** | | | | **49,881** |

*Critical Findings from Empirical File Audit:*
1. **Measured Stored Total:** Ingestion of `bangladesh.poi` yields exactly **49,881 post-deduplication records** across the 19 mapped categories.
2. **Religious Separation:** Place of worship is divided by the `religion` tag: 10,702 Muslim (`mosque`), 1,805 other religions (`worship`).
3. **Unmapped Noise Exclusion:** Approximately **28,661 named places** in `bangladesh.poi` represent niche shops (clothes 1,663, electronics 1,237, furniture 743), police outposts, and local services that do not match the transit navigation taxonomy. They are **explicitly not stored** in `dpmaps.osm_pois` to prevent index bloat, with counts recorded in build logs.
4. **Intersections:** Intersections remain **entirely absent from the OSM data**. The 300-point intersection and gate quota depends 100% on the field survey campaign.

---

## 4. The 2,000 Dhaka Landmark Seeding Quotas & Venue Linkage

Field collection is constrained to verified public destinations, transit portals, and navigational landmarks within the Greater Dhaka metropolitan area:

```
Target Collection Quotas (Total: 2,000 Points):
├── 🏙️ Neighborhood Areas & Sectors (Quota: 250 Points)
│    ├── Primary Wards & Zones: Banani, Gulshan 1/2, Dhanmondi, Wari, Badda, Niketan, Mohakhali
│    ├── Planned Townships: Uttara Sectors 1–18, Mirpur Sections 1–14, Bashundhara R/A Blocks A–P
│    └── Historic Neighborhoods: Lalbagh, Armanitola, Sutrapur, Shantinagar, Chawkbazar
├── 🚇 Transit Hubs & Gates (Quota: 250 Points)
│    ├── MRT Line 6: Stations & individual concourse/gate exits (Uttara North to Motijheel)
│    │    └── [UNVERIFIED: confirm exact count of active stations (~16) and gates (~64) as of survey date]
│    ├── Airport: Hazrat Shahjalal International Airport (T1, T2, Cargo, Domestic, Hajj Camp)
│    ├── Railway Terminals: Kamalapur, Airport Station, Tejgaon, Cantonment
│    └── Inter-District Bus Terminals: Gabtoli, Sayedabad, Mohakhali, Fulbaria
├── 🏥 Healthcare & Pharmacies (Quota: 250 Points)
│    ├── Tertiary Hospitals: Dhaka Medical College (DMC), BSMMU, Square, United, Evercare, Labaid, BIRDEM
│    ├── Specialized Clinics: Ibn Sina, Popular, Medinova, National Heart Foundation
│    └── Landmark Flagship Pharmacies: Lazz Pharma Kalabagan/Panthapath, Tamanna Pharmacy
├── 🛍️ Retail & Commercial Markets (Quota: 350 Points)
│    ├── Modern Malls (150 Points): Jamuna Future Park, Bashundhara City, Shimanto Square, Police Plaza
│    └── Traditional Markets (200 Points): New Market, Gausia, Karwan Bazar, Chawkbazar, Elephant Road
├── 🎓 Educational Institutions (Quota: 250 Points)
│    ├── Universities (150 Points): DU, BUET, DMC, NSU, IUB, BRACU, AIUB, UIU
│    └── Schools & Colleges (100 Points): Notre Dame College, Dhaka College, Viqarunnisa, Ideal School
├── 🏢 Commercial, Financial & Government (Quota: 350 Points)
│    ├── Government & Embassies (150 Points): Bangladesh Secretariat, City Corporations, US Embassy
│    └── Corporate Towers & Banking Hubs (200 Points): Motijheel C/A, Dilkusha, Gulshan Circle 2 Towers
└── 🚪 Residential Society Gates & Major Intersections (Quota: 300 Points)
     ├── DOHS Checkpoints: Mohakhali DOHS, Mirpur DOHS, Baridhara DOHS, Banani DOHS Gates
     └── Major Intersections / Mors: Bata Signal, Farmgate Mor, Nilkhet Mor, Shahbagh Mor, Kakoli Mor
```

### 4.1 Parent Venue Linkage (`parent_place_id`)
Pickup snapping (Stage 013) requires linking pedestrian gates (e.g. "Gate 2") to parent venues (e.g. "Jamuna Future Park").

Every gate or entrance record in `dpmaps.public_pois` incorporates a nullable foreign key:
```sql
ALTER TABLE dpmaps.public_pois 
  ADD COLUMN parent_place_id UUID REFERENCES dpmaps.public_pois(id) ON DELETE SET NULL;

CREATE INDEX idx_pois_parent_place_id ON dpmaps.public_pois(parent_place_id);
```
- For venue centroids (`point_type = 'building'` or `'area'`), `parent_place_id` is `NULL`.
- For specific perimeter gates (`point_type = 'entrance'`), `parent_place_id` points to the venue's UUID.

---

## 5. Landmark Pin Tool Architecture & Status

### 5.1 As-Built Tool Architecture (v1 in resources)
The tool currently in `docs/resources/dpmaps-poi-tool.zip` is built with Express 4.19, `better-sqlite3`, and Leaflet 1.9.4:
- **Server:** Node.js Express server with in-memory rate limiting and HTTP Basic Auth on `/admin`.
- **Database:** Local SQLite database (`pois.db`) with WAL mode.
- **Frontend:** Leaflet map with standard OpenStreetMap raster tiles.
- **Authentication:** Contributor access governed via shared header key (`x-contributor-key`); admin protected by `ADMIN_PASSWORD`.
- **Duplicate Prevention:** In-process duplicate detector flags entries within 50m (`DUP_RADIUS_M = 50`) sharing matching normalized names.

### 5.2 Correct Extraction Target
The ZIP archive contains a top-level `poi-tool/` root directory. Extraction must target `tools/` directly:
```powershell
# Extracts archive directly to tools/ resulting in tools/poi-tool
Expand-Archive -Path "docs/resources/dpmaps-poi-tool.zip" -DestinationPath "tools"
cd tools/poi-tool
npm install
```

### 5.3 Pin Tool Feature Matrix & Upgrade Backlog

> [!NOTE]
> The ZIP file in `docs/resources/dpmaps-poi-tool.zip` is byte-for-byte the v1 baseline (12,319 bytes). The latest tool build has already implemented several features, but the zip file in `docs/resources` must be replaced with the updated archive.

| Feature / Capability | Implementation Status | Plan & Backlog Requirements |
|---|:---:|---|
| **Colloquial Aliases Field** | 🟡 Built in latest build; pending ZIP replacement | Input field in UI; persisted in `pois.notes` / dedicated column. |
| **Clean-Room Warranty Checkbox** | 🟡 Built in latest build; pending ZIP replacement | Mandatory checkbox on submit; records version and timestamp. |
| **OSM-Only Basemap** | 🟡 Built in latest build; pending ZIP replacement | Uses exclusively OpenStreetMap tiles; Esri satellite layers removed. |
| **`public_pois` Exporter** | 🟡 Built in latest build; pending ZIP replacement | Built as `/api/admin/export.public_pois.sql` and `.json` (currently paper schema). **Backlog:** Align output columns to Stage 003 schema. |
| **23 Categories Update** | 🔴 Pending Backlog | Update `CATEGORIES` array in `server.js` and `index.html` to include `pharmacy`, `fuel`, `supermarket`, `atm`, and `society_gate`. |
| **Venue Linkage Dropdown (`parent_venue`)** | 🔴 Pending Backlog | Add parent venue selector for gates, stations, and hospital entrances. |
| **Per-Surveyor Auth Tokens** | 🔴 Pending Backlog | Replace shared key with unique surveyor tokens (Stage 002 alignment). |
| **OSM Candidate Import ("Confirm/Move Pin")** | 🔴 Pending Backlog | Endpoint `/api/admin/seed-candidates` to ingest candidate points from `dpmaps.osm_pois` into a "To Verify" review layer so field surveyors can tap an existing candidate, confirm names, and drag the pin to the physical curb. |

---

## 6. Open POI Ingestion Pipeline (`bangladesh.poi` Baseline)

To prevent ODbL contamination while maximizing coverage, Stage 001 implements an automated ingestion script:

```
[ bangladesh.poi (SQLite) ]
          │
          ▼
[ Extraction & Filtering Worker (ingest_open_pois.py) ]
  ├── Filter 1: Has non-empty name (name, name:en, or name:bn)
  ├── Filter 2: Drop Noise (chimneys, toilets, wells, playgrounds, villages)
  ├── Filter 3: Tag-Based Category Mapping (23 Pin Tool categories)
  │             (Drop unmapped named places -> 28,661 logged as dropped)
  ├── Filter 4: Script Classification (Bangla vs. Latin)
  ├── Filter 5: Neighbour-Cell Dedupe (H3 grid_disk k=1 within 25m; richer record wins)
  │             (Prevents suppressed candidates from suppressing others)
  └── Tag License: 'osm_odbl_attributed' (osm_type = 'M' for Mapsforge baseline)
          │
          ▼
[ Insert into SEPARATE dpmaps.osm_pois table ]
  (NEVER merged into dpmaps.public_pois; queried via separate search index)
```

### 6.1 Database Extensions & Schema: `dpmaps.osm_pois`
```sql
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE TABLE dpmaps.osm_pois (
  osm_type CHAR(1) NOT NULL, -- 'N' (node), 'W' (way), 'R' (relation), 'M' (Mapsforge baseline)
  osm_id BIGINT NOT NULL,
  name VARCHAR(255) NOT NULL,
  name_en VARCHAR(255),
  name_bn VARCHAR(255),
  primary_script VARCHAR(10) NOT NULL, -- 'bengali', 'latin', 'mixed'
  category VARCHAR(64) NOT NULL,
  tags JSONB NOT NULL DEFAULT '{}',
  h3_res9 VARCHAR(15) NOT NULL,
  h3_res10 VARCHAR(15) NOT NULL,
  geom GEOMETRY(Point, 4326) NOT NULL,
  license_classification VARCHAR(32) NOT NULL DEFAULT 'osm_odbl_attributed',
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (osm_type, osm_id)
);

CREATE INDEX idx_osm_pois_geom ON dpmaps.osm_pois USING GIST (geom);
CREATE INDEX idx_osm_pois_h3_res9 ON dpmaps.osm_pois (h3_res9);
CREATE INDEX idx_osm_pois_category ON dpmaps.osm_pois (category);
CREATE INDEX idx_osm_pois_name_trgm ON dpmaps.osm_pois USING GIN (name gin_trgm_ops);
```

### 6.2 Complete Ingestion Script: `tools/scripts/ingest_open_pois.py`
```python
#!/usr/bin/env python3
"""
ingest_open_pois.py - Ingests, filters, deduplicates, and classifies POIs from
bangladesh.poi into dpmaps.osm_pois with strict ODbL license isolation.
"""
import sqlite3
import psycopg2
from psycopg2.extras import execute_batch
import json
import re
import math
import h3

# Noise tags to explicitly drop (~17,000+ entries)
DROPPED_AMENITIES = {'toilets', 'waste_basket', 'bench', 'drinking_water', 'watering_place'}
DROPPED_MAN_MADE = {'chimney', 'water_well', 'works', 'water_tap', 'storage_tank', 'tower'}
DROPPED_LEISURE = {'playground'}
DROPPED_PLACES = {'village', 'hamlet', 'isolated_dwelling'}

def parse_data_column(raw_data):
    tags = {}
    for line in raw_data.split('\r'):
        line = line.strip()
        if '=' in line:
            k, v = line.split('=', 1)
            tags[k.strip()] = v.strip()
    return tags

def map_category(tags):
    # Railway & Bus Stations
    if tags.get('railway') == 'station' or tags.get('highway') == 'bus_stop':
        return 'station'
    
    # Hospitality
    if tags.get('tourism') in {'hotel', 'guest_house', 'hostel'}:
        return 'hotel'
        
    # Areas & Neighborhoods
    if tags.get('place') in {'suburb', 'neighbourhood', 'quarter'}:
        return 'area'
        
    # Parks & Recreation
    if tags.get('leisure') in {'park', 'stadium'}:
        return 'park'
        
    # Airports & Aviation
    if tags.get('aeroway') in {'terminal', 'aerodrome'}:
        return 'airport'
        
    # Markets & Convenience
    if tags.get('amenity') == 'marketplace' or tags.get('shop') == 'convenience':
        return 'market'
        
    # Places of Worship (split by religion)
    if tags.get('amenity') == 'place_of_worship':
        return 'mosque' if tags.get('religion') == 'muslim' else 'worship'
        
    # Government Offices
    if tags.get('office') == 'government':
        return 'government'

    # Healthcare
    if tags.get('amenity') == 'pharmacy' or tags.get('healthcare') == 'pharmacy':
        return 'pharmacy'
    if tags.get('amenity') in {'hospital', 'clinic', 'doctors'}:
        return 'hospital'

    # Education
    if tags.get('amenity') in {'university', 'college'}:
        return 'university'
    if tags.get('amenity') == 'school':
        return 'school'

    # Retail & Commercial
    if tags.get('shop') == 'supermarket':
        return 'supermarket'
    if tags.get('shop') == 'mall':
        return 'mall'

    # Food & Dining
    if tags.get('amenity') in {'restaurant', 'cafe', 'fast_food'}:
        return 'restaurant'

    # Financial & Fuel
    if tags.get('amenity') == 'bank':
        return 'bank'
    if tags.get('amenity') == 'atm':
        return 'atm'
    if tags.get('amenity') == 'fuel':
        return 'fuel'

    return None # Unmapped categories return None to be dropped

def classify_script(text):
    has_bn = bool(re.search(r'[\u0980-\u09FF]', text))
    has_lat = bool(re.search(r'[a-zA-Z]', text))
    if has_bn and has_lat:
        return 'mixed'
    return 'bengali' if has_bn else 'latin'

def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return 2 * R * math.asin(math.sqrt(a))

def run_pipeline(sqlite_path, pg_conn_str):
    print(f"Opening SQLite source: {sqlite_path}")
    sq_conn = sqlite3.connect(sqlite_path)
    sq_cur = sq_conn.cursor()

    # Column in poi_data is 'data' (not 'tags')
    sq_cur.execute("""
        SELECT d.id, d.data, i.lat, i.lon 
        FROM poi_data d 
        JOIN poi_index i ON d.id = i.id
    """)

    candidates = []
    dropped_noise = 0
    dropped_unnamed = 0
    dropped_unmapped_category = 0

    for row_id, raw_data, lat, lon in sq_cur:
        tags = parse_data_column(raw_data)
        
        # Filter 1: Drop unnamed
        name = tags.get('name') or tags.get('name:en') or tags.get('name:bn')
        if not name or len(name.strip()) < 2:
            dropped_unnamed += 1
            continue

        # Filter 2: Drop noise
        if tags.get('amenity') in DROPPED_AMENITIES or \
           tags.get('man_made') in DROPPED_MAN_MADE or \
           tags.get('leisure') in DROPPED_LEISURE or \
           tags.get('place') in DROPPED_PLACES:
            dropped_noise += 1
            continue

        # Filter 3: Category mapping (unmapped dropped to prevent index bloat)
        category = map_category(tags)
        if not category:
            dropped_unmapped_category += 1
            continue

        # Script classification
        script = classify_script(name)
        name_en = tags.get('name:en')
        name_bn = tags.get('name:bn')
        if not name_en and script == 'latin':
            name_en = name
        if not name_bn and script == 'bengali':
            name_bn = name

        # Compute H3 cells
        h3_9 = h3.latlng_to_cell(lat, lon, 9)
        h3_10 = h3.latlng_to_cell(lat, lon, 10)

        candidates.append({
            'osm_type': 'M', # 'M' for Mapsforge baseline; purged upon PBF cutover
            'osm_id': row_id,
            'name': name.strip(),
            'name_en': name_en.strip() if name_en else None,
            'name_bn': name_bn.strip() if name_bn else None,
            'primary_script': script,
            'category': category,
            'tags': json.dumps(tags),
            'lat': lat,
            'lon': lon,
            'h3_res9': h3_9,
            'h3_res10': h3_10,
            'richness': len(tags) + (2 if name_bn and name_en else 0)
        })

    print(f"Retained candidates before dedupe: {len(candidates)}")
    print(f"Dropped: unnamed: {dropped_unnamed}, noise: {dropped_noise}, unmapped category: {dropped_unmapped_category}")

    # Filter 4: Spatial Deduplication with H3 grid_disk (k=1) & Richer-Record-Wins
    # Fix: once cand is suppressed, it breaks and never suppresses other records
    print("Deduplicating with neighbor-cell inspection (grid_disk k=1) within 25m...")
    spatial_index = {} # cell -> list of candidate indices
    for idx, c in enumerate(candidates):
        spatial_index.setdefault(c['h3_res9'], []).append(idx)

    suppressed_indices = set()

    for idx, cand in enumerate(candidates):
        if idx in suppressed_indices:
            continue
        norm_name = cand['name'].lower().strip()
        neighbor_cells = h3.grid_disk(cand['h3_res9'], 1)
        
        cand_was_suppressed = False
        for cell in neighbor_cells:
            if cand_was_suppressed:
                break
            for other_idx in spatial_index.get(cell, []):
                if other_idx <= idx or other_idx in suppressed_indices:
                    continue
                other = candidates[other_idx]
                if other['name'].lower().strip() == norm_name:
                    if haversine_m(cand['lat'], cand['lon'], other['lat'], other['lon']) < 25.0:
                        if other['richness'] > cand['richness']:
                            suppressed_indices.add(idx)
                            cand_was_suppressed = True
                            break # cand suppressed; stop checking other neighbors for cand
                        else:
                            suppressed_indices.add(other_idx)

    deduped = [c for idx, c in enumerate(candidates) if idx not in suppressed_indices]
    print(f"Final deduplicated count: {len(deduped)} (removed {len(suppressed_indices)} duplicates)")

    # Batch Insert / Upsert into PostGIS dpmaps.osm_pois
    print("Inserting into PostGIS dpmaps.osm_pois...")
    pg_conn = psycopg2.connect(pg_conn_str)
    pg_cur = pg_conn.cursor()

    insert_query = """
        INSERT INTO dpmaps.osm_pois (
            osm_type, osm_id, name, name_en, name_bn, primary_script, category, tags,
            h3_res9, h3_res10, geom, license_classification
        ) VALUES (
            %(osm_type)s, %(osm_id)s, %(name)s, %(name_en)s, %(name_bn)s, %(primary_script)s, %(category)s, %(tags)s,
            %(h3_res9)s, %(h3_res10)s, ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326), 'osm_odbl_attributed'
        ) ON CONFLICT (osm_type, osm_id) DO UPDATE SET
            name = EXCLUDED.name,
            name_en = EXCLUDED.name_en,
            name_bn = EXCLUDED.name_bn,
            category = EXCLUDED.category,
            primary_script = EXCLUDED.primary_script,
            tags = EXCLUDED.tags,
            h3_res9 = EXCLUDED.h3_res9,
            h3_res10 = EXCLUDED.h3_res10,
            geom = EXCLUDED.geom,
            is_deleted = FALSE,
            updated_at = NOW();
    """
    execute_batch(pg_cur, insert_query, deduped, page_size=1000)
    pg_conn.commit()
    print(f"Ingestion complete: {len(deduped)} rows stored.")

if __name__ == '__main__':
    run_pipeline("docs/resources/bangladesh.poi", "dbname=ride user=postgres host=localhost port=5432")
```

### 6.3 Physical Search Index Isolation & Attribution Invariant
- **Two Separate Physical Search Indexes:**
  - `dpmaps_first_party` (MeiliSearch index for `dpmaps.public_pois` & merchant places).
  - `dpmaps_osm` (MeiliSearch index for `dpmaps.osm_pois`).
  - Merging occurs **strictly at query time** in `searchOrchestrator.ts`. Maintaining two physically separate index files completely prevents ODbL derivative-database share-alike exposure.
- **Client Attribution Requirement:** Whenever an unbadged open POI from `dpmaps.osm_pois` is rendered on the client map or search dropdown, the client footer must render:
  > *"Map data & POIs © OpenStreetMap contributors under ODbL."*
- **"Ride Verified" Badge Scoping:** Open POIs from `dpmaps.osm_pois` **NEVER** receive the "Ride Verified" badge in search autocomplete. The high-trust badge is reserved exclusively for clean-room field surveys (`pin_tool`) and onboarded merchants (`merchant_onboarding`).

---

## 7. Granular Administrative Boundaries: ADM3 & Geometry Simplification

### 7.1 The ADM2 Resolution Problem & ADM3 Upazilas/Thanas
The existing `geoBoundaries-BGD-ADM2.geojson` file represents Bangladesh's 64 districts. In this file, **Dhaka District is a single monolithic polygon** spanning over 1,460 km². District-level boundaries cannot support compound address parsing (*"Road 4, Block C, Banani"*) or thana-level fallback geocoding.

### 7.2 ADM3 Ingestion Plan
Stage 001 ingests **geoBoundaries ADM3 (Thana / Upazila level)** for Greater Dhaka:
- **Boundary Source:** `geoBoundaries-BGD-ADM3.geojson` (maintaining consistency with the existing ADM0, ADM1, and ADM2 files).
- **Urban Thana Verification Gate:** `[UNVERIFIED - verify that Dhaka city police thanas such as Dhanmondi, Gulshan, Mirpur, and Uttara appear as discrete polygons in the geoBoundaries ADM3 extract before relying on them for address parsing]`. If urban DMP thanas are aggregated into a single municipal polygon, supplement with Dhaka City Corporation (DNCC/DSCC) ward boundaries.

### 7.3 Dual Geometry Storage & Simplification
The raw ADM2 GeoJSON is **46.5 MB** with tens of thousands of vertices per polygon. Point-in-polygon queries against raw geometries incur estimated CPU latency of 100–300ms `[ESTIMATE]`.

**Dual Geometry Schema (`dpmaps.admin_boundaries`):**
```sql
ALTER TABLE dpmaps.admin_boundaries
  ADD COLUMN geom_full GEOMETRY(MultiPolygon, 4326),
  ADD COLUMN geom GEOMETRY(MultiPolygon, 4326);

-- Store full fidelity original geometry in geom_full;
-- Store topology-preserved simplified geometry in geom for runtime lookups:
UPDATE dpmaps.admin_boundaries
SET geom_full = raw_imported_geom,
    geom = ST_Multi(ST_SimplifyPreserveTopology(raw_imported_geom, 0.0001));
```
*Latency & Size Impact:* Simplification reduces runtime geometry size by an estimated >80% `[ESTIMATE]` and targets spatial containment queries under 2ms `[ESTIMATE]`, while `geom_full` permanently preserves raw cartographic precision.

---

## 8. Landmark Field Survey Operating Plan

To collect the 2,000 clean-room Dhaka landmarks, the campaign executes an empirically calibrated operating model:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        FIELD SURVEY CAMPAIGN OPERATING MODEL                           │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ PHASE 1: PILOT CAMPAIGN (50 Landmarks)                                                 │
│ • Area: Dhanmondi (Wards 15, 32) and Gulshan 1/2                                       │
│ • Staffing: 2 Core Systems / Product Engineers                                         │
│ • Goals: Measure true on-site survey minutes per pin, test OSM candidate import,       │
│   measure mobile GPS drift vs. physical curb, and calibrate compensation rate.         │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ PHASE 2: FULL FIELD CAMPAIGN (1,950 Landmarks)                                         │
│ • Staffing Baseline: ~6 Surveyors over ~2 weeks [ESTIMATE - to be set by Pilot Phase]  │
│ • Workflow: OSM Candidate Seeding pre-loads known venues into surveyor map;            │
│   surveyor physically visits venue, verifies entrance curb, enters bilingual names,    │
│   attaches aliases, and checks clean-room warranty.                                    │
│ • Compensation Baseline: ~৳50–৳80 BDT per approved entry [ESTIMATE - set by Pilot]     │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ PHASE 3: QUALITY ASSURANCE & AUDITING                                                   │
│ • Independent Spot Check: 5–10% second-person field audit (100–200 points).            │
│ • Audit Standard: Visual verification against physical curb entrance OR                │
│   maximum 25-meter tolerance [accounting for Dhaka urban canyon GPS drift].            │
│ • Fraud Rule: If a surveyor exhibits >5% fake/displaced pins, their entire batch       │
│   is revoked and re-surveyed.                                                          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 8.1 Acceptance Criteria per Category
- **Transit Stations / Gates:** Marker must be placed on the physical roadside pedestrian exit gate, NOT the center of the railway track or elevated platform.
- **Hospitals & Malls:** Marker must be placed at the primary vehicle drop-off / emergency gate curb.
- **Society Gates:** Marker must be placed on the physical security barrier / gatehouse curb.
- **Areas & Neighborhoods:** Marker placed at the established geographic or commercial centroid.

---

## 9. Deliverables & Definition of Done

- [ ] `tools/poi-tool` extracted to `tools/poi-tool` (without folder nesting) and dependencies installed.
- [ ] Pin Tool backlog executed: 23 categories, parent venue linkage, per-surveyor tokens, OSM candidate import tool, and export schema alignment with Stage 003.
- [ ] Direct PBF extraction pipeline (`scripts/extract-osm-pois.sh`) configured with `(osm_type, osm_id)` natural primary keys and soft-delete updates.
- [ ] Open POI pipeline (`tools/scripts/ingest_open_pois.py`) extracts, cleans, classifies, and loads `bangladesh.poi` baseline into `dpmaps.osm_pois` (**49,881 stored post-dedupe**, 28,661 unmapped logged).
- [ ] Physical search index isolation verified: `dpmaps_first_party` and `dpmaps_osm` maintained as separate MeiliSearch indexes merged strictly at query time.
- [ ] geoBoundaries ADM3 boundaries ingested; ADM2 dual geometries (`geom` simplified, `geom_full` raw) deployed.
- [ ] 50-place field survey pilot completed in Dhanmondi/Gulshan; surveyor throughput and pay calibrated.
- [ ] Full 2,000-point Dhaka landmark campaign completed across all 7 quota categories.
- [ ] **Falsifiable Verification Audit:**
  - 100% of rows in `dpmaps.public_pois` carry `source_type = 'pin_tool'`, `contributor_name`, `warranty_version`, and `warranty_timestamp`.
  - Independent 5% spot audit confirms pin accuracy via visual curb check or within 25 meters.
  - Zero third-party commercial vendor IDs or API keys present in data stores.
- [ ] "Ride Verified" badge surfaces exclusively on `pin_tool` and `merchant_onboarding` records; open OSM records remain unbadged with ODbL attribution.
