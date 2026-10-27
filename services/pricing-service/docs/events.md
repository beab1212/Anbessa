# pricing-service events

## Kafka

None. pricing-service has no Kafka client (no `kafkajs` in `package.json`), no outbox, and produces and consumes no topics. Its `docker-compose.dev.yml` starts Redpanda anyway; the service does not use it.

Quote creation and lookup are not published as events. No audit events are written.

## Redis pub/sub (subscribed)

| Channel | Publisher | Effect | Source |
|---|---|---|---|
| `settings:changed` | platform-service | reload `GET /internal/settings/snapshot` (new fares, `quote.ttlSeconds`, vehicle types) | `createSettingsClient` in `src/container.ts` |
| `authz:changed` | auth-service | reload `GET /internal/authz/snapshot` | `createAuthzSync` in `src/server.ts` |

Both also poll every 30 s, so a lost message delays a change by at most about 30 s. The subscriptions use a duplicate of the main Redis connection.
