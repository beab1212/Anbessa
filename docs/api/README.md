# API docs

All HTTP services run on Fastify 5 (Node 24), and request/env validation uses
Zod 4. Each Fastify service registers its own OpenAPI spec at `/docs` in
development (via `@fastify/swagger`, not wired up in this scaffold). Treat
this folder as the place for cross-service API conventions: error shapes,
pagination, versioning policy.
