# mapping-stack

Self-hosted, free OSM-based replacement for Google Maps' geocoding, tiles, and
routing APIs. `PBF_URL` above points at a regional extract — swap it for
whichever Geofabrik region you're launching in. The OSRM data file needs a
one-time preprocessing step (`osrm-extract` + `osrm-partition` +
`osrm-customize`) before `osrm-routed` can serve it; see
https://github.com/Project-OSRM/osrm-backend for that pipeline.

Image versions are pinned (no `:latest`): `maptiler/tileserver-gl:v5.7.0`,
`mediagis/nominatim:5.3` and `osrm/osrm-backend:v5.25.0`. Nominatim 5.x runs
Postgres 16 internally, so its data volume mounts at `/var/lib/postgresql/16/main`.
Data imported with the old 4.x image must be re-imported.

`services/mapping-service` is the only thing in the rest of the system allowed
to call these directly — every other service goes through it.
