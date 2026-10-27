# pricing-service configuration

Source: `src/config/index.ts` (zod). Blank values (`KEY=`) count as not set. There are no production-only checks in this service's schema.

| Variable | Meaning | Default | Required | Validation |
|---|---|---|---|---|
| `NODE_ENV` | `development`, `test`, `production` | `development` | set in production | enum |
| `PORT` | HTTP port | `3004` | no | coerced number |
| `LOG_LEVEL` | pino level override | logger default | no | string |
| `REDIS_URL` | quotes, deny list / permission versions, settings and authz subscriptions | none | **yes, always** | URL |
| `INTERNAL_SERVICE_TOKEN` | guards `/internal/quotes/:id` and `POST /internal/quotes`; sent to mapping-, location-, platform-, auth-service | none | **yes, always** | ≥ 32 characters |
| `AUTH_ISSUER` | expected token issuer | `http://localhost:3001` | set in production | URL |
| `AUTH_JWKS_URL` | auth-service JWKS | `http://localhost:3001/api/auth/jwks` | set in production | URL |
| `AUTH_INTERNAL_URL` | auth-service base for `/internal/authz/snapshot` | `http://localhost:3001` | set in production | URL |
| `MAPPING_INTERNAL_URL` | mapping-service base for `/internal/route` | `http://localhost:3007` | set in production | URL |
| `LOCATION_INTERNAL_URL` | location-service base for `/internal/eta-to-pickup` | `http://localhost:3003` | set in production | URL |
| `PLATFORM_INTERNAL_URL` | platform-service base for `/internal/settings/snapshot` | `http://localhost:3011` | set in production | URL |

`LOCATION_INTERNAL_URL` is read by the code but is missing from `.env.example`; the default works locally.

## Live settings used (not env)

| Setting | Effect | Default |
|---|---|---|
| `fares.<type>.baseMinor`, `perKmMinor`, `perMinMinor`, `minFareMinor`, `waitingPerMinMinor` (city scope) | the fare card | see [architecture.md](architecture.md#where-the-card-comes-from) |
| `quote.ttlSeconds` (global) | quote lifetime in Redis | 600 |
| Vehicle-type catalogue (snapshot `vehicleTypes`) | which types are offered per city | built-in three when the snapshot is empty |

## Constants in code

| Constant | Value | Where |
|---|---|---|
| mapping-service timeout | 2500 ms | `src/lib/mapping.ts` |
| location-service timeout | 1500 ms | `src/lib/location.ts` |
| Max vehicle types per estimate | 5 | `src/http/routes.ts` |
| Built-in vehicle types | `economy`, `comfort`, `minivan` | `src/http/routes.ts` |
| Currency | `ETB` | `src/quotes.ts` |
| Fare card `max-age` | 60 s | `src/http/routes.ts` |
| Rate limit | 300 / minute | `src/app.ts` |
| Body limit | 16 KB | `src/app.ts` |

## Workflow 15 variables (added)

| Variable | Meaning | Default | Required |
|---|---|---|---|
| `DATABASE_URL` | Postgres (zones, fare rules and changes, promos, outbox) | none | **yes, always** |
| `KAFKA_BROKERS` | comma-separated brokers; outbox relay and the trip event consumer | none (events stay in `outbox`) | **in production** (refused otherwise) |
| `PROMO_APPROVAL_THRESHOLD_MINOR` | promos with a larger budget are activated by `incentive:approve`, not the creator | `1000000` (10 000 birr) | no |

`LOCATION_INTERNAL_URL` is now in `.env.example`. `make secrets` adds the new keys to an existing `.env`.

| Constant | Value | Where |
|---|---|---|
| Earliest fare start | 24 h after approval (emergency: on approval) | `src/rules/service.ts` `MIN_NOTICE_MS` |
| Fare change approval expiry | 7 days | `APPROVAL_TTL_MS` |
| Catalog max age | 60 s; retry after a failed reload 10 s | `src/catalog.ts` |
| Zone outline | 3–500 points, inside the city box | `src/zones/geometry.ts` |
| Surge multiplier | 1–3 | `src/http/admin-routes.ts`, DB CHECK |
| Booked promo reservation lifetime | 24 h | `src/promos/service.ts` |
| Sweep | every 30 s | `src/server.ts` |
