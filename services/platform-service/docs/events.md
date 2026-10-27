# platform-service events

platform-service **produces** Kafka events through its transactional outbox and **publishes** one Redis pub/sub channel. It consumes no Kafka topics. It subscribes to one Redis channel (`authz:changed`) through `libs/shared-authz`.

## Kafka topics produced (outbox)

Source: `src/outbox/outbox.ts`, `src/outbox/relay.ts`. Every payload is wrapped as:

```ts
{ eventId: string /* UUIDv7 */, version: 1, at: string /* ISO, time the row was written */, ...payload }
```

Message key = the outbox `key` column; value = the JSON payload. Producer client id `platform-service-outbox`, idempotent, `acks: -1`.

### `audit.recorded`

Key: `actorId`, or `"system"` when null.

```ts
{
  actorId: string | null;
  action: string;
  resource: { type: string; id: string };
  outcome: "ALLOWED" | "PENDING_APPROVAL" | "EXECUTED";
  reason?: string;
  service: "platform-service";
}
```

Written by:

| Action | Resource | Outcome | When |
|---|---|---|---|
| `settings:change` | `setting`, id `key` or `key@cityId` | `EXECUTED` | a change applied directly or on approval (actor = approver if any). Reason `"<old> → <new> · <reason>"` |
| `settings:propose` | `setting` | `PENDING_APPROVAL` | a sensitive change was proposed. Reason `"→ <new> · <reason>"` |
| `settings:reject` | `setting_change`, id = change id | `EXECUTED` | a change request was rejected |
| `city:manage` | `city` | `EXECUTED` | city created/updated/enabled/disabled |
| `vehicle_type:manage` | `vehicle_type` | `EXECUTED` | vehicle type saved |
| `announcement:create`, `announcement:update`, `announcement:archive` | `announcement` | `EXECUTED` | announcement saved or archived |

Not audited (no event found in code): cancelling a change request, the hourly expiry of change requests, the first-start seed.

Consumer: audit-service (`services/audit-service/src/events/consumer.ts`, consumer group `audit-service`).

### `platform.settings_changed`

Key: the setting key.

```ts
{ version: number; keys: string[] /* always one key */; cityId: string | null; byUserId: string }
```

Written only by `applyTx`, so only for setting values. City and vehicle-type changes bump the version but do not write this event.

Consumers: **none found in code.** It is not declared in `libs/shared-types/src/events.ts`. Services pick up changes through Redis and the snapshot, not this topic (comment in `src/outbox/outbox.ts`: "Live reloads go through Redis (`settings:changed`), not Kafka").

## Redis pub/sub

| Channel | Direction | Message | Source |
|---|---|---|---|
| `settings:changed` (`SETTINGS_CHANNEL`) | publish | the new version number as a string | `settings.publish()` after a committed setting, city or vehicle-type change |
| `authz:changed` (`AUTHZ_CHANNEL`) | subscribe | (ignored; triggers a reload of `GET /internal/authz/snapshot` from auth-service) | `createAuthzSync` in `server.ts` |

Publishing happens after the transaction commits. If it fails (Redis down) the error is logged as a warning and the request still succeeds; services then see the change on their next 30 s poll. Without `REDIS_URL` there is no publisher at all.

Subscribers to `settings:changed`: every service that uses `createSettingsClient` with a Redis connection (trip-, pricing-, payment-, notification-, fleet-service). They ignore the message body and fetch `GET /internal/settings/snapshot`.

## Delivery guarantees

| Path | Guarantee |
|---|---|
| Outbox → Kafka | At least once. The row and the change commit together; the relay can re-send if it crashes between `send` and the commit that marks rows published. Consumers should de-duplicate on `eventId` |
| Order | Rows are read `ORDER BY created_at`, sent one at a time. Several replicas use `FOR UPDATE SKIP LOCKED`, so order across replicas is not guaranteed |
| Redis `settings:changed` | At most once (plain pub/sub). The 30 s poll is the backstop |
