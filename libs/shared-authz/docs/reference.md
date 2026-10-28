# API reference: `@ride-app/shared-authz`

Every export of [`src/index.ts`](../src/index.ts), grouped by source file. Catalogue contents are in [roles-and-permissions.md](roles-and-permissions.md); token details are in [tokens.md](tokens.md).

Contents: [roles.ts](#rolests) · [permissions.ts](#permissionsts) · [matrix.ts](#matrixts) · [registry.ts](#registryts) · [sync.ts](#syncts) · [principal.ts](#principalts) · [authorize.ts](#authorizets) · [verify.ts](#verifyts)

---

## roles.ts

### Types

```ts
type Audience = "ride-app" | "ride-admin";
type ScopeType = "SELF" | "ORG" | "CITY" | "GLOBAL";
type OrgKind = "FLEET" | "CORPORATE" | "STAFF_CITY" | "STAFF_HQ";
type RoleCode = keyof typeof ROLES;   // the 20 built-in codes
```

### `ROLES`

```ts
const ROLES: { readonly [code in RoleCode]: {
  audience: Audience;
  storage: { type: "user" } | { type: "member"; orgKinds: readonly OrgKind[] };
  stored: string;                     // lower-case Better Auth name
} };
```

Declared `as const satisfies Record<string, RoleDefinition>`. Built-in roles only; custom roles are in the registry. Table: [Role catalogue](roles-and-permissions.md#role-catalogue).

Call sites: auth-service (Better Auth access-control generation, role storage), `ROLES[code].audience` checks.

### `ROLE_CODES: RoleCode[]`

`Object.keys(ROLES)`, in declaration order.

### `roleFromStored(stored: string): RoleCode | undefined`

Built-in role code for a stored name. Trims the input. Only built-in roles; use [`roleByStored`](#rolebystoredstored-string-roleinfo--undefined) to include custom roles.

### `isRoleCode(value: string): value is RoleCode`

`Object.hasOwn(ROLES, value)`. Built-in only. Not imported outside the lib.

### `USER_ROLE_CODES: RoleCode[]`

Built-in roles with `storage.type === "user"` (kept on `user.role`). auth-service's Prisma schema comment on `User.role` refers to it.

### `GRANTABLE_STAFF_ROLES: RoleCode[]`

Built-in roles with audience `ride-admin`. Not imported outside the lib; auth-service uses the registry version [`grantableStaffRoles()`](#grantablestaffroles-roleinfo).

### `rolesForOrgKind(kind: OrgKind): RoleCode[]`

Built-in member roles whose `orgKinds` include `kind`. `STAFF_HQ` returns `[]`.

```ts
rolesForOrgKind("FLEET");      // ["FLEET_OWNER", "FLEET_DRIVER"]
```

---

## permissions.ts

### `PERMISSIONS` and `Permission`

```ts
const PERMISSIONS: readonly [ "trip:create", …, "session:revoke" ];  // 95 entries, as const
type Permission = (typeof PERMISSIONS)[number];
```

Format `resource:action`. Full list: [Permission catalogue](roles-and-permissions.md#permission-catalogue). Because `Permission` is a string-literal union, `authorize(p, "trip:asign")` is a compile error.

### `APPROVAL_PERMISSIONS: readonly Permission[]`

The 13 checker permissions ([list](roles-and-permissions.md#approval-permissions)). Informational; not imported outside the lib.

### `PENDING_ORG_PERMISSIONS: readonly Permission[]`

What a role in a partner organisation that isn't verified yet (`RoleAssignment.pending`) may still do: `org:update`, `org:manage_members`, `document:upload`, `vehicle:register`, `vehicle:read`, `ticket:create`. Fixed in code, not part of the editable matrix; applied by `grantingAssignments` / `can` / `authorize`. See [tokens.md → Pending organisations](tokens.md#pending-organisations).

### `PERMISSION_GROUPS: { name: string; prefixes: string[] }[]`

UI groups for the admin matrix editor ([table](roles-and-permissions.md#permission-groups)). Used by `apps/web`.

### `permissionGroup(permission: string): string`

Group name for the prefix before `:`, or `"Other"`.

```ts
permissionGroup("session:revoke");   // "Users"
permissionGroup("foo:bar");          // "Other"
```

### `isPermission(value: string): value is Permission`

`PERMISSIONS.includes(value)`. Used by `setAuthzSnapshot` to drop unknown permissions, and by auth-service when validating matrix changes.

---

## matrix.ts

### `ScopeLetter`

```ts
type ScopeLetter = "S" | "O" | "C" | "G";
```

### `MATRIX: Record<RoleCode, Partial<Record<Permission, ScopeLetter>>>`

The built-in role → permission → scope matrix. The comment in the file calls it "the single source of truth"; at runtime it's only the default (see [Live registry](roles-and-permissions.md#live-registry)). Each role has a single scope letter for all its grants (built with a local `each(scope, ...permissions)` helper). Contents: [Permissions by role](roles-and-permissions.md#permissions-by-role).

Read `MATRIX` directly only when you want the built-in default (auth-service seeding, guardrail tests). For a decision, use `authorize`/`can`, which read the live registry.

---

## registry.ts

### Types

```ts
type Grants = Partial<Record<Permission, ScopeLetter>>;
type RoleStorage = { type: "user" } | { type: "member"; orgKinds: readonly OrgKind[] };

interface RoleInfo {
  code: string;
  label: string;
  description?: string;
  audience: Audience;
  storage: RoleStorage;
  stored: string;          // lower-case name kept in Better Auth (user.role / member.role)
  builtIn: boolean;
  archived?: boolean;
}

interface AuthzSnapshot {
  version: number;
  roles: RoleInfo[];
  matrix: Record<string, Grants>;
}
```

`AuthzSnapshot` is also the JSON body of auth-service's `GET /internal/authz/snapshot` and `GET /api/identity/authz`.

### `ROLE_LABELS: Record<string, string>`

Display names for the 20 built-in roles (e.g. `CORPORATE_COORDINATOR` → `"Company travel desk"`). Used by `builtInSnapshot()`.

### `builtInSnapshot(): AuthzSnapshot`

A fresh snapshot from code: `version: 0`, every built-in role (`builtIn: true`, label from `ROLE_LABELS`), and a shallow copy of each role's `MATRIX` entry. auth-service seeds its `role_definition` / `role_permission` tables from it (`services/auth-service/src/authz/store.ts`).

### `setAuthzSnapshot(snapshot: AuthzSnapshot): void`

Replaces the process-wide registry.

- For each role in `snapshot.roles`, copies `snapshot.matrix[role.code]`, keeping only entries where the key passes `isPermission` and the value is one of `S/O/C/G`. Matrix entries for codes not in `snapshot.roles` are dropped.
- Rebuilds the code → role and stored-name → role lookups.
- Does not throw on bad input; it filters.

Call sites: `createAuthzSync` (all services), `services/auth-service/src/authz/service.ts` (after executing a change), `apps/web/src/lib/session.tsx`.

### `getAuthzSnapshot(): AuthzSnapshot`

The current snapshot (the same object, not a copy). Used by `createAuthzSync` to compare versions.

### `resetAuthzSnapshot(): void`

`setAuthzSnapshot(builtInSnapshot())`. For tests (`afterEach(resetAuthzSnapshot)` in `tests/registry.test.ts`).

### `roleInfo(code: string): RoleInfo | undefined`

Role from the current registry by code (archived roles included).

### `isKnownRole(code: string): boolean`

The role exists in the registry and isn't archived.

### `grantsOf(code: string): Grants`

Current grants of a role; `{}` for unknown codes.

### `roleByStored(stored: string): RoleInfo | undefined`

Role from the current registry by stored name (trimmed). Includes custom roles (test: `roleByStored("custom_qa")?.code === "CUSTOM_QA"`).

### `grantableStaffRoles(): RoleInfo[]`

Current roles with audience `ride-admin` that aren't archived (built-in and custom). Used by `apps/web` for the role-request form.

---

## sync.ts

### `AUTHZ_CHANNEL = "authz:changed"`

Redis pub/sub channel. auth-service publishes the new version on it after an approved matrix change.

### `RedisLike`

```ts
interface RedisLike {
  duplicate(): {
    subscribe(channel: string): Promise<unknown>;
    on(event: "message", listener: (channel: string, message: string) => void): unknown;
    quit(): Promise<unknown>;
  };
}
```

Structural subset of an ioredis client, so the lib has no Redis dependency. `duplicate()` is called because a subscribed connection can't run other commands.

### `AuthzSyncOptions`

```ts
interface AuthzSyncOptions {
  fetchSnapshot: () => Promise<AuthzSnapshot>;
  redis?: RedisLike;
  logger: { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };
  pollMs?: number;          // default 30_000
}
```

### `fetchAuthzSnapshotFrom(authInternalUrl: string, token: string): () => Promise<AuthzSnapshot>`

Returns a fetcher for `GET {authInternalUrl}/internal/authz/snapshot` with `authorization: Bearer {token}` and a 3 s timeout (`AbortSignal.timeout(3000)`). Throws `Error("auth-service answered {status}")` on a non-2xx response; network errors and timeouts propagate. The body is cast, not validated (validation happens in `setAuthzSnapshot`).

Services pass `config.AUTH_INTERNAL_URL` and `config.INTERNAL_SERVICE_TOKEN`.

### `createAuthzSync(opts: AuthzSyncOptions)`

```ts
function createAuthzSync(opts): {
  refresh(reason: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type AuthzSync = ReturnType<typeof createAuthzSync>;
```

| Method | Behaviour |
|---|---|
| `refresh(reason)` | Calls `fetchSnapshot()`. If the returned `version` differs from the current one (higher **or lower**), calls `setAuthzSnapshot` and logs `info "permission matrix updated"`. Any error is caught and logged as `warn "permission matrix refresh failed; keeping the current one"`. Never throws |
| `start()` | `await refresh("start")`; then, if `redis` is given, `duplicate()`, listen for `message` (any message on the connection triggers `refresh("published")`; the payload is ignored) and `subscribe(AUTHZ_CHANNEL)`; a subscribe error is logged (`"can't subscribe to permission changes; polling only"`). Then starts a `setInterval` poll (`refresh("poll")`, `pollMs` default 30 s), `unref()`'d so it doesn't keep the process alive |
| `stop()` | Clears the interval and `quit()`s the subscriber (errors swallowed) |

If auth-service is unreachable at start, the built-in matrix stays in force (version 0) until a later refresh succeeds.

Call sites: every service's `server.ts` (audit, fleet, location, notification, payment, platform, pricing, trip), realtime-gateway (`void createAuthzSync({ …, redis: pubClient, logger }).start()`), and auth-service itself with a DB loader: `createAuthzSync({ fetchSnapshot: () => loadAuthzSnapshot(db), … })` (`services/auth-service/src/container.ts`). mapping-service doesn't run a sync.

---

## principal.ts

### `RoleAssignment`, `Principal`, `RoleClaim`

See [tokens.md → Principal](tokens.md#principal) and [Role claims](tokens.md#role-claims).

### `toRoleClaim(a: RoleAssignment): RoleClaim`

Assignment → compact claim. Used by auth-service when building the JWT payload.

### `parseRoleClaims(raw: unknown, audience: Audience): RoleAssignment[]`

Claim array → assignments, dropping anything unknown, archived, malformed or of the other audience. Details: [tokens.md → parseRoleClaims](tokens.md#parseroleclaimsraw-audience). Also used by `apps/web` to read roles from its own token.

### `hasRole(principal: Principal, role: string): boolean`

Any assignment with that role code, any scope. Used by auth-service.

---

## authorize.ts

### `ResourceScope`

```ts
interface ResourceScope {
  ownerUserIds?: readonly string[];   // users who "own" the resource (rider and driver of a trip, the user themself…)
  orgId?: string | null;
  cityId?: string | null;
}
```

Pass what applies to the resource; omit the rest. An omitted attribute can't satisfy the matching scope letter (an empty `{}` resource only matches `G` grants and `C` grants held through a `GLOBAL` assignment).

### `AuthorizationError`

```ts
class AuthorizationError extends Error {
  readonly statusCode = 403;
  readonly code = "forbidden";
  readonly permission: Permission;
  // message: `missing permission ${permission} for this resource`
}
```

### `grantingAssignments(principal, permission, resource = {}): RoleAssignment[]`

The principal's assignments that grant `permission` on `resource`: for each assignment, look up `grantsOf(a.role)[permission]` in the live registry and check the scope letter with `covers()`:

| Letter | `covers()` returns true when |
|---|---|
| `G` | always |
| `S` | `resource.ownerUserIds?.includes(principal.userId)` |
| `O` | `a.scope === "ORG"` and `resource.orgId` is truthy and `a.orgId === resource.orgId` |
| `C` | `a.scope === "GLOBAL"`; or `a.scope === "CITY"` and `resource.cityId` is truthy and `a.cityId === resource.cityId` |

An assignment with `pending: true` counts only for `PENDING_ORG_PERMISSIONS` through an `O` grant; `citiesWith` ignores it.

Empty array means denied. Not imported outside the lib; useful when you need to know *which* assignment granted access (e.g. for an audit record).

### `can(principal, permission, resource = {}): boolean`

`grantingAssignments(...).length > 0`.

```ts
// apps/web/src/App.tsx: menu items
...item(can(p, "payout:prepare") || can(p, "payout:approve"), "/staff/money/payouts", "Payouts"),
// a city-scoped check in the web app
const inAnyCity = (p: Principal, permission: Permission) =>
  CITIES.some((cityId) => can(p, permission, { cityId })) || can(p, permission);
```

### `authorize(principal, permission, resource = {}): void`

Throws `AuthorizationError(permission)` unless `can(...)`. The one call every protected action makes. Real call sites from `services/trip-service/src/trips/service.ts`:

```ts
authorize(p, "trip:update_status", { ownerUserIds: [t.driverUserId] });     // S: the assigned driver
authorize(p, "trip:create_on_behalf", { cityId: quote.cityId });           // C: call center in that city
authorize(p, "trip:create_on_behalf", { orgId: input.billingOrgId });      // O: corporate coordinator
authorize(p, "trip:create", { ownerUserIds: [riderId], ...(input.billingOrgId ? { orgId: input.billingOrgId } : {}) });
authorize(p, "trip:assign", { cityId: t.cityId });                         // C: dispatcher
```

Notes:

- One call can match several letters: passing both `ownerUserIds` and `orgId` lets a rider (S) and a corporate admin (O) through the same check.
- The lib doesn't decide between 403 and 404. Services that must not reveal a resource exists catch the error or check `can` first.
- No audit record is written here.

### `citiesWith(principal, permission): string[] | "*"`

Cities in which the principal holds `permission`, for filtering list queries.

- Returns `"*"` as soon as any assignment has a `G` grant for it, or a `C` grant through a `GLOBAL` assignment.
- Otherwise returns the distinct `cityId`s of `CITY` assignments with a `C` grant.
- `S` and `O` grants are ignored: a rider with `trip:read` (S) gets `[]`.

```ts
// services/payment-service/src/money/balance-service.ts
const cities = citiesWith(p, "balance:read");
// "*" → no city filter; [] → nothing (or a 403); ["addis-ababa", …] → WHERE cityId IN (…)
```

---

## verify.ts

### `VerifierOptions`, `createTokenVerifier`, `VerifyAccessToken`, `TokenError`, `TokenCheckUnavailable`, `bearerToken`

Documented in [tokens.md](tokens.md#createtokenverifieroptions). Signatures:

```ts
interface VerifierOptions {
  issuer: string;
  jwksUrl?: string;
  keySet?: JWTVerifyGetKey;
  algorithms?: string[];                 // default ["ES256"]
  clockToleranceSeconds?: number;        // default 30
  isDenied?: (userId: string) => Promise<boolean>;
  currentPermissionVersion?: (userId: string) => Promise<number | undefined>;
}
function createTokenVerifier(options: VerifierOptions): (token: string, audience: Audience) => Promise<Principal>;
type VerifyAccessToken = ReturnType<typeof createTokenVerifier>;
class TokenError extends Error { statusCode: 401; code: "invalid_token" | "token_revoked" | "token_outdated" }
class TokenCheckUnavailable extends Error { statusCode: 503; code: "auth_unavailable"; cause: unknown } // isDenied / currentPermissionVersion threw
function bearerToken(header: string | undefined): string | undefined;
```
