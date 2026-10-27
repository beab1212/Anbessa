# mapping-service data model

## Database

None. No Prisma schema, no migrations, not in the Makefile's `PRISMA_SERVICES`. The `postgres` service in `docker-compose.dev.yml` is under the `db` profile and is not used.

## Redis keys

Only when `REDIS_URL` is set. All keys are `map:<kind>:<hash>`, where `<hash>` is the first 32 characters of the base64url SHA-256 of the JSON of the key parts (`cacheKey()` in `src/lib/cache.ts`). Coordinates in the parts are rounded to 4 decimals first.

| Pattern | Type | TTL | Key parts | Value |
|---|---|---|---|---|
| `map:route:<hash>` | string (JSON) | 3600 s | `[points, withGeometry, withSteps]` | `{ distanceMeters, durationSeconds, geometry?, steps? }` |
| `map:table:<hash>` | string (JSON) | 600 s | `[sources, destinations]` | `{ durations, distances }` |
| `map:snap:<hash>` | string (JSON) | 86 400 s | the rounded point | `{ lat, lng, name, distanceMeters }` |
| `map:search:<hash>` | string (JSON) | 86 400 s | `{ text (lower case), cityId, language, limit }` | `Place[]` (before the service-area filter) |
| `map:reverse:<hash>` | string (JSON) | 86 400 s | `[point, language]` | `Place` or `null` |

TTLs: `TTL` in `src/maps.ts`. Approximate (fallback) answers are never written. A route with geometry and one without, or with and without steps, are separate entries.

The service writes no other Redis keys and reads none written by other services (no deny list, no permission versions, no pub/sub).

## In-memory state

| What | Lifetime |
|---|---|
| Circuit breaker per engine (failure count, opened-at) | per process; replicas don't share it |
