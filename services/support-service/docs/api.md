# API

Every route of support-service, from `src/http/routes.ts` and `src/app.ts`. Public routes are reached through Kong at `/api/support`. `/internal/*` is reachable only inside the network.

## Conventions

| Topic | Rule |
|---|---|
| Auth | `Authorization: Bearer <access token>`, audience `ride-app` (phone app, partner portal) or `ride-admin` (staff web); both are accepted everywhere. Exceptions: health routes (none) and `/internal/*` (service token) |
| Body | JSON, at most 32 KB, validated with zod (unknown fields ignored) |
| Ids | uuids; `cityId` matches `^[a-z0-9-]{1,40}$` |
| Lists | `cursor` + `limit` (1–200, default 50) → `{ <items>, next }`; newest first unless stated |
| Idempotency | `Idempotency-Key` on `POST /tickets`, `POST /lost-items`, `POST /sos` (same contract as trip-service) |
| Errors | `{ error, message }`; validation adds `issues` |
| Hidden resources | Things you may not see answer `404 not_found`; seen but not allowed → `403 forbidden` |
| Caching | lists and detail views send `cache-control: no-store` |

## Error codes

| Status | `error` | When |
|---|---|---|
| 400 | `validation_error`, `bad_request`, `use_lost_items` | bad input; a missing `cityId` without a trip; app ticket with category LOST_ITEM |
| 401 | `unauthorized`, `invalid_token`, `token_revoked`, `token_outdated` | token problems |
| 403 | `forbidden` | missing permission / scope; app tokens on staff lists; staff on `POST /sos` and `POST /lost-items` |
| 404 | `not_found` | missing or hidden ticket, trip, lost item, alert, incident |
| 409 | `invalid_transition`, `invalid_state`, `reopen_window_closed`, `ticket_resolved`, `ticket_closed`, `already_linked`, `already_reported`, `report_window_closed`, `lost_item_closed`, `sos_unavailable`, `sos_resolved`, `incident_resolved`, `request_in_progress` | see routes |
| 422 | `idempotency_mismatch` | same key, different request |
| 503 | `auth_unavailable` (`retry-after: 5`), `dependency_unavailable` (trip-service) | |

## Objects

| Object | Fields |
|---|---|
| Ticket (staff) | `id, ref, cityId, category, priority, status, source, subject, description, requester { userId, kind, orgId }, createdByUserId, tripId, assigneeUserId, firstResponseDueAt, firstRespondedAt, overdue, resolution, resolutionNote, resolvedAt, closedAt, reopenCount, incidentId, lostItemId, createdAt, updatedAt` |
| Ticket (requester) | `id, ref, cityId, category, status, subject, description, tripId, resolution, resolutionNote, resolvedAt, closedAt, lostItemId, createdAt, updatedAt` |
| TicketMessage | `id, authorUserId (null for staff/system in the requester view), authorKind REQUESTER\|STAFF\|SYSTEM, internal, body, createdAt` |
| TicketRefund | `refundId, amountMinor, status REQUESTED\|SUCCEEDED\|FAILED, note, linkedByUserId, createdAt, updatedAt` |
| LostItem | `id, ticketId, tripId, cityId, description, status, driverNote, respondedAt, returnedAt, closedAt, createdAt, updatedAt, viewerRole`; staff also `riderUserId, driverUserId, fleetOrgId, driverNotFoundCount` |
| LostItemMessage | `id, authorKind RIDER\|DRIVER\|FLEET\|STAFF, body, createdAt` (no user ids) |
| SosAlert (staff) | `id, cityId, tripId, userId, role, source, status, outcome, location { lat, lng, accuracy, at }, triggeredAt, acknowledgedAt, acknowledgedBy, resolvedAt, resolvedBy, resolutionNote, emergencyReference, incidentId, riderUserId, driverUserId, tripVerified, ackOverdue` |
| SosAlert (owner) | `id, tripId, status, outcome, triggeredAt, acknowledgedAt, resolvedAt` |
| Note | `id, authorUserId, body, createdAt` |
| Incident | `id, ref, cityId, category, severity, status, summary, tripId, subjectUserIds, source, ownerUserId, openedBy, outcome, outcomeNote, resolvedAt, resolvedBy, createdAt, updatedAt` |
| IncidentAction | `id, userId, kind, until, reference, note, recordedBy, createdAt` |

## Health

`GET /health`, `GET /health/live` → `200 { status: "ok" }`. `GET /health/ready` → `SELECT 1` on Postgres, `503 { status: "unavailable" }` on failure.

## Tickets

| Route | Who | Body / query | Response | Notes |
|---|---|---|---|---|
| `POST /api/support/tickets` **idempotent** | app: `ticket:create` @ SELF (or @ ORG with `orgId`); staff: `ticket:create` @ city | `{ category, subject (≤200), description (≤5000), tripId?, cityId?, orgId?, as?: RIDER\|DRIVER }`; staff add `requesterUserId` (required), `source?: PHONE\|STAFF` (default PHONE), `priority?` | `201 { ticket }` | city = trip's city, else `cityId` (400 if neither). Trip not yours → 404. SAFETY → P1 + incident. Staff creation is audited (`ticket:create`, `onBehalfOf`) |
| `GET /api/support/me/tickets` | app | `cursor, limit` | `{ tickets, next }` (requester view) | |
| `GET /api/support/tickets` | staff `ticket:read` | `cityId, status (comma list), category, priority, assignee=me\|none\|<uuid>, overdue=true, q, tripId, requesterUserId, cursor, limit` | `{ tickets, next }` | `q`: subject/description (case-insensitive) or `#ref`. No `cityId` → every city you hold `ticket:read` in; a city outside them → 403 |
| `GET /api/support/tickets/:id` | requester side or staff `ticket:read` | | staff: `{ ticket, messages, refunds, lostItem }`; requester: `{ ticket, messages }` (public only) | |
| `PATCH /api/support/tickets/:id` | `ticket:update` | `{ priority?, category? }` | `{ ticket }` | to SAFETY → P1 + incident; a new category moves an unanswered deadline. 409 `ticket_closed` |
| `POST /api/support/tickets/:id/claim` | `ticket:update` | | `{ ticket }` | assignee = you; OPEN → IN_PROGRESS |
| `POST /api/support/tickets/:id/assign` | `ticket:update` | `{ assigneeUserId: uuid\|null }` | `{ ticket }` | OPEN → IN_PROGRESS on assign; IN_PROGRESS → OPEN on unassign. The assignee's permissions are not checked |
| `POST /api/support/tickets/:id/status` | `ticket:update` | `{ status: OPEN\|IN_PROGRESS\|WAITING_REQUESTER\|CLOSED, note? }` | `{ ticket }` | `409 invalid_transition`; `note` becomes an internal message |
| `POST /api/support/tickets/:id/resolve` | `ticket:update` | `{ resolution, note }` | `{ ticket }` | `ticket.resolved`; ESCALATE_SAFETY opens an incident; push `support:ticket_resolved` |
| `POST /api/support/tickets/:id/reopen` | requester or `ticket:update` | `{ reason }` | `{ ticket }` | RESOLVED only, ≤ 7 days (`409 reopen_window_closed`) |
| `POST /api/support/tickets/:id/messages` | requester or `ticket:update` | `{ body, internal? }` (staff only) | `201 { message }` | first public staff message = first response; push `support:ticket_message`. A requester reply moves WAITING_REQUESTER → IN_PROGRESS |
| `POST /api/support/tickets/:id/refunds` | `ticket:update` | `{ refundId, amountMinor?, note? }` | `201 { refund }` | `409 already_linked`. The refund itself is requested in payment-service first |

## Lost items

| Route | Who | Body / query | Response | Notes |
|---|---|---|---|---|
| `POST /api/support/lost-items` **idempotent** | app: the trip's rider or booker (`ticket:create` @ SELF) | `{ tripId, description }` | `201 { lostItem }` | completed trip ≤ 7 days ago (`409 report_window_closed`); one live report per trip (`409 already_reported`); opens a LOST_ITEM ticket; push `support:lost_item` to the driver |
| `GET /api/support/me/lost-items` | app | `cursor, limit` | `{ lostItems, next }` | reports you made, about trips you drove, or about your fleet's cars |
| `GET /api/support/lost-items` | staff `lost_item:manage` | `cityId, status, tripId, cursor, limit` | `{ lostItems, next }` | |
| `GET /api/support/lost-items/:id` | rider, driver, fleet, staff | | `{ lostItem, messages }` | |
| `POST /api/support/lost-items/:id/respond` | driver, fleet, staff | `{ found, note? }` | `{ lostItem }` | → FOUND / NOT_FOUND; the rider gets 403 |
| `POST /api/support/lost-items/:id/status` | staff (any allowed move); rider (RETURNED only) | `{ status: FOUND\|NOT_FOUND\|RETURNED\|CLOSED, note?, share? }` | `{ lostItem }` | RETURNED → `lost_item.returned`; RETURNED / CLOSED resolve the ticket. A staff `note` is an internal message (staff only, `internal: true`) unless `share: true`; only a shared note becomes the ticket's resolution note. A staff note never replaces the driver's `driverNote` (also for staff answering through `/respond`). Messages carry `internal`; non-staff readers never get internal ones |
| `POST /api/support/lost-items/:id/messages` | any viewer | `{ body }` | `201 { message }` | `409 lost_item_closed` |

## SOS

| Route | Who | Body / query | Response | Notes |
|---|---|---|---|---|
| `POST /api/support/sos` **idempotent** | app: the trip's rider, booker or driver (`sos:trigger` @ SELF) | `{ tripId, location: { lat, lng, accuracy? }, cityId? }` | `201 { alert, duplicate: false }` or `200 { alert, duplicate: true }` | active trip or ≤ 30 min after drop-off (`409 sos_unavailable`); trip-service down + `cityId` → accepted unverified; staff → 403 |
| `POST /api/support/sos/:id/location` | the presser | `{ lat, lng, accuracy? }` | `{ alert }` | `409 sos_resolved` |
| `GET /api/support/sos` | staff `sos:respond` | `cityId, status=active\|resolved\|all` (default active) | `{ alerts }` (max 200) | active: OPEN first, then oldest first. Poll it (the web polls every 5 s) |
| `GET /api/support/sos/:id` | the presser (owner view) or `sos:respond` | | `{ alert }` / `{ alert, notes }` | |
| `POST /api/support/sos/:id/acknowledge` | `sos:respond` | `{ note? }` | `{ alert }` | `sos.acknowledged`, audited, push `support:sos` |
| `POST /api/support/sos/:id/notes` | `sos:respond` | `{ body }` | `201 { note }` | |
| `POST /api/support/sos/:id/resolve` | `sos:respond` + `incident:manage` | `{ outcome: FALSE_ALARM\|ASSISTED\|ESCALATED, note, emergencyReference? }` | `{ alert }` | `sos.resolved`, audited, push `support:sos` |

## Incidents

| Route | Who | Body / query | Response | Notes |
|---|---|---|---|---|
| `POST /api/support/incidents` | `incident:manage` @ the city | `{ category, severity, summary, cityId?, tripId?, subjectUserIds?, sosAlertId?, ticketId? }` | `201 { incident }` | from an SOS or a ticket the city, trip and users are copied; `409 already_linked`; by hand `cityId` is required |
| `GET /api/support/incidents` | `incident:manage` | `cityId, status, severity, category, cursor, limit` | `{ incidents, next }` | |
| `GET /api/support/incidents/:id` | `incident:manage` | | `{ incident, notes, actions, sosAlerts, tickets }` | |
| `PATCH /api/support/incidents/:id` | `incident:manage` | `{ severity?, category?, summary?, status?: OPEN\|INVESTIGATING, ownerUserId?: uuid\|null }` | `{ incident }` | `409 incident_resolved` |
| `POST /api/support/incidents/:id/notes` | `incident:manage` | `{ body }` | `201 { note }` | |
| `POST /api/support/incidents/:id/actions` | `incident:manage` | `{ userId, kind: WARNING\|SUSPENDED\|BANNED\|REINSTATED\|PAIR_BLOCK, until?, reference?, note? }` | `201 { action }` | records a decision carried out elsewhere; adds the user to the subjects; audited |
| `POST /api/support/incidents/:id/resolve` | `incident:manage` | `{ outcome: CLEARED\|WARNING\|SUSPENDED_TEMPORARY\|REMOVED_PERMANENTLY, note }` | `{ incident }` | `incident.resolved`, audited |

## Internal

| Route | Caller | Response |
|---|---|---|
| `GET /internal/ops/outbox` | platform-service system page | `{ pending, oldestAt }` (unpublished outbox rows) |
