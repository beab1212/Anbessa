# Kafka events

audit-service **consumes one topic** and **produces none**.

## Consumer

| Property | Value | Source |
|---|---|---|
| Topic | `audit.recorded` | `src/events/consumer.ts` |
| Client id / group id | `audit-service` / `audit-service` | same |
| `fromBeginning` | `true` (a new group reads the whole retained topic) | same |
| Topic creation | if missing, at start, outside production (`createTopics: NODE_ENV !== "production"`) | `src/server.ts` |
| Enabled | only with `KAFKA_BROKERS`; required in production | `src/server.ts`, `src/config/index.ts` |
| Start failure | logged, service keeps running without a consumer (no automatic restart of the consumer in code) | `src/server.ts` |

Database.md §11 lists the topic with 6 partitions and 7-day retention; topics are not provisioned by this service in production.

## Producers

Every producer has an `audit()` helper in its `src/outbox/outbox.ts` that sets `topic: "audit.recorded"`, `key: actorId ?? "system"` and `service: "<name>"`:

| Service | `service` value |
|---|---|
| auth-service | `auth-service` |
| fleet-service | `fleet-service` |
| payment-service | `payment-service` |
| platform-service | `platform-service` |

audit-service itself writes `service: "audit-service"` for CSV exports, directly into the table (not through Kafka).

## Payload

Envelope fields come from the producer's `writeOutbox()`; the rest from the `AuditPayload` type (e.g. `services/auth-service/src/outbox/outbox.ts`). The consumer validates against `auditEvent` in `src/store.ts`:

| Field | Type | Validation | Stored in |
|---|---|---|---|
| `eventId` | string | UUID | `event_id` |
| `version` | number | not validated, dropped | — |
| `at` | string | ISO datetime, offset allowed | `at` |
| `actorId` | string \| null | UUID or null (required key) | `actor_id` |
| `action` | string | 1–80 chars | `action` |
| `resource` | `{ type, id }` | `type` 1–60, `id` 1–200 | `resource_type`, `resource_id` |
| `outcome` | enum | `ALLOWED`, `DENIED`, `PENDING_APPROVAL`, `EXECUTED` | `outcome` |
| `reason` | string? | ≤ 2000 | `reason` |
| `onBehalfOf` | string? | UUID | `on_behalf_of` |
| `service` | string? | ≤ 60 | `service` |

Example as produced:

```json
{
  "eventId": "0192f7a8-1c2d-7000-8000-000000000001",
  "version": 1,
  "at": "2026-10-27T09:14:03.000Z",
  "actorId": "0192f7a8-0000-7000-8000-0000000000aa",
  "action": "role:approve",
  "resource": { "type": "approval_request", "id": "0192f7a8-…" },
  "outcome": "EXECUTED",
  "reason": "night shift cover",
  "service": "auth-service"
}
```

Notes:

- payment-service's `AuditPayload` type has no `PENDING_APPROVAL` and no `onBehalfOf`; that is a narrower subset and still valid here.
- Fields named in Role.md §12 but not in the schema (`actorRoles`, `requestId`, `ip`, `userAgent`) are dropped if sent.

## Processing, retries, ordering

| Case | Result |
|---|---|
| Valid, new | inserted |
| Valid, same `(at, eventId)` already stored | no-op (`ON CONFLICT DO NOTHING`) |
| Not JSON, or fails the schema | error log `skipping invalid audit event`, offset committed, event not stored |
| Database error | thrown; kafkajs retries the message, the partition waits |

Ordering: per partition (the key is the actor id, so one actor's entries stay in order). Query order uses `at`, the producer's time, not arrival order. No DLQ.
