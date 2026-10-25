#!/usr/bin/env bash
# Prepare routing data for the local OSRM container (`make map-data`).
#
#   1. downloads the Geofabrik extract (default: Ethiopia, ~140 MB) unless it's already there
#   2. osrm-extract (car profile) → osrm-partition → osrm-customize  (the MLD pipeline)
#
# Result: infra/mapping-stack/data/osrm/region.osrm*, served by `make dev-infra` (osrm-routed --algorithm mld).
# Needs Docker and ~4 GB of free RAM for the extract step. Re-run after downloading a newer extract.
set -euo pipefail
cd "$(dirname "$0")/.."

PBF_URL="${PBF_URL:-https://download.geofabrik.de/africa/ethiopia-latest.osm.pbf}"
OSRM_IMAGE="osrm/osrm-backend:v5.25.0"   # same version as infra/mapping-stack/docker-compose.mapping.yml
DIR=infra/mapping-stack/data/osrm
mkdir -p "$DIR"

if [ ! -f "$DIR/region.osm.pbf" ]; then
  echo "→ downloading $PBF_URL"
  curl -fL --retry 3 -o "$DIR/region.osm.pbf.part" "$PBF_URL"
  mv "$DIR/region.osm.pbf.part" "$DIR/region.osm.pbf"
fi

run() { docker run --rm -v "$PWD/$DIR:/data" "$OSRM_IMAGE" "$@"; }

echo "→ osrm-extract (car profile)"
run osrm-extract -p /opt/car.lua /data/region.osm.pbf
echo "→ osrm-partition"
run osrm-partition /data/region.osrm
echo "→ osrm-customize"
run osrm-customize /data/region.osrm
echo "✔ routing data ready in $DIR. Start it with: make dev-infra (or docker compose -f infra/mapping-stack/docker-compose.mapping.yml up osrm)"
