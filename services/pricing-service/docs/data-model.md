# pricing-service data model

## Database

None. pricing-service has no Prisma schema and no migrations. It is not in the Makefile's `PRISMA_SERVICES`. (`docker-compose.dev.yml` defines a Postgres container under the `db` profile, so it is not started by default.)

## Redis keys

| Key | Type | TTL | Written by | Read by | Purpose |
|---|---|---|---|---|---|
| `quote:<id>` (id = `q_<uuid>`) | string (JSON `Quote`) | `quote.ttlSeconds` at estimate time (default 600 s, 60–3600) | pricing-service `SET … EX` | pricing-service `GET` (for `/internal/quotes/:id`) | the quote trip-service books with |
| `deny:<userId>` | string | set by auth-service | auth-service | pricing-service `EXISTS` | refuse tokens of suspended users |
| `pv:<userId>` | string (integer) | set by auth-service | auth-service | pricing-service `GET` | refuse tokens issued before a role change |
| `settings:changed` | channel | — | platform-service | pricing-service (SUBSCRIBE) | reload settings |
| `authz:changed` | channel | — | auth-service | pricing-service (SUBSCRIBE) | reload the permission matrix |

`quote:<id>` is the only data the service owns. Losing Redis loses every open quote; riders then have to ask for a new estimate (trip-service gets 404 → no quote).

trip-service's development stand-in (`PRICING=builtin`) uses its own key `devquote:<id>` in `services/trip-service/src/quotes.ts`; pricing-service does not read it.

## In-memory state

| What | Source | Lifetime |
|---|---|---|
| Settings snapshot (fares, `quote.ttlSeconds`, vehicle types) | `createSettingsClient` | replaced when the version changes |
| Permission matrix | `createAuthzSync` | replaced on change |
