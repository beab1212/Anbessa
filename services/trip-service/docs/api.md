# API

Every HTTP route of trip-service, from `src/http/routes.ts` and `src/app.ts`, plus the socket events it pushes. Public routes are reached through Kong at `/api/trips` (see [integrations.md](integrations.md#kong)); `/internal/*` is reachable only inside the network.

## Contents

- [Conventions](#conventions)
- [Error codes](#error-codes)
- [The trip object](#the-trip-object)
- [Health](#health)
- [Request and quotes](#request-and-quotes)
- [Offers and assignment](#offers-and-assignment)
- [Trip execution](#trip-execution)
- [Cancellation](#cancellation)
- [Ratings](#ratings)
- [Reads](#reads)
- [Saved places](#saved-places)
- [Share links](#share-links)
- [Internal](#internal)
- [Socket events](#socket-events)

## Conventions

| Topic | Rule |
|---|---|
| Auth | `Authorization: Bearer <access token>`. Audience `ride-app` (phone app) or `ride-admin` (web staff); both are accepted on every public route. Exceptions: the health routes and `GET /api/trips/shared/:token` (no token), `/internal/*` (service token) |
| Body | JSON, at most 32 KB (`bodyLimit` in `src/app.ts`). Validated with zod; unknown fields are ignored |
| IDs | Trip, offer, place, user and org ids are UUIDs (validated). `cityId` is a string of 1–40 chars |
| Money | Integers in minor units (santim), with a `currency` (`ETB`) |
| Times | ISO 8601 strings |
| Rate limits | Kong: 60/min for `/api/trips` (policy `local`). In the service: 300/min per client IP for every route (in-process memory), 30/min for the share view, none for `GET /internal/trips/:id` |
| Idempotency | `Idempotency-Key` header (8–100 chars of `[A-Za-z0-9_-]`) on the routes marked **idempotent**. Retry → the stored answer; still running → `409 request_in_progress`; same key, different URL/body → `422 idempotency_mismatch`. Kept 24 h. Other routes ignore the header |
| Errors | `{ "error": "<code>", "message": "<text>" }`. Validation errors add `issues: [{ path, message }]` |
| Hidden resources | Trips you may not read, offers and places that aren't yours, and dead share links answer `404 not_found` |

## Error codes

Codes found in the code, by status. A route section lists the ones specific to it.

| Status | `error` | Source |
|---|---|---|
| 400 | `validation_error` | zod parse failure (with `issues`) |
| 400 | `bad_request` | generic (`badRequest()`), bad `Idempotency-Key`, other Fastify 4xx without a code |
| 400 | `invalid_quote`, `quote_expired`, `wrong_pin`, `invalid_tags`, `outside_service_area` | see routes |
| 401 | `unauthorized` | missing token, or bad service token on `/internal/*` |
| 401 | `invalid_token`, `token_revoked`, `token_outdated` | token verification (`libs/shared-authz/src/verify.ts`) |
| 403 | `forbidden` | missing permission/scope (`AuthorizationError`) |
| 403 | `feature_disabled`, `payment_method_unavailable` | live settings, on `POST /api/trips` |
| 404 | `not_found` | missing or hidden resource; unknown route |
| 409 | `invalid_state` | the trip isn't in a status that allows this, or another change won the race |
| 409 | `active_trip_exists`, `driver_busy`, `driver_unavailable`, `offer_closed`, `position_unknown`, `too_far_from_pickup`, `not_arrived`, `too_early_for_no_show`, `rating_closed`, `already_rated`, `trip_ended`, `too_many_places`, `request_in_progress` | see routes |
| 422 | `idempotency_mismatch` | same key, different request |
| 429 | (from `@fastify/rate-limit`, passed through the error handler's 4xx branch) | rate limit |
| 503 | `auth_unavailable` | Redis deny-list / permission-version lookup failed (`TokenCheckUnavailable`); sent with `retry-after: 5`, logged warn `token check unavailable (Redis)`. The token is refused, retry later |
| 500 | `internal_error` | anything unhandled (logged) |
| 503 | `dependency_unavailable` | pricing-service or location-service could not be reached when needed |
| 503 | `maintenance` | `maintenance.newTrips` is on; the message is `maintenance.message` |

## The trip object

Returned by most routes. Built by `tripView()` in `src/trips/service.ts`; the TypeScript type is `Trip` in `libs/shared-types/src/trip.ts` (mirrored in `packages/core/lib/src/models/trip.dart`).

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `status` | `requested` \| `matched` \| `en_route` \| `in_progress` \| `completed` \| `cancelled` | |
| `cityId` | string | from the quote |
| `channel` | `APP` \| `PHONE` \| `CORPORATE_PORTAL` | |
| `vehicleType` | string | from the quote |
| `paymentMethod` | `CASH` \| `MOBILE_MONEY` \| `CARD` \| `CORPORATE` | |
| `billing` | `{ type: PERSONAL\|CORPORATE, orgId: uuid\|null }` | |
| `riderUserId` | uuid | |
| `pickup`, `dropoff` | `{ lat, lng, address: string\|null }` | |
| `driver` | `{ userId, vehicleId }` \| null | set at match |
| `fare` | `{ estimateMinor, finalMinor\|null, waitingFeeMinor\|null, currency }` | final values set at completion |
| `route` | `{ estDistanceMeters, estDurationSeconds, distanceMeters\|null, durationSeconds\|null, polyline\|null }` | `polyline` = encoded polyline, precision 6 |
| `times` | `{ requestedAt, matchedAt, arrivedAt, startedAt, completedAt, cancelledAt }` | null until reached |
| `cancellation` | `{ by: RIDER\|DRIVER\|SYSTEM\|STAFF, reason, feeMinor, driverCompensationMinor }` \| null | |
| `pin` | 4-digit string | **only** when the caller is the rider or the booker |
| `flags` | string[] (e.g. `FAR_FROM_DROPOFF`) | **only** for `ride-admin` callers |

## Health

| Route | Auth | Response |
|---|---|---|
| `GET /health` | none | `200 { status: "ok" }` (used by the Dockerfile `HEALTHCHECK`) |
| `GET /health/live` | none | `200 { status: "ok" }` |
| `GET /health/ready` | none | `200 { status: "ok" }` if `SELECT 1` on Postgres succeeds, else `503 { status: "unavailable" }`. Redis and Kafka are not checked |

## Request and quotes

### `POST /api/trips/estimates`

Development stand-in for pricing-service's estimates. **Registered only when `PRICING=builtin`** (refused in production); otherwise this path is `404`.

| | |
|---|---|
| Who | any valid token (no permission check) |
| Body | `pickup {lat −90..90, lng −180..180}`, `dropoff {…}`, `vehicleTypes` string[1..5] of 1–30 chars (default `["economy"]`), `pickupAddress?` ≤ 200, `dropoffAddress?` ≤ 200 |
| Response | `200 { quotes: Quote[] }`, one per vehicle type (shape: `Quote` in `src/quotes.ts`; `id` is `q_<uuid>`, valid `quote.ttlSeconds`) |
| Errors | `400 outside_service_area` (pickup not in a known city, `cityAt()` in `libs/shared-location`); `400 bad_request` "no fare for vehicle type X"; `500` if mapping-service fails (not caught) |

### `POST /api/trips`

Request a trip. **Idempotent.** `request()` in `src/trips/service.ts`.

| Field | Type | Rules |
|---|---|---|
| `quoteId` | string 1–100 | must exist, be made by the caller (`requestedBy`), not be expired, and not already be on a trip that wasn't cancelled (one trip per quote; re-booking after a cancellation is allowed) |
| `paymentMethod` | `CASH` \| `MOBILE_MONEY` \| `CARD` \| `CORPORATE` | `CORPORATE` exactly when `billingOrgId` is given |
| `riderUserId` | uuid, optional | someone else rides (booking on behalf). Not checked against auth-service |
| `billingOrgId` | uuid, optional | the company account to bill |

Who may call, and the resulting `channel`:

| Caller | Condition | Permission | Channel |
|---|---|---|---|
| `ride-admin` token (call center) | `riderUserId` required and ≠ caller | `trip:create_on_behalf` @ CITY of the quote | `PHONE` |
| `ride-app` token booking for someone else | `billingOrgId` required | `trip:create_on_behalf` @ ORG `billingOrgId` | `CORPORATE_PORTAL` |
| `ride-app` token booking for themselves | | `trip:create` @ SELF (+ `orgId` if billing a company) | `APP` |
| any, with `billingOrgId` | | additionally `trip:bill_corporate` @ ORG | |

Then, in this order, the live settings: `maintenance.newTrips` (→ `503 maintenance`), `features.phoneBooking` for `PHONE` (→ `403 feature_disabled`), `features.corporateBooking` when `billingOrgId` is set (→ `403 feature_disabled`), and `payments.methods` for the quote's city unless `CORPORATE` (→ `403 payment_method_unavailable`).

Response: `201` [trip](#the-trip-object) with `status: requested` (and `pin` for the caller). Matching starts right after.

Errors: `400 invalid_quote`, `400 quote_expired`, `400 quote_used` ("this quote was already used, get a new one"), `400 bad_request` (corporate/billing mismatch, staff without `riderUserId`, on-behalf without `billingOrgId`), `403 forbidden`, `403 feature_disabled`, `403 payment_method_unavailable`, `409 active_trip_exists` (the rider already has an active trip), `503 dependency_unavailable` (pricing-service), `503 maintenance`.

## Offers and assignment

### `POST /api/trips/:id/accept`

The offered driver accepts. **Idempotent.**

| | |
|---|---|
| Who | the driver the offer was made to (`404 not_found` "offer not found" otherwise), with `trip:accept` @ SELF |
| Body | `{ offerId: uuid }` |
| Response | `200` trip, `status: matched` |
| Errors | `409 offer_closed` (offer already `DECLINED`/`ACCEPTED`, or `EXPIRED` while another offer is open), `409 invalid_state` (trip no longer `requested`, or lost a race), `409 driver_unavailable` (driver not available/stale, different city or vehicle type, balance `BLOCKED`, or a cash trip and cash not allowed), `409 driver_busy` (already has an active trip), `503 dependency_unavailable` (location-service) |
| Notes | An `EXPIRED` offer may still be accepted while the trip is `requested` and no other offer is open. On success: the offer → `ACCEPTED`, other open offers → `EXPIRED`, matching stops, `offer:driver:{id}` deleted, `trip:status` pushed |

### `POST /api/trips/:id/decline`

| | |
|---|---|
| Who | the offered driver, `trip:accept` @ SELF |
| Body | `{ offerId: uuid }` |
| Response | `200 { declined: true }`, or `{ declined: false }` if the offer was no longer open |
| Errors | `404 not_found` |
| Notes | Not idempotency-wrapped (it is naturally repeatable). The driver won't be offered this trip again |

### `POST /api/trips/:id/assign`

Dispatcher assigns a driver manually. **Idempotent.**

| | |
|---|---|
| Who | `trip:assign` @ CITY of the trip |
| Body | `{ driverId: uuid }` |
| Response | `200` trip, `status: matched` |
| Errors | `400 bad_request` (driver is the trip's rider), `403 forbidden`, `404` (trip missing), `409 driver_unavailable`, `409 driver_busy`, `409 invalid_state`, `503 dependency_unavailable` |
| Notes | Same checks and snapshot as accept. `trip_event.data = { assignedBy }`. Any open offer is marked `EXPIRED`, but that driver gets no push and their `offer:driver` key is left to expire |

## Trip execution

All four routes: only the assigned driver (`404` for anyone else, including the rider), with `trip:update_status` @ SELF. Response: `200` trip.

| Route | Body | Allowed from | Effect | Errors |
|---|---|---|---|---|
| `POST /api/trips/:id/en-route` | none | `matched` | → `en_route` | `409 invalid_state` |
| `POST /api/trips/:id/arrive` | none | `en_route` | sets `arrived_at` (status stays `en_route`). Calling again after arrival returns the trip unchanged | `409 invalid_state` (still `matched`), `409 position_unknown` (no fix in the last 60 s), `409 too_far_from_pickup` (farther than `trip.arrivalRadiusMeters`, default 150 m; message gives the distance), `503 dependency_unavailable` |
| `POST /api/trips/:id/start` | `{ pin?: "dddd" }` | `en_route` with `arrived_at` | → `in_progress` | `409 not_arrived`, `400 wrong_pin` (only when `trip.pinRequired` is on), `409 invalid_state` |
| `POST /api/trips/:id/complete` | none | `in_progress` | → `completed`, final fare = quote + paid waiting, `FAR_FROM_DROPOFF` flag if > `trip.completeFarFromDropoffMeters` from the drop-off. **Idempotent** | `409 invalid_state` |

## Cancellation

### `POST /api/trips/:id/cancel`

**Idempotent.**

| | |
|---|---|
| Who | anyone who can read the trip **and** has `trip:cancel`: rider or assigned driver @ SELF, coordinator @ ORG (billing org), call center, dispatcher, support, safety @ CITY |
| Body | `{ reason }`, one of `CHANGED_PLANS`, `DRIVER_TOO_FAR`, `DRIVER_ASKED_TO_CANCEL`, `WRONG_PICKUP`, `NO_SHOW`, `SAFETY`, `OTHER`, `STAFF_DECISION` |
| Allowed from | `requested`, `matched`, `en_route` |
| Response | `200` trip with `cancellation { by, reason, feeMinor, driverCompensationMinor }` |
| Errors | `404`, `403 forbidden`, `409 invalid_state` (e.g. `in_progress`), `400 bad_request` (`NO_SHOW` from anyone but the driver), `409 too_early_for_no_show`, `409 too_far_from_pickup` (no-show reported away from the pickup or with no recent fix), `503 dependency_unavailable` |
| Notes | `by` = `STAFF` for `ride-admin` callers, `DRIVER` for the assigned driver, else `RIDER`. Fees: [architecture.md](architecture.md#money-final-fare-waiting-cancellation-fees) |

## Ratings

### `POST /api/trips/:id/rating`

| | |
|---|---|
| Who | the trip's rider or driver (`404` otherwise) |
| Body | `stars` int 1–5; `comment?` ≤ 500; `tags?` string[≤ 5], each ≤ 40 chars and in `RATING_TAGS[RIDER\|DRIVER]` (`libs/shared-types/src/trip.ts`) |
| Response | `201 { tripId, byRole: RIDER\|DRIVER, stars, tags }` |
| Errors | `409 invalid_state` (not completed), `409 rating_closed` (more than 7 days after completion), `400 invalid_tags`, `409 already_rated` |

### `GET /api/trips/:id/rating`

| | |
|---|---|
| Who | anyone who can read the trip |
| Response | `200 { mine: { stars, tags, comment } \| null }` (null if the caller isn't the rider/driver or hasn't rated) |

### `GET /api/trips/me/rating`

| | |
|---|---|
| Who | any valid token |
| Response | `200 { average: number\|null, count }` over ratings the caller received (one decimal, cached 300 s) |

## Reads

### `GET /api/trips/:id`

Who: the rider, booker, driver (`trip:read` @ SELF); staff with `trip:read` @ CITY of the trip (or GLOBAL); the billing org (@ ORG); the fleet that owns the vehicle (`trip:read` @ ORG of `beneficiary_id`, `ORGANIZATION` vehicles only). Others: `404`. Response: `200` trip.

### `GET /api/trips/:id/parties`

Who: same as `GET /api/trips/:id`. Response:

```json
{
  "tripId": "…",
  "driver": { "name": "Abebe Kebede", "photo": "data:…", "rating": 4.8, "ratingCount": 12 },
  "vehicle": { "plateNumber": "3-A40402", "vehicleType": "economy", "make": "Toyota", "model": "Vitz", "color": "White" },
  "rider": { "name": "…", "photo": null }
}
```

- `driver` and `vehicle`: for the rider, the booker and staff (`ride-admin`); `null` for others or before a match. `rating` is null below 3 ratings.
- `rider`: for the driver and staff; `null` for others.
- Names that are still a phone number come back as `null`. Upstream failures become `null` (no error). Cached 60 s.

### `GET /api/trips/active`

Who: any valid token. Response: `200 { trip: Trip | null }`, the newest active trip where the caller is the rider or the driver (not the booker).

### `GET /api/trips`

| Query | Type | Default |
|---|---|---|
| `as` | `rider` \| `driver` | `rider` |
| `before` | date (coerced) | none |
| `limit` | int 1–50 | 20 |

Who: any valid token; returns only the caller's trips (as rider or as driver), newest first. Response: `200 { trips: Trip[], next: string|null }`; `next` is the last trip's `createdAt` when the page is full, to pass as `before`.

### `GET /api/trips/board`

| | |
|---|---|
| Who | `trip:read` @ CITY for `cityId` |
| Query | `cityId` string 1–40, required |
| Response | `200 { trips: Trip[] }`: active trips of the city, oldest first, at most 500 |

### `GET /api/trips/stats`

Admin overview (`apps/web/src/pages/admin/Overview.tsx`).

| | |
|---|---|
| Who | `report:read`, with the city scope when `cityId` is given. Without `cityId`, only GLOBAL-scoped grants (and GLOBAL assignments of city roles) pass |
| Query | `cityId?` string 1–40 |
| Response | `200 { since, requested, completed, cancelled, active, completionRate: number\|null, avgSecondsToMatch: number\|null, byChannel: { APP?: n, PHONE?: n, CORPORATE_PORTAL?: n } }` |
| Notes | "Today" starts at midnight Addis Ababa time (UTC+3, hard-coded). `requested`/`completed`/`cancelled`/`byChannel`/`avgSecondsToMatch` count trips created since then; `active` counts all currently active trips regardless of creation date |

## Saved places

No permission check: every caller has their own list.

| Route | Body | Response | Errors |
|---|---|---|---|
| `GET /api/trips/places` | | `200 { places: Place[] }` (HOME, WORK, then others by creation) | |
| `PUT /api/trips/places/home` · `PUT /api/trips/places/work` | `name` 1–120 (trimmed), `address?` ≤ 240 (trimmed), `lat`, `lng` | `200 Place` (created or replaced) | `400 validation_error` (other labels) |
| `POST /api/trips/places` | same | `201 Place` (label `OTHER`) | `409 too_many_places` (20 in total) |
| `DELETE /api/trips/places/:id` | | `204` | `404` (missing or not yours) |

`Place` = `{ id, label: HOME|WORK|OTHER, name, address|null, lat, lng, updatedAt }`.

## Share links

### `POST /api/trips/:id/share`

| | |
|---|---|
| Who | the trip's rider or booker (`404` otherwise) |
| Response | `201 { token, url, expiresAt }`; `url` = `{SHARE_BASE_URL}/t/{token}`. Asking again returns the same live link |
| Errors | `409 trip_ended` (ended more than 30 min ago) |

### `DELETE /api/trips/:id/share`

Who: the rider or booker. Revokes every link this person made for the trip. Response: `204`.

### `GET /api/trips/shared/:token`

| | |
|---|---|
| Who | **no token**. Rate limit 30/min per IP |
| Params | `token`: 16–64 chars of `[A-Za-z0-9_-]` (else `400 validation_error`) |
| Headers set | `cache-control: no-store`, `referrer-policy: no-referrer` |
| Response | see below |
| Errors | `404 not_found` for unknown, revoked, expired links, or a trip that ended more than 30 min ago |

```json
{
  "status": "en_route",
  "pickup": { "name": "Bole", "lat": 8.98, "lng": 38.75 },
  "dropoff": { "name": "Piassa", "lat": 9.03, "lng": 38.75 },
  "driver": { "firstName": "Abebe", "photo": null },
  "vehicle": { "plateNumber": "…", "vehicleType": "economy", "make": "…", "model": "…", "color": "…" },
  "position": { "lat": 8.98, "lng": 38.75, "heading": 90, "at": "…" },
  "routePolyline": "…",
  "times": { "matchedAt": "…", "arrivedAt": null, "startedAt": null, "endedAt": null },
  "estDurationSeconds": 900,
  "expiresAt": "…"
}
```

`driver` and `vehicle` are `null` before a match. `position` is `null` unless the trip is active, the driver is on this trip, and the fix is fresh (< 60 s, not stale). No user ids, PIN or fare are included.

## Internal

All routes under `/internal` need `Authorization: Bearer {INTERNAL_SERVICE_TOKEN}` (constant-time comparison; `401 unauthorized` otherwise). Not routed by Kong.

| Route | Caller | Response | Notes |
|---|---|---|---|
| `GET /internal/trips/:id` | intended for support and payment (comment in code); no caller found in the repo | `200` trip via `tripView(trip)` (no `pin`, no `flags`); `404` | exempt from the rate limit |
| `GET /internal/ops/outbox` | platform-service system page (`services/platform-service/src/system/health.ts`) | `200 { pending: number, oldestAt: string\|null }` (unpublished outbox rows) | subject to the 300/min limit |

## Socket events

Pushed through the Socket.io Redis emitter (`src/lib/realtime.ts`) to room `user:{userId}`; realtime-gateway puts every socket of a user in that room. Delivery is best-effort: only to connected sockets, with no retry or acknowledgement.

| Event | To | When | Payload |
|---|---|---|---|
| `trip:offer` | the offered driver | the matcher makes an offer | `{ tripId, offerId, expiresAt, etaToPickupSeconds, pickup {lat,lng,address}, dropoff {lat,lng,address}, vehicleType, fare { estimateMinor, currency }, paymentMethod }` |
| `trip:offer_expired` | the driver | the matcher finds the open offer past `expiresAt` | `{ tripId, offerId }` |
| `trip:offer_cancelled` | a driver holding an open offer | the trip is cancelled (by anyone, including the timeout) | `{ tripId }` |
| `trip:status` | the rider, the booker and the driver (each once) | after every committed transition, including the initial request and arrival | `{ tripId, status, trip: Trip }` where `trip` has no `pin` and no `flags` |

`etaToPickupSeconds` is the OSRM duration from mapping-service, or the straight-line estimate when mapping-service is down.
