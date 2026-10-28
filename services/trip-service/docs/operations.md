# Operations

Running, testing, building and troubleshooting trip-service.

## Run locally

Prerequisites: Node 24, pnpm (via corepack), Docker.

```bash
# from the repo root, once
make secrets                 # .env files + the shared INTERNAL_SERVICE_TOKEN (never overwrites)
make infra-up                # Postgres (PostGIS), Redis, Redpanda from infra/docker/docker-compose.yml
make db-migrate              # prisma migrate deploy for every Prisma service, trip-service included

# just this service
cd services/trip-service
pnpm install                 # postinstall runs prisma generate
pnpm dev                     # tsx watch, loads .env, http://localhost:3002
```

Alternatives:

- `docker compose -f docker-compose.dev.yml up -d` in `services/trip-service` starts only Postgres (`postgis/postgis:18-3.6-alpine`, database `trip_service`), Redis and Redpanda for this service. It binds the same host ports (5432, 6379, 9092) as `make infra-up`, so run one or the other.
- `make dev-services` (repo root) runs every service in watch mode; `make dev-gateway` puts Kong on `:8000` in front of them.
- `make stack-up` builds and runs the whole stack from Dockerfiles (`infra/docker/docker-compose.yml`, trip-service on port 3002, `env_file: ../../.env`).

To book a ride end to end you also need auth-service, location-service, mapping-service, pricing-service and realtime-gateway (and a driver online). See [docs/development/README.md](../../../docs/development/README.md#book-a-ride-locally). To run trip-service alone, set `PRICING=builtin` and get quotes from `POST /api/trips/estimates`.

Migrations: use `prisma migrate deploy` (what `make db-migrate` runs). The Makefile notes that `prisma migrate dev` treats the generated PostGIS columns as drift; to write a new migration use `pnpm exec prisma migrate dev --create-only` and edit the SQL.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | `tsx watch --conditions=development --env-file-if-exists=.env src/server.ts` |
| `pnpm build` | `tsc -p tsconfig.json` → `dist/` |
| `pnpm start` | `node dist/server.js` |
| `pnpm test` | unit tests (`vitest run`, excluding `tests/integration/**`) |
| `pnpm test:integration` | integration tests (`vitest.integration.config.ts`) |
| `pnpm lint` | `eslint src` |
| `pnpm typecheck` | `tsc --noEmit --customConditions development` |
| `pnpm generate` | `prisma generate` → `src/generated/prisma` |
| `make test-svc SVC=trip-service` | the unit tests from the repo root |

## Tests

### Unit (`tests/unit/policy.test.ts`)

No infrastructure needed.

- Waiting fee: free for 3 min, then per started minute; zero without arrival.
- Cancellation fee: rider free before a match and within 2 min; 30 ETB with 80% compensation after; fee + paid waiting after arrival; waiver when the driver asked; driver/staff/system free; no-show charged.
- Config: production refuses `PRICING=builtin`, missing `KAFKA_BROKERS` and a local `SHARE_BASE_URL`; radius parsing and the 100 m minimum.

### Integration (`tests/integration/`)

Needs Docker and a running Postgres (`make infra-up`).

- `global-setup.ts` drops and recreates `trip_service_test` (refuses names not ending in `_test`), runs `prisma migrate deploy`, and starts a throwaway `redis:8-alpine` container `anbessa-test-redis-trip` on port 6394 unless `TEST_REDIS_URL` is set. Tests flush that Redis.
- `harness.ts` builds the real app with `createContainer()` and `buildApp()`, with: `PRICING=builtin`; the **real** `libs/shared-location` code against the test Redis as the location client (so matching uses the real geo index); fake mapping (controllable outage) and parties clients; a controllable clock; `staticSettings()` instead of platform-service; captured socket pushes; locally signed ES256 tokens.
- Files run one at a time (`fileParallelism: false`), 30 s per test.

`tests/integration/trip.test.ts` covers:

| Area | Cases |
|---|---|
| Request | the quote's road line on the trip; PIN only for the rider; idempotency (same key → same trip, different body → refused); one active trip per rider; expired and foreign quotes; a quote books one trip (`quote_used`), and again after a cancellation; `tests/unit/quote-booking.test.ts`: the trip id named to pricing, unbooking when no trip is created, the unique-index race → `quote_used`; call center and coordinator bookings on behalf; only company employees may bill it |
| Matching | nearest by driving time, then accept; decline and expiry move on; cash filter; blocked balances; payment methods turned off; ranking by distance when mapping is down; `NO_DRIVER_FOUND` after 120 s, free; rider cancel beats a late accept; one active trip per driver even through a dispatcher; dispatchers assign in their city only |
| Execution | en route → arrive (geofence) → start → complete with paid waiting and the `trip.completed` payload; `FAR_FROM_DROPOFF` (staff only); ratings once, after completion; tags, read-back and averages (shown from 3) |
| Cancellations | rider free window then fee; no-show only after 5 min at the pickup; driver and staff free; no cancelling a started trip; strangers get 404 |
| Saved places | one home/work, limit, owner only |
| Share links | one link per rider; public view without ids or PIN; works 30 min after the end; revocation; unknown and malformed tokens |
| Reads | parties per side, never phone numbers; parties degrade to nulls; read access (rider, driver, city staff, others 404); dispatcher board; my trips and active trip |
| Live settings | maintenance and channel flags; city fares and cancellation fees |

`tests/integration/reports.test.ts` covers staff search (every filter, Addis day ranges, paging through trips created in the same instant, other city 403, `city_required`, global holders), company and fleet lists (billing vs fleet, no PIN for partners, other org / employee / fleet driver / city staff 403, finance allowed) and the daily report and CSV (per-day numbers, day boundaries at Addis midnight, permissions, default 7-day range).

`tests/integration/phase2c.test.ts` covers scheduled rides (book, list, lead time by day and night, window, per-rider conflicts, the feature flag, edit and free cancel before dispatch only, dispatch at `match_at` with re-pricing capped at the booked fare, retry while the rider is on another trip then `FAILED`, escalation once then `NO_DRIVER_FOUND` after the grace period, coordinator bookings and company / city lists with permissions), company policies (admin-only save, events and audit, hours / days / overnight, vehicle type, max fare, purpose, monthly budget including scheduled rides, scheduled rides checked at the pickup time), reassignment (to a driver: active-trip rows, old driver freed in Redis and told, rider push, events and audit; back to matching skipping the old driver; permissions, `same_driver`, not after pickup), the GPS trace (thinning, foreign and late pings dropped, phases, ride distance becomes the trip's, audit with reason, CSV, permissions) and the regulatory report (per month and city at Addis month boundaries, distinct drivers and vehicles, incidents via the Kafka handler with replay, CSV, regulator and auditor only, range limit). `tests/unit/phase2c.test.ts` covers the polyline encoder, distance with GPS jumps, Addis clock and month, overnight hours, lead times, month ranges and the regulatory CSV.

Not covered by tests (not found in `tests/`): `GET /api/trips/stats`, `/internal/*`, the PIN-required start, the outbox relay against Kafka, the settings and authz sync against real services.

## Build and deploy

`Dockerfile` (build from the repo root so `libs/*` are in the context):

```bash
docker build -f services/trip-service/Dockerfile -t ride-app/trip-service .
```

- Build stage (`node:24-alpine`, pnpm via corepack): `pnpm fetch` with a cache mount, `pnpm install --frozen-lockfile --offline --filter @ride-app/trip-service...` (postinstall generates the Prisma client), `pnpm --filter @ride-app/trip-service... build`, then `pnpm deploy --prod --legacy /out`.
- Runtime stage: `NODE_ENV=production`, non-root user `app`, only `node_modules`, `dist` and `package.json`. `EXPOSE 3002`, `HEALTHCHECK` every 15 s: `wget -qO- http://localhost:3002/health`, `CMD node dist/server.js`.
- The image does not run migrations. Run `prisma migrate deploy` against the database before rolling out a version that needs a new migration (the runtime image has no Prisma CLI, as `prisma` is a dev dependency).
- Several replicas can run at once: the matcher (Redis leases), the outbox relay (`SKIP LOCKED`) and partition maintenance (idempotent) are safe to run in each. The in-process rate limiter counts per replica.
- Production needs `KAFKA_BROKERS`, `PRICING=service` and a public `SHARE_BASE_URL` ([configuration.md](configuration.md#production-refusals)).

## Health

| Endpoint | Checks | Use for |
|---|---|---|
| `GET /health` | nothing (process up) | Docker `HEALTHCHECK` |
| `GET /health/live` | nothing | liveness probe |
| `GET /health/ready` | `SELECT 1` on Postgres; `503` on failure | readiness probe. Redis, Kafka and upstream services are **not** checked |
| `GET /internal/ops/outbox` (service token) | unpublished outbox count and oldest `created_at` | event backlog; shown on platform-service's system page |

## Logging

- pino logger named `trip-service` (`src/utils/logger.ts` → `createLogger()` in `libs/shared-utils`): JSON at `info` in production, `pino-pretty` at `debug` elsewhere; `LOG_LEVEL` overrides. Fastify uses it as its request logger.
- Unhandled errors are logged as `unhandled error` with the request id and answered with `500 internal_error`; the client never sees details.

Messages worth knowing:

| Message | Level | Meaning |
|---|---|---|
| `PRICING=builtin: quotes come from the development stand-in …` | warn | started with the stand-in |
| `KAFKA_BROKERS not set: trip events stay in the outbox table …` | warn | relay not started |
| `outbox relay: publish failed, will retry` | warn | Kafka unreachable or a send failed; retried every 500 ms |
| `partition maintenance failed` | error | `ensure_trip_event_partitions()` failed |
| `idempotency purge failed` | error | daily purge failed |
| `matching step failed` (with `tripId`) | error | a step threw; retried in 2 s |
| `matcher tick failed` | error | the tick itself failed (e.g. Redis) |
| `location-service unavailable, retrying` (with `tripId`) | warn | nearby search failed; retried in 2 s |
| `mapping-service unavailable, ranking by distance` | warn | ranking fallback |
| `parties: rider\|driver\|vehicle unavailable` | warn | auth/fleet call failed; `null` returned |
| `settings refresh failed; keeping the current values` | warn | platform-service unreachable |
| `permission matrix refresh failed; keeping the current one` | warn | auth-service unreachable |
| `token check unavailable (Redis)` | warn | Redis deny-list / permission-version lookup failed; the request got `503 auth_unavailable` |
| `settings updated` / `permission matrix updated` | info | a new snapshot version was loaded |

## Failure modes

| Failure | Effect | Diagnose |
|---|---|---|
| **Postgres down** | every route fails (`500`); `/health/ready` → `503`; matcher steps fail | readiness probe, logs |
| **Redis down** | token checks (`deny:`/`pv:` lookups) throw, so authenticated routes answer `503 auth_unavailable` (`retry-after: 5`); matching stops; pushes are lost; settings/authz updates fall back to polling | `matcher tick failed`, warn `token check unavailable (Redis)`, `unhandled error` in logs |
| **Redis data lost** (flush, failover without persistence) | trips in `requested` lose their `match:due` entry and are never matched or timed out; nothing re-enqueues them (no sweeper found in code). The rider sees "searching" until they cancel (free) | `ZSCORE match:due <tripId>` is nil for a `requested` trip |
| **Crash between request commit and `matching.start()`** | same as above for that one trip | same |
| **Kafka down or `KAFKA_BROKERS` unset** | trip state is correct, but events wait in `outbox`; payment-service doesn't settle; location-service doesn't mark matched drivers busy (they keep getting offers, accepting fails with `driver_busy`) | `GET /internal/ops/outbox`; relay warnings |
| **location-service down** | no new offers (retried every 2 s, the timeout still runs); accept/assign/arrive/no-show → `503 dependency_unavailable`; completion proceeds without the drop-off check; share view shows no position | `location-service unavailable, retrying` |
| **mapping-service down** | offers ranked by straight-line distance; builtin estimates fail with `500` | warn log |
| **pricing-service down** | `POST /api/trips` → `503 dependency_unavailable` | |
| **auth-service down** | new JWKS keys can't be fetched (tokens signed with an unknown key → `401 invalid_token`); parties names → `null`; matrix stays as loaded | |
| **platform-service down at start** | the service runs on env/registry defaults until it comes back | `settings refresh failed` |
| **Socket.io Redis differs from the gateway's** | no pushes reach the apps; the API still works | compare `REDIS_URL` across trip-service and realtime-gateway |
| **Missing monthly partition** | `trip_event` rows go to `trip_event_default`. Creating a monthly partition later fails if the default partition already holds rows of that month (PostgreSQL refuses), logged as `partition maintenance failed` | `SELECT count(*) FROM trip_event_default` |

## Troubleshooting

**A trip stays `requested` forever.**
Check it is being matched: `ZSCORE match:due <tripId>` and `HGETALL match:<tripId>`. If absent, matching was never started or its state was lost (see above); the rider (or staff) must cancel. If present, look at `trip_offer` rows for the trip and at `matching step failed` logs.

**A driver never gets offers.**
In location-service, the driver must be `available`, not stale (recent pings), in the right city and vehicle type, cash-allowed for cash trips, and not `BLOCKED`. Check `offer:driver:<driverId>` (an offer for another trip blocks them for up to `match.offerSeconds`) and `SMEMBERS match:<tripId>:declined` (a driver who declined or let an offer expire isn't asked again for that trip). The rider and the booker are never offered their own trip. Offers only reach a connected socket.

**`409 invalid_state` on a transition.**
The trip moved on (another request won, or the action is out of order). The message gives the current status. Arrival before "On my way" and starting before "Arrived" have their own messages (`invalid_state`, `not_arrived`).

**`409 too_far_from_pickup` / `position_unknown` on arrive.**
The driver's last accepted ping is older than 60 s or farther than `trip.arrivalRadiusMeters` (default 150 m). Check the driver in location-service (`GET /internal/drivers/<id>`): `at`, `lat`, `lng`. Pings are filtered for plausibility by realtime-gateway before they reach location state.

**`401 token_outdated` right after a role change.**
Expected: the token's `pv` claim is older than `pv:<userId>`. The app must refresh its token.

**Events missing downstream.**
`GET /internal/ops/outbox` (service token). A growing `pending` with an old `oldestAt` means the relay can't publish: check `KAFKA_BROKERS`, broker reachability and topic auto-creation. Published rows have `published_at` set and stay in the table.

**The PIN isn't required although it should be.**
The value comes from `trip.pinRequired` in platform-service; `TRIP_PIN_REQUIRED` is only the default when no value is stored there.
