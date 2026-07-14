# Architecture overview

This system follows a layered microservices design: client apps (Flutter
rider/driver apps, React admin dashboard) talk to Kong (REST) and
realtime-gateway (WebSocket) at the edge, which route to independently
deployable services backed by Postgres+PostGIS, Redis, and Kafka/Redpanda.
See `services/*/README.md` for what each service owns, and
`infra/mapping-stack/README.md` for the free, self-hosted OpenStreetMap-based
mapping layer (tile server + Nominatim + OSRM) that every routing/geocoding
call goes through `services/mapping-service` to reach.
