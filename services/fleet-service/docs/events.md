# Events

fleet-service publishes through a transactional outbox and consumes one topic. Event types: `src/outbox/outbox.ts`. Relay: `src/outbox/relay.ts`. Consumer: `src/events/consumer.ts`. Shared contracts for the session events: `libs/shared-types/src/events.ts`.

## How publishing works

```mermaid
sequenceDiagram
  participant S as fleet service method
  participant DB as Postgres (state + outbox)
  participant R as Outbox relay (every 500 ms)
  participant K as Kafka
  S->>DB: BEGIN; update state; INSERT outbox rows; COMMIT
  loop every 500 ms (one loop at a time per process)
    R->>DB: BEGIN; SELECT … WHERE published_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED
    R->>K: send each row (acks = -1, key = row.key)
    R->>DB: UPDATE published_at = now(); COMMIT
  end
```

- `writeOutbox(tx, …events)` inserts rows in the caller's transaction, so an event exists exactly when its state change committed.
- Every payload is wrapped: `{ eventId: uuidv7, version: 1, at: ISO 8601 (when written), …payload }` — the `EventEnvelope` of `libs/shared-types`.
- The Kafka message key is the row's `key` (see the table). The value is the JSON payload. No headers.
- Producer: kafkajs, client id `fleet-service-outbox`, `idempotent: true`, `maxInFlightRequests: 1`, `acks: -1`. Rows are sent one by one in `created_at` order.
- A batch of 100 means more rows are waiting; the relay loops until a batch is smaller.
- Failure: if a send fails, the transaction rolls back (rows stay unpublished), the producer is marked disconnected and reconnects on the next tick; a warning is logged. Rows already sent in that batch are sent again → **at-least-once** delivery. Consumers must tolerate duplicates (use `eventId`).
- Several replicas can run the relay: `FOR UPDATE SKIP LOCKED` gives each a different batch. Ordering per key is then not strictly guaranteed across replicas.
- Without `KAFKA_BROKERS` the relay doesn't start and rows accumulate (warning at start). `GET /internal/ops/outbox` reports the backlog.
- Topics are not created by fleet-service. Published rows are never deleted (not found in code).

## Topics produced

| Topic | Key | Payload (besides the envelope) | Written when (`src/fleet/service.ts`) |
|---|---|---|---|
| `driver.applied` | driver id | `driverId`, `cityId` | `apply` |
| `driver.submitted` | driver id | `driverId`, `cityId` | `submitDriver` (first submission and renewal) |
| `driver.activated` | driver id | `driverId`, `cityId`, `byUserId` | `approveDriver` |
| `driver.changes_requested` | driver id | `driverId`, `cityId`, `reason`, `byUserId` | `requestChanges` |
| `driver.suspended` | driver id | `driverId`, `cityId`, `reason`, `byUserId` (null from the expiry job; reason `"LICENSE expired"`) | `suspendDriver`, `expireDocuments` |
| `driver.reinstated` | driver id | `driverId`, `cityId`, `byUserId` | `reinstateDriver` |
| `vehicle.submitted` | vehicle id | `vehicleId`, `cityId`, `ownerType` | `submitVehicle` |
| `vehicle.verified` | vehicle id | `vehicleId`, `cityId`, `vehicleType`, `ownerType`, `ownerId` (owner user or org id), `byUserId` | `approveVehicle` |
| `vehicle.rejected` | vehicle id | `vehicleId`, `cityId`, `reason`, `byUserId` | `rejectVehicle` |
| `vehicle.suspended` | vehicle id | `vehicleId`, `cityId`, `reason` (`"INSURANCE expired"` / `"INSPECTION expired"`), `byUserId: null` | `expireDocuments` |
| `vehicle.retired` | vehicle id | `vehicleId`, `cityId`, `reason: "owner removed it"`, `byUserId` | `retireVehicle` |
| `vehicle.driver_authorized` | vehicle id | `vehicleId`, `driverId`, `orgId`, `byUserId` | `authorizeDriver` (also on re-grant) |
| `vehicle.driver_unauthorized` | vehicle id | `vehicleId`, `driverId`, `orgId`, `byUserId` | `revokeDriver` (only when an active authorisation was revoked) |
| `document.expiring` | subject id | `documentId`, `subjectType`, `subjectId`, `kind`, `expiresAt` (`YYYY-MM-DD`) | `remindExpiring` (daily, N days ahead for N in `documents.reminderDays`) |
| `driver.online` | driver id | `driverId`, `vehicleId`, `vehicleType`, `cityId` (the vehicle's), `fleetOrgId` (fleet cars only; omitted otherwise), `beneficiaryId` (org id for fleet cars, else driver id), `balanceState` (`OK` \| `WARNING` \| `CASH_BLOCKED`; `OK` when payment-service didn't answer), `cashAllowed` (true when payment-service didn't answer) | `startSession` |
| `driver.offline` | driver id | `driverId`, `reason` (`DRIVER` \| `CONNECTION_LOST` \| `SUSPENDED` \| `VEHICLE_UNAVAILABLE`) | `endSessionTx`: going offline, connection lost, suspension, licence expiry, vehicle retired / suspended, authorisation revoked |
| `audit.recorded` | actor id (`"system"` if none) | `actorId`, `action`, `resource: { type, id }`, `outcome` (`ALLOWED` \| `EXECUTED`), `reason?`, `service: "fleet-service"` | See below |

`DriverOfflineEvent.reason` in `libs/shared-types` also allows `BALANCE_BLOCKED` and `FLEET_SUSPENDED`; fleet-service never produces them.

Events are not written for: vehicle registration, document upload/confirm, document review (only an audit entry), session start via the idempotent "already online with this vehicle" path.

### Audit entries

| `action` | `resource.type` | `outcome` | `reason` | Written by |
|---|---|---|---|---|
| `driver:activate` | `driver` | `EXECUTED` | — | `approveDriver` |
| `driver:suspend` | `driver` | `EXECUTED` | officer's reason | `suspendDriver` |
| `driver:reinstate` | `driver` | `EXECUTED` | officer's reason | `reinstateDriver` |
| `vehicle:verify` | `vehicle` | `EXECUTED` | — | `approveVehicle` |
| `vehicle:reject` | `vehicle` | `EXECUTED` | officer's reason | `rejectVehicle` |
| `document:approve` / `document:reject` | `document` | `EXECUTED` | reviewer's reason, if any | `reviewDocument` |
| `document:view` | `document` | `ALLOWED` | — | `documentUrl`, staff access only |
| `user:read_pii` | `driver` | `ALLOWED` | `"licence number"` | `getDriver`, staff with `user:read_pii` |

Not audited: the expiry job's suspensions (only the `*.suspended` event with `byUserId: null`), request-changes, fleet authorisations, retirements.

### Who consumes them (in this repo)

| Topic | Consumer group | What it does |
|---|---|---|
| `driver.online` | `location-service` | Validates the payload (`services/location-service/src/events/handlers.ts`: uuid ids, known city and vehicle type) and calls `goOnline()` from `libs/shared-location`, which writes the driver's Redis state (vehicle, type, beneficiary, balance state, cash flag) |
| `driver.offline` | `location-service` | `goOffline()`: removes the driver from the geo sets |
| `audit.recorded` | `audit-service` | Stores the audit entry (subscribes `fromBeginning: true`) |
| all `driver.*` lifecycle, `vehicle.*`, `document.expiring` | **none found in code** | notification-service's handlers (`services/notification-service/src/notify/handlers.ts`) don't include any fleet topic. The "you're approved" push comes from auth-service's `role.granted`, which auth-service emits when fleet-service calls `/internal/drivers/:id/role` |

## Topic consumed

| Topic | Producer | Group | Key | Payload used |
|---|---|---|---|---|
| `driver.connection_lost` | location-service (staleness sweeper: no ping for 10 min and not on a trip) | `fleet-service` (client id `fleet-service`) | driver id | `driverId` (uuid). `cityId`, `lastSeenAt` are ignored |

Handler (`src/events/consumer.ts`): parse JSON, validate with zod, then `fleet.endSession(driverId, "CONNECTION_LOST")`, which ends the open session (if any) and writes `driver.offline { reason: "CONNECTION_LOST" }`. No open session → nothing happens, so redelivery is harmless.

- Invalid JSON or payload → logged (`skipping invalid event`, with topic/partition/offset) and skipped, so a bad message can't block the partition.
- Any other error (database) is rethrown and kafkajs retries the message.
- The subscription doesn't set `fromBeginning`, so a brand-new group starts at the latest offset. fleet-service doesn't create the topic (location-service creates it when its `createTopics` option is on).
- If the consumer can't start, an error is logged and the service keeps running without it: sessions then don't end on connection loss.
- Only started when `KAFKA_BROKERS` is set.

Not consumed (though the design mentions them): `org.suspended` (auth-service), `balance.state_changed` (payment-service). A suspended fleet or a blocked balance therefore doesn't end sessions from fleet-service's side; location-service applies `balance.state_changed` to its own Redis state.

## Redis signalling

fleet-service only **reads** Redis; it never writes keys.

| Key / channel | Type | Written by | Used for (fleet-service) |
|---|---|---|---|
| `deny:{userId}` | string, with TTL set by auth-service | auth-service (`services/auth-service/src/lib/signals.ts`) | `EXISTS` on every token check → `401 token_revoked` |
| `pv:{userId}` | string (number), TTL 24 h set by auth-service | auth-service | `GET` on every token check → `401 token_outdated` if the token's `pv` is older |
| `authz:changed` | pub/sub channel | auth-service | Re-fetch the permission matrix (`libs/shared-authz/src/sync.ts`) |
| `settings:changed` | pub/sub channel | platform-service | Re-fetch live settings (`libs/shared-settings/src/client.ts`) |

Both subscriptions use a duplicated ioredis connection; both also poll every 30 s, so a lost message only delays a change.
