# Events

Kafka topics trip-service produces, how they get to Kafka, who consumes them, and the Redis channels used for signalling. Payload types are in `libs/shared-types/src/events.ts`; the producer side is `src/outbox/outbox.ts`.

## Summary

- **Produced:** seven `trip.*` topics, always through the transactional outbox.
- **Consumed:** none. trip-service has no Kafka consumer (not found in code). Anything it needs from other services it asks over HTTP or reads from live settings.
- **Redis pub/sub:** subscribes to `settings:changed` and `authz:changed`; publishes Socket.io emitter messages.

## Envelope and key

`writeOutbox(tx, event)` stores one row per event inside the caller's transaction:

| Outbox column | Value |
|---|---|
| `topic` | the topic name |
| `key` | `tripId` (all topics) |
| `payload` | `{ eventId: uuidv7, version: 1, at: <ISO time of the write>, ...fields }` |

Because the key is the trip id, all events of one trip land on one partition and keep their order there.

## Topics produced

| Topic | Emitted by | When |
|---|---|---|
| `trip.requested` | `request()` | the trip row is created |
| `trip.matched` | `matchDriver()` (accept, assign) | `requested → matched` |
| `trip.driver_en_route` | `enRoute()` | `matched → en_route` |
| `trip.driver_arrived` | `arrive()` | `arrived_at` is set |
| `trip.started` | `start()` | `en_route → in_progress` |
| `trip.completed` | `complete()` | `in_progress → completed` |
| `trip.cancelled` | `finishCancel()` (cancel, system cancel) | `→ cancelled` |

### `trip.requested` (`TripRequestedEvent`)

| Field | Type | Notes |
|---|---|---|
| `tripId` | uuid | |
| `riderId` | uuid | |
| `bookedById` | uuid | the caller (equals `riderId` unless booked on behalf) |
| `cityId` | string | |
| `vehicleType` | string | |
| `channel` | `APP` \| `PHONE` \| `CORPORATE_PORTAL` | |
| `paymentMethod` | `CASH` \| `MOBILE_MONEY` \| `CARD` \| `CORPORATE` | |
| `fareEstimateMinor` | int | the quoted fare |

### `trip.matched` (`TripMatchedEvent`)

`tripId`, `riderId`, `driverId`, `cityId`, `vehicleType`.

### `trip.driver_en_route`, `trip.driver_arrived`, `trip.started` (`TripProgressEvent`)

`tripId`, `riderId`, `driverId`, `cityId`.

### `trip.completed` (`TripCompletedEvent`)

Everything payment-service needs to settle the trip.

| Field | Type | Notes |
|---|---|---|
| `tripId`, `riderId`, `driverId` | uuid | |
| `cityId`, `vehicleType` | string | |
| `vehicleId` | string | snapshot at match |
| `beneficiary` | `{ type: INDIVIDUAL\|ORGANIZATION, id }` | the fleet org for company cars, else the driver; snapshot at match |
| `paymentMethod` | enum | |
| `billingType` | `PERSONAL` \| `CORPORATE` | |
| `billingOrgId` | uuid, optional | only for company-billed trips |
| `fareMinor` | int | final fare, waiting fee included |
| `waitingFeeMinor` | int | |
| `currency` | string | `ETB` |
| `distanceMeters` | int | currently the planned route distance |
| `durationSeconds` | int | `started_at → completed_at` |
| `completedAt` | ISO string | |

### `trip.cancelled` (`TripCancelledEvent`)

| Field | Type | Notes |
|---|---|---|
| `tripId`, `riderId` | uuid | |
| `driverId` | uuid, optional | present if a driver was matched |
| `cityId` | string | |
| `by` | `RIDER` \| `DRIVER` \| `SYSTEM` \| `STAFF` | |
| `reason` | string | one of the API reasons, or `NO_DRIVER_FOUND` |
| `paymentMethod` | enum | |
| `feeMinor` | int | charged to the rider; 0 when free |
| `driverCompensationMinor` | int | credited to the beneficiary out of the fee |
| `beneficiary` | `{ type, id }`, optional | present if matched |
| `billingOrgId` | uuid, optional | company trips: the fee is billed to the company |
| `currency` | string | |

## Consumers (in other services)

| Topic | Consumer group | Service | What it does |
|---|---|---|---|
| `trip.matched` | `location-service` | location-service (`src/events/handlers.ts`) | `startTrip()`: driver → `on_trip`, moved from the `available` to the `busy` geo set, `trip:{id}:members` = rider + driver, `offer:driver:{id}` deleted |
| `trip.completed`, `trip.cancelled` | `location-service` | location-service | `endTrip()`: driver back to `available` (if still on this trip), trip member/last-position keys expire after 300 s |
| `trip.completed` | `payment-service` | payment-service (`src/events/consumer.ts`) | settles the trip per payment method (inbox dedupe on `eventId`) |
| `trip.cancelled` | `payment-service` | payment-service | settles the cancellation fee when `feeMinor > 0` (inbox dedupe) |
| `trip.requested`, `trip.driver_en_route`, `trip.driver_arrived`, `trip.started` | — | none found in the repo | produced only |

Consequence: **without the relay running, location-service never marks a matched driver as busy**, so the driver stays in the `available` set and can be offered other trips. Accepting a second one fails with `409 driver_busy` (the `driver_active_trip` key), but offers are wasted. Keep `KAFKA_BROKERS` set whenever you run location-service.

## Outbox relay

`src/outbox/relay.ts`, started in `src/server.ts` only when `KAFKA_BROKERS` is set.

| Aspect | Behaviour |
|---|---|
| Producer | kafkajs, `clientId: trip-service-outbox`, `idempotent: true`, `maxInFlightRequests: 1`, `acks: -1` (all in-sync replicas) |
| Interval | every 500 ms; a pass that publishes a full batch (100) runs again immediately |
| Selection | `SELECT … FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED` inside a transaction, so replicas share the work |
| Publishing | one `producer.send()` per row, in `created_at` order; then all rows of the batch get `published_at = now()` in the same transaction |
| Failure | any error rolls the transaction back, sets `connected=false` (reconnect next pass) and logs `outbox relay: publish failed, will retry`. Rows already sent in that batch are sent again next time |
| Delivery | at-least-once. Consumers must dedupe on `eventId` (payment-service does; location-service handlers are idempotent by design) |
| Ordering | by `created_at` within one batch; Kafka keeps per-key order once sent. With several replicas, `SKIP LOCKED` lets a second replica publish a later batch while the first is still sending, so order is not strictly guaranteed across batches, even for one trip |
| Topics | not created by trip-service; the broker must allow auto-creation or the topics must exist (payment-service can create the topics it consumes) |
| Retention | published rows are never deleted (no purge found in code) |
| Without Kafka | rows stay in `outbox` with `published_at IS NULL`; `GET /internal/ops/outbox` reports the backlog |

On shutdown the relay timer stops and the producer disconnects; there is no final flush.

## Redis pub/sub and signalling keys

| Channel / key | Direction | Purpose |
|---|---|---|
| `settings:changed` | subscribe (`@ride-app/shared-settings`) | platform-service published a settings change → reload the snapshot |
| `authz:changed` | subscribe (`@ride-app/shared-authz`) | auth-service changed the permission matrix → reload |
| `socket.io#/#user:{userId}#` | publish (Socket.io Redis emitter) | push events to realtime-gateway's adapter ([api.md](api.md#socket-events)) |
| `offer:driver:{driverId}` | write (`SET NX EX`), delete | soft reservation read by location-service's nearby search |
| `deny:{userId}`, `pv:{userId}` | read | token revocation and permission version, written by auth-service |

Full Redis key list: [data-model.md](data-model.md#redis-keys).
