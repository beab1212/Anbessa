# HTTP API

Every route is registered in `src/app.ts` (health) and `src/http/routes.ts` (everything else). Paths are the full paths the service sees; Kong forwards `/api/payments/*` unchanged (`strip_path: false`) and never routes `/internal/*`.

## Conventions

**Authentication.** Unless a route says otherwise it needs `Authorization: Bearer <access token>` from auth-service. A `ride-app` (phone app) or `ride-admin` (web staff / partner) token is accepted on every route; the permission checks decide. See [architecture.md](architecture.md#security-model).

**Amounts** are integers in santim (`…Minor`, 1 ETB = 100). Currency is ETB.

**Common validators** (`src/http/routes.ts`):

| Name | Rule |
|---|---|
| `uuid` | `z.string().uuid()` |
| `cityId` | `^[a-z0-9-]{1,40}$` |
| `money` | integer, > 0, ≤ 100 000 000 |
| `reason` | trimmed string, 5–500 characters |

**Errors** (`src/middlewares/error-handler.ts`): JSON `{ "error": "<code>", "message": "..." }`.

| Status | `error` | When |
|---|---|---|
| 400 | `validation_error` (+ `issues: [{path, message}]`) | zod validation of params, query or body failed |
| 400 | route-specific (below) or `bad_request` | business rule |
| 401 | `unauthorized` | no bearer token, or bad service token on `/internal/*` |
| 401 | `invalid_token`, `token_revoked`, `token_outdated` | token rejected (expired / wrong audience, user suspended, roles changed) |
| 403 | `forbidden` | missing permission (`AuthorizationError`, message `missing permission <perm> for this resource`) or a module's `forbidden()` |
| 403 | `maker_checker` | the same person tried to approve what they created |
| 404 | `not_found` | unknown id, unknown route, or a balance the caller may not read |
| 409 | `invalid_state`, `conflict`, … | the resource is in the wrong state, or a decision raced another |
| 422 | `idempotency_mismatch` | `Idempotency-Key` reused with a different request |
| 429 | (from `@fastify/rate-limit`) | rate limit hit |
| 503 | `auth_unavailable` | Redis deny-list / permission-version lookup failed (`TokenCheckUnavailable`); sent with `retry-after: 5`, logged warn `token check unavailable (Redis)`. The token is refused, retry later |
| 500 | `internal_error` | anything else (details only in the log) |
| 502 | `provider_unavailable` | refund approval: the provider didn't answer |

**Rate limits.** Global: 300 requests per minute per client IP (`@fastify/rate-limit` in `src/app.ts`; `trustProxy: true`). Overrides: webhooks 600/min; `GET /internal/balances/state` unlimited. In front of that, Kong limits the whole service to 120/min per client and 64 KB bodies (`infra/kong/kong.yml`). The service's own JSON body limit is 32 KB.

### Idempotency

These POST routes accept an `Idempotency-Key` header (`src/lib/idempotency.ts`): `POST balances/:accountId/top-ups`, `POST payments/:id/pay`, `POST payments/:id/refunds`, `POST top-ups/manual`, and the money controls' `POST adjustments`, `POST write-offs`, `POST policy-overrides`, `POST incentives`, `POST invoices`, `POST invoices/:id/payments`.

- The key must match `^[A-Za-z0-9_-]{8,100}$` (else 400 `bad_request`). It is scoped per user (`idempotency_key` PK `(user_id, key)`).
- The request hash is SHA-256 of `{ url, body }`.
- First request: does the work, stores the status code and body. Retry with the same key and request: gets the stored response. Same key while the first is still running: 409 `request_in_progress`. Same key, different request: 422 `idempotency_mismatch`. A request that throws releases the key.
- Keys are purged 24 h after creation (daily job in `src/server.ts`).
- Without the header the route runs normally (no deduplication beyond the domain checks).

### Response objects

`PaymentView` (`paymentView` in `src/money/payments.ts`):

| Field | Type | Notes |
|---|---|---|
| `id`, `tripId`, `riderId` | uuid | |
| `purpose` | `TRIP_FARE` \| `CANCELLATION_FEE` | |
| `cityId` | string | |
| `method` | `MOBILE_MONEY` \| `CARD` | |
| `provider` | string | `none` while no provider is enabled |
| `amountMinor`, `refundedMinor` | int | |
| `currency` | string | |
| `status` | `PENDING`, `ACTION_REQUIRED`, `RETRY_SCHEDULED`, `SUCCEEDED`, `FAILED`, `PARTIALLY_REFUNDED`, `REFUNDED` | |
| `checkoutUrl` | string \| null | only while `ACTION_REQUIRED` |
| `attempts` | int | |
| `nextAttemptAt`, `createdAt`, `updatedAt`, `completedAt` | ISO date \| null | |
| `lastError` | string \| null | |
| `settledAsReceivable` | bool | |
| `refunds` | `RefundView[]` | only on `GET payments/:id` and `GET trips/:tripId` |

`RefundView`: `id`, `paymentId`, `amountMinor`, `reason`, `driverAtFault`, `status` (`PENDING_APPROVAL`, `PROCESSING`, `SUCCEEDED`, `FAILED`, `REJECTED`), `requestedBy`, `approvedBy`, `decisionReason`, `failure`, `createdAt`, `decidedAt`, `completedAt`.

`TopUpView` (`topUpView` in `src/money/topups.ts`): `id`, `accountId`, `channel` (`MOBILE_MONEY`, `OFFICE_CASH`, `BANK_TRANSFER`), `provider`, `amountMinor`, `status` (`PENDING`, `ACTION_REQUIRED`, `SUCCEEDED`, `FAILED`, `PENDING_APPROVAL`, `REJECTED`), `checkoutUrl` (only while `ACTION_REQUIRED`), `receiptNo`, `note`, `failure`, `createdBy`, `approvedBy`, `createdAt`, `completedAt`.

`BalanceView` (`balanceView` in `src/money/balances.ts`):

| Field | Type | Notes |
|---|---|---|
| `accountId` | uuid \| null | null in the empty view (no account yet) |
| `beneficiary` | `{ type: INDIVIDUAL \| ORGANIZATION, id }` | |
| `cityId` | string | |
| `balanceMinor` | int | positive: owed to the beneficiary |
| `currency` | string | |
| `state` | `OK`, `WARNING`, `CASH_BLOCKED`, `BLOCKED` | |
| `cashAllowed` | bool | `OK` or `WARNING` |
| `stateChangedAt`, `overdueSince` | ISO date \| null | |
| `referenceCode` | string \| null | `ANB-XXXXXX`, quoted on bank transfers and office cash |
| `payoutMethod` | `{ provider, destination }` \| null | destination masked `•••1234` |
| `suggestedTopUpMinor` | int | amount (rounded up to whole ETB) to reach `warningMinor` (postpaid) or `prepaidMinimumMinor` (prepaid) |
| `policy` | `{ mode, warningMinor, cashLimitMinor, hardLimitMinor, prepaidMinimumMinor, minPayoutMinor, dueDays, builtIn }` | `builtIn` true when no approved policy exists |
| `dues` | `[{ id, cycleEnd (YYYY-MM-DD), amountMinor, minimumMinor, paidMinor, dueAt, status }]` | latest 5 |

`BatchView` (`batchView` in `src/money/payouts.ts`): `id`, `cycleEnd` (YYYY-MM-DD), `status` (`PENDING_APPROVAL`, `SENDING`, `COMPLETED`, `REJECTED`), `preparedBy`, `approvedBy`, `rejectReason`, `totalMinor`, `lineCount`, `duesCreated`, `createdAt`, `decidedAt`, and on `GET payouts/:id` and decisions `lines: [{ id, accountId, amountMinor, provider, destination (masked), status (PENDING, SENT, SUCCEEDED, FAILED, SKIPPED), failure, updatedAt, beneficiary {type, id}, referenceCode }]`.

`ChangeView` (`changeView` in `src/money/rule-changes.ts`): `id`, `kind`, `cityId`, `payload`, `reason`, `makerId`, `checkerId`, `status` (`PENDING`, `EXECUTED`, `REJECTED`, `CANCELLED`, `EXPIRED`), `decisionReason`, `createdAt`, `decidedAt`, `expiresAt`.

---

## Health

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/health` | none | `{ status: "ok" }` (Docker `HEALTHCHECK`) |
| GET | `/health/live` | none | `{ status: "ok" }` |
| GET | `/health/ready` | none | `SELECT 1` on Postgres: `{ status: "ok", gateways: [{ provider, mode }] }`, or 503 `{ status: "unavailable" }`. Doesn't check Redis or Kafka |

All three count against the global rate limit.

---

## Public (no token)

### GET /api/payments/methods

What the apps offer at checkout.

| Query | Type | Notes |
|---|---|---|
| `cityId` | `cityId`, optional | resolves the per-city override of `payments.methods` |

200 `{ methods: string[], providers: [{ provider, label, methods: ("MOBILE_MONEY"\|"CARD")[], mode: "simulated" }] }`. `methods` is the platform-service setting `payments.methods`; `providers` are the enabled gateways (`PAYMENT_PROVIDERS`). Header `cache-control: public, max-age=30`.

### POST /api/payments/webhooks/:provider

Provider callbacks. No token: each provider's signature is the authentication (see [integrations.md](integrations.md#payment-providers)).

- Registered in its own Fastify scope with every content type read as a raw string (limit 64 KB), so the signature is checked over the exact bytes.
- Rate limit 600/min.
- `provider` param: string ≤ 30.

| Status | Body | When |
|---|---|---|
| 200 | `{ received: true, outcome }` | processed; `outcome` is what the handler did (below) |
| 200 | `{ received: true, duplicate: true, outcome? }` | the same `(provider, eventKey)` was already processed |
| 401 | `{ received: false, error: "invalid signature" }` | the parser threw `WebhookRejected` (bad signature, not JSON, incomplete). The callback is stored with `signature_ok = false` |
| 404 | `{ received: false, error: "unknown provider" }` | provider not enabled |
| 500 | `{ error: "internal_error" }` | the handler threw (e.g. database down). The `webhook_event` row stays unprocessed, so the provider's redelivery is processed |

Outcomes (`src/money/webhooks.ts` routes by our reference `ANB{P|T|O|R}…`):

| Reference kind | Outcomes |
|---|---|
| payment (`ANBP`) | `captured`, `duplicate`, `second_capture`, `failed`, `stale_attempt`, `pending`, `amount_mismatch`, `unknown_payment`, `unknown_reference` |
| top-up (`ANBT`) | `credited`, `duplicate`, `failed`, `pending`, `amount_mismatch`, `unknown_top_up`, `unknown_reference` |
| payout (`ANBO`) | `paid_out`, `payout_failed`, `duplicate`, `ignored_<status>`, `pending`, `unknown_payout`, `unknown_reference` |
| refund (`ANBR`) | `refunded`, `refund_failed`, `duplicate`, `pending`, `unknown_refund`, `unknown_reference` |

### GET /api/payments/sim/checkout/:ref and POST /api/payments/sim/checkout/:ref

The simulator's hosted checkout page. **Registered only when `GATEWAY_MODE=simulated` and `NODE_ENV≠production`.** No token.

- `ref`: string ≤ 60 (the simulator's provider ref, e.g. `TBPRE…`, `CBE-…`, `CHK…`).
- GET: HTML page (`text/html`, `cache-control: no-store`) for a charge; 404 if the ref is unknown or not a charge.
- POST: form body `decision=approve|decline|insufficient` (400 `bad_request` "choose approve or decline" otherwise). Decides the operation (`insufficient` fails with "insufficient funds", `decline` with "declined by the payer"), which sends the signed callback; then 303 redirect back to the GET page. 404 if unknown.

---

## Drivers and fleet owners

### GET /api/payments/earnings/me

The driver's earnings summary (`src/money/earnings.ts`). Permission `earnings:read` @ SELF.

| Query | Type | Default | Notes |
|---|---|---|---|
| `period` | `today` \| `week` \| `month` \| `custom` | `today` | Addis Ababa days; week is Monday–Sunday |
| `from`, `to` | `YYYY-MM-DD` | — | required for `custom`; range 1–92 days inclusive, else 400 `invalid_range` |

200 `{ from, to (ISO), trips, cancellations, grossMinor, commissionMinor, vatMinor, netMinor, balanceChangeMinor, cashCollectedMinor, byDay: [{ day, trips, grossMinor, netMinor }] }`. See [architecture.md](architecture.md#driver-earnings-summary) for how each total is computed.

### GET /api/payments/earnings/org/:orgId

A fleet's earnings: settlements whose beneficiary is the fleet organisation (its cars, whoever drove them). `earnings` module in `src/money/earnings.ts`, same arithmetic as `earnings/me` (on cash trips `netMinor` is fare − commission − VAT, not the balance debt).

| | |
|---|---|
| Who | `earnings:read` covering `{ orgId }` (FLEET_OWNER of that org), or `report:read_finance` (finance, auditor). Anyone else (another org, FLEET_DRIVER, CORPORATE_ADMIN, drivers, city staff) → 403 `forbidden` |
| Params | `orgId`: uuid |
| Query | `period`, `from`, `to` as for `earnings/me` |

200 `{ orgId, from, to, trips, cancellations, grossMinor, commissionMinor, vatMinor, netMinor, balanceChangeMinor, cashCollectedMinor, byDay: [{ day, trips, grossMinor, netMinor }], byDriver: [{ driverId, trips, grossMinor, netMinor }] }`. `byDriver` is sorted by gross, largest first. A fleet with no balance account yet answers zeros. 400 `invalid_range` as for `earnings/me`.

### GET /api/payments/balances/me

The caller's own (`INDIVIDUAL`) balance.

| Query | Type | Default |
|---|---|---|
| `cityId` | `cityId` | `addis-ababa` |
| `open` | `true` / `false` / `1` / `0` | `false` |

Permission: `balance:read` covering `{ ownerUserIds: [caller] }` (DRIVER). With `open=true` and no account yet, it is created (needs `topup:create` too) so the driver can top up before a first trip; the account's city is `cityId`. 200 `BalanceView` (the empty view with `accountId: null` if there is no account and `open` is false). 404 if the caller may not read it.

`open` is parsed by `queryFlag` in `src/http/routes.ts`: `"true"` or `"1"` is on, `"false"` or `"0"` (or no value) is off, anything else is `400 validation_error`. So `open=false` creates nothing (fixed 2026-10-27: it used `z.coerce.boolean()`, which read `"false"` as true). Test: `tests/integration/payments.test.ts`.

### GET /api/payments/balances/org/:orgId

A fleet company's balance. Same query and response as `balances/me`; permission `balance:read` covering `{ orgId, cityId }` (FLEET_OWNER of that org, or staff with the permission in that city). `open=true` creates the account with `topup:create` @ ORG.

### GET /api/payments/balances/:accountId

One balance by account id. Permission `balance:read` on the balance's owner scope; otherwise 404. 200 `BalanceView`.

### GET /api/payments/balances/:accountId/statement

Postings on the balance, newest first.

| Query | Type | Default |
|---|---|---|
| `before` | date (coerced) | — |
| `limit` | int 1–100 | 30 |

200 `{ entries: [{ id, at, amountMinor, kind, memo, reference: { type, id }, entryId }], next: ISO | null }`. `next` is the last row's `createdAt`; pass it as `before` for the next page. Postings with the same timestamp as `before` are skipped (strict `<`).

### GET /api/payments/balances/:accountId/top-ups

The 20 latest top-ups of the balance. Permission `balance:read` on the balance. 200 `{ topUps: TopUpView[] }`. 404 if no such balance.

### POST /api/payments/balances/:accountId/top-ups

Top up by mobile money. Idempotent with `Idempotency-Key`.

| Body | Type |
|---|---|
| `amountMinor` | `money`; the module also requires 1 000–10 000 000 |
| `provider` | string 1–30; must be an enabled `MOBILE_MONEY` provider |

Permission: `balance:read` and `topup:create` on the balance (owner-driver @ SELF, fleet owner @ ORG). The charge starts in the request.

| Status | Body / error |
|---|---|
| 201 | `TopUpView` + `instructions` (string for the payer, or null if the provider was unreachable; the top-up is then `FAILED`) |
| 400 | `unknown_provider`, `amount_out_of_range` |
| 404 | balance not found or not readable |

### PUT /api/payments/balances/:accountId/payout-method

Where payouts go.

| Body | Type | Notes |
|---|---|---|
| `provider` | string 1–30 | must be an enabled gateway (any method) |
| `destination` | string 6–30 | spaces and dashes removed, then `^\+?\d{6,20}$` |

Permission as for top-ups (owner). 200 `BalanceView`. 400 `unknown_provider`, `invalid_destination`. Writes `audit.recorded` (`payout_method:set`).

### GET /api/payments/top-ups/:id

One top-up. Permission `balance:read` on its balance. 200 `TopUpView`; 404.

---

## Riders

### GET /api/payments/trips/:tripId

Payments and settlements of a trip.

200 `{ payments: PaymentView[], settlements: [{ purpose, paymentMethod, fareMinor, commissionMinor, vatMinor, earningsMinor, promoDiscountMinor, commissionRuleId, settledAt, beneficiaryAccountId }] }` (`fareMinor` is the full fare; `promoDiscountMinor` is the rider's promo discount paid by the platform, 0 = none; the TRIP_FARE payment's `amountMinor` is `fareMinor − promoDiscountMinor`).

- `payments` are filtered by `canSeePayment`: a `ride-app` caller sees only payments where they are the rider (`payment:read` @ SELF); staff see them with `balance:read`, `trip:read`, `refund:request` or `refund:approve` in the payment's city.
- `settlements` are returned to `ride-admin` callers, and to the driver of the trip; riders get none.
- No permission is required to call it: an unrelated caller gets empty lists.

### POST /api/payments/payments/:id/pay

Pay now instead of waiting for the next retry, or pay a payment that ended as a receivable. Idempotent with `Idempotency-Key`. Only the payment's rider (`payment:read` @ SELF); anyone else gets 404.

| Payment status | Effect |
|---|---|
| `ACTION_REQUIRED` | returned unchanged (the prompt is still open) |
| `RETRY_SCHEDULED` | a new attempt starts now |
| `FAILED` | set back to `RETRY_SCHEDULED`, then a new attempt starts |
| anything else | 409 `invalid_state` ("the payment is succeeded", …) |

200 `PaymentView`.

### GET /api/payments/me/preferences

200 `{ mobileMoneyProvider: string | null }`. Any signed-in user.

### PUT /api/payments/me/preferences

Body `{ mobileMoneyProvider: string 1–30 }`; must be an enabled `MOBILE_MONEY` provider (400 `unknown_provider`). 200 `{ mobileMoneyProvider }`. Any signed-in user.

### GET /api/payments/org/:orgId/payments

What corporate-billed trips and cancellation fees cost a company: the postings on its `CORPORATE_RECEIVABLE:{orgId}` account (`src/money/reports.ts`), newest first.

| | |
|---|---|
| Who | `payment:read` covering `{ orgId }` (CORPORATE_ADMIN of that org), or `report:read_finance`. Others (another org, coordinators, employees, riders, city staff) → 403 |
| Query | `before`: the `next` cursor of a previous page (else 400 `invalid_cursor`); `limit` int 1–100, default 50 |

200 `{ orgId, owedMinor, charges: OrgCharge[], next }`:

- `owedMinor`: what the company owes now (minus the receivable's balance; 0 for a company never billed, which has no account).
- `OrgCharge`: `{ id (posting id), at, kind (journal entry kind: TRIP_SETTLEMENT, CANCELLATION_FEE, …), memo, tripId | null, purpose (TRIP_FARE | CANCELLATION_FEE | null), amountMinor (positive = charged to the company), riderId, cityId, vehicleType }` (the last three from `trip_settlement`, null if there is none).
- `next`: `<created_at in microseconds>_<posting id>` when the page is full, else null. Paging is on `(created_at, id)`, so postings in the same millisecond are neither skipped nor repeated.

---

## Finance and support: overview and balances

### GET /api/payments/overview

What the platform holds, is owed and owes. Permission: `balance:read` or `report:read_finance` everywhere (`G`), else `report:read_finance` with no scope (403).

200:

| Field | Content |
|---|---|
| `accounts` | per ledger account kind: `{ positiveMinor, negativeMinor, count }` |
| `providers` | `[{ provider, balanceMinor }]` from `PROVIDER_CLEARING:*` (includes `bank`) |
| `states` | beneficiary count per state |
| `payments` | per status: `{ count, amountMinor }` |
| `topUps`, `refunds` | count per status |
| `openBatches` | `PENDING_APPROVAL` / `SENDING` batches: `{ id, status, totalMinor, cycleEnd }` |
| `last7Days` | `{ fareMinor, commissionMinor, vatMinor, tripsByMethod }` over trip settlements |

### GET /api/payments/ledger/integrity

Permission: `report:read_finance` or `system:read` everywhere, else 403. 200 `{ ok, totalMinor, accounts, entries, mismatched: [{ code, cachedMinor, actualMinor }] }` (at most 50 mismatches). `ok` is true when nothing mismatches and the total is 0.

### GET /api/payments/balances

Finance list, most negative first.

| Query | Type | Default |
|---|---|---|
| `state` | `OK` \| `WARNING` \| `CASH_BLOCKED` \| `BLOCKED` | — |
| `cityId` | `cityId` | — |
| `type` | `INDIVIDUAL` \| `ORGANIZATION` | — |
| `q` | string ≤ 60 | matched against the reference code (contains, upper-cased), or equal to the owner id / account id if it looks like a UUID |
| `limit` | int 1–100 | 50 |
| `offset` | int ≥ 0 | 0 |

Permission: `balance:read` in some city or everywhere; results limited to those cities; a `cityId` outside them → 403. 200 `{ total, balances: [{ accountId, beneficiary, cityId, balanceMinor, state, cashAllowed, referenceCode, overdueSince, payoutReady }] }`.

### GET /api/payments/reports/daily

Finance's money per Addis Ababa day (`src/money/reports.ts`, SQL aggregates).

| Query | Type | Default |
|---|---|---|
| `cityId` | `cityId`, optional | every city |
| `from`, `to` | `YYYY-MM-DD`, inclusive, 1–92 days (else 400 `invalid_range`) | `to` = today (Addis), `from` = `to` − 6 days |

Permission `report:read_finance` (FINANCE_OFFICER, FINANCE_MANAGER, AUDITOR; `G`), else 403.

200 `{ cityId | null, from, to, days: FinanceDay[], totals }`, every day present (zero-filled), oldest first. `FinanceDay`:

| Field | Source and day |
|---|---|
| `date` | `YYYY-MM-DD` |
| `trips`, `fareMinor`, `vatMinor` | `TRIP_FARE` settlements, by `settled_at` |
| `commissionMinor` | trip commission **plus** the platform's share of cancellation fees |
| `earningsMinor` | Σ `earnings_minor` of all settlements (what beneficiaries' balances moved by) |
| `byMethod` | `{ CASH|MOBILE_MONEY|CARD|CORPORATE: { trips, fareMinor, commissionMinor, vatMinor } }` (trip fares only) |
| `cancellationFees` | `{ count, feeMinor, commissionMinor }` from `CANCELLATION_FEE` settlements |
| `collections` | `{ MOBILE_MONEY|CARD: { count, amountMinor } }`: rider payments captured by a provider (status `SUCCEEDED`, `PARTIALLY_REFUNDED`, `REFUNDED`), by `completed_at` |
| `refunds` | `{ count, amountMinor }`: `SUCCEEDED` refunds by `completed_at`; city = the payment's |
| `payouts` | `{ count, amountMinor }`: `SUCCEEDED` payout lines by `updated_at`; city = the beneficiary's |
| `topUps` | `{ MOBILE_MONEY|OFFICE_CASH|BANK_TRANSFER: { count, amountMinor } }`: `SUCCEEDED` top-ups by `completed_at`; city = the beneficiary's |

`totals` has the same fields without `date`.

### GET /api/payments/reports/daily.csv

Same query, permission and data. 200 `text/csv; charset=utf-8`, `content-disposition: attachment; filename="payments-<cityId|all>-<from>-<to>.csv"`, `cache-control: no-store`. CRLF lines: header, one row per day, a `total` row. Columns: `date, trips, fare_minor, commission_minor, vat_minor, earnings_minor`, `<method>_trips/_fare_minor/_commission_minor` (cash, mobile_money, card, corporate), `cancellation_fees, cancellation_fee_minor, cancellation_commission_minor`, `collected_<method>_count/_minor` (mobile_money, card), `refunds, refund_minor, payouts, payout_minor`, `topup_<channel>_count/_minor` (mobile_money, office_cash, bank_transfer). Methods or channels outside these lists get their own columns when they occur.

---

## Finance and support: payments and refunds

Staff list routes use `cityFilter`: the union of cities where the caller has `balance:read`, `report:read_finance`, `refund:approve` or `refund:request` (any of them everywhere → no filter; none → 403 `forbidden`).

### GET /api/payments/payments

| Query | Type | Default |
|---|---|---|
| `status` | string ≤ 30 | — |
| `provider` | string ≤ 30 | — |
| `tripId` | uuid | — |
| `cityId` | city id | — |
| `before` | date | — |
| `limit` | int 1–100 | 50 |

200 `{ payments: PaymentView[], next: ISO | null }` (newest first; `next` is the last `createdAt`). With `cityId`, only that city; it must be one of the caller's `cityFilter` cities (or the caller holds a permission everywhere), else 403 `forbidden` (`missing permission balance:read`): a city outside reach is refused, not emptied.

### GET /api/payments/payments/:id

200 `PaymentView` with `refunds`. 404 if missing or not visible to the caller (`canSeePayment`).

### POST /api/payments/payments/:id/reconcile

Ask the provider about the payment now. Permission `commission:collect` (no scope). If the payment is `ACTION_REQUIRED` or `PENDING`, the provider is queried for the current attempt and the answer applied. 200 `PaymentView`; 404.

### POST /api/payments/payments/:id/refunds

Request a refund. Idempotent with `Idempotency-Key`.

| Body | Type | Default |
|---|---|---|
| `amountMinor` | `money` | — |
| `reason` | `reason` (5–500) | — |
| `driverAtFault` | boolean | `false` |

Permission `refund:request` @ the payment's city. 201 `RefundView` (`PENDING_APPROVAL`). 404 payment not found; 409 `invalid_state` unless `SUCCEEDED` or `PARTIALLY_REFUNDED`; 400 `refund_too_large` if more than what's left after earlier and pending refunds. Writes `audit.recorded`.

### GET /api/payments/refunds

Query `status` (one of the refund statuses), optional. `cityFilter` on the payment's city. 200 `{ refunds: (RefundView & { payment: PaymentView })[] }`, newest 100.

### POST /api/payments/refunds/:id/approve and /reject

`:decision` is `approve` or `reject`. Body `{ reason?: string ≤ 500 }` (required to reject).

Permission `refund:approve` @ the payment's city; the requester can't decide (403 `maker_checker`).

| Status | When |
|---|---|
| 200 `RefundView` | rejected (`REJECTED`) or approved (`PROCESSING`, then `SUCCEEDED`/`FAILED` if the provider answered at once; the simulator does) |
| 400 `reason_required` | reject without a reason |
| 404 | refund not found |
| 409 `invalid_state` | already decided |
| 502 `provider_unavailable` | approved, but the provider call failed; the refund stays `PROCESSING` |

---

## Finance: office cash and bank transfers

### POST /api/payments/top-ups/manual

Record a top-up (maker). Idempotent with `Idempotency-Key`. Permission `topup:record_cash` (no scope: FINANCE_OFFICER).

| Body | Type | Notes |
|---|---|---|
| `accountId` | uuid, optional | exactly one of `accountId` / `referenceCode` |
| `referenceCode` | string ≤ 20, optional | case-insensitive |
| `channel` | `OFFICE_CASH` \| `BANK_TRANSFER` | |
| `amountMinor` | `money` | module: 100–10 000 000 |
| `receiptNo` | string 3–60 | office receipt or bank transaction id |
| `note` | string ≤ 300, optional | |

201 `TopUpView` (`PENDING_APPROVAL`). 404 balance not found; 400 `amount_out_of_range`; 409 `duplicate_receipt` if a non-rejected top-up with the same channel and receipt number exists. Writes `audit.recorded`.

### GET /api/payments/top-ups

Query `status`, `channel` (strings ≤ 30), `cityId` (optional). Visible cities: the union of cities where the caller holds `topup:record_cash`, `topup:approve_cash` or `balance:read` (any of them everywhere → no filter; none → 403). A top-up has no city of its own: it belongs to the city of the balance it credits (`beneficiary.city_id` of its `beneficiaryAccountId`). `cityId` narrows to one city and must be within reach, else 403 `forbidden`. 200 `{ topUps: TopUpView[] }`, newest 100. Code: `list()` in `src/money/topups.ts`.

### POST /api/payments/top-ups/:id/approve and /reject

Body `{ reason?: string ≤ 500 }`. Permission `topup:approve_cash` (FINANCE_MANAGER); the recorder can't decide (403 `maker_checker`). Approval credits the balance (`TOP_UP` from `CASH_RECEIPTS:{city}` or `PROVIDER_CLEARING:bank`) and writes `balance.topped_up`. 200 `TopUpView`; 404; 409 `invalid_state` if not `PENDING_APPROVAL`.

---

## Finance: settlement and payouts

### POST /api/payments/settlements/run

Prepare today's settlement batch ("run now"). Permission `payout:prepare`. 201 `{ batch: BatchView, created: true }` when a batch was created; 200 `{ batch, created: false }` if one already exists for today's Addis date. No body.

### GET /api/payments/payouts

Permission: `payout:approve` or `report:read_finance`, else `payout:prepare` (no scope). 200 `{ batches: BatchView[] }` (latest 30 by `cycleEnd`, without lines).

### GET /api/payments/payouts/:id

Same permission. 200 `BatchView` with `lines` (largest first). 404.

### POST /api/payments/payouts/:id/approve and /reject

Body `{ reason?: string ≤ 500 }`. Permission `payout:approve`; the preparer can't decide (403 `maker_checker`). 409 `invalid_state` if not `PENDING_APPROVAL`. Approval sends every pending line within the request; rejection marks pending lines `SKIPPED` (`rejectReason` defaults to `rejected`). 200 `BatchView` with lines.

---

## Commission rules and balance policies

### GET /api/payments/rules?cityId=

`cityId` required. Permission: any of `commission_rule:propose`, `commission_rule:approve`, `balance_policy:propose`, `balance_policy:approve`, `balance:read`, `commission:read` @ the city.

200 `{ cityId, defaults: { rule, policy }, policy (in force, + builtIn), rules: [... + cityId, vehicleType, beneficiaryId, validFrom, validTo, proposedBy, approvedBy, inForce] (latest 50), policies (latest 20), changes: ChangeView[] (latest 30) }`.

### GET /api/payments/rules/pending

200 `{ changes: ChangeView[] }`: `PENDING` changes in the cities where the caller can propose or approve rules or policies; an empty list (not 403) for anyone else.

### POST /api/payments/rules/changes

Propose a change. 202 `ChangeView`. Body, discriminated by `kind`:

| Field | Type |
|---|---|
| `kind` | `COMMISSION_RULE` \| `BALANCE_POLICY` |
| `cityId` | `cityId` |
| `reason` | `reason` (5–500) |
| `payload` | below |

`COMMISSION_RULE` payload (permission `commission_rule:propose` @ city):

| Field | Type | Default |
|---|---|---|
| `vehicleType` | `^[a-z0-9_]{1,30}$` \| null | null (all types) |
| `beneficiaryId` | uuid \| null | null (a contract rule for one driver / fleet) |
| `model` | `PERCENT` \| `FIXED_PER_TRIP` \| `ZERO` | — |
| `rateBp` | int 0–10 000 \| null | null; required for `PERCENT` |
| `fixedMinor` | int 0–100 000 000 \| null | null; required for `FIXED_PER_TRIP` |
| `minMinor`, `maxMinor` | int 0–100 000 000 \| null | null; max ≥ min |
| `validFrom` | ISO datetime \| null | null (now at approval) |

`BALANCE_POLICY` payload (permission `balance_policy:propose` @ city):

| Field | Type |
|---|---|
| `mode` | `POSTPAID` \| `PREPAID` |
| `warningMinor`, `cashLimitMinor`, `hardLimitMinor` | int ≤ 0, and hard ≤ cash ≤ warning |
| `prepaidMinimumMinor` | int ≥ 0 |
| `dueDays` | int 1–30 |
| `minPaymentBp` | int 0–10 000 |
| `minPayoutMinor` | int ≥ 0 |
| `taxBasis` | `COMMISSION` \| `FULL_FARE` |
| `vatRateBp` | int 0–10 000 |
| `validFrom` | ISO datetime \| null (default null) |

400 `invalid_rule` when `validateRule` / `validatePolicy` refuse it. Writes `audit.recorded`. The proposal expires in 7 days.

### POST /api/payments/rules/changes/:id/approve | reject | cancel

Body `{ reason?: string ≤ 500 }`.

| Decision | Who | Errors |
|---|---|---|
| `approve` | `commission_rule:approve` / `balance_policy:approve` @ city, not the maker | 403 `maker_checker`; 409 `rule_scheduled` / `policy_scheduled` (a later version exists / same start time) |
| `reject` | same | 400 `reason_required` |
| `cancel` | the maker only | 403 `forbidden` |

All: 404 unknown; 409 `invalid_state` if not `PENDING`; 409 `expired` (and the change becomes `EXPIRED`) past `expiresAt`. 200 `ChangeView`. Approving a balance policy recomputes every balance state in the city before answering.

---

## Providers

### GET /api/payments/gateways

The payment providers page. Permission (`assertFinanceView`): a `ride-admin` token with any of `balance:read`, `report:read_finance`, `payout:prepare`, `payout:approve`, `refund:approve`, `topup:record_cash`, `topup:approve_cash`, `system:read` (unscoped), else `balance:read` unscoped.

200 `{ providers: [{ provider, label, methods, mode }], simulator: { autoApproveSeconds, payoutSeconds, dropWebhooks } | null, webhooks: { last24h: [{ provider, signatureOk, count }], unprocessed }, recent: [{ id, provider, eventKey, signatureOk, outcome, receivedAt, processedAt }] (30) }`. `unprocessed` counts signed callbacks still unprocessed after 60 s.

---

## Internal (service token)

All `/internal/*` routes need `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` (constant-time comparison; 401 `unauthorized` "invalid service credentials" otherwise). Not routed by Kong.

### GET /internal/balances/state

Called by fleet-service when a driver starts a session. No rate limit.

| Query | Type |
|---|---|
| `type` | `INDIVIDUAL` \| `ORGANIZATION` |
| `ownerId` | uuid |

200 `{ state, cashAllowed, balanceMinor, known }`. An unknown beneficiary answers `{ state: "OK", cashAllowed: true, balanceMinor: 0, known: false }`.

### GET /internal/ops/outbox

platform-service system page. 200 `{ pending: int, oldestAt: ISO | null }` for unpublished outbox rows.

### GET /internal/ops/integrations

platform-service system page. 200 `{ mode, providers: [{ provider, label, methods, openCharges, callbacks24h, rejected24h }], unprocessedCallbacks }`. `openCharges` counts payments in `ACTION_REQUIRED`, `RETRY_SCHEDULED` or `PENDING`.

## Money controls (adjustments, write-offs, overrides, incentives)

Maker–checker requests (see [architecture.md](architecture.md#money-controls-adjustments-write-offs-overrides-incentives-invoices)). Common rules:

- Request routes accept `Idempotency-Key` and answer `201` with the request (`status: "PENDING_APPROVAL"`, `expiresAt` = +7 days).
- A request names the balance by `accountId` **or** `referenceCode` (`ANB-…`, any case), never both (`400 validation_error`); an unknown balance is `404 not_found`.
- `POST …/:id/approve | reject | cancel` with optional `{ reason }` (≤ 500 chars). `reject` needs a reason (`400 reason_required`). `cancel` is the requester's own withdrawal (anyone else `403`). The requester can't approve or reject (`403 maker_checker`). Not pending → `409 invalid_state`; past `expiresAt` → `409 expired`; raced by another decider → `409 invalid_state`. The answer is the updated request.
- Lists return the newest 100 in the cities the caller may see (`?cityId=` outside them → `403`); `?status=` filters.
- Rows about a balance carry `beneficiary { type, id }`, `referenceCode`, the current `balanceMinor` and `state`.

### GET /api/payments/approvals/pending

Any token. `{ adjustments, writeOffs, overrides, incentives }`: what waits in the cities where the caller requests or decides each kind (empty arrays otherwise). Used by the Money approvals inbox.

### POST /api/payments/adjustments

`adjustment:request` @ the balance's city. Body `{ accountId | referenceCode, direction: "CREDIT" | "DEBIT", amountMinor (1–100,000,000), category: "GOODWILL" | "FEE_REVERSAL" | "CORRECTION" | "LOST_ITEM_RETURN" | "OTHER", reason (5–500), ticketId?, tripId? }`. `400 limit_exceeded`: over 50,000 ETB, over 1,000 ETB for a city-only grant (support agents), or credits to this balance over 30 days above 10,000 ETB.

### GET /api/payments/adjustments, GET /api/payments/adjustments/:id

Lists for `adjustment:request`, `adjustment:approve` or `balance:read` (by city); `?status=&accountId=&cityId=`. One adjustment: the same, or the requester; else `404`.

### POST /api/payments/adjustments/:id/approve | reject | cancel

Approve: `adjustment:approve` @ city. Limits re-checked (`409 limit_exceeded`, the request stays pending). Posts the `ADJUSTMENT` entry, recomputes the state, emits `balance.adjusted`. Answer: the adjustment with `status: "EXECUTED"`, `journalEntryId`.

### GET /api/payments/write-offs/candidates

`writeoff:request`, `writeoff:approve` or `balance:read` (by city); `?cityId=`. `{ afterDays, candidates: [{ accountId, beneficiary, cityId, referenceCode, state, balanceMinor, overdueSince, overdueDays }] }`: balances below zero overdue at least `afterDays` (`WRITE_OFF_AFTER_DAYS`), without an open request, oldest first (200).

### POST /api/payments/write-offs

`writeoff:request` @ city. Body `{ accountId | referenceCode, reason }`. The amount is the whole debt now. `400 not_eligible` (not below zero, no overdue due, or overdue fewer days than required); `409 already_requested` (one open request per balance).

### GET /api/payments/write-offs, GET /api/payments/write-offs/:id

As for adjustments, with `writeoff:*` / `balance:read`.

### POST /api/payments/write-offs/:id/approve | reject | cancel

Approve: `writeoff:approve` @ city. `409 not_eligible` if no longer eligible; `409 balance_changed` if the balance isn't exactly `−amountMinor` any more (reject and ask again). Posts `WRITE_OFF`, marks open dues `WRITTEN_OFF`, recomputes the state, emits `balance.written_off`.

### POST /api/payments/policy-overrides

`policy_override:request` @ city. Body `{ accountId | referenceCode, mode?: "POSTPAID" | "PREPAID" | null, warningMinor?, cashLimitMinor?, hardLimitMinor? (each ≤ 0 or null), prepaidMinimumMinor? (≥ 0 or null), validFrom?: ISO | null (default now), validUntil: ISO, reason }`. Null fields keep the city's value. `400 invalid_override` (nothing set; merged limits out of order; hard limit below −10,000 ETB; window over or longer than 90 days); `409 overlap` (an approved override of the balance overlaps the window).

### GET /api/payments/policy-overrides, GET /api/payments/policy-overrides/:id

As for adjustments, with `policy_override:*` / `balance:read`. Each row also has `inForce` (approved and the window covers now).

### POST /api/payments/policy-overrides/:id/approve | reject | cancel | revoke

Approve: `policy_override:approve` @ city; limits re-checked against the city's current policy (`409 invalid_override`), overlap re-checked (`409 overlap`, also from the exclusion constraint). The state is recomputed at once when the window has started. `revoke` (`policy_override:approve`, body `{ reason }` required, 5–500): an `APPROVED` override ends now (`REVOKED`), the state is recomputed; otherwise `409 invalid_state`.

### POST /api/payments/incentives

`incentive:propose` @ `cityId`. Body `{ cityId, name (3–80), vehicleType?: string | null, targetTrips (1–1000), rewardMinor, budgetMinor, startsAt: ISO, endsAt: ISO, reason }`. `400 invalid_incentive`: reward over 10,000 ETB, budget below the reward or over 1,000,000 ETB, window over or longer than 31 days.

### GET /api/payments/incentives, GET /api/payments/incentives/:id

Lists for `incentive:propose`, `incentive:approve` or `report:read_finance` (by city); `?status=&cityId=`. One program adds `progress` (top 100 `{ driverId, beneficiaryAccountId, trips, reachedAt, reached }` for approved or closed programs) and `awards` (`{ id, driverId, accountId, trips, amountMinor, journalEntryId, createdAt }`).

### POST /api/payments/incentives/:id/approve | reject | cancel

Approve: `incentive:approve` @ city; terms re-checked (`409 invalid_incentive`, e.g. the window is over). Status `APPROVED`; paid by the job when `endsAt` passes (`CLOSED`, `qualifiedCount`, `awardsCount`, `spentMinor`).

### GET /api/payments/incentives/me

Drivers (`earnings:read` @ SELF). `?cityId=` (default `addis-ababa`). `{ incentives: [{ id, name, cityId, vehicleType, targetTrips, rewardMinor, startsAt, endsAt, status, trips, awardedMinor }] }`: approved and closed programs of the city running now, starting within 7 days, or ended within 30 days, with the caller's settled trips in the window and what they were paid.

## Corporate invoices

### GET /api/payments/invoices/uninvoiced?period=YYYY-MM

Finance (`invoice:issue` or `report:read_finance`, unscoped). `{ period, periodStart, periodEnd, open, companies: [{ orgId, lines, totalMinor, firstAt, lastAt }] }`: companies with receivable postings in the month that aren't on an invoice yet (`open`: the month isn't over).

### POST /api/payments/invoices

`invoice:issue`. `Idempotency-Key` accepted. Body `{ orgId, period: "YYYY-MM" }`. `201` with the invoice and its `lines` and `payments`. `400 period_open` (the Addis Ababa month isn't over); `409 nothing_to_invoice`; `409 already_issued` (one per company per month).

Invoice object: `{ id, orgId, period, number ("INV-YYYYMM-NNNNN"), periodStart, periodEnd, currency, totalMinor, lineCount, paidMinor, outstandingMinor, status: "ISSUED" | "PAID", overdue, issuedBy, issuedAt, dueAt, paidAt }`. Detail adds `lines: [{ id, at, kind, tripId, purpose, riderId, cityId, vehicleType, amountMinor }]` and `payments: [{ id, amountMinor, bankReference, createdAt, recordedBy (finance only) }]`.

### GET /api/payments/invoices, GET /api/payments/invoices/:id, GET /api/payments/invoices/:id/csv

Finance: `?status=ISSUED|PAID&orgId=&period=&overdue=true` (200 newest). One invoice: finance, or that company's `corporate:read_invoices` @ ORG; anyone else `404`. CSV (`text/csv`, attachment `INV-….csv`): `invoice_number,period,at,kind,trip_id,purpose,rider_id,city,vehicle_type,amount_etb` per line, then a `TOTAL` row.

### POST /api/payments/invoices/:id/payments

`invoice:issue`. `Idempotency-Key` accepted. Body `{ amountMinor, bankReference (3–60, [A-Za-z0-9/_.-]) }`. `201` with the invoice detail. `400 amount_exceeds_outstanding`; `409 duplicate_reference` (that bank transaction is already applied, compared upper-case); `409 invalid_state` (already paid). The last payment makes it `PAID` and emits `invoice.paid`.

### GET /api/payments/org/:orgId/invoices

Company account admins (`corporate:read_invoices` @ ORG) or finance; others `403`. `{ orgId, owedMinor (the receivable now, including charges not invoiced yet), invoices: [...] }` (60 newest months).

### GET /api/payments/org/:orgId/invoices/:id, GET /api/payments/org/:orgId/invoices/:id/csv

The same reader check; an invoice of another company is `404`.
