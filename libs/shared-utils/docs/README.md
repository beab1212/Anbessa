# `@ride-app/shared-utils`

A small lib: a logger factory and two error classes. Source: [`src/logger.ts`](../src/logger.ts), [`src/errors.ts`](../src/errors.ts), re-exported from [`src/index.ts`](../src/index.ts).

## What is (and isn't) here

| Exported | File |
|---|---|
| `createLogger(serviceName, environment)` | `logger.ts` |
| `Logger` (type, re-exported from pino) | `logger.ts` |
| `AppError` | `errors.ts` |
| `NotFoundError` | `errors.ts` |

**Not in this lib** (not found in `libs/shared-utils/src`): outbox helpers, audit helpers, Kafka helpers, idempotency, retries, ids. Each service has its own copy:

| Helper | Where it lives today |
|---|---|
| Transactional outbox (`writeOutbox`, typed event union, `audit(...)` builder) | `services/{auth,fleet,payment,platform,trip}-service/src/outbox/outbox.ts` |
| Outbox → Kafka relay (`createOutboxRelay`, `idempotent: true, maxInFlightRequests: 1`) | `services/{auth,fleet,payment,platform,trip}-service/src/outbox/relay.ts` |
| `AuditPayload` (`{ actorId, action, resource, outcome, reason?, service? }`) | declared separately in each producer's `outbox.ts` |
| Kafka consumers | `services/location-service/src/events/kafka.ts`, `fleet-service/src/events/consumer.ts`, `payment-service/src/events/consumer.ts`, `notification-service/src/notify/consumer.ts`, `audit-service/src/events/consumer.ts` |
| HTTP `Idempotency-Key` handling (`withIdempotency`, `purgeIdempotencyKeys`) | `services/{trip,fleet,payment}-service/src/lib/idempotency.ts` |
| Error shortcuts (`badRequest`, `forbidden`, `notFound`, `conflict`, `unauthorized`) built on `AppError` | `services/*/src/lib/errors.ts` |
| Fastify error handler mapping `AppError` → JSON | `services/*/src/middlewares/error-handler.ts` |

They are near-identical across services; moving them here would be a code change and is out of scope for these docs.

## Who uses it

Every service lists `"@ride-app/shared-utils": "workspace:*"` and imports it. Counts of importing files: payment-service 13, notification-service 9, auth-service 8, fleet-service 8, trip-service 8, location-service 6, platform-service 6, mapping-service 5, audit-service 4, pricing-service 4, realtime-gateway 1. `apps/web` doesn't use it. Symbols used: `Logger` (51 imports, mostly as a type for dependency injection), `AppError` (20), `createLogger` (11). `NotFoundError` is not imported anywhere.

---

## `createLogger(serviceName: string, environment: string): Logger`

```ts
pino({
  name: serviceName,
  level: environment === "production" ? "info" : "debug",
  transport: environment === "production" ? undefined : { target: "pino-pretty" },
});
```

- `environment` is compared with the exact string `"production"`. Anything else (`development`, `test`, a typo) gives `debug` level and the `pino-pretty` transport (human-readable output).
- Production: `info` level, newline-delimited JSON on stdout, each line with `"name": "<serviceName>"`.
- No redaction, no base fields beyond pino's defaults (`pid`, `hostname`), no request-id handling (Fastify adds that on its own child loggers).

Every service wraps it in `src/utils/logger.ts` to allow a level override:

```ts
// services/trip-service/src/utils/logger.ts (same in the other services)
export function serviceLogger(nodeEnv: string, level?: string): Logger {
  const logger = createLogger("trip-service", nodeEnv);
  if (level) logger.level = level;
  return logger;
}
// server.ts
const logger = serviceLogger(config.NODE_ENV, config.LOG_LEVEL);
```

realtime-gateway calls `createLogger("realtime-gateway", config.NODE_ENV)` directly.

### `Logger`

`export type { Logger }` from pino. Services type their dependencies with it (`logger: Logger`) so modules don't import pino themselves. shared-authz and shared-settings don't depend on it: they declare a structural `{ info, warn }` logger.

## `AppError`

```ts
class AppError extends Error {
  constructor(public statusCode: number, message: string, public code: string);
}
```

An error meant to reach the client: HTTP status, a human message, and a stable machine `code`. The services' Fastify error handlers turn it into the response body:

```ts
// services/trip-service/src/middlewares/error-handler.ts
if (err instanceof AppError) return reply.status(err.statusCode).send({ error: err.code, message: err.message });
```

Anything that isn't an `AppError` (or shared-authz's `AuthorizationError` / `TokenError`, or a `ZodError`, or a Fastify 4xx) becomes `500 { error: "internal_error" }` and is logged.

Typical use, through the per-service shortcuts:

```ts
// services/trip-service/src/lib/errors.ts
export const badRequest = (message: string, code = "bad_request") => new AppError(400, message, code);
export const conflict = (message: string, code = "conflict") => new AppError(409, message, code);
// services/trip-service/src/trips/service.ts
throw new AppError(503, deps.settings.get<string>("maintenance.message"), "maintenance");
```

`name` is not set, so `err.name` is `"Error"`; use `instanceof`. With the `development` condition and `dist/` both in play, `instanceof` only works if the throwing and catching code load the same copy of the lib (they do when a service runs consistently with or without the condition).

## `NotFoundError`

```ts
class NotFoundError extends AppError {
  constructor(resource: string);   // → AppError(404, `${resource} not found`, "not_found")
}
```

Not used; services use their own `notFound(what)` shortcut, which builds the same `AppError`.

## Build and import

[`package.json`](../package.json): `exports` with `development` → `./src/index.ts`, `types` → `./dist/index.d.ts`, `default` → `./dist/index.js`. Dependencies: `pino`, `pino-pretty`. Scripts: `build` (`tsc -p tsconfig.json`), `lint`, `typecheck`. No tests.

```ts
import { AppError, createLogger, type Logger } from "@ride-app/shared-utils";
```

## What belongs here

Small, dependency-light helpers that every service needs identically and that have no domain knowledge. Not domain types (shared-types), not authorization (shared-authz), not configuration (shared-config).
