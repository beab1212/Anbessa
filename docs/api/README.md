# API docs

Each Fastify service registers its own OpenAPI spec at `/docs` in
development (via `@fastify/swagger`, not wired up in this scaffold). Treat
this folder as the place for cross-service API conventions: error shapes,
pagination, versioning policy.
