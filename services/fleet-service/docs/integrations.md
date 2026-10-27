# Integrations

Every system fleet-service talks to, and every system that talks to it. Clients: `src/lib/clients.ts`, `libs/shared-authz/src/sync.ts`, `libs/shared-settings/src/client.ts`, `src/lib/storage.ts`.

All service-to-service HTTP calls use `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` (one shared token, the same value in every service's `.env`; `make secrets` copies it). fleet-service's own clients also send `x-service-name: fleet-service`; auth-service records it in its audit entry when the DRIVER role changes.

## Outbound

| Target | Call | Timeout | On failure |
|---|---|---|---|
| auth-service | `GET {AUTH_JWKS_URL}` (JWKS) | jose defaults | Token checks fail → 401 `invalid_token` |
| auth-service | `GET /internal/organizations/:id` → `{ id, name, kind, cityId, legalName, status }` | 3 s | Network error / timeout / non-2xx except 404 → `503 dependency_unavailable`. 404 → treated as "no such organisation" |
| auth-service | `GET /internal/organizations/:orgId/members/:userId` → `{ organizationId, userId, roles[], name, phoneNumber, banned }` | 3 s | Same. auth-service answers 404 for non-members and for memberships past their `validUntil` |
| auth-service | `POST /internal/drivers/:userId/role { active: true }` | 3 s | `503` → the approval transaction rolls back. A 404 (user unknown to auth-service) is swallowed and the approval succeeds |
| auth-service | `GET /internal/authz/snapshot` (permission matrix) | 3 s | Logged; the current (or built-in) matrix stays in force. Retried on `authz:changed` and every 30 s |
| payment-service | `GET /internal/balances/state?type=INDIVIDUAL\|ORGANIZATION&ownerId=` → `{ state, cashAllowed }` | 2 s | Any error or non-2xx → `null`: the session starts with `balanceState: "OK"`, `cashAllowed: true` and a warning is logged |
| platform-service | `GET /internal/settings/snapshot` | 3 s | Logged; current values (or env / registry defaults) stay. Retried on `settings:changed` and every 30 s |
| Object storage (S3 / MinIO) | `PutObject` / `GetObject` presign (local computation), `HeadObject` on confirm, `HeadBucket` on `/internal/ops/storage` | AWS SDK defaults | `HeadObject` 404 → `upload_missing`; other errors → 500. `HeadBucket` errors → `{ ok: false }` |
| Redis | `EXISTS deny:{id}`, `GET pv:{id}` per authenticated request; `SUBSCRIBE authz:changed`, `settings:changed` | ioredis, `maxRetriesPerRequest: 2` | A Redis error during a token check is not caught: the request fails with 500 |
| Kafka | Produce (outbox relay), consume `driver.connection_lost` | kafkajs defaults | See [events.md](events.md) |
| Postgres | Prisma over `pg` | — | `/health/ready` returns 503 |

Callers of auth-service that need an organisation's city or status: vehicle registration (fleet), vehicle approval (fleet car), document upload and listing (`ORGANIZATION` subject). Membership lookups: granting an authorisation, the fleet overview (one call per listed member, up to 100), `GET /drivers/:id?orgId=`.

What is **not** called: location-service (driver state reaches it only through Kafka), notification-service (no fleet event is consumed by it), audit-service (only through `audit.recorded`), trip-service.

## Inbound

| Caller | What it calls | How |
|---|---|---|
| Phone app (driver mode) | `GET /drivers/me`, `POST /drivers/apply`, `POST /drivers/me/submit`, `GET /drivers/me/vehicles`, `POST /vehicles` (always `INDIVIDUAL`), `GET /vehicles/:id`, `POST /vehicles/:id/submit` / `retire`, document upload-url → PUT → confirm, `GET /documents`, `GET /documents/:id/url`, `POST /sessions` (with an idempotency key), `GET` / `DELETE /sessions/current` | `FleetApi` in `packages/core/lib/src/api/service_apis.dart`; used by `apps/phone-app/lib/features/driver/onboarding/onboarding_screens.dart` (apply, vehicle, uploads, submit) and `apps/phone-app/lib/features/driver/shift/shift_controller.dart` (going online / offline). Direct to port 3008 in dev (`packages/core/lib/src/api/api_client.dart`) or through Kong |
| Web app (staff) | Review queue, driver list / record / actions, vehicle list / record / approve / reject, documents (list, view URL, review), `GET /stats` | `apps/web/src/pages/staff/Onboarding.tsx`, `staff/Fleet.tsx`, `admin/Overview.tsx`, `components/Documents.tsx`, `lib/fleet.ts`. Vite proxies `/api/fleet` to `FLEET_URL` or port 3008 (`apps/web/vite.config.ts`) |
| Web app (fleet portal) | `POST /vehicles` (`ORGANIZATION`), `GET /vehicles?ownerOrgId=`, vehicle submit / retire, authorisations, `GET /organizations/:id/overview`, organisation documents | `apps/web/src/pages/partner/Fleet.tsx` |
| trip-service | `GET /internal/vehicles/:id` for the rider's view of the car | `partiesClient` in `services/trip-service/src/lib/clients.ts` (`FLEET_INTERNAL_URL`, default `http://localhost:3008`, 2.5 s timeout, 404 → null) |
| platform-service | `GET /health/ready`, `GET /internal/ops/outbox`, `GET /internal/ops/storage` (4 s) and the `fleet-service` consumer group's lag | `services/platform-service/src/system/health.ts`; the target URL comes from its config (`fleet-service=http://localhost:3008` by default) |
| location-service | `driver.connection_lost` (Kafka) | — |
| Anyone | `GET /internal/drivers/:userId/session` | No caller found in the repo |

## Kong

`infra/kong/kong.yml` (DB-less):

```yaml
- name: fleet-service
  url: http://fleet-service:3008
  routes:
    - name: fleet-routes
      paths: ["/api/fleet"]
      strip_path: false
  plugins:
    - name: rate-limiting
      config: { minute: 120, policy: local }
```

- One route for the whole prefix, path kept as is. `/internal/*` and `/health*` are not routed.
- Kong does not verify JWTs; fleet-service does.
- No `request-size-limiting` plugin on this service (unlike auth-service and notification-service). The service's own body limits apply (32 KB; 10 MB on the local file route).
- With local storage behind Kong (`make dev-gateway`), the relative upload/view URLs `/api/fleet/files/…` go through the same route. `infra/kong/kong.dev.yml` is generated from `kong.yml` by `scripts/kong-dev-config.sh` with `host.docker.internal` upstreams (git-ignored).

## Sequence: driver onboarding → approval → DRIVER role

```mermaid
sequenceDiagram
  autonumber
  participant D as Phone app (rider token)
  participant F as fleet-service
  participant S as Object storage
  participant O as Onboarding officer (web, ride-admin token)
  participant A as auth-service
  participant K as Kafka
  D->>F: POST /api/fleet/drivers/apply {fullName, licenseNumber, cityId}
  F->>F: driver:apply @ SELF, normalise licence, blind-index check
  F->>F: INSERT driver_profile APPLIED + outbox driver.applied
  F-->>D: 201 driver
  Note over D,S: three uploads (LICENSE, NATIONAL_ID, PHOTO), see next diagram
  opt owner-driver
    D->>F: POST /api/fleet/vehicles {ownerType: INDIVIDUAL, …}
    Note over D,F: + REGISTRATION, INSURANCE, INSPECTION uploads, then POST /vehicles/:id/submit
  end
  D->>F: POST /api/fleet/drivers/me/submit
  F->>F: missingForSubmit = [] → PENDING_REVIEW + driver.submitted
  O->>F: GET /api/fleet/review/queue?cityId=
  O->>F: GET /api/fleet/documents/:id/url
  F->>F: outbox audit.recorded (document:view)
  O->>S: GET pre-signed URL
  O->>F: POST /api/fleet/documents/:id/review {APPROVE} (× 3)
  O->>F: POST /api/fleet/drivers/:userId/approve
  F->>F: driver:verify + driver:activate @ CITY
  rect rgb(240,240,240)
    Note over F,A: one database transaction (15 s timeout)
    F->>F: driver_profile ACTIVE; outbox driver.activated + audit.recorded
    F->>A: POST /internal/drivers/:userId/role {active: true}
    A->>A: user.role += driver, permissionVersion++, pv:{userId} in Redis, outbox role.granted
    A-->>F: 200
  end
  F-->>O: 200 driver ACTIVE
  F->>K: relay: driver.activated, audit.recorded
  Note over D: the app's next token refresh carries DRIVER (older tokens get 401 token_outdated)
```

If auth-service fails at step "POST /internal/drivers/…/role", the transaction rolls back, the profile stays `PENDING_REVIEW` and the officer gets `503 dependency_unavailable` (covered by `tests/integration/fleet.test.ts`).

## Sequence: document upload

```mermaid
sequenceDiagram
  autonumber
  participant C as Client (phone app or web)
  participant F as fleet-service
  participant S as Object storage (S3, or fleet-service /api/fleet/files locally)
  C->>C: compute SHA-256 and size
  C->>F: POST /api/fleet/documents/upload-url {subjectType, subjectId, kind, contentType, sizeBytes, sha256}
  F->>F: kind belongs to subject, ≤ 10 MB, uploadScope() (may ask auth-service for an org)
  F->>S: presign PUT key {subject}/{id}/{kind}/{uuidv7}.{ext} (5 min)
  F-->>C: {uploadUrl, headers, ticket (15 min), expiresIn: 300}
  C->>S: PUT uploadUrl with headers, bytes
  S-->>C: 200
  C->>F: POST /api/fleet/documents {ticket, expiresAt?}
  F->>F: verify ticket (HMAC, expiry, same user), expiry date rules
  F->>S: HEAD object → size (+ SHA-256 when local)
  F->>F: transaction: older docs of this kind → SUPERSEDED; INSERT document PENDING
  F-->>C: 201 document
```

## Sequence: going online

```mermaid
sequenceDiagram
  autonumber
  participant D as Phone app (driver token)
  participant F as fleet-service
  participant P as payment-service
  participant DB as Postgres
  participant K as Kafka
  participant L as location-service
  D->>F: POST /api/fleet/sessions {vehicleId} + Idempotency-Key
  F->>DB: idempotency_key INSERT (IN_PROGRESS) or replay stored response
  F->>DB: load driver_profile, vehicle, open session of this driver
  alt already online with this vehicle
    F-->>D: 201 existing session
  else
    F->>DB: current LICENSE, other open session on the vehicle, authorisation (fleet car)
    F->>F: driveDenial(): ACTIVE → licence valid → VERIFIED → V6 / V7 → V4
    F->>P: GET /internal/balances/state (2 s)
    P-->>F: {state, cashAllowed} (or failure → treated as OK)
    alt state = BLOCKED
      F-->>D: 403 balance_blocked
    else
      F->>DB: BEGIN; INSERT driving_session; outbox driver.online; COMMIT
      Note over DB: ux_session_vehicle_active / ux_session_driver_active settle races → 409 vehicle_in_use
      F->>DB: idempotency_key DONE (201, body)
      F-->>D: 201 session
      F->>K: relay: driver.online {driverId, vehicleId, vehicleType, cityId, fleetOrgId?, beneficiaryId, balanceState, cashAllowed}
      K->>L: driver.online → Redis driver state (available for matching once pings arrive)
    end
  end
```

Going offline is the mirror: `DELETE /api/fleet/sessions/current` → `ended_at`, `end_reason = DRIVER` and `driver.offline` in one transaction → location-service removes the driver from the geo sets. When location-service sees no ping for 10 minutes outside a trip, it publishes `driver.connection_lost` and fleet-service ends the session with `CONNECTION_LOST`.
