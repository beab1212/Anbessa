# Kafka events

notification-service **consumes** events only. It **produces none**: it has no outbox table and no Kafka producer. Login codes never travel through Kafka (they arrive over `POST /internal/otp-deliveries`).

## Consumer

| Property | Value | Source |
|---|---|---|
| Client id | `notification-service` | `src/notify/consumer.ts` |
| Group id | `notification-service` | `src/notify/consumer.ts` |
| Topics | every key of the handler map (19 topics below, plus the campaign audience topics) | `src/notify/handlers.ts` |
| Start offset for a new group | kafkajs default (latest); `fromBeginning` is not set | `src/notify/consumer.ts` |
| Topic creation | non-production only: missing topics are created at start (`createTopics: NODE_ENV !== "production"`) | `src/server.ts` |
| Enabled | only when `KAFKA_BROKERS` is set; required in production | `src/server.ts`, `src/config/index.ts` |
| Processing | `eachMessage`, one message at a time per partition | `src/notify/consumer.ts` |

### Message handling

1. `JSON.parse(value)`; it must have a string `eventId`. Otherwise: error log `skipping malformed event` with topic, partition and offset; the offset moves on.
2. The topic's handler runs. A handler that returns without sending (missing recipient, wrong role) is a normal success.
3. A send failure throws → kafkajs does not commit the offset and retries the message. Messages behind it in the same partition wait, so per-partition order is kept.
4. After 5 attempts for the same `(eventId, channel)` the notifier records `FAILED` and returns normally; the offset then moves on. There is **no DLQ**.

Duplicates (redelivery, replays, two consumers racing) are absorbed by `notification.dedupe_key = eventId:channel`; handlers that tell several people (scheduled rides, reassignment) send each push as `<eventId>:<userId>`, so the key is `eventId:userId:channel` (see [architecture.md](architecture.md#dedupe-and-retries-notifieronce)).

## Envelope

Every event has `{ eventId, version, at, ...payload }` (`EventEnvelope` in `src/notify/handlers.ts` and `libs/shared-types/src/events.ts`). Only `eventId` is used. `version` is not checked.

## Topics consumed

Fields listed are the ones the handler reads. Field types and full payloads are in `libs/shared-types/src/events.ts` (payment events) and `services/auth-service/src/outbox/outbox.ts` (auth events). Keys are the ones the producers write.

| Topic | Producer | Key | Fields used | Condition | Channel / recipient | `template` value |
|---|---|---|---|---|---|---|
| `org.member_invited` | auth-service (`src/auth/hooks.ts`) | `orgId` | `phoneNumber`, `orgName`, `role` | skipped if no `phoneNumber` (invite by real email) | SMS to `phoneNumber`: `Anbessa: "<org name>" invited you …`, Anbessa's text first; the org name is quoted, cut to 40 characters and stripped of links, domains, 4+ digit runs, quotes and control characters (`safeOrgName`) | `org_invite` |
| `role.granted` | auth-service | `userId` | `userId`, `role` | only `role === "DRIVER"` | push to `userId` | `driver_activated` |
| `payment.action_required` | payment-service | `riderId` | `riderId`, `amountMinor`, `provider`, `purpose`, `checkoutUrl`, `tripId` | needs `riderId` | push to rider | `payment_approve` |
| `trip.settled` | payment-service | `tripId` | `riderId`, `fareMinor`, `paymentMethod`, `purpose`, `tripId` | needs `riderId` | push to rider | `trip_receipt` |
| `payment.failed` | payment-service | `riderId` | `riderId`, `amountMinor`, `final`, `tripId` | needs `riderId` | push to rider | `payment_failed` |
| `refund.succeeded` | payment-service | `riderId` | `riderId`, `amountMinor` | needs `riderId` | push to rider | `refund_sent` |
| `balance.state_changed` | payment-service | beneficiary owner id | `beneficiary {type,id}`, `state`, `balanceMinor` | only `beneficiary.type === "INDIVIDUAL"` | push to `beneficiary.id` | `balance_state` |
| `balance.topped_up` | payment-service | beneficiary owner id | `beneficiary`, `amountMinor`, `balanceMinor` | `INDIVIDUAL` only | push | `balance_topped_up` |
| `balance.payment_due` | payment-service | beneficiary owner id | `beneficiary`, `amountMinor`, `minimumMinor`, `dueAt` | `INDIVIDUAL` and `dueAt` set | push | `payment_due` |
| `payout.sent` | payment-service | beneficiary owner id | `beneficiary`, `amountMinor`, `provider` | `INDIVIDUAL` only | push | `payout_sent` |
| `payout.failed` | payment-service | beneficiary owner id | `beneficiary`, `amountMinor`, `provider` | `INDIVIDUAL` only | push | `payout_failed` |
| `payout_method.changed` | payment-service | beneficiary owner id | `beneficiary`, `destinationMasked`, `payoutsResumeAt` | `INDIVIDUAL` only; SMS only when auth-service has a phone number (looked up per event; a lookup failure throws and Kafka redelivers) | push + SMS: "Your payout account was changed to the account ending 1234. Payouts resume <time>. If this wasn't you, contact support." (English; Amharic templates exist, `lang: "am"`, but events carry no locale) | `payout_method_changed` |
| `trip.scheduled` | trip-service | `scheduledTripId` | `scheduledTripId`, `riderId`, `bookedById`, `scheduledFor`, `updated` | needs id and `scheduledFor` | push to the rider ("booked for you" when someone else booked) and to a different booker | `scheduled_booked` / `scheduled_updated` |
| `trip.schedule_cancelled` | trip-service | `scheduledTripId` | `scheduledTripId`, `riderId`, `bookedById`, `by`, `byUserId`, `scheduledFor` | whoever cancelled (`byUserId`) is skipped | push to rider / booker | `scheduled_cancelled` |
| `trip.schedule_failed` | trip-service | `scheduledTripId` | `scheduledTripId`, `riderId`, `bookedById`, `reason`, `scheduledFor` | `RIDER_HAS_ACTIVE_TRIP` gets its own wording | push to rider and booker | `scheduled_failed` |
| `trip.dispatch_escalated` | trip-service | `tripId` | `tripId`, `riderId`, `scheduledFor` | needs `riderId` | push to rider ("still finding your driver") | `scheduled_escalated` |
| `trip.reassigned` | trip-service | `tripId` | `tripId`, `riderId`, `fromDriverId`, `toDriverId?` | | push to rider ("your driver changed" / "finding you a new driver") and to the old driver ("trip reassigned"); the new driver hears through the normal match flow | `trip_reassigned` |
| `sos.triggered` | support-service | `alertId` | `alertId`, `tripId`, `userId`, `source` | `source: SYSTEM` skipped | push to `userId` (who pressed SOS) only, never the other party on the trip; body says to call 991 | `sos_triggered` |
| `sos.acknowledged` | support-service | `alertId` | `alertId`, `tripId`, `userId` | | push to `userId` | `sos_acknowledged` |
| `sos.resolved` | support-service | `alertId` | `alertId`, `tripId`, `userId`, `outcome` | `ESCALATED` gets its own wording | push to `userId` | `sos_resolved` |

Notes:

- Numeric fields that are missing or not numbers become `0` (`num()` in `src/notify/handlers.ts`); missing strings become `""` or are omitted.
- Fleet-company balances (`beneficiary.type = "ORGANIZATION"`) are skipped on purpose: they are for the fleet portal.
- Push `data` payloads: `driver.activated`, `payment.action_required` (+ `tripId`, `checkoutUrl`), `trip.receipt` (+ `tripId`), `payment.failed` (+ `tripId`), `balance.state_changed` (+ `state`), `balance.topped_up`, `balance.payment_due`, `payout.sent`, `payout.failed`, `payout_method.changed`, `refund.succeeded`, `trip.scheduled` / `trip.schedule_cancelled` / `trip.schedule_failed` (+ `scheduledTripId`), `trip.dispatch_escalated` (+ `tripId`), `trip.reassigned` (rider) / `trip.reassigned_away` (old driver) (+ `tripId`), `sos.triggered` / `sos.acknowledged` / `sos.resolved` (+ `alertId`, `tripId`), each as `data.type`.
- Times in scheduled-ride pushes are Addis Ababa time, 24-hour (`addisTime` in `src/notify/templates.ts`, e.g. "Tue 3 Nov, 14:30").
- Not built: a scheduled-ride **reminder** (no event announces one; dispatch at `matchAt` publishes a plain `trip.requested` without `scheduledTripId`), and SOS SMS to emergency contacts (no contact store).

## Topics not consumed

These are listed as notification inputs in `docs/architecture/overview.md` but have no handler, so the consumer does not subscribe to them: `trip.matched`, `trip.requested`, `trip.driver_en_route`, `trip.driver_arrived`, `trip.started`, `trip.completed`, `trip.cancelled`, `payment.captured`, `refund.failed`, `role.revoked`.

## Campaign audience topics and the outbox (workflow 15, added)

Consumed in addition (same group `notification-service`, handlers in `src/campaigns/audience.ts`):

| Topic | Producer | Effect |
|---|---|---|
| `trip.requested` | trip-service | rider active in `cityId` at `at` |
| `trip.completed` | trip-service | rider and driver active in `cityId` at `completedAt` |
| `driver.online` | fleet-service | driver active in `cityId` at `at` |

Published (new outbox, relay `src/campaigns/relay.ts`, only when `KAFKA_BROKERS` is set): `audit.recorded` for campaign create, edit, schedule and cancel, `{ actorId, action: "campaign:send", resource: { type: "campaign", id }, outcome: "EXECUTED", reason, service: "notification-service" }`.
