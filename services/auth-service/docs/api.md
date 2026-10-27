# HTTP API

Every route auth-service serves. Port 3001. Kong routes `/api/auth`, `/api/admin-auth` and `/api/identity` with `strip_path: false`; `/internal/*` and `/api/dev/*` are never routed by Kong ([integrations.md](integrations.md#kong)).

No WebSocket or socket events.

## Conventions

**Error body** (our routes, `src/middlewares/error-handler.ts`):

```json
{ "error": "<code>", "message": "<text>" }
```

| Status | `error` | When |
|---|---|---|
| 400 | `validation_error` (+ `issues: [{ path, message }]`) | Zod rejected params, query or body |
| 400 | `bad_request`, `guardrail` | Domain checks (`guardrail`: a permission-matrix change breaks a rule; `message` lists every problem, joined with `; `) |
| 401 | `unauthorized` | No bearer token / wrong service token |
| 401 | `invalid_token` | Bad signature, issuer, audience, or expired |
| 401 | `token_revoked` | User is on the Redis denylist (suspended) |
| 401 | `token_outdated` | Token `pv` older than Redis `pv:{userId}`: get a new token |
| 403 | `forbidden` | Missing permission (`missing permission <p> for this resource`) or a domain refusal |
| 403 | `maker_is_checker` | Approving/rejecting your own request |
| 404 | `not_found` | Unknown resource or route |
| 409 | `conflict`, `not_pending`, `expired`, `change_pending` | State conflicts |
| 4xx | Fastify's code | Other client errors from Fastify (e.g. body too large, rate limit) |
| 503 | `auth_unavailable` | `TokenCheckUnavailable` is mapped (503, `retry-after: 5`) but can't occur here: auth-service's own `SecuritySignals` lookups catch Redis errors and fall back (not denied, version unknown) |
| 500 | `internal_error` | Anything else (logged with the request id, details never returned) |

Better Auth routes answer with **Better Auth's own error bodies**, except the 404 from the allowlist and the 400 for `updatePhoneNumber`, which use the format above.

**Tokens.** "admin JWT" = a `GET /api/admin-auth/token` JWT (`aud=ride-admin`). "app JWT" = a `GET /api/auth/token` JWT (`aud=ride-app`). Permissions are checked with `shared-authz` `authorize()`; `perm @ C(cityId)` means the permission must be granted in the city given in the request.

**Common types.** `uuid` = UUID string. `reason` = string, trimmed, 10–500 characters. `cityId` = string, trimmed, 1–64 characters.

## Rate limits

| Layer | Limit | Applies to |
|---|---|---|
| Kong (`infra/kong/kong.yml`) | 60 requests/minute, `policy: local`; payload ≤ 64 KB | everything routed to auth-service |
| Fastify `@fastify/rate-limit` (`src/app.ts`) | 300/minute per client IP, in-process memory store | every route except the Better Auth mounts (so `/api/identity`, `/internal`, `/api/dev`, `/health*`) |
| Better Auth (`src/auth/instances.ts`) | default 60 per 60 s per endpoint; `/phone-number/send-otp` 3/60 s; `/phone-number/verify` 5/60 s; `/sign-in/email` 5/60 s; `/two-factor/verify-totp` 5/60 s; `/token` 30/60 s | Better Auth routes. Stored in Redis secondary storage when `REDIS_URL` is set, else memory. Off with `AUTH_RATE_LIMIT=off` (refused in production). How Better Auth keys the counters (IP + path) is Better Auth behaviour, not code in this repo |

`trustProxy: true`, and Better Auth reads the client IP from `x-forwarded-for`.

---

## Health

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/health` | none | `200 { "status": "ok" }` (process is up; used by the Dockerfile `HEALTHCHECK`) |
| GET | `/health/live` | none | `200 { "status": "ok" }` |
| GET | `/health/ready` | none | `200 { "status": "ok" }` after `SELECT 1` on Postgres, else `503 { "status": "unavailable" }`. Redis and Kafka are not checked |

---

## Better Auth: app surface `/api/auth/*`

Better Auth instance `createAppAuth` (`src/auth/instances.ts`). Clients: phone app (bearer session) and the web app's fleet and corporate portals (cookies, origin in `APP_TRUSTED_ORIGINS`). Sessions last 30 days and are refreshed daily (`updateAge` 1 day). Only these endpoints are served (`src/auth/allowlist.ts`); request and response bodies are Better Auth 1.7.13's own (see the Better Auth docs) unless noted.

| Method | Path | Notes |
|---|---|---|
| GET | `/ok` | Better Auth liveness |
| POST | `/phone-number/send-otp` | Body `{ phoneNumber }`. Must match `^\+251[79]\d{8}$`. Generates a 6-digit code (5 min, 3 attempts) and hands it to the OTP sender without awaiting it. Rate limit 3/60 s |
| POST | `/phone-number/verify` | Body `{ phoneNumber, code }`. Signs in or signs up (new users get name = phone, email = `<digits>@phone.anbessa.invalid`). `updatePhoneNumber` in the body → **400** `bad_request`. On success: a call-center guest is claimed (`account_status` → `ACTIVE`, `user.claimed` event); the placeholder email is marked verified; notification-service is told the code was verified (best effort). The session token comes back in the `set-auth-token` response header (bearer plugin; the integration tests read it there). Rate limit 5/60 s |
| GET | `/token` | Mints an app JWT (ES256, 15 min, `aud=ride-app`) → `{ token }`. **403** if the session belongs to the admin surface or the user is banned; **401** if the user no longer exists. Rate limit 30/60 s |
| GET | `/jwks` | Public JWKS (both surfaces share it). Every verifier uses this URL |
| GET | `/get-session` | Current session and user |
| POST | `/sign-out` | |
| GET | `/list-sessions` | |
| POST | `/revoke-session` | |
| POST | `/revoke-other-sessions` | |
| POST | `/update-user` | Only `input: true` fields (`name`, `image`). `accountStatus`, `permissionVersion`, `mustChangePassword`, `role` are not writable. `image` must be `data:image/jpeg;base64,…` of at most 48 KB + 32 characters, else 400 |
| POST | `/organization/create` | Self-service FLEET or CORPORATE organisation. Extra fields: `kind` (`FLEET`/`CORPORATE`, anything else **403**), `cityId` (must exist), `legalName` (required), `tin` (exactly 10 digits, unique per kind). `status` is forced to `PENDING`. Banned or non-`ACTIVE` users: **403**. The creator becomes `fleet_owner`, or `corporate_admin` for CORPORATE. Events: `org.created`, `role.granted`, `audit.recorded` |
| GET, POST | `/organization/check-slug` | |
| GET | `/organization/list` | |
| GET | `/organization/get-full-organization` | |
| POST | `/organization/set-active` | |
| POST | `/organization/update` | `kind`, `cityId`, `tin`, `status`, `legalName` can't be changed (**403**) |
| GET | `/organization/get-active-member` | |
| GET | `/organization/list-members` | |
| POST | `/organization/invite-member` | Organisation must be `VERIFIED` (**403** otherwise). Role must be allowed for the org kind (**400**). Invite by phone: `email = <digits>@phone.anbessa.invalid`. Event `org.member_invited` (notification-service sends the SMS). Invitations expire after 7 days |
| POST | `/organization/cancel-invitation` | |
| GET | `/organization/get-invitation` | |
| GET | `/organization/list-invitations` | |
| GET | `/organization/list-user-invitations` | Needs a verified email; phone users get it on OTP verification |
| POST | `/organization/accept-invitation` | Refused (**403**) if the organisation is `SUSPENDED`. Event `role.granted` per role |
| POST | `/organization/reject-invitation` | |
| POST | `/organization/remove-member` | Event `role.revoked` per role, `pv` bump |
| POST | `/organization/update-member-role` | Role must be allowed for the org kind; `pv` bump. No event |
| POST | `/organization/has-permission` | |

Every `/organization/*` call that names a staff organisation (`organizationId` or `organizationSlug` in body or query, kind `STAFF_CITY`/`STAFF_HQ`) answers **404**. Organisation hooks also refuse every membership, role, removal and invitation change on staff organisations (**403**). Membership limit 5000 per organisation; organisation deletion disabled.

Everything else under `/api/auth/*` (sign-up, email sign-in, social, `/organization/leave`, `/organization/delete`, `/admin/*`, …) answers **404** `{ "error": "not_found" }`.

## Better Auth: admin surface `/api/admin-auth/*`

Instance `createAdminAuth`. Client: the staff dashboard (cookies, origin in `ADMIN_TRUSTED_ORIGINS`). Sessions last 12 h, refreshed hourly. Sign-up is disabled: staff accounts come from `POST /api/identity/staff-accounts` or the bootstrap CLI.

| Method | Path | Notes |
|---|---|---|
| GET | `/ok` | |
| POST | `/sign-in/email` | Body `{ email, password }`. Password 12–128 characters, argon2id. Rate limit 5/60 s. Each new admin session writes an `audit.recorded` `staff:sign_in` (reason: IP · user agent ≤ 120 chars) |
| POST | `/sign-out` | |
| GET | `/get-session` | |
| GET | `/list-sessions` | |
| POST | `/revoke-session` | |
| POST | `/revoke-other-sessions` | |
| POST | `/change-password` | The first change clears `mustChangePassword` |
| POST | `/update-user` | "My account" in the staff dashboard. Only `input: true` fields (`name`, `image`); `image` is checked by the shared user hook (as on the app surface) |
| GET | `/token` | Admin JWT (ES256, 10 min, `aud=ride-admin`) → `{ token }`. Roles only if 2FA is enabled and the password was changed; otherwise `roles: []` and `setup: { twoFactor, changePassword }`. **403** for app sessions and banned users |
| POST | `/two-factor/enable` | Returns `totpURI` (and backup codes) |
| POST | `/two-factor/get-totp-uri` | |
| POST | `/two-factor/verify-totp` | Rate limit 5/60 s |
| POST | `/two-factor/verify-backup-code` | |
| POST | `/two-factor/generate-backup-codes` | |

`/two-factor/disable`, `/admin/*`, sign-up and everything else: **404**.

### JWT claims

| Claim | App | Admin |
|---|---|---|
| `iss` | `AUTH_ISSUER` (defaults to `AUTH_BASE_URL`) | same |
| `aud` | `ride-app` | `ride-admin` |
| `sub` | user id | user id |
| `exp` | +15 min | +10 min |
| `roles` | `[{ r }]` (SELF), `[{ r, org }]` (ORG) | `[{ r, g: true }]` (GLOBAL), `[{ r, city }]` (CITY) |
| `pv` | `app_user.permission_version` | same |
| `amr` | `["otp"]` | `["pwd","otp"]` with 2FA, else `["pwd"]` |
| `setup` | — | `{ twoFactor, changePassword }` while setup is incomplete |

Roles are filtered to the token's audience (`roleInfo(role).audience`). Unknown and archived roles are dropped (`src/auth/roles-codec.ts`).

---

## Identity API `/api/identity/*`

Defined in `src/http/identity.routes.ts`, logic in `src/identity/service.ts`, `src/identity/approvals.ts`, `src/authz/service.ts`. All need `Authorization: Bearer <JWT>`. Unless noted, the token must be an **admin JWT**.

Which built-in roles hold a permission is defined in `libs/shared-authz/src/matrix.ts` and can be changed live ([Role.md §8](../../../docs/design/Role.md#8-role--permission-matrix)). Notes like "(SUPER_ADMIN)" below are the built-in defaults at the time of writing.

### Session info

| Method + path | Caller | Request | Response |
|---|---|---|---|
| `GET /me` | app **or** admin JWT; header `x-auth-surface: admin` selects the admin audience, anything else the app audience | — | `{ userId, audience, roles: RoleAssignment[], permissionVersion }` |
| `GET /cities` | app or admin JWT (same header rule) | — | `[{ id, name, timezone }]` ordered by name |

### Call center

**`POST /guests`** — `user:create_guest @ C(cityId)` (CALL_CENTER_AGENT).

| Field | Type | Rule |
|---|---|---|
| `phoneNumber` | string | must match `^\+251[79]\d{8}$` (else 400 `bad_request`) |
| `cityId` | cityId | used for the permission check only |

- New number: creates a user (`account_status = GUEST`, role `rider`, name = phone, placeholder email). **201** `{ userId, created: true, accountStatus: "GUEST" }`. Events `user.created { guest: true }`, `audit.recorded user:create_guest`.
- Known number: **200** `{ userId, created: false, accountStatus }`. No event.

### Staff accounts and roles (maker–checker)

**`POST /staff-accounts`** — `staff:manage` (SUPER_ADMIN, `G`).

| Field | Type | Rule |
|---|---|---|
| `email` | string | email; lowercased |
| `name` | string | trimmed, 2–120 |

**201** `{ userId, email, temporaryPassword }` with `cache-control: no-store`. The password is shown once. The account has no roles and `mustChangePassword = true`. 409 if the email exists. Events `user.created`, `audit.recorded staff:create_account`.

**`POST /staff-role-requests`** — maker; `role:request` (SUPER_ADMIN).

| Field | Type | Rule |
|---|---|---|
| `userId` | uuid | must exist (404), not banned (409), have a `credential` account (400) |
| `role` | string | a staff role code (built-in or `CUSTOM_…`), not archived, audience `ride-admin` (else 400 `not a grantable staff role`) |
| `cityId` | cityId, optional | required for city-scoped roles (member storage), refused for global ones; the city must have a staff organisation |
| `reason` | reason | |

409 if the user already holds the role in that scope, or an identical request is pending. **201** with the `approval_request` row (`{ id, action: "role:grant", payload: { userId, role, cityId }, reason, makerId, checkerId: null, status: "PENDING", decisionReason: null, createdAt, decidedAt: null, expiresAt }`). Expires after 7 days. Event `audit.recorded role:grant:request` (`PENDING_APPROVAL`).

**`GET /staff-role-requests?status=`** — anyone who may request or approve `role:grant`. `status` ∈ `PENDING, EXECUTED, REJECTED, EXPIRED, CANCELLED, FAILED`. Returns an array of approval rows, newest first, at most 100. 403 if the caller can see no approval action.

**`POST /staff-role-requests/:id/approve`** — checker; `role:approve`, must not be the maker. Body `{ reason?: string ≤ 500 }` (optional). Executes the grant in the same transaction: adds the stored role to `app_user.role` (global) or to the membership in the city's staff organisation (created if missing), bumps `pv`, writes `role.granted { userId, role, cityId?, byUserId }` and audit `role:grant:approve`. After commit: `pv:{userId}`. Response `{ userId, role, cityId, permissionVersion }`. Errors: 404 unknown request, 409 `not_pending`, 409 `expired`, 403 `maker_is_checker`, 409 if the target is missing or banned.

**`POST /staff-role-requests/:id/reject`** — `role:approve`, not the maker. Body `{ reason }` (required). → `{ id, status: "REJECTED" }`. Audit `role:grant:reject`.

**`POST /staff-roles/revoke`** — `staff:manage`. Immediate, no approval.

| Field | Type | Rule |
|---|---|---|
| `userId` | uuid | must exist |
| `role` | string | a staff role code (audience `ride-admin`) |
| `cityId` | cityId, optional | required for city-scoped roles; the membership must exist (404). Removing the last role deletes the membership |
| `reason` | reason | |

Revoking `SUPER_ADMIN` is refused (409) when two or fewer non-banned super admins exist. → `{ userId, permissionVersion }`. Events `role.revoked`, audit `role:revoke`. After commit `pv:{userId}`.

### Approvals inbox (every action)

Actions: `role:grant` (request `role:request`, approve `role:approve`), `staff:reset_mfa` (`staff:manage` both), `authz:change` (request `authz:propose`, approve `authz:approve`).

| Method + path | Caller | Request | Response |
|---|---|---|---|
| `GET /approvals` | sees the actions they may request or approve somewhere; 403 if none. Per action: global holders see every request; city-scoped holders see only requests whose `cityId` is one of their cities (requests without a city are platform-wide and need a global grant) | query `status?` (as above), `action?` (≤ 40 chars), `limit` 1–200, default 100 | `{ approvals: ApprovalRow[] }` newest first |
| `POST /approvals/:id/approve` | the action's approve permission **in the request's city** (`cityId`; none = a global grant); not the maker | body `{ reason?: ≤ 500 }` | the executor's result: `role:grant` as above; `staff:reset_mfa` → `{ userId, temporaryPassword }`; `authz:change` → `{ roleCode, version }` |
| `POST /approvals/:id/reject` | approve permission in the request's city; not the maker | body `{ reason }` | `{ id, status: "REJECTED" }` |
| `POST /approvals/:id/cancel` | only the maker | — | `{ id, status: "CANCELLED" }` |

Errors as for staff-role approvals. **City-aware (phase 2D):** each request may carry `cityId` (`approval_request.city_id`): a `role:grant` of a city-scoped role carries that city, and `POST /staff-role-requests` checks `role:request` in that city (global roles: a global grant). So a city-scoped holder (e.g. a custom city role holding `role:request`/`role:approve` at C) asks, sees and decides only its own city's requests; maker ≠ checker still holds. `staff:reset_mfa` and `authz:change` have no city (global holders only). `ApprovalRow` gains `cityId`.

### Permission matrix

**`GET /authz`** — any valid admin **or** app JWT. Response: the snapshot `{ version, roles: RoleInfo[], matrix: { [roleCode]: { [permission]: "S"|"O"|"C"|"G" } } }`. `RoleInfo` = `{ code, label, description?, audience, storage: { type: "user" } | { type: "member", orgKinds }, stored, builtIn, archived? }`.

**Change body** (shared by `/authz/changes` and `/authz/preview`):

| Field | Type | Rule |
|---|---|---|
| `roleCode` | string ≤ 60 | the role to change; ignored when `create` is set (code becomes `CUSTOM_<LABEL>`); required by `/preview` |
| `create` | `{ label: 3–60, description?: ≤ 300, storage: "city" \| "global" }` | creates a custom staff role |
| `set` | array ≤ 150 of `{ permission: ≤ 60, scope: "S"\|"O"\|"C"\|"G"\|null }`, default `[]` | `null` removes the grant |
| `label` | 3–60 | rename |
| `description` | ≤ 300 | |
| `archive` | boolean | |
| `reason` | reason | `/changes` only |

Guardrails (`src/authz/guardrails.ts`), checked when proposing **and** again at execution:

- unknown permission; staff roles only `C`/`G`; app roles only `S`/`O`; city roles can't have `G`;
- one role can't hold both halves of a maker–checker pair (`refund:request`/`refund:approve`, `payout:prepare`/`payout:approve`, `pricing:*`, `incentive:*`, `topup:record_cash`/`topup:approve_cash`, `adjustment:*`, `writeoff:*`, `commission_rule:*`, `balance_policy:*`, `policy_override:*`); `role:*`, `authz:*` and `settings:*` pairs are exempt (checked by user id instead);
- `SUPER_ADMIN` must keep `staff:manage`, `role:request`, `role:approve`, `authz:read`, `authz:propose`, `authz:approve`;
- `org:manage_members` on partner (app-audience) roles can't change live;
- custom roles: code `CUSTOM_[A-Z0-9_]{2,40}`, unique code and label; built-in roles can't be archived; a role still held by anyone can't be archived; archived roles can't be changed;
- an empty change is refused.

| Method + path | Caller | Response |
|---|---|---|
| `POST /authz/changes` | `authz:propose` (SUPER_ADMIN) | **201** approval row (`action: "authz:change"`). 400 `guardrail`, 409 `change_pending` if another change to that role is pending |
| `POST /authz/preview` | `authz:read` (SUPER_ADMIN, AUDITOR) | `{ problems: string[] }` (dry run; doesn't count role holders for `archive`) |

On approval the executor writes the rows, bumps `authz_version`, audits `authz:change` (reason `v<N>: <summary>`), then swaps this process's registry and publishes `authz:changed` on Redis.

### Directory, sessions, MFA

**`GET /users`** — `user:read_masked` in **any** city (`authorizeDirectory` in `src/identity/service.ts`: users aren't bound to a city, so a city-scoped grant opens the masked directory; dispatchers, onboarding, support, operations, marketing and analysts hold it city-scoped). Phones are unmasked only with `user:read_pii` held globally (no city is passed).

| Query | Type | Meaning |
|---|---|---|
| `q` | ≤ 80 | name/email contains (case-insensitive); phone contains the last 9 digits when ≥ 4 digits are given; exact id when it looks like a UUID |
| `kind` | `staff` \| `rider` \| `driver` \| `partner` \| `guest` | staff = has a credential account; rider = role `rider` and not GUEST; driver = role `driver`; partner = member of a FLEET/CORPORATE org; guest = `account_status = GUEST` |
| `status` | `active` \| `suspended` | by `banned` |
| `cursor` | uuid | id of the last row of the previous page |
| `limit` | 1–100, default 50 | |

Response `{ users: [{ id, name, staff, email (staff only, else null), phone (masked unless PII), roles: [{ role, scope, orgId?, cityId?, label }], status ("SUSPENDED" or account_status), twoFactorEnabled, createdAt, lastSignInAt }], next }`. Ordered by `createdAt desc, id desc`. `next` is the last id when the page is full, else `null`.

**`GET /users/:id`** — `user:read_masked` in any city (as `GET /users`). `cache-control: no-store`. Response: as above plus `banReason`, `banExpires`, `mustChangePassword`, `permissionVersion`, `memberships: [{ organizationId, organizationName, kind, cityId, status, roles, since }]`, `sessions` (latest 50: `{ id, surface, ipAddress, userAgent, createdAt, lastActiveAt, expiresAt, active }`). `ipAddress` and `userAgent` are `null` unless the caller reads the directory globally or holds `user:read_pii`. Writes (suspend, reinstate, sign out, MFA reset) keep their own scopes. 404 if unknown.

**`POST /users/:id/sessions/revoke`** — `session:revoke` (SUPER_ADMIN). Body `{ reason }`. Bumps `pv`, deletes every session, sets `pv:{userId}`. → `{ userId, revoked: true }`. Audit `session:revoke`.

**`POST /users/:id/reset-mfa`** — `staff:manage`. Body `{ reason }`. `cache-control: no-store`. Not yourself (403); target must have a credential account (400).
- Target is a super admin: creates a `staff:reset_mfa` approval → `{ userId, pendingApproval: <approvalId> }`.
- Otherwise at once: new temporary password, 2FA removed, `mustChangePassword = true`, `pv` bump, sessions deleted → `{ userId, temporaryPassword }`. Audit `staff:reset_mfa`.

**`GET /stats?cityId=`** — without `cityId`: a global `report:read`; with `cityId`: `report:read @ C(cityId)`. With a city, `staff`, `staffWithoutMfa`, `activeSessions.admin` and `organizations` count only that city (staff = members of that city's `STAFF_CITY` org); the account counts (`users`, `riders`, `drivers`, `guests`, `suspended`, sign-ups, `activeSessions.app`) stay platform-wide because users aren't bound to a city. Response `{ cityId (or null), users, staff, riders, drivers, guests, suspended, signups24h, signups7d, activeSessions: { app, admin }, staffWithoutMfa, organizations: [{ kind, status, count }] }`.

### Safety

**`POST /users/:id/suspend`**

| Field | Type | Rule |
|---|---|---|
| `reason` | reason | stored as `ban_reason` |
| `cityId` | cityId | city where the case is handled (permission check, caller-asserted) |
| `until` | date (coerced), optional | stored as `ban_expires` |

Authorization: staff target → `staff:manage`; anyone else → `user:suspend @ C(cityId)` (SAFETY_OFFICER). Not yourself (403). A super admin can't be suspended when two or fewer non-banned super admins remain (409). 404 if the user doesn't exist. Sets `banned = true` (account_status is unchanged), bumps `pv`, events `user.suspended { userId, until, byUserId }` + audit. After commit: all sessions deleted, `deny:{userId}`, `pv:{userId}`. → `{ userId, suspended: true }`.

**`POST /users/:id/reinstate`** — body `{ reason, cityId }`; staff target → `staff:manage`, else `user:reinstate @ C(cityId)`. 409 if not suspended. Clears ban fields, bumps `pv`, events `user.reinstated` + audit; after commit removes `deny:{userId}`, sets `pv`. → `{ userId, suspended: false }`.

### Partner organisations

**`GET /organizations?cityId=&status=`** — `org:read` **or** `org:suspend` (safety and finance officers may suspend a company without holding `org:read`, so they can find it). `cityId` optional: with it, either permission in that city; without it, every city where the caller holds either (a global holder sees all). `status` ∈ `PENDING, VERIFIED, SUSPENDED`. FLEET and CORPORATE only, oldest first, at most 200. → `[{ id, name, kind, cityId, legalName, tin, status, createdAt, members }]`.

**`GET /organizations/:id`** — `org:read` or `org:suspend @ C(org.cityId)`. 404 for unknown ids and staff orgs. → `{ id, name, kind, cityId, legalName, tin, status, createdAt, members }`.

**`POST /organizations/:id/verify`** — `org:verify @ C(org.cityId)` (ONBOARDING_OFFICER). 404 if not a partner org; 409 unless `PENDING`. Sets `VERIFIED`, bumps `pv` of every member, events `org.verified` + audit; after commit `pv` per member. → `{ orgId, status: "VERIFIED" }`.

**`POST /organizations/:id/suspend`** — `org:suspend @ C(org.cityId)` (SAFETY_OFFICER @ C, FINANCE_OFFICER @ G). Body `{ reason }`. From `PENDING` or `VERIFIED` (409 `already_suspended` if suspended). Sets `SUSPENDED`, records the status before in `organization_suspension` (with the reason and who), bumps `pv` of every member, events `org.suspended` + audit. → `{ orgId, status: "SUSPENDED" }`.

**`POST /organizations/:id/reinstate`** (phase 2D) — `org:suspend @ C(org.cityId)`: whoever may suspend may lift it (SAFETY_OFFICER @ C, FINANCE_OFFICER @ G; the matrix has no `org:reinstate`). Body `{ reason }` (10–500). 404 if not a partner org; 409 `not_suspended`; 409 `state_changed` on a race. Restores the status from before the suspension (`VERIFIED`, or `PENDING` if it was suspended while waiting; `VERIFIED` for suspensions older than the table), closes the open `organization_suspension` row (who, when, reason), bumps `pv` of every member (their organisation roles count again), events `org.reinstated` + audit `org:reinstate`; after commit `pv` per member. → `{ orgId, status }`. Cars suspended separately in fleet-service stay suspended.

**`GET /organizations/:id/members`** (phase 2D) — `org:read` or `org:suspend @ C(org.cityId)`. 404 for unknown ids and staff orgs. `cache-control: no-store`. → `{ orgId, status, pendingInvitations, members: [{ userId, name, phone (always masked: "+25191 ••• ••44"; a name that is the phone number is masked too), roles: ["fleet_owner" | "fleet_driver" | …], since, validUntil, suspended }], suspensions: [{ id, previousStatus, reason, suspendedBy, suspendedAt, reinstatedBy, reinstatedAt, reinstateReason }] }` (up to 500 members, 20 suspensions, newest first).

---

## Internal API `/internal/*`

Service-to-service only; never routed by Kong. Every route needs `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` (401 `unauthorized` `invalid service credentials` on mismatch; 403 `internal API disabled` when the token isn't configured). Optional `x-service-name` header. The Fastify 300/min per-IP limit applies.

| Method + path | Caller (in code) | Request | Response | Notes |
|---|---|---|---|---|
| `POST /internal/drivers/:userId/role` | fleet-service (`src/lib/clients.ts`) | params `userId: uuid`; body `{ active: boolean }` | `{ userId, driver: active }` | Adds/removes `driver` on `app_user.role`. Idempotent: no change → no `pv` bump, no event. Otherwise `pv` bump, `role.granted`/`role.revoked { role: "DRIVER", byUserId: null }`, audit `driver:activate`/`driver:suspend` (reason `by <x-service-name>`). 404 unknown user |
| `GET /internal/authz/snapshot` | every service's `createAuthzSync` (`libs/shared-authz/src/sync.ts`) | — | the snapshot (as `GET /api/identity/authz`) | Polled every 30 s by each service |
| `PUT /internal/cities/:id` | platform-service (`src/lib/identity.ts`) | params `id` matching `^[a-z0-9-]{1,40}$`; body `{ name: 2–80, timezone: 3–60 }` | the `city` row `{ id, name, timezone }` | Upsert; creates the city's `STAFF_CITY` org (`Anbessa Staff — <name>`, slug `staff-<id>`, `VERIFIED`) if missing. The org name is not updated on rename |
| `GET /internal/ops/outbox` | platform-service system page (`src/system/health.ts`) | — | `{ pending: number, oldestAt: ISO string \| null }` | Unpublished outbox rows |
| `GET /internal/users/:id` | trip-service (`GET /api/trips/:id/parties`) | params `id: uuid` | `{ id, name, image }` | `image` is the profile photo data URL or null. 404 unknown |
| `GET /internal/users/:id/contact` | notification-service (`src/campaigns/contacts.ts`, SMS campaigns) | params `id: uuid` | `{ userId, phoneNumber: string \| null, email: string \| null }` | Unmasked, `cache-control: no-store`. `phoneNumber` is E.164 or null (no number on file); `email` is null for phone-only users (their stored email is the `phone.anbessa.invalid` placeholder). No locale or marketing opt-out is stored here. 404 unknown (notification-service skips the recipient as `no_phone`) |
| `GET /internal/organizations/:id` | fleet-service | params `id: uuid` | `{ id, name, kind, cityId, legalName, status }` | Any kind, including staff orgs. 404 unknown |
| `GET /internal/organizations/:id/members/:userId` | fleet-service | params `id, userId: uuid` | `{ organizationId, userId, roles: string[] (stored names), name, phoneNumber, banned }` | 404 when not a member or `valid_until` has passed. Returns the unmasked phone number |

---

## Development routes `/api/dev/*`

Mounted only when `DEV_LOGIN=on` (config refuses it in production and requires `OTP_DELIVERY=console`). No authentication.

| Method + path | Request | Response |
|---|---|---|
| `GET /api/dev/accounts` | — | `{ accounts: [...], orgs: [{ slug, id }] }`. Staff entries: `{ key, surface: "staff", name, label, email, password, userId, seeded }`; partner entries: `{ key, surface: "partner", app, name, label, phone, userId, seeded }` (from `src/dev/accounts.ts`) |
| `GET /api/dev/code?email=` | a dev staff email | `{ code }` = current TOTP of the shared dev secret; 404 `not_a_dev_account` |
| `GET /api/dev/code?phone=` | E.164 phone | `{ code }` = last console OTP for that number (≤ 5 min old); 404 `no_code_yet` |

fleet-service's own `seed:dev` reads `/api/dev/accounts`.
