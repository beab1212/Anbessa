# Local development infrastructure

What the compose files start, what every `make` target and script does, and which ports
everything uses. The developer workflow itself (signing in, running a trip end to end, phone app
setup) is in [docs/development/README.md](../../docs/development/README.md).

## 1. Compose files

### `infra/docker/docker-compose.yml`

Used by `make infra-up`, `make stack-up`, `make infra-down`, `make infra-reset`, `make logs-svc` and
`scripts/setup.sh`. `make infra-up` starts only `postgres`, `redis` and `redpanda`; `make stack-up`
starts everything with `--build`.

| Container | Image / build | Host port | Volumes | Env | depends_on |
|-----------|---------------|-----------|---------|-----|------------|
| `postgres` | `postgis/postgis:18-3.6-alpine` | 5432 | named volume `pg-data` at `/var/lib/postgresql` | `POSTGRES_USER=ride`, `POSTGRES_DB=ride_app` (password set in file) | |
| `redis` | `redis:8-alpine` | 6379 | none (not persisted) | | |
| `redpanda` | `redpandadata/redpanda:v26.2.6`, `--smp 1 --memory 512M --overprovisioned`; two listeners: `external` advertised as `localhost:9092` (host processes), `internal` as `redpanda:29092` (containers of this file; not published) | 9092 | none | | |
| `kong` | `kong:3.9`, DB-less, `KONG_DECLARATIVE_CONFIG=/kong/kong.yml` | 8000 | `../kong/kong.yml` read-only | `KONG_PROXY_LISTEN=0.0.0.0:8000` | auth-service, trip-service |
| `auth-service` | `services/auth-service/Dockerfile`, context repo root | 3001 | | `env_file: ../../.env`, plus `DATABASE_URL` pointing at `postgres:5432/ride_app` | postgres, redpanda |
| `trip-service` | own Dockerfile | 3002 | | `env_file: ../../.env` | postgres, redis, redpanda |
| `location-service` | own Dockerfile | 3003 | | `env_file: ../../.env` | redis, redpanda |
| `pricing-service` | own Dockerfile | 3004 | | `env_file: ../../.env`, plus in-network overrides: `DATABASE_URL` (`postgres:5432/pricing_service`), `REDIS_URL` (`redis:6379`), `KAFKA_BROKERS` (`redpanda:29092`), `AUTH_JWKS_URL` / `AUTH_INTERNAL_URL` (`auth-service:3001`), `MAPPING_INTERNAL_URL`, `LOCATION_INTERNAL_URL` (`location-service:3003`), `PLATFORM_INTERNAL_URL` | postgres, redis, redpanda |
| `payment-service` | own Dockerfile | 3005 | | `env_file: ../../.env` | postgres, redis, redpanda |
| `notification-service` | own Dockerfile | none published | | `env_file: ../../.env` | redpanda |
| `mapping-service` | own Dockerfile | 3007 | | `env_file: ../../.env` | |
| `fleet-service` | own Dockerfile | 3008 | | `env_file: ../../.env` | postgres, redis, redpanda |
| `support-service` | own Dockerfile | 3009 | | `env_file: ../../.env` | postgres, redis, redpanda |
| `audit-service` | own Dockerfile | 3010 | | `env_file: ../../.env` | postgres, redpanda |
| `platform-service` | own Dockerfile | 3011 | | `env_file: ../../.env` | postgres, redis, redpanda |
| `realtime-gateway` | own Dockerfile | 3000 | | `env_file: ../../.env` | redis, redpanda |

Healthchecks: the compose file defines none. Each service image has a Docker `HEALTHCHECK`
(`wget -qO- http://localhost:<port>/health` every 15 s, 3 s timeout) from its Dockerfile. `depends_on`
waits only for containers to start, not to be healthy. `make infra-up` waits for Postgres itself
with `pg_isready -U ride -d ride_app`.

Things to know about the containerized stack as the files stand:

- Every service container reads only the root `.env` (copied from the root `.env.example`). That
  file sets `DATABASE_URL`, `REDIS_URL` and `KAFKA_BROKERS` to `localhost`, which inside a container
  is the container itself. auth-service gets an override (`DATABASE_URL` to the `postgres`
  host, database `ride_app`); pricing-service gets in-network values for its database
  (`pricing_service`), Redis, Kafka (`redpanda:29092`) and the services it calls. Containers that
  should reach Kafka must use `redpanda:29092`, not `localhost:9092`.
- The root `.env.example` has none of the per-service secrets (`BETTER_AUTH_SECRET`,
  `INTERNAL_SERVICE_TOKEN`, `PII_*`, webhook secrets, ...) or `AUTH_BASE_URL`, which the services'
  config schemas require (see [production-checklist.md](production-checklist.md)). The
  per-service `services/*/.env` files are not passed to the containers.
- The other services share one database name (`ride_app`) in this file, while the host workflow uses one
  database per service (see [data-stores.md](data-stores.md)).
- Kong's `depends_on` lists only auth-service and trip-service.

So `make stack-up` needs a hand-edited root `.env` before the services can boot. No other config
for it was found in repo.

### `infra/kong/docker-compose.dev.yml`

Used by `make dev-gateway` / `make dev-gateway-down`. One container, `anbessa-kong-dev`:

| Setting | Value |
|---------|-------|
| Image | `kong:3.9`, DB-less |
| Config | `./kong.dev.yml` mounted read-only at `/kong/kong.yml` (generated, see section 4) |
| Ports | `8000` (proxy), `127.0.0.1:8001` (admin API, bound to loopback only) |
| Logs | proxy access log to stdout, error log to stderr |
| `extra_hosts` | `host.docker.internal:host-gateway`, so Linux can reach services on the host |

### `infra/mapping-stack/docker-compose.mapping.yml`

Used by `make dev-infra` (foreground `up`). See [mapping-stack.md](mapping-stack.md).

| Container | Image | Host port | Volume |
|-----------|-------|-----------|--------|
| `tileserver` | `maptiler/tileserver-gl:v5.7.0` | 8081 → 8080 | `./data/tiles:/data` |
| `nominatim` | `mediagis/nominatim:5.3`, `shm_size: 1g`, imports `PBF_URL` (Ethiopia) on first start | 8080 | `./data/nominatim:/var/lib/postgresql/16/main` |
| `osrm` | `osrm/osrm-backend:v5.25.0`, `osrm-routed --algorithm mld /data/region.osrm` | 5000 | `./data/osrm:/data` |

### `services/*/docker-compose.dev.yml`

Each service has a minimal stack. All bind the same host ports as `infra/docker/docker-compose.yml`
(5432, 6379, 9092), so run only one of them, or `make infra-up`, at a time. Postgres data goes to
`services/<svc>/.dev-data/postgres` (gitignored). Redpanda runs with `--memory 256M`.

| Service | postgres (`POSTGRES_DB`) | redis | redpanda |
|---------|--------------------------|-------|----------|
| audit-service | yes (`audit_service`) | no | yes |
| auth-service | `profiles: [default]` (`auth_service`) | yes | yes |
| fleet-service | yes (`fleet_service`) | no | yes |
| location-service | `profiles: [db]`, no DB name | yes | yes |
| mapping-service | `profiles: [db]`, no DB name | yes | yes |
| notification-service | yes, no DB name (Postgres creates `ride`) | yes | yes |
| payment-service | `profiles: [default]` (`payment_service`) | yes | yes |
| platform-service | yes (`platform_service`) | no | yes |
| support-service | yes (`support_service`) | yes | yes |
| pricing-service | `profiles: [db]`, no DB name | yes | yes |
| realtime-gateway | `profiles: [db]`, no DB name | yes | yes |
| trip-service | `profiles: [default]` (`trip_service`) | yes | yes |

A service with `profiles:` only starts when that profile is enabled (`docker compose --profile <name> up`).
The comment in these files says "skip postgres if service doesn't use it", but auth-service,
payment-service and trip-service do use Postgres and their postgres is behind a profile named
`default`. fleet-service, audit-service and platform-service need Redis in production but their
dev stacks have none (their config treats `REDIS_URL` as optional outside production).

## 2. Makefile targets

`Makefile` uses `SHELL := /bin/bash`. Two lists drive the loops:

- `SERVICES`: auth, trip, location, pricing, payment, notification, mapping, realtime-gateway, fleet, platform, audit, support.
- `PRISMA_SERVICES`: auth, notification, trip, fleet, payment, platform, audit, support.

| Target | What it runs |
|--------|--------------|
| `help` (default goal) | Prints the target list |
| `setup` | `setup-services`, `setup-mobile`, `setup-web` (not `setup-infra`, although `help` says "Everything above") |
| `setup-mobile` | Checks `flutter` is installed, then `dart pub get` at the root (Dart pub workspace) |
| `setup-services` | Checks `node`; runs `corepack enable` if `pnpm` is missing; `pnpm install`; then `_copy-env-examples`, `secrets`, `infra-up`, `db-migrate` |
| `setup-web` | `cd apps/web && pnpm install`; copies `apps/web/.env.example` to `.env` if missing |
| `setup-infra` | Checks `terraform` and `kubectl`; `cd infra/terraform && terraform init` (fails today: the modules don't exist, see [terraform.md](terraform.md)) |
| `_copy-env-examples` | Copies root `.env.example` to `.env` and each `services/<svc>/.env.example` to `.env` when missing |
| `secrets` | `bash scripts/dev-secrets.sh` (section 3) |
| `map-data` | `bash scripts/map-data.sh` (see [mapping-stack.md](mapping-stack.md)) |
| `dev-services` | `secrets`, then `pnpm turbo run dev --parallel --concurrency=32` (every service and the web app) |
| `dev-svc SVC=<name>` | `secrets`, then `pnpm --filter @ride-app/<name> dev` |
| `dev-mobile [ENV=...]` | `cd apps/phone-app && flutter run --dart-define-from-file=env/<ENV>.json`, `ENV` defaults to `dev-host`. Files: `dev-host`, `dev-emulator`, `dev-kong`, `stack`, `staging` |
| `dev-web` | `cd apps/web && pnpm dev` (Vite on 5173) |
| `dev-gateway` | `bash scripts/kong-dev-config.sh`; `docker compose -f infra/kong/docker-compose.dev.yml up -d`; polls `http://localhost:8001/status` until Kong answers |
| `dev-gateway-down` | `docker compose -f infra/kong/docker-compose.dev.yml down` |
| `dev-infra` | `docker compose -f infra/mapping-stack/docker-compose.mapping.yml up` (foreground) |
| `test` | `pnpm turbo run test`, then `dart run melos run test` |
| `test-svc SVC=<name>` | `pnpm --filter @ride-app/<name> test` |
| `lint` | `pnpm turbo run lint`, then `dart run melos run analyze` |
| `typecheck` | `pnpm turbo run typecheck` |
| `logs-svc SVC=<name>` | `docker compose -f infra/docker/docker-compose.yml logs -f <name>` (only useful with `stack-up`) |
| `infra-up` | `docker compose -f infra/docker/docker-compose.yml up -d postgres redis redpanda`, then waits for `pg_isready` |
| `stack-up` | Copies `.env.example` to `.env` if missing; `docker compose -f infra/docker/docker-compose.yml up -d --build` |
| `infra-down` | `docker compose -f infra/docker/docker-compose.yml down` |
| `infra-reset` | `down -v` (deletes the `pg-data` volume), then `infra-up`, `db-migrate`, `db-seed` |
| `db-migrate` | For each of `PRISMA_SERVICES`: `pnpm --filter @ride-app/<svc> exec prisma migrate deploy`; stops at the first failure |
| `db-seed` | `pnpm tsx scripts/seed-db.ts` (a stub that only prints a TODO) |
| `clean` | Deletes every `node_modules`, `dist` and `.turbo` directory under the repo |

`dev-svc`, `test-svc`, `logs-svc`, `infra-up`, `infra-down`, `infra-reset`, `db-migrate`, `db-seed` and
`_copy-env-examples` are not in `.PHONY`. That only matters if a file with the same name appears at the root.

Development seed data for sign-in comes from the services, not `db-seed`:
`pnpm --filter @ride-app/auth-service seed:dev` and `pnpm --filter @ride-app/fleet-service seed:dev`
(both refuse unless `NODE_ENV=development`).

## 3. Scripts (`scripts/`)

| Script | Called by | What it does |
|--------|-----------|--------------|
| `dev-secrets.sh` | `make secrets`, `make dev-services`, `make dev-svc`, `scripts/setup.sh` | Creates missing `services/*/.env` from `.env.example`; appends keys that are new in a template; fills blank secrets with `openssl rand -hex 32`; copies auth-service's `INTERNAL_SERVICE_TOKEN` to the other services; `chmod 600` on the files. Refuses if a target `.env` isn't gitignored. Never overwrites a value that is set, and never prints secret values |
| `kong-dev-config.sh` | `make dev-gateway` | Writes `infra/kong/kong.dev.yml` (section 4) |
| `map-data.sh` | `make map-data` | Downloads the OSM extract and builds the OSRM graph ([mapping-stack.md](mapping-stack.md)) |
| `seed-db.ts` | `make db-seed`, `make infra-reset` | Stub: prints "TODO: seed script" |
| `setup.sh` | by hand | Checks Node ≥ 24, enables pnpm, `pnpm install`, `dart pub get` if Flutter exists, starts postgres/redis/redpanda, copies `.env` files (root, services, web), runs `make secrets` and `make db-migrate` |

### Secrets generated by `make secrets` (names only)

| Secret | Written to |
|--------|-----------|
| `BETTER_AUTH_SECRET` | `services/auth-service/.env` |
| `INTERNAL_SERVICE_TOKEN` | generated in auth-service's `.env`, copied to notification, location, mapping, trip, fleet, pricing, payment, platform, audit and realtime-gateway |
| `PHONE_HASH_KEY`, `OTP_ENCRYPTION_KEY` | `services/notification-service/.env` |
| `PII_ENCRYPTION_KEY`, `PII_BLIND_INDEX_KEY`, `UPLOAD_SIGNING_KEY` | `services/fleet-service/.env` |
| `TELEBIRR_WEBHOOK_SECRET`, `CBEBIRR_WEBHOOK_SECRET`, `CHAPA_WEBHOOK_SECRET` | `services/payment-service/.env` |

JWT signing keys are not files: auth-service keeps them encrypted in its database (`jwks` table).
The script prints a note if old `JWT_*_KEY_PATH` lines are still present.

## 4. Kong in development (`make dev-gateway`)

1. `scripts/kong-dev-config.sh` reads `infra/kong/kong.yml` and rewrites every upstream
   `http://<name>:<port>` to `http://host.docker.internal:<port>` with `sed`.
2. It appends one extra service, `auth-dev` → `http://host.docker.internal:3001`, route
   `dev-sign-in-routes` on `/api/dev` (`strip_path: false`). The real `kong.yml` never routes `/api/dev`.
3. The result goes to `infra/kong/kong.dev.yml` (gitignored, header "GENERATED ... Don't edit").
4. Kong starts from `infra/kong/docker-compose.dev.yml` and `make` waits for the admin API.

Change routes in `kong.yml` and rerun `make dev-gateway`. List the loaded routes with
`curl localhost:8001/routes`. Clients through Kong: the web app with `GATEWAY_URL=http://localhost:8000`
(read by `apps/web/vite.config.ts`), the phone app with `make dev-mobile ENV=dev-kong`.
Route details are in [kong.md](kong.md).

## 5. Port map

| Port | What | Started by |
|------|------|------------|
| 3000 | realtime-gateway (Socket.io) | `dev-services`, `stack-up` |
| 3001 | auth-service | same |
| 3002 | trip-service | same |
| 3003 | location-service | same |
| 3004 | pricing-service | same |
| 3005 | payment-service | same |
| 3006 | notification-service (not published by `stack-up`) | `dev-services` |
| 3007 | mapping-service | `dev-services`, `stack-up` |
| 3008 | fleet-service | same |
| 3009 | support-service | `dev-services`, `stack-up` |
| 3010 | audit-service | `dev-services`, `stack-up` |
| 3011 | platform-service | same |
| 5173 | web app (Vite dev server, proxies `/api/*`) | `dev-web`, `dev-services` |
| 5432 | Postgres | `infra-up`, `stack-up`, per-service compose |
| 6379 | Redis | same |
| 9092 | Redpanda (Kafka API) | same |
| 8000 | Kong proxy | `stack-up` or `dev-gateway` |
| 8001 | Kong admin API (127.0.0.1 only) | `dev-gateway` |
| 5000 | OSRM | `dev-infra` |
| 8080 | Nominatim | `dev-infra` |
| 8081 | TileServer GL | `dev-infra` |

The service ports are also the defaults in each `src/config/index.ts` (`PORT`) and in each
Dockerfile's `EXPOSE`.

## 6. Known port conflicts

| Conflict | Why |
|----------|-----|
| `make stack-up` and `make dev-services` | Both bind 3000–3011. Stop one (`make infra-down`) before the other. The Makefile comment above `infra-up` says "3000-3007"; the real range is 3000–3011 |
| `make stack-up` and `make dev-gateway` | Both bind 8000 |
| `make infra-up` and any `services/*/docker-compose.dev.yml` | All bind 5432, 6379, 9092 |
| Another project's Redis or Postgres on the machine | `Bind for 0.0.0.0:6379 failed: port is already allocated`. Stop the other container or change the host port in the compose file (troubleshooting table in [docs/development/README.md](../../docs/development/README.md)) |
| Nominatim on 8080 | Anything else on 8080 on the host |
