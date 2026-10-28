# pricing-service HTTP API

Source: `src/http/routes.ts`, `src/app.ts`. `/api/pricing/*` is routed by Kong (`pricing-routes`); `/internal/*` and `/health*` are not.

## Common rules

| Rule | Value |
|---|---|
| Body limit | 16 KB |
| Rate limit (service) | 300 / minute per client IP on every route except `/internal/quotes/:id` and `POST /internal/quotes` (`rateLimit: false`) |
| Rate limit (Kong) | 120 / minute on `/api/pricing` |
| App / staff token | `Authorization: Bearer <access token>`, audience `ride-app` or `ride-admin` |
| Service token | `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` |
| Point | `{ lat: number −90..90, lng: number −180..180 }` |
| Money | integer santim, currency `ETB` |

## Routes

| Method and path | Caller | Auth | Success |
|---|---|---|---|
| `GET /health`, `GET /health/live` | probes | none | `200 { status: "ok" }` |
| `GET /health/ready` | probes, platform system page | none | `200 { status: "ok" }` if Redis answers `PONG`, else `503 { status: "unavailable" }` |
| `POST /api/pricing/estimates` | phone app (rider), web partner page, web call-center phone booking | `ride-app` or `ride-admin` token; no permission check | `200` |
| `GET /api/pricing/fares` | phone app (fare info, before sign-in) | none | `200` |
| `GET /internal/quotes/:id` | trip-service | service token | `200` |
| `POST /internal/quotes` | trip-service (scheduled-ride re-pricing at dispatch) | service token | `200` |
| `POST /internal/quotes/:id/unbook` | trip-service (a booking that didn't become a trip) | service token | `200 { unbooked }` |

### `POST /api/pricing/estimates`

Request body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `pickup` | Point | yes | must be inside a city box from `libs/shared-location` (`addis-ababa`, `hawassa`) |
| `dropoff` | Point | yes | not checked against cities (mapping-service checks the service area) |
| `vehicleTypes` | string[] 1–5, each `^[a-z0-9_]{1,30}$` | no | default: every type offered in the pickup's city |
| `pickupAddress` | string ≤ 200 | no | copied onto the quotes |
| `dropoffAddress` | string ≤ 200 | no | copied onto the quotes |

Response `200`:

```ts
{
  quotes: Quote[];   // one per vehicle type, in the order requested/offered
  route: { polyline6: string; distanceMeters: number; durationSeconds: number; approximate: boolean };
}
```

`Quote` fields: `id` (`q_<uuid>`), `requestedBy`, `cityId`, `vehicleType`, `pickup`, `dropoff`, `pickupAddress?`, `dropoffAddress?`, `fareMinor`, `waitingPerMinMinor`, `currency`, `distanceMeters`, `durationSeconds`, `approximate`, `routePolyline6?`, `etaToPickupSeconds` (number or null), `driversNearby`, `breakdown { baseMinor, distanceMinor, timeMinor, minimumApplied, roundingMinor }`, `expiresAt` (ISO). See [architecture.md](architecture.md#the-quote).

Errors:

| Status | `error` | When |
|---|---|---|
| 400 | `validation_error` | body shape |
| 400 | `vehicle_type_unavailable` | a requested type is not offered in the pickup's city |
| 400 | `outside_service_area` | pickup is in no city box |
| 400 | `unknown_vehicle_type` | a type (requested or offered) has no `fares.<type>.*` settings |
| 401 | `unauthorized` / token error code | no token, bad token, wrong audience, denied user, stale permission version |
| 503 | `dependency_unavailable` | mapping-service call failed (any error, including no road between the points) |
| 503 | `auth_unavailable` | Redis deny-list / permission-version lookup failed (`TokenCheckUnavailable`); sent with `retry-after: 5`, logged warn `token check unavailable (Redis)`. The token is refused, retry later |
| 500 | `internal_error` | e.g. Redis unavailable while storing a quote |

### `GET /api/pricing/fares?cityId=`

Query: `cityId` required, `^[a-z0-9-]{1,40}$`. Header `cache-control: public, max-age=60`.

```ts
{
  cityId: string;
  fares: { vehicleType: string; baseMinor; perKmMinor; perMinMinor; minFareMinor; waitingPerMinMinor: number; currency: "ETB" }[];
}
```

Types without fare settings are left out. An unknown city id is not an error.

### `GET /internal/quotes/:id`

Params: `id` string 1–100. Query (both or neither): `tripId` uuid (the id trip-service will give the trip), `userId` uuid (who books). With them, the quote's promo discount is **booked for that one trip** (see the promo table below); without them the quote comes **without** its discount (`discountMinor: 0`, no `promo`) and nothing is booked (scheduled bookings read it this way). Response: the stored `Quote`. Errors: `401 unauthorized` ("invalid service credentials"), `404 not_found` ("quote not found") when expired or unknown.

### `POST /internal/quotes/:id/unbook`

Body `{ tripId: uuid }`. trip-service booked the quote's discount for `tripId` but then didn't create the trip (a policy refusal, an active trip, a lost race): the reservation goes back BOOKED → HELD (until the quote expires) so the rider's retry can book it. Acts only on a reservation BOOKED for that trip id; anything else is a no-op. Response `200 { unbooked: boolean }`.

### `POST /internal/quotes`

A quote made by a service for a user: trip-service re-prices a scheduled ride shortly before dispatch (workflow 12, `services/trip-service/src/quotes.ts` `reprice`). Priced exactly like an estimate (approved fare rule in force else live settings, zones, ETA) and stored in Redis like any quote (readable by `GET /internal/quotes/:id` until `quote.ttlSeconds`). **Never carries a promo** (`discountMinor: 0`, `payableMinor = fareMinor`).

| Field | Type | Required | Notes |
|---|---|---|---|
| `requestedBy` | uuid | yes | the user the quote is for (trip-service sends the booker) |
| `cityId` | `^[a-z0-9-]{1,40}$` | no | when given, must be the pickup's city |
| `vehicleType` | `^[a-z0-9_]{1,30}$` | one of the two | |
| `vehicleTypes` | string[] 1–5 | one of the two | wins over `vehicleType`; duplicates dropped |
| `pickup`, `dropoff` | Point | yes | |
| `pickupAddress`, `dropoffAddress` | string ≤ 200 | no | copied onto the quote |

Response `200`: the same `{ quotes, route }` as `POST /api/pricing/estimates` (no `promo`). Errors: `401 unauthorized` (missing/wrong service token; user tokens are refused), `400 validation_error` (shape, or neither `vehicleType` nor `vehicleTypes`), `400 outside_service_area`, `400 city_mismatch`, `400 vehicle_type_unavailable` (type not offered in the city any more), `400 unknown_vehicle_type`, `400 pickup_not_allowed` and other zone refusals, `503 dependency_unavailable` (routing down, rules never loaded). trip-service keeps the booked quote on any error.

## Errors

`src/middlewares/error-handler.ts`, body `{ error, message }`: `AppError` → its status and code; `AuthorizationError` → 403 `forbidden` (no route raises it today); `TokenError` → 401 with its code; `TokenCheckUnavailable` (Redis lookup failed) → 503 `auth_unavailable` with `retry-after: 5`; `ZodError` → 400 `validation_error` with `issues[]`; other Fastify 4xx pass through; everything else → 500 `internal_error`; unknown route → 404 `not_found`.

## Workflow 15: zones, fare changes, promos (added)

Source: `src/http/admin-routes.ts` (staff and the rider promo check) and `src/http/routes.ts` (estimates, internal quote). Staff routes need a `ride-admin` token; a `ride-app` token gets `403 forbidden` ("staff only"). A resource in a city the caller doesn't cover answers **404**, never 403. Creates accept `Idempotency-Key` (8–100 of `[A-Za-z0-9_-]`; same key + same body → stored response, different body → `422 idempotency_mismatch`, in flight → `409 request_in_progress`; kept 24 h). Every change writes `audit.recorded` (service `pricing-service`) in the same transaction.

### Changes to existing routes

| Route | Change |
|---|---|
| `POST /api/pricing/estimates` | Optional `promoCode` (3–32 of `[A-Za-z0-9_-]`, case-insensitive). The response gains `promo?: { code, applied: true, discountedQuotes } \| { code, applied: false, reason, message }`; a bad code never fails the estimate. New errors: `400 pickup_not_allowed` (pickup in a NO_PICKUP zone), `400 outside_service_area` also when the city has SERVICE_AREA zones and the pickup is outside all of them, `503 dependency_unavailable` when the rules were never loaded from Postgres |
| `Quote` | New fields: `fareRuleId` (approved rule used, `null` = live settings), `zoneIds`, `discountMinor` (0 = none), `payableMinor` (= `fareMinor − discountMinor`), `promo?: { promoId, code, discountMinor, fundedBy }`. `breakdown` gains `surgeMultiplier` (1 = none) and `zoneFeeMinor` (0 = none). `fareMinor` stays the full fare (the driver's earning is computed on it) |
| `GET /api/pricing/fares` | The card is the approved rule in force, else the live settings |
| `GET /internal/quotes/:id?tripId=&userId=` | Reading a quote with a promo books its discount for that trip (reservation HELD → BOOKED, `trip_id` set). Asking again for the same trip keeps it. It is served **without** `promo` (`discountMinor: 0`, `payableMinor = fareMinor`) when: no `tripId`/`userId` given; `userId` isn't the quote's rider; the reservation is BOOKED for another trip; it was RELEASED (its trip was cancelled: a rebooked quote never gets the discount again), REDEEMED or EXPIRED; the promo is no longer ACTIVE; or, counted under the promo's row lock, the rider's `perUserLimit`, `maxRedemptions` (redeemed + booked) or the budget (spent + booked + this discount) would be passed |

### Routes

| Method and path | Permission (scope) | Success |
|---|---|---|
| `GET /api/pricing/zones?cityId=&includeArchived=` | `zone:manage` (C) | `200 { zones: Zone[] }`; without `cityId`, every city the caller covers |
| `POST /api/pricing/zones/check` `{ cityId, polygon }` | `zone:manage` in `cityId` | `200 { valid: true, points } \| { valid: false, problem, message }` |
| `POST /api/pricing/zones` `{ cityId, name, kind, polygon, feeMinor?, surgeMultiplier? }` | `zone:manage` in `cityId`; Idempotency-Key | `201 { zone }` |
| `GET /api/pricing/zones/:id` | `zone:manage` in the zone's city (else 404) | `200 { zone }` |
| `PUT /api/pricing/zones/:id` `{ …zone, version }` | `zone:manage` | `200 { zone }` (version + 1); stale `version` → `409 invalid_state`; archived → `409 archived` |
| `DELETE /api/pricing/zones/:id` | `zone:manage` | `200 { zone }` with `archivedAt` |
| `GET /api/pricing/fare-rules?cityId=` | `pricing:propose` or `pricing:approve` in the city | `200 { cityId, fares: [{ vehicleType, offered, current: { …card, source: "RULE" \| "SETTINGS", ruleId, validFrom } \| null, scheduled: Rule[], past: Rule[] }], pendingChanges, minNoticeHours }` |
| `GET /api/pricing/fare-changes?cityId=&status=&vehicleType=&limit=&before=` | same | `200 { changes: FareChange[], next }` (newest first; `next` = `before` cursor) |
| `POST /api/pricing/fare-changes/preview` `{ cityId, vehicleType, …card }` | `pricing:propose` in the city | `200 { source, impact }` |
| `POST /api/pricing/fare-changes` `{ cityId, vehicleType, baseMinor, perKmMinor, perMinMinor, minFareMinor, waitingPerMinMinor, validFrom?, emergency?, reason }` | `pricing:propose` in the city; Idempotency-Key | `201 { change }` (status `PENDING`) |
| `GET /api/pricing/fare-changes/:id` | readers (else 404) | `200 { change }` |
| `POST /api/pricing/fare-changes/:id/approve` `{ reason? }` | `pricing:approve` in the city, not the maker | `200 { change }` (status `APPROVED`, `phase` `SCHEDULED` until `validFrom`) |
| `POST /api/pricing/fare-changes/:id/reject` `{ reason }` | `pricing:approve`, not the maker | `200 { change }` |
| `POST /api/pricing/fare-changes/:id/cancel` | the maker only | `200 { change }` (status `CANCELLED`) |
| `GET /api/pricing/promos?cityId=&status=&limit=` | `promo:manage` or `incentive:approve` (C/G) | `200 { promos: Promo[], approvalThresholdMinor }`; city staff also see every-city promos |
| `POST /api/pricing/promos` | `promo:manage` in every city of `cityIds` (empty `cityIds` = every city, needs a GLOBAL role); Idempotency-Key | `201 { promo }` (status `DRAFT`) |
| `GET /api/pricing/promos/:id` | readers in one of its cities (else 404) | `200 { promo }` |
| `PUT /api/pricing/promos/:id` | `promo:manage`; drafts only (`409 not_draft`) | `200 { promo }` |
| `POST /api/pricing/promos/:id/activate` | `promo:manage`; when this budget plus the live (ACTIVE or PAUSED) budgets of the same creator, or of any of its cities (every-city promos count in each city), passes `PROMO_APPROVAL_THRESHOLD_MINOR`: `incentive:approve` in its cities **and** not the creator (`403 approval_required`, `403 maker_is_checker`) | `200 { promo }` (status `ACTIVE`) |
| `GET /api/pricing/promos/anomalies?limit=` | `incentive:approve` in every city (GLOBAL) | `200 { anomalies: [{ id, kind: DISCOUNT_WITHOUT_RESERVATION \| DISCOUNT_ABOVE_RESERVATION \| OVER_BUDGET, tripId, promoId, quoteId, riderId, discountMinor, details, createdAt }] }` newest first |
| `POST /api/pricing/promos/:id/pause` · `/resume` · `/archive` | `promo:manage` | `200 { promo }` |
| `GET /api/pricing/promos/:id/redemptions?limit=&before=` | readers | `200 { redemptions: [{ id, tripId, userId, cityId, fareMinor, discountMinor, redeemedAt }], next }` |
| `POST /api/pricing/promos/check` `{ code, cityId? \| pickup? }` | any signed-in user (`ride-app` or `ride-admin`) | `200 { valid: true, promo } \| { valid: false, reason, message, promo? }`; `promo` = `{ code, name, description, type, percentOff, amountOffMinor, maxDiscountMinor, vehicleTypes, endsAt }` |

`Zone`: `{ id, cityId, name, kind: SERVICE_AREA | NO_PICKUP | AIRPORT | SURGE, polygon: [lng, lat][] (closed), feeMinor, surgeMultiplier, version, createdBy, updatedBy, createdAt, updatedAt, archivedAt }`.

`FareChange`: `{ id, cityId, vehicleType, card, validFrom, emergency, reason, impact: { current, proposed, samples: [{ label, beforeMinor, afterMinor, deltaMinor, deltaPct }], averageChangePct }, status: PENDING | APPROVED | REJECTED | CANCELLED | EXPIRED, phase (status, or SCHEDULED), makerId, checkerId, decisionReason, createdAt, decidedAt, expiresAt, ruleId }`.

`Promo`: `{ id, code, name, description, type: PERCENT_OFF | AMOUNT_OFF, percentOff, amountOffMinor, maxDiscountMinor, cityIds, vehicleTypes, startsAt, endsAt, perUserLimit, maxRedemptions, budgetMinor, spentMinor, redemptionCount, bookedMinor, bookedCount, fundedBy: PLATFORM | PARTNER, status: DRAFT | ACTIVE | PAUSED | EXHAUSTED | EXPIRED | ARCHIVED, needsFinanceApproval, createdBy, activatedBy, activatedAt, createdAt, updatedAt }`.

### Errors (new codes)

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_geometry` | outline fewer than 3 points, crossing itself, zero area, outside the city box, bad coordinate |
| 400 | `fee_required` / `multiplier_required` | AIRPORT without a fee / SURGE without a multiplier above 1 |
| 400 | `valid_from_required` / `valid_from_too_soon` / `valid_from_in_past` | fare change start missing, less than 24 h ahead (non-emergency), or in the past |
| 400 | `unknown_vehicle_type` | no current fares for that type |
| 400 | `invalid_window` | promo `endsAt` ≤ `startsAt` |
| 403 | `maker_is_checker` | approving or rejecting your own fare change; activating your own big-budget promo |
| 403 | `approval_required` | activating a big-budget promo without `incentive:approve` |
| 409 | `already_pending` | a fare change for this city and type is already waiting |
| 409 | `not_pending` / `expired` / `valid_from_too_soon` / `version_exists` | approving a decided, expired or too-soon change, or a version with the same start |
| 409 | `code_taken` | promo code used by another promo |
| 409 | `not_draft` / `promo_ended` / `invalid_transition` / `invalid_state` | promo edits and transitions; concurrent change |
| 422 / 409 | `idempotency_mismatch` / `request_in_progress` | Idempotency-Key reuse |

Promo rejection reasons (`promo.reason` on estimates, `reason` on `/promos/check`): `unknown_code`, `not_active`, `not_started`, `expired`, `exhausted`, `not_in_city`, `vehicle_type_not_eligible`, `limit_reached`.
