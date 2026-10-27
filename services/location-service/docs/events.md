# location-service: events

Source: `src/events/kafka.ts`, `src/events/handlers.ts`, contracts in `libs/shared-types/src/events.ts`.

## Kafka client

| Item | Value |
|---|---|
| Client id | `location-service` |
| Consumer group | `location-service` (platform-service's system page shows its lag: `CONSUMER_GROUPS` default in `services/platform-service/src/config/index.ts`) |
| Subscription | the six topics below, one `consumer.subscribe({ topics })`. `fromBeginning` is not set (kafkajs default: a new group starts at the latest offset) |
| Processing | `eachMessage`, one message at a time per partition, auto-commit (kafkajs default) |
| Producer | `idempotent: true`, `maxInFlightRequests: 1`, sends with `acks: -1` (all in-sync replicas) |
| Topic creation | outside production, `start()` creates any missing topic among the six consumed plus `driver.connection_lost` (default partitions/replication of the broker). In production topics must exist already |
| Without `KAFKA_BROKERS` | nothing consumed or produced (allowed outside production; required in production by config validation) |

### Error handling

| Error | Effect |
|---|---|
| Value isn't JSON (`SyntaxError`) or fails the Zod schema (`ZodError`) | logged at `error` with topic, partition, offset and the first 300 chars of the message: `skipping invalid event`. The offset moves on |
| Anything else (Redis errors) | rethrown, so kafkajs retries the message with its default retry policy |

There is no dead-letter topic and no inbox/dedup table. The handlers are written to be idempotent (replaying the same event leaves the same state; comment in `handlers.ts`).

## Consumed topics

Schemas are the Zod objects in `src/events/handlers.ts`. Extra fields (such as the envelope `eventId`, `version`, `at`) are ignored by Zod's default object parsing.

| Topic | Producer (key) | Fields validated | Handler | Effect |
|---|---|---|---|---|
| `driver.online` | fleet-service (`driverId`) | `driverId` uuid, `vehicleId` 1–64, `vehicleType` (key guard), `cityId` (key guard), `fleetOrgId?` uuid, `beneficiaryId?` uuid, `cashAllowed` boolean, `balanceState?` ≤ 20 chars | `goOnline` | hash rewritten with `status = available` (or kept `on_trip`), city and type registered for the sweeper, beneficiary membership updated. See [architecture.md §3](architecture.md#3-driver-state) |
| `driver.offline` | fleet-service (`driverId`) | `driverId` uuid, `reason` ≤ 40 chars (not used) | `goOffline` | out of every geo set and `seen`, `status = offline` |
| `trip.matched` | trip-service (`tripId`) | `tripId`, `riderId`, `driverId` (uuids) | `startTrip` | members set, offer lock deleted, driver `on_trip` and moved to `busy` |
| `trip.completed` | trip-service (`tripId`) | `tripId` uuid, `driverId?` uuid | `endTrip` (only if `driverId` present) | 5 min grace on trip keys; driver back to `available` if still on this trip |
| `trip.cancelled` | trip-service (`tripId`) | same as `trip.completed` | `endTrip` (only if `driverId` present) | same. A trip cancelled before a match has no `driverId` and is a no-op |
| `balance.state_changed` | payment-service (beneficiary owner id) | `beneficiary { type: INDIVIDUAL\|ORGANIZATION, id uuid }`, `state` OK\|WARNING\|CASH_BLOCKED\|BLOCKED, `cashAllowed` boolean | `applyBalanceState` | `balance:{id}` stored; every online driver of that beneficiary updated |

Full contract types: `DriverOnlineEvent`, `DriverOfflineEvent`, `TripMatchedEvent`, `BalanceStateChangedEvent` in `libs/shared-types/src/events.ts`. `trip.completed` / `trip.cancelled` carry many more fields (fare, beneficiary…) that location-service ignores.

## Produced topics

### `driver.connection_lost`

| Item | Value |
|---|---|
| When | the sweeper finds a driver with no ping for 10 min who is not `on_trip` ([architecture.md §11](architecture.md#11-staleness-sweeper-srcsweeperts-sweepcity)) |
| Key | `driverId` |
| Payload (`DriverConnectionLostEvent`) | `{ eventId: uuid v7, version: 1, at: ISO-8601, driverId, cityId, lastSeenAt: ISO-8601 }` |
| Consumer | fleet-service (`services/fleet-service/src/events/consumer.ts`), which ends the driving session and publishes `driver.offline` |
| Delivery | sent directly (no outbox). Published once: the driver is removed from `seen:{city}` in the same sweep, before the send. A failed send is logged (`could not report lost driver`) and not retried |

## Ordering

| Guarantee | Source |
|---|---|
| Events for one driver on `driver.online`/`driver.offline` are ordered (key `driverId`, one partition) | fleet-service keys |
| Events for one trip on one `trip.*` topic are ordered (key `tripId`) | trip-service outbox (`key: event.payload.tripId`) |
| **No** ordering across topics: `trip.matched` and `trip.completed` are different topics, and `driver.offline` is keyed differently | Kafka semantics |

How the handlers cope: `endTrip` only frees the driver when the hash's `tripId` equals the event's; `goOnline` keeps an `on_trip` status; `startTrip` does nothing to the hash of an offline driver. Not handled in code: a `trip.matched` processed **after** that trip's `trip.completed` (for example on redelivery) would put the driver back `on_trip` with no later event to free them, until a new `driver.online` or the hash expires.

## Redis pub/sub

| Channel | Direction | Purpose |
|---|---|---|
| `authz:changed` | subscribed (through `createAuthzSync`, `libs/shared-authz/src/sync.ts`) | auth-service announces a new permission matrix; the service re-fetches `GET /internal/authz/snapshot` |

location-service publishes nothing on Redis pub/sub and does not use the Socket.io emitter. Signalling between services goes through shared keys instead: `offer:driver:{id}` (written by trip-service, read here) and the keys written by realtime-gateway's `recordPing`. See [data-model.md](data-model.md).
