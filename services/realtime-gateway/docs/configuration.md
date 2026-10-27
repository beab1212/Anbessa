# realtime-gateway: configuration

Source: `src/config/index.ts` (Zod, parsed at import), template `.env.example`. `pnpm dev` loads `.env` (`--env-file-if-exists=.env`). Blank values (`KEY=`) count as unset. A parse error throws at startup.

| Variable | Meaning | Default | Validation | Production |
|---|---|---|---|---|
| `NODE_ENV` | logger format and level (`production` → JSON at `info`, else `pino-pretty` at `debug`) | `development` | `development` \| `test` \| `production` | `production` (the Dockerfile sets it) |
| `PORT` | HTTP + Socket.io port | `3000` | number | optional |
| `REDIS_URL` | Redis for the adapter, location keys, deny list and permission versions. Must be the same Redis as location-service, trip-service and payment-service | none | URL | **required** |
| `KAFKA_BROKERS` | comma-separated brokers for `driver.location`. Unset: nothing published (warning) | none | optional string | not enforced by validation (no production check); without it the stream is silently off |
| `AUTH_ISSUER` | expected `iss` | `http://localhost:3001` | URL | set |
| `AUTH_JWKS_URL` | JWKS for ES256 verification | `http://localhost:3001/api/auth/jwks` | URL | set |
| `AUTH_INTERNAL_URL` | auth-service base for `GET /internal/authz/snapshot` | `http://localhost:3001` | URL | set |
| `INTERNAL_SERVICE_TOKEN` | service token for the snapshot call. Unset: the built-in permission matrix applies (warning) | none | optional, **min 32 chars** if set | set, so admin edits to the matrix apply |

`.env.example` also contains `LOG_LEVEL`, but the gateway's config schema doesn't read it and `createLogger` (`libs/shared-utils/src/logger.ts`) derives the level from `NODE_ENV` only, so **`LOG_LEVEL` has no effect** in this service.

Not configurable (constants in code): minimum ping interval 1000 ms, deny recheck 60 s, max message size 16 KiB, Kafka reconnect (1 s after a disconnect, then every 5 s while it fails), `acks: 1`, ping plausibility limits (`libs/shared-location/src/geo.ts`).

## Secrets

`INTERNAL_SERVICE_TOKEN` is the only secret. `make secrets` copies it from auth-service into this service's `.env`. In the container stack (`infra/docker/docker-compose.yml`) the service reads the root `.env` instead, which has no `INTERNAL_SERVICE_TOKEN`, so the built-in matrix applies there.
