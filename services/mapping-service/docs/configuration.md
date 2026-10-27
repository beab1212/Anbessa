# mapping-service configuration

Source: `src/config/index.ts` (zod). Blank values count as not set.

| Variable | Meaning | Default | Required in production | Validation |
|---|---|---|---|---|
| `NODE_ENV` | `development`, `test`, `production` | `development` | set | enum |
| `PORT` | HTTP port | `3007` | no | coerced number |
| `LOG_LEVEL` | pino level override | logger default | no | string |
| `REDIS_URL` | result cache | unset (no cache; warning `REDIS_URL not set: map results are not cached`) | **yes** (start refused: "protects the engines from repeated queries") | URL |
| `OSRM_URL` | OSRM base URL | `http://localhost:5000` | set to the real host | URL |
| `NOMINATIM_URL` | Nominatim base URL | `http://localhost:8080` | set to the real host | URL |
| `ENGINE_TIMEOUT_MS` | per engine call | `2000` | no | integer 200–10 000 |
| `INTERNAL_SERVICE_TOKEN` | guards `/internal/*` | none | **yes, always** | ≥ 32 characters |
| `AUTH_ISSUER` | expected issuer of user tokens | `http://localhost:3001` | set | URL |
| `AUTH_JWKS_URL` | auth-service JWKS | `http://localhost:3001/api/auth/jwks` | set | URL |

The root `.env.example` (used by `make stack-up`) also lists `OSRM_URL`, `NOMINATIM_URL` and `TILESERVER_URL`; `TILESERVER_URL` is not read by mapping-service.

## Constants in code

| Constant | Value | Where |
|---|---|---|
| Breaker threshold / cooldown | 3 failures / 10 s | `src/engines/http.ts` |
| Fallback detour factor / speed | 1.35 / 22 km/h | `FALLBACK`, `src/maps.ts` |
| Cache TTLs | route 3600 s, table 600 s, snap/search/reverse 86 400 s | `TTL`, `src/maps.ts` |
| Coordinate rounding | 4 decimals | `src/maps.ts` |
| Limits | 10 waypoints, 50 per table side, 625 cells, 120-character search | `LIMITS`, `src/maps.ts` |
| Public rate limit | 60 / minute per user | `src/http/routes.ts` |
| Redis key prefix | `map:` | `src/lib/cache.ts` |
| Nominatim `countrycodes` | `et` | `libs/shared-location` |
| Body limit | 32 KB | `src/app.ts` |
