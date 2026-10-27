# platform-service

Runs the platform's **live configuration** (port 3011, database `platform_service`):

- **settings** that services read at runtime, from `libs/shared-settings`: matching, trip rules, cancellation fees, the built-in fares, OTP channels, document reminders, maintenance and minimum app versions, feature flags;
- **cities** (map area, time zone, open or closed) and **vehicle types**;
- **announcements** for the apps and the web;
- the **system page**: every service's health, outboxes, Kafka lag, Redis and outside services.

The admin dashboard (web → Administration) is its user interface.

## Quick start

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres, Redpanda
pnpm install
make -C ../.. secrets                             # .env + the shared INTERNAL_SERVICE_TOKEN
pnpm prisma migrate dev                           # creates platform_service
pnpm dev                                          # http://localhost:3011
```

On first start it creates the built-in cities (Addis Ababa, Hawassa) and vehicle types (economy, comfort, minivan). It then tells auth-service about every city (`PUT /internal/cities/:id`), which creates the city's staff organisation for city-scoped roles. If auth-service isn't up yet, it retries every 30 s.

## How settings work

- **Definitions:** each setting is defined in `libs/shared-settings/src/registry.ts` with its type, bounds, default, scope (`global`, or `city` for per-city overrides) and whether it is **sensitive**.
- **Changing a value:** an ordinary change applies at once. A sensitive one (★) becomes a change request that a **different** super admin approves (maker–checker, 7-day expiry).
- **What every applied change does:**
  - writes `setting_history` (before → after, who, approved by, why);
  - bumps `settings_version`;
  - writes an `audit.recorded` event;
  - after commit, publishes `settings:changed` on Redis.
- **How services read them:** through `createSettingsClient`, which loads the snapshot at start (`GET /internal/settings/snapshot`), reloads on the Redis message and polls every 30 s as a backstop.
- **Resolution order:** city override → global value → the service's own default (its env value) → the registry default. If platform-service is down, services keep their last snapshot, or their defaults.

| Who reads it | Settings |
|---|---|
| trip-service | `match.*`, `trip.*`, `cancel.*`, `fares.*`, `quote.ttlSeconds`, `maintenance.newTrips` (refuses new trips with `503 maintenance`), `features.phoneBooking`, `features.corporateBooking` |
| notification-service | `otp.channels`, `otp.fallbackSeconds` |
| fleet-service | `documents.expiryWarningDays`, `documents.reminderDays` |
| apps and web (`/api/platform/client-config`) | cities, vehicle types, feature flags, maintenance message, minimum app versions, announcements |

## API

Everything is under `/api/platform` and needs a staff (`ride-admin`) token, except `client-config`.

| Route | Who (permission) | What |
|---|---|---|
| `GET /client-config?audience=&cityId=` | public (cached 15 s) | Open cities, vehicle types, flags, maintenance, minimum app versions, current announcements |
| `GET /settings` · `GET /settings/history?key=` | `settings:read` | Definitions, values, city overrides, pending changes · history |
| `PUT /settings/:key` | `settings:propose` | `{ value, cityId?, reason }`. `value: null` goes back to the default. `200` applied, or `202` waiting for approval |
| `GET /settings/changes` · `POST /settings/changes/:id/approve`, `/reject`, `/cancel` | `settings:read` / `settings:approve` / the maker | Sensitive changes. Maker ≠ checker |
| `GET /cities` · `POST /cities` · `PUT /cities/:id` | `settings:read` / `city:manage` | Synced to auth-service before it's saved here |
| `GET /vehicle-types` · `PUT /vehicle-types/:code` | `settings:read` / `city:manage` | Name, seats, on/off, which cities |
| `GET`/`POST /announcements` · `PUT /announcements/:id` · `POST /announcements/:id/archive` | `announcement:manage` | Audience (rider, driver, partner, staff), cities, time window |
| `GET /system?refresh=` | `system:read` | Health of every service in `SERVICE_URLS`, outbox backlogs, Kafka lag for `CONSUMER_GROUPS`, Redis, OTP delivery and Telegram balance, routing engines, document storage (cached 10 s) |
| `GET /internal/settings/snapshot` | service token | What every service loads |

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Watch mode |
| `pnpm test:integration` | Throwaway `platform_service_test` database: settings applied vs approved, validation, permissions, city sync, vehicle types, announcements, system page |
| `pnpm lint` / `pnpm typecheck` | |

## Documentation

Reference documentation for engineers (architecture, API, events, data model, integrations, configuration, operations): [docs/README.md](docs/README.md).
