# Design: authentication with Better Auth

| | |
|---|---|
| **Status** | ✅ Implemented (v1) in `services/auth-service` and `libs/shared-authz`. Phone app and dashboard screens still to do. What changed while building it: [§17](#17-implementation-notes-v1) |
| **Scope** | How Anbessa authenticates riders, drivers, partners and staff with **[Better Auth](https://better-auth.com)**: plugins, configuration, how the 18 roles and their scopes map onto Better Auth, sessions vs JWTs, verification in other services, data model, security, migration from the current auth-service |
| **Out of scope** | *What* each role may do. That stays in [Role.md](Role.md) and `libs/shared-authz` |
| **Related** | [← Design home](README.md) · [Role.md](Role.md) · [Database.md](Database.md) · [Payment.md](Payment.md) |

---

## Contents

1. [Summary](#1-summary)
2. [What Better Auth does, and what we keep](#2-what-better-auth-does-and-what-we-keep)
3. [Decisions](#3-decisions)
4. [Architecture](#4-architecture)
5. [Plugins](#5-plugins)
6. [Configuration sketch](#6-configuration-sketch)
7. [Mapping roles and scopes onto Better Auth](#7-mapping-roles-and-scopes-onto-better-auth)
8. [Sessions and tokens](#8-sessions-and-tokens)
9. [Key flows](#9-key-flows)
10. [Verifying tokens in other services](#10-verifying-tokens-in-other-services)
11. [Data model](#11-data-model)
12. [Security](#12-security)
13. [Events and audit](#13-events-and-audit)
14. [Migration from the current auth-service](#14-migration-from-the-current-auth-service)
15. [Risks and spikes](#15-risks-and-spikes)
16. [Open questions](#16-open-questions)
17. [Implementation notes (v1)](#17-implementation-notes-v1)

---

## 1. Summary

**Better Auth runs inside auth-service** (Fastify + Prisma 7 + PostgreSQL) and handles **authentication**:
- phone OTP sign-in, with codes delivered **through Telegram (Telegram Gateway API)** and SMS as the fallback,
- staff password + two-factor login,
- sessions,
- organisations, memberships and invitations,
- bans,
- issuing short-lived **JWTs** signed with keys it manages and publishes as a **JWKS**.

Every other service and the realtime gateway **verify those JWTs locally** against the JWKS, with no call to auth-service per request.

**Authorization stays ours.** Our permission matrix and scope checks (`libs/shared-authz`, [Role.md §8–9](Role.md#8-role--permission-matrix)) remain the single source of truth for what each role may do. The token's claims are built from Better Auth's data in the format Role.md defines.

```mermaid
flowchart LR
  App["📱 Phone app"] -->|"phone OTP → session (bearer)"| BA
  Admin["🛠 Admin dashboard"] -->|"password + 2FA → session (cookie)"| BA2
  subgraph AS["auth-service (Fastify)"]
    BA["Better Auth · app surface<br/>/api/auth/*"]
    BA2["Better Auth · admin surface<br/>/api/admin-auth/*"]
    DOM["Identity domain endpoints<br/>guests, approvals, staff grants"]
  end
  BA & BA2 --> DB[(identity DB<br/>user · session · account · organization · member · jwks)]
  BA & BA2 --> R[(Redis<br/>session cache · rate limits)]
  App -->|"GET /token → JWT 15 min"| BA
  App -->|"Bearer JWT"| SVC["trip · payment · fleet · … services"]
  App -->|"WSS auth.token = JWT"| RT["realtime-gateway"]
  SVC & RT -->|"fetch + cache JWKS"| JWKS["/api/auth/jwks"]
  SVC --> AZ["libs/shared-authz<br/>permission matrix + scopes"]
```

---

## 2. What Better Auth does, and what we keep

| Concern | Owner | Notes |
|---|---|---|
| Phone OTP sign-up and sign-in | **Better Auth** (`phoneNumber` plugin) generates and **checks** the code | Delivered by notification-service: **Telegram Gateway first, SMS fallback** ([§9.7](#97-otp-delivery-telegram-gateway-first-sms-fallback)) |
| Staff password login + two-factor | **Better Auth** (`emailAndPassword`, `twoFactor`) | Password hashing kept as **argon2id** through a custom hasher |
| Sessions, revocation, multi-device | **Better Auth** (DB sessions + Redis secondary storage) | |
| Mobile auth without cookies | **Better Auth** (`bearer` plugin) | |
| JWT issuing, key storage, rotation, JWKS | **Better Auth** (`jwt` plugin) | Replaces the RSA key files from `make secrets` |
| Organisations, members, invitations | **Better Auth** (`organization` plugin) | Fleet companies, corporate accounts **and** city staff groups |
| Global roles, ban/unban, session revoke | **Better Auth** (`admin` plugin) | Impersonation **disabled** |
| Rate limiting of auth endpoints | **Better Auth** (`rateLimit` in Redis) | Plus Kong's limits at the edge |
| **Permission matrix and scopes** | **Us** (`libs/shared-authz`) | Fed into Better Auth's access-control definitions so both agree |
| Maker–checker approvals for role grants | **Us** (approval tables + Better Auth hooks that refuse unapproved grants) | [Role.md §11](Role.md#11-approvals-makerchecker) |
| Guest riders, on-behalf bookings (`act`) | **Us** (identity domain endpoints) | Built on Better Auth's server API |
| Domain events (`user.created`, `user.suspended`, `role.granted`) | **Us** (database hooks → outbox) | [Database.md §8](Database.md#8-consistency-model) |
| Audit log | **Us** (`audit.recorded` events) | [Role.md §12](Role.md#12-audit-log) |

---

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| AU1 | Use **Better Auth** for authentication, sessions, organisations and token issuing | TypeScript-native, framework-agnostic (Fastify works), Prisma adapter, plugin model covers phone OTP, organisations, 2FA, JWT/JWKS, bans. Saves building and maintaining security-critical code |
| AU2 | **Authorization stays in `libs/shared-authz`.** Better Auth's access-control definitions are **generated from** the same permission matrix | One source of truth. Better Auth's role checks can't express our CITY scopes on their own |
| AU3 | **Two surfaces**: an *app* instance (`/api/auth`, `aud = ride-app`) and an *admin* instance (`/api/admin-auth`, `aud = ride-admin`, 2FA required), over **one** identity database | Keeps [Role.md §10](Role.md#10-tokens)'s separation: staff tokens never work in the app, and app tokens never work on admin routes |
| AU4 | Signing algorithm **ES256** with automatic rotation (90 days) and the default 30-day grace period | Small, fast keys, supported by `jose` and by common gateways. The library default EdDSA is also fine for `jose`, but less widely supported by gateways |
| AU5 | Services verify JWTs **locally with the JWKS**. Kong does routing and rate limits, and **stops verifying JWTs** | Kong's open-source `jwt` plugin needs static per-consumer keys, which clashes with automatic key rotation. Verification in services is needed anyway for scopes |
| AU6 | **Minimal token payload** via `definePayload`: id, roles, scopes, versions. **Never** the whole user object (the plugin's default) | No PII in tokens, smaller headers |
| AU7 | IDs are **UUIDv7** via `advanced.database.generateId` | Matches [Database.md §6](Database.md#6-conventions-for-every-table) |
| AU8 | **Impersonation disabled.** Call-center work uses explicit on-behalf actions with an `act` claim | Impersonation hides who really acted. On-behalf keeps both identities in the audit log |
| AU9 | Pin the current **stable** Better Auth 1.x release and upgrade deliberately (a 1.8 beta exists at the time of writing) | Auth is security-critical. No beta in production |
| AU10 | **OTP codes are delivered through the Telegram Gateway API**, with **SMS as an automatic fallback**. Better Auth still **generates and verifies** the code. Telegram only delivers it (`sendVerificationMessage` with our `code`) | About $0.01 per delivered code, charged only if delivered within the TTL (far cheaper than SMS), fast, and tied to the Telegram account rather than the SIM. One code and one set of attempt limits whatever the channel |
| AU11 | **OTP codes never travel through Kafka, logs or analytics.** auth-service hands them to notification-service over an internal authenticated HTTP call, and the only copy at rest is Better Auth's short-lived verification record (+ an encrypted 5-minute copy for the SMS fallback) | Kafka topics are retained for days and readable by many consumers |

---

## 4. Architecture

```mermaid
flowchart TB
  subgraph Edge
    K["Kong<br/>routing · rate limits · TLS"]
  end
  subgraph Auth["auth-service"]
    F["Fastify"] --> H1["/api/auth/* → betterAuth(app config)"]
    F --> H2["/api/admin-auth/* → betterAuth(admin config)"]
    F --> D["/api/identity/* → our endpoints<br/>(guest riders, staff grants w/ approval, city list)"]
    H1 & H2 --> P["Prisma 7 client<br/>(src/generated/prisma)"]
    D --> P
    H1 & H2 & D --> OB["outbox → Kafka<br/>user.* · role.* · org.*"]
  end
  K --> F
  P --> DB[(identity DB)]
  H1 & H2 --> RS[(Redis secondary storage)]
```

Fastify mounting (the documented pattern, one route per surface):

```ts
// services/auth-service/src/routes/better-auth.routes.ts (sketch)
import { fromNodeHeaders } from "better-auth/node";

export function mountBetterAuth(app: FastifyInstance, instance: Auth, prefix: string) {
  app.route({
    method: ["GET", "POST"],
    url: `${prefix}/*`,
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const req = new Request(url.toString(), {
        method: request.method,
        headers: fromNodeHeaders(request.headers),
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const res = await instance.handler(req);
      reply.status(res.status);
      res.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(res.body ? await res.text() : null);
    },
  });
}

mountBetterAuth(app, appAuth, "/api/auth");
mountBetterAuth(app, adminAuth, "/api/admin-auth");
```

Register `@fastify/cors` **before** these routes, and list allowed origins in each instance's `trustedOrigins`.

---

## 5. Plugins

| Plugin / feature | App surface | Admin surface | Purpose |
|---|---|---|---|
| `phoneNumber` | ✅ | — | OTP sign-up and sign-in for riders, drivers and partners. `signUpOnVerification` creates the account on first verify |
| `bearer` | ✅ | — | Mobile app sends `Authorization: Bearer <session token>` (no cookies) |
| `jwt` | ✅ `aud=ride-app`, 15 min | ✅ `aud=ride-admin`, 10 min | Short-lived JWTs for services, JWKS endpoint, key rotation |
| `organization` | ✅ | — | Self-service fleet companies and corporate accounts, invitations. Staff city groups use the same tables but change **only** through `/api/identity` (§9.3) |
| `admin` | ✅ (data only) | ✅ (data only) | Global roles on `user.role` and the ban fields. **None of its HTTP endpoints are served** (allowlist, §17). Role changes and bans go through `/api/identity`. Impersonation disabled |
| `emailAndPassword` | — | ✅ | Staff login (password hashed with argon2id) |
| `twoFactor` | optional | ✅ **required** | TOTP + backup codes for staff |
| `secondaryStorage` (Redis) | ✅ | ✅ | Session lookups and rate-limit counters without hitting Postgres |
| `rateLimit` | ✅ | ✅ | Stricter custom rules on OTP and sign-in endpoints |
| `databaseHooks` / `organizationHooks` | ✅ | ✅ | Outbox events, approval enforcement, validation |
| Not used | | | Anonymous sessions, magic links, social login (v1), impersonation, sign-up by email |

**Endpoint allowlist.** Each surface serves only an explicit list of Better Auth endpoints (`src/auth/allowlist.ts`). Anything else returns 404, including every `/admin/*` endpoint, `/sign-up/*`, `/organization/delete`, `/organization/leave` and `/two-factor/disable`. A plugin upgrade that adds endpoints therefore exposes nothing until someone adds them to the list.

---

## 6. Configuration sketch

> [!NOTE]
> A **sketch** to fix the design. Option names follow the Better Auth docs; exact signatures must be checked against the pinned version during the spike ([§15](#15-risks-and-spikes)).

```ts
// services/auth-service/src/auth/app-auth.ts (sketch)
import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";   // or "better-auth/adapters/prisma", per pinned version
import { phoneNumber, bearer, jwt, organization, admin, twoFactor } from "better-auth/plugins";
import argon2 from "argon2";
import { v7 as uuidv7 } from "uuid";
import { prisma } from "../db.js";                                // Prisma 7 client from src/generated/prisma
import { redisStorage } from "./redis-storage.js";
import { orgAc, orgRoles, globalAc, globalRoles } from "@ride-app/shared-authz/better-auth";  // generated from the matrix
import { buildClaims } from "./claims.js";
import { requestOtpDelivery, outbox } from "./side-effects.js";   // internal HTTP to notification-service, never Kafka (AU11)
import { requireApprovedGrant } from "./approvals.js";

const ETHIOPIAN_MOBILE = /^\+251[79]\d{8}$/;                   // +2519… and +2517… (E.164)

export const appAuth = betterAuth({
  appName: "Anbessa",
  baseURL: process.env.AUTH_BASE_URL,                           // e.g. https://api.anbessa.et
  basePath: "/api/auth",
  secret: process.env.BETTER_AUTH_SECRET,                       // from Secrets Manager; also encrypts JWKS private keys
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  secondaryStorage: redisStorage,
  trustedOrigins: [process.env.FLEET_PORTAL_ORIGIN!, process.env.CORPORATE_PORTAL_ORIGIN!],
  advanced: { database: { generateId: () => uuidv7() } },

  user: {
    modelName: "user",                                          // Prisma model User @@map("app_user")
    additionalFields: {
      accountStatus:     { type: "string", defaultValue: "ACTIVE", input: false },  // ACTIVE | GUEST | DELETED
      permissionVersion: { type: "number", defaultValue: 0,        input: false },  // the "pv" claim
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,                               // 30 days (refreshes the app's ability to get JWTs)
    updateAge: 60 * 60 * 24,
    additionalFields: { surface: { type: "string", defaultValue: "app", input: false } },
  },
  rateLimit: {
    enabled: true,
    storage: "secondary-storage",
    customRules: {
      "/phone-number/send-otp": { window: 60, max: 3 },
      "/phone-number/verify":   { window: 60, max: 5 },
    },
  },

  plugins: [
    phoneNumber({
      phoneNumberValidator: (p) => ETHIOPIAN_MOBILE.test(p),
      sendOTP: ({ phoneNumber, code }) => { void requestOtpDelivery({ phoneNumber, code, ttlSeconds: 300, purpose: "sign_in" }); },
                                                                // don't await (docs advice). notification-service tries Telegram, then SMS (§9.7)
      otpLength: 6,
      expiresIn: 300,
      allowedAttempts: 3,
      requireVerification: true,
      signUpOnVerification: {
        getTempEmail: (p) => `${p.slice(1)}@phone.anbessa.invalid`,  // email is required by the core schema
        getTempName:  (p) => p,
      },
    }),
    bearer(),
    jwt({
      jwks: { keyPairConfig: { alg: "ES256" }, rotationInterval: 60 * 60 * 24 * 90 },  // gracePeriod: default 30 days
      jwt: {
        issuer: "https://auth.anbessa.et",
        audience: "ride-app",
        expirationTime: "15m",
        definePayload: (ctx) => buildClaims(ctx, "app"),        // minimal claims, never the whole user (AU6)
      },
    }),
    organization({
      ac: orgAc,
      roles: orgRoles,
      allowUserToCreateOrganization: true,                      // fleet owners / corporate admins self-register (PENDING)
      schema: {
        organization: { additionalFields: {
          kind:      { type: "string", required: true },        // FLEET | CORPORATE | STAFF_CITY | STAFF_HQ
          cityId:    { type: "string", required: true },
          legalName: { type: "string" },
          tin:       { type: "string" },
          status:    { type: "string", defaultValue: "PENDING" },
        } },
        member: { additionalFields: { validUntil: { type: "date" } } },
      },
      organizationHooks: {
        beforeCreateOrganization: async ({ organization }) => {
          if (!["FLEET", "CORPORATE"].includes(organization.kind)) throw new Error("FORBIDDEN_ORG_KIND"); // staff orgs are seeded
        },
        beforeAddMember: async (data) => requireApprovedGrant(data),  // staff grants need an APPROVED approval_request
      },
    }),
    admin({ ac: globalAc, roles: globalRoles, defaultRole: "rider", adminRoles: ["super_admin"] }),
    twoFactor({ issuer: "Anbessa" }),
  ],

  emailAndPassword: { enabled: false },
  databaseHooks: {
    user: {
      create: { after: async (user) => outbox("user.created", { userId: user.id }) },
      update: { after: async (user) => { if (user.banned) await outbox("user.suspended", { userId: user.id }); } },
    },
  },
});
```

The **admin instance** reuses the same database, Prisma client, access control and hooks, with these differences:

| Setting | Admin surface |
|---|---|
| `basePath` | `/api/admin-auth` |
| `emailAndPassword` | `{ enabled: true, password: { hash: argon2.hash, verify: ({ hash, password }) => argon2.verify(hash, password) } }` |
| `twoFactor` | required for every staff account (sign-in refused until enrolled) |
| `session.expiresIn` | 12 h, and `session.additionalFields.surface.defaultValue = "admin"` |
| `jwt.audience` / `expirationTime` | `ride-admin` / `10m` |
| `phoneNumber`, `bearer` | not loaded |
| `trustedOrigins` | the admin dashboard origin only |
| Cookies | `__Host-` prefixed, `Secure`, `SameSite=Strict` |

---

## 7. Mapping roles and scopes onto Better Auth

[Role.md](Role.md) needs role assignments with a **scope** (`SELF`, `ORG`, `CITY`, `GLOBAL`). Better Auth has two role stores: **global roles** on `user.role` (admin plugin, comma-separated) and **per-organisation roles** on `member.role` (organization plugin, comma-separated). We use both, and model **cities as staff organisations**:

```mermaid
flowchart TB
  subgraph Global["user.role (admin plugin) → SELF / GLOBAL scope"]
    G1["rider · driver"]
    G2["super_admin · finance_officer · finance_manager · auditor · regulator"]
  end
  subgraph Orgs["member.role (organization plugin) → ORG / CITY scope"]
    O1["FLEET org (a company)<br/>fleet_owner · fleet_driver"]
    O2["CORPORATE org (a company)<br/>corporate_admin · corporate_coordinator · employee"]
    O3["STAFF_CITY org (one per city, seeded)<br/>call_center_agent · dispatcher · support_agent · onboarding_officer<br/>safety_officer · operations_manager · marketing · analyst"]
  end
```

| Role ([Role.md §4](Role.md#4-role-catalog)) | Stored as | Scope it gives |
|---|---|---|
| `RIDER` | `user.role` contains `rider` (default on sign-up) | `SELF` |
| `DRIVER` | `user.role` contains `driver`, set by fleet-service on activation (server API) | `SELF` |
| `FLEET_OWNER` | `member.role = fleet_owner` in a `FLEET` org | `ORG:<id>` |
| Fleet driver (attribute) | `member.role = fleet_driver` in a `FLEET` org | membership for [V7](Role.md#ownership-rules) |
| `CORPORATE_ADMIN` / `CORPORATE_COORDINATOR` | `member.role` in a `CORPORATE` org | `ORG:<id>` |
| Corporate employee (attribute) | `member.role = employee` in a `CORPORATE` org | billing eligibility |
| `CALL_CENTER_AGENT`, `DISPATCHER`, `SUPPORT_AGENT`, `ONBOARDING_OFFICER`, `SAFETY_OFFICER`, `OPERATIONS_MANAGER`, `MARKETING`, `ANALYST` | `member.role` in the city's `STAFF_CITY` org (e.g. `staff-addis-ababa`) | `CITY:<org.cityId>` |
| `FINANCE_OFFICER`, `FINANCE_MANAGER`, `SUPER_ADMIN`, `AUDITOR` | `user.role` | `GLOBAL` |
| `ANALYST` (global) | `user.role` contains `analyst` | `GLOBAL` |
| `SERVICE` | Not a Better Auth user. Workload identity (Kubernetes service account / mTLS) or a separate client-credentials token | per client |

**Why cities as organisations?** Better Auth already gives organisations memberships, several roles per member, invitations, hooks and `validUntil` (as an additional field). A staff member who covers two cities simply has two memberships. Our `CITY` scope becomes "membership in a `STAFF_CITY` org whose `cityId` is X". No custom role-assignment table is needed.

### One permission matrix, two consumers

```mermaid
flowchart LR
  M["libs/shared-authz<br/>matrix.ts (Role.md §8)"] -->|generate| AC["createAccessControl statements<br/>+ ac.newRole(...) per role"]
  AC --> BA["Better Auth organization() / admin()<br/>(protects its own endpoints:<br/>invite member, ban, …)"]
  M --> REQ["authz.require(principal, permission, resource)<br/>used by every service"]
```

Better Auth's `hasPermission` protects **Better Auth's own** endpoints (inviting members, banning). Every **domain** action (`trip:assign`, `refund:approve`) is checked by `shared-authz` with scopes. Both read the same generated definitions, so they can't drift.

---

## 8. Sessions and tokens

Two kinds of credentials, with different jobs:

| | Session | Access JWT |
|---|---|---|
| Issued by | Better Auth on sign-in | Better Auth `jwt` plugin (`GET /token`) |
| Format | Opaque token. App: `Authorization: Bearer`. Admin: `__Host-` cookie | Signed JWT (ES256). The header carries the `kid` of the signing key |
| Lifetime | App 30 days, admin 12 h (sliding) | App 15 min, admin 10 min |
| Stored | `session` table + Redis secondary storage | Nowhere (stateless) |
| Used for | Getting new JWTs, Better Auth endpoints | Every call to every other service, and the WebSocket handshake |
| Revocation | Immediate (ban, sign-out, `revokeUserSessions`) | Expires within its TTL, plus the `user.suspended` denylist ([Role.md §10](Role.md#10-tokens)) |

### Claims (built by `definePayload`)

Same shape as [Role.md §10](Role.md#10-tokens):

```json
{
  "iss": "https://auth.anbessa.et",
  "aud": "ride-app",
  "sub": "0192f7a8-…",
  "exp": 1792900900,
  "pv": 7,
  "amr": ["otp"],
  "roles": [
    { "r": "RIDER" },
    { "r": "DRIVER" },
    { "r": "FLEET_OWNER", "org": "0192f7b1-…" }
  ]
}
```

A staff token (`aud=ride-admin`) looks like `"roles": [{ "r": "SUPER_ADMIN", "g": true }, { "r": "DISPATCHER", "city": "addis-ababa" }]`, with `"amr": ["pwd", "otp"]`. `g: true` marks a `GLOBAL` assignment. While a staff account still has setup to do, its token has `"roles": []` and `"setup": { "twoFactor": true, "changePassword": true }`, which the dashboard uses to send the user to TOTP enrolment or password change.

`buildClaims(ctx, surface)`:
1. Refuses to issue a token (403) if `session.surface ≠ surface` or the user is banned. A session belongs to exactly one surface.
2. Maps `user.role` → global/self roles.
3. Loads the user's active members (`validUntil` in the future) with their organisation `kind` and `cityId`. FLEET/CORPORATE become `{ r, org }`, and STAFF_CITY becomes `{ r, city }`.
4. On the **app** surface: includes only customer and partner roles. On the **admin** surface: includes only staff roles, and only if the user has two-factor enabled **and** has changed the initial password (`mustChangePassword = false`).
4a. Partner roles count only while the organisation is `VERIFIED` (the owner/admin role also counts while it's `PENDING`, so they can finish onboarding). Expired memberships, suspended organisations and roles in the wrong kind of organisation are dropped.
5. Adds `pv = user.permissionVersion`. Never adds name, phone, email or any other PII.

### Refreshing

```mermaid
sequenceDiagram
  autonumber
  participant A as Phone app
  participant BA as Better Auth (app)
  participant S as trip-service
  A->>BA: GET /api/auth/token (Authorization: Bearer <session>)
  BA-->>A: { token: JWT, exp: +15 min }
  A->>S: POST /trips (Authorization: Bearer <JWT>)
  S->>S: verify with cached JWKS, check aud=ride-app, pv, permission + scope
  Note over A: ~1 min before exp, or on 401 → GET /token again
  Note over A,BA: session banned or revoked → /token fails → app returns to login
```

---

## 9. Key flows

### 9.1 Rider sign-up and sign-in with a phone OTP

```mermaid
sequenceDiagram
  autonumber
  participant A as Phone app
  participant BA as Better Auth (app)
  participant N as notification-service
  participant OB as outbox
  A->>BA: POST /phone-number/send-otp {phoneNumber: "+251911…"}
  BA->>BA: validator ✔, rate limit ✔, store code (verification table, 5 min)
  BA-->>N: requestOtpDelivery (internal HTTP, not awaited)
  N-->>A: code via Telegram (or SMS fallback, see 9.7)
  A->>BA: POST /phone-number/verify {phoneNumber, code}
  alt first time
    BA->>BA: signUpOnVerification → create user (role "rider", temp email)
    BA->>OB: user.created
  end
  BA-->>A: session token (bearer)
  A->>BA: GET /token → JWT {roles: [RIDER]}
```

### 9.2 Staff sign-in with two-factor

```mermaid
sequenceDiagram
  autonumber
  participant D as Staff browser
  participant BA as Better Auth (admin)
  D->>BA: POST /sign-in/email {email, password}
  BA->>BA: argon2 verify ✔ → two-factor required
  BA-->>D: 2FA challenge
  D->>BA: POST /two-factor/verify-totp {code}
  BA-->>D: session cookie (__Host-, 12 h, surface=admin)
  D->>BA: GET /token → JWT aud=ride-admin {roles: [DISPATCHER@addis-ababa, …]}
```

### 9.3 Granting a staff role (maker–checker)

```mermaid
sequenceDiagram
  autonumber
  participant SA1 as Super admin A
  participant ID as auth-service /api/identity
  participant DB as identity DB
  participant SA2 as Super admin B
  SA1->>ID: POST /staff-role-requests {userId, DISPATCHER, cityId addis-ababa, reason}
  ID->>ID: authorize role:request, role grantable, target has a staff login
  ID->>DB: approval_request PENDING (expires in 7 days)
  SA2->>ID: POST /staff-role-requests/:id/approve
  ID->>ID: authorize role:approve, B ≠ A (also a DB check constraint)
  ID->>DB: one transaction: lock request, member upsert in staff-addis-ababa,<br/>permissionVersion + 1, request EXECUTED, outbox role.granted + audit
  ID->>ID: after commit: Redis pv:{userId}
```

The grant is executed **by the identity service itself, in one transaction**, not through Better Auth's `addMember`. Better Auth's organisation hooks refuse **every** change to a staff organisation (create, update, add/remove member, change role, invite). So there is no Better Auth path, not even server-side, that can put someone in a staff organisation, and a crash can't leave a member without its audit row and event.

Global staff roles (`SUPER_ADMIN`, `FINANCE_*`, `AUDITOR`, `REGULATOR`) work the same way, but the role is appended to `user.role`. Revocation (`POST /staff-roles/revoke`, `staff:manage`) takes effect immediately and refuses to leave fewer than two super admins.

### 9.4 Call center: guest rider, then claiming the account

```mermaid
sequenceDiagram
  autonumber
  participant Ag as Call center agent
  participant ID as auth-service /api/identity
  participant BA as Better Auth (server API)
  participant C as Caller, later app user
  Ag->>ID: POST /guests {phone, cityId} (user:create_guest in that city)
  ID->>ID: create user (role rider, accountStatus GUEST, phoneNumberVerified false) + outbox, one transaction
  Note over Ag: books the trip on behalf (Role.md §13.3, act claim)
  C->>BA: later installs the app → send-otp → verify (same phone)
  BA->>BA: phone found → session for the existing user, phoneNumberVerified true
  BA->>BA: callbackOnVerification → accountStatus ACTIVE + outbox user.claimed (trip history kept)
```

### 9.5 Suspension

`POST /api/identity/users/:id/suspend {reason, cityId, until?}`:
1. **Authorization:** suspending a **staff** account needs `staff:manage` (super admins). Anyone else needs `user:suspend` in that city (safety officers). Nobody can suspend themselves, and the last two super admins can't be suspended.
2. **One transaction:** `banned`, `banReason`, `banExpires`, `accountStatus = SUSPENDED`, `permissionVersion + 1`, outbox `user.suspended` + audit.
3. **After commit:** every session of the user is deleted (both surfaces), and Redis `deny:{userId}` is set.
4. Verifiers (`createTokenVerifier` in `libs/shared-authz`) refuse tokens of denied users (`token_revoked`) and tokens older than the current `pv` (`token_outdated`). Without Redis (local dev only) an already-issued JWT stays valid until it expires (≤ 15 min).
5. `/token` refuses new JWTs while the user is banned (`definePayload` throws).

`POST /users/:id/reinstate` reverses it with the same authorization rules.

### 9.6 Key rotation

```mermaid
flowchart LR
  K1["Key A (active)"] -->|"rotationInterval: 90 days"| K2["Key B becomes active<br/>new JWTs have kid=B"]
  K1 -->|"gracePeriod: 30 days"| K1b["Key A stays in JWKS<br/>(old tokens still verify)"]
  K1b --> K1c["Key A removed"]
  S["Services: JWKS cached,<br/>refetch on unknown kid"] -.-> K2
```

Tokens live 15 minutes, so the 30-day grace period is generous. Private keys are stored **AES-256-GCM encrypted** with `BETTER_AUTH_SECRET` (the default; don't disable it).

---

### 9.7 OTP delivery: Telegram Gateway first, SMS fallback

The user enters their phone number. **Telegram delivers the verification code to that number's Telegram account**, in the "Verification Codes" chat, and **our backend checks the code** (Better Auth). If the number can't receive Telegram codes, or the code isn't delivered quickly, the same code goes by SMS.

```mermaid
sequenceDiagram
  autonumber
  participant A as Rider app
  participant BA as auth-service (Better Auth)
  participant N as notification-service
  participant TG as Telegram Gateway API
  participant SMS as SMS provider
  A->>BA: POST /phone-number/send-otp {+2519…}
  BA->>BA: rate limit ✔, generate a 6-digit code, store it (verification, 5 min)
  BA-->>N: POST /internal/otp-deliveries {phone, code, ttl 300} (mTLS, not awaited)
  N->>TG: checkSendAbility(phone_number)
  alt the number can receive on Telegram
    TG-->>N: RequestStatus {request_id}
    N->>TG: sendVerificationMessage(phone_number, request_id, code, ttl=300, callback_url, payload=deliveryId)
    TG-->>A: code in the user's Telegram app
    TG->>N: delivery report (signed): delivered / read
  else cannot receive (no Telegram account, settings)
    TG-->>N: error (free of charge)
    N->>SMS: send the same code by SMS
  end
  opt no "delivered" report within 20 s
    N->>SMS: fallback, the same code by SMS
    N->>TG: revokeVerificationMessage(request_id) (best effort)
  end
  A->>BA: POST /phone-number/verify {phone, code}
  BA->>BA: Better Auth checks code, expiry, 3 attempts → session
  BA-->>N: POST /internal/otp-deliveries/verified {phone} (best effort)
  N->>TG: checkVerificationStatus(request_id, code) → code_valid (closes it on Telegram's side)
```

#### Steps in notification-service

| # | Action | Telegram method / result |
|---|---|---|
| 1 | Receives `{phone, code, ttl, purpose}` from auth-service over **internal mTLS HTTP**. Stores an `otp_delivery` row (no code), and keeps the code **encrypted in Redis for `ttl`** only so the SMS fallback can resend it | — |
| 2 | **Can this number receive a Telegram code?** | `checkSendAbility(phone_number)` → `RequestStatus.request_id`, or an error if it can't |
| 3 | **Yes:** send our code. Passing the `request_id` from step 2 means the check isn't charged separately | `sendVerificationMessage(phone_number, request_id, code, ttl=300, callback_url, payload=<otp_delivery.id>, sender_username=<verified Anbessa channel>)` |
| 4 | **No:** immediate SMS fallback. A failed check is free | SMS provider |
| 5 | **Delivery report** arrives at `POST /api/webhooks/telegram-gateway` → verify the signature (below) → update status `sent → delivered → read` (or `expired`, `revoked`). Return `200` fast (Telegram retries up to 10 times otherwise) | callback with `RequestStatus.delivery_status` |
| 6 | **Auto-fallback:** no `delivered` within **20 s** → send the same code by SMS, and revoke the Telegram message (best effort: `True` means the revocation request was received, and a delivered message isn't removed) | `revokeVerificationMessage(request_id)` |
| 7 | **Manual resend** (the user taps "Resend" or "Send by SMS"): Better Auth creates a new code. notification-service sees a recent unread Telegram attempt for the same phone and sends by **SMS** directly | — |
| 8 | **After a successful verify** (Better Auth), auth-service notifies notification-service (best effort), which reports the outcome to Telegram and deletes the Redis copy of the code | `checkVerificationStatus(request_id, code)` → `verification_status.status = code_valid` |

The app shows: *"We sent a code to your **Telegram**. Open Telegram → Verification Codes."* After 20 s: *"Didn't get it? We've also sent it by SMS."* The user doesn't need to know which channel worked: **one code, one input box**.

#### Why Better Auth verifies (not Telegram)

| Option | Chosen? | Reason |
|---|---|---|
| **Our code** (Better Auth generates it), Telegram **delivers** it, Better Auth **verifies** it | ✅ | One code works on both channels. Better Auth's attempt limits (3), expiry (5 min) and rate limits apply uniformly. No Telegram call on the critical verify path |
| Telegram generates (`code_length`) and verifies (`checkVerificationStatus`) | — | SMS fallback would need a second, different code. Verification would depend on Telegram's availability. Possible later through Better Auth's custom `verifyOTP` hook if wanted |

#### Verifying delivery reports

```ts
// notification-service: POST /api/webhooks/telegram-gateway (raw body required)
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const secretKey = createHash("sha256").update(process.env.TELEGRAM_GATEWAY_TOKEN!).digest();

export function verifyTelegramReport(rawBody: string, timestamp: string, signature: string): boolean {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;          // reject replays older than 5 min
  const expected = createHmac("sha256", secretKey).update(`${timestamp}\n${rawBody}`).digest("hex");
  return expected.length === signature.length &&
         timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
// headers: X-Request-Timestamp, X-Request-Signature. Process idempotently by (request_id, status, updated_at).
```

#### Data (notification-service)

```sql
CREATE TABLE otp_delivery (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  phone_hash           bytea NOT NULL,                 -- HMAC of the E.164 number, never the number itself
  purpose              text  NOT NULL CHECK (purpose IN ('sign_in','phone_change','claim_guest')),
  channel              text  NOT NULL CHECK (channel IN ('TELEGRAM','SMS')),
  telegram_request_id  text  UNIQUE,                    -- RequestStatus.request_id
  status               text  NOT NULL DEFAULT 'REQUESTED'
                       CHECK (status IN ('REQUESTED','NOT_REACHABLE','SENT','DELIVERED','READ',
                                         'EXPIRED','REVOKED','FAILED','VERIFIED')),
  cost_usd             numeric(10,4),                   -- RequestStatus.request_cost
  is_refunded          boolean,
  fallback_of          uuid REFERENCES otp_delivery(id),-- the SMS row points at the Telegram attempt it replaced
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((channel = 'TELEGRAM') OR telegram_request_id IS NULL)
);
CREATE INDEX ix_otp_delivery_phone_recent ON otp_delivery (phone_hash, created_at DESC);
```

No code is ever stored in this table. Rows are kept for 30 days (cost reconciliation, fraud analysis), then deleted.

#### Configuration and operations

| Setting | Value |
|---|---|
| `TELEGRAM_GATEWAY_TOKEN` | notification-service **only**, from Secrets Manager. Never in logs |
| Base URL | `https://gatewayapi.telegram.org/<method>`, `Authorization: Bearer <token>` |
| `ttl` | 300 s (= the Better Auth OTP expiry). Undelivered within the TTL → refunded |
| `code` | Better Auth's 6-digit code (Telegram accepts 4–8 digits) |
| `sender_username` | Anbessa's verified Telegram channel (branding) |
| `callback_url` | `https://api.anbessa.et/api/webhooks/telegram-gateway` (Kong route, no auth plugin: the signature is the authentication) |
| `payload` | `otp_delivery.id` only (no phone, no code) |
| Auto-fallback delay | 20 s without a `delivered` report (per-city config) |
| Channel order | `[TELEGRAM, SMS]` (per-city config. Set `[SMS]` to disable Telegram) |
| Prepaid balance | `remaining_balance` from charged requests is exported as a metric. **Alert** below 7 days of expected spend. Finance tops up the Gateway account |
| Testing | Codes to your own number are free. Use them in staging and CI smoke tests |

Privacy: Telegram doesn't reveal users' phone numbers to services, and we only send numbers the user entered themselves. The sign-in screen states: *"We'll send your code via Telegram, or SMS if Telegram isn't available."*

## 10. Verifying tokens in other services

In `libs/shared-authz` (used by every service and realtime-gateway):

```ts
import { createTokenVerifier, authorize } from "@ride-app/shared-authz";

const verify = createTokenVerifier({
  issuer: process.env.AUTH_ISSUER!,             // e.g. https://api.anbessa.et
  jwksUrl: process.env.AUTH_JWKS_URL!,          // …/api/auth/jwks, cached; refetched on an unknown kid
  // algorithms default to ["ES256"]: pinned, never taken from the token header
  isDenied: async (id) => (await redis.exists(`deny:${id}`)) === 1,
  currentPermissionVersion: async (id) => Number(await redis.get(`pv:${id}`)) || undefined,
});

const principal = await verify(token, "ride-app");   // throws TokenError (401)
authorize(principal, "trip:assign", { cityId });     // throws AuthorizationError (403)
```

Unknown roles, and roles of the other audience, are dropped while parsing the claims, so a staff role can never be used on the app audience.

| Consumer | Status |
|---|---|
| realtime-gateway | ✅ Done: the handshake uses `createTokenVerifier` (+ Redis `deny`/`pv`). `JWT_PUBLIC_KEY_PATH` is gone |
| All HTTP services | To do as each service gets real routes: verify in an `onRequest` hook, then `authorize(...)` per route |
| Admin-facing routes (`/api/admin/*`) | `audience: "ride-admin"` |
| Kong | ✅ Done: `jwt` plugin removed. Routes for `/api/auth`, `/api/admin-auth` and `/api/identity` with `strip_path: false`. `/internal/*` is never routed |
| Local dev | ✅ Done: services get `AUTH_ISSUER` / `AUTH_JWKS_URL` (`http://localhost:3001…`). `make secrets` generates `BETTER_AUTH_SECRET` and `INTERNAL_SERVICE_TOKEN` instead of RSA key files |

---

## 11. Data model

Better Auth owns its core tables, plus the plugin tables. We add fields through `additionalFields`. Its CLI generates the Prisma models, and our normal **Prisma migrations** apply them (the Better Auth CLI doesn't migrate Prisma schemas).

```mermaid
erDiagram
  user ||--o{ session : has
  user ||--o{ account : "credentials / providers"
  user ||--o{ member : "belongs to"
  organization ||--o{ member : has
  organization ||--o{ invitation : sends
  user ||--o| twoFactor : "may enroll"
  user {
    uuid id PK "uuidv7"
    string name
    string email UK "temp for phone-only users"
    boolean emailVerified
    string phoneNumber UK "E.164 (phoneNumber plugin)"
    boolean phoneNumberVerified
    string role "comma-separated global roles (admin plugin)"
    boolean banned
    string banReason
    datetime banExpires
    boolean twoFactorEnabled
    string accountStatus "ours: ACTIVE | GUEST | DELETED"
    int permissionVersion "ours: pv claim"
  }
  session {
    uuid id PK
    string token UK
    uuid userId FK
    datetime expiresAt
    string ipAddress
    string userAgent
    uuid activeOrganizationId
    string surface "ours: app | admin"
  }
  account {
    uuid id PK
    uuid userId FK
    string providerId "credential | …"
    string password "argon2id hash (staff)"
  }
  verification {
    uuid id PK
    string identifier
    string value "OTP"
    datetime expiresAt
  }
  organization {
    uuid id PK
    string name
    string slug UK
    string kind "ours: FLEET | CORPORATE | STAFF_CITY | STAFF_HQ"
    string cityId "ours"
    string legalName "ours"
    string tin "ours"
    string status "ours: PENDING | VERIFIED | SUSPENDED"
  }
  member {
    uuid id PK
    uuid organizationId FK
    uuid userId FK
    string role "comma-separated org roles"
    datetime validUntil "ours"
  }
  invitation {
    uuid id PK
    uuid organizationId FK
    string email
    string role
    string status
    datetime expiresAt
  }
  jwks {
    uuid id PK
    string publicKey
    string privateKey "AES-256-GCM encrypted"
    datetime createdAt
  }
  twoFactor {
    uuid id PK
    uuid userId FK
    string secret "encrypted"
    string backupCodes "encrypted"
  }
```

### What changes in the other designs

| Previous design element | Becomes |
|---|---|
| `app_user` ([Database.md §7.1](Database.md#71-identity-auth-service-better-auth)) | Better Auth `user` (Prisma `@@map("app_user")`) + additional fields |
| `role_assignment` with `scope_type` | `user.role` (SELF/GLOBAL) + `member.role` in FLEET / CORPORATE / STAFF_CITY organisations |
| `organization` (ours) | Better Auth `organization` + additional fields (`kind`, `cityId`, `legalName`, `tin`, `status`) |
| `membership` | Better Auth `member` (+ `validUntil`) and `invitation` |
| `token_version` | `user.permissionVersion` (the `pv` claim) |
| `status SUSPENDED` | Better Auth ban fields (`banned`, `banReason`, `banExpires`) |
| `city` | Stays ours (plain table). Each city also gets a seeded `STAFF_CITY` organisation |
| RSA key files from `make secrets` | `jwks` table (encrypted). `make secrets` generates `BETTER_AUTH_SECRET` |

### Constraints we add on top (raw SQL migrations)

| Constraint | Why |
|---|---|
| `UNIQUE (phoneNumber)` where not null | One account per phone (the plugin relies on it) |
| `CHECK (phoneNumber ~ '^\+251[79][0-9]{8}$')` | Same rule as the validator, enforced in the DB |
| `CHECK (kind IN ('FLEET','CORPORATE','STAFF_CITY','STAFF_HQ'))` on organization | Valid kinds only |
| `UNIQUE (kind, tin)` on organization where `tin` is not null | One verified legal entity per kind ([Role.md §5](Role.md#5-core-model-users-roles-scopes-organisations)) |
| `UNIQUE (organizationId, userId)` on member | One membership row per org (several roles are comma-separated in it) |

---

## 12. Security

| # | Measure |
|---|---|
| S1 | `BETTER_AUTH_SECRET`: 32+ random bytes, in Secrets Manager, **different per environment**. It encrypts JWKS private keys and signs cookies, so rotating it needs a planned key migration |
| S2 | **Minimal JWT payload** (AU6). The plugin's default puts the whole user object in the token, so it **must** be overridden |
| S3 | Pin `algorithms: ["ES256"]` on verification, and check `iss`, `aud` and `exp` everywhere |
| S4 | **OTP abuse ("SMS pumping" / paid-message pumping, which applies to Telegram codes too)**: per-number and per-IP rate limits (Kong + Better Auth `customRules`), the Ethiopian-mobile validator, daily SMS budget alerts, a CAPTCHA challenge after repeated sends |
| S5 | `allowedAttempts: 3` and a 5-minute expiry on OTPs. After 3 failures the code is deleted and a new one must be requested |
| S6 | Staff: password + **TOTP required**, `__Host-` cookies, `SameSite=Strict`, 12-hour sessions, admin origin only in `trustedOrigins` |
| S7 | **Impersonation disabled** (no role gets `impersonate`). On-behalf actions carry an `act` claim instead |
| S8 | Passwords hashed with **argon2id** (custom hasher). Existing hashes migrate unchanged |
| S9 | Session cookies and bearer tokens never logged. Better Auth's error messages don't reveal whether a phone number exists |
| S10 | Pin a stable Better Auth version, watch its security advisories, and upgrade through a PR with the auth test suite |
| S11 | **Telegram Gateway:** the token lives only in notification-service. Delivery reports are accepted only with a valid `X-Request-Signature` (HMAC-SHA256, key = SHA256(token)) and a fresh `X-Request-Timestamp` (≤ 5 min). The `payload` carries only an internal id. Codes are never put in Kafka, logs or `payload` (AU11) |
| S12 | **Paid-message pumping** applies to Telegram too (about $0.01 per delivered code): the same per-number and per-IP limits as SMS, plus a daily spend alert on both channels and a balance alert |

---

## 13. Events and audit

| Better Auth event (hook) | Our event (outbox) | Consumers |
|---|---|---|
| `databaseHooks.user.create.after` | `user.created` | notification (welcome), trip (rider cache), audit |
| user updated with `banned = true` / `false` | `user.suspended` / `user.reinstated` | every service (denylist), audit |
| `organizationHooks` after add/remove member | `role.granted` / `role.revoked` (+ `permissionVersion` bump) | audit, admin dashboard |
| `organizationHooks` after organisation status changes | `org.verified` / `org.suspended` | fleet, payment, trip |
| sign-in success / failure | `audit.recorded` (staff surface: always. App: failures only, sampled) | audit-service |

Hooks only **write to the outbox in the same database**. They never call Kafka directly, so a Kafka outage can't break sign-in ([Database.md §8](Database.md#8-consistency-model)). A relay in auth-service (`src/outbox/relay.ts`, `FOR UPDATE SKIP LOCKED`, idempotent producer) publishes them.

**Known limitation.** Better Auth runs its own inserts and our *after* hooks in separate statements, so for Better Auth flows (sign-up, organisation create, member added through an invitation) the outbox row is written right after the change, not in the same transaction. A crash between the two loses that one event. Everything security-relevant (staff grants, revocations, suspensions, organisation verification, the driver role) goes through `/api/identity`, where state, `permissionVersion`, outbox and audit are always one transaction.

---

## 14. Migration from the current auth-service

Today, auth-service has hand-written `register`/`login` (both currently broken, see [architecture §16](../architecture/overview.md#16-known-gaps)), a single `User.role`, and RS256 key files.

| Phase | Work | Result |
|---|---|---|
| **1. Spike** ✅ | Better Auth + Prisma 7 adapter + Fastify in a branch. Prove: phone OTP, bearer, `/token`, JWKS verify in a test service, two surfaces on one DB ([§15](#15-risks-and-spikes)) | Risks closed or design adjusted |
| **2. Schema** ✅ | Generate the Better Auth Prisma models, add our `additionalFields` and constraints, `@@map` to snake_case tables, migrate with `prisma migrate` | Tables ready |
| **3. Data migration** ✅ | `User` → `user` (+ `phoneNumber`), `passwordHash` → `account` (`providerId = "credential"`, argon2 kept), `role` → `user.role` (`RIDER → rider`, `DRIVER → driver`, `ADMIN → super_admin`, flagged for review). Seed `STAFF_CITY` org `staff-addis-ababa` | Existing users keep working |
| **4. Switch auth-service** ✅ | Mount both Better Auth surfaces. Delete the hand-written routes, `jose` signing and `JWT_PRIVATE_KEY_PATH`. Add `/api/identity/*` for guests and staff grants | Login works (fixes today's bugs) |
| **5. Switch verifiers** ✅ (gateway; other services as they get routes) | `libs/shared-authz` `verifyAccessToken` in realtime-gateway and services. Remove the `jwt` plugin from Kong | One verification path |
| **6. Clients** | Phone app: OTP screens + bearer + `/token` refresh (replaces the login placeholder and the rider/driver buttons). Admin dashboard: password + TOTP | End-to-end |
| **7. Hardening** (partly: integration tests for ban, pv, OTP lockout) | OTP abuse controls, key-rotation drill, ban → denylist test, audit events | Production-ready |

---

## 15. Risks and spikes

| # | Risk | Spike / mitigation |
|---|---|---|
| R1 | **Two Better Auth instances on one database** (app + admin surfaces) | Verify that sessions stamped with `surface` can't mint tokens on the other surface, and that shared tables and hooks behave. **Fallback:** one instance, with the surface decided by a session field set at sign-in and the audience chosen in a custom `jwt.sign`. ✅ **Closed:** two instances work; integration tests prove an app session can't mint an admin token |
| R2 | `definePayload` arguments, and whether it can be `async` (needed to load memberships) | Check against the pinned version. **Fallback:** keep memberships in a Redis cache refreshed by `role.*` events, and read it synchronously. ✅ **Closed:** `definePayload` may be async in 1.7.13 |
| R3 | Prisma 7 client with the custom output path (`src/generated/prisma`) and the driver adapter | Import the client from the generated path (as the adapter docs require). Integration test in CI |
| R4 | Organisations as city staff groups could be confused with customer organisations in Better Auth's own UI/APIs | `kind` field + hooks that refuse every staff-org change. Staff orgs are only created by migrations. The app surface returns 404 for any `/organization/*` request that names a staff organisation |
| R5 | Better Auth's core schema requires an email for phone-only users | Temp email on a reserved domain (`@phone.anbessa.invalid`), never shown and never sent to |
| R6 | Library upgrades changing behaviour | Pin the version, run the auth test suite (sign-in, OTP limits, token claims, ban, rotation) on every upgrade |
| R7 | **Telegram reach** among Ethiopian users is unknown, and Telegram Gateway's availability/terms may change | Measure `checkSendAbility` success in a pilot. Keep SMS as a first-class fallback (channel order is config, so `[SMS]` disables Telegram per city) |

---

## 16. Open questions

| # | Question | Current default |
|---|---|---|
| Q1 | Should riders and drivers have **passwords** as well as OTP? | OTP only for the app (passwords for staff) |
| Q2 | Social login (Google/Apple) for riders? | Not in v1 |
| Q3 | SMS provider for the **fallback** channel, and its cost per message | Through notification-service, provider TBD. Telegram Gateway is the primary channel (AU10) |
| Q4 | Optional 2FA for fleet owners and corporate admins (they handle money and staff)? | Optional at launch, required later for fleets above N vehicles |
| Q5 | Service-to-service identity: Kubernetes workload identity / mTLS, or OAuth client credentials? | Workload identity + mTLS (service mesh) in production, so no Better Auth users for services |

---

## 17. Implementation notes (v1)

What was built, and where it differs from or adds to the sections above.

### Code map (`services/auth-service/src`)

| Path | What it does |
|---|---|
| `auth/instances.ts` | The two Better Auth instances (`createAppAuth`, `createAdminAuth`) and their plugins |
| `auth/allowlist.ts` | The endpoints each surface serves. Everything else is 404 |
| `auth/claims.ts` | `definePayload`: surface check, ban check, roles per surface, 2FA/password gate, `pv`, `amr`, `setup` |
| `auth/roles-codec.ts` | Stored `user.role` / `member.role` → scoped `RoleAssignment`s |
| `auth/hooks.ts` | Organisation hooks: partner-org validation, staff orgs frozen, allowed roles per org kind, `pv` bumps, outbox |
| `auth/access-control.ts` | Better Auth access control generated from the `shared-authz` matrix |
| `auth/otp-delivery.ts` | OTP sender: `notification` (internal HTTP to notification-service) or `console` (dev only, refused in production) |
| `identity/service.ts` | Guests, staff accounts, maker–checker grants, revocation, suspension, organisation verification, driver role |
| `http/better-auth.routes.ts` | Mounts both surfaces behind the allowlist and the staff-org guard |
| `http/identity.routes.ts` | `/api/identity/*` and `/internal/*` with zod validation |
| `http/principal.ts` | Verifies Bearer JWTs with `shared-authz` against Better Auth's own key set (no HTTP call to itself) |
| `outbox/` | Outbox writes and the Kafka relay |
| `lib/signals.ts` | Redis `deny:{userId}` and `pv:{userId}` |
| `cli/bootstrap-super-admin.ts` | Creates the first two super admins |

### Identity API

All routes take an **admin** access token (`aud=ride-admin`) unless noted, and every one is checked with `shared-authz` `authorize(...)` inside the service.

| Route | Permission | Notes |
|---|---|---|
| `GET /api/identity/me` | any valid token | `x-auth-surface: admin` selects the admin audience |
| `GET /api/identity/cities` | any valid token | |
| `POST /api/identity/guests` | `user:create_guest` in `cityId` | Returns the existing user if the phone is known |
| `POST /api/identity/staff-accounts` | `staff:manage` | Returns a one-time temporary password (`cache-control: no-store`) |
| `POST /api/identity/staff-role-requests` | `role:request` | Maker. Reason ≥ 10 characters. City required for city roles and refused for global ones |
| `GET /api/identity/staff-role-requests` | `role:request` or `role:approve` | Optional `?status=` |
| `POST /api/identity/staff-role-requests/:id/approve` | `role:approve`, checker ≠ maker | Executes the grant (§9.3) |
| `POST /api/identity/staff-role-requests/:id/reject` | `role:approve` | |
| `POST /api/identity/staff-roles/revoke` | `staff:manage` | Immediate. Keeps at least two super admins |
| `POST /api/identity/users/:id/suspend` · `/reinstate` | staff target: `staff:manage`. Others: `user:suspend` / `user:reinstate` in `cityId` | §9.5. See the city-scope limitation below |
| `POST /api/identity/organizations/:id/verify` · `/suspend` | `org:verify` / `org:suspend` in the org's city | Bumps `pv` of every member |
| `POST /internal/drivers/:userId/role` | service token | Adds or removes `driver` on `user.role`. Called by onboarding when a driver is activated |

Errors are JSON `{ error, message }`: 400 `validation_error`, 401 `invalid_token` / `token_revoked` / `token_outdated`, 403 `forbidden`, 404, 409. Internal errors are logged, never returned.

### Decisions taken while building

| # | Decision | Why |
|---|---|---|
| I1 | **Staff grants are executed by the identity service, not `addMember`** (§9.3). Better Auth hooks refuse every staff-org change | One transaction for state, `pv`, outbox and audit. No Better Auth path into a staff org at all |
| I2 | **Allowlist per surface** (§5) | The admin plugin's endpoints (set role, ban, impersonate, list users) would bypass our maker–checker and scopes |
| I3 | **Staff roles only after 2FA *and* a changed initial password** | A leaked temporary password alone gives nothing |
| I4 | **Phone invitations**: invite `phoneToEmail(phone)` (`2519…@phone.anbessa.invalid`). The `org.member_invited` event carries the real phone for delivery. Verifying the phone also marks the placeholder email verified (Better Auth requires it to accept invitations) | Partners invite drivers and employees by phone number; no real email involved |
| I5 | **Changing your phone number is not self-service** (`updatePhoneNumber` is refused) | The phone is the identity and the invitation address. Support handles changes |
| I6 | `/organization/leave` is not served | Leaving could orphan a fleet. Owners remove members instead |
| I7 | **Interim service authentication**: `/internal/*` needs `Authorization: Bearer $INTERNAL_SERVICE_TOKEN` (timing-safe compare). Kong never routes `/internal/*` | Until workload identity / mTLS ([Q5](#16-open-questions)) |
| I8 | **Bootstrap**: `pnpm --filter @ride-app/auth-service bootstrap:super-admin -- --email … --name …` works only while fewer than two super admins exist (advisory lock), and prints a one-time temporary password | No backdoor once the maker–checker pair exists |
| I9 | Partner roles other than owner/admin count only once the organisation is `VERIFIED` | An unverified company can't bill or dispatch |
| I10 | **Redis is optional in development, required in production** (config refuses to start otherwise), like Kafka, the service token and real OTP delivery | Fast local setup without weakening production |

### Not done yet

- **City scope of suspensions is caller-asserted.** Riders have no home city in the identity database, so `cityId` on suspend/reinstate is the city where the case is handled. The check proves the officer holds `user:suspend` *in that city*, and the city goes into the audit event, but it can't prove the user belongs to it. To tighten it, take the city from the safety case or trip (support-service / trip-service) instead of the request body.

- **notification-service `POST /internal/otp-deliveries`** (Telegram Gateway + SMS fallback, §9.7). Until it exists, use `OTP_DELIVERY=console` locally.
- `act` claim for call-center actions on behalf of a rider.
- Sign-in success/failure `audit.recorded` events, CAPTCHA after repeated OTP sends.
- Staff password reset (v1: a super admin creates a new account, or resets it in the database with an audited script).
- Phone app OTP screens and dashboard password + TOTP screens.

### Tests

- `pnpm --filter @ride-app/auth-service test`: unit tests (role decoding, claims gating, allowlist, config rules).
- `pnpm --filter @ride-app/auth-service test:integration`: the real app against a throwaway `auth_service_test` database. Covers OTP sign-up and lockout, ES256 claims without PII, blocked endpoints, the staff-org guard, the 2FA/password gate, maker ≠ checker, `pv` invalidation, guest claim, city scoping, suspension (sessions and tokens die), the fleet invite-by-phone flow, and the internal driver role.
