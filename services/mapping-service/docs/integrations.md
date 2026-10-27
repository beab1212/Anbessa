# mapping-service integrations

## Who calls mapping-service

| Caller | Path | Caller timeout | Caller behaviour on failure | Source |
|---|---|---|---|---|
| pricing-service | `POST /internal/route` (`geometry: true`) | 2.5 s | estimate fails with `503 dependency_unavailable` | `services/pricing-service/src/lib/mapping.ts` |
| location-service | `POST /internal/table` (≤ 5 drivers → pickup) | 2.5 s | its own straight-line ETA (× 1.35, 22 km/h) | `services/location-service/src/lib/mapping.ts`, `src/locations.ts` |
| trip-service | `POST /internal/table` (rank candidate drivers) | 2.5 s | trip-service's choice (`src/matching/matcher.ts`) | `services/trip-service/src/lib/clients.ts` |
| trip-service | `POST /internal/route` (development quote stand-in, `PRICING=builtin`) | 2.5 s | — | `services/trip-service/src/quotes.ts` |
| phone app | `GET /api/maps/search`, `/reverse`, `/snap`, `/route` | — | — | `packages/core/lib/src/api/service_apis.dart` |
| web | `GET /api/maps/search` (place picker), `GET /api/maps/reverse` (phone booking) | — | — | `apps/web/src/components/PlacePicker.tsx`, `apps/web/src/pages/staff/PhoneBooking.tsx` |
| platform-service | `GET /health/ready` (system page; reads `engines`) | 2 s | shown as `down` | `services/platform-service/src/system/health.ts` |

All internal callers send `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`.

## Whom mapping-service calls

| Target | Paths | Auth | Timeout | Failure | Source |
|---|---|---|---|---|---|
| OSRM (`OSRM_URL`) | `/route/v1/driving/…`, `/table/v1/driving/…`, `/nearest/v1/driving/…` | none | `ENGINE_TIMEOUT_MS` | breaker + fallback ([architecture.md](architecture.md#fallbacks)) | `src/engines/osrm.ts` |
| Nominatim (`NOMINATIM_URL`) | `/search`, `/reverse` | none (`user-agent` header) | `ENGINE_TIMEOUT_MS` | breaker, `503` | `src/engines/nominatim.ts` |
| Redis (`REDIS_URL`) | `GET`, `SET … EX` on `map:*` | URL | `maxRetriesPerRequest: 1` | treated as a cache miss | `src/lib/cache.ts` |
| auth-service | JWKS (`AUTH_JWKS_URL`) | none | jose defaults | user token rejected → 401 | `libs/shared-authz` |

No other service is called. TileServer GL (in the same compose file) is not used by mapping-service.

## External system: infra/mapping-stack

`infra/mapping-stack/docker-compose.mapping.yml` (started by `make dev-infra`):

| Container | Image | Port | Data |
|---|---|---|---|
| `osrm` | `osrm/osrm-backend:v5.25.0`, `osrm-routed --algorithm mld /data/region.osrm` | 5000 | `infra/mapping-stack/data/osrm` (built by `make map-data`) |
| `nominatim` | `mediagis/nominatim:5.3`, imports the Geofabrik Ethiopia extract on first start | 8080 | `infra/mapping-stack/data/nominatim` |
| `tileserver` | `maptiler/tileserver-gl:v5.7.0` | 8081 | `infra/mapping-stack/data/tiles` (not used by this service) |

`make map-data` (`scripts/map-data.sh`): downloads `PBF_URL` (default `https://download.geofabrik.de/africa/ethiopia-latest.osm.pbf`) into `infra/mapping-stack/data/osrm/region.osm.pbf` if missing, then runs `osrm-extract -p /opt/car.lua`, `osrm-partition`, `osrm-customize` in the same OSRM image. Needs Docker and about 4 GB RAM. The service uses the `driving` profile path; the graph is built with the car profile.

The full stack (`make stack-up`, `infra/docker/docker-compose.yml`) does not include the mapping stack.

## Kong

`infra/kong/kong.yml`:

```yaml
- name: mapping-service
  url: http://mapping-service:3007
  routes:
    - name: maps-routes
      paths: ["/api/maps"]
      methods: ["GET"]
      strip_path: false
  plugins:
    - name: rate-limiting
      config: { minute: 120, policy: local }
```

Only `GET`. The service applies its own 60/min per user on top. `/internal/*` is not routed.

## Sequence: rider estimate (pricing → mapping → location)

```mermaid
sequenceDiagram
  autonumber
  participant P as pricing-service
  participant M as mapping-service
  participant C as Redis map:*
  participant O as OSRM
  participant L as location-service
  P->>M: POST /internal/route {points:[pickup, dropoff], geometry:true}
  M->>M: service token; 2–10 points; inside SERVICE_AREA; round to 4 dp
  M->>C: GET map:route:<hash>
  alt hit
    C-->>M: cached route
  else miss
    M->>O: /route/v1/driving/lng,lat;lng,lat?overview=full&geometries=polyline6 (breaker, timeout)
    alt Ok
      O-->>M: routes[0]
      M->>C: SET EX 3600
    else NoRoute
      M-->>P: 404 not_found
    else timeout / 5xx / breaker open
      M->>M: haversine × 1.35, 22 km/h, straight polyline6, approximate
    end
  end
  M-->>P: {distanceMeters, durationSeconds, geometry, approximate}
  par meanwhile, per vehicle type
    P->>L: GET /internal/eta-to-pickup
    L->>M: POST /internal/table {sources: ≤5 drivers, destinations:[pickup]}
    M->>C: GET map:table:<hash>
    M->>O: /table/v1/driving/... (on miss)
    M-->>L: {durations, distances, approximate}
  end
```

## Sequence: destination search in the app

```mermaid
sequenceDiagram
  autonumber
  actor A as Phone app
  participant K as Kong
  participant M as mapping-service
  participant C as Redis
  participant N as Nominatim
  A->>K: GET /api/maps/search?q=bole&cityId=addis-ababa
  K->>M: same (GET only, 120/min)
  M->>M: verify token (ride-app / ride-admin); 60/min per user; 2–120 chars; city box
  M->>C: GET map:search:<hash>
  alt miss
    M->>N: /search?q=bole&countrycodes=et&viewbox=...&bounded=1&format=jsonv2
    alt answered
      N-->>M: places
      M->>C: SET EX 86400
    else down / breaker open
      M-->>A: 503 engine_unavailable
    end
  end
  M-->>A: {results} (service-area filtered)
```
