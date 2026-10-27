# realtime-gateway: API

Port 3000. One Node HTTP server serves the health routes and Socket.io (default path `/socket.io/`). Not behind Kong: apps connect directly (`WS_URL` in `apps/phone-app/env/*.json`, e.g. `ws://localhost:3000`).

## HTTP routes (`src/server.ts`)

| Route | Response |
|---|---|
| `GET /health` | `200` body `ok` (text) |
| `GET /health/live` | `200` body `ok` |
| `GET /health/ready` | `PING` to Redis OK → `200 {"status":"ok","kafka":{"published":N,"dropped":N}}`; fails → `503 {"status":"unavailable"}` |
| anything else (not `/socket.io/…`) | `404`, empty body |

The method isn't checked. The `kafka` counters are process-local, since start; platform-service shows them on the admin system page as "location stream" (`services/platform-service/src/system/health.ts`).

## Connecting

| Item | Value |
|---|---|
| Handshake credential | `auth: { token: "<access JWT>" }` (the app's access token, audience `ride-app`) |
| CORS | any origin (`cors: { origin: true }`) |
| Max message size | 16 KiB (`maxHttpBufferSize`) |
| Transports | server allows Socket.io defaults (HTTP long-polling and WebSocket); the phone app forces `websocket` |
| Refusal | `connect_error` with message `unauthorized: <code>` when the token is refused (`missing_token`, `invalid_token` for bad signature/issuer/audience/expiry, `token_revoked` for suspended, `token_outdated` for an outdated permission version), or `unavailable` when the check itself failed (Redis error during the deny/pv lookups). Only `unauthorized` counts toward the app's sign-out. See [architecture.md §3](architecture.md#3-handshake-authentication-srcmiddlewaresauthmiddlewarets) |
| On success | the socket is in room `user:{userId}` |

There is no connection rate limit and no per-user connection cap in code.

## Client → server

### `location:update`

Driver GPS ping. Send with an ack callback.

| Item | Value |
|---|---|
| Who | principals with `location:stream` for themselves (built-in matrix: `DRIVER`) |
| Payload | `{ lat: number, lng: number, heading?: number, speed?: number, accuracy?: number, at?: number }`. `at` = device time, unix ms; server time if omitted. `speed` m/s, `accuracy` metres (app types: `LocationPing` in `packages/core/lib/src/realtime/realtime_event.dart`). Values are passed through `Number()`; other fields (`driverId`, `tripId`) are ignored |
| Rate limit | 1 accepted ping per second per socket (`MIN_PING_INTERVAL_MS`). The app sends every 4 s while moving, every 10 s otherwise (`shift_controller.dart`) |
| Ack, accepted | `{ accepted: true }` |
| Ack, rejected | `{ accepted: false, reason }` |

| `reason` | Meaning |
|---|---|
| `forbidden` | the token has no `location:stream` (not a driver) |
| `too_frequent` | < 1 s since this socket's last accepted ping |
| `not_online` | no `driver:{id}` in Redis, or `status = offline` (no active driving session applied by location-service) |
| `invalid` | non-finite coordinates or `at`, `|lat| > 85.05112878`, `|lng| > 180` |
| `inaccurate` | `accuracy > 100` |
| `future` | `at` more than 5 s after server time |
| `out_of_order` | `at` not newer than the last accepted ping |
| `too_fast` | > 200 km/h from the last accepted ping |
| `unavailable` | Redis error |

The app additionally produces `offline` (socket not connected) and `timeout` (no ack in 3 s) locally (`realtime_hub.dart`); the server never sends those.

Side effects when accepted: Redis updated, `driver:location` to `trip:{tripId}` if the driver is on a trip, `driver.location` to Kafka.

### `trip:subscribe`

Join a trip's room to receive `driver:location`.

| Item | Value |
|---|---|
| Who | the trip's rider or driver (members of `trip:{tripId}:members`) |
| Payload | the trip id as a plain string (UUID) |
| Ack | `{ ok: true }` or `{ ok: false, reason: "invalid" \| "not_found" \| "unavailable" }` |

`invalid` = not a UUID string; `not_found` = not a member (or the set doesn't exist yet / anymore); `unavailable` = Redis error.

### `trip:unsubscribe`

| Item | Value |
|---|---|
| Who | anyone |
| Payload | trip id string |
| Ack | **none**: the handler never calls an ack (the app passes one, which never fires) |

Leaves `trip:{tripId}`. Non-string payloads are ignored.

No other client events are handled.

## Server → client

| Event | Emitted by | Room | Payload |
|---|---|---|---|
| `driver:location` | realtime-gateway (`location.handler.ts`) | `trip:{tripId}` | `{ tripId, driverId, lat, lng, heading, speed, at }`. `heading` and `speed` are whatever the driver sent (absent if not sent); `at` = ping time, unix ms |
| `trip:offer` | trip-service matcher (`services/trip-service/src/matching/matcher.ts`) | `user:{driverId}` | `{ tripId, offerId, expiresAt (ISO), etaToPickupSeconds, pickup, dropoff, vehicleType, fare: { estimateMinor, currency }, paymentMethod }` |
| `trip:offer_expired` | trip-service matcher | `user:{driverId}` | `{ tripId, offerId }` |
| `trip:offer_cancelled` | trip-service (`trips/service.ts`, the trip is cancelled while an offer is open) | `user:{driverId}` | `{ tripId }` |
| `trip:status` | trip-service (`notify()` in `trips/service.ts`) | `user:{riderId}`, `user:{bookedById}`, `user:{driverId}` | `{ tripId, status, trip }`, `trip` = `tripView(t)` without a viewer (so no `pin`, no `flags`) |
| `payment:action_required` | payment-service (`money/payments.ts`) | `user:{riderId}` | `{ payment: paymentView, instructions }` |
| `payment:captured` | payment-service | `user:{riderId}` | `{ payment: paymentView }` |
| `payment:failed` | payment-service | `user:{riderId}` | `{ payment: paymentView }` |
| `balance:topped_up` | payment-service (`money/topups.ts`, only for `INDIVIDUAL` beneficiaries) | `user:{ownerId}` | `{ topUp: topUpView }` |

Only `driver:location` comes from the gateway's own code; the rest pass through the Redis adapter from `@socket.io/redis-emitter` in the named services, and the payload shape is owned there. The app's parser for all of them is `RealtimeEvent.fromSocket` in `packages/core/lib/src/realtime/realtime_event.dart`.

Delivery is at-most-once: nothing is stored for offline users.
