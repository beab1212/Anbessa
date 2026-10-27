# Events

auth-service **produces** Kafka events through a transactional outbox and **consumes none**. It also uses Redis for fast signals (keys and one pub/sub channel).

## How events are produced

1. Code calls `writeOutbox(tx, ...events)` (`src/outbox/outbox.ts`) inside the transaction that changes state. Each event becomes an `outbox` row: `topic`, `key`, `payload` = the envelope below.
2. The relay (`src/outbox/relay.ts`) runs every 500 ms when `KAFKA_BROKERS` is set: it locks up to 100 unpublished rows (`ORDER BY created_at … FOR UPDATE SKIP LOCKED`), sends each one with kafkajs (`acks: -1`, idempotent producer, `maxInFlightRequests: 1`, client id `auth-service-outbox`), then sets `published_at`. Full batches are drained back to back.
3. On a send error the transaction rolls back (rows stay unpublished), the producer is marked disconnected and reconnects on the next tick. The warning `outbox relay: publish failed, will retry` is logged. There is no back-off, no attempt counter (the `attempts` column is never written) and no dead-letter topic.
4. Without `KAFKA_BROKERS` (allowed outside production) events stay in `outbox` until a relay runs.

**Envelope.** Every payload is `{ eventId: uuidv7, version: 1, at: ISO timestamp, ...fields }`. The Kafka message value is that JSON; the message key is the event key.

**Delivery and ordering.** At-least-once (a row can be resent if the `published_at` update fails after Kafka accepted it); consumers should dedupe on `eventId`. Rows are sent in `created_at` order within one relay pass, and Kafka keeps order per key within a partition. With several replicas, two relays can publish different rows concurrently, so strict ordering across rows is not guaranteed.

**Atomicity.** Events from `/api/identity`, `/internal`, the bootstrap CLI and the OTP-verification callback are written in the same transaction as the state change. Events from Better Auth hooks (`user.created` on sign-up, `org.created`, `role.granted`/`role.revoked` from organisation membership, `org.member_invited`, `staff:sign_in` audit) are written right after Better Auth's own insert, not in the same transaction. See [Auth.md §13](../../../docs/design/Auth.md#13-events-and-audit).

Topic creation is not done by auth-service. Some consumers create the topics they read in development (`createTopics` options in notification-service, audit-service).

## Topics produced

Types: `IdentityEvent` in `src/outbox/outbox.ts`. Only `user.created` also has a shared type (`UserCreatedEvent` in `libs/shared-types/src/events.ts`).

| Topic | Key | Payload fields (besides the envelope) | Emitted when (source) |
|---|---|---|---|
| `user.created` | userId | `userId`, `guest: boolean` | Better Auth creates a user (phone sign-up) — `instances.ts` `databaseHooks.user.create.after` (`guest` = `accountStatus === "GUEST"`); guest created by the call center — `identity/service.ts` `createGuest` (`guest: true`); staff account created — `createStaffAccount`; bootstrap CLI; `seed:dev` (new users only) |
| `user.claimed` | userId | `userId` | A GUEST verifies their phone with an OTP — `instances.ts` `callbackOnVerification` |
| `user.suspended` | userId | `userId`, `until: ISO \| null`, `byUserId` | `POST /api/identity/users/:id/suspend` |
| `user.reinstated` | userId | `userId`, `byUserId` | `POST /api/identity/users/:id/reinstate` |
| `role.granted` | userId | `userId`, `role` (role **code**, e.g. `DRIVER`, `DISPATCHER`, `FLEET_DRIVER`), `orgId?`, `cityId?`, `byUserId: string \| null` | Staff grant approved (`cityId` for city roles, `byUserId` = checker); driver activated via `/internal/drivers/:userId/role` (`role: "DRIVER"`, `byUserId: null`); member added to a partner org, one event per role (`orgId`, `byUserId: null`) — `hooks.ts` `afterAddMember` (includes the creator at org creation); bootstrap super admin (`role: "SUPER_ADMIN"`) |
| `role.revoked` | userId | same as `role.granted` | Staff role revoked (`cityId?`, `byUserId` = revoker); driver deactivated; member removed from a partner org (one per role) — `hooks.ts` `afterRemoveMember` |
| `org.created` | orgId | `orgId`, `kind`, `cityId` | `POST /api/auth/organization/create` — `hooks.ts` `afterCreateOrganization` |
| `org.verified` | orgId | `orgId`, `kind`, `cityId`, `byUserId` | `POST /api/identity/organizations/:id/verify` |
| `org.suspended` | orgId | `orgId`, `kind`, `byUserId` | `POST /api/identity/organizations/:id/suspend` |
| `org.member_invited` | orgId | `invitationId`, `orgId`, `orgName`, `role` (stored name, e.g. `fleet_driver`), `phoneNumber?` (E.164, only when the invitation email is a phone placeholder) | `POST /api/auth/organization/invite-member` — `hooks.ts` `afterCreateInvitation` |
| `audit.recorded` | actorId, or `"system"` | `actorId: string \| null`, `action`, `resource: { type, id }`, `outcome: ALLOWED \| DENIED \| PENDING_APPROVAL \| EXECUTED`, `reason?`, `onBehalfOf?`, `service: "auth-service"` | Alongside every operation below |

Not emitted: no role-change event for `update-member-role` (only a `pv` bump), no event for `authz:change` other than its audit row, no `user.updated`.

### `audit.recorded` actions

| `action` | `resource.type` | `outcome` | Source |
|---|---|---|---|
| `staff:sign_in` | user | ALLOWED | new admin-surface session (`instances.ts`); `reason` = IP · user agent |
| `staff:bootstrap_super_admin` | user | EXECUTED | bootstrap CLI (`actorId: null`) |
| `staff:create_account` | user | EXECUTED | `createStaffAccount` |
| `staff:reset_mfa` | user | EXECUTED | `resetMfa` or the approved `staff:reset_mfa` |
| `user:create_guest` | user | EXECUTED | `createGuest` |
| `user:suspend` / `user:reinstate` | user | EXECUTED | suspend / reinstate |
| `session:revoke` | user | EXECUTED | sign out everywhere |
| `role:revoke` | user | EXECUTED | staff role revocation |
| `driver:activate` / `driver:suspend` | user | EXECUTED | `/internal/drivers/:userId/role` (`actorId: null`, `reason: "by <service>"`) |
| `org:create` | organization | EXECUTED | org created via Better Auth |
| `org:verify` / `org:suspend` | organization | EXECUTED | identity API |
| `authz:change` | role | EXECUTED | approved matrix change; `reason` = `v<version>: <summary>` |
| `<action>:request` | approval_request | PENDING_APPROVAL | approval created (`role:grant`, `staff:reset_mfa`, `authz:change`) |
| `<action>:approve` / `:reject` / `:cancel` | approval_request | EXECUTED | approval decided |

## Who consumes them (found in code)

| Topic | Consumer (group) | What it does |
|---|---|---|
| `audit.recorded` | audit-service (`audit-service`), `services/audit-service/src/events/consumer.ts` | Stores the audit row. Subscribes `fromBeginning`; invalid JSON/schema is logged and skipped; database errors are retried by kafkajs |
| `org.member_invited` | notification-service (`notification-service`), `services/notification-service/src/notify/handlers.ts` | Sends the invitation SMS when `phoneNumber` is present |
| `role.granted` | notification-service | When `role === "DRIVER"`: push "driver activated" to `userId` |
| `user.created`, `user.claimed`, `user.suspended`, `user.reinstated`, `role.revoked`, `org.created`, `org.verified`, `org.suspended` | none found in `services/*/src` | Published, but no consumer exists yet. The design docs list planned consumers (trip, fleet, payment, notification welcome) |

notification-service leaves the offset uncommitted on handler errors so kafkajs retries; malformed events are skipped. No DLQ in either consumer.

## Redis signalling

| Mechanism | Name | Written by | Read by | Purpose |
|---|---|---|---|---|
| Key | `deny:{userId}` = `"1"` | `signals.deny` after a suspension commits | `shared-authz` verifiers in every service (`isDenied`) and auth-service itself | Refuse unexpired JWTs of suspended users (`token_revoked`). TTL = `min(30 min, max(60 s, until − now))`; 30 min without `until`. Deleted on reinstate |
| Key | `pv:{userId}` = permission version | `signals.permissionVersion` after any role/permission-affecting commit | every verifier (`currentPermissionVersion`) | Refuse tokens with an older `pv` (`token_outdated`). TTL 24 h |
| Pub/sub channel | `authz:changed`, message = new `authz_version` as a string | `authz/service.ts` `reload()` after an approved matrix change | `createAuthzSync` in every service (and in auth-service) | Reload the permission matrix from `GET /internal/authz/snapshot` at once; the 30 s poll is the backstop |
| Keys | `ba:*` | Better Auth secondary storage | Better Auth | Sessions and rate-limit counters (see [data-model.md](data-model.md#redis-keys)) |

Signal writes are best effort: Redis errors are logged (`security signal unavailable`) and never fail the request. Kafka events are the durable record.
