# Events

## Produced (outbox → Kafka)

- **How they are written:** in the same transaction as the change, through `writeOutbox()` (`src/outbox/outbox.ts`).
- **Envelope:** `{ eventId: uuidv7, version: 1, at }`, merged into the payload.
- **Publishing:** the relay (`src/outbox/relay.ts`) publishes every 500 ms with an idempotent producer (`acks: -1`). Batches are 100 rows, taken `FOR UPDATE SKIP LOCKED`.
- **Payload types:** in `libs/shared-types/src/events.ts`. Topic names are in `SUPPORT_TOPICS`.

| Topic | Key | When | Payload |
|---|---|---|---|
| `ticket.created` | ticketId | any new ticket (app, staff, lost-item report) | `TicketCreatedEvent`: `ticketId, ref, cityId, category, priority, source, requesterUserId, tripId?, firstResponseDueAt` |
| `ticket.resolved` | ticketId | resolve (staff), lost item returned / closed, 72 h no-reply timer | `TicketResolvedEvent`: `ticketId, cityId, category, requesterUserId, tripId?, resolution, byUserId \| null` |
| `ticket.closed` | ticketId | staff close, 7-day timer | `TicketClosedEvent`: `ticketId, cityId, requesterUserId, automatic, byUserId \| null` |
| `lost_item.returned` | lostItemId | status RETURNED | `LostItemReturnedEvent` |
| `sos.triggered` | alertId | a new SOS alert (not a duplicate press) | `SosTriggeredEvent`: `alertId, cityId, tripId, userId, role, source, lat, lng, triggeredAt, riderUserId?, driverUserId?, tripVerified` |
| `sos.acknowledged` | alertId | acknowledge | `SosAcknowledgedEvent` |
| `sos.resolved` | alertId | resolve | `SosResolvedEvent`: `… outcome, byUserId, resolvedAt, incidentId?` |
| `incident.opened` | incidentId | an incident from an SOS, a ticket (SAFETY tickets automatically, `byUserId: null`), or by hand | `IncidentOpenedEvent` |
| `incident.resolved` | incidentId | resolve | `IncidentResolvedEvent` |
| `audit.recorded` | actorId | staff actions (below) | `{ actorId, action, resource { type, id }, outcome: "EXECUTED", reason, onBehalfOf?, service: "support-service" }` |

No service consumes the support topics yet. Missing consumers worth adding:
- **notification-service:** pushes for `ticket.resolved` and `lost_item.*`; SMS to emergency contacts on `sos.triggered`. There is no template or contact store today.
- **On-call paging:** `sos.triggered` not acknowledged within 60 s.
- **trip-service:** the pair-block filter from `incident.resolved`.

### Audit actions

| `action` | `resource.type` | Written by |
|---|---|---|
| `ticket:create` | ticket | staff logging a ticket for a caller (`onBehalfOf` = requester) |
| `ticket:update` | ticket | claim, assign, status change, resolve, staff reopen, priority/category change, linking a refund |
| `lost_item:manage` | lost_item | staff status changes and staff answers |
| `sos:respond` | sos_alert | acknowledge (reason includes seconds to acknowledge), resolve |
| `incident:manage` | incident | open, patch, recorded action, resolve |

Messages and notes are not audited separately; they are stored with their author.

## Consumed

Consumer group `support-service` (`src/events/consumer.ts`). Topics are created outside production (`createTopics`).

| Topic | Producer | Handling |
|---|---|---|
| `refund.succeeded` | payment-service | linked `ticket_refund` rows with this `refundId` in `REQUESTED` → `SUCCEEDED`, plus one internal SYSTEM message on the ticket |
| `refund.failed` | payment-service | same, → `FAILED` |

- **Idempotent:** only `REQUESTED` rows change, so a replay does nothing.
- **Bad messages:** invalid JSON or a missing / non-uuid `refundId` is logged and skipped.
- **Database errors:** rethrown, so kafkajs retries.

## Socket pushes (phone app)

Best effort, through the Socket.io Redis emitter (`src/lib/realtime.ts`) to room `user:{userId}` that realtime-gateway joins. Staff consoles can't receive them (the gateway refuses `ride-admin` tokens); they poll.

| Event | To | Payload |
|---|---|---|
| `support:ticket_message` | the requester | `{ ticketId, ref }` on a public staff reply |
| `support:ticket_resolved` | the requester | `{ ticketId, ref, resolution }` |
| `support:lost_item` | the rider and the driver (not the actor) | `{ lostItemId, tripId, status? , message? }` |
| `support:sos` | the person who pressed SOS | `{ alertId, status: ACKNOWLEDGED \| RESOLVED }` |
