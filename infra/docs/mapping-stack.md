# Mapping stack

Self-hosted OpenStreetMap services in `infra/mapping-stack/`: OSRM (routing), Nominatim
(geocoding) and TileServer GL (map tiles). Only mapping-service may call OSRM and Nominatim
(`infra/mapping-stack/README.md`); every other service goes through it.

## 1. Containers (`docker-compose.mapping.yml`)

| Service | Image | Host port | Data | Notes |
|---------|-------|-----------|------|-------|
| `osrm` | `osrm/osrm-backend:v5.25.0` | 5000 | `./data/osrm` → `/data` | `osrm-routed --algorithm mld /data/region.osrm`. Needs the prepared graph from `make map-data` |
| `nominatim` | `mediagis/nominatim:5.3` | 8080 | `./data/nominatim` → `/var/lib/postgresql/16/main` | `PBF_URL=https://download.geofabrik.de/africa/ethiopia-latest.osm.pbf`, `REPLICATION_URL=.../ethiopia-updates/`, `shm_size: 1g`. Imports the extract on first start. Data from the old 4.x image must be re-imported |
| `tileserver` | `maptiler/tileserver-gl:v5.7.0` | 8081 → 8080 | `./data/tiles` → `/data` | Serves whatever tiles/styles are in `data/tiles` |

Start everything with `make dev-infra` (foreground), or one container with
`docker compose -f infra/mapping-stack/docker-compose.mapping.yml up osrm`.
`infra/mapping-stack/data/` is gitignored.

## 2. OSRM data (`make map-data`)

`scripts/map-data.sh`:

1. Downloads `PBF_URL` (default Geofabrik Ethiopia, about 140 MB) to
   `infra/mapping-stack/data/osrm/region.osm.pbf`, unless the file exists. Override with
   `PBF_URL=... make map-data`.
2. Runs, in `osrm/osrm-backend:v5.25.0` with the directory mounted at `/data`:
   - `osrm-extract -p /opt/car.lua /data/region.osm.pbf` (car profile, the only profile used)
   - `osrm-partition /data/region.osrm`
   - `osrm-customize /data/region.osrm`

That is the MLD pipeline, matching `--algorithm mld` in the compose file. The script says it needs
about 4 GB of free RAM for the extract step. Re-run it after deleting `region.osm.pbf` to get a newer
extract (the download is skipped while the file exists).

There is also an `infra/mapping-stack/data/osrm-addis/region.osm` file on disk (ignored by git).
Nothing in repo references `osrm-addis`.

## 3. Nominatim and tiles

- Nominatim imports on its own from `PBF_URL`; no script in repo prepares it.
- No script or doc in repo downloads or builds tiles for `data/tiles`. The web app's default map
  style is OpenFreeMap (`VITE_MAP_STYLE_URL=https://tiles.openfreemap.org/styles/liberty` in
  `apps/web/.env.example`). To use TileServer GL locally, set `VITE_MAP_STYLE_URL` to
  `http://localhost:8081/styles/<id>/style.json`.
- The phone app reads `TILE_URL` (empty in the local profiles; `https://tiles.staging.anbessa.et/styles/basic/{z}/{x}/{y}.png`
  in `apps/phone-app/env/staging.json`).
- The root `.env.example` has `TILESERVER_URL`; no service reads it.

## 4. How mapping-service uses the engines

Config (`services/mapping-service/src/config/index.ts`): `OSRM_URL` (default `http://localhost:5000`),
`NOMINATIM_URL` (default `http://localhost:8080`), `ENGINE_TIMEOUT_MS` (200–10000, default 2000),
optional `REDIS_URL` (required in production).

| Engine call | Used for | Exposed as | Cache TTL (`src/maps.ts`) |
|-------------|----------|-----------|---------------------------|
| OSRM `/route/v1/driving/...` | routes | `GET /api/maps/route`, `POST /internal/route` (pricing, trip) | 3600 s |
| OSRM `/table/v1/driving/...` | distance/time matrices | `POST /internal/table` (location, trip) | 600 s |
| OSRM `/nearest/v1/driving/...` | road snapping | `GET /api/maps/snap` | 86400 s |
| Nominatim `/search` (jsonv2, viewbox per city) | destination search | `GET /api/maps/search` | 86400 s |
| Nominatim `/reverse` | pickup labels | `GET /api/maps/reverse` | 86400 s |

- Cache keys are in Redis under the `map:` prefix (`src/lib/cache.ts`).
- OSRM calls go through a circuit breaker (`osrmBreaker`). While OSRM is down, routes and tables fall
  back to straight-line estimates flagged "approximate"; address search returns 503
  (`services/mapping-service/.env.example`).
- `GET /health/ready` returns `200` with the engines' status in the body.
- City search boxes and the service area come from `libs/shared-location` (`src/regions.ts`).

In production, `OSRM_URL` / `NOMINATIM_URL` should be in-cluster URLs reachable only from
mapping-service ([docs/production/README.md](../../docs/production/README.md) section 5). No
Kubernetes manifests or Terraform for the mapping stack were found in repo.
