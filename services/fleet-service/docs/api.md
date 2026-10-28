# HTTP API

Every route registered in `src/http/routes.ts` and `src/app.ts`. Business rules are in `src/fleet/service.ts`; the permission names are from `libs/shared-authz`.

- **Public** routes live under `/api/fleet` and are reached through Kong (`infra/kong/kong.yml`, route `fleet-routes`, `strip_path: false`).
- **Internal** routes live under `/internal` and are never routed by Kong.
- **Health** routes are at the root.

## Conventions

### Authentication

| Kind | Header | Notes |
|---|---|---|
| User token | `Authorization: Bearer <access token>` | Audience `ride-app` (phone app, partners) is tried first, then `ride-admin` (staff). Both are accepted on every public route |
| Service token | `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` | `/internal/*` only. Constant-time comparison |
| File ticket | none (the ticket is in the path) | `/api/fleet/files/:ticket`, only when `STORAGE=local` |

"Who" below is written as `permission @ scope`. `SELF` means the resource belongs to the caller, `ORG` the caller's organisation, `CITY` the resource's city (or a `GLOBAL` assignment). "Any signed-in user" means no permission is checked beyond a valid token.

### Errors

All errors are JSON `{ "error": "<code>", "message": "<text>" }` (`src/middlewares/error-handler.ts`).

| Status | `error` | When |
|---|---|---|
| 400 | `validation_error` | zod rejected params, query or body; the body also has `issues: [{ path, message }]` |
| 400 | `bad_request` or a specific code | Business rule (codes per route below) |
| 401 | `unauthorized` | No bearer token, or invalid service token / file ticket |
| 401 | `invalid_token` | Signature, issuer, audience or expiry wrong (for both audiences) |
| 401 | `token_revoked` | User is in the Redis deny list (suspended) |
| 401 | `token_outdated` | Token's permission version is older than Redis `pv:{userId}`: refresh the token |
| 403 | `forbidden` | Missing permission for this resource (`AuthorizationError`, message `missing permission <perm> for this resource`) or an explicit ownership refusal |
| 404 | `not_found` | `"<thing> not found"`, or unknown route |
| 409 | `conflict` or a specific code | State conflicts; `user_not_found` when auth-service has no account for the driver (approve, suspend, reinstate) |
| 413 | `FST_ERR_CTP_BODY_TOO_LARGE` | Body over 32 KB (10 MB on the local upload route) |
| 422 | `idempotency_mismatch` | `Idempotency-Key` reused with a different request |
| 429 | (from `@fastify/rate-limit`) | More than 300 requests per minute from one IP |
| 503 | `dependency_unavailable` | auth-service unreachable, timed out (3 s) or answered non-2xx other than 404 |
| 503 | `auth_unavailable` | Redis deny-list / permission-version lookup failed (`TokenCheckUnavailable`); sent with `retry-after: 5`, logged warn `token check unavailable (Redis)`. The token is refused, retry later |
| 500 | `internal_error` | Anything unexpected (logged) |

Request bodies are parsed before the token is checked on most routes, so an invalid body returns 400 even without a token.

### Limits

- Rate limit: 300 requests / minute / client IP in the service (all routes), 120 / minute on `/api/fleet` in Kong.
- Body: 32 KB (JSON routes); 10 MB on `PUT /api/fleet/files/:ticket`.
- Path parameters: up to 1024 characters (`maxParamLength`, for signed file links).
- Idempotency: only `POST /api/fleet/sessions` honours `Idempotency-Key` (see [architecture.md §10](architecture.md#10-caching-and-idempotency)).

### Common response shapes

**Driver** (`driverView`):

| Field | Type | Notes |
|---|---|---|
| `userId` | uuid | Same id as the auth-service user |
| `status` | `APPLIED` \| `PENDING_REVIEW` \| `ACTIVE` \| `SUSPENDED` | |
| `statusReason` | `SAFETY` \| `DOCUMENT_EXPIRED` \| null | When suspended |
| `reviewNote` | string \| null | Last officer note / suspension reason |
| `fullName` | string | |
| `licenseNumber` | string | Full (normalised) for the driver themself and PII-allowed staff, else `"•••• " + last 4` |
| `cityId` | string | |
| `submittedAt`, `activatedAt`, `createdAt` | ISO 8601 \| null | |

**Vehicle** (`vehicleView`): `id`, `plateNumber`, `ownerType` (`INDIVIDUAL` \| `ORGANIZATION`), `ownerUserId`, `ownerOrgId`, `vehicleType`, `make`, `model`, `year`, `color`, `seats`, `status` (`DRAFT` \| `PENDING_REVIEW` \| `VERIFIED` \| `REJECTED` \| `SUSPENDED` \| `RETIRED`), `statusReason`, `reviewNote`, `cityId`, `submittedAt`, `verifiedAt`, `createdAt`.

**Document** (`documentView`): `id`, `subjectType`, `subjectId`, `kind`, `status` (`PENDING` \| `APPROVED` \| `REJECTED` \| `EXPIRED` \| `SUPERSEDED`), `contentType`, `sizeBytes`, `expiresAt` (`YYYY-MM-DD` \| null), `expiringSoon` (approved and due within `documents.expiryWarningDays`), `rejectReason`, `uploadedBy`, `reviewedBy`, `reviewedAt`, `createdAt`.

**Checklist** (merged into driver, vehicle and document-list responses):

```json
{
  "documents": [{ "kind": "LICENSE", "required": true, "expires": true, "document": { "...documentView or null": "" } }],
  "missingForSubmit": ["PHOTO"],
  "missingForApproval": ["LICENSE", "PHOTO"]
}
```

`documents` has one entry per required kind of the subject, with its current (newest non-superseded) document.

**Session** (`sessionView`): `id`, `driverUserId`, `vehicleId`, `startedAt`, `endedAt` (null while open), `endReason`.

---

## Drivers: the applicant / driver (phone app)

### `POST /api/fleet/drivers/apply`

| | |
|---|---|
| Who | `driver:apply @ SELF` (`RIDER`) |
| Body | `fullName` string 3–120 (trimmed) · `licenseNumber` string 5–30 (trimmed) · `cityId` string 1–40 |
| 201 | Driver (full licence), status `APPLIED` |
| Errors | 400 `unknown_city` (not in `CITIES`: `addis-ababa`, `hawassa`) · 400 `invalid_licence` (after removing spaces/dashes and upper-casing, not 5–20 `[A-Z0-9]`) · 409 `already_applied` · 409 `licence_registered` (blind index exists, including a race on the unique index) |
| Events | `driver.applied` |

### `GET /api/fleet/drivers/me`

| | |
|---|---|
| Who | Any signed-in user |
| 200 | `{ driver: (Driver + Checklist) \| null, vehicles: Vehicle[], fleetVehicles: (Vehicle + { authorization: { validUntil } })[], session: Session \| null }` |
| Notes | `vehicles`: the caller's non-retired `INDIVIDUAL` cars, oldest first. `fleetVehicles`: cars with an `ACTIVE` authorisation for the caller (retired ones included). `driver` is null if they never applied |

### `POST /api/fleet/drivers/me/submit`

| | |
|---|---|
| Who | `driver:apply @ SELF` |
| 200 | Driver (full licence), status `PENDING_REVIEW` |
| Errors | 404 `not_found` (no profile) · 409 `invalid_state` (not `APPLIED`, and not `SUSPENDED` with reason `DOCUMENT_EXPIRED`) · 400 `documents_missing` (message lists the kinds) |
| Events | `driver.submitted` |

### `GET /api/fleet/drivers/me/vehicles`

| | |
|---|---|
| Who | Any signed-in user |
| 200 | `{ vehicles: (Vehicle + { canDrive: boolean, denial: string \| null, message: string \| null })[] }` |
| Notes | Every non-retired owned car and every non-retired car with an `ACTIVE` authorisation, evaluated with the going-online rules ([architecture.md §8](architecture.md#8-driving-sessions)). The balance is not checked here |

## Drivers: staff and fleet owners (web)

### `GET /api/fleet/review/queue`

| | |
|---|---|
| Who | `driver:read`, `vehicle:read` or `document:review` @ `CITY` of `cityId` |
| Query | `cityId` string 1–40 (required) |
| 200 | `{ drivers: (Driver masked + { pendingDocuments })[], vehicles: (Vehicle + { pendingDocuments })[], organizations: { orgId, pendingDocuments, oldest }[], expiringSoon: number }` |
| Notes | `drivers` only with `driver:read`, `vehicles` only with `vehicle:read` (empty arrays otherwise). Max 200 each, oldest `submittedAt` first. See [architecture.md §6](architecture.md#6-review-queue) |

### `GET /api/fleet/drivers`

| | |
|---|---|
| Who | `driver:read @ CITY` of `cityId` |
| Query | `cityId` (required) · `status` one of the driver statuses · `q` string ≤ 60 · `limit` int 1–200, default 100 |
| 200 | `{ drivers: Driver[] }` (masked licence), most recently updated first |
| Notes | `q` matches `fullName` (contains, case-insensitive) **or** `licenseLast4` equal to the last 4 characters of `q` upper-cased |

### `GET /api/fleet/drivers/:userId`

| | |
|---|---|
| Who | The driver themself; or `driver:read @ CITY` of the driver; or, with `?orgId=`, `driver:read @ ORG` (fleet owner) and auth-service confirms the driver is a member of that org |
| Params / query | `userId` uuid · `orgId` uuid (optional) |
| 200 | Driver + Checklist + `{ vehicles: Vehicle[] (all owned, retired included), fleetVehicles: (Vehicle + { authorization: { status, validUntil } })[] (all authorisations), session }`. A fleet owner (`?orgId=`, without `driver:read @ CITY`) sees only that fleet: `vehicles` is `[]`, `fleetVehicles` only the org's cars, `session` only when it's in one of them |
| Errors | 404 `not_found` (no profile, or not a member of `orgId`) · 403 · 503 (auth-service, with `orgId`) |
| Notes | Full licence for the driver themself and for staff with `user:read_pii @ CITY`; each such staff read writes `audit.recorded` (`user:read_pii`). Fleet owners always see the masked licence |

### `POST /api/fleet/drivers/:userId/approve`

| | |
|---|---|
| Who | `driver:verify @ CITY` **and** `driver:activate @ CITY` |
| Body | none |
| 200 | Driver (masked), status `ACTIVE` |
| Errors | 404 · 403 · 409 `invalid_state` (not `PENDING_REVIEW`) · 409 `documents_not_approved` · 503 `dependency_unavailable` (auth-service couldn't add `DRIVER`; nothing changed) · 409 `user_not_found` (auth-service has no account for this driver; nothing changed) |
| Events | `driver.activated`, `audit.recorded` (`driver:activate`) |
| Notes | Calls auth-service `POST /internal/drivers/:userId/role {active:true}` inside the transaction (15 s transaction timeout) |

### `POST /api/fleet/drivers/:userId/request-changes`

| | |
|---|---|
| Who | `driver:verify @ CITY` |
| Body | `reason` string 3–500 (trimmed) |
| 200 | Driver (masked), status `APPLIED`, `reviewNote` = reason |
| Errors | 404 · 403 · 409 `invalid_state` (not `PENDING_REVIEW`) |
| Events | `driver.changes_requested` |

### `POST /api/fleet/drivers/:userId/suspend`

| | |
|---|---|
| Who | `driver:suspend @ CITY` (onboarding or safety officer) |
| Body | `reason` string 10–500 |
| 200 | Driver (masked), status `SUSPENDED`, `statusReason: "SAFETY"`. Already suspended → current driver, nothing written |
| Errors | 404 · 403 · 503 `dependency_unavailable` (auth-service couldn't remove `DRIVER`; nothing changed, retry) · 409 `user_not_found` (auth-service has no such user) |
| Events | `driver.offline` (`SUSPENDED`, if online), `driver.suspended`, `audit.recorded` (`driver:suspend`) |
| Notes | Calls auth-service `POST /internal/drivers/:userId/role {active:false}` inside the transaction (15 s transaction timeout), so the `DRIVER` role goes and open tokens become `token_outdated` |

### `POST /api/fleet/drivers/:userId/reinstate`

| | |
|---|---|
| Who | `driver:reinstate @ CITY` |
| Body | `reason` string 10–500 |
| 200 | Driver (masked), status `ACTIVE` |
| Errors | 404 · 403 · 409 `invalid_state` (not suspended) · 409 `documents_not_approved` · 503 `dependency_unavailable` (auth-service couldn't add `DRIVER`; nothing changed) · 409 `user_not_found` |
| Events | `driver.reinstated`, `audit.recorded` (`driver:reinstate`) |
| Notes | Calls auth-service `POST /internal/drivers/:userId/role {active:true}` inside the transaction (15 s transaction timeout) |

### `GET /api/fleet/stats`

| | |
|---|---|
| Who | `report:read`, at `CITY` of `cityId` if given; without `cityId` only a `GLOBAL`-scope grant passes |
| Query | `cityId` (optional) |
| 200 | `{ drivers: { [status]: count }, vehicles: { [status]: count }, pendingDocuments: number, online: number }` |
| Notes | Used by the admin overview page. `online` = open sessions (filtered by the vehicle's city) |

## Vehicles

### `POST /api/fleet/vehicles`

| | |
|---|---|
| Who | `INDIVIDUAL`: `vehicle:register @ SELF` or `driver:apply @ SELF`, and the caller has a driver profile. `ORGANIZATION`: `vehicle:register @ ORG` of `ownerOrgId` |
| Body | `ownerType` `INDIVIDUAL` \| `ORGANIZATION` · `ownerOrgId` uuid (required for `ORGANIZATION`, ignored otherwise) · `plateNumber` 3–20 · `vehicleType` 1–30 · `make` 1–40 · `model` 1–40 · `year` int · `color` 1–30 · `seats` int |
| 201 | Vehicle, status `DRAFT`, city of the driver profile or organisation |
| Errors | 400 `invalid_vehicle_type` (not `economy` / `comfort` / `minivan`) · 400 `invalid_seats` (economy/comfort 3–4, minivan 5–8) · 400 `invalid_year` (< 1990 or > next year) · 400 `not_a_driver` · 400 `bad_request` (missing `ownerOrgId`) · 400 `not_a_fleet` (auth-service doesn't know the org, or it isn't `FLEET`) · 409 `org_not_verified` · 409 `plate_registered` · 403 · 503 |
| Notes | Plate normalised: trimmed, whitespace collapsed, upper case. No event |

### `GET /api/fleet/vehicles`

| | |
|---|---|
| Who | With `ownerOrgId`: `vehicle:read @ ORG`, or, when `cityId` is also given and the caller has no org grant, `vehicle:read @ CITY` of `cityId` (city staff such as onboarding officers looking at a company: only the company's cars in that city). Else with `cityId`: `vehicle:read @ CITY`. Else: the caller's own cars, no permission |
| Query | `ownerOrgId` uuid · `cityId` 1–40 · `status` vehicle status · `limit` 1–200, default 100 |
| 200 | `{ vehicles: Vehicle[] }`, newest first |
| Notes | With an org grant, `ownerOrgId` wins over `cityId` (all the company's cars). "Mine" includes retired cars unless `status` filters them out |

### `GET /api/fleet/vehicles/:id`

| | |
|---|---|
| Who | The owner-driver; `vehicle:read @ ORG` of the owning fleet; `vehicle:read @ CITY` |
| 200 | Vehicle + Checklist + `{ authorizations: { driverUserId, status, validUntil, grantedBy, createdAt, revokedAt }[], session: Session \| null }` |
| Errors | 404 · 403 |

### `POST /api/fleet/vehicles/:id/submit`

| | |
|---|---|
| Who | The owner-driver, or `vehicle:register @ ORG` of the owning fleet |
| 200 | Vehicle, status `PENDING_REVIEW` |
| Errors | 404 · 403 `forbidden` ("not your vehicle") · 409 `invalid_state` (not `DRAFT` / `REJECTED` / `SUSPENDED`+`DOCUMENT_EXPIRED`) · 400 `documents_missing` |
| Events | `vehicle.submitted` |

### `POST /api/fleet/vehicles/:id/retire`

| | |
|---|---|
| Who | The owner-driver, or `vehicle:retire @ ORG` of the owning fleet |
| 200 | Vehicle, status `RETIRED` (unchanged if already retired) |
| Errors | 404 · 403 `forbidden` |
| Events | `driver.offline` (`VEHICLE_UNAVAILABLE`, if in use), `vehicle.retired` (`reason: "owner removed it"`) |
| Notes | Revokes every active authorisation of the car |

### `POST /api/fleet/vehicles/:id/approve`

| | |
|---|---|
| Who | `vehicle:verify @ CITY` |
| 200 | Vehicle, status `VERIFIED` |
| Errors | 404 · 403 · 409 `invalid_state` (not `PENDING_REVIEW`) · 409 `documents_not_approved` · fleet car: 400 `not_a_fleet`, 409 `org_not_verified`, 503 |
| Events | `vehicle.verified`, `audit.recorded` (`vehicle:verify`) |

### `POST /api/fleet/vehicles/:id/reject`

| | |
|---|---|
| Who | `vehicle:verify @ CITY` |
| Body | `reason` 3–500 |
| 200 | Vehicle, status `REJECTED`, `reviewNote` = reason |
| Errors | 404 · 403 · 409 `invalid_state` |
| Events | `vehicle.rejected`, `audit.recorded` (`vehicle:reject`) |

### `POST /api/fleet/vehicles/:id/authorizations`

| | |
|---|---|
| Who | `vehicle:authorize_driver @ ORG` of the owning fleet |
| Body | `driverUserId` uuid · `validUntil` date (anything `new Date()` accepts; optional) |
| 201 | `{ vehicleId, driverUserId, status: "ACTIVE", validUntil }` |
| Errors | 404 · 400 `not_a_fleet_vehicle` · 403 · 409 `invalid_state` (retired) · 400 `not_a_fleet_driver` (auth-service has no membership with role `fleet_driver`) · 400 `bad_request` (`validUntil` not in the future) · 503 |
| Events | `vehicle.driver_authorized` |
| Notes | Upsert; granting again re-activates |

### `DELETE /api/fleet/vehicles/:id/authorizations/:driverUserId`

| | |
|---|---|
| Who | `vehicle:authorize_driver @ ORG` |
| 200 | `{ vehicleId, driverUserId, status: "REVOKED" }` (also when there was nothing to revoke) |
| Errors | 404 · 400 `not_a_fleet_vehicle` · 403 |
| Events | `driver.offline` (`VEHICLE_UNAVAILABLE`, if that driver is in that car), `vehicle.driver_unauthorized` |

### `GET /api/fleet/organizations/:id/overview`

| | |
|---|---|
| Who | `vehicle:read @ ORG` |
| Query | `members` comma-separated uuids, ≤ 4000 characters, default empty; only the first 100 are used |
| 200 | `{ vehicles: (Vehicle + Checklist + authorizations + session)[], drivers: { userId, driver: { status, statusReason, fullName, activatedAt } \| null, session: Session \| null }[] }` |
| Errors | 400 `bad_request` ("members: comma-separated user ids") · 403 · 503 |
| Notes | Each member id is checked with auth-service; unknown ids are dropped. `driver` is null unless the caller also has `driver:read @ ORG` |

## Documents

### `POST /api/fleet/documents/upload-url`

| | |
|---|---|
| Who | See [architecture.md §5](architecture.md#upload-flow): the driver for `DRIVER`; the owner-driver or `document:upload @ ORG` for `VEHICLE`; `document:upload @ ORG` for `ORGANIZATION` |
| Body | `subjectType` `DRIVER` \| `VEHICLE` \| `ORGANIZATION` · `subjectId` uuid · `kind` one of the eight kinds · `contentType` `image/jpeg` \| `image/png` \| `application/pdf` · `sizeBytes` int 1–10 485 760 · `sha256` 64 hex characters |
| 200 | `{ uploadUrl, headers: { "content-type": … }, ticket, expiresIn: 300 }` |
| Errors | 400 `invalid_kind` · 400 `file_too_large` · 403 `forbidden` ("drivers upload their own documents", "not your vehicle") · 404 (driver profile, vehicle or organisation) · 409 `invalid_state` (retired vehicle) · 503 |
| Notes | `uploadUrl` is absolute (S3) or relative `/api/fleet/files/…` (local). The URL is valid 5 min, the ticket 15 min |

### `POST /api/fleet/documents`

| | |
|---|---|
| Who | The user the ticket was issued to |
| Body | `ticket` string 20–4000 · `expiresAt` `YYYY-MM-DD` (optional; required for `LICENSE`, `INSURANCE`, `INSPECTION`) |
| 201 | Document, status `PENDING` |
| Errors | 400 `invalid_ticket` (bad signature, expired, other user) · 400 `expiry_required` · 400 `document_expired` (date before today) · 400 `upload_missing` · 400 `upload_mismatch` (size, or hash on local storage) · 400 `bad_request` (unparseable date) |
| Notes | Supersedes the previous document of the same subject and kind. Confirming twice returns the same document |

### `GET /api/fleet/documents`

| | |
|---|---|
| Who | Owner side: the driver (own `DRIVER` documents), the owner-driver or `vehicle:read @ ORG` (vehicle), `document:upload @ ORG` (organisation). Otherwise `document:read @ CITY` |
| Query | `subjectType` · `subjectId` uuid |
| 200 | Checklist + `{ history: Document[] }` (every document of the subject, newest first, superseded included) |
| Errors | 403 · 404 (organisation unknown to auth-service, for staff) · 503 |
| Notes | For a `DRIVER` or `VEHICLE` subject the staff city comes from the newest document; a subject with no documents gives staff 403 unless their grant is `GLOBAL`. Not audited |

### `GET /api/fleet/documents/:id/url`

| | |
|---|---|
| Who | As for `GET /documents` |
| 200 | `{ url, contentType, expiresIn: 300 }` with `cache-control: no-store` |
| Errors | 404 · 403 |
| Events | `audit.recorded` (`document:view`, `ALLOWED`) for every staff view |

### `POST /api/fleet/documents/:id/review`

| | |
|---|---|
| Who | `document:review @ CITY` of the document |
| Body | `decision` `APPROVE` \| `REJECT` · `reason` string ≤ 500 (required ≥ 3 for `REJECT`) · `expiresAt` `YYYY-MM-DD` (optional, `APPROVE` only; overrides the uploaded date) |
| 200 | Document, status `APPROVED` or `REJECTED` |
| Errors | 404 · 403 · 409 `invalid_state` (not `PENDING`) · 400 `expiry_required` · 400 `document_expired` · 400 `reason_required` |
| Events | `audit.recorded` (`document:approve` / `document:reject`) |

## Driving sessions

### `POST /api/fleet/sessions`

| | |
|---|---|
| Who | Any signed-in user; the going-online rules decide |
| Headers | `Idempotency-Key` (optional) 8–100 of `[A-Za-z0-9_-]` |
| Body | `vehicleId` uuid |
| 201 | Session (also when already online with this vehicle) |
| Errors | 404 (vehicle) · 409 `already_online` (online with another vehicle) · 403 `driver_not_active` / `documents_expired` / `vehicle_not_verified` / `not_your_vehicle` / `not_in_this_fleet` / `not_authorized_for_vehicle` · 409 `vehicle_in_use` · 403 `balance_blocked` · 400 `bad_request` (bad key) · 409 `request_in_progress` · 422 `idempotency_mismatch` |
| Events | `driver.online` |
| Notes | Asks payment-service for the balance state (2 s timeout; failure doesn't block). Rules: [architecture.md §8](architecture.md#8-driving-sessions) |

### `GET /api/fleet/sessions/current`

| | |
|---|---|
| Who | Any signed-in user |
| 200 | `{ session: Session \| null }` |

### `DELETE /api/fleet/sessions/current`

| | |
|---|---|
| Who | Any signed-in user (their own session) |
| 200 | `{ session: Session \| null }` (the ended session with `endReason: "DRIVER"`, or null if not online) |
| Events | `driver.offline` (`DRIVER`) |

## Phase 2D: vehicle suspension, ownership transfers, a fleet's expiring documents

### `POST /api/fleet/vehicles/:id/suspend`

| | |
|---|---|
| Who | `driver:suspend @ CITY(vehicle)` (onboarding or safety officer). The matrix has no `vehicle:suspend`; taking a car off the road uses the driver permission |
| Body | `reason` string 10–500, `category?` `SAFETY` (default) \| `ONBOARDING` |
| 200 | Vehicle, status `SUSPENDED`, `statusReason` = category, `reviewNote` = reason. Already suspended → current vehicle, nothing written |
| Errors | 404 · 403 · 409 `invalid_state` (only `VERIFIED` cars are suspended) |
| Events | `driver.offline` (`VEHICLE_UNAVAILABLE`, if a session was open: it ends now), `vehicle.suspended` (`byUserId` = staff), `audit.recorded` (`vehicle:suspend`) |

### `POST /api/fleet/vehicles/:id/reinstate`

| | |
|---|---|
| Who | `driver:reinstate @ CITY(vehicle)` |
| Body | `reason` string 10–500 |
| 200 | Vehicle, status `VERIFIED` |
| Errors | 404 · 403 · 409 `invalid_state` (not suspended) · 409 `documents_not_approved` (every document approved and in date) · 409 `org_not_verified` (fleet car whose company isn't verified or is suspended) · 503 (auth-service down, fleet cars) |
| Events | `vehicle.reinstated`, `audit.recorded` (`vehicle:reinstate`) |
| Notes | Works for any suspension reason, including `DOCUMENT_EXPIRED` once the renewed documents are approved |

### Ownership transfers (rule V9, maker–checker)

States: `REQUESTED` (the current owner asked) → `PENDING` (an onboarding officer proposed it: the maker) → `EXECUTED` (a **different** officer approved: the checker). Staff may start at `PENDING`. Open transfers may be `REJECTED` by an officer (not the maker) or `CANCELLED` by whoever opened them; after 7 days they're `EXPIRED` (hourly job, and refused on use). One open transfer per vehicle (`ux_transfer_vehicle_open`). The approval runs in fleet-service (the resource's owner), not in auth-service's approvals inbox; both halves use `vehicle:transfer @ CITY` (Role.md §11: "a second onboarding officer").

`Transfer` = `{ id, vehicleId, cityId, status, from: { type, id, name }, to: { type, id, name }, reason, requestedBy, makerId, checkerId, decisionNote, expiresAt, decidedAt, createdAt, vehicle?: { plateNumber, make, model, color, status } }` (`name` = the driver's full name for `INDIVIDUAL`, null for companies; an open transfer past `expiresAt` reads `EXPIRED`).

| Method + path | Who | Body / query | Result |
|---|---|---|---|
| `POST /api/fleet/vehicles/:id/transfers` | the current owner (owner-driver with `vehicle:retire @ SELF`; fleet with `vehicle:retire @ ORG`) → `REQUESTED`; or `vehicle:transfer @ CITY` → `PENDING` with the caller as maker | `toOwnerType` `INDIVIDUAL`\|`ORGANIZATION`, `toOwnerId` uuid, `reason` 10–500 | 201 Transfer. 400 `same_owner` · 400 `not_a_fleet` · 409 `org_not_verified` (receiving fleet must be `VERIFIED`) · 400 `not_a_driver` (a new owner-driver must have a driver profile) · 409 `invalid_state` (retired) · 409 `transfer_pending`. Audit `vehicle:transfer:request` (`PENDING_APPROVAL`) |
| `GET /api/fleet/vehicles/:id/transfers` | anyone who may read the vehicle (owner, fleet `vehicle:read @ ORG`, staff `vehicle:read`/`vehicle:transfer @ CITY`) | — | `{ transfers }` newest first (50) |
| `GET /api/fleet/transfers` | `cityId`: `vehicle:transfer` or `vehicle:read @ CITY`; `ownerOrgId`: `vehicle:read @ ORG` (transfers out of **and into** the fleet); neither: the caller's own (as owner-driver, either way) | `cityId?`, `ownerOrgId?`, `status?`, `limit` 1–200 (100) | `{ transfers }` |
| `POST /api/fleet/transfers/:id/endorse` | `vehicle:transfer @ CITY(transfer)` | `note?` ≤ 500 | `REQUESTED → PENDING`, caller = maker. 409 `not_requested` · `expired` · `not_open` · `state_changed`. Audit `vehicle:transfer:propose` |
| `POST /api/fleet/transfers/:id/approve` | `vehicle:transfer @ CITY`, not the maker (403 `maker_is_checker`) | `note?` | Executes (below). 409 `not_proposed` (still `REQUESTED`) · `expired` · `not_open` · `owner_changed` · `invalid_state` (retired) · `org_not_verified` |
| `POST /api/fleet/transfers/:id/reject` | `vehicle:transfer @ CITY`, not the maker | `reason` 10–500 | `REJECTED`. Audit `vehicle:transfer:reject` |
| `POST /api/fleet/transfers/:id/cancel` | whoever opened it (`requestedBy` or `makerId`) | — | `CANCELLED`. Audit `vehicle:transfer:cancel` |

**What approval does (one transaction):** the open driving session ends (`driver.offline VEHICLE_UNAVAILABLE`); every active `vehicle_authorization` is revoked; the current `REGISTRATION` document is `SUPERSEDED` (it names the old owner) and other approved documents go back to `PENDING` (checked again); the vehicle's owner fields switch (single-owner CHECK holds), `city_id` becomes the new owner's city (documents too), status `DRAFT` with `statusReason: "TRANSFERRED"`, `verifiedAt`/`submittedAt` cleared, `version + 1`. The new owner uploads a registration naming them and submits as usual (`POST /vehicles/:id/submit`). Events `vehicle.transferred` + audit `vehicle:transfer` (`EXECUTED`). Past trips keep their snapshot (Role.md §6).

### `GET /api/fleet/organizations/:id/expiring-documents`

| | |
|---|---|
| Who | `document:read @ CITY(org)` (onboarding officers). Documents of other cities are left out unless the caller reads them too |
| Query | `days` 1–120 (default 30) |
| 200 | `{ orgId, days, until, documents: [Document + { daysLeft, vehicle: { id, plateNumber, status } \| null }] }`, soonest first (up to 500): the company's own documents and those of its non-retired cars that are `EXPIRED` (and not yet replaced) or `APPROVED` with `expiresAt` ≤ today + `days` |
| Errors | 404 (unknown id or not a fleet, via auth-service) · 403 · 503 |

## Local file storage (`STORAGE=local` only)

Registered only when the store is the local one; in production config refuses `STORAGE=local`, so these routes don't exist there.

### `PUT /api/fleet/files/:ticket`

| | |
|---|---|
| Who | Holder of a valid `put` ticket (from `upload-url`) |
| Headers | `content-type` exactly the announced type |
| Body | Raw bytes, exactly the announced size, ≤ 10 MB |
| 200 | `{ ok: true }` |
| Errors | 401 `unauthorized` ("upload link invalid or expired") · 400 `upload_mismatch` · 415 (unsupported content type, from Fastify) |

### `GET /api/fleet/files/:ticket`

| | |
|---|---|
| Who | Holder of a valid `get` ticket (from `documents/:id/url`) |
| 200 | The file, `content-type` from the key's extension, `cache-control: private, no-store`, `content-disposition: inline` |
| Errors | 401 `unauthorized` ("link invalid or expired") · 404 |

## Health

| Route | Response | Notes |
|---|---|---|
| `GET /health` | `{ status: "ok" }` | Used by the Dockerfile `HEALTHCHECK` |
| `GET /health/live` | `{ status: "ok" }` | Process is up |
| `GET /health/ready` | `{ status: "ok" }` or 503 `{ status: "unavailable" }` | Runs `SELECT 1`. Doesn't check Redis, Kafka or storage. Polled by platform-service's system page |

No authentication; the global rate limit applies.

## Internal (`/internal/*`, service token)

All return 401 `unauthorized` ("invalid service credentials") without the right token.

| Route | Caller (in this repo) | Response |
|---|---|---|
| `GET /internal/ops/outbox` | platform-service system page (`services/platform-service/src/system/health.ts`) | `{ pending: number, oldestAt: ISO \| null }` (unpublished outbox rows) |
| `GET /internal/ops/storage` | platform-service system page | `{ kind: "s3" \| "local", ok: boolean, detail?: string }` |
| `GET /internal/drivers/:userId/session` | none found in code (comment says trip-service / payment-service) | `{ sessionId, vehicleId, vehicleType, ownerType, beneficiaryId }` where `beneficiaryId` = owning org, else owner-driver. 404 `not_found` when not online. 400 for a non-uuid id |
| `GET /internal/vehicles/:id` | trip-service `partiesClient` (`services/trip-service/src/lib/clients.ts`), for `GET /api/trips/:id/parties` | `{ id, plateNumber, vehicleType, make, model, color }`. 404 `not_found` |
