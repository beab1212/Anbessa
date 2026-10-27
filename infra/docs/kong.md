# Kong API gateway

Kong runs DB-less from one declarative file, `infra/kong/kong.yml` (`_format_version: "3.0"`).
The file does routing, rate limiting and request-size limits. It does not verify JWTs: each service
verifies access tokens itself with `libs/shared-authz` against auth-service's JWKS (comment at the
top of `kong.yml`; decision AU5 in [docs/design/Auth.md](../../docs/design/Auth.md)).

Where Kong runs:

| Where | Config loaded | File |
|-------|---------------|------|
| `make stack-up` | `infra/kong/kong.yml` | `infra/docker/docker-compose.yml`, service `kong` |
| `make dev-gateway` | `infra/kong/kong.dev.yml` (generated) | `infra/kong/docker-compose.dev.yml` |
| Staging / production | not found in repo (no Kong Deployment, Helm chart or ingress in `infra/k8s/`) | |

## 1. Services, routes and plugins

Every route has `strip_path: false`, so the service receives the full path. A route without
`methods` accepts every method. Plugins are attached per Kong service, so they apply to all of
that service's routes.

| Kong service | Upstream | Route name | Path prefix | Methods | Plugins |
|--------------|----------|-----------|-------------|---------|---------|
| auth-service | `http://auth-service:3001` | `app-auth-routes` | `/api/auth` | all | rate-limiting 60/min; request-size-limiting 64 KB |
| | | `admin-auth-routes` | `/api/admin-auth` | all | same |
| | | `identity-routes` | `/api/identity` | all | same |
| notification-service | `http://notification-service:3006` | `notification-device-routes` | `/api/notifications` | all | rate-limiting 120/min; request-size-limiting 16 KB |
| | | `telegram-gateway-webhook` | `/api/webhooks/telegram-gateway` | POST | same (no auth plugin; the service checks the HMAC signature) |
| mapping-service | `http://mapping-service:3007` | `maps-routes` | `/api/maps` | GET | rate-limiting 120/min |
| location-service | `http://location-service:3003` | `location-routes` | `/api/locations` | GET | rate-limiting 120/min |
| trip-service | `http://trip-service:3002` | `trip-routes` | `/api/trips` | all | rate-limiting 60/min |
| fleet-service | `http://fleet-service:3008` | `fleet-routes` | `/api/fleet` | all | rate-limiting 120/min |
| platform-service | `http://platform-service:3011` | `platform-routes` | `/api/platform` | all | rate-limiting 120/min |
| support-service | `http://support-service:3009` | `support-routes` | `/api/support` | all | rate-limiting 120/min |
| audit-service | `http://audit-service:3010` | `audit-routes` | `/api/audit` | GET | rate-limiting 60/min |
| pricing-service | `http://pricing-service:3004` | `pricing-routes` | `/api/pricing` | all | rate-limiting 120/min |
| payment-service | `http://payment-service:3005` | `payment-routes` | `/api/payments` | all | rate-limiting 120/min; request-size-limiting 64 KB |
| | | `payment-webhooks` | `/api/payments/webhooks` | POST | same (provider callbacks, verified by each provider's signature in the service) |

Plugin settings:

- `rate-limiting`: `config: { minute: N, policy: local }`. `policy: local` keeps the counters in each
  Kong node's memory, so with several Kong replicas the effective limit is N per node. No `limit_by`
  is set, so Kong's default (by consumer, falling back to client IP) applies.
- `request-size-limiting`: `allowed_payload_size` in kilobytes. Services without it (mapping,
  location, trip, fleet, platform, audit, support, pricing) have no body limit at Kong. Every service also sets
  a Fastify `bodyLimit` in `src/app.ts`: 64 KB auth; 32 KB audit, fleet, payment, mapping, platform,
  support, trip; 16 KB location, notification, pricing. fleet-service raises it to 10 MB only for
  `PUT /api/fleet/files/:ticket` (local storage uploads). realtime-gateway caps Socket.io messages at
  16 KB (`maxHttpBufferSize`).
- Not used anywhere in `kong.yml`: `cors`, `jwt`, `key-auth`, `acl`, `proxy-cache`, `ip-restriction`,
  any logging or metrics plugin. CORS is not needed for the web app because it is served on the same
  origin as `/api/*` (comment in `apps/web/vite.config.ts`; [docs/production/README.md](../../docs/production/README.md) section 8).

Which paths each service actually serves (from the route registrations in `services/*/src`):

| Prefix | Served paths found in code |
|--------|-----------------------------|
| `/api/auth`, `/api/admin-auth` | Better Auth handlers (auth-service) |
| `/api/identity` | `users`, `staff-role-requests`, `approvals`, `organizations`, `authz`, `stats`, `staff-roles`, `staff-accounts`, `me`, `guests`, `cities` |
| `/api/notifications` | `devices` |
| `/api/webhooks/telegram-gateway` | the delivery-report webhook |
| `/api/maps` | `search`, `reverse`, `snap`, `route` |
| `/api/locations` | `nearby`, `trips`, `cities` |
| `/api/trips` | trips, `places`, `stats`, `shared`, `me`, `estimates` (builtin pricing only), `board`, `active` |
| `/api/fleet` | `drivers`, `vehicles`, `documents`, `sessions`, `files` (local storage only), `stats`, `review`, `organizations` |
| `/api/platform` | `settings`, `announcements`, `cities`, `vehicle-types`, `system`, `client-config` |
| `/api/audit` | `entries` |
| `/api/support` | `tickets`, `lost-items`, `sos`, `incidents`, `me` |
| `/api/pricing` | `fares`, `estimates` |
| `/api/payments` | `balances`, `payments`, `top-ups`, `sim` (simulator checkout), `rules`, `payouts`, `refunds`, `me`, `webhooks`, `trips`, `settlements`, `overview`, `methods`, `ledger`, `gateways`, `earnings` |

Every Kong route prefix has a service behind it. Every public `/api/*` prefix in the services has a
Kong route, except `/api/dev` (development sign-in, see section 2).

## 2. `kong.dev.yml`

Generated by `scripts/kong-dev-config.sh` (run by `make dev-gateway`), gitignored:

1. Copies `kong.yml` with `sed -E 's#http://[a-z-]+:([0-9]+)#http://host.docker.internal:\1#'`, so
   each upstream points at the same port on the host.
2. Appends a service `auth-dev` (`http://host.docker.internal:3001`) with route `dev-sign-in-routes`
   on `/api/dev`. auth-service refuses `/api/dev` unless `DEV_LOGIN=on` outside production.

Never edit `kong.dev.yml`; edit `kong.yml` and rerun `make dev-gateway`.

## 3. WebSockets

realtime-gateway (Socket.io on port 3000) has no Kong service or route. Clients connect directly:
`WS_URL` in `apps/phone-app/env/*.json` is `ws://localhost:3000` (`ws://10.0.2.2:3000` on the
Android emulator) in every local profile, including `dev-kong` and `stack`, and
`wss://ws.staging.anbessa.et` in `staging.json`. The web app has no Socket.io client.

The gateway verifies the token in the Socket.io handshake (`auth.token`) and allows any origin
(`cors: { origin: true }` in `services/realtime-gateway/src/server.ts`). The load balancer in front of
it must support WebSockets ([docs/production/README.md](../../docs/production/README.md) section 7).

## 4. What is never routed

- `/internal/*`. Each service exposes service-to-service endpoints there, guarded by
  `INTERNAL_SERVICE_TOKEN` (for example `/internal/authz/snapshot`, `/internal/quotes/:id`,
  `/internal/route`, `/internal/table`, `/internal/settings/snapshot`, `/internal/ops/*`). Kong's
  path prefixes all start with `/api/`, so none of them match. The comments in `kong.yml` repeat this
  for notification, location, fleet and pricing.
- `/health`, `/health/live`, `/health/ready`.
- `/api/dev` (only in the generated `kong.dev.yml`).
- `/internal/dev/drivers/:id/online` (location-service, registered only when `NODE_ENV=development`).

## 5. Adding a route

1. Add the route under the right Kong service in `infra/kong/kong.yml` (or a new service entry with
   `url: http://<service-name>:<port>`; the `<service-name>` must match the compose / Kubernetes
   service name, and the `sed` in `kong-dev-config.sh` only rewrites names made of `a-z` and `-`).
2. Use a path under `/api/`, `strip_path: false`, and restrict `methods` when the route is read-only
   or webhook-only.
3. Attach `rate-limiting` and, where bodies are accepted, `request-size-limiting` on the Kong
   service.
4. Never add a path under `/internal`.
5. Locally: `make dev-gateway` and `curl localhost:8001/routes`. If the web app should reach the path
   without Kong too, add the prefix to the `proxy` map in `apps/web/vite.config.ts`.
6. The config file is read when Kong starts, so restart it to pick up changes
   (`make dev-gateway-down && make dev-gateway`, or recreate the `kong` container in `stack-up`).
