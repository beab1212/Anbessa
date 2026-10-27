# Data model

Postgres database `support_service`. Schema: `prisma/schema.prisma`. Migration: `prisma/migrations/20261028090000_init/migration.sql`. Ids are `uuidv7()` (Postgres 18) and times are `timestamptz`. Postgres enums mirror the API enums.

## Tables

| Table | Purpose | Key columns |
|---|---|---|
| `ticket` | one problem report | `ref` (serial, unique, shown as #ref), `city_id`, `category`, `priority`, `status`, `source`, `subject`, `description`, `requester_user_id`, `requester_kind`, `requester_org_id`, `created_by_user_id`, `trip_id`, `assignee_user_id`, `first_response_due_at`, `first_responded_at`, `waiting_since`, `resolution`, `resolution_note`, `resolved_at/by`, `closed_at`, `reopen_count`, `incident_id` → incident, `version` |
| `ticket_message` | thread | `ticket_id`, `author_user_id` (null = system), `author_kind`, `internal`, `body` |
| `ticket_refund` | refunds requested in payment-service for the ticket | PK `(ticket_id, refund_id)`, `amount_minor`, `status` REQUESTED/SUCCEEDED/FAILED, `note`, `linked_by_user_id` |
| `lost_item` | lost-item report | `ticket_id` (unique), `trip_id`, `city_id`, `rider_user_id`, `driver_user_id`, `fleet_org_id`, `description`, `status`, `found` (last answer), `driver_note`, `responded_at`, `returned_at`, `closed_at`, `version` |
| `lost_item_message` | rider ↔ driver/fleet ↔ staff thread | `lost_item_id`, `author_user_id`, `author_kind` |
| `sos_alert` | SOS alert | `city_id`, `trip_id`, `user_id` (presser), `role`, `source`, `status`, `outcome`, `lat`, `lng`, `accuracy`, `location_at`, `trip_verified`, `rider_user_id`, `driver_user_id`, `triggered_at`, `acknowledged_at/by`, `resolved_at/by`, `resolution_note`, `emergency_reference`, `incident_id`, `version` |
| `sos_note` | responder notes | `alert_id`, `author_user_id`, `body` |
| `incident` | safety investigation | `ref` (serial), `city_id`, `category`, `severity`, `status`, `summary`, `trip_id`, `subject_user_ids uuid[]`, `source`, `owner_user_id`, `opened_by` (null = automatic), `outcome`, `outcome_note`, `resolved_at/by`, `version` |
| `incident_note` | investigation notes | |
| `incident_action` | decisions carried out elsewhere | `user_id`, `kind`, `until`, `reference`, `note`, `recorded_by` |
| `idempotency_key` | HTTP idempotency | PK `(user_id, key)`, `request_hash`, `status`, `status_code`, `response`; purged after 24 h |
| `outbox` | transactional outbox | `topic`, `key`, `payload`, `published_at`; partial index `ix_outbox_unpublished` |

## Constraints and indexes beyond Prisma

| Object | Rule |
|---|---|
| `ux_sos_alert_live` | unique `(user_id, trip_id)` where status is OPEN or ACKNOWLEDGED: one live SOS per user and trip |
| `ux_lost_item_live` | unique `(trip_id)` where status is REPORTED, FOUND or NOT_FOUND |
| `ck_ticket_resolution` | a RESOLVED ticket has a resolution |
| `ck_ticket_city` | `city_id ~ '^[a-z0-9-]{1,40}$'` |
| `ck_sos_outcome`, `ck_incident_outcome` | RESOLVED rows have an outcome |
| `ck_sos_position` | lat/lng in range |
| `refuse_delete()` triggers | `DELETE` on `sos_alert`, `sos_note`, `incident`, `incident_note`, `incident_action` raises "… rows are never deleted (legal hold)" (workflow 14 §6) |

Indexes: tickets by `(city_id, status, created_at desc)`, by requester, trip and assignee. Lost items by city/status, driver, fleet and rider. SOS by `(city_id, status, triggered_at)` and `(user_id, trip_id, triggered_at desc)`. Incidents by city/status and trip.

## Redis keys read

| Key | Written by | Use |
|---|---|---|
| `deny:{userId}` | auth-service | suspended users' tokens refused |
| `pv:{userId}` | auth-service | outdated tokens refused |
| `authz:changed` (channel) | auth-service | live permission matrix (`createAuthzSync`) |

The Socket.io emitter publishes on the adapter channel realtime-gateway listens to.

## Retention

- **Tickets and lost items:** no deletion code exists.
- **SOS alerts and incidents:** kept forever (triggers).
- **Idempotency keys:** 24 h.
- **Outbox rows:** stay after publishing (`published_at` set). There is no purge yet, the same as the other services.
