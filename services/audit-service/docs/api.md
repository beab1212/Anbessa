# HTTP API

Routes: `src/app.ts` (health) and `src/http/routes.ts`. Port 3010. The API is read only; there is no create, update or delete route.

## Summary

| Method | Path | Caller | Auth | Through Kong |
|---|---|---|---|---|
| GET | `/health` | Docker `HEALTHCHECK`, load balancer | none | no |
| GET | `/health/live` | orchestrator | none | no |
| GET | `/health/ready` | orchestrator, platform-service system page | none | no |
| GET | `/api/audit/entries` | web admin dashboard (`apps/web/src/pages/admin/Audit.tsx`, `Users.tsx`) | staff token (`ride-admin`) + `audit_log:read` | yes |
| GET | `/api/audit/entries.csv` | web admin dashboard (`Audit.tsx`) | staff token + `audit_log:read` | yes |

No `/internal/*` routes and no webhooks.

## Errors

`src/middlewares/error-handler.ts`; body `{ "error": "<code>", "message": "<text>" }`.

| Status | `error` | When |
|---|---|---|
| 400 | `validation_error` (+ `issues`) | query parameters fail the Zod schema |
| 401 | `unauthorized` | no bearer token |
| 401 | `invalid_token` | bad signature, issuer, audience (e.g. an app `ride-app` token), or expired |
| 401 | `token_revoked` | user is on the Redis deny list (only with `REDIS_URL`) |
| 401 | `token_outdated` | roles changed since the token was issued (only with `REDIS_URL`) |
| 403 | `forbidden` | no `audit_log:read` |
| 404 | `not_found` | unknown route |
| 429 | rate-limit plugin | > 300 req/min/IP (in-process) |
| 500 | `internal_error` | anything else |

## Rate limits

| Layer | Limit |
|---|---|
| Service (`@fastify/rate-limit`) | 300 / minute / IP, in memory, all routes |
| Kong (`infra/kong/kong.yml`) | 60 / minute, `policy: local`, route `/api/audit`, GET only |

---

## Health

- `GET /health`, `GET /health/live` → `200 { "status": "ok" }`.
- `GET /health/ready` → Postgres `SELECT 1`: `200 { "status": "ok" }` or `503 { "status": "unavailable" }`. Kafka and Redis are not checked.

---

## Filters (both routes)

| Param | Type | Rules | Match |
|---|---|---|---|
| `actorId` | uuid | Zod `uuid()` | equal |
| `action` | string | ≤ 80 | **prefix** (`authz` matches `authz:change`) |
| `resourceType` | string | ≤ 60 | equal |
| `resourceId` | string | ≤ 200 | equal |
| `outcome` | enum | `ALLOWED`, `DENIED`, `PENDING_APPROVAL`, `EXECUTED` | equal |
| `service` | string | ≤ 60 | equal |
| `from` | date | anything `z.coerce.date()` accepts (ISO recommended) | `at >= from` |
| `to` | date | same | `at <= to` |

Unknown parameters are ignored.

## `GET /api/audit/entries`

Extra parameters:

| Param | Type | Default | Rules |
|---|---|---|---|
| `limit` | int | 50 | 1–200 |
| `cursor` | string | none | ≤ 100 chars; the `next` value of the previous page, `"{at ISO}|{eventId}"`. Its parts are not validated; it applies only if both parts are present |

Response `200`, header `cache-control: no-store`:

```json
{
  "entries": [
    {
      "eventId": "0192f7a8-…",
      "at": "2026-10-27T09:14:03.000Z",
      "actorId": "0192…",
      "action": "role:approve",
      "resourceType": "approval_request",
      "resourceId": "0192…",
      "outcome": "EXECUTED",
      "reason": "night shift cover",
      "onBehalfOf": null,
      "service": "auth-service",
      "recordedAt": "2026-10-27T09:14:04.120Z"
    }
  ],
  "next": "2026-10-27T09:14:03.000Z|0192f7a8-…"
}
```

Order: `at` desc, then `eventId` desc. `next` is `null` when fewer than `limit` rows came back. URL-encode the cursor (it contains `|` and `:`).

## `GET /api/audit/entries.csv`

Same filters (no `limit`, no `cursor`). Returns up to 50 000 rows, newest first.

Response `200`:

| Header | Value |
|---|---|
| `content-type` | `text/csv; charset=utf-8` |
| `content-disposition` | `attachment; filename="audit-YYYY-MM-DD.csv"` (server date, UTC) |
| `cache-control` | `no-store` |

Columns, in order: `at, service, actor_id, action, resource_type, resource_id, outcome, reason, on_behalf_of, event_id`. Dates are ISO 8601, nulls are empty, cells with `"` `,` or newline are quoted. Lines end in `\n`, with a trailing newline.

Side effect: one `audit_log:export` entry is inserted for the caller (see [architecture.md](architecture.md#query-path)). It is written after the rows are read, so it is not part of the same export.
