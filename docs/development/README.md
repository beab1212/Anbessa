# Development guide

How to get the repo running on your machine and the day-to-day loop for each
part of the stack. For tests see [`../testing/README.md`](../testing/README.md);
for shipping see [`../production/README.md`](../production/README.md).

---

## 1. Prerequisites

| Tool | Version | Install / notes |
|------|---------|-----------------|
| Node.js | 24 LTS | `nvm install && nvm use` (reads `.nvmrc`) |
| pnpm | 11 (pinned in `package.json` → `packageManager`) | `corepack enable`. Don't `npm i -g pnpm` |
| Docker | Engine + Compose v2 | Runs Postgres, Redis, Redpanda (and optionally every service) |
| Flutter | 3.44+ (Dart 3.12+) | Mobile team only. Android SDK with licenses accepted: `flutter doctor --android-licenses` |
| OpenSSL | any | Generating local dev secrets (`make secrets`) |
| Terraform, kubectl | ≥ 1.8 / any | Infra team only |

---

## 2. First-time setup

```bash
git clone <repo> && cd Anbessa
nvm use && corepack enable

make setup            # everything; or pick one:
make setup-services   # backend: pnpm install, .env files + dev secrets, infra-up, db-migrate
make setup-web      # web app (staff dashboard, fleet and corporate portals)
make setup-mobile     # Flutter: dart pub get for the whole workspace
```

`make setup-services` does the following, in order:

1. `pnpm install`. This also runs `prisma generate` for auth-service (the client is written to `src/generated/prisma`, gitignored).
2. Copies the env files if they don't exist:
   - root `.env`, used by `infra/docker/docker-compose.yml`
   - `services/*/.env`, used by each service's `pnpm dev`
3. `make infra-up`: starts Postgres 18 + PostGIS, Redis 8 and Redpanda in Docker.
4. `make db-migrate`: `prisma migrate dev` for every service in `PRISMA_SERVICES` (auth-service today). It creates the database if it's missing and applies `prisma/migrations`.

### Dev secrets (required once)

```bash
make secrets
```

`make setup-services`, `make dev-services` and `make dev-svc` run this for you (`scripts/dev-secrets.sh`). It:

- creates `services/*/.env` from `.env.example` where missing, and adds keys that are new in the auth-service or notification-service `.env.example` to an existing `.env`;
- fills **`BETTER_AUTH_SECRET`** (encrypts the JWT signing keys stored in the database and signs cookies), **`INTERNAL_SERVICE_TOKEN`** (service-to-service calls to `/internal/*`), and notification-service's **`PHONE_HASH_KEY`** and **`OTP_ENCRYPTION_KEY`** with fresh random values, **only when they're blank**. Values are never printed;
- copies auth-service's `INTERNAL_SERVICE_TOKEN` into notification-service's `.env` (the two must match);
- refuses to run if either `.env` isn't gitignored;
- warns if the disk ignores Unix permissions (NTFS/exFAT mounts, like this repo's): fine for throwaway dev secrets, never for real ones.

There are no key files any more: Better Auth generates the ES256 signing keys on first use, stores them encrypted in the `jwks` table and rotates them. Other services verify tokens with the public keys at `AUTH_JWKS_URL` (`http://localhost:3001/api/auth/jwks`). If you still have `secrets/*.pem` or `JWT_*_KEY_PATH` lines from before, you can delete them.

> Changing `BETTER_AUTH_SECRET` makes the stored signing keys unreadable. Locally, delete them after changing it (`docker exec -it docker-postgres-1 psql -U ride auth_service -c 'DELETE FROM jwks'`); new keys are created on the next `/token`.

### First staff login (super admin)

The staff dashboard has no sign-up. Create the first two super admins with the bootstrap command (it refuses once two exist):

```bash
pnpm --filter @ride-app/auth-service bootstrap:super-admin -- --email you@anbessa.et --name "Your Name"
```

It prints a one-time temporary password. Sign in at `/api/admin-auth/sign-in/email`, change the password and enrol TOTP. Until both are done, your access token carries no roles. After that, every other staff role goes through maker–checker: one super admin requests (`POST /api/identity/staff-role-requests`), the other approves.

### Ready-made accounts (web app dev sign-in)

For day-to-day work you don't need to go through bootstrap, setup and maker–checker each time:

```bash
pnpm --filter @ride-app/auth-service seed:dev    # accounts and companies
pnpm --filter @ride-app/fleet-service seed:dev   # drivers, cars and documents for them (auth-service running with DEV_LOGIN=on)
```

fleet-service's seed gives the onboarding officer something to review (an owner-driver and their car, a fleet car, a company's papers), an approved owner-driver with a car, and the dev fleet's car given to its driver. Its documents are generated PDFs marked "development sample".

It creates (or resets) staff accounts with a fixed password, an authenticator already enrolled and their roles in Addis Ababa (two super admins, dispatcher, call center, onboarding, safety, an all-round "ops floor" account), plus partners: a verified fleet with its owner, a verified company account with its admin, travel desk and an employee, and a partner with no company yet. The list is in `services/auth-service/src/dev/accounts.ts`.

With `DEV_LOGIN=on` in `services/auth-service/.env` (the `.env.example` default; `make secrets` adds it), the web app's sign-in page shows a **Sign in as…** panel: one click signs in through the normal endpoints, with auth-service's `/api/dev/code` supplying the authenticator or SMS code. None of it exists in production: config refuses `DEV_LOGIN=on` there, `seed:dev` refuses anything but `NODE_ENV=development`, Kong has no `/api/dev` route, and the panel is left out of `vite build`. It needs the web app's Vite proxy (not Kong), and it shares the normal sign-in rate limits (5 a minute); set `AUTH_RATE_LIMIT=off` locally if you switch accounts a lot.

### Phone sign-in during development

`OTP_DELIVERY=console` (the default in `.env.example`) logs the code instead of sending it:

```
WARN DEV OTP (console delivery, never enabled in production)  phone: "+2519••••344"  code: "892513"
```

```bash
curl -XPOST localhost:3001/api/auth/phone-number/send-otp -H 'content-type: application/json' -d '{"phoneNumber":"+251911223344"}'
curl -i -XPOST localhost:3001/api/auth/phone-number/verify -H 'content-type: application/json' -d '{"phoneNumber":"+251911223344","code":"<code from the log>"}'
# the session token is in the `set-auth-token` response header
curl localhost:3001/api/auth/token -H 'authorization: Bearer <session token>'   # → { "token": "<15-min JWT>" }
```

Only Ethiopian mobile numbers (`+2519…` / `+2517…`) are accepted. Configuration refuses `console` delivery when `NODE_ENV=production`.

**Through notification-service** (the production path): set `OTP_DELIVERY=notification` in `services/auth-service/.env` and run both services (`make dev-svc SVC=notification-service`, with `make db-migrate` once). Without a `TELEGRAM_GATEWAY_TOKEN` the code goes by SMS, and with `SMS_PROVIDER=console` notification-service prints it:

```
WARN DEV SMS (console provider, never enabled in production)  to: "+2519••••344"  body: "Anbessa: your code is 892513. …"
```

To try Telegram, put a Gateway token in `services/notification-service/.env`. Codes sent to your own number are free. Delivery reports need a public `TELEGRAM_CALLBACK_URL`, so without one the 20-second SMS fallback also fires.

---

## 3. Backend services

```bash
make dev-services                 # all 8 services, hot reload (turbo, parallel)
make dev-svc SVC=auth-service     # one service
```

`pnpm dev` in a service runs:

```
tsx watch --conditions=development --env-file-if-exists=.env src/server.ts
```

- `--env-file-if-exists=.env` loads that service's `.env`. Config is validated with Zod at boot and fails fast if a variable is missing.
- `--conditions=development` resolves `@ride-app/shared-*` to their TypeScript **source**, so editing `libs/*` hot-reloads with no rebuild. Compiled output (`pnpm build` / `pnpm start` / Docker) uses the libs' `dist/` instead.

### Ports

| Port | What |
|------|------|
| 3000 | realtime-gateway (Socket.io) |
| 3001 | auth-service |
| 3002 | trip-service |
| 3003 | location-service |
| 3004 | pricing-service |
| 3005 | payment-service |
| 3006 | notification-service |
| 3007 | mapping-service |
| 5173 | web app (Vite) |
| 5432 / 6379 / 9092 | Postgres / Redis / Redpanda (Kafka API) |
| 8000 | Kong. Only in `make stack-up` |
| 5000 / 8080 / 8081 | OSRM / Nominatim / tile server (`make dev-infra`) |

Every service exposes `GET /health`.

### Two ways to run the stack (don't mix them)

| | `make infra-up` + `make dev-services` | `make stack-up` |
|---|---|---|
| Services run | on your machine, hot reload | in containers built from each `Dockerfile` |
| Kong (`:8000`) | not started (Kong routes to container hostnames) | yes, in front of auth/trip/pricing/payment |
| Use it for | day-to-day coding | checking the production images and Kong routing |

Both use ports 3000–3007, so stop one (`make infra-down`) before starting the other.

### Working on one service in isolation

Each service has its own `docker-compose.dev.yml` that starts only what it needs:

```bash
cd services/auth-service
docker compose -f docker-compose.dev.yml up -d
cp .env.example .env
pnpm prisma migrate dev
pnpm dev
```

### Database workflow (Prisma 7, auth-service)

```bash
cd services/auth-service
# 1. edit prisma/schema.prisma
pnpm prisma migrate dev --name add_refresh_tokens   # creates + applies a migration, regenerates the client
pnpm prisma studio                                   # browse data
```

- Connection settings live in `prisma.config.ts` (reads `DATABASE_URL` from `.env`), not in `schema.prisma`.
- Import the client from `../generated/prisma/client.js`. Queries go through `@prisma/adapter-pg`.
- Commit the generated `prisma/migrations/*` folder; production applies exactly those.
- trip-service and payment-service have empty `prisma/` folders. Copy auth-service's setup when they get a schema, and add them to `PRISMA_SERVICES` in the `Makefile`.

### Shared contracts

Kafka payloads and cross-service types live in `libs/shared-types`. Change the
type in the same PR as the producer and consumer (see `CONTRIBUTING.md`).

### Adding a new service

1. Copy `services/pricing-service` (the smallest) and rename it in `package.json` (`@ride-app/<name>`).
2. Pick a free port, and update `src/server.ts`, the `Dockerfile` (`EXPOSE`/`HEALTHCHECK`) and `.env.example`.
3. Add it to `SERVICES` in the `Makefile`, `infra/docker/docker-compose.yml`, the `deploy.yml` matrix, and Kong if it has a public HTTP API.
4. `pnpm install` at the root, then `pnpm typecheck && pnpm lint`.

---

## 4. Web app (staff dashboard, fleet and corporate portals)

```bash
make setup-web                  # pnpm install + apps/web/.env
make dev-web                    # http://localhost:5173
```

One app, three areas: the staff dashboard, the fleet portal and the corporate portal. Which pages a user sees depends on the roles in their token (see [Role.md §4](../design/Role.md#which-surface-each-role-uses) and `apps/web/README.md`).

The browser only calls `/api/*` on `localhost:5173`; Vite forwards each prefix to its service (targets in `apps/web/.env`). Run auth, trip, location and mapping (`make dev-services`). To sign in as staff locally, bootstrap a super admin (section 2), then sign in at `/sign-in/staff`: the first sign-in walks through the new password and authenticator setup. Partners sign in at `/sign-in/partner` with a console OTP.

To go through Kong instead (`make stack-up`), point every target in `apps/web/.env` at `http://localhost:8000`.

Map tiles come from OpenFreeMap by default (`VITE_MAP_STYLE_URL` in `apps/web/.env`), so the maps work without running anything else. To use the self-hosted tile server instead, run `make dev-infra` and set `VITE_MAP_STYLE_URL` to one of its styles (listed at `http://localhost:8081/`).

---

## 5. Mobile app (rider + driver in one app)

```bash
make setup-mobile                 # dart pub get (root pub workspace)
make dev-mobile                   # flutter run in apps/phone-app
```

- There is one app, `apps/phone-app`. The login screen offers **Continue as rider** / **Continue as driver** until the OTP screens are wired to the API. After that, the JWT's `roles` claim (`RIDER`, `DRIVER`) picks the mode.
- Backend URLs come from `--dart-define` (`lib/core/config/env.dart`):
  ```bash
  flutter run --dart-define=API_BASE_URL=http://10.0.2.2:8000 --dart-define=WS_URL=ws://10.0.2.2:3000
  ```
  On the Android emulator, `10.0.2.2` is your machine; `localhost` is the emulator itself.
- Driver mode needs location permission. On an emulator, set a simulated location.
- Shared Dart code lives in `packages/core`. Both resolve together through the root `pubspec.yaml` workspace.

---

## 6. Mapping stack (optional, heavy)

```bash
make map-data     # once: download the Ethiopia extract (~140 MB) and build the OSRM graph (~10 min, ~4 GB RAM)
make dev-infra    # tileserver-gl, Nominatim, OSRM — see infra/mapping-stack/README.md
```

Nominatim imports the extract on its first start (slow). Most developers point `OSRM_URL` / `NOMINATIM_URL` in `services/mapping-service/.env` at a shared staging instance instead.

**You don't need the engines to work on the backend.** Without them, mapping-service answers routes and ETAs with straight-line estimates flagged `"approximate": true`, and address search returns `503`.

### Drivers online

A driver goes online through fleet-service (`POST /api/fleet/sessions {vehicleId}` with an approved profile and a verified car), which publishes `driver.online`; location-service picks it up from Kafka. `seed:dev` (below) gives you approved drivers with cars. For a quick test without fleet-service or Kafka, location-service still has a development stand-in route:

```bash
TOKEN=$(grep ^INTERNAL_SERVICE_TOKEN= services/location-service/.env | cut -d= -f2)
curl -XPOST localhost:3003/internal/dev/drivers/<driver user id>/online -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"vehicleId":"v-1","vehicleType":"economy","cityId":"addis-ababa","cashAllowed":true}'
```

The user needs the `DRIVER` role (`POST /internal/drivers/:userId/role {"active":true}` on auth-service).

### Book a ride locally

With auth, location, mapping, trip and realtime-gateway running (`make dev-services`) and Kafka up:

1. **Sign in** a rider and a driver with phone OTP (section 2), grant the driver role, and get fresh access tokens from `GET /api/auth/token`.
2. **Put the driver online** with the location-service dev route above, connect the driver's socket to realtime-gateway (`auth: { token }`), and send `location:update` pings near the pickup.
3. **Quote** (stand-in until pricing-service exists):
   ```bash
   curl -XPOST localhost:3002/api/trips/estimates -H "authorization: Bearer $RIDER" -H 'content-type: application/json' \
     -d '{"pickup":{"lat":8.9806,"lng":38.7578},"dropoff":{"lat":9.0333,"lng":38.75},"vehicleTypes":["economy"]}'
   ```
4. **Request:** `POST localhost:3002/api/trips {"quoteId":"q_…","paymentMethod":"CASH"}` with `Idempotency-Key: <uuid>`.
5. The driver's socket receives **`trip:offer`** with an `offerId`. Accept it: `POST /api/trips/:id/accept {"offerId":"…"}` with the driver's token. The rider's socket receives `trip:status` `matched`.
6. Drive it: `en-route` → ping within 150 m of the pickup → `arrive` → `start` → `complete`.

Without location-service's view of the driver, matching finds nobody and the trip is cancelled with `NO_DRIVER_FOUND` after 120 s.

---

## 7. Editor

Open the workspace file for your team instead of the repo root:
`.vscode/services.code-workspace`, `web.code-workspace`,
`mobile.code-workspace` or `infra.code-workspace`.

Formatting: `.editorconfig` everywhere; Prettier (`pnpm format`) for TS/JSON/MD;
`dart format` for Dart.

---

## 8. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Bind for 0.0.0.0:6379 failed: port is already allocated` | Another Redis (often another project's container) owns the port. Stop it, or change the host port in `infra/docker/docker-compose.yml`. |
| Postgres container exits right after an upgrade | The old Postgres 16 volume won't start on 18. Run `make infra-reset` (wipes local data). |
| `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | pnpm wants to rebuild `node_modules` in a non-interactive shell. Run `CI=true pnpm install`. |
| `Cannot find module '../generated/prisma/client.js'` | Run `pnpm --filter @ride-app/auth-service exec prisma generate`. |
| `pnpm start` / `node dist/server.js` can't find `@ride-app/shared-*` | The libs aren't built. Run `pnpm build` at the root (turbo builds the libs first). |
| `typescript-eslint does not support TS 7.0` | The root `typescript` must stay aliased to `@typescript/typescript6` (see root `package.json`). Don't replace it with plain `typescript@7`. |
| Every file shows as modified in git (NTFS / WSL / USB drives) | `git config core.fileMode false` |
| `TimeoutNegativeWarning: -17929… is a negative number` | A kafkajs 2.2.4 bug on Node 24 (it schedules `-1 - Date.now()` ms). Fixed by `patches/kafkajs@2.2.4.patch` (`patchedDependencies` in `pnpm-workspace.yaml`). If you see it, run `pnpm install`. Remove the patch when upgrading kafkajs |
| `GET /` on a service returns 404 | Expected: services only serve their API and `/health`. auth-service: `/health`, `/health/ready`, `/api/auth/*`, `/api/admin-auth/*`, `/api/identity/*` |
| auth-service exits with a ZodError naming `BETTER_AUTH_SECRET` | Run `make secrets` (section 2). |
| `/api/auth/token` fails after changing `BETTER_AUTH_SECRET` | The stored signing keys can't be decrypted. Locally, `DELETE FROM jwks;` in `auth_service` (section 2) |
| Every `/api/auth/...` you try returns 404 | Only allowlisted Better Auth endpoints are served ([Auth.md §5](../design/Auth.md#5-plugins)). Admin-plugin endpoints are replaced by `/api/identity` |
