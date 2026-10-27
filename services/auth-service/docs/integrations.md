# Integrations

How auth-service talks to the rest of the platform. Route details are in [api.md](api.md), events in [events.md](events.md).

## Services auth-service calls

| Target | Call | Auth | Timeout | Failure behaviour | Code |
|---|---|---|---|---|---|
| notification-service | `POST {NOTIFICATION_INTERNAL_URL}/internal/otp-deliveries` body `{ phoneNumber, code, ttlSeconds: 300, purpose: "sign_in" }` | `Authorization: Bearer $INTERNAL_SERVICE_TOKEN` | 2 s | Not awaited by `send-otp` (the client gets its answer regardless). Non-2xx or network error is logged with a masked phone; never retried by auth-service. The user just doesn't get a code and asks again | `src/auth/otp-delivery.ts` |
| notification-service | `POST /internal/otp-deliveries/verified` body `{ phoneNumber }` | same | 2 s | Best effort after a successful verify; failure only logged | same |

Only with `OTP_DELIVERY=notification`. With `console`, codes are logged instead (development only). The `purpose` values `phone_change` and `claim_guest` exist in the type but nothing sends them.

auth-service makes no other outbound HTTP calls. It verifies its own JWTs in process (`src/http/principal.ts` reads Better Auth's key set directly), so `AUTH_INTERNAL_URL` is not used.

## Who calls auth-service

| Caller | What | Code in the caller |
|---|---|---|
| Phone app | `/api/auth/*`: OTP sign-in, `/token`, sessions, profile; `/api/identity/me`, `/cities` | `apps/phone-app` |
| Web app — staff dashboard | `/api/admin-auth/*` (password, TOTP, `/token`); `/api/identity/*` (approvals, users, roles/matrix, stats, organisations, suspension) | `apps/web/src/pages/admin/*`, `apps/web/src/lib/session.tsx` |
| Web app — fleet and corporate portals | `/api/auth/*` (phone OTP, organisations, invitations), `/api/identity/authz` | `apps/web` |
| fleet-service | `GET /internal/organizations/:id`, `GET /internal/organizations/:id/members/:userId`, `POST /internal/drivers/:userId/role`. 3 s timeout; 404 → `null`; other errors → 503 `dependency_unavailable`. The driver-role call runs inside fleet-service's transaction, so a failure there rolls back the activation | `services/fleet-service/src/lib/clients.ts` |
| fleet-service `seed:dev` | `GET /api/dev/accounts` | `services/fleet-service/src/dev/seed.ts` |
| trip-service | `GET /internal/users/:id` for `GET /api/trips/:id/parties`; 404 → `null` | `services/trip-service/src/lib/clients.ts` |
| platform-service | `PUT /internal/cities/:id` when a city is created or changed (3 s timeout; failure → 503 to its caller, "try again"); `GET /internal/ops/outbox` for the system page | `services/platform-service/src/lib/identity.ts`, `src/system/health.ts` |
| Every service with `createAuthzSync` (audit, fleet, location, notification, payment, platform, trip, realtime-gateway) | `GET /internal/authz/snapshot` at start, on `authz:changed`, every 30 s; 3 s timeout. Unreachable → keeps the current (at start: built-in) matrix and logs a warning | `libs/shared-authz/src/sync.ts` |
| Every token verifier | `GET /api/auth/jwks` (`AUTH_JWKS_URL`), cached by `jose`'s remote key set; plus Redis `deny:*`, `pv:*` | `libs/shared-authz/src/verify.ts` |

## Kafka summary

| Direction | Topics |
|---|---|
| Out (outbox relay) | `user.created`, `user.claimed`, `user.suspended`, `user.reinstated`, `role.granted`, `role.revoked`, `org.created`, `org.verified`, `org.suspended`, `org.member_invited`, `audit.recorded` |
| In | none |

## Redis

| Use | Keys / channel |
|---|---|
| Better Auth sessions + rate limits | `ba:*` |
| Suspension denylist | `deny:{userId}` |
| Permission versions | `pv:{userId}` |
| Matrix changes | publish and subscribe `authz:changed` |

Redis is shared with the other services (they read `deny:*`, `pv:*` and subscribe to `authz:changed`).

## External providers

None called directly. SMS and Telegram Gateway delivery of OTP codes happens in notification-service ([Auth.md §9.7](../../../docs/design/Auth.md#97-otp-delivery-telegram-gateway-first-sms-fallback)). TOTP is computed locally by Better Auth's two-factor plugin. Better Auth telemetry is disabled (`telemetry: { enabled: false }`).

## Kong

From `infra/kong/kong.yml` (`kong.dev.yml` is generated from it and points at `host.docker.internal:3001`):

| Route name | Path | `strip_path` |
|---|---|---|
| `app-auth-routes` | `/api/auth` | false |
| `admin-auth-routes` | `/api/admin-auth` | false |
| `identity-routes` | `/api/identity` | false |

Service plugins: `rate-limiting` 60/minute (`policy: local`), `request-size-limiting` 64 KB. Kong does not verify JWTs. `/internal/*`, `/api/dev/*` and `/health*` have no Kong route.

## Key flows

### 1. Rider phone sign-in

```mermaid
sequenceDiagram
  autonumber
  participant A as Phone app
  participant K as Kong
  participant BA as auth-service (app surface)
  participant DB as Postgres
  participant N as notification-service
  participant O as Outbox relay → Kafka
  A->>K: POST /api/auth/phone-number/send-otp {phoneNumber}
  K->>BA: (60/min)
  BA->>BA: allowlist, +251[79]… check, rate limit 3/60 s
  BA->>DB: verification row (code, 5 min)
  BA--)N: POST /internal/otp-deliveries {phone, code, ttl 300} (not awaited, 2 s timeout)
  BA-->>A: 200
  N-->>A: code by Telegram or SMS
  A->>BA: POST /api/auth/phone-number/verify {phoneNumber, code}
  BA->>DB: check code (3 attempts); new number → app_user (role rider) + session
  BA->>DB: outbox user.created (new) or user.claimed (guest) 
  BA--)N: POST /internal/otp-deliveries/verified (best effort)
  BA-->>A: 200, header set-auth-token: <session>
  A->>BA: GET /api/auth/token (Bearer session)
  BA->>DB: fresh user + memberships → claims
  BA-->>A: {token: ES256 JWT, aud=ride-app, 15 min}
  O->>DB: poll outbox (500 ms)
  O-->>O: publish user.created
```

### 2. Staff role grant (maker–checker)

```mermaid
sequenceDiagram
  autonumber
  participant M as Super admin A (maker)
  participant C as Super admin B (checker)
  participant ID as auth-service /api/identity
  participant DB as Postgres
  participant R as Redis
  participant S as Any service
  M->>ID: POST /staff-role-requests {userId, role: DISPATCHER, cityId, reason}
  ID->>ID: authorize role:request; role grantable; city has a staff org
  ID->>DB: approval_request PENDING (+7 days) + audit role:grant:request
  ID-->>M: 201 approval row
  C->>ID: POST /approvals/:id/approve
  ID->>DB: BEGIN; SELECT … FOR UPDATE; authorize role:approve; checker ≠ maker
  ID->>DB: member row in staff-addis-ababa += dispatcher; permission_version+1
  ID->>DB: outbox role.granted + audit role:grant:approve; status EXECUTED; COMMIT
  ID->>R: SET pv:{userId} (24 h)
  ID-->>C: {userId, role, cityId, permissionVersion}
  Note over S: the user's old JWT now fails with token_outdated
  S->>R: GET pv:{userId}
  Note over M,S: user calls GET /api/admin-auth/token → new JWT with {r: DISPATCHER, city: addis-ababa}
```

### 3. Permission-matrix change, live in every service

```mermaid
sequenceDiagram
  autonumber
  participant A as Super admin A
  participant B as Super admin B
  participant AU as auth-service
  participant DB as Postgres
  participant R as Redis
  participant S as Other service
  A->>AU: POST /api/identity/authz/changes {roleCode, set, reason}
  AU->>DB: guardrails on current snapshot; no pending change for roleCode
  AU->>DB: approval_request authz:change PENDING
  B->>AU: POST /api/identity/approvals/:id/approve
  AU->>DB: BEGIN; re-check guardrails; upsert/delete role_permission; authz_version+1; audit; COMMIT
  AU->>AU: setAuthzSnapshot (this replica)
  AU->>R: PUBLISH authz:changed "<version>"
  R-->>S: message
  S->>AU: GET /internal/authz/snapshot (service token)
  AU-->>S: {version, roles, matrix}
  Note over S: missed message → 30 s poll picks it up
```

### Driver activation (fleet-service → auth-service)

fleet-service calls `POST /internal/drivers/:userId/role {active: true}` inside its own transaction. auth-service adds `driver` to `app_user.role`, bumps `pv`, writes `role.granted {role: "DRIVER"}` (notification-service pushes "driver activated"), and sets `pv:{userId}`. The driver's next `/token` includes `{ r: "DRIVER" }`.
