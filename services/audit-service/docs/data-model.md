# Data model

Postgres database `audit_service` (from `.env.example`). Prisma schema `prisma/schema.prisma`; the partitioning, trigger and functions exist only in the SQL migration. The Prisma model is used for reads; inserts use raw SQL (`src/store.ts`).

## `audit_entry`

Partitioned table, `PARTITION BY RANGE ("at")`.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `event_id` | uuid | no | | producer's envelope `eventId` |
| `at` | timestamptz | no | | producer's envelope `at` (when the action happened); partition key |
| `actor_id` | uuid | yes | | user who acted; null for system actions |
| `action` | text | no | | e.g. `role:approve`, `settings:change`, `audit_log:export` |
| `resource_type` | text | no | | |
| `resource_id` | text | no | | free text, not necessarily a UUID |
| `outcome` | text | no | | `ck_audit_outcome`: `ALLOWED`, `DENIED`, `PENDING_APPROVAL`, `EXECUTED` |
| `reason` | text | yes | | free text, ≤ 2000 at validation |
| `on_behalf_of` | uuid | yes | | when an agent acts for a user |
| `service` | text | yes | | producing service |
| `recorded_at` | timestamptz | no | `CURRENT_TIMESTAMP` | when audit-service inserted it |

Keys and indexes (created on the parent, so on every partition):

| Name | Columns | Purpose |
|---|---|---|
| `audit_entry_pkey` | `(at, event_id)` | primary key; idempotent insert |
| `audit_entry_actor_id_at_idx` | `(actor_id, at DESC)` | filter by actor |
| `audit_entry_resource_type_resource_id_at_idx` | `(resource_type, resource_id, at DESC)` | filter by resource |
| `audit_entry_action_at_idx` | `(action, at DESC)` | filter by action |

No index exists for `outcome` or `service` alone; those filters rely on the others or on scanning.

## Partitions

| Partition | Range |
|---|---|
| `audit_entry_default` | DEFAULT: anything without a monthly partition |
| `audit_entry_YYYY_MM` | `[first of month, first of next month)`, created by `ensure_audit_partitions()` |

`ensure_audit_partitions(months_ahead int DEFAULT 2)` (plpgsql): for the current month and the next `months_ahead` months, `CREATE TABLE audit_entry_YYYY_MM PARTITION OF audit_entry …` unless `to_regclass` finds it. Called by the migration and by the service at start and every 24 h, always with `2`.

Postgres refuses to create a monthly partition when `audit_entry_default` already holds rows in that month's range. That can only happen if rows for a month arrive before its partition exists (maintenance not run for over two months, or events dated more than two months ahead). The service would then log `partition maintenance failed` daily.

## Functions and triggers

| Object | Kind | What |
|---|---|---|
| `audit_entry_immutable()` | trigger function | `RAISE EXCEPTION 'audit entries are write-once (%)', TG_OP USING ERRCODE = 'insufficient_privilege'` |
| `audit_entry_no_update_delete` | trigger | `BEFORE UPDATE OR DELETE ON audit_entry FOR EACH ROW` |
| `ensure_audit_partitions(int)` | function | see above |

## Migrations

| Order | Folder | What |
|---|---|---|
| 1 | `prisma/migrations/20261027170000_init` | Table, check constraint, indexes, trigger, default partition, partition function, first call |

Applied with `prisma migrate deploy` (`make db-migrate`, integration-test setup). The Docker image does not contain `prisma/` (see [operations.md](operations.md#build-and-deploy)).

## Retention

Not implemented in code. Database.md §15 proposes 13 months hot and 7 years in S3 Object Lock; docs/production/README.md asks ops to export monthly partitions and detach them.

## Redis keys (read only)

Redis is optional (`REDIS_URL`). The service never writes to it.

| Key / channel | Type | Written by | Used for |
|---|---|---|---|
| `deny:{userId}` | key (existence) | auth-service | reject tokens of suspended users (`EXISTS`) |
| `pv:{userId}` | string (number) | auth-service | reject tokens with an older permission version (`GET`) |
| `authz:changed` | pub/sub channel | auth-service | reload the permission matrix |
