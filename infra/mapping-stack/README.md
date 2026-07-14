# mapping-stack

Self-hosted, free OSM-based replacement for Google Maps' geocoding, tiles, and
routing APIs. `PBF_URL` above points at a regional extract — swap it for
whichever Geofabrik region you're launching in. The OSRM data file needs a
one-time preprocessing step (`osrm-extract` + `osrm-partition` +
`osrm-customize`) before `osrm-routed` can serve it; see
https://github.com/Project-OSRM/osrm-backend for that pipeline.

`services/mapping-service` is the only thing in the rest of the system allowed
to call these directly — every other service goes through it.
