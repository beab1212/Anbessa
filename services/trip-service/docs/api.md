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
- [Search, company lists and reports](#search-company-lists-and-reports)
- [Saved places](#saved-places)
- [Share links](#share-links)
- [Internal](#internal)
- [Socket events](#socket-events)
- [Scheduled rides](#scheduled-rides)
- [Reassignment](#reassignment)
- [GPS trace](#gps-trace)
- [Company ride policies](#company-ride-policies)
- [Regulatory report](#regulatory-report)

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
| `fare` | `{ estimateMinor, finalMinor\|null, waitingFeeMinor\|null, currency, promoDiscountMinor, promoCode\|null, payableMinor }` | final values set at completion. `promoDiscountMinor` = promo discount from the quote (0 = none, never above the fare); `payableMinor` = what the rider pays: (`finalMinor` once completed, else `estimateMinor`) − `promoDiscountMinor` |
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

- `driver` and `vehicle`: for the rider, the booker, staff (`ride-admin`), the company the trip is billed to (`trip:read` @ ORG `billingOrgId`) and the fleet that owns the car (`trip:read` @ ORG `beneficiaryId`, `ORGANIZATION` vehicles); `null` for others or before a match. `rating` is null below 3 ratings.
- `rider`: for the driver, staff and the billed company; `null` for others (the fleet sees its driver and car, not the rider).
- Names that are still a phone number come back as `null`. Upstream failures become `null` (no error). Cached 60 s.

### `GET /api/trips/:id/events`

The trip's history, oldest first: the timeline in the staff console (`apps/web/src/pages/staff/TripDetail.tsx`). Logic: `events()` in `src/trips/service.ts`.

| | |
|---|---|
| Who | staff only: a `ride-admin` token with `trip:read` @ CITY of the trip (or GLOBAL). Everyone else, including the rider and driver: `404` |
| Response | `200 { tripId, events: [{ at, from, to, actorId, data }] }` from `trip_event`, ordered by `at`, then `id`. `from` is null on the first row; `data` is the row's JSON or null (e.g. `{quoteId, approximate}`, `{assignedBy}`, `{arrived, metersFromPickup}`; see [architecture.md](architecture.md#trip-state-machine)) |

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

## Search, company lists and reports

Code: `src/trips/reports.ts`, routes in `src/http/routes.ts` (static paths, registered before `/api/trips/:id`).

Shared rules:

| Topic | Rule |
|---|---|
| Days | `from`, `to`: `YYYY-MM-DD` Addis Ababa days (UTC+3), **inclusive**. When both are given the range is 1–92 days, else `400 invalid_range`. Malformed dates → `400 invalid_range` |
| Paging | Newest first by `(created_at, id)`. `next` is an opaque cursor `<created_at in microseconds>_<id>` (microseconds because Postgres keeps them and a JS date doesn't, so trips created in the same millisecond are neither skipped nor repeated); pass it back as `before`. A plain ISO date is also accepted as `before`. Anything else → `400 invalid_cursor`. `next` is `null` when the page isn't full |
| `limit` | int 1–100, default 50 |

### `GET /api/trips/search`

Staff trip search.

| | |
|---|---|
| Who | `trip:read` @ CITY for `cityId`. Without `cityId`: only holders who have `trip:read` everywhere (a `G` grant such as finance, or a city role assigned globally); city staff get `400 city_required`, callers without `trip:read` anywhere `403` |
| Query | `cityId?` (1–40), `status?` (one of the six), `from?`, `to?`, `channel?` (`APP`, `PHONE`, `CORPORATE_PORTAL`), `paymentMethod?` (`CASH`, `MOBILE_MONEY`, `CARD`, `CORPORATE`), `riderUserId?` uuid, `driverUserId?` uuid, `vehicleId?` (1–100), `billingOrgId?` uuid, `q?` (start of a trip id: 1–36 hex characters, dashes ignored; matched as a uuid range on the primary key, else `400 invalid_query`), `before?`, `limit?` |
| Response | `200 { trips: Trip[], next: string \| null }`. The trip view of the caller (`flags` for `ride-admin`) |
| Errors | `400 city_required`, `invalid_range`, `invalid_query`, `invalid_cursor`, `validation_error`; `403 forbidden` (another city, no `trip:read`) |

### `GET /api/trips/org/:orgId`

A company's trips, for the partner portal.

| | |
|---|---|
| Who | `trip:read` covering `{ orgId }`: CORPORATE_ADMIN, CORPORATE_COORDINATOR, FLEET_OWNER of that org (@ ORG), or anyone holding `trip:read` everywhere (finance, global city roles). Others (another org, CORPORATE_EMPLOYEE, FLEET_DRIVER, city staff) → `403` |
| Query | `role` **required**: `billing` (trips billed to the org, `billing_org_id`) or `fleet` (trips driven in the org's vehicles: `vehicle_owner_type = ORGANIZATION` and `beneficiary_id` = the org); `status?`, `from?`, `to?`, `before?`, `limit?` |
| Response | `200 { trips: Trip[], next }`. `ride-app` callers get the plain view: **no `pin`** (even for trips they booked) and no `flags`. `ride-admin` callers get their usual view |
| Errors | `400 validation_error` (no or bad `role`, bad uuid), `400 invalid_range`, `invalid_cursor`; `403 forbidden` |

### `GET /api/trips/reports/daily`

| | |
|---|---|
| Who | `report:read` @ CITY for `cityId`; without `cityId`, only GLOBAL holders (as for `/stats`) |
| Query | `cityId?`, `from?`, `to?`. Defaults: `to` = today (Addis), `from` = `to` − 6 days |
| Response | `200 { cityId \| null, from, to, days: TripDay[], totals }` |
| Errors | `400 invalid_range`, `403 forbidden` |

Every day of the range is present (zero-filled), oldest first. A trip counts on the Addis day it was **requested** (`created_at`). `TripDay`:

| Field | Meaning |
|---|---|
| `date` | `YYYY-MM-DD` |
| `requested` | trips requested that day |
| `completed`, `cancelled`, `active` | of those, by current status (`active` = not ended yet) |
| `completionRate` | `completed / (completed + cancelled)`, `null` if none ended |
| `avgSecondsToMatch` | mean of `matched_at − created_at` over matched trips, rounded; `null` if none |
| `fareMinor` | Σ `fare_final_minor` of completed trips |
| `cancelFeeMinor` | Σ `cancel_fee_minor` of cancelled trips |
| `gmvMinor` | `fareMinor + cancelFeeMinor` (an estimate: refunds and unpaid charges are payment-service's) |
| `cancellations` | `{ bySide: { RIDER?, DRIVER?, SYSTEM?, STAFF? }, byReason: { <reason>: n } }` |
| `byChannel`, `byVehicleType` | `{ <key>: { requested, completed } }` |

`totals` has the same fields without `date`; its `avgSecondsToMatch` is over all matched trips of the range (not a mean of daily means).

### `GET /api/trips/reports/daily.csv`

Same query, permission and data. `200 text/csv; charset=utf-8`, `content-disposition: attachment; filename="trips-<cityId|all>-<from>-<to>.csv"`, `cache-control: no-store`. CRLF lines: a header, one row per day, then a `total` row. Columns: `date, requested, completed, cancelled, active, completion_rate` (4 decimals, empty when null), `avg_seconds_to_match, fare_minor, cancel_fee_minor, gmv_minor`, `cancelled_by_<side>` (rider, driver, system, staff), `reason_<reason>` (reasons seen in the range), `channel_<channel>_requested/_completed` (app, phone, corporate_portal), `vehicle_<type>_requested/_completed` (types seen).

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
| `GET /internal/trips/:id` | support-service (`services/support-service/src/lib/trips.ts`: parties, city, status, drop-off time for tickets, lost items and SOS) | `200` trip via `tripView(trip)` (no `pin`, no `flags`) plus `bookedByUserId` and `beneficiary: { type: INDIVIDUAL\|ORGANIZATION, id } \| null`; `404` | exempt from the rate limit |
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

## Scheduled rides

Workflow 12. A booking lives in `scheduled_trip` (see [data-model.md](data-model.md#scheduled_trip)) until the scheduler turns it into a normal `requested` trip at `matchAt` (see [architecture.md](architecture.md#scheduled-rides)). `TripStatus` has no `scheduled` value; the booking has its own status: `SCHEDULED → DISPATCHING → DISPATCHED`, or `CANCELLED`, `FAILED`.

The `ScheduledRide` object (`scheduledView` in `src/trips/scheduled.ts`):

```ts
{
  id, status: "SCHEDULED"|"DISPATCHING"|"DISPATCHED"|"CANCELLED"|"FAILED",
  cityId, channel: "APP"|"PHONE"|"CORPORATE_PORTAL", vehicleType, paymentMethod,
  billing: { type: "PERSONAL"|"CORPORATE", orgId: string|null },
  riderUserId, bookedByUserId, purpose: string|null,
  pickup: { lat, lng, address }, dropoff: { lat, lng, address },
  fare: { estimateMinor, currency },            // the booked quote: the most the rider pays
  route: { estDistanceMeters, estDurationSeconds, polyline },
  scheduledFor, matchAt,                         // ISO; matchAt = scheduledFor − lead time
  tripId: string|null, tripStatus: string|null,  // the trip created at dispatch, and its status
  dispatchedAt, cancelledAt, failReason, escalatedAt, createdAt,
  editable: boolean                              // SCHEDULED and before matchAt
}
```

| Route | Who | Body / query | Response | Errors |
|---|---|---|---|---|
| `POST /api/trips/scheduled` **idempotent** | as `POST /api/trips`: `trip:create` @ SELF, `trip:create_on_behalf` @ ORG (coordinator) or @ CITY (call center, `riderUserId` required), `trip:bill_corporate` @ ORG for company rides | `{ quoteId, paymentMethod, scheduledFor (ISO), riderUserId?, billingOrgId?, purpose? (≤ 200) }` | `201 ScheduledRide` | `403 feature_disabled` (`features.scheduledRides` off), `400 too_soon` (< 30 min ahead), `400 too_far_ahead` (> 7 days), `400 invalid_quote`/`quote_expired`/`quote_used`, `409 too_many_scheduled` (5 upcoming per rider), `409 schedule_conflict` (another booking of the rider within 60 min), `422 policy_violation` (company policy at the pickup time), plus the `POST /api/trips` switches (`maintenance`, `payment_method_unavailable` …) |
| `GET /api/trips/scheduled` | mine (rider or booker); `orgId`: `trip:read` @ ORG; `cityId`: staff `trip:read` @ CITY | `orgId?, cityId?, status? = upcoming\|all\|<status>` (default `upcoming` = SCHEDULED + DISPATCHING, soonest first; otherwise newest pickup first), `from?, to?` (pickup time), `limit` 1–200 (100) | `{ scheduled: ScheduledRide[] }` | `403` |
| `GET /api/trips/scheduled/:sid` | rider, booker, the billed company, staff of the city | | `ScheduledRide` | `404` |
| `PATCH /api/trips/scheduled/:sid` | `trip:cancel` on the booking (rider, booker, company, staff) | `{ scheduledFor?, quoteId?, purpose?: string\|null }` (at least one) | `ScheduledRide` (new `matchAt`); `trip.scheduled` with `updated: true` | `409 invalid_state` (dispatching or later, or changed meanwhile), window and quote errors as above, `400` new quote in another city, `422 policy_violation` |
| `POST /api/trips/scheduled/:sid/cancel` | as PATCH | | `ScheduledRide` (`CANCELLED`); always free | `409 invalid_state` once dispatching (cancel the trip instead) |

Socket event `scheduled:status` to the rider and the booker on every change: `{ scheduledTripId, status, tripId, scheduledFor, failReason }`. Once dispatched, the trip's own `trip:status` events follow as for any trip.

## Reassignment

### `POST /api/trips/:id/reassign` **idempotent**

`trip:reassign` @ the trip's city (dispatcher). Body `{ driverId?: uuid, reason?: string ≤ 300 }`. Only `matched` and `en_route` trips (before pickup; `arrived_at` is cleared).

- With `driverId`: the driver must be available like for `/assign` (same city and vehicle type, not stale, balance not BLOCKED, cash allowed for cash trips) → trip `matched` with the new driver, vehicle and beneficiary snapshot; `driver_active_trip` moves. Events `trip.matched` (new driver) and `trip.reassigned`.
- Without: back to `requested`, driver fields cleared, matching restarts with the old driver in the declined set. Event `trip.reassigned` (no `toDriverId`).

Both add the review flag `REASSIGNED`, a `trip_event` row with `{ reassignedFrom, reassignedTo?, by, reason? }`, and an `audit.recorded` (`trip:reassign`, `EXECUTED`). The old driver is released in the shared live state (back to available, removed from the trip's watchers, the trip's last position cleared) and gets socket `trip:reassigned { tripId, reason }`; rider, booker and new driver get `trip:status`.

Errors: `400 same_driver`, `400` (the rider as driver), `403`, `404`, `409 invalid_state` (`in_progress` or later), `409 driver_unavailable`, `409 driver_busy`.

## GPS trace

### `GET /api/trips/:id/trace` · `GET /api/trips/:id/trace.csv`

`trip:read_gps_trace` @ the trip's city (dispatcher, safety officer). Query `reason?` (≤ 500, copied into the audit entry). Every read writes `audit.recorded` (`trip:read_gps_trace`, `ALLOWED`). `cache-control: no-store`.

```ts
{
  tripId, cityId, status, driverUserId,
  count, polyline6,                         // every kept point, Google polyline precision 6
  points: { at, phase: "to_pickup"|"ride"|"after", speed, accuracy }[],   // same order as the polyline
  from, to, startedAt, completedAt,
  totalDistanceMeters, rideDistanceMeters,  // straight lines between points, GPS jumps (> 200 km/h) skipped
  thinning: { minSeconds: 5, minMeters: 20, heartbeatSeconds: 60 }
}
```

The CSV is `at,lat,lng,status,speed_mps,accuracy_m` (status = the trip status when recorded), file name `trip-<id>-trace.csv`. Errors: `403`, `404`.

## Company ride policies

Workflow 11 step 4. One policy per company (`corporate_policy`); empty lists and `null` mean no limit. Times are Addis Ababa local.

| Route | Who | Body | Response |
|---|---|---|---|
| `GET /api/trips/corporate/:orgId/policy` | app: `trip:bill_corporate` @ ORG (employees, coordinators, admin); staff: `trip:read` @ ORG (global holders) | | `{ orgId, allowedVehicleTypes, allowedDays, startMinute, endMinute, maxFareMinor, monthlyBudgetMinor, requirePurpose, updatedAt, updatedByUserId, configured, month, spentThisMonthMinor }` |
| `PUT /api/trips/corporate/:orgId/policy` | `corporate:manage_policies` @ ORG (corporate admin) | `{ allowedVehicleTypes: string[] ≤ 20, allowedDays: (0=Sun … 6=Sat)[], startMinute: 0–1440\|null, endMinute: 0–1440\|null, maxFareMinor: int > 0\|null, monthlyBudgetMinor: int > 0\|null, requirePurpose: boolean }` (all default to no limit) | the policy; events `corporate.policy_updated` + `audit.recorded` |

`startMinute > endMinute` wraps past midnight (e.g. 1320–360 = 22:00–06:00). Both or neither must be set (`400`).

**Enforcement.** `POST /api/trips` and `POST /api/trips/scheduled` (and PATCH) with a `billingOrgId` check, in order: vehicle type, day, hours (at the request time, or the scheduled pickup time), `maxFareMinor` against the quote, `purpose` when required, and the monthly budget (the company's non-cancelled trips created this Addis month, final fare or estimate, plus undispatched bookings for that month, plus this ride). A violation is `422 { error: "policy_violation", rule: "vehicle_type"|"day"|"hours"|"max_fare"|"purpose"|"monthly_budget", message }`, e.g. `"Your company allows rides 06:00–22:00 only"`. `POST /api/trips` accepts `purpose?` (≤ 200), stored on the trip and shown in the trip object (not to the driver).

## Regulatory report

### `GET /api/trips/reports/regulatory` · `GET /api/trips/reports/regulatory.csv`

`report:read_regulatory` (REGULATOR and AUDITOR, global; without `cityId` only global holders, others get `400 city_required`). Query `cityId?`, `from?`, `to?` as `YYYY-MM` (Addis months, inclusive; default last month; at most 12 → `400 invalid_range`).

```ts
{ cityId, from, to, rows: { month, cityId, tripsRequested, tripsCompleted, tripsCancelled, tripsNoDriver,
                             activeDrivers, activeVehicles, distanceKm, safetyIncidents, seriousIncidents }[] }
```

Requested and cancelled count by request month, completed / drivers / vehicles / km by drop-off month (`distance_m`, else the planned distance), incidents by `incident.opened` time (`seriousIncidents` = HIGH or CRITICAL). A requested city gets a row for every month even when empty. CSV columns: `month,city,trips_requested,trips_completed,trips_cancelled,trips_no_driver_found,active_drivers,active_vehicles,distance_km,safety_incidents,serious_safety_incidents`; file `regulatory-<city|all>-<from>-<to>.csv`.

