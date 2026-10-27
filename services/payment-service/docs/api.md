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

Four POST routes accept an `Idempotency-Key` header (`src/lib/idempotency.ts`): `POST balances/:accountId/top-ups`, `POST payments/:id/pay`, `POST payments/:id/refunds`, `POST top-ups/manual`.

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

200 `{ payments: PaymentView[], settlements: [{ purpose, paymentMethod, fareMinor, commissionMinor, vatMinor, earningsMinor, commissionRuleId, settledAt, beneficiaryAccountId }] }`.

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

---

## Finance and support: payments and refunds

Staff list routes use `cityFilter`: the union of cities where the caller has `balance:read`, `report:read_finance`, `refund:approve` or `refund:request` (any of them everywhere → no filter; none → 403 `forbidden`).

### GET /api/payments/payments

| Query | Type | Default |
|---|---|---|
| `status` | string ≤ 30 | — |
| `provider` | string ≤ 30 | — |
| `tripId` | uuid | — |
| `before` | date | — |
| `limit` | int 1–100 | 50 |

200 `{ payments: PaymentView[], next: ISO | null }` (newest first; `next` is the last `createdAt`).

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

Query `status`, `channel` (strings ≤ 30). Permission: `topup:record_cash` or `topup:approve_cash`, else `balance:read`, all with no scope. 200 `{ topUps: TopUpView[] }`, newest 100. Not filtered by city.

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
