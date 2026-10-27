# Models

All models are immutable classes with a hand-written `fromJson` factory (a few also have `toJson`). They live in `packages/core/lib/src/models/`, except the routing and position types that sit next to their API in `lib/src/api/service_apis.dart` and the socket payloads in `lib/src/realtime/realtime_event.dart` (see [realtime.md](realtime.md)).

Money is always an `int` in minor units (santim, 1/100 birr). Times are `DateTime` in UTC.

## Reading JSON (`models/json.dart`)

The readers never throw on a missing or wrongly typed field; they return a fallback.

| Helper | Returns |
|---|---|
| `asJson(v)` | `v` as `Map<String, dynamic>`, or `{}` |
| `asJsonList(v)` | a list of maps, or `[]` |
| `str(j, key, [fallback = ''])`, `strOrNull` | the string, or the fallback / null |
| `readInt`, `intOrNull`, `readDouble`, `doubleOrNull` | accept `int` or `double` (`num`) |
| `readBool(j, key, [fallback = false])` | the bool, or the fallback |
| `dateOrNull(j, key)` | parses an ISO 8601 string or a unix-ms number, as UTC |
| `readDate(j, key)` | like `dateOrNull` but falls back to the epoch (1970-01-01) |
| `strList(j, key)` | the string items of a list |
| `enumFrom(values, raw, unknown, {apiName})` | the enum member whose API name equals `raw`, else `unknown` |
| `snakeOf(camel)` | `enRoute` → `en_route` (used to build API names) |

### Enum API names and fallbacks

| Enum | Members | API form | Unknown fallback |
|---|---|---|---|
| `TripStatus` | requested, matched, enRoute, inProgress, completed, cancelled | snake_case (`en_route`) | `unknown` |
| `PaymentMethod` | cash, mobileMoney, card, corporate | UPPER_SNAKE (`MOBILE_MONEY`) | `unknown` |
| `CancelReason` | changedPlans, driverTooFar, driverAskedToCancel, wrongPickup, noShow, safety, other | UPPER_SNAKE (sent only, `cancelReasonToApi`) | none (never parsed) |
| `CancelledBy` | rider, driver, system, staff | the API value lower-cased | `unknown` |
| `PaymentStatus` | pending, actionRequired, retryScheduled, succeeded, failed, refunded, partiallyRefunded | UPPER_SNAKE | `unknown` |
| `BalanceState` | ok, warning, cashBlocked, blocked | UPPER_SNAKE (`CASH_BLOCKED`) | `unknown` |
| `TopUpStatus` | pending, actionRequired, succeeded, failed, pendingApproval, rejected | UPPER_SNAKE | `unknown` |
| `DriverStatus` | applied, pendingReview, changesRequested, active, suspended | UPPER_SNAKE | `unknown` |
| `VehicleStatus` | draft, pendingReview, verified, rejected, suspended, retired | UPPER_SNAKE | `unknown` |
| `DocumentStatus` | pending, approved, rejected, expired | UPPER (`APPROVED`) | `unknown` |
| `DocumentKind` | license, nationalId, photo, registration, insurance, inspection, businessLicense, tinCertificate | UPPER_SNAKE (`NATIONAL_ID`) | `unknown` |
| `PlaceLabel` | home, work, other | the API value lower-cased | `unknown` |
| `TicketCategory` | safety, payment, trip, lostItem, account, feedback | UPPER_SNAKE (`LOST_ITEM`) | `unknown` |
| `TicketStatus` | open, inProgress, waitingRequester, resolved, closed | UPPER_SNAKE | `unknown` |
| `TicketAuthor` | requester, staff, system | UPPER (`authorKind`) | `unknown` |
| `LostItemStatus` | reported, found, notFound, returned, closed | UPPER_SNAKE | `unknown` |
| `LostItemRole` | rider, driver, fleet, staff | UPPER (`viewerRole`, `authorKind`) | `unknown` |
| `SosStatus` | open, acknowledged, resolved | UPPER | `unknown` |
| `SosOutcome` | falseAlarm, assisted, escalated | UPPER_SNAKE | `unknown` |
| `ScheduledStatus` | scheduled, dispatching, dispatched, cancelled, failed | UPPER (`DISPATCHING`) | `unknown` |

`Feature` (client config) is not parsed from a string: each member is read by name from the `features` object, see below.

## Trips (`models/trip.dart`)

Mirrors `libs/shared-types/src/trip.ts`. Returned by `GET /api/trips/:id`, `GET /api/trips/active` (`trip` key), `GET /api/trips` (`trips` list), every trip transition (`POST /api/trips`, `/accept`, `/en-route`, `/arrive`, `/start`, `/complete`, `/cancel`) and the socket event `trip:status` (`trip` key).

### `Trip`

| Field | JSON | Notes |
|---|---|---|
| `id` | `id` | |
| `status` | `status` | `TripStatus`, unknown → `unknown` |
| `cityId` | `cityId` | |
| `channel` | `channel` | default `APP` |
| `vehicleType` | `vehicleType` | a vehicle type code |
| `paymentMethod` | `paymentMethod` | `PaymentMethod` |
| `billingType` | `billing.type` | `PERSONAL` (default) or `CORPORATE` |
| `billingOrgId` | `billing.orgId` | |
| `riderUserId` | `riderUserId` | |
| `pickup`, `dropoff` | `pickup`, `dropoff` | `TripPlace` |
| `driver` | `driver` | `TripDriver`, null until matched |
| `fare` | `fare` | `TripFare` |
| `route` | `route` | `TripRoute` |
| `times` | `times` | `TripTimes` |
| `cancellation` | `cancellation` | `TripCancellation`, null unless cancelled |
| `pin` | `pin` | only sent to the rider |
| `purpose` | `purpose` | a company ride's purpose or cost centre; never sent to the driver |

Getters: `isActive` (requested, matched, enRoute or inProgress), `isDigital` (mobile money or card), `hasArrived` (`times.arrivedAt != null`). Equality compares `id`, `status`, `arrivedAt`, driver id and `finalMinor` only.

### Parts of a trip

| Class | Fields (JSON key = field name unless noted) |
|---|---|
| `TripPlace` | `lat`, `lng`, `address?`. Has `toJson()` and value equality |
| `TripDriver` | `userId`, `vehicleId?` |
| `TripFare` | `estimateMinor`, `finalMinor?`, `waitingFeeMinor?`, `currency` (default `ETB`), `promoDiscountMinor` (default 0), `promoCode?`, `payableMinor`. `chargedMinor` = final, else estimate (what the driver's earning is based on); `payableMinor` = the server's `payableMinor`, else `chargedMinor − promoDiscountMinor` (never below 0): what the rider pays and the driver collects in cash |
| `TripRoute` | `estDistanceMeters`, `estDurationSeconds`, `distanceMeters?`, `durationSeconds?`, `polyline?` (encoded polyline, precision 6; null on older trips) |
| `TripTimes` | `requestedAt` (epoch if missing), `matchedAt?`, `arrivedAt?`, `startedAt?`, `completedAt?`, `cancelledAt?` |
| `TripCancellation` | `by` (`CancelledBy`), `reason` (string, e.g. `NO_DRIVER_FOUND`), `feeMinor`, `driverCompensationMinor` |
| `TripShare` | `token`, `url`, `expiresAt`. Returned by `POST /api/trips/:id/share` |

## Offers, parties and ratings (`models/trip_offer.dart`)

### `TripOffer`

The payload of the socket event `trip:offer` (produced by `services/trip-service/src/matching/matcher.ts`).

| Field | JSON |
|---|---|
| `tripId`, `offerId` | `tripId`, `offerId` |
| `expiresAt` | `expiresAt` |
| `etaToPickupSeconds?` | `etaToPickupSeconds` |
| `pickup`, `dropoff` | `pickup`, `dropoff` (`TripPlace`) |
| `vehicleType` | `vehicleType` |
| `fareEstimateMinor` | `fare.estimateMinor` |
| `currency` | `fare.currency` (default `ETB`) |
| `paymentMethod` | `paymentMethod` |

`remaining(now)` gives the time left (never negative). Equality is by `offerId`.

### Others

| Class | Endpoint | Fields |
|---|---|---|
| `TripParties` | `GET /api/trips/:id/parties` | `driverName` (`driver.name`), `driverRating` (`driver.rating`, null under three ratings per the code comment), `driverRatingCount` (`driver.ratingCount`), `driverPhoto` (`driver.photo`, data URL or https), `riderName` (`rider.name`), `riderPhoto` (`rider.photo`), `vehicle` (`PartyVehicle`) |
| `PartyVehicle` | inside `TripParties` | `plateNumber`, `make`, `model`, `color`, `vehicleType`; `label` = "color make model" |
| `MyRating` | `GET /api/trips/me/rating` | `average?`, `count` |
| `GivenRating` | `GET /api/trips/:id/rating`, key `mine` | `stars`, `tags`, `comment?` |
| `RatingTags` (constants) | mirrors shared-types `RATING_TAGS` | `ofDriver` (10 tags), `ofRider` (8 tags), `positive` (the 7 positive ones) |

## Quotes (`models/quote.dart`)

| Class | Endpoint | Fields |
|---|---|---|
| `Quote` | `POST /api/pricing/estimates`, `quotes[]` | `id`, `cityId`, `vehicleType`, `pickup` / `dropoff` (`TripPlace` built from `pickup` + `pickupAddress`, `dropoff` + `dropoffAddress`), `fareMinor`, `waitingPerMinMinor`, `currency`, `distanceMeters`, `durationSeconds`, `approximate` (routing was down, straight line), `routePolyline6?`, `etaToPickupSeconds?`, `driversNearby`, `breakdown?`, `expiresAt`, `discountMinor` (default 0), `payableMinor` (default `fareMinor − discountMinor`), `promo?` (`QuotePromo`). `isExpired(now)`, `discounted` |
| `QuotePromo` | `Quote.promo` | `promoId`, `code`, `discountMinor`, `fundedBy` |
| `PromoOutcome` | `Estimates.promo` (only when a `promoCode` was sent) | `code`, `applied`, `discountedQuotes`, `reason?` (a `PromoRejection`), `message?` (the server's English sentence) |
| `FareBreakdown` | `Quote.breakdown` | `baseMinor`, `distanceMinor`, `timeMinor`, `minimumApplied` |
| `QuoteRoute` | `POST /api/pricing/estimates`, `route` | `polyline6`, `distanceMeters`, `durationSeconds`, `approximate` |
| `Estimates` | `POST /api/pricing/estimates` | `quotes`, `route?`, `promo?` |

`PromoRejection` holds the reasons pricing-service gives (`promos/discount.ts`): `unknown_code`, `not_active`, `not_started`, `expired`, `exhausted`, `not_in_city`, `vehicle_type_not_eligible`, `limit_reached`, plus the app's own `invalid_format`. `isValidPromoCode(code)` mirrors pricing-service's format check (3–32 letters, digits, `_` or `-`, trimmed): a malformed code makes the API refuse the whole estimate (`validation_error`), so the app checks first.

## Scheduled rides (`models/scheduled.dart`)

| Class | Endpoint | Fields |
|---|---|---|
| `ScheduledTrip` | `GET/POST /api/trips/scheduled`, `GET /api/trips/scheduled/:id`, `POST …/:id/cancel` (`scheduledView`) | `id`, `status` (`ScheduledStatus`), `cityId`, `vehicleType`, `paymentMethod`, `billingType` / `billingOrgId` (`billing.*`), `riderUserId`, `bookedByUserId`, `purpose?`, `pickup` / `dropoff` (`TripPlace`), `fareEstimateMinor` / `currency` (`fare.*`), `estDistanceMeters` / `estDurationSeconds` / `polyline?` (`route.*`), `scheduledFor`, `matchAt` (when matching starts), `tripId?` (once dispatched), `tripStatus?`, `cancelledAt?`, `failReason?`, `editable`. Getters `cancellable` (SCHEDULED: the cancel route answers `invalid_state` after), `upcoming` (SCHEDULED or DISPATCHING) |
| `ScheduleWindow` | none (trip-service doesn't publish it) | `minAhead` (30 min), `maxAhead` (7 days), mirroring trip-service's `DEFAULT_SCHEDULE`. `earliest(now)`, `latest(now)`, `check(at, now)` → null, `too_soon` or `too_far_ahead`; `suggested(now)`: the next quarter hour at least `minAhead` + 15 min away. `ScheduleWindow.tripService` is the default |

## Company policies, incentives, marketing (`models/corporate.dart`, `incentive.dart`, `marketing.dart`)

| Class | Endpoint | Fields |
|---|---|---|
| `CorporatePolicy` | `GET /api/trips/corporate/:orgId/policy` | `orgId`, `allowedVehicleTypes`, `allowedDays` (0 = Sunday, Addis time), `startMinute?` / `endMinute?`, `maxFareMinor?`, `monthlyBudgetMinor?`, `requirePurpose`, `configured`, `spentThisMonthMinor` |
| `PolicyRule` (constants) | `AppError.rule` of a 422 `policy_violation` | `vehicle_type`, `day`, `hours`, `max_fare`, `monthly_budget`, `purpose` |
| `Incentive` | `GET /api/payments/incentives/me?cityId=`, `incentives[]` | `id`, `name`, `cityId`, `vehicleType?`, `targetTrips`, `rewardMinor`, `startsAt`, `endsAt`, `status` (APPROVED or CLOSED), `trips` (the driver's settled trips in the window), `awardedMinor`. Getters `closed`, `reached`, `progress` (0–1), `startsLater(now)`, `counting(now)` (window over, not closed yet) |
| `MarketingPrefs` | `GET`/`PUT /api/notifications/me/marketing` | `push`, `sms` (true = receives campaign messages; default true). `copyWith` |
| `FareCard` | `GET /api/pricing/fares`, `fares[]` | `vehicleType`, `baseMinor`, `perKmMinor`, `perMinMinor`, `minFareMinor`, `waitingPerMinMinor`. Not used by the app (no caller of `PricingApi.fares`) |

## Places (`models/place.dart`)

| Class | Endpoint | Fields |
|---|---|---|
| `Place` | `GET /api/maps/search` (`results[]`), `GET /api/maps/reverse` | `name`, `label?` (full address line), `lat`, `lng`. Has `toJson()`, `copyWith`, equality on lat, lng and name |
| `SavedPlace` | `GET /api/trips/places` (`places[]`), `PUT /api/trips/places/:label`, `POST /api/trips/places` | `id`, `label` (`PlaceLabel`), `name`, `address?`, `lat`, `lng`. `place` converts to a `Place` |
| `NearbyCar` | `GET /api/locations/nearby`, `cars[]` | `lat`, `lng`, `heading?` |
| `NearbyCars` | `GET /api/locations/nearby` | `cars`, `etaSeconds?` (nearest car), `driversNearby`, `approximate`. `NearbyCars.none` is the empty value |

`commonPlaces` is a constant map from city id (`addis-ababa`, `hawassa`) to well-known places, shown before the first keystroke and when search is down. It is the same list as `apps/web/src/components/PlacePicker.tsx` (per the code comment).

## Client config (`models/client_config.dart`)

Returned by `GET /api/platform/client-config?audience=<rider|driver>` (platform-service, public).

| Class | Fields |
|---|---|
| `ClientConfig` | `version`, `cities` (`City`), `vehicleTypes` (`VehicleType`), `features` (`Features`), `maintenance` (`Maintenance`), `minAppVersions` (mode → platform → semver; non-string values become `0.0.0`), `announcements` (`Announcement`) |
| `City` | `id`, `name`, `timezone` (default `Africa/Addis_Ababa`), `bbox` (`BBox`) |
| `BBox` | `minLat`, `minLng`, `maxLat`, `maxLng`; `contains(lat, lng)`, `centerLat`, `centerLng` |
| `VehicleType` | `code`, `name`, `seatsMin`, `seatsMax`, `cities` (empty = every city); `offeredIn(cityId)` |
| `Maintenance` | `newTripsPaused`, `message`. `Maintenance.off` |
| `Announcement` | `id`, `title`, `body`, `severity` (`info` default, or `warning`), `audiences`, `cities`, `startsAt?`, `endsAt?` |

Helpers on `ClientConfig`: `city(id)`, `vehicleTypesIn(cityId)`, `cityAt(lat, lng)` (the served city whose bbox contains the point).

Built-in values, used before the first successful fetch (`ClientConfig.fallback`):

- `City.builtIn`: Addis Ababa (bbox 8.83–9.1, 38.63–38.92) and Hawassa (6.98–7.12, 38.42–38.54), from `libs/shared-location/src/cities.ts`.
- `VehicleType.builtIn`: `economy` (1–4 seats), `comfort` (1–4), `minivan` (1–7).
- `Features.none` (every flag off), `Maintenance.off`, no minimum versions, no announcements, `version: 0`.

### Feature flags

`enum Feature { phoneBooking, corporateBooking, tripPin, scheduledRides, sos, support, promos, accountDeletion }`

`Features.fromJson` reads each flag by its Dart name from the `features` object. A flag missing from the object defaults to **true for `phoneBooking` and `corporateBooking`** and **false for every other flag**. `Features.none` (the fallback) has every flag off, including those two. `features[Feature.x]` returns false for anything not set.

## Sessions and identity (`models/session.dart`)

| Class | Source | Fields |
|---|---|---|
| `Claims` | the access JWT, decoded with `Claims.decode(jwt)` **without verifying the signature** | `userId` (`sub`), `audience` (`aud`, first item if a list), `expiresAt` (`exp`), `issuedAt?` (`iat`), `permissionVersion` (`pv`), `roles` (`roles[]` as `RoleClaim`), `amr` |
| `RoleClaim` | `roles[]` in the JWT (`libs/shared-authz/src/principal.ts` `toRoleClaim`) | `role` (`r`), `orgId?` (`org`), `cityId?` (`city`), `global` (`g`) |
| `Me` | `GET /api/identity/me` | `userId`, `audience`, `permissionVersion`. Not used by the app |
| `Profile` | Better Auth `user` (in `GET /api/auth/get-session`, the OTP verify response, `POST /api/auth/update-user`) | `id`, `name`, `phone` (`phoneNumber`), `image?` |
| `SessionInfo` | `GET /api/auth/list-sessions` | `token`, `createdAt`, `expiresAt`, `ipAddress?`, `userAgent?` |
| `DevAccount` | `GET /api/dev/accounts`, `accounts[]` (DEV_LOGIN=on only) | `key`, `name`, `label`, `phone`, `app` (`phone` or `web`, default `web`), `seeded` |
| `Organization` | `GET /api/auth/organization/list` | `id`, `name`, `kind` (FLEET, CORPORATE, STAFF_CITY, STAFF_HQ), `status` (PENDING, ACTIVE, SUSPENDED), `slug?`, `cityId?`; `isCorporate`, `isFleet` |
| `OrgInvitation` | `GET /api/auth/organization/list-user-invitations` | `id`, `organizationId`, `organizationName?`, `role`, `status` (default `pending`), `expiresAt?`; `isPending` (pending and not expired) |
| `VerifiedSession` (in `api/auth_api.dart`) | `POST /api/auth/phone-number/verify` | `sessionToken`, `user` (`Profile`) |

`Claims` getters: `hasRole(code)`, `isRider` (`RIDER`), `isDriver` (`DRIVER` or `FLEET_DRIVER`), `isFleetDriver`, `orgIds` (distinct org ids across roles), `isFresh(now, margin: 60 s)`.

## Payments, rider side (`models/payment.dart`)

| Class | Endpoint | Fields |
|---|---|---|
| `Payment` | `GET /api/payments/trips/:tripId` (`payments[]`), `POST /api/payments/payments/:id/pay`, socket `payment:*` (`payment` key) | `id`, `purpose` (`TRIP_FARE` default, or `CANCELLATION_FEE`), `tripId`, `method`, `provider`, `amountMinor`, `currency`, `status` (`PaymentStatus`), `checkoutUrl?` (provider page, only while ACTION_REQUIRED), `attempts`, `nextAttemptAt?`, `lastError?`, `refundedMinor`, `settledAsReceivable`, `createdAt`, `completedAt?` |
| `Settlement` | `GET /api/payments/trips/:tripId`, `settlements[]` (drivers and staff only) | `purpose`, `paymentMethod`, `fareMinor`, `commissionMinor`, `vatMinor`, `earningsMinor` (negative on cash trips), `settledAt` |
| `TripPayments` | `GET /api/payments/trips/:tripId` | `payments`, `settlements`. `fare` = the `TRIP_FARE` payment, else the first. `TripPayments.empty` |
| `PaymentProvider` | `GET /api/payments/methods`, `providers[]` | `provider`, `label`, `methods`, `mode` (`simulated` until real integrations); `isSimulated`, `takesMobileMoney` |
| `PaymentMethodsConfig` | `GET /api/payments/methods` | `methods` (offered to riders in the city), `providers`. `fallback` = cash only, no providers |
| `EarningsSummary` | `GET /api/payments/earnings/me` | `from`, `to`, `trips`, `cancellations`, `grossMinor`, `commissionMinor`, `vatMinor`, `netMinor`, `balanceChangeMinor`, `cashCollectedMinor`, `byDay` (`EarningsDay`). `EarningsSummary.empty` |
| `EarningsDay` | inside `EarningsSummary` | `day` (YYYY-MM-DD, Addis time), `trips`, `grossMinor`, `netMinor` |

`Payment` getters: `isPaid` (succeeded, refunded, partially refunded), `isOpen` (pending, action required, retry scheduled), `isOwed` (failed).

## Balance, driver side (`models/balance.dart`)

| Class | Endpoint | Fields |
|---|---|---|
| `Balance` | `GET /api/payments/balances/me`, `/balances/org/:id`, `/balances/:accountId`, `PUT .../payout-method` | `accountId?` (null until the first trip or top-up opens the account), `ownerType` (`beneficiary.type`, INDIVIDUAL default or ORGANIZATION), `ownerId` (`beneficiary.id`), `cityId`, `balanceMinor` (> 0 the platform owes them, < 0 they owe), `currency`, `state` (`BalanceState`), `cashAllowed` (default true), `stateChangedAt?`, `overdueSince?`, `referenceCode?` (quoted on bank transfers), `payoutMethod?`, `suggestedTopUpMinor`, `policy`, `dues` |
| `BalancePolicy` | `Balance.policy` | `mode` (POSTPAID default, or PREPAID), `warningMinor`, `cashLimitMinor`, `hardLimitMinor`, `prepaidMinimumMinor`, `minPayoutMinor`, `dueDays` (default 3), `builtIn`; `prepaid` |
| `PaymentDue` | `Balance.dues[]` | `id`, `amountMinor`, `minimumMinor`, `paidMinor`, `dueAt`, `status` (OPEN default, MIN_PAID, PAID, OVERDUE, WRITTEN_OFF); `isOpen`, `leftMinor`, `minimumLeftMinor` |
| `PayoutMethod` | `Balance.payoutMethod` | `provider`, `destination?` (masked) |
| `StatementEntry` | `GET /api/payments/balances/:accountId/statement`, `entries[]` | `id`, `at`, `amountMinor`, `kind` (TRIP_SETTLEMENT, CANCELLATION_FEE, TOP_UP, PAYOUT, PAYOUT_REVERSAL, REFUND, RECEIVABLE_COLLECTION), `memo?`, `referenceType` (`reference.type`), `referenceId` (`reference.id`) |
| `TopUp` | `GET /api/payments/balances/:accountId/top-ups` (`topUps[]`), `POST` same path, `GET /api/payments/top-ups/:id`, socket `balance:topped_up` (`topUp` key) | `id`, `accountId`, `channel` (MOBILE_MONEY, BANK_TRANSFER, OFFICE_CASH), `provider?`, `amountMinor`, `status` (`TopUpStatus`), `checkoutUrl?`, `failure?`, `instructions?` (create response only), `createdAt`, `completedAt?`; `isOpen` |

`Balance` getters: `owes`, `openDues`. Equality compares `accountId`, `balanceMinor`, `state` and the number of dues.

## Fleet, driver side (`models/fleet.dart`)

| Class | Endpoint | Fields |
|---|---|---|
| `DriverHome` | `GET /api/fleet/drivers/me` | `driver?` (`DriverProfile`), `vehicles`, `fleetVehicles`, `session?` (`DrivingSession`). `allVehicles` = both lists. `DriverHome.empty` |
| `DriverProfile` | `DriverHome.driver`, `POST /api/fleet/drivers/apply`, `POST /api/fleet/drivers/me/submit` | `userId`, `status` (`DriverStatus`), `statusReason?`, `reviewNote?`, `fullName`, `licenseNumber`, `cityId`, `submittedAt?`, `activatedAt?`, `checklist` (parsed from the same object). `isActive` |
| `Checklist` | inside `DriverProfile`; also `GET /api/fleet/vehicles/:id` | `items` (`documents[]` as `ChecklistItem`), `missingForSubmit`, `missingForApproval` (document kinds). `readyToSubmit`. `Checklist.empty` |
| `ChecklistItem` | `Checklist.documents[]`, `GET /api/fleet/documents` (`documents[]`) | `kind`, `required` (default true), `expires` (needs an expiry date), `document?` (`DocumentView`). `needsUpload` = no document, or rejected or expired |
| `DocumentView` | `ChecklistItem.document`, `POST /api/fleet/documents` | `id`, `kind`, `status`, `contentType?`, `expiresAt?` (YYYY-MM-DD string), `expiringSoon`, `rejectReason?`, `createdAt`. `isImage` |
| `DocumentUrl` | `GET /api/fleet/documents/:id/url` | `url`, `contentType?`, `expiresIn` (default 300 s) |
| `UploadTicket` | `POST /api/fleet/documents/upload-url` | `uploadUrl`, `headers` (map, all values stringified), `ticket`, `expiresIn` (default 300 s) |
| `Vehicle` | `DriverHome.vehicles[]`, `GET /api/fleet/drivers/me/vehicles` (`vehicles[]`), `POST /api/fleet/vehicles`, `GET /api/fleet/vehicles/:id`, `POST /api/fleet/vehicles/:id/submit` | `id`, `plateNumber`, `ownerType` (INDIVIDUAL default, or ORGANIZATION), `ownerOrgId?`, `vehicleType`, `make`, `model`, `year`, `color`, `seats`, `status` (`VehicleStatus`), `statusReason?`, `reviewNote?`, `cityId`, `authorizationValidUntil?` (`authorization.validUntil`), `canDrive?`, `denial?`, `denialMessage?` (`message`). `label`, `isFleet` |
| `DrivingSession` | `DriverHome.session`, `POST /api/fleet/sessions`, `GET /api/fleet/sessions/current` (`session` key) | `id`, `vehicleId`, `startedAt`, `endedAt?`, `endReason?` (DRIVER, CONNECTION_LOST, BALANCE_BLOCKED, SUSPENDED, VEHICLE_UNAVAILABLE, FLEET_SUSPENDED). `isOpen` |

`canDrive`, `denial` and `message` are only present on `GET /api/fleet/drivers/me/vehicles`; elsewhere `canDrive` is null.

## Support (`models/support.dart`)

support-service's app-facing views (`services/support-service/src/support/views.ts`): the requester view of a ticket, the rider / driver / fleet view of a lost item, the owner view of an SOS alert. Staff-only fields (priority, assignee, incident links, user ids) are never sent to the app. Fixtures: `test/fixtures/ticket.json`, `lost_item.json`, `sos_alert.json`; tests in `test/support_test.dart`.

| Class | Endpoint | Fields |
|---|---|---|
| `Ticket` | `POST /api/support/tickets`, `GET /api/support/me/tickets` (`tickets[]`), `GET /api/support/tickets/:id` (`ticket`), `POST .../reopen` | `id`, `ref` (the number shown as "#1042"), `cityId`, `category`, `status`, `subject`, `description`, `tripId?`, `resolution?` (NO_ACTION, EXPLAINED, REFUND, ADJUSTMENT, DRIVER_WARNING, ESCALATE_SAFETY), `resolutionNote?`, `resolvedAt?`, `closedAt?`, `lostItemId?`, `createdAt`, `updatedAt`. `isOpen` (open, in progress, waiting), `canReply` (= `isOpen`), `canReopen(now)` (resolved ≤ 7 days ago) |
| `TicketMessage` | `GET /api/support/tickets/:id` (`messages[]`), `POST .../messages` (`message`) | `id`, `authorUserId?` (null for staff and system), `author` (`authorKind`), `internal`, `body`, `createdAt` |
| `TicketThread` | `GET /api/support/tickets/:id` | `ticket`, `messages` (oldest first; `internal` ones are dropped even if sent) |
| `LostItem` | `POST /api/support/lost-items`, `GET /api/support/me/lost-items` (`lostItems[]`), `GET /api/support/lost-items/:id` (`lostItem`), `POST .../respond`, `POST .../status` | `id`, `ticketId`, `tripId`, `cityId`, `description`, `status`, `driverNote?`, `respondedAt?`, `returnedAt?`, `closedAt?`, `createdAt`, `updatedAt`, `viewerRole`. `isRider`, `isDriverSide` (driver or fleet), `canMessage` (not closed), `canAnswerFound` (driver side, reported or not found), `canAnswerNotFound` (driver side, reported or found), `canConfirmReturned` (rider, found) |
| `LostItemMessage` | `GET /api/support/lost-items/:id` (`messages[]`), `POST .../messages` (`message`) | `id`, `author` (`authorKind`), `body`, `createdAt` |
| `LostItemThread` | `GET /api/support/lost-items/:id` | `lostItem`, `messages` |
| `SosAlert` | `POST /api/support/sos` (`alert`), `GET /api/support/sos/:id` (`alert`), `POST .../location` | `id`, `tripId`, `status`, `outcome?`, `triggeredAt`, `acknowledgedAt?`, `resolvedAt?`. `isLive` (open or acknowledged) |
| `SosTrigger` | `POST /api/support/sos` | `alert`, `duplicate` (a live alert for the trip, or one pressed in the last 2 min, came back instead of a new one) |

Rules mirrored from `services/support-service/src/support/policy.ts` (`SupportLimits`):

| Helper | Rule |
|---|---|
| `sosAvailable(trip, now)` | trip matched, en route or in progress, or completed ≤ 30 min ago (`sos_unavailable` otherwise; a trip still `requested` doesn't qualify) |
| `lostItemReportable(trip, now)` | trip completed ≤ 7 days ago (`report_window_closed`) |
| `Ticket.canReopen(now)` | resolved ≤ 7 days ago (`reopen_window_closed`) |

`ticketCategoriesForApp` is the list "Contact support" offers: every category except LOST_ITEM (the route answers `use_lost_items`; lost items have their own route).

## Routing and positions (`api/service_apis.dart`)

| Class | Endpoint | Fields |
|---|---|---|
| `RouteSteps` | `GET /api/maps/route` | `polyline6` (default empty), `distanceMeters`, `durationSeconds`, `approximate`, `steps` |
| `RouteStep` | `RouteSteps.steps[]` | `type` (`maneuver.type`, OSRM: depart, turn, new name, continue, merge, on ramp, off ramp, fork, end of road, roundabout, exit roundabout, arrive…), `modifier?` (`maneuver.modifier`), `lat` / `lng` (`maneuver.location`), `bearingAfter` (`maneuver.bearingAfter`), `exit?` (`maneuver.exit`), `name`, `distanceMeters`, `durationSeconds` |
| `DriverPosition` | `GET /api/locations/trips/:tripId/driver` | `driverId`, `lat`, `lng`, `heading?`, `at` (unix ms or ISO; now if missing) |

`typedef OfferModel = TripOffer` is also exported from this file.
