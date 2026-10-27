# location-service: configuration

Source: `src/config/index.ts` (Zod), template `.env.example`. `pnpm dev` loads `.env` with `--env-file-if-exists=.env`. `loadConfig()` drops variables whose value is blank (`KEY=` counts as unset), then parses. A failed parse throws at startup and the process exits with code 1.

| Variable | Meaning | Default | Validation | Production |
|---|---|---|---|---|
| `NODE_ENV` | `development` enables the dev routes (`/internal/dev/*`); anything but `production` creates missing Kafka topics at start; `production` makes `KAFKA_BROKERS` mandatory | `development` | `development` \| `test` \| `production` | set to `production` (the Dockerfile sets it) |
| `PORT` | HTTP port | `3003` | number | optional |
| `LOG_LEVEL` | pino level, overrides the logger default (`info` in production, `debug` otherwise) | none | any string (pino rejects unknown levels) | optional |
| `REDIS_URL` | Redis holding driver state, shared with realtime-gateway and trip-service | none | URL | **required** |
| `KAFKA_BROKERS` | comma-separated broker list. Blank: no events consumed or produced | none | CSV, trimmed | **required** (custom check: `required in production (driver and trip events)`) |
| `MAPPING_INTERNAL_URL` | mapping-service base URL for `POST /internal/table` | `http://localhost:3007` | URL | set to the in-cluster URL |
| `INTERNAL_SERVICE_TOKEN` | shared service token; guards `/internal/*` and is sent to mapping-service and auth-service | none | string, **min 32 chars** | **required** (required in every environment) |
| `AUTH_ISSUER` | expected `iss` of access tokens | `http://localhost:3001` | URL | set |
| `AUTH_JWKS_URL` | JWKS used to verify access tokens | `http://localhost:3001/api/auth/jwks` | URL | set |
| `AUTH_INTERNAL_URL` | auth-service base URL for `GET /internal/authz/snapshot` | `http://localhost:3001` | URL | set |
| `SWEEP_INTERVAL_MS` | sweeper period; the per-city lock lives `max(1000, value − 500)` ms | `5000` | integer ≥ 1000 | optional |

Not configurable (constants in code): stale/lost thresholds, hash TTLs, ping limits (`libs/shared-location/src/drivers.ts`, `geo.ts`), the served cities (`libs/shared-location/src/cities.ts`), the public-nearby radius/cap/grid and ETA radius (`src/locations.ts`), the mapping timeout 2.5 s (`src/lib/mapping.ts`), rate limits (`src/app.ts`, `src/http/routes.ts`), body limit 16 KiB.

## Secrets

`INTERNAL_SERVICE_TOKEN` is the only secret. Locally `make secrets` (`scripts/dev-secrets.sh`) generates it in auth-service's `.env` and copies the same value into this service's `.env`. In staging/production it comes from the secrets manager (`docs/production/README.md`). Don't commit `.env`.

## Running in the full container stack

`infra/docker/docker-compose.yml` starts this service with `env_file: ../../.env` (the root `.env`, created from the root `.env.example`), not `services/location-service/.env`. The root template has no `INTERNAL_SERVICE_TOKEN`, which this service requires.
