# audit-service

The **write-once audit log** ([Role.md §12](../../docs/design/Role.md#12-audit-log)). Port 3010, database `audit_service`.

It consumes `audit.recorded` from Kafka. Every service writes these events through its outbox: auth, fleet and platform today. They cover:
- staff actions;
- approvals;
- permission and settings changes;
- suspensions;
- document and personal-data views;
- staff sign-ins.

## Storage

- **One table, `audit_entry`,** partitioned by month (`ensure_audit_partitions()` runs at start and daily).
- **Write-once:**
  - A trigger refuses every `UPDATE` and `DELETE`, even through the application.
  - A replayed event (same id and time) is stored once.
- **Retention** (ops, Database.md): export old partitions to WORM storage (S3 Object Lock) and detach them.

## API

Read only, under `/api/audit`, staff token with `audit_log:read` (super admins, auditors).

| Route | What |
|---|---|
| `GET /entries?actorId=&action=&resourceType=&resourceId=&outcome=&service=&from=&to=&cursor=&limit=` | Newest first. `action` matches a prefix (`authz`, `settings:change`). Pages with `next` |
| `GET /entries.csv?…` | The same filters, up to 50 000 rows. The export itself is recorded |

## Quick start

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres, Redpanda
pnpm install && make -C ../.. secrets
pnpm prisma migrate dev                           # creates audit_service
pnpm dev                                          # http://localhost:3010
```

Without `KAFKA_BROKERS` nothing arrives. `pnpm test:integration` runs against a throwaway `audit_service_test` database. It covers idempotent inserts, skipping invalid events, refusing updates and deletes, filters, paging and CSV export.
