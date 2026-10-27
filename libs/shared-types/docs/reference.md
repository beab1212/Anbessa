# API reference: `@ride-app/shared-types`

Every export, field by field. Topic-level information (key, producer, consumers) is in [event-catalog.md](event-catalog.md).

Conventions used in the code:

- `…Minor` amounts are integers in minor units (santim; 1 birr = 100 santim). `currency` is a string (ETB in practice; not constrained by the type).
- `at` in `EventEnvelope` is an ISO 8601 string. `at` in `DriverLocationEvent` is **unix milliseconds** (device time). They are different fields with the same name.
- Ids are strings. Consumers that validate (location-service, fleet-service) require UUIDs for user, trip and org ids.

Contents: [Envelope](#envelope) · [Driver events](#driver-events) · [Trip events](#trip-events) · [Payment events](#payment-events) · [User events](#user-events) · [Shared enums](#shared-enums) · [Trip DTO](#trip-dto) · [RATING_TAGS](#rating_tags) · [user.ts](#userts)

---

## Envelope

### `EventEnvelope`

```ts
interface EventEnvelope {
  eventId: string;   // uuidv7 in every producer; consumers dedupe on it
  version: number;   // 1 in every producer
  at: string;        // ISO 8601, set when the outbox row is written
}
```

"Every event also carries the envelope" (comment in `events.ts`), with one exception: `DriverLocationEvent` does not extend it.

---

## Driver events

### `DriverLocationEvent` → `driver.location`

Not an `EventEnvelope`: no `eventId`, `version` or ISO `at`.

| Field | Type | Notes |
|---|---|---|
| `driverId` | `string` | Kafka key |
| `tripId` | `string?` | set while the driver is on a trip, taken from the Redis driver state, never from the client |
| `cityId` | `string` | from the driver state |
| `lat`, `lng` | `number` | |
| `heading` | `number?` | |
| `speed` | `number?` | |
| `accuracy` | `number?` | metres |
| `at` | `number` | device time, unix ms |

Built in `services/realtime-gateway/src/sockets/location.handler.ts` for accepted pings only (after `recordPing` accepts).

### `DriverOnlineEvent` → `driver.online`

`extends EventEnvelope`.

| Field | Type | Notes |
|---|---|---|
| `driverId` | `string` | |
| `vehicleId` | `string` | |
| `vehicleType` | `string` | e.g. `economy` |
| `cityId` | `string` | |
| `fleetOrgId` | `string?` | fleet organisation owning the vehicle; absent for owner-drivers |
| `beneficiaryId` | `string?` | optional in the type; fleet-service always sends `fleetOrgId ?? driverId` |
| `balanceState` | `BalanceState?` | fleet-service sends `balance?.state ?? "OK"` |
| `cashAllowed` | `boolean` | fleet-service sends `balance?.cashAllowed ?? true` |

### `DriverOfflineEvent` → `driver.offline`

`extends EventEnvelope`.

| Field | Type |
|---|---|
| `driverId` | `string` |
| `reason` | `"DRIVER" \| "CONNECTION_LOST" \| "BALANCE_BLOCKED" \| "SUSPENDED" \| "VEHICLE_UNAVAILABLE" \| "FLEET_SUSPENDED"` |

### `DriverConnectionLostEvent` → `driver.connection_lost`

`extends EventEnvelope`. Sent by location-service when a driver has had no ping for 10 minutes and has no trip.

| Field | Type | Notes |
|---|---|---|
| `driverId` | `string` | |
| `cityId` | `string` | |
| `lastSeenAt` | `string` | ISO 8601 of the last ping |

---

## Trip events

All produced by trip-service, key `tripId`.

### `TripRequestedEvent` → `trip.requested`

| Field | Type | Notes |
|---|---|---|
| `tripId`, `riderId`, `bookedById` | `string` | `bookedById` differs from `riderId` for phone and corporate bookings |
| `cityId`, `vehicleType` | `string` | |
| `channel` | `"APP" \| "PHONE" \| "CORPORATE_PORTAL"` | |
| `paymentMethod` | `PaymentMethod` | |
| `fareEstimateMinor` | `number` | |

### `TripMatchedEvent` → `trip.matched`

| Field | Type |
|---|---|
| `tripId`, `riderId`, `driverId`, `cityId`, `vehicleType` | `string` |

### `TripProgressEvent` → `trip.driver_en_route`, `trip.driver_arrived`, `trip.started`

| Field | Type |
|---|---|
| `tripId`, `riderId`, `driverId`, `cityId` | `string` |

### `TripEndedEvent`

Base interface for `TripCompletedEvent` and `TripCancelledEvent`; not used directly.

| Field | Type |
|---|---|
| `tripId`, `riderId` | `string` |
| `driverId` | `string?` |

### `TripCompletedEvent` → `trip.completed`

`extends TripEndedEvent`. "Everything payment-service needs to settle (Payment.md §6)."

| Field | Type | Notes |
|---|---|---|
| `driverId` | `string` | required here (optional on the base) |
| `cityId`, `vehicleType`, `vehicleId` | `string` | |
| `beneficiary` | `Beneficiary` | who earns the trip |
| `paymentMethod` | `PaymentMethod` | |
| `billingType` | `"PERSONAL" \| "CORPORATE"` | |
| `billingOrgId` | `string?` | company account trips |
| `fareMinor` | `number` | final fare, waiting fee included; the full fare (the driver's earning is computed on it) |
| `waitingFeeMinor` | `number` | |
| `quoteId` | `string?` | the pricing-service quote the trip was booked with |
| `promoDiscountMinor` | `number?` | promo discount given to the rider, 0 ≤ discount ≤ `fareMinor`; absent = 0. The rider pays `fareMinor − promoDiscountMinor` |
| `currency` | `string` | |
| `distanceMeters`, `durationSeconds` | `number` | |
| `completedAt` | `string` | ISO 8601 |

### `TripCancelledEvent` → `trip.cancelled`

`extends TripEndedEvent` (workflow 07).

| Field | Type | Notes |
|---|---|---|
| `driverId` | `string?` | absent when no driver was assigned |
| `cityId` | `string` | |
| `by` | `"RIDER" \| "DRIVER" \| "SYSTEM" \| "STAFF"` | |
| `reason` | `string` | e.g. `NO_DRIVER_FOUND` for the matcher timeout |
| `paymentMethod` | `PaymentMethod` | |
| `feeMinor` | `number` | charged to the rider; 0 when free |
| `driverCompensationMinor` | `number` | credited to the beneficiary out of the fee |
| `beneficiary` | `Beneficiary?` | |
| `billingOrgId` | `string?` | company account trips: the fee is billed to the company |
| `quoteId` | `string?` | the pricing-service quote the trip was booked with (pricing releases its promo reservation) |
| `currency` | `string` | |

---

## Payment events

All produced by payment-service (Payment.md, workflows 08–09).

### `BalanceStateChangedEvent` → `balance.state_changed`

Key: the beneficiary's owner id.

| Field | Type | Notes |
|---|---|---|
| `accountId` | `string` | beneficiary account |
| `beneficiary` | `Beneficiary` | |
| `cityId` | `string` | |
| `state`, `previousState` | `BalanceState` | |
| `cashAllowed` | `boolean` | "OK and WARNING may take cash trips" |
| `balanceMinor` | `number` | |

### `PaymentActionRequiredEvent` → `payment.action_required`

Key: `riderId`. The rider must approve the charge with their provider.

| Field | Type |
|---|---|
| `paymentId`, `tripId`, `riderId` | `string` |
| `purpose` | `"TRIP_FARE" \| "CANCELLATION_FEE"` |
| `provider` | `string` |
| `amountMinor` | `number` |
| `currency` | `string` |
| `checkoutUrl` | `string \| null` |

### `PaymentOutcomeEvent` → `payment.captured`, `payment.failed`

Key: `riderId`.

| Field | Type | Notes |
|---|---|---|
| `paymentId`, `tripId`, `riderId` | `string` | |
| `purpose` | `"TRIP_FARE" \| "CANCELLATION_FEE"` | |
| `provider` | `string` | |
| `method` | `PaymentMethod` | |
| `amountMinor` | `number` | |
| `currency` | `string` | |
| `final` | `boolean?` | `payment.failed`: `true` = no retry left (settled as a rider receivable); payment-service sends `false` with `nextAttemptAt` otherwise |
| `nextAttemptAt` | `string?` | ISO 8601 |

### `TripSettledEvent` → `trip.settled`

Key: `tripId`. The ledger entry for a trip, any payment method ("the receipt").

| Field | Type | Notes |
|---|---|---|
| `tripId`, `riderId` | `string` | |
| `driverId` | `string?` | |
| `beneficiary` | `Beneficiary?` | |
| `purpose` | `"TRIP_FARE" \| "CANCELLATION_FEE"` | |
| `paymentMethod` | `PaymentMethod` | |
| `fareMinor`, `commissionMinor`, `vatMinor` | `number` | |
| `earningsMinor` | `number` | what the beneficiary's balance moved by (negative on cash trips) |
| `promoDiscountMinor` | `number?` | promo discount booked to `PROMO_EXPENSE`; the rider paid `fareMinor − promoDiscountMinor`. Absent = 0 |
| `currency` | `string` | |

### `BalanceMoneyEvent` → `balance.topped_up`, `balance.payment_due`, `payout.sent`, `payout.failed`

Key: the beneficiary's owner id.

| Field | Type | Notes |
|---|---|---|
| `accountId` | `string` | |
| `beneficiary` | `Beneficiary` | |
| `amountMinor`, `balanceMinor` | `number` | |
| `currency` | `string` | |
| `channel` | `string?` | |
| `provider` | `string?` | |
| `minimumMinor` | `number?` | `balance.payment_due` |
| `dueAt` | `string?` | `balance.payment_due` |
| `failure` | `string?` | `payout.failed` |

### `RefundOutcomeEvent` → `refund.succeeded`, `refund.failed`

Key: `riderId`.

| Field | Type |
|---|---|
| `refundId`, `paymentId`, `tripId`, `riderId` | `string` |
| `amountMinor` | `number` |
| `currency` | `string` |

### Money controls → `balance.adjusted`, `balance.written_off`, `incentive.awarded`, `invoice.issued`, `invoice.paid`

Topic names are exported as `PAYMENT_CONTROL_TOPICS` (type `PaymentControlTopic`).

| Type | Topic (key) | Fields |
|---|---|---|
| `BalanceAdjustedEvent` | `balance.adjusted` (beneficiary owner id) | `adjustmentId`, `accountId`, `beneficiary`, `direction` (`"CREDIT" \| "DEBIT"`), `amountMinor` (positive), `category` (`GOODWILL`, `FEE_REVERSAL`, `CORRECTION`, `LOST_ITEM_RETURN`, `OTHER`), `balanceMinor`, `currency`, `tripId?`, `ticketId?` |
| `BalanceWrittenOffEvent` | `balance.written_off` (beneficiary owner id) | `writeOffId`, `accountId`, `beneficiary`, `amountMinor`, `balanceMinor`, `currency` |
| `IncentiveAwardedEvent` | `incentive.awarded` (beneficiary owner id) | `awardId`, `programId`, `programName`, `cityId`, `driverId`, `accountId`, `beneficiary`, `trips`, `amountMinor`, `balanceMinor`, `currency` |
| `InvoiceEvent` | `invoice.issued`, `invoice.paid` (`orgId`) | `invoiceId`, `orgId`, `number`, `period` (YYYY-MM), `totalMinor`, `paidMinor`, `currency`, `dueAt`, `paidAt?` (`invoice.paid`) |

---

## User events

### `UserCreatedEvent` → `user.created`

`extends EventEnvelope`. Documented as "auth-service → `user.created` (key userId)".

| Field | Type | Notes |
|---|---|---|
| `userId` | `string` | |
| `guest` | `boolean` | created by the call center (phone only, not yet claimed) |

auth-service doesn't import this type; it declares the same shape in `services/auth-service/src/outbox/outbox.ts`.

---

## Support events (support-service)

Producer: `services/support-service/src/outbox/outbox.ts` (the outbox union uses these types minus the envelope). `SUPPORT_TOPICS` maps a short name to each topic string (`SUPPORT_TOPICS.sosTriggered === "sos.triggered"`); `SupportTopic` is the union of the values. No consumer yet (see [event-catalog.md](event-catalog.md)).

| Type | Topic | Key | Notes |
|---|---|---|---|
| `TicketCreatedEvent` | `ticket.created` | ticketId | `ref` is the human number (#1042); `firstResponseDueAt` from the category SLA |
| `TicketResolvedEvent` | `ticket.resolved` | ticketId | `byUserId: null` when the 72 h no-reply timer resolved it |
| `TicketClosedEvent` | `ticket.closed` | ticketId | `automatic: true` from the 7-day timer |
| `LostItemReturnedEvent` | `lost_item.returned` | lostItemId | |
| `SosTriggeredEvent` | `sos.triggered` | alertId | `tripVerified: false` when trip-service was down and the app's `cityId` was used |
| `SosAcknowledgedEvent` | `sos.acknowledged` | alertId | |
| `SosResolvedEvent` | `sos.resolved` | alertId | `outcome`: `FALSE_ALARM` \| `ASSISTED` \| `ESCALATED` |
| `IncidentOpenedEvent` | `incident.opened` | incidentId | `source`: `SOS` \| `TICKET` \| `MANUAL`; `byUserId: null` for the automatic incident of a SAFETY ticket |
| `IncidentResolvedEvent` | `incident.resolved` | incidentId | suspensions themselves are auth-service's `user.suspended` |

Shared unions: `TicketCategory`, `TicketPriority`, `TicketResolution`, `IncidentCategory`, `IncidentSeverity`, `IncidentOutcome`.

## Shared enums

### `PaymentMethod`

```ts
type PaymentMethod = "CASH" | "MOBILE_MONEY" | "CARD" | "CORPORATE";
```

`Trip.paymentMethod` repeats the same union inline. The `payments.methods` setting (shared-settings) only offers `CASH`, `MOBILE_MONEY`, `CARD`.

### `Beneficiary`

```ts
interface Beneficiary {
  type: "INDIVIDUAL" | "ORGANIZATION";
  id: string;
}
```

Who earns the trip (Payment.md D1): the fleet company for `ORGANIZATION` vehicles, else the driver. trip-service derives it from the trip's vehicle owner type (`beneficiaryOf` in `src/trips/service.ts`).

### `BalanceState`

```ts
type BalanceState = "OK" | "WARNING" | "CASH_BLOCKED" | "BLOCKED";
```

Effect on matching (shared-location `nearbyAvailable`): `BLOCKED` drivers are never offered trips; `CASH_BLOCKED` drivers have `cashAllowed: false` and are skipped only for cash searches.

---

## Trip DTO

### `TripStatus`

```ts
type TripStatus = "requested" | "matched" | "en_route" | "in_progress" | "completed" | "cancelled";
```

Lower case, unlike the event enums. trip-service transitions (`src/trips/service.ts`): `matched → en_route` (driver en route), `en_route → en_route` with `arrivedAt` (arrived), `en_route → in_progress` (started).

### `TripPlace`

```ts
interface TripPlace { lat: number; lng: number; address: string | null }
```

### `Trip`

"The trip as trip-service's API returns it (GET /api/trips/:id, socket trip:status)." trip-service builds it in `tripView()` (`services/trip-service/src/trips/service.ts`) without importing this type; `apps/web` reads it (`src/lib/hooks.ts`, `pages/staff/Board.tsx`, `TripDetail.tsx`, `PhoneBooking.tsx`, `pages/partner/Partner.tsx`).

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | |
| `status` | `TripStatus` | |
| `cityId` | `string` | |
| `channel` | `"APP" \| "PHONE" \| "CORPORATE_PORTAL"` | |
| `vehicleType` | `string` | |
| `paymentMethod` | `"CASH" \| "MOBILE_MONEY" \| "CARD" \| "CORPORATE"` | |
| `billing` | `{ type: "PERSONAL" \| "CORPORATE"; orgId: string \| null }` | |
| `riderUserId` | `string` | |
| `pickup`, `dropoff` | `TripPlace` | |
| `driver` | `{ userId: string; vehicleId: string \| null } \| null` | |
| `fare` | `{ estimateMinor: number; finalMinor: number \| null; waitingFeeMinor: number \| null; currency: string }` | minor units |
| `route` | `{ estDistanceMeters: number; estDurationSeconds: number; distanceMeters: number \| null; durationSeconds: number \| null; polyline: string \| null }` | `polyline`: road line pickup → drop-off, encoded polyline precision 6; null for trips quoted before it existed |
| `times` | `{ requestedAt, matchedAt, arrivedAt, startedAt, completedAt, cancelledAt }` | ISO 8601 strings; all but `requestedAt` nullable |
| `cancellation` | `{ by: "RIDER" \| "DRIVER" \| "SYSTEM" \| "STAFF"; reason: string; feeMinor: number; driverCompensationMinor: number } \| null` | |
| `pin` | `string?` | only to the rider and whoever booked the trip; the driver asks for it at pickup |
| `flags` | `string[]?` | staff only (`ride-admin` audience): review flags such as `FAR_FROM_DROPOFF` |

---

## `RATING_TAGS`

```ts
const RATING_TAGS = {
  RIDER: ["polite", "safe_driving", "clean_car", "on_time", "good_navigation", "rude", "unsafe_driving", "dirty_car", "late", "took_long_route"],
  DRIVER: ["polite", "on_time", "clear_pickup", "respectful", "rude", "late", "wrong_pickup", "left_mess"],
} as const;
```

The tags a rater may tick, keyed by **who rates** (workflow 08 step 14): `RIDER` tags describe the driver, `DRIVER` tags describe the rider. The apps localise them.

Call site (`services/trip-service/src/trips/service.ts`, `rate()`):

```ts
const byRole = p.userId === t.riderUserId ? "RIDER" : p.userId === t.driverUserId ? "DRIVER" : undefined;
const allowed: readonly string[] = RATING_TAGS[byRole];
const unknown = tags.filter((x) => !allowed.includes(x));
if (unknown.length) throw badRequest(`unknown tags: ${unknown.join(", ")}`, "invalid_tags");
```

---

## user.ts

```ts
type Role = "RIDER" | "DRIVER" | "ADMIN";
interface PublicUser { id: string; email: string; phone: string; role: Role }
```

Not imported anywhere. `Role` predates the role catalogue in shared-authz (there is no `ADMIN` role code there). trip-service has its own unrelated `PublicUser` interface in `src/lib/clients.ts`. Treat these as legacy.
