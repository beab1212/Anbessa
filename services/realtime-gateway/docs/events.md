# realtime-gateway: events

## Kafka

The gateway only **produces**. It consumes no Kafka topic.

### `driver.location` (produced)

| Item | Value |
|---|---|
| Source | `src/kafka.ts` (`kafkaLocationPublisher`), called from `location.handler.ts` after an accepted ping |
| Client id | `realtime-gateway` |
| Key | `driverId` (the token's `sub`), so one driver's pings stay ordered on one partition |
| Producer settings | `allowAutoTopicCreation: true`; not idempotent; `acks: 1` (leader only) |
| Payload (`DriverLocationEvent`, `libs/shared-types/src/events.ts`) | `{ driverId, cityId, lat, lng, at, tripId?, heading?, speed?, accuracy? }`. `tripId` comes from the driver's Redis state (set while `on_trip`), never from the client. `at` = device time, unix ms |
| Envelope | **none**: unlike other events this payload has no `eventId` / `version` / `at` envelope (the type doesn't extend `EventEnvelope`) |
| Consumers | none found in code (the design docs list ETA, trip audit, analytics/ClickHouse) |

Guarding (comment: "a failure is logged and counted, and never reaches the socket server or the driver"):

| Situation | Behaviour |
|---|---|
| Producer not connected yet | `publish()` increments `dropped` and returns; nothing is buffered |
| Connect fails (at start or after a disconnect) | `onError` logs `driver.location publish failed`, retried every 5 s in the background |
| `send()` rejects | `dropped++`, logged with the same message |
| `send()` resolves | `published++` |
| `DISCONNECT` event | `connected = false` (pings are counted as dropped meanwhile); `connect()` is tried again 1 s later, then every 5 s while it fails |
| `stop()` | cancels any pending retry, then disconnects the producer if connected |
| `KAFKA_BROKERS` unset | `noopPublisher`: nothing published, counters stay 0 |

The counters are exposed on `GET /health/ready` as `kafka: { published, dropped }`.

## Redis pub/sub

| Channel | Who | Purpose |
|---|---|---|
| Socket.io adapter channels (prefix `socket.io`, the `@socket.io/redis-adapter` default) | gateway pods (publish + subscribe via `pubClient` / `subClient`), trip-service and payment-service (publish via `@socket.io/redis-emitter`) | room broadcasts across pods; service-to-user pushes into `user:{id}` rooms |
| `authz:changed` | gateway subscribes (via `createAuthzSync`, only when `INTERNAL_SERVICE_TOKEN` is set) | auth-service announces a new permission matrix; the gateway re-fetches `GET /internal/authz/snapshot` |

Exact channel names inside the adapter are chosen by the Socket.io libraries; the code passes no custom `key`, so the gateway and the emitters must keep the defaults to stay compatible.

## Socket events

Not Kafka, but listed here for completeness: see [api.md](api.md) for every client → server and server → client event.
