#!/usr/bin/env bash
# tools/scripts/build-osrm-graphs.sh — Stage 004 §3.1 MLD compilation pipeline.
# Compiles bangladesh-latest.osm.pbf into 3 per-profile MLD graphs
# (osrm-extract → osrm-partition → osrm-customize) using osrm-backend v5.27.1.
# ODbL provenance: output graphs are OSM derivatives in the isolated
# attribution layer; first-party POIs never enter this pipeline (Invariant 4).
set -eo pipefail

DATA_DIR="${DATA_DIR:-/opt/dpmaps/data}"
PROFILES_DIR="${PROFILES_DIR:-/opt/dpmaps/profiles}"
IMAGE="${OSRM_IMAGE:-ghcr.io/project-osrm/osrm-backend:v5.27.1}"
EXTRACT_URL="${EXTRACT_URL:-https://download.geofabrik.de/asia/bangladesh-latest.osm.pbf}"

mkdir -p "${DATA_DIR}"/{car,bike,cng}

echo "=== [Step 1/4] Geofabrik Bangladesh OSM PBF ==="
if [ ! -f "${DATA_DIR}/bangladesh-latest.osm.pbf" ]; then
  curl -sSL "${EXTRACT_URL}" -o "${DATA_DIR}/bangladesh-latest.osm.pbf"
else
  echo "Extract already exists. Validating size..."
  stat -c %s "${DATA_DIR}/bangladesh-latest.osm.pbf"
fi

PROFILES=("car" "bike" "cng")

for PROFILE in "${PROFILES[@]}"; do
  echo "=========================================================="
  echo "=== Compiling MLD Graph for Profile: ${PROFILE} ==="
  echo "=========================================================="

  TARGET_DIR="${DATA_DIR}/${PROFILE}"
  cp "${DATA_DIR}/bangladesh-latest.osm.pbf" "${TARGET_DIR}/bangladesh.osm.pbf"

  echo "-> Running osrm-extract (${PROFILE})..."
  docker run --rm -t \
    -v "${TARGET_DIR}:/data" \
    -v "${PROFILES_DIR}:/profiles" \
    "${IMAGE}" \
    osrm-extract -p "/profiles/${PROFILE}.lua" /data/bangladesh.osm.pbf

  rm -f "${TARGET_DIR}/bangladesh.osm.pbf"

  echo "-> Running osrm-partition (${PROFILE})..."
  docker run --rm -t \
    -v "${TARGET_DIR}:/data" \
    "${IMAGE}" \
    osrm-partition /data/bangladesh.osrm

  echo "-> Running osrm-customize (${PROFILE})..."
  docker run --rm -t \
    -v "${TARGET_DIR}:/data" \
    "${IMAGE}" \
    osrm-customize /data/bangladesh.osrm

  echo "=== Profile ${PROFILE} compilation completed successfully ==="
done
