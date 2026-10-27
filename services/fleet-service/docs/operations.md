# Operations

Running, testing, deploying and diagnosing fleet-service. Repo-wide guides: [docs/development](../../../docs/development/README.md), [docs/testing](../../../docs/testing/README.md), [docs/production](../../../docs/production/README.md).

## Run locally

Prerequisites: Node 24, pnpm (corepack), Docker. Postgres must be version 18 (`uuidv7()`).

```bash
# from services/fleet-service
docker compose -f docker-compose.dev.yml up -d   # Postgres 18 (PostGIS image) on 5432, Redpanda on 9092 — no Redis
pnpm install                                      # also runs prisma generate
make -C ../.. secrets                             # .env from .env.example, PII/upload keys, shared INTERNAL_SERVICE_TOKEN
pnpm prisma migrate dev                           # creates fleet_service and applies the migration
pnpm dev                                          # tsx watch on src/server.ts, http://localhost:3008
```

Or use the repo-wide infrastructure: `make infra-up` (Postgres, Redis, Redpanda from `infra/docker/docker-compose.yml`), `make db-migrate` (runs `prisma migrate deploy` for every Prisma service), then `make dev-services` (everything) or `make dev-svc SVC=fleet-service`.

Things to know:

- `docker-compose.dev.yml` doesn't start Redis, but `.env.example` sets `REDIS_URL=redis://localhost:6379`. If nothing listens there, every authenticated request answers `503 auth_unavailable` (see failure modes). Either run Redis (`make infra-up`) or blank `REDIS_URL` for development.
- Without auth-service on `AUTH_JWKS_URL` no token can be verified. Without it on `AUTH_INTERNAL_URL` the built-in permission matrix is used and organisation lookups / approvals fail with 503.
- Without payment-service every driver goes online with `cashAllowed: true`; without platform-service the env/registry defaults apply.
- With `STORAGE=local` files land in `.dev-data/uploads/` and are served by this service. The phone app and the web app can PUT to the relative URL directly (port 3008) or through Kong (`make dev-gateway`).
- With `KAFKA_BROKERS` unset, events stay in the `outbox` table and location-service never sees drivers go online.

Startup warnings you may see: `STORAGE=local: documents are kept in …`, `REDIS_URL not set: …`, `KAFKA_BROKERS not set: …`, `Kafka consumer failed to start; …`, `permission matrix refresh failed; keeping the current one`, `settings refresh failed; keeping the current values`.

## Seed data

`pnpm seed:dev` (`src/dev/seed.ts`):

- Refuses unless `NODE_ENV=development`.
- Needs auth-service running with `DEV_LOGIN=on` and its own `seed:dev` done: it reads accounts and organisations from `GET {AUTH_INTERNAL_URL}/api/dev/accounts`.
- Writes directly to the database (no events, no outbox rows) and puts small generated PDFs marked "DEVELOPMENT SAMPLE" into the configured store (direct write for local, pre-signed PUT for S3). Expiring documents get an expiry of 30 June next year. City: `addis-ababa`.
- Runs once: drivers already having a profile, plates already registered, and organisations that already have documents are skipped. Prints what it created.

| Dev account / org (auth-service key) | Created |
|---|---|
| `driver-applicant` | Driver `PENDING_REVIEW` (licence `AA204401`), 3 `PENDING` documents; car `3-A40401` Toyota Vitz economy `PENDING_REVIEW` with 3 `PENDING` documents |
| `driver-active` | Driver `ACTIVE` (licence `AA204402`), 3 `APPROVED` documents, DRIVER role added through auth-service; car `3-A40402` Hyundai Atos economy `VERIFIED` with 3 `APPROVED` documents |
| `dev-fleet` (owner `fleet-owner`) | Company documents `APPROVED` ("Selam Transport PLC"); car `3-B10201` Toyota Corolla comfort `VERIFIED` authorised for `fleet-driver`; car `3-B10202` Toyota HiAce minivan (7 seats) `PENDING_REVIEW` |
| `fleet-driver` | Driver `ACTIVE` (licence `AA201002`), documents `APPROVED`, DRIVER role added |
| `dev-corporate` (admin `corporate-admin`) | Company documents `PENDING` ("Abay Bank S.C.") |

## Tests

| Command | What | Needs |
|---|---|---|
| `pnpm test` | Unit tests (`tests/unit/rules.test.ts`): current-document selection, `missingForSubmit` / `missingForApproval` (including "expires today is still valid"), plate normalisation, every `driveDenial` outcome (V4, V6, V7, revoked and lapsed authorisations), licence encryption round trip and blind-index normalisation, ticket tampering and expiry | nothing |
| `pnpm test:integration` | `tests/integration/fleet.test.ts` against the real app (`app.inject`) | Postgres on localhost:5432 with user `ride` (`make infra-up`) |

Integration setup (`tests/integration/global-setup.ts`, `harness.ts`):

- Drops and recreates `fleet_service_test` (or `TEST_DATABASE_URL`; the name must end in `_test`) and runs `prisma migrate deploy`.
- Local storage in a temporary directory; a fake auth-service (organisations, memberships, a switch to make `setDriverRole` fail); a fake payment-service balance map; ES256 tokens signed with a key generated per run. No Redis, no Kafka (events are checked in the `outbox` table).
- Files run serially; 30 s per test.

Integration scenarios covered:

- Application: licence encrypted at rest, duplicate licence (formatted differently) refused, second application refused.
- Uploads: expiry required for `LICENSE`; size mismatch on PUT; hash mismatch on confirm; another user can't request a ticket for someone else or use their ticket.
- Submit → queue (masked licence, pending counts) → approval blocked until documents approved → other city's officer refused → auth-service down rolls back the approval → approval adds DRIVER and writes `driver.activated`.
- Document rejection needs a reason; request-changes sends the driver back; rejected photo must be replaced before resubmitting; staff view writes `document:view` audit.
- Owner-driver session: `driver.online` payload, idempotent re-start, other driver refused (`not_your_vehicle`), going offline, `CASH_BLOCKED` goes online without cash, `BLOCKED` refused.
- Plates unique after normalisation; seat ranges; registering a car without a profile.
- Fleet cars: unverified fleet refused, other fleet's owner refused, authorisation needs `fleet_driver` membership, V7 checks, picker shows `canDrive`, beneficiary is the fleet, second driver gets `vehicle_in_use`, overview content, revoking ends the session.
- Expiry: expired insurance suspends the car and ends the session, renewal flow, dispatcher can't suspend a driver, safety officer suspends (session ends, `DRIVER` role removed in auth-service) and reinstates (role added back).

Not covered by tests: the Kafka consumer and relay, the S3 store, reminders, the internal routes, stats, the seed script.

## Build and deploy

- `pnpm build` → `tsc -p tsconfig.json` into `dist/`; `pnpm start` → `node dist/server.js`.
- Docker image (build from the repo root): `docker build -f services/fleet-service/Dockerfile -t ride-app/fleet-service .` Multi-stage on `node:24-alpine`: `pnpm fetch` / offline install of the service and its workspace deps, build, `pnpm deploy --prod --legacy`; the runtime stage runs as user `app`, `NODE_ENV=production`, exposes 3008, `HEALTHCHECK` every 15 s on `/health`.
- The runtime image contains production dependencies only, so the Prisma CLI isn't in it: run migrations separately (`prisma migrate deploy` with the service's `DATABASE_URL`, as `make db-migrate` does).
- Full stack in containers: `make stack-up` (`infra/docker/docker-compose.yml`, service `fleet-service`, `env_file: ../../.env`, depends on Postgres, Redis, Redpanda, port 3008). Kong routes `/api/fleet` to `http://fleet-service:3008`.
- Production requires `STORAGE=s3`, `KAFKA_BROKERS` and `REDIS_URL` (the process refuses to start otherwise) plus the three keys, the service token and `DATABASE_URL`.
- Scaling: several replicas can share the outbox (`SKIP LOCKED`) and the Kafka group. The expiry job and reminders run in every replica with no lock (see failure modes).

## Health endpoints

| Route | Meaning |
|---|---|
| `GET /health`, `GET /health/live` | Process up (always 200) |
| `GET /health/ready` | 200 if `SELECT 1` works, else 503. Doesn't check Redis, Kafka or storage |
| `GET /internal/ops/outbox` (service token) | Unpublished outbox rows and the oldest one's time |
| `GET /internal/ops/storage` (service token) | Storage reachable (`HeadBucket` / writable directory) |

platform-service's system page polls `/health/ready`, both ops routes and the Kafka lag of the `fleet-service` consumer group.

## Logging

pino via `libs/shared-utils` (`name: "fleet-service"`), JSON in production, `pino-pretty` otherwise; level `info` in production, `debug` otherwise, overridden by `LOG_LEVEL`. Fastify request logs come from the same logger. Licence numbers and file contents are never logged by the service code.

Messages worth alerting on:

| Message | Level | Meaning |
|---|---|---|
| `unhandled error` | error | A 500; the error is logged with the request id |
| `outbox relay: publish failed, will retry` | warn | Kafka unreachable or refusing; backlog grows |
| `skipping invalid event` | error | A malformed `driver.connection_lost` message was skipped |
| `document expiry job failed` | error | The hourly run threw (often the database) |
| `idempotency purge failed` | error | Daily purge threw |
| `payment-service unreachable at session start; …` | warn | Driver went online without a balance check |
| `token check unavailable (Redis)` | warn | Redis deny-list / permission-version lookup failed; the request got `503 auth_unavailable` |
| `documents expired` (`count`) | info | Expiry run changed documents |
| `permission matrix updated` / `settings updated` | info | New snapshot loaded |

## Background jobs

All in-process timers started by `src/server.ts`.

| Job | Schedule | What |
|---|---|---|
| Outbox relay | every 500 ms (only with `KAFKA_BROKERS`) | Publish unpublished rows, 100 at a time |
| Kafka consumer | continuous | `driver.connection_lost` → end session |
| Document expiry | at start, then every hour | Approved documents past their date → `EXPIRED`, suspend vehicle / driver, end sessions |
| Expiry reminders | on the first expiry run of each UTC day (per process) | `document.expiring` for documents due in exactly N days |
| Idempotency purge | every 24 h after start | Delete keys older than 24 h |
| Permission matrix sync | at start, on `authz:changed`, every 30 s | From auth-service |
| Settings sync | at start, on `settings:changed`, every 30 s | From platform-service |

Shutdown on `SIGTERM` / `SIGINT`: stop the matrix and settings sync, the expiry timer and the purge timer, close Fastify (in-flight requests finish), disconnect the consumer, stop the relay (no final flush: unpublished rows wait for the next start), disconnect Prisma and Redis, exit 0.

## Failure modes and diagnosis

| Symptom | Likely cause | Check / fix |
|---|---|---|
| Every authenticated request returns `503 auth_unavailable` (`retry-after: 5`; warn `token check unavailable (Redis)`) | `REDIS_URL` set but Redis unreachable: the deny-list / pv lookup throws, and the verifier refuses the token as `TokenCheckUnavailable` | Start Redis or blank `REDIS_URL` (development only) |
| 401 `invalid_token` for valid-looking tokens | `AUTH_ISSUER` / `AUTH_JWKS_URL` wrong, auth-service down, token from another environment | Compare the token's `iss` with `AUTH_ISSUER`; fetch the JWKS URL |
| 401 `token_outdated` right after approval | Expected: the DRIVER role bumped the permission version | The app refreshes its token |
| 401 `token_revoked` | User suspended in auth-service | auth-service |
| 403 `forbidden` for a staff member who should have access | Wrong city (scope comes from the resource), or the live matrix differs from the built-in one, or the matrix couldn't be loaded | Check the role claims in the token and the `permission matrix …` logs |
| Staff get 403 listing documents of a driver/vehicle that has none | The staff city is taken from the newest document; with no documents it is empty | Expected limitation; `GLOBAL` grants pass |
| Approve returns 503 `dependency_unavailable` | auth-service unreachable or erroring; nothing was changed | Fix auth-service, retry |
| Approve / suspend / reinstate → `409 user_not_found` | auth-service has no account for the driver's user id (this used to be swallowed, so approval went through without the role; fixed 2026-10-27) | Check the user exists in auth-service |
| Suspend / reinstate → `503 dependency_unavailable` | auth-service unreachable when changing the `DRIVER` role; nothing changed | Retry once auth-service is back |
| Drivers go online but never appear on the map | Relay not running (`KAFKA_BROKERS` unset) or Kafka down | `GET /internal/ops/outbox` (pending, oldest); relay warnings |
| Sessions never end after the app is killed | Consumer not running, or location-service not producing `driver.connection_lost` | `Kafka consumer failed to start` log; `fleet-service` group lag on the system page |
| `upload_missing` on confirm | The client didn't PUT, PUT to the wrong place, or the URL expired (5 min) | Request a new upload URL |
| `upload_mismatch` | Different size (or, locally, different hash) than announced | The client must hash and size the exact bytes it sends |
| `invalid_ticket` | Ticket older than 15 min, signed with another `UPLOAD_SIGNING_KEY`, or used by another user | Start the upload again |
| Uploads fail on S3 with signature errors | `content-type` header not sent as returned in `headers`, or a different length | Send exactly the returned headers |
| Licence decrypt errors | `PII_ENCRYPTION_KEY` changed | Restore the key; there is no re-encryption tool |
| Duplicate licences accepted | `PII_BLIND_INDEX_KEY` changed since the earlier profiles | Restore the key |
| Same reminder sent twice in a day | Restart (the last reminder day is in memory) or several replicas | Not de-duplicated in code |
| Duplicate `vehicle.suspended` / `driver.suspended` | Several replicas ran the expiry job at once (no lock) | Not de-duplicated in code |
| `409 request_in_progress` stuck | A going-online request died between insert and completion; the key stays `IN_PROGRESS` until purged (≤ 48 h) | Use a new idempotency key |
| `/health/ready` 503 | Postgres unreachable | `DATABASE_URL`, database up |
| Process exits at start with a zod error | Invalid or missing env (keys not 64 hex, keys equal, production rules) | [configuration.md](configuration.md) |
