# Events

Kafka (Redpanda) in and out, the outbox relay, live pushes through realtime-gateway, and Redis pub/sub. Payload contracts are in `libs/shared-types/src/events.ts`.

## Envelope

Every event this service produces carries `eventId` (UUIDv7), `version` (`1`) and `at` (ISO time the outbox row was written), merged with the payload (`writeOutbox` in `src/outbox/outbox.ts`). Events carry ids and amounts only, never payout destinations.

## Consumed

`src/events/consumer.ts`. kafkajs client id `payment-service`, consumer group **`payment-service`**, both topics in one subscription. Outside production the consumer creates the two topics if missing (`createTopics: NODE_ENV !== "production"`).

| Topic | Producer | Key | What payment-service does |
|---|---|---|---|
| `trip.completed` | trip-service | `tripId` | `payments.onTripCompleted`: cash and company-account trips settle at once; mobile money and card trips with something left to pay (`fareMinor − promoDiscountMinor > 0`) create a `payment` for that amount and start the charge after commit; a digital trip fully covered by a promo settles at once with nothing charged |
| `trip.cancelled` | trip-service | `tripId` | `payments.onTripCancelled`: nothing if `feeMinor ≤ 0`; a digital fee creates a `CANCELLATION_FEE` payment; a cash fee becomes a rider receivable; corporate with `billingOrgId` a company receivable. The beneficiary gets `driverCompensationMinor` (capped at the fee) at once |

Validated fields (zod, `schemas` in `src/events/consumer.ts`):

| `trip.completed` field | Rule |
|---|---|
| `eventId` | string, min 1 |
| `version`, `at` | number, string |
| `tripId`, `riderId`, `driverId` | uuid |
| `cityId` | 1–40 chars |
| `vehicleType` | 1–30 chars |
| `vehicleId` | min 1 |
| `beneficiary` | `{ type: INDIVIDUAL \| ORGANIZATION, id: uuid }` |
| `paymentMethod` | `CASH`, `MOBILE_MONEY`, `CARD`, `CORPORATE` |
| `billingType` | `PERSONAL`, `CORPORATE` |
| `billingOrgId` | uuid, optional; **required** when `paymentMethod` is `CORPORATE` (zod `refine`) |
| `fareMinor`, `waitingFeeMinor` | int ≥ 0 (`fareMinor` already includes the waiting fee; `waitingFeeMinor` is not used). `fareMinor` is the full fare: commission, VAT and earnings are computed on it |
| `quoteId` | string ≤ 100, optional (not used here; pricing-service uses it) |
| `promoDiscountMinor` | int ≥ 0, optional (absent = 0); clamped to `fareMinor`. The rider pays `fareMinor − promoDiscountMinor`; the discount is booked to `PROMO_EXPENSE:{cityId}` (see [architecture.md](architecture.md#settlement)) |
| `currency` | 3 chars |
| `distanceMeters`, `durationSeconds` | number (not used) |
| `completedAt` | string; the commission rule and policy valid at this time apply |

| `trip.cancelled` field | Rule |
|---|---|
| `eventId`, `version`, `at` | as above |
| `tripId`, `riderId` | uuid |
| `driverId` | uuid, optional |
| `cityId` | 1–40 chars |
| `by` | `RIDER`, `DRIVER`, `SYSTEM`, `STAFF` (not used) |
| `reason` | string (not used) |
| `paymentMethod` | as above |
| `feeMinor`, `driverCompensationMinor` | int ≥ 0 |
| `beneficiary` | optional |
| `currency` | 3 chars |
| `billingOrgId` | uuid, optional; **required** when `paymentMethod` is `CORPORATE` |
| `quoteId` | string ≤ 100, optional (not used here) |

**Deduplication.** The handler's transaction starts with `INSERT INTO inbox (event_id, topic) … ON CONFLICT DO NOTHING`; a redelivered `eventId` does nothing. Settlement is also guarded by `trip_settlement (trip_id, purpose)` and the journal idempotency key, and `payment` is unique per `(trip_id, purpose)`.

**Errors and retries.**

- Invalid JSON or a zod failure: logged at error (`skipping invalid event` with topic, partition, offset) and skipped; the offset moves on. This includes a `CORPORATE` trip without `billingOrgId` ("CORPORATE payment without billingOrgId"), which is not settled at all rather than settled as cash. Test: `tests/unit/consumer.test.ts`.
- Any other error (database down, a bug): rethrown, so kafkajs doesn't commit the offset and retries with its default retry policy. There is no dead-letter topic in the code; a message that always fails blocks its partition.
- The charge for a digital trip starts after the transaction commits. If the process dies in between, the `charges` job picks up `PENDING` payments without a `provider_ref` after 10 s.

**Ordering.** Per partition (kafkajs `eachMessage`, one message at a time per partition). Both topics are keyed by `tripId`, so a trip's events stay in order.

**Without Kafka** (`KAFKA_BROKERS` unset, allowed outside production): neither the consumer nor the relay starts, so no trip is settled and outbox rows pile up (logged warning at start).

## Produced

All through the transactional outbox: `writeOutbox(tx, …)` inserts rows in `outbox` inside the transaction that moved the money, and the relay publishes them.

| Topic | Key | Payload type | Emitted when | Code |
|---|---|---|---|---|
| `trip.settled` | `tripId` | `TripSettledEvent` | a trip fare or cancellation fee is settled (any method, including via receivable) | `src/money/settlement.ts` |
| `payment.action_required` | `riderId` | `PaymentActionRequiredEvent` | a charge attempt was accepted by the provider (every attempt, so retries emit it again) | `payments.ts` `startCharge` |
| `payment.captured` | `riderId` | `PaymentOutcomeEvent` | the provider confirmed a charge | `payments.ts` `captured` |
| `payment.failed` | `riderId` | `PaymentOutcomeEvent` + `final`, `nextAttemptAt?` | a charge failed: `final: false` with `nextAttemptAt` when a retry is scheduled, `final: true` when it was settled as a receivable | `payments.ts` `failed` |
| `balance.state_changed` | beneficiary owner id | `BalanceStateChangedEvent` | the state of a balance changed after a posting, an overdue sweep, a policy change or a recompute | `balances.ts` `afterPosting` |
| `balance.topped_up` | beneficiary owner id | `BalanceMoneyEvent` (+ `channel`, `provider?`) | a top-up was credited | `topups.ts` `credit` |
| `balance.payment_due` | beneficiary owner id | `BalanceMoneyEvent` (+ `minimumMinor`, `dueAt`) | the settlement run created a due for a negative balance | `payouts.ts` `run` |
| `payout.sent` | beneficiary owner id | `BalanceMoneyEvent` (+ `provider`) | the provider confirmed a payout | `payouts.ts` `applyNotice` |
| `payout.failed` | beneficiary owner id | `BalanceMoneyEvent` (+ `provider`, `failure`) | a payout failed and was reversed | `payouts.ts` `failLine` |
| `refund.succeeded` | `riderId` | `RefundOutcomeEvent` | the provider confirmed a refund | `payments.ts` `refundDone` |
| `refund.failed` | `riderId` | `RefundOutcomeEvent` | the provider refused a refund | `payments.ts` `refundDone` |
| `balance.adjusted` | beneficiary owner id | `BalanceAdjustedEvent` | an adjustment was approved and posted | `adjustments.ts` `decide` |
| `balance.written_off` | beneficiary owner id | `BalanceWrittenOffEvent` | a write-off was approved and posted | `write-offs.ts` `decide` |
| `incentive.awarded` | beneficiary owner id | `IncentiveAwardedEvent` | a driver reached an incentive's target and was credited at period close | `incentives.ts` `close` |
| `invoice.issued` | `orgId` | `InvoiceEvent` | finance issued a company's monthly invoice | `invoices.ts` `issue` |
| `invoice.paid` | `orgId` | `InvoiceEvent` (+ `paidAt`) | the last bank payment made an invoice fully paid | `invoices.ts` `recordPayment` |
| `audit.recorded` | actor user id, or `system` | `AuditPayload` (`src/outbox/outbox.ts`) | a staff or owner action (list below) | modules |

Payload fields:

| Type | Fields |
|---|---|
| `TripSettledEvent` | `tripId`, `riderId`, `driverId?`, `beneficiary?`, `purpose` (`TRIP_FARE` \| `CANCELLATION_FEE`), `paymentMethod`, `fareMinor` (the fee for cancellations), `commissionMinor`, `vatMinor` (0 for fees), `earningsMinor` (what the balance moved by; negative on cash trips), `promoDiscountMinor?` (present when > 0: the promo discount booked to `PROMO_EXPENSE`; the rider paid `fareMinor −` it), `currency` |
| `PaymentActionRequiredEvent` | `paymentId`, `tripId`, `riderId`, `purpose`, `provider`, `amountMinor`, `currency`, `checkoutUrl` |
| `PaymentOutcomeEvent` | `paymentId`, `tripId`, `riderId`, `purpose`, `provider`, `method`, `amountMinor`, `currency`, `final?`, `nextAttemptAt?` |
| `BalanceStateChangedEvent` | `accountId`, `beneficiary`, `cityId`, `state`, `previousState`, `cashAllowed`, `balanceMinor` |
| `BalanceMoneyEvent` | `accountId`, `beneficiary`, `amountMinor`, `balanceMinor` (after the movement), `currency` (`ETB`), `channel?`, `provider?`, `minimumMinor?`, `dueAt?`, `failure?` |
| `RefundOutcomeEvent` | `refundId`, `paymentId`, `tripId`, `riderId`, `amountMinor`, `currency` |
| `BalanceAdjustedEvent` | `adjustmentId`, `accountId`, `beneficiary`, `direction` (`CREDIT` \| `DEBIT`), `amountMinor` (positive), `category`, `balanceMinor` (after), `currency`, `tripId?`, `ticketId?` |
| `BalanceWrittenOffEvent` | `writeOffId`, `accountId`, `beneficiary`, `amountMinor`, `balanceMinor` (after, normally 0), `currency` |
| `IncentiveAwardedEvent` | `awardId`, `programId`, `programName`, `cityId`, `driverId` (who drove), `accountId`, `beneficiary` (who is paid: the driver, or their fleet), `trips`, `amountMinor`, `balanceMinor`, `currency` |
| `InvoiceEvent` | `invoiceId`, `orgId`, `number`, `period` (YYYY-MM), `totalMinor`, `paidMinor`, `currency`, `dueAt`, `paidAt?` |
| `AuditPayload` | `actorId` (null for the scheduled run), `action`, `resource: { type, id }`, `outcome` (`EXECUTED` in every current call), `reason?`, `service: "payment-service"` |

`audit.recorded` actions: `payout_method:set`, `refund:request`, `refund:approve`, `refund:reject`, `topup:record_cash`, `topup:approve_cash`, `topup:reject_cash`, `payout:prepare`, `payout:approve`, `payout:reject`, `commission_rule:propose`, `commission_rule:approve`, `balance_policy:propose`, `balance_policy:approve`, `rule_change:reject`, `rule_change:cancel`, `adjustment:request`, `adjustment:approve`, `adjustment:reject`, `adjustment:cancel`, `writeoff:request`, `writeoff:approve`, `writeoff:reject`, `writeoff:cancel`, `policy_override:request`, `policy_override:approve`, `policy_override:reject`, `policy_override:cancel`, `policy_override:revoke`, `incentive:propose`, `incentive:approve`, `incentive:reject`, `incentive:cancel`, `incentive:close` (actor null), `invoice:issue`, `invoice:record_payment`.

### Who consumes them

Found by searching `services/` for the topic names:

| Topic | Consumer (group) | What it does |
|---|---|---|
| `trip.settled` | notification-service (`notification-service`) | receipt push to the rider (`src/notify/handlers.ts`) |
| `payment.action_required` | notification-service | "approve the payment" push |
| `payment.failed` | notification-service | failure push (`final` changes the text) |
| `refund.succeeded` | notification-service | refund push |
| `balance.state_changed` | location-service (`location-service`); notification-service | location: `applyBalanceState` updates `cashAllowed` / `balanceState` of every online car of the beneficiary (matching eligibility). notification: push to the owner |
| `balance.topped_up`, `balance.payment_due`, `payout.sent`, `payout.failed` | notification-service | pushes to the owner |
| `audit.recorded` | audit-service (`audit-service`) | stores the audit log |
| `payment.captured`, `refund.failed` | none found in code | |
| `balance.adjusted`, `balance.written_off`, `incentive.awarded`, `invoice.issued`, `invoice.paid` | none yet (added 2026-11; notification-service could tell the owner / the company's billing contact) | |

### The outbox relay

`src/outbox/relay.ts`, started by `src/server.ts` when `KAFKA_BROKERS` is set.

- kafkajs client id `payment-service-outbox`, idempotent producer, `maxInFlightRequests: 1`, `acks: -1` (all in-sync replicas).
- Every 500 ms: in one transaction, `SELECT … FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED`, send each row (`key` = row key, `value` = JSON payload) one at a time, then set `published_at`. A full batch of 100 loops immediately to drain bursts.
- On any error the transaction rolls back, the producer reconnects on the next tick, and the batch is resent. Rows sent before the failure are sent again, so delivery is **at least once**; consumers dedupe by `eventId`.
- `SKIP LOCKED` lets several replicas share the table. Order is by `created_at` within a batch; across replicas it is only roughly ordered.
- Published rows are never deleted by this service.
- The relay does not create topics; output topics must exist or be auto-created by the broker (not found in code).
- `GET /internal/ops/outbox` reports the backlog (`pending`, `oldestAt`).

## Live pushes (realtime-gateway)

`src/lib/realtime.ts`: a Socket.io Redis emitter (`@socket.io/redis-emitter`) on the service's Redis connection publishes to the channel realtime-gateway's Redis adapter listens to, addressed to room `user:{userId}`. No network call to the gateway. Without Redis, pushes are dropped (`noRealtime`).

| Socket event | To | Payload | When |
|---|---|---|---|
| `payment:action_required` | rider | `{ payment: PaymentView, instructions }` | charge attempt accepted by the provider |
| `payment:captured` | rider | `{ payment: PaymentView }` | charge confirmed |
| `payment:failed` | rider | `{ payment: PaymentView }` | charge failed (retry scheduled or final) |
| `balance:topped_up` | owner-driver (`INDIVIDUAL` only) | `{ topUp: TopUpView }` | mobile money top-up credited by callback or reconciliation (not office cash / bank approvals) |

These pushes happen after the transaction commits and are best effort.

## Redis pub/sub

| Channel | Direction | Purpose |
|---|---|---|
| `authz:changed` | subscribe (`libs/shared-authz/src/sync.ts`) | reload the permission matrix from auth-service |
| `settings:changed` | subscribe (`libs/shared-settings/src/client.ts`) | reload live settings from platform-service |
| Socket.io emitter channel | publish | realtime pushes (above) |

Both subscriptions also poll every 30 s as a backstop. Redis keys used by the service are listed in [data-model.md](data-model.md#redis-keys).
