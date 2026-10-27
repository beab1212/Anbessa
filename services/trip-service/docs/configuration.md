# Configuration

Two layers:

1. **Environment variables**, parsed once at start by `loadConfig()` in `src/config/index.ts` (zod). An invalid environment stops the process with the zod error.
2. **Live settings** from platform-service (admin dashboard → Settings), read on every use through `SettingsReader.get()`. For four of them the environment value is only the default.

`.env.example` lists the variables for local development; `make secrets` (repo root) copies it to `.env` and fills in `INTERNAL_SERVICE_TOKEN`. `pnpm dev` loads `.env` if it exists (`--env-file-if-exists=.env`). Never commit or copy values from `.env`.

## Environment variables

A variable set to an empty string (`KEY=`) counts as **not set** (`loadConfig()` drops blank values before parsing).

| Variable | Type / rule | Default | Required | Meaning |
|---|---|---|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` | `development` | no | `production` turns on the refusals below; also sets the default log level |
| `PORT` | number | `3002` | no | HTTP port (listens on `0.0.0.0`) |
| `LOG_LEVEL` | string | unset → `info` in production, `debug` otherwise | no | pino level |
| `DATABASE_URL` | URL | — | **yes** | Postgres `trip_service` database. Also read by `prisma.config.ts` for migrations |
| `REDIS_URL` | URL | — | **yes** | Matching state, offer locks, caches, token denylist, pub/sub, Socket.io emitter. Must be the Redis that location-service and realtime-gateway use |
| `KAFKA_BROKERS` | comma-separated list | unset | **yes in production** | Brokers for the outbox relay. Unset (development): the relay doesn't start and events stay in `outbox` |
| `INTERNAL_SERVICE_TOKEN` | string, ≥ 32 chars | — | **yes** | Guards `/internal/*`; sent as the bearer token to location, mapping, pricing, auth, fleet and platform services. Same value as auth-service |
| `AUTH_ISSUER` | URL | `http://localhost:3001` | in practice | Expected `iss` of access tokens |
| `AUTH_JWKS_URL` | URL | `http://localhost:3001/api/auth/jwks` | in practice | Public keys for token verification |
| `AUTH_INTERNAL_URL` | URL | `http://localhost:3001` | in practice | auth-service internal API: permission matrix snapshot, user names |
| `LOCATION_INTERNAL_URL` | URL | `http://localhost:3003` | in practice | location-service internal API |
| `MAPPING_INTERNAL_URL` | URL | `http://localhost:3007` | in practice | mapping-service internal API |
| `FLEET_INTERNAL_URL` | URL | `http://localhost:3008` | in practice | fleet-service internal API (vehicles for the parties view). **Not listed in `.env.example`** |
| `PRICING` | `service` \| `builtin` | `service` | no | Quote source. `builtin` registers `POST /api/trips/estimates` and keeps quotes in Redis. **Refused in production** |
| `PRICING_INTERNAL_URL` | URL | `http://localhost:3004` | with `PRICING=service` | pricing-service internal API |
| `PLATFORM_INTERNAL_URL` | URL | `http://localhost:3011` | in practice | platform-service settings snapshot |
| `MATCH_TIMEOUT_SECONDS` | int ≥ 10 | `120` | no | Default for `match.timeoutSeconds` |
| `OFFER_SECONDS` | int 5–60 | `15` | no | Default for `match.offerSeconds` |
| `MATCH_RADII_METERS` | comma-separated numbers, each 100–20000 | `2000,4000,6000` | no | Default for `match.radiiMeters`. Validated in every environment |
| `TRIP_PIN_REQUIRED` | `true` \| `false` | `false` | no | Default for `trip.pinRequired` |
| `SHARE_BASE_URL` | URL | `http://localhost:5173` | **yes in production** (non-local) | Base of share links: `{SHARE_BASE_URL}/t/{token}`. Trailing `/` is stripped |
| `SCHEDULE_LEAD_MINUTES` | int 5–120 | `15` | no | Scheduled rides: matching starts this long before a daytime pickup |
| `SCHEDULE_NIGHT_LEAD_MINUTES` | int 5–120 | `30` | no | … before a pickup between 22:00 and 06:00 Addis time |
| `SCHEDULE_TICK_SECONDS` | int 1–300 | `15` | no | How often the scheduler looks for due bookings |

"In practice" means the default only works when every service runs on localhost; set it in any deployment.

### Production refusals

With `NODE_ENV=production`, `loadConfig()` fails if:

| Condition | Message |
|---|---|
| `PRICING=builtin` | the built-in quote stand-in is not allowed in production |
| `SHARE_BASE_URL` matches `^http://(localhost\|127\.)` | share links must point at the public web app |
| `KAFKA_BROKERS` unset | required in production (trip events) |

In every environment it fails if any `MATCH_RADII_METERS` value is not a finite number in 100–20000.

Covered by `tests/unit/policy.test.ts` ("config").

### Test-only variables

| Variable | Default | Used by |
|---|---|---|
| `TEST_DATABASE_URL` | `postgresql://ride:ride@localhost:5432/trip_service_test` | `tests/integration/global-setup.ts`. The database name must end in `_test` (it is dropped and recreated) |
| `TEST_REDIS_URL` | `redis://localhost:6394` | integration tests. If unset, the global setup starts a `redis:8-alpine` container named `anbessa-test-redis-trip` on port 6394 |

## Live settings (platform-service)

Read through `@ride-app/shared-settings` (`createSettingsClient()` in `src/container.ts`). Resolution order for `get(key, cityId?)`: city override (for city-scoped keys) → global value → trip-service's default (from env, only the four `match.*`/`trip.pinRequired` keys) → registry default (`libs/shared-settings/src/registry.ts`). Changes apply without a restart (Redis `settings:changed` or the 30 s poll); "sensitive" settings need a second super admin to approve in platform-service.

| Key | Scope | Default | Range | Used in | Effect |
|---|---|---|---|---|---|
| `match.timeoutSeconds` | global | env `MATCH_TIMEOUT_SECONDS` (120) | 10–600 s | matcher | give up and cancel `NO_DRIVER_FOUND` |
| `match.offerSeconds` | global | env `OFFER_SECONDS` (15) | 5–60 s | matcher | offer window and `offer:driver` TTL |
| `match.radiiMeters` | global | env `MATCH_RADII_METERS` | each 100–20000 m | matcher | search radius steps |
| `trip.pinRequired` | global | env `TRIP_PIN_REQUIRED` (false) | bool | `start()` | the driver must send the rider's PIN |
| `trip.arrivalRadiusMeters` | city | 150 | 30–1000 m | `arrive()`, no-show | geofence around the pickup |
| `trip.freeWaitingSeconds` | city | 180 | 0–1800 s | `waitingFee()` | free waiting after arrival |
| `trip.noShowAfterSeconds` | city | 300 | 60–3600 s | no-show | earliest no-show after arrival |
| `trip.completeFarFromDropoffMeters` | city | 300 | 50–5000 m | `complete()` | `FAR_FROM_DROPOFF` flag threshold |
| `cancel.freeSeconds` | city | 120 | 0–1800 s | `cancellationFee()` | rider's free window after matching |
| `cancel.feeMinor` | city, sensitive | 3000 | 0–100000 | `cancellationFee()` | cancellation / no-show fee (santim) |
| `cancel.driverShare` | city, sensitive | 0.8 | 0–1 | `cancellationFee()` | share of the fee to the beneficiary |
| `payments.methods` | city, sensitive | `CASH, MOBILE_MONEY, CARD` | enum list | `request()` | methods riders may choose (`CORPORATE` always allowed) |
| `maintenance.newTrips` | global, sensitive | false | bool | `request()` | `503 maintenance` for new requests |
| `maintenance.message` | global | (registry text) | ≤ 300 chars | `request()` | message of the `503` |
| `features.phoneBooking` | global | true | bool | `request()` | off → `403 feature_disabled` for `PHONE` |
| `features.corporateBooking` | global | true | bool | `request()` | off → `403 feature_disabled` with `billingOrgId` |
| `quote.ttlSeconds` | global | 600 | 60–3600 s | builtin quotes | quote validity |
| `fares.{vehicleType}.baseMinor`, `.perKmMinor`, `.perMinMinor`, `.minFareMinor`, `.waitingPerMinMinor` | city, sensitive (owner pricing-service) | per type in the registry | 0–1000000 | builtin quotes | fare table of the stand-in |

Unknown keys make `get()` throw (`unknown setting`), so a key must exist in the registry before the service reads it.

## Phase 2C notes

- `KAFKA_BROKERS` now also starts the event consumer (group `trip-service`: `driver.location`, `incident.opened`). Without it no GPS traces or incident counts are recorded.
- The live setting `features.scheduledRides` (platform-service, default **off**) gates `POST /api/trips/scheduled`. The lead times are environment variables, not live settings: `libs/shared-settings` has no `schedule.*` keys yet.
