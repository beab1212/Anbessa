# realtime-gateway: operations

## Run locally

| Way | Commands | Notes |
|---|---|---|
| Alone | `docker compose -f docker-compose.dev.yml up -d` (Redis 6379, Redpanda 9092), `pnpm install`, `cp .env.example .env` (or `make -C ../.. secrets`, which also fills `INTERNAL_SERVICE_TOKEN`), `pnpm dev` | http://localhost:3000, `/health` |
| With everything | `make infra-up`, then `make dev-services` from the repo root | |
| One service | `make dev-svc SVC=realtime-gateway` | |

**Port 3000.** It's the default of many other dev servers, so check nothing else holds it. If you change `PORT`, change the app's `WS_URL` (`apps/phone-app/env/*.json`) and platform-service's `SERVICE_URLS` too; both assume 3000. The Android emulator reaches it as `ws://10.0.2.2:3000` (`env/dev-emulator.json`).

To see pings accepted locally the driver must be online in Redis: either fleet-service publishes `driver.online` and location-service applies it, or use location-service's dev route `POST /internal/dev/drivers/:id/online` (development only). Gateway, location-service and trip-service must point at the same `REDIS_URL`.

## Test

| Command | What |
|---|---|
| `pnpm test` | unit tests outside `tests/integration` (none today; `--passWithNoTests`) |
| `pnpm test:integration` | `tests/integration/location.test.ts`: the socket handlers against a throwaway Redis container `anbessa-test-redis-gateway` on port **6395** (`tests/integration/global-setup.ts`, needs Docker). `io`/`socket` are stand-ins, so the handshake middleware, adapter and Kafka publisher are not covered. Set `TEST_REDIS_URL` for another *dedicated* instance (the suite flushes it) |
| `pnpm lint` / `pnpm typecheck` | |

Covered: only drivers stream; the driver id comes from the token; offline drivers are refused and nothing is published; pings faster than 1/s; fan-out only to the assigned trip with `speed`/`heading`; trip rooms limited to members and UUID ids.

## Build and deploy

- `pnpm build` → `dist/`. Build libs first: `pnpm turbo run build --filter=@ride-app/realtime-gateway...`.
- Docker from the repo root: `docker build -f services/realtime-gateway/Dockerfile -t ride-app/realtime-gateway .` (`node:24-alpine`, `pnpm deploy --prod`, user `app`, `EXPOSE 3000`, `HEALTHCHECK` `/health` every 15 s, `CMD node dist/server.js`).
- Kubernetes: only the template in `infra/k8s/base` (shown for trip-service) exists; no gateway manifest in the repo.

## Scaling

- **Horizontal through the Redis adapter.** Rooms and broadcasts go through Redis, so any pod reaches any socket, and the emitters in other services reach every pod.
- **Sticky sessions** are needed only for clients that use HTTP long-polling (Socket.io's polling transport makes several requests that must hit the same pod). The server allows polling, but the phone app uses websocket only, so no stickiness is needed for it (`docs/production/README.md` §7 says the same). Add stickiness if a polling client is ever added.
- The load balancer must support WebSocket upgrades and an idle timeout longer than Socket.io's ping interval (Socket.io default: 25 s ping, 20 s timeout; not overridden in code).
- Every accepted ping costs one `HGETALL` and one pipeline of 5–7 commands, plus one adapter publish when on a trip. Every rejected ping after the 1 s check still costs one `HGETALL`.
- Each socket has a 60 s `setInterval` doing `EXISTS deny:{id}`, i.e. connections/60 Redis commands per second per pod.
- Deploys drop every socket on the old pod; clients reconnect with 1–16 s backoff, re-authenticate and re-subscribe to trips.

## Health

| Endpoint | Meaning | Used by |
|---|---|---|
| `GET /health`, `/health/live` | process up (`ok`) | Docker `HEALTHCHECK` |
| `GET /health/ready` | Redis `PING` OK; also returns `kafka.published` / `kafka.dropped` | platform-service system page |

Kafka state doesn't affect readiness. A growing `dropped` counter with `published` flat means the producer isn't connected.

## Logging

pino, logger name `realtime-gateway`, level from `NODE_ENV` only (`LOG_LEVEL` is ignored, see [configuration.md](configuration.md)). The service logs very little:

| Message | Level |
|---|---|
| `realtime-gateway listening on :3000` | info |
| `KAFKA_BROKERS not set: driver.location is not published (Redis still updates)` | warn |
| `driver.location publish failed` (with `err`) | warn |
| `INTERNAL_SERVICE_TOKEN not set: using the built-in permission matrix` | warn |
| `permission matrix updated` / `… refresh failed; keeping the current one` / `can't subscribe to permission changes; polling only` | info / warn |
| `SIGTERM received, shutting down` | info |

Connections, refused handshakes, rejected pings and disconnects are **not** logged. There's no metrics endpoint beyond the two Kafka counters.

## Failure modes and diagnosis

| Symptom | Likely cause | Check |
|---|---|---|
| App can't connect, `connect_error: unauthorized`, and the user is signed out after 3 tries | expired/invalid token, wrong `AUTH_ISSUER`/`AUTH_JWKS_URL`, user suspended (`deny:{id}`), outdated `pv`, **or Redis unreachable** (the deny/pv lookup fails and is reported as `unauthorized`) | `redis-cli EXISTS deny:<id>`, `GET pv:<id>`; JWKS reachable from the pod; the token's `iss`/`aud` |
| Every ping acked `not_online` | no `driver:{id}` hash: `driver.online` not applied by location-service (Kafka/fleet-service), or different Redis instances | `HGETALL driver:<id>` on the gateway's Redis |
| Pings acked `too_fast` / `out_of_order` after a phone clock change | `at` is device time and compared with the last accepted device time | wait for the hash to expire (15 min) or go offline/online |
| Pings acked `unavailable` | Redis errors | `/health/ready` |
| Rider sees no live car | not joined (`trip:subscribe` → `not_found` because `trip.matched` not applied yet), driver not `on_trip` in Redis, or gateway pods on different Redis | `SMEMBERS trip:<id>:members`, `HGET driver:<id> tripId` |
| Drivers don't get offers / riders no status | trip-service's `REDIS_URL` differs from the gateway's, or the user has no connected socket (events aren't stored) | compare `REDIS_URL`s |
| `/health/ready` shows `dropped` rising | Kafka unreachable or producer disconnected; pings still work | Kafka brokers; restart the pod if `published` stays flat (no reconnect after a `DISCONNECT` event) |
| Suspended user still connected for up to a minute | expected: 60 s recheck | |
