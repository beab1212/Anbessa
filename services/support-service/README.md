# support-service

**Support tickets, lost items, SOS alerts and safety incidents** ([workflow 13](../../docs/design/workflows/13-support-refunds.md), [workflow 14](../../docs/design/workflows/14-safety-sos.md)). Port 3009, database `support_service`.

- **Tickets**: opened by riders, drivers, fleet and company admins in the app, or by call center and support staff for a caller. Each gets a category, a priority and a first-response SLA (SAFETY P1 5 min … FEEDBACK P4 72 h), lands in its city's queue, and is worked in a thread (internal notes are staff-only). It is resolved with a recorded decision, can be reopened within 7 days, and is closed automatically after that. Refunds stay in payment-service: agents link the refund id and its outcome arrives from Kafka.
- **Lost items**: the rider reports within 7 days of the trip. The driver (or the fleet that owns the car) answers found / not found, the return is arranged in the item's thread, and nobody's phone number is revealed (none is stored).
- **SOS**: `POST /api/support/sos` from the app during a trip or up to 30 min after drop-off. One live alert per user and trip. It goes into the city queue for safety officers and dispatchers, who acknowledge it, then safety resolves it as FALSE_ALARM / ASSISTED / ESCALATED. Publishes `sos.triggered`, `sos.acknowledged`, `sos.resolved`.
- **Incidents**: opened from an SOS, a SAFETY ticket or by hand, investigated with notes, and resolved with an outcome. Suspensions are done in auth-service and recorded here as actions.

Staff actions are audited (`audit.recorded`). SOS and incident records are never deleted (a trigger refuses DELETE).

## Quick start

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres, Redis, Redpanda
pnpm install && make -C ../.. secrets
pnpm exec prisma migrate deploy                   # creates support_service
pnpm dev                                          # http://localhost:3009
```

It needs auth-service (JWKS, permission matrix) and trip-service (`/internal/trips/:id`). `pnpm test` runs the unit tests (SLA and state machines). `pnpm test:integration` runs against a throwaway `support_service_test` database and its own Redis container on port 6396 (Docker).

## Documentation

Detailed reference (architecture, API, events, data model, integrations, configuration, operations): [docs/README.md](docs/README.md).
