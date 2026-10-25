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
| OpenSSL | any | Generating the local JWT key pair |
| Terraform, kubectl | ≥ 1.8 / any | Infra team only |

---

## 2. First-time setup

```bash
git clone <repo> && cd Anbessa
nvm use && corepack enable

make setup            # everything; or pick one:
make setup-services   # backend: pnpm install, .env files, JWT keys, infra-up, db-migrate
make setup-admin      # admin dashboard
make setup-mobile     # Flutter: dart pub get for the whole workspace
```

`make setup-services` does the following, in order:

1. `pnpm install`. This also runs `prisma generate` for auth-service (the client is written to `src/generated/prisma`, gitignored).
2. Copies the env files if they don't exist:
   - root `.env`, used by `infra/docker/docker-compose.yml`
   - `services/*/.env`, used by each service's `pnpm dev`
3. `make infra-up`: starts Postgres 18 + PostGIS, Redis 8 and Redpanda in Docker.
4. `make db-migrate`: `prisma migrate dev` for every service in `PRISMA_SERVICES` (auth-service today). It creates the database if it's missing and applies `prisma/migrations`.

### JWT keys (required once)

> **Planned change:** when auth-service moves to Better Auth ([docs/design/Auth.md](../design/Auth.md)), signing keys are generated and rotated by Better Auth inside the database, and `make secrets` will create `BETTER_AUTH_SECRET` instead of key files. The steps below describe the code as it is today.

auth-service signs tokens with a private key. realtime-gateway (and later Kong)
verifies them with the public key. The paths in the `.env.example` files point at
`secrets/` in the repo root:

```bash
make secrets
```

`make setup-services`, `make dev-services` and `make dev-svc` run this for you. It:

- generates an RSA-3072 pair **only if missing**, so existing keys (and the tokens signed with them) survive. To rotate, delete `secrets/` and run it again.
- creates files under `umask 077`, then sets `secrets/` to `700`, the private key to `600` and the public key to `644`.
- refuses to run if `secrets/jwt-private.pem` isn't gitignored, and `.dockerignore` keeps `secrets/` out of every image.
- warns if the disk ignores Unix permissions (NTFS/exFAT mounts, like this repo's). There the private key is readable by other local users: acceptable for throwaway dev keys, never for real ones.

Only `services/auth-service/.env` references the private key. Every other service gets `JWT_PUBLIC_KEY_PATH` only.

If a key file is missing, the service stops at boot with a config error naming the variable:
``JWT_PUBLIC_KEY_PATH: file not found. Run `make secrets` from the repo root…``

> These are **development keys**. Staging and production keys come from the secrets manager. See `docs/production/README.md`.

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
| 5173 | admin dashboard (Vite) |
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

## 4. Admin dashboard

```bash
make setup-admin                  # pnpm install + apps/admin-dashboard/.env
make dev-admin                    # http://localhost:5173
```

`VITE_*` variables in `apps/admin-dashboard/.env` are baked in at build time.
`VITE_API_BASE_URL` should point at Kong (`http://localhost:8000`, only up with `make stack-up`)
or directly at a service while Kong isn't running.

---

## 5. Mobile app (rider + driver in one app)

```bash
make setup-mobile                 # dart pub get (root pub workspace)
make dev-mobile                   # flutter run in apps/rider-app
```

- There is one app, `apps/rider-app`. The login screen offers **Continue as rider** / **Continue as driver** until auth is wired to the API. After that, the JWT's `role` claim picks the mode.
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
make dev-infra    # tileserver-gl, Nominatim, OSRM — see infra/mapping-stack/README.md
```

Nominatim needs a regional OSM import, and OSRM needs a one-time preprocessing
step. Most developers point `OSRM_URL` / `NOMINATIM_URL` at a shared staging instance instead.

---

## 7. Editor

Open the workspace file for your team instead of the repo root:
`.vscode/services.code-workspace`, `admin.code-workspace`,
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
| `JWT_*_KEY_PATH: file not found` on boot | Run `make secrets` (section 2). |
