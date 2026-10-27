# Architecture

## Layout

| Path | Role |
|---|---|
| `src/server.ts` | Loads config, builds container and app, runs partition maintenance, starts the Kafka consumer and the authz sync, listens, shuts down on `SIGTERM`/`SIGINT` |
| `src/container.ts` | Composition root: Prisma, optional Redis, audit store, token verifier (with deny list and permission-version checks when Redis is set) |
| `src/app.ts` | Fastify (`trustProxy: true`, `bodyLimit` 32 KiB), helmet, rate limit 300/min, health routes, routes |
| `src/http/routes.ts` | `GET /api/audit/entries`, `GET /api/audit/entries.csv` |
| `src/store.ts` | Event schema (`auditEvent`), `insert`, `search`, `exportCsv` |
| `src/events/consumer.ts` | kafkajs consumer for `audit.recorded`; `handle()` is also used by tests |
| `src/middlewares/error-handler.ts` | Error → `{ error, message }` JSON |
| `src/config/index.ts` | Zod env schema |
| `src/generated/prisma/` | Generated Prisma client |

There are no internal (`/internal/*`) routes and no outbox: the service produces no events.

## Background work

| Job | When | What |
|---|---|---|
| Partition maintenance | at start (awaited), then every 24 h | `SELECT ensure_audit_partitions(2)`: creates the monthly partitions for this month and the next two if missing. Errors are logged (`partition maintenance failed`), not fatal |
| Kafka consumer | continuous, only if `KAFKA_BROKERS` | Start errors are caught and logged (`Kafka consumer failed to start; audit events wait in Kafka`); the HTTP API still starts |
| Authz sync | start, Redis `authz:changed`, poll every 30 s | Keeps the permission matrix equal to auth-service's (`libs/shared-authz/src/sync.ts`). Used by `authorize(p, "audit_log:read")` |

## Ingest flow

1. A producing service writes `{ topic: "audit.recorded", key: actorId ?? "system", payload }` into its outbox in the same transaction as the action, with the envelope `{ eventId (uuidv7), version: 1, at }` and `service` set by its `audit()` helper.
2. The producer's outbox relay publishes to Kafka (`acks: -1`, idempotent producer; `services/auth-service/src/outbox/relay.ts`).
3. `consumer.handle()` parses JSON and validates with `auditEvent` (Zod). Unknown fields (`version`) are dropped.
4. `store.insert()` runs one raw `INSERT … ON CONFLICT (at, event_id) DO NOTHING`.

### Idempotency

The primary key is `(at, event_id)`. A replayed or redelivered event carries the same `eventId` and `at` (both are fixed in the outbox row), so the second insert does nothing. `insert()` returns `true` only when a row was inserted; the consumer ignores the value. An event with the same `eventId` but a different `at` would be stored twice: the PK includes `at` because a partitioned table's primary key must include the partition column.

### Errors and retries

| Error | Behaviour |
|---|---|
| `SyntaxError` (not JSON) or `ZodError` (schema) | logged `skipping invalid audit event` (first 300 chars of the message), offset moves on. The event is lost for the audit log |
| Anything else (database unreachable, other database errors) | rethrown; kafkajs does not commit the offset and retries. Later messages in the partition wait |

No DLQ.

## Write-once

- Trigger `audit_entry_no_update_delete`: `BEFORE UPDATE OR DELETE … FOR EACH ROW` calls `audit_entry_immutable()`, which raises `audit entries are write-once (UPDATE|DELETE)` with SQLSTATE `insufficient_privilege`. The integration test checks both through Prisma.
- Not blocked by the trigger: `TRUNCATE`, `DROP`/`DETACH PARTITION`, `ALTER TABLE … DISABLE TRIGGER`. Protection against those depends on the database role. The migration grants nothing; docs/production/README.md asks ops to give the service role INSERT/SELECT only.
- The application has no update or delete code path.

## Partitioning

- `audit_entry` is `PARTITION BY RANGE (at)`.
- `audit_entry_default` (DEFAULT partition) catches rows with no matching monthly partition.
- `ensure_audit_partitions(months_ahead int DEFAULT 2)` creates `audit_entry_YYYY_MM` from the first of the current month for `months_ahead + 1` months, skipping existing ones (`to_regclass`). The migration calls it once.
- Retention and archiving are not implemented in code.

## Query path

- `GET /api/audit/entries`: verify the staff token (`ride-admin`), `authorize(p, "audit_log:read")`, then `findMany` ordered by `at DESC, event_id DESC`, `take = limit`. `next` is `"{at ISO}|{eventId}"` of the last row when the page is full, else `null`.
- Cursor condition: `at < cursorAt OR (at = cursorAt AND event_id < cursorId)`.
- `action` is a prefix match (`startsWith`, case-sensitive). Other filters are equality; `from`/`to` are inclusive.
- `GET /api/audit/entries.csv`: same filters, up to 50 000 rows, newest first. After reading, the service inserts its own entry: `action = "audit_log:export"`, `resource = { type: "audit_log", id: "export" }`, `outcome = EXECUTED`, `actorId` = caller, `reason = "{n} rows · {filters JSON}"`, `service = "audit-service"`. This insert goes straight to the database, not through Kafka.
- CSV cells are quoted when they contain `"`, `,` or a newline. No protection against spreadsheet formula injection (cells starting with `=`, `+`, `-`, `@`) was found.

## Security model

| Concern | What the code does |
|---|---|
| Who can read | Access token for audience `ride-admin` (staff surface), verified against auth-service's JWKS: ES256, issuer, `sub`/`exp`/`iat`, 30 s tolerance (`libs/shared-authz/src/verify.ts`). Then permission `audit_log:read`; in the built-in matrix `SUPER_ADMIN` and `AUDITOR` hold it with global scope (`libs/shared-authz/src/matrix.ts`). The live matrix from auth-service can change this |
| Suspended users, changed roles | With `REDIS_URL` set: `deny:{userId}` present → 401 `token_revoked`; token `pv` lower than `pv:{userId}` → 401 `token_outdated`; a failed Redis lookup → 503 `auth_unavailable`. Without Redis these checks are skipped |
| Writes | None over HTTP. Kong routes only `GET /api/audit` |
| Cache | Responses carry `cache-control: no-store` |
| Rate limiting | 300/min/IP in the service (in memory), 60/min in Kong |
| Headers | `@fastify/helmet` defaults |
| Kafka trust | Any producer that can write to `audit.recorded` can add entries; the consumer does not authenticate producers. The `service` field is whatever the producer wrote |

## Caching

None besides the in-memory permission matrix and the JWKS cache inside `jose`.
