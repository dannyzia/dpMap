#!/usr/bin/env bash
# extract_osm_pois.sh — Extract canonical POIs from Geofabrik Bangladesh PBF extract using osmium
# Part of Stage 001: Phase 0 Landmark Seeding & Data Assets (Production Pipeline)
set -euo pipefail

PBF_INPUT="${1:-docs/resources/bangladesh-latest.osm.pbf}"
OUTPUT_JSON="${2:-docs/resources/osm_pois_extracted.jsonl}"

if ! command -v osmium &> /dev/null; then
    echo "ERROR: 'osmium' (osmium-tool) is required but not installed." >&2
    echo "Install via: sudo apt-get install osmium-tool (Debian/Ubuntu) or brew install osmium-tool (macOS)" >&2
    exit 1
fi

if [ ! -f "$PBF_INPUT" ]; then
    echo "ERROR: Input PBF file not found: $PBF_INPUT" >&2
    echo "Download latest extract: curl -O https://download.geofabrik.de/asia/bangladesh-latest.osm.pbf" >&2
    exit 1
fi

TEMP_PBF="$(mktemp /tmp/osm_filtered_XXXXXX.osm.pbf)"
trap 'rm -f "$TEMP_PBF"' EXIT

echo "Filtering POIs from $PBF_INPUT..."
osmium tags-filter "$PBF_INPUT" \
  n/amenity=place_of_worship,school,restaurant,cafe,fast_food,bank,pharmacy,hospital,clinic,doctors,fuel,university,college,atm,marketplace \
  w/amenity=place_of_worship,school,restaurant,cafe,fast_food,bank,pharmacy,hospital,clinic,doctors,fuel,university,college,atm,marketplace \
  n/healthcare=pharmacy w/healthcare=pharmacy \
  n/railway=station w/railway=station \
  n/highway=bus_stop \
  n/office=government,company w/office=government,company \
  n/tourism=hotel,guest_house,hostel w/tourism=hotel,guest_house,hostel \
  n/place=suburb,neighbourhood,quarter \
  n/shop=supermarket,mall,convenience w/shop=supermarket,mall,convenience \
  n/leisure=park,stadium w/leisure=park,stadium \
  n/aeroway=terminal,aerodrome w/aeroway=terminal,aerodrome \
  w/building=commercial \
  n/barrier=gate,lift_gate \
  -o "$TEMP_PBF" --overwrite

echo "Exporting filtered features to JSONL: $OUTPUT_JSON..."
osmium export "$TEMP_PBF" --geometry-types=point,polygon -f jsonseq -o "$OUTPUT_JSON" --overwrite

echo "Extraction complete: $(wc -l < "$OUTPUT_JSON") features extracted to $OUTPUT_JSON."
