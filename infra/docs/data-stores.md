# Data stores

Postgres, Redis, Kafka (Redpanda locally, MSK planned in production) and S3-compatible object
storage. Table-level design is in [docs/design/Database.md](../../docs/design/Database.md); the
event catalog will be in [libs/shared-types/docs/event-catalog.md](../../libs/shared-types/docs/event-catalog.md).

## 1. Postgres

Local image `postgis/postgis:18-3.6-alpine`, user `ride` (`infra/docker/docker-compose.yml`).
Production: RDS Postgres 16 is declared in `infra/terraform/main.tf` (modules not written yet, see
[terraform.md](terraform.md)).

One database per service. Names are the defaults in each `services/<svc>/.env.example`
(`DATABASE_URL`); the config schemas have no default and require the variable.

| Service | Database | Prisma | Migrations (`prisma/migrations`) | Extensions created by migrations |
|---------|----------|--------|----------------------------------|----------------------------------|
| auth-service | `auth_service` | yes | 4 | |
| trip-service | `trip_service` | yes | 4 | `postgis` |
| payment-service | `payment_service` | yes | 2 | `btree_gist` |
| notification-service | `notification_service` | yes | 1 | |
| fleet-service | `fleet_service` | yes | 1 | |
| platform-service | `platform_service` | yes | 1 | |
| audit-service | `audit_service` | yes | 1 | |
| support-service | `support_service` | yes | 1 | |
| pricing-service | `pricing_service` | yes | 1 | |
| location-service | none | | | |
| mapping-service | none | | | |
| realtime-gateway | none | | | |

All nine databases live on one Postgres server locally (`make infra-up`). `prisma migrate deploy`
creates a missing database. `make stack-up` is different: auth-service gets a `DATABASE_URL` pointing at `ride_app`, pricing-service
one pointing at `pricing_service`; the others keep the root `.env`'s (see [local-development.md](local-development.md)).

Notes:

- The connection URL is read in each service's `prisma.config.ts` (`datasource.url = process.env.DATABASE_URL`),
  which loads `.env` through `dotenv/config` (Prisma 7).
- audit-service: `audit_entry` is partitioned by month and write-once; a trigger refuses UPDATE and
  DELETE (`services/audit-service/.env.example`).
- support-service: SOS alerts, incidents and their notes and actions are never deleted (legal hold);
  a trigger refuses DELETE on `sos_alert`, `sos_note`, `incident`, `incident_note`, `incident_action`.
- The trip-service PostGIS columns are generated columns; `prisma migrate dev` reports them as drift,
  which is why the Makefile uses `migrate deploy` (comment in `Makefile`, target `db-migrate`).

### Migrations

| Command | What it does |
|---------|--------------|
| `make db-migrate` | `pnpm --filter @ride-app/<svc> exec prisma migrate deploy` for auth, notification, trip, fleet, payment, platform, audit, support, in that order; stops on the first failure |
| `pnpm exec prisma migrate dev --create-only` (in a service) | Writes a new migration without applying it (Makefile comment) |
| `make infra-reset` | Deletes the local Postgres volume, then `infra-up`, `db-migrate`, `db-seed` |

In CI/CD, no workflow runs migrations, and the runtime images contain no Prisma CLI. The intended
production procedure is in [docs/production/README.md](../../docs/production/README.md) section 6.

### Backups

No backup configuration, script or Terraform setting was found in repo. Locally, `pg-data` is a
Docker named volume and per-service stacks write to `services/<svc>/.dev-data/postgres`.
[docs/production/README.md](../../docs/production/README.md) describes exporting monthly
`audit_entry_YYYY_MM` partitions to S3 Object Lock; nothing in repo automates it.

## 2. Redis

Local image `redis:8-alpine`, no persistence configured. Production: ElastiCache declared in
Terraform. All services share one Redis: auth-service writes the deny list and permission versions
that every service reads, and trip-service and payment-service emit Socket.io events into the Redis
realtime-gateway uses.

Whether `REDIS_URL` is required (from each `src/config/index.ts`):

| Required always | Required in production | Optional |
|-----------------|------------------------|----------|
| trip, location, pricing, notification, realtime-gateway | auth, payment, fleet, platform, mapping, support | audit |

### Key prefixes and channels by owner

| Owner (writes) | Keys / channels | Readers | Source |
|----------------|-----------------|---------|--------|
| auth-service | `deny:<userId>` (suspended users), `pv:<userId>` (permission version, 24 h TTL) | every service and realtime-gateway | `services/auth-service/src/lib/signals.ts` |
| auth-service | `ba:*` (Better Auth secondary storage: sessions cache, rate limits) | auth-service | `src/lib/secondary-storage.ts` |
| auth-service | pub/sub channel `authz:changed` | every service using `libs/shared-authz` | `libs/shared-authz/src/sync.ts` |
| platform-service | pub/sub channel `settings:changed` | services using `libs/shared-settings` | `libs/shared-settings/src/client.ts` |
| realtime-gateway / location-service (through `libs/shared-location`) | `geo:{city}:<vehicleType>:<set>` (GEO), `seen:{city}`, `vtypes:{city}`, `location:cities`, `driver:<id>`, `trip:<id>:last`, `trip:<id>:members`, `balance:<beneficiaryId>`, `beneficiary:<id>:drivers`, `lock:sweep:{city}` | location, trip, realtime-gateway, fleet/payment (balance state) | `libs/shared-location/src/keys.ts` |
| trip-service | `offer:driver:<driverId>` (offer soft lock, via shared-location keys) | location-service | `services/trip-service/src/matching/matcher.ts` |
| trip-service | `match:due` (sorted set), `match:<tripId>`, `match:<tripId>:declined`, `match:lease:<tripId>` | trip-service | `src/matching/matcher.ts` |
| trip-service | `rating:user:<id>` (300 s), `trip:parties:<...>`, `devquote:<id>` (builtin pricing only) | trip-service | `src/trips/*.ts`, `src/quotes.ts` |
| pricing-service | `quote:<id>` (TTL from settings) | pricing-service (trip-service reads quotes over HTTP) | `services/pricing-service/src/quotes.ts` |
| notification-service | `otp:code:<phoneHash>` (encrypted OTP copy), `otp:fallback` (sorted set) | notification-service | `src/otp/otp-store.ts` |
| mapping-service | `map:*` (route, table, snap, search, reverse cache) | mapping-service | `src/lib/cache.ts`, `src/maps.ts` |
| payment-service | simulator state, 7-day TTL (`sim:op:*`, `sim:ref:*`) | payment-service | `src/gateways/simulator.ts` |
| Socket.io | Redis adapter / emitter channels (library default prefix) | realtime-gateway, trip-service, payment-service (`@socket.io/redis-emitter`) | `services/realtime-gateway/src/server.ts` |

Keys with `{city}` use Redis Cluster hash tags so a city's keys stay on one slot. The exact
ownership split between realtime-gateway and location-service for the shared-location keys is in
[docs/architecture/overview.md](../../docs/architecture/overview.md).

## 3. Kafka / Redpanda

Local image `redpandadata/redpanda:v26.2.6`, one broker on `localhost:9092`. Production: MSK
declared in Terraform. Client: `kafkajs@2.2.4`, patched (`patches/kafkajs@2.2.4.patch`).

- Producers write through a transactional outbox table (auth, trip, fleet, payment, platform, support) and a
  relay; realtime-gateway publishes `driver.location` directly.
- Consumer groups (`groupId` in code): `location-service`, `notification-service`, `fleet-service`,
  `payment-service`, `audit-service`, `support-service`. platform-service shows their lag (`CONSUMER_GROUPS`).
- Consumers create missing topics only outside production (`createTopics: NODE_ENV !== "production"`
  in each `server.ts`). In production, topics must be created up front.

| Producer | Topic families |
|----------|----------------|
| auth-service | `user.*`, `role.*`, `org.*`, `audit.recorded` |
| trip-service | `trip.*` |
| fleet-service | `driver.*`, `vehicle.*`, `document.expiring`, `audit.recorded` |
| payment-service | `balance.*`, `payment.*`, `payout.*`, `refund.*`, `trip.settled`, `audit.recorded` |
| platform-service | `platform.settings_changed`, `audit.recorded` |
| support-service | `ticket.*`, `lost_item.returned`, `sos.*`, `incident.*`, `audit.recorded` |
| location-service | `driver.connection_lost` |
| realtime-gateway | `driver.location` |

Full topic list, keys and payloads: [libs/shared-types/docs/event-catalog.md](../../libs/shared-types/docs/event-catalog.md)
and the events table in [docs/architecture/overview.md](../../docs/architecture/overview.md).

## 4. Object storage (driver and vehicle documents)

Only fleet-service uses object storage (`services/fleet-service/src/lib/storage.ts`).

| Setting | Meaning |
|---------|---------|
| `STORAGE=local` | Files in `STORAGE_DIR` (default `.dev-data/uploads`), served at `/api/fleet/files/:ticket` with signed tickets (`UPLOAD_SIGNING_KEY`). Refused in production |
| `STORAGE=s3` | Pre-signed `PUT` / `GET` URLs; requires `S3_BUCKET`. `S3_REGION` (default `eu-central-1`), `S3_ENDPOINT` + `S3_FORCE_PATH_STYLE=true` for MinIO or another S3 API |

- Upload and view URLs expire after 5 minutes; maximum upload size 10 MB.
- Object keys: `<subjectType>/<subjectId>/<kind>/<uuidv7>.<ext>`.
- Clients (web `apps/web/src/components/Documents.tsx`, phone driver onboarding) upload straight to
  the URL, so no file body passes through Kong.
- AWS credentials come from the SDK's default provider chain; no credential variables are read.
- No bucket is declared in Terraform and no MinIO container is in any compose file.
