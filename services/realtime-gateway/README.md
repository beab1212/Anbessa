# realtime-gateway

## Quick start — standalone, no other services needed

Requires Node 24 (`nvm use`) and pnpm via `corepack enable` (see the root README's Toolchain table).

```bash
# 1. Start only the infra this service requires
docker compose -f docker-compose.dev.yml up -d

# 2. Install dependencies (once)
pnpm install

# 3. Copy the env file
cp .env.example .env

# Start with hot reload (tsx watch — loads libs/* TypeScript source directly)
pnpm dev
```

Service URL  : http://localhost:3000
Health check : http://localhost:3000/health

> **Working across the full stack?**
> From the repo root, run `make dev-services` instead —
> it starts all services together.

---

## Socket events

| Event | Who | Payload → ack | What happens |
|---|---|---|---|
| `location:update` | drivers (`DRIVER` token, `location:stream`) | `{ lat, lng, heading?, speed?, accuracy?, at? }` → `{ accepted }` or `{ accepted: false, reason }` | Plausibility checks, then one Redis pipeline into the driver's geo set (`libs/shared-location`). On a trip, `driver:location` goes to room `trip:{tripId}`, where the trip is the one location-service assigned (never one from the message). Then `driver.location` to Kafka |
| `trip:subscribe` | the trip's rider or driver | `tripId` → `{ ok }` | Joins room `trip:{tripId}` only if the user is in `trip:{id}:members` (written on `trip.matched`) |
| `trip:unsubscribe` | anyone | `tripId` | Leaves the room |
| `driver:location` | server → room | `{ tripId, driverId, lat, lng, heading, at }` | Live position for the rider's map |
| `trip:offer` · `trip:offer_expired` · `trip:offer_cancelled` | trip-service → the driver | `{ tripId, offerId, expiresAt, pickup, dropoff, fare, paymentMethod, etaToPickupSeconds }` | A ride offer (15 s) and its end |
| `trip:status` | trip-service → rider, booker and driver | `{ tripId, status, trip }` | Every status change |

Every socket joins room **`user:{userId}`** on connect. trip-service publishes into those rooms with Socket.io's Redis emitter (same Redis), so services address people, and all of a user's devices receive it.

Rejection reasons: `forbidden` (not a driver), `not_online` (no active driving session in Redis), `too_frequent` (< 1 s since the last accepted ping), `invalid`, `inaccurate` (> 100 m), `future`, `out_of_order`, `too_fast` (> 200 km/h jump), `unavailable` (Redis down).

**Kafka is a side path.** The producer reconnects in the background. A failed publish is counted (`/health/ready` shows `published` / `dropped`) and never reaches the driver's socket or blocks the Redis update. Without `KAFKA_BROKERS` (local) nothing is published.

**Suspensions** end open sockets: every connection rechecks the `deny:{userId}` key once a minute.

---

## Project layout

```
src/
├── config/                 env → typed config (Zod)
├── middlewares/            handshake authentication (JWKS, deny list, permission version)
├── sockets/                location:update, trip:subscribe
├── kafka.ts                guarded driver.location publisher
└── server.ts               HTTP health, Socket.io + Redis adapter, graceful shutdown
```

---

## Common commands

| Command | What it does |
|---------|-------------|
| `pnpm dev` | Start with hot reload (tsx watch) |
| `pnpm build` | Compile TypeScript → dist/ (build libs first: `pnpm turbo run build --filter=@ride-app/realtime-gateway...`) |
| `pnpm start` | Run compiled output (production) |
| `pnpm test:integration` | Socket handlers against a real Redis |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | Type-check only, no emit (against lib source, no build needed) |

---

## Running tests

```bash
pnpm test:integration   # handlers against a real Redis (throwaway container on port 6392, needs Docker)
```

Covers: only drivers stream, the driver id comes from the token, offline drivers are refused, ping flooding, fan-out to the assigned trip only, trip rooms limited to the trip's members.

---

## Docker image

Build from the **repo root** so the workspace libs are in the build context:

```bash
docker build -f services/realtime-gateway/Dockerfile -t ride-app/realtime-gateway .
```

The image is `node:24-alpine`. The build stage uses pnpm (`pnpm deploy --prod`) and the runtime stage ships only `dist/` and production `node_modules`.

---

## Authentication

Sockets authenticate once, at the handshake (`auth.token` = the app's access JWT from `GET /api/auth/token`). The gateway verifies it with `createTokenVerifier` from `libs/shared-authz`: ES256 only, `iss = AUTH_ISSUER`, `aud = ride-app`, keys from `AUTH_JWKS_URL` (cached, refetched on an unknown `kid`). It also refuses suspended users (Redis `deny:{userId}`) and tokens older than the user's permission version (`pv:{userId}`). The verified principal is in `socket.data.principal` ([Auth.md §10](../../docs/design/Auth.md#10-verifying-tokens-in-other-services)).

---

## Environment variables

See `.env.example` — every variable is documented there.
Never commit a `.env` file with real secrets.

## Documentation

Reference documentation (architecture, API, events, data model, integrations, configuration, operations): [docs/README.md](docs/README.md).
