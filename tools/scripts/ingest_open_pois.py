#!/usr/bin/env python3
"""
ingest_open_pois.py - Ingests, filters, deduplicates, and classifies POIs from
bangladesh.poi into dpmaps.osm_pois with strict ODbL license isolation and
schema-of-record alignment (Stage 003 composite PK: osm_type, osm_id, snapshot_date).
"""
import sqlite3
import psycopg2
from psycopg2.extras import execute_batch
import json
import re
import math
import h3

SNAPSHOT_DATE = '2026-02-25'

# Noise tags to explicitly drop (~8,858 entries)
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
    # Railway & Bus Stations -> canonical transit_station
    if tags.get('railway') == 'station' or tags.get('highway') == 'bus_stop':
        return 'transit_station'
    
    # Hospitality -> canonical hotel
    if tags.get('tourism') in {'hotel', 'guest_house', 'hostel'}:
        return 'hotel'
        
    # Areas & Neighborhoods -> canonical area
    if tags.get('place') in {'suburb', 'neighbourhood', 'quarter'}:
        return 'area'
        
    # Parks & Recreation -> canonical park
    if tags.get('leisure') in {'park', 'stadium'}:
        return 'park'
        
    # Airports & Aviation -> canonical airport
    if tags.get('aeroway') in {'terminal', 'aerodrome'}:
        return 'airport'
        
    # Markets & Convenience -> canonical market
    if tags.get('amenity') == 'marketplace' or tags.get('shop') == 'convenience':
        return 'market'
        
    # Places of Worship (split by religion) -> canonical mosque / worship
    if tags.get('amenity') == 'place_of_worship':
        return 'mosque' if tags.get('religion') == 'muslim' else 'worship'
        
    # Government Offices -> canonical government
    if tags.get('office') == 'government':
        return 'government'

    # Healthcare -> canonical pharmacy / hospital
    if tags.get('amenity') == 'pharmacy' or tags.get('healthcare') == 'pharmacy':
        return 'pharmacy'
    if tags.get('amenity') in {'hospital', 'clinic', 'doctors'}:
        return 'hospital'

    # Education -> canonical university / school
    if tags.get('amenity') in {'university', 'college'}:
        return 'university'
    if tags.get('amenity') == 'school':
        return 'school'

    # Retail & Commercial -> canonical supermarket / shopping_mall
    if tags.get('shop') == 'supermarket':
        return 'supermarket'
    if tags.get('shop') == 'mall':
        return 'shopping_mall'

    # Food & Dining -> canonical restaurant
    if tags.get('amenity') in {'restaurant', 'cafe', 'fast_food'}:
        return 'restaurant'

    # Financial & Fuel -> canonical bank / atm / fuel
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

def run_pipeline(sqlite_path, pg_conn_str=None):
    print(f"Opening SQLite source: {sqlite_path}")
    sq_conn = sqlite3.connect(sqlite_path)
    sq_cur = sq_conn.cursor()

    sq_cur.execute("""
        SELECT d.id, d.data, i.lat, i.lon 
        FROM poi_data d 
        JOIN poi_index i ON d.id = i.id
    """)

    candidates = []
    dropped_noise = 0
    dropped_unnamed = 0
    dropped_unmapped_category = 0
    total_scanned = 0

    for row_id, raw_data, lat, lon in sq_cur:
        total_scanned += 1
        tags = parse_data_column(raw_data)
        
        # Filter 1: Drop unnamed (< 2 characters)
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
            'snapshot_date': SNAPSHOT_DATE,
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

    print(f"Total rows scanned: {total_scanned}")
    print(f"Retained candidates before dedupe: {len(candidates)}")
    print(f"Dropped: unnamed: {dropped_unnamed}, noise: {dropped_noise}, unmapped: {dropped_unmapped_category}")

    # Filter 4: Spatial Deduplication with H3 grid_disk (k=1) & Richer-Record-Wins
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
                            break
                        else:
                            suppressed_indices.add(other_idx)

    deduped = [c for idx, c in enumerate(candidates) if idx not in suppressed_indices]
    print(f"Final deduplicated count: {len(deduped)} (removed {len(suppressed_indices)} duplicates)")

    # Batch Insert / Upsert into PostGIS dpmaps.osm_pois if pg_conn_str provided
    if pg_conn_str:
        print("Inserting into PostGIS dpmaps.osm_pois...")
        pg_conn = psycopg2.connect(pg_conn_str)
        pg_cur = pg_conn.cursor()

        insert_query = """
            INSERT INTO dpmaps.osm_pois (
                osm_type, osm_id, snapshot_date, name, name_en, name_bn, primary_script, category, tags,
                h3_res9, h3_res10, geom, license_classification
            ) VALUES (
                %(osm_type)s, %(osm_id)s, %(snapshot_date)s, %(name)s, %(name_en)s, %(name_bn)s, %(primary_script)s, %(category)s, %(tags)s,
                %(h3_res9)s, %(h3_res10)s, ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326), 'osm_odbl_attributed'
            ) ON CONFLICT (osm_type, osm_id, snapshot_date) DO UPDATE SET
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
        print(f"PostGIS load complete: {len(deduped)} rows stored.")
    else:
        print("Dry run completed (no PostgreSQL connection string provided).")

    return deduped

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description="Ingest Open POIs into PostGIS")
    parser.add_argument("--poi-file", default="docs/resources/bangladesh.poi", help="Path to SQLite .poi file")
    parser.add_argument("--pg-conn", default=None, help="PostgreSQL connection string")
    parser.add_argument("--dry-run", action="store_true", help="Perform dry run without connecting to DB")
    parser.add_argument("db_conn_pos", nargs="?", default=None, help="Optional positional connection string")
    args = parser.parse_args()
    conn_str = None if args.dry_run else (args.pg_conn or args.db_conn_pos)
    run_pipeline(args.poi_file, conn_str)

