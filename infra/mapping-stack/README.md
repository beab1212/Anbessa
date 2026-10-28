# mapping-stack

Self-hosted, free OSM-based replacement for Google Maps' geocoding, tiles, and
routing APIs. `PBF_URL` in `docker-compose.mapping.yml` (Nominatim) and in
`scripts/map-data.sh` (OSRM) points at a regional extract — swap it for
whichever Geofabrik region you're launching in.

Quick start for real road routes:

```bash
make map-data   # once: download the extract (or place it as data/osrm/region.osm.pbf) and build the OSRM graph
docker compose -f infra/mapping-stack/docker-compose.mapping.yml up -d osrm   # after every reboot
```

Step-by-step guide and troubleshooting: [docs/development/README.md](../../docs/development/README.md)
section 6; details: [infra/docs/mapping-stack.md](../docs/mapping-stack.md).

Image versions are pinned (no `:latest`): `maptiler/tileserver-gl:v5.7.0`,
`mediagis/nominatim:5.3` and `osrm/osrm-backend:v5.25.0`. Nominatim 5.x runs
Postgres 16 internally, so its data volume mounts at `/var/lib/postgresql/16/main`.
Data imported with the old 4.x image must be re-imported.

`services/mapping-service` is the only thing in the rest of the system allowed
to call these directly — every other service goes through it.
