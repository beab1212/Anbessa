# mapping-service

The **only** service that talks to the self-hosted map engines ([architecture §10](../../docs/architecture/overview.md#10-mapping-stack)):

| Need | Engine | Endpoint here |
|---|---|---|
| Road distance and time (fares, ETAs) | OSRM `/route` | `POST /internal/route` |
| Driving-time matrix (rank drivers by ETA) | OSRM `/table` | `POST /internal/table` |
| Pickup pin on the nearest road | OSRM `/nearest` | `GET /api/maps/snap` |
| Destination search while typing | Nominatim `/search` | `GET /api/maps/search` |
| Label for the pickup pin | Nominatim `/reverse` | `GET /api/maps/reverse` |

Because everything goes through here, the engines can be replaced without touching pricing, trip or location.

## Quick start

```bash
docker compose -f docker-compose.dev.yml up -d   # Redis (cache)
pnpm install
make -C ../.. secrets                             # .env + the shared INTERNAL_SERVICE_TOKEN
pnpm dev                                          # http://localhost:3007
```

**Engines.** Real routing needs the OSRM graph: run `make map-data` once from the repo root (downloads the Ethiopia extract, about 140 MB, and builds the graph in roughly 10 minutes), then `make dev-infra`. Nominatim imports the extract on its first start (slow; see `infra/mapping-stack/README.md`). **Without engines** the service still works: routes and tables return straight-line estimates flagged `"approximate": true`, and search/reverse return `503`.

## API

| Route | Auth | Body / query → response |
|---|---|---|
| `POST /internal/route` | `Bearer $INTERNAL_SERVICE_TOKEN` | `{ points: [{lat,lng}…] (2–10), geometry?: bool }` → `{ distanceMeters, durationSeconds, geometry?, approximate }` (`geometry` = polyline, precision 6). No road → `404` |
| `POST /internal/table` | service token | `{ sources: [...], destinations: [...] }` (≤ 50 per side, ≤ 625 cells) → `{ durations[s][d], distances[s][d], approximate }` (seconds / meters, `null` = unreachable) |
| `GET /api/maps/search?q=&cityId=&language=en\|am&limit=` | any app or staff token | `{ results: [{ name, label, lat, lng, category, type }] }`, bounded to the city's box |
| `GET /api/maps/reverse?lat=&lng=` | any token | `{ name, label, lat, lng, … }` |
| `GET /api/maps/snap?lat=&lng=` | any token | `{ lat, lng, name, distanceMeters, approximate }` |

Public routes are limited to **60 requests per minute per user** (after authentication, so not per IP). Every point must be inside the service area (Ethiopia), or the request gets `400 outside_service_area` before any engine is called.

## How it stays fast and available

- **Cache:** results go in Redis. Coordinates are rounded to about 11 m first, so requests from nearly the same place share an entry. TTLs: route 1 h, table 10 min, search, reverse and snap 24 h.
- **Timeouts:** each engine call is cut off at `ENGINE_TIMEOUT_MS` (2 s).
- **Circuit breaker:** after 3 consecutive failures an engine is skipped for 10 s, so callers fail fast instead of each waiting for a timeout. `GET /health/ready` reports `"osrm": "degraded"` while it's open.
- **Fallback (OSRM):** straight-line distance × 1.35 at 22 km/h, flagged `approximate` and never cached. Pricing and matching show it as an estimate (workflow 05).

## Layout

```
src/
├── engines/   OSRM and Nominatim clients, timeouts + circuit breaker
├── maps.ts    service-area checks, caching, fallbacks, limits
├── regions.ts service area and per-city search boxes
├── http/      internal and public routes (per-user rate limit)
├── lib/       Redis cache, errors
├── config/    env → typed config (Zod)
├── app.ts / container.ts / server.ts
```

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Hot reload |
| `pnpm test` | The service against a local HTTP server that answers like OSRM and Nominatim: parsing, caching, no-route, timeouts, breaker, fallback, limits, auth, rate limit |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | |

See `.env.example` for every variable.
