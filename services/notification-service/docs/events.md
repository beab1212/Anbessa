# Kafka events

notification-service **consumes** events only. It **produces none**: it has no outbox table and no Kafka producer. Login codes never travel through Kafka (they arrive over `POST /internal/otp-deliveries`).

## Consumer

| Property | Value | Source |
|---|---|---|
| Client id | `notification-service` | `src/notify/consumer.ts` |
| Group id | `notification-service` | `src/notify/consumer.ts` |
| Topics | every key of the handler map (11 topics below) | `src/notify/handlers.ts` |
| Start offset for a new group | kafkajs default (latest); `fromBeginning` is not set | `src/notify/consumer.ts` |
| Topic creation | non-production only: missing topics are created at start (`createTopics: NODE_ENV !== "production"`) | `src/server.ts` |
| Enabled | only when `KAFKA_BROKERS` is set; required in production | `src/server.ts`, `src/config/index.ts` |
| Processing | `eachMessage`, one message at a time per partition | `src/notify/consumer.ts` |

### Message handling

1. `JSON.parse(value)`; it must have a string `eventId`. Otherwise: error log `skipping malformed event` with topic, partition and offset; the offset moves on.
2. The topic's handler runs. A handler that returns without sending (missing recipient, wrong role) is a normal success.
3. A send failure throws → kafkajs does not commit the offset and retries the message. Messages behind it in the same partition wait, so per-partition order is kept.
4. After 5 attempts for the same `(eventId, channel)` the notifier records `FAILED` and returns normally; the offset then moves on. There is **no DLQ**.

Duplicates (redelivery, replays, two consumers racing) are absorbed by `notification.dedupe_key = eventId:channel` (see [architecture.md](architecture.md#dedupe-and-retries-notifieronce)).

## Envelope

Every event has `{ eventId, version, at, ...payload }` (`EventEnvelope` in `src/notify/handlers.ts` and `libs/shared-types/src/events.ts`). Only `eventId` is used. `version` is not checked.

## Topics consumed

Fields listed are the ones the handler reads. Field types and full payloads are in `libs/shared-types/src/events.ts` (payment events) and `services/auth-service/src/outbox/outbox.ts` (auth events). Keys are the ones the producers write.

| Topic | Producer | Key | Fields used | Condition | Channel / recipient | `template` value |
|---|---|---|---|---|---|---|
| `org.member_invited` | auth-service (`src/auth/hooks.ts`) | `orgId` | `phoneNumber`, `orgName`, `role` | skipped if no `phoneNumber` (invite by real email) | SMS to `phoneNumber` | `org_invite` |
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

Notes:

- Numeric fields that are missing or not numbers become `0` (`num()` in `src/notify/handlers.ts`); missing strings become `""` or are omitted.
- Fleet-company balances (`beneficiary.type = "ORGANIZATION"`) are skipped on purpose: they are for the fleet portal.
- Push `data` payloads: `driver.activated`, `payment.action_required` (+ `tripId`, `checkoutUrl`), `trip.receipt` (+ `tripId`), `payment.failed` (+ `tripId`), `balance.state_changed` (+ `state`), `balance.topped_up`, `balance.payment_due`, `payout.sent`, `payout.failed`, `refund.succeeded`, each as `data.type`.

## Topics not consumed

These are listed as notification inputs in `docs/architecture/overview.md` but have no handler, so the consumer does not subscribe to them: `trip.matched`, `trip.requested`, `trip.driver_en_route`, `trip.driver_arrived`, `trip.started`, `trip.completed`, `trip.cancelled`, `payment.captured`, `refund.failed`, `role.revoked`.
