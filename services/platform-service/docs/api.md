# platform-service HTTP API

Source: `src/http/routes.ts`, `src/app.ts`. All `/api/platform/*` routes are reachable through Kong (`infra/kong/kong.yml`, route `platform-routes`). `/internal/*` and `/health*` are not routed by Kong.

## Common rules

| Rule | Value |
|---|---|
| Body limit | 32 KB (`bodyLimit`) |
| Rate limit (service) | 300 requests / minute per client IP, every route (`@fastify/rate-limit` default key) |
| Rate limit (Kong) | 120 / minute on `/api/platform` (Kong `rate-limiting`, `policy: local`) |
| Staff token | `Authorization: Bearer <access token>` with audience `ride-admin` |
| Service token | `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` |
| Permission check | `authorize(principal, permission)` with no resource, so a global grant is needed |
| `reason` field | trimmed string, 5–500 characters |
| City id (`cityId`, `:id`) | `^[a-z0-9-]{1,40}$` in the route; creating or updating a city additionally needs 2–40 characters |

## Routes

| Method and path | Caller | Permission | Success |
|---|---|---|---|
| `GET /health`, `GET /health/live` | probes | none | `200 { status: "ok" }` |
| `GET /health/ready` | probes, system page | none | `200 { status: "ok" }` or `503 { status: "unavailable" }` (Postgres `SELECT 1`) |
| `GET /api/platform/client-config` | phone app, web (no token) | none | `200` |
| `GET /api/platform/settings` | web admin | `settings:read` | `200` |
| `GET /api/platform/settings/history` | web admin | `settings:read` | `200` |
| `PUT /api/platform/settings/:key` | web admin | `settings:propose` | `200` applied / `202` pending |
| `GET /api/platform/settings/changes` | web admin | `settings:read` | `200` |
| `POST /api/platform/settings/changes/:id/approve` | web admin | `settings:approve` | `200` |
| `POST /api/platform/settings/changes/:id/reject` | web admin | `settings:approve` | `200` |
| `POST /api/platform/settings/changes/:id/cancel` | web admin (the maker) | none (staff token only) | `200` |
| `GET /api/platform/cities` | web admin | `settings:read` | `200` |
| `POST /api/platform/cities` | web admin | `city:manage` | `201` |
| `PUT /api/platform/cities/:id` | web admin | `city:manage` | `200` |
| `GET /api/platform/vehicle-types` | web admin | `settings:read` | `200` |
| `PUT /api/platform/vehicle-types/:code` | web admin | `city:manage` | `200` (create or update) |
| `GET /api/platform/announcements` | web admin | `announcement:manage` | `200` |
| `POST /api/platform/announcements` | web admin | `announcement:manage` | `201` |
| `PUT /api/platform/announcements/:id` | web admin | `announcement:manage` | `200` |
| `POST /api/platform/announcements/:id/archive` | web admin | `announcement:manage` | `200` |
| `GET /api/platform/system` | web admin | `system:read` | `200` |
| `GET /internal/settings/snapshot` | trip, pricing, payment, notification, fleet (via `libs/shared-settings`) | service token | `200` |

## Details

### `GET /api/platform/client-config`

Query:

| Param | Type | Notes |
|---|---|---|
| `audience` | `rider \| driver \| partner \| staff`, optional | Filters announcements by audience. Without it, all audiences' announcements are returned |
| `cityId` | city id, optional | Filters announcements to those for this city or for every city |

Response header `cache-control: public, max-age=15`. Body:

```ts
{
  version: number;
  cities: { id: string; name: string; timezone: string; bbox: { minLat; minLng; maxLat; maxLng } }[]; // enabled only
  vehicleTypes: { code: string; name: string; seatsMin: number; seatsMax: number; cities: string[] }[]; // enabled only
  features: { phoneBooking; corporateBooking; tripPin; scheduledRides; sos; support; promos; accountDeletion: boolean };
  maintenance: { newTripsPaused: boolean; message: string };
  minAppVersions: { rider: { android: string; ios: string }; driver: { android: string; ios: string } };
  announcements: { id; title; body; severity: "info" | "warning"; audiences: string[]; cities: string[]; startsAt; endsAt: string | null }[]; // ≤ 20
}
```

### `GET /api/platform/settings`

Response:

```ts
{
  version: number;
  groups: string[];            // SETTING_GROUPS
  definitions: SettingDef[];   // the full registry
  global: Record<string, unknown>;
  cities: Record<string, Record<string, unknown>>;
  cityList: CityInfo[];
  pending: SettingChange[];    // status PENDING, oldest first
}
```

### `GET /api/platform/settings/history`

Query: `key` (string ≤ 80, optional), `limit` (int 1–200, default 50). Response `{ history: SettingHistory[] }`, newest first. Each row: `id, key, cityId, oldValue, newValue, changedBy, approvedBy, reason, version, at`.

### `PUT /api/platform/settings/:key`

Params: `key` (string ≤ 80). Body:

| Field | Type | Notes |
|---|---|---|
| `value` | any JSON, required key | `null` (or missing) removes the stored value, so the default applies again. Otherwise validated against the definition |
| `cityId` | city id or `null`, optional | Only for keys with scope `city`. Must exist in `city` |
| `reason` | string 5–500 | Stored in history and in the audit event |

Responses:

- `200 { status: "APPLIED", version }`
- `202 { status: "PENDING_APPROVAL", change: SettingChange }` for sensitive keys.

Errors: `404 not_found` (unknown key), `400 bad_request` (city on a global key, unknown city, short reason), `400 invalid_value`, `409 change_pending`.

### `GET /api/platform/settings/changes`

Query: `status` = `PENDING | EXECUTED | REJECTED | EXPIRED | CANCELLED`, optional. Response `{ changes: SettingChange[] }`, newest first, at most 100. A row: `id, key, cityId, value, reason, makerId, checkerId, status, decisionReason, createdAt, decidedAt, expiresAt`.

### `POST /api/platform/settings/changes/:id/approve`

Params: `id` (UUID). Body (optional): `{ reason?: string ≤ 500 }` (stored as `decision_reason`). Response `{ id, status: "EXECUTED", version }`.

Errors: `404 not_found`, `409 not_pending`, `403 maker_is_checker`, `409 expired`, `400 invalid_value` (the stored value no longer passes validation).

### `POST /api/platform/settings/changes/:id/reject`

Body `{ reason }` (5–500, required). Response `{ id, status: "REJECTED" }`. Errors: `404`, `409 not_pending`, `403 maker_is_checker`.

### `POST /api/platform/settings/changes/:id/cancel`

No body. Response `{ id, status: "CANCELLED" }`. Errors: `404`, `409 not_pending`, `403 forbidden` (not the maker).

### Cities

`GET /api/platform/cities` → `{ cities: City[] }` ordered by name; a row has `id, name, timezone, enabled, minLat, minLng, maxLat, maxLng, createdAt, updatedAt`.

`POST /api/platform/cities` body:

| Field | Type | Default |
|---|---|---|
| `id` | city id (2–40 effective) | required |
| `name` | string 2–80, trimmed | required |
| `timezone` | string 3–60 | `Africa/Addis_Ababa` |
| `enabled` | boolean | `true` |
| `bbox` | `{ minLat, minLng, maxLat, maxLng }` (lat −90..90, lng −180..180) | required |

`PUT /api/platform/cities/:id` takes the same body without `id`. Both return the saved `City`.

Errors: `400` (bad id, bbox corners in the wrong order, a side over 3°), `409 conflict` (create, exists), `404` (update, missing), `503 dependency_unavailable` (auth-service did not accept the city; nothing was saved).

### Vehicle types

`GET /api/platform/vehicle-types` → `{ vehicleTypes: VehicleType[] }` by `sortOrder`, `code`.

`PUT /api/platform/vehicle-types/:code` (`code` ≤ 30 in the route; service requires `^[a-z0-9_]{2,30}$`) body:

| Field | Type |
|---|---|
| `name` | string 2–40 |
| `seatsMin`, `seatsMax` | integers, 1 ≤ min ≤ max ≤ 20 |
| `enabled` | boolean |
| `cities` | up to 50 city ids, default `[]` (= every city); each must exist |

Returns the saved `VehicleType`. Errors: `400`.

### Announcements

`GET /api/platform/announcements` → `{ announcements: Announcement[] }`, non-archived first, then newest `startsAt`, at most 200.

`POST` / `PUT /:id` body:

| Field | Type | Default |
|---|---|---|
| `title` | string 3–80 | required |
| `body` | string 3–500 | required |
| `severity` | `info \| warning` | `info` |
| `audiences` | non-empty array of `rider \| driver \| partner \| staff` | required |
| `cities` | up to 50 city ids | `[]` (every city). Not checked against the `city` table |
| `startsAt` | date (coerced) | required |
| `endsAt` | date or `null`, optional | none |

Errors: `400` (`endsAt` not after `startsAt`), `404` (PUT or archive on an unknown id). `POST /:id/archive` returns the archived announcement.

### `GET /api/platform/system`

Query `refresh` (coerced boolean, default `false`). Header `cache-control: no-store`. Response:

```ts
{
  checkedAt: string;
  services: { name; status: "up" | "degraded" | "down"; latencyMs: number | null; detail?: object; error?: string }[];
  outbox: { name; pending: number | null; oldestAt: string | null; error?: string }[];
  kafka: { configured: boolean; groups: { groupId; lag: number | null; topics: { topic; lag }[]; error? }[]; error?: string };
  redis: { configured: boolean; status; latencyMs: number | null };
  integrations: { messaging; routing; locationStream; documentStorage; payments }; // raw bodies from the other services
}
```

Note that `refresh` uses `z.coerce.boolean()`, so any non-empty value, including `refresh=false`, counts as true.

### `GET /internal/settings/snapshot`

Service token. Response: `SettingsSnapshot` (see [architecture.md](architecture.md#versioning-and-snapshots)). `401 unauthorized` ("invalid service credentials") on a wrong or missing token.

## Errors

From `src/middlewares/error-handler.ts`. Body shape `{ error, message }`.

| Cause | Status | `error` |
|---|---|---|
| `AppError` | its status | its code (`bad_request`, `invalid_value`, `not_found`, `conflict`, `change_pending`, `not_pending`, `expired`, `maker_is_checker`, `forbidden`, `unauthorized`, `dependency_unavailable`) |
| Missing token | 401 | `unauthorized` |
| Bad or expired token (`TokenError`) | 401 | the token error code |
| Missing permission (`AuthorizationError`) | 403 | `forbidden` |
| zod validation | 400 | `validation_error`, plus `issues: [{ path, message }]` |
| Other Fastify 4xx (e.g. body too large, rate limit) | that status | Fastify's code |
| Anything else | 500 | `internal_error` ("Something went wrong") |
| Unknown route | 404 | `not_found` |
