# @ride-app/shared-utils

Small helpers every service uses: `createLogger` (pino, pretty output outside production, query strings and share tokens stripped from request logs, secrets redacted), `kafkaClientConfig` (Kafka TLS/SASL from env, required in production), `trustProxyFromEnv` (`TRUST_PROXY`, default one hop) and the `AppError` / `NotFoundError` error classes. Outbox, audit and idempotency helpers are not here; each service has its own copy.

Full documentation: [docs/README.md](docs/README.md).
