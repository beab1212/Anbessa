# Realtime events

Source: `packages/core/lib/src/realtime/realtime_event.dart`.

The phone app keeps one Socket.io connection to realtime-gateway (Socket.io v4, never behind Kong). Core only knows the event names and how to parse them; the connection, reconnects, token refresh and trip rooms are in the app's `RealtimeHub` (`apps/phone-app/lib/core/realtime/realtime_hub.dart`, described in `apps/phone-app/docs/architecture.md`).

Producers, per the file header: trip-service (`trip:*`), payment-service (`payment:*`, `balance:*`), the gateway itself (`driver:location`).

## Events the app listens to

`realtimeEventNames` is the list the hub registers on the socket. Each incoming event goes through `RealtimeEvent.fromSocket(name, payload)`. It returns `null` for an unknown name, and also when parsing throws a `FormatException`; the hub drops `null`s.

| Socket event | Class | Payload read | Used by (app) |
|---|---|---|---|
| `trip:status` | `TripStatusEvent(tripId, status, trip)` | `tripId`, `status` (TripStatus string), `trip` (a full trip view, see `Trip` in [models.md](models.md)) | `ActiveTripController` (rider and driver), `BalanceController` (refresh 3 s after `completed` / `cancelled`) |
| `trip:offer` | `OfferEvent(offer)` | the whole payload as `TripOffer`: `tripId`, `offerId`, `expiresAt`, `etaToPickupSeconds`, `pickup`, `dropoff`, `vehicleType`, `fare.estimateMinor`, `fare.currency`, `paymentMethod` | `OfferController` (driver) |
| `trip:offer_expired` | `OfferExpiredEvent(tripId, offerId)` | `tripId`, `offerId` | `OfferController` |
| `trip:offer_cancelled` | `OfferCancelledEvent(tripId)` | `tripId` | `OfferController` |
| `driver:location` | `DriverLocationEvent(tripId, driverId, lat, lng, heading?, speed?, at)` | `tripId`, `driverId`, `lat`, `lng`, `heading`, `speed` (m/s), `at` (unix ms; now if missing) | `driverLiveProvider` (rider trip screen) |
| `payment:action_required` | `PaymentActionRequiredEvent(payment, instructions?)` | `payment` (`Payment`), `instructions` | `TripPaymentsController` (pay screen) |
| `payment:captured` | `PaymentCapturedEvent(payment)` | `payment` | `TripPaymentsController` |
| `payment:failed` | `PaymentFailedEvent(payment)` | `payment` | `TripPaymentsController` |
| `balance:topped_up` | `BalanceToppedUpEvent(topUp)` | `topUp` (`TopUp`) | `BalanceController` (driver) |

`RealtimeEvent` is `sealed`, so features `switch` on the classes.

`driver:location` reaches only sockets that joined the trip's room with `trip:subscribe` (rider and driver of that trip, per the hub's comment).

## Events the app emits

These are sent by `RealtimeHub` with an acknowledgement.

| Event | Payload | Ack | Notes |
|---|---|---|---|
| `trip:subscribe` | the trip id (a string) | `{ok: bool}` | joins the trip room. The hub waits 5 s, then treats it as `false`. Rooms are re-joined after every reconnect |
| `trip:unsubscribe` | the trip id | ignored | leaves the room |
| `location:update` | `LocationPing.toJson()`: `{lat, lng, heading?, speed?, accuracy?, at}` | `PingAck`: `{accepted: bool, reason?}` | the online driver's position. The hub gives up after 3 s with `reason: 'timeout'`, and answers `reason: 'offline'` itself when the socket is not connected |

### `LocationPing`

| Field | Unit |
|---|---|
| `lat`, `lng` | degrees |
| `heading?` | degrees |
| `speed?` | m/s |
| `accuracy?` | metres |
| `at` | unix ms, device time |

### `PingAck.reason` values

From the class comment: `forbidden`, `too_frequent`, `unavailable`, `invalid`, `inaccurate`, `future`, `out_of_order`, `too_fast`, plus the hub's own `timeout` and `offline`. The driver's `ShiftController` counts a rejection for any reason except `offline`, `too_frequent` and `timeout`, and shows "GPS poor" after five rejections in a row that outnumber the accepted pings.

## Handshake

The token goes in the Socket.io `auth` object: `{token: <access JWT>}`. The gateway checks it only at the handshake (per the hub's comment), which is why the app refreshes it before every reconnect. A connect error whose text contains `unauthorized` makes the hub force a new token; three such refusals in a row sign the person out.
