# @ride-app/shared-utils

Two small helpers every service uses: `createLogger` (pino, pretty output outside production) and the `AppError` / `NotFoundError` error classes. Outbox, Kafka, audit and idempotency helpers are not here; each service has its own copy.

Full documentation: [docs/README.md](docs/README.md).
