# pricing-service configuration

Source: `src/config/index.ts` (zod). Blank values (`KEY=`) count as not set. There are no production-only checks in this service's schema.

| Variable | Meaning | Default | Required | Validation |
|---|---|---|---|---|
| `NODE_ENV` | `development`, `test`, `production` | `development` | set in production | enum |
| `PORT` | HTTP port | `3004` | no | coerced number |
| `LOG_LEVEL` | pino level override | logger default | no | string |
| `REDIS_URL` | quotes, deny list / permission versions, settings and authz subscriptions | none | **yes, always** | URL |
| `INTERNAL_SERVICE_TOKEN` | guards `/internal/quotes/:id`; sent to mapping-, location-, platform-, auth-service | none | **yes, always** | ≥ 32 characters |
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
