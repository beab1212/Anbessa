# Integrations

| System | Direction | How | Auth | Timeout | On failure |
|---|---|---|---|---|---|
| Kafka | in | `audit.recorded`, group `audit-service` | none configured in code | kafkajs defaults | start failure logged, no consumer; per-message DB errors retried |
| auth-service, fleet-service, payment-service, platform-service | in (via Kafka) | outbox → relay → `audit.recorded` | — | — | events wait in the producer's outbox or in Kafka |
| auth-service | out | `GET {AUTH_INTERNAL_URL}/internal/authz/snapshot` | `Bearer INTERNAL_SERVICE_TOKEN` | 3 s | keeps the current matrix (built-in at start), warning logged |
| auth-service | out | JWKS at `AUTH_JWKS_URL` | none | jose defaults | 401 on API calls |
| Redis | out | `EXISTS deny:{id}`, `GET pv:{id}`, subscribe `authz:changed` | `REDIS_URL` | `maxRetriesPerRequest: 2` | Redis errors during token checks fail the request (500); subscribe failure falls back to polling |
| Postgres | out | Prisma + `@prisma/adapter-pg` | `DATABASE_URL` | driver defaults | 500 / 503 ready; consumer retries |
| Web admin dashboard | in | `GET /api/audit/entries`, `/entries.csv` via Kong (Vite proxy `AUDIT_URL` in dev, `apps/web/vite.config.ts`) | staff token | — | — |
| platform-service | in | `/health/ready`; consumer-group lag of `audit-service` (`CONSUMER_GROUPS`) | none | — | shown on the System page |

No external providers.

## Kong

`infra/kong/kong.yml` (and `kong.dev.yml` → `host.docker.internal:3010`):

| Route | Paths | Methods | `strip_path` | Plugins |
|---|---|---|---|---|
| `audit-routes` | `/api/audit` | GET | false | `rate-limiting` 60/min, `policy: local` |

Kong does not check JWTs; the service does.

## Producers' side

Each producer writes the audit event in the same database transaction as the action (`writeOutbox(tx, …, audit({...}))`). The relay (`src/outbox/relay.ts` in each producer) polls every 500 ms, takes up to 100 unpublished rows with `FOR UPDATE SKIP LOCKED`, sends each with `acks: -1` and an idempotent producer, and marks them published. So an audit entry exists in Kafka if and only if the action committed, and it may arrive seconds later.

## Sequence: from a service's outbox to a query

```mermaid
sequenceDiagram
  autonumber
  participant Staff as staff user
  participant S as auth-service (any producer)
  participant OB as producer DB (outbox)
  participant K as Kafka audit.recorded
  participant A as audit-service
  participant PG as audit_service DB
  participant W as web admin (Audit log page)
  participant KG as Kong
  Staff->>S: approve a role request
  S->>OB: BEGIN; change state; INSERT outbox {topic audit.recorded, key actorId, payload {eventId, at, actorId, action, resource, outcome, reason, service}}; COMMIT
  loop relay every 500 ms
    S->>OB: SELECT … FOR UPDATE SKIP LOCKED
    S->>K: send (acks all)
    S->>OB: published_at = now
  end
  K->>A: message (group audit-service)
  A->>A: JSON.parse + Zod auditEvent
  A->>PG: INSERT … ON CONFLICT (at, event_id) DO NOTHING
  Note over PG: row lands in audit_entry_YYYY_MM (or default)
  W->>KG: GET /api/audit/entries?action=role&limit=50 (Bearer staff token)
  KG->>A: forward
  A->>A: verify ride-admin token, deny list / pv (Redis), authorize audit_log:read
  A->>PG: SELECT … ORDER BY at DESC, event_id DESC LIMIT 50
  A-->>W: { entries, next }
  W->>KG: GET /api/audit/entries.csv?action=role
  KG->>A: forward
  A->>PG: SELECT … LIMIT 50000
  A->>PG: INSERT audit_log:export entry
  A-->>W: text/csv attachment
```
