# payment-service

The money side of every trip ([docs/design/Payment.md](../../docs/design/Payment.md), workflows [08](../../docs/design/workflows/08-payment-receipt-rating.md) and [09](../../docs/design/workflows/09-driver-balance.md)):

- **Ledger.** A double-entry ledger whose journal entries always balance and are never edited.
- **Settlement.** Each trip is settled by payment method, with commission and VAT.
- **Balances.** Each driver or fleet company has one balance, with limits that pause cash trips or block driving.
- **Rider charges.** Riders pay by mobile money or card, with retries. A charge that keeps failing becomes a rider receivable.
- **Top-ups.** Drivers and fleets pay in by mobile money, by bank transfer, or with cash at an office.
- **Payouts.** A weekly settlement pays out positive balances and sends payment dues to negative ones.
- **Refunds.** A refund is requested by one person and approved by another.
- **Commission and limits.** Commission rules and balance limits change only when one person proposes and another approves.

Port **3005**, database **`payment_service`**.

> [!WARNING]
> **Payment providers are simulated.** telebirr, CBE Birr (mobile money) and Chapa (cards) run against an in-process simulator. It answers like each provider and posts that provider's signed callback to our webhook, so everything except the provider HTTP calls is the production code. No real money moves. Config refuses `GATEWAY_MODE=simulated` in production.

## Quick start

```bash
make secrets       # fills the webhook secrets and INTERNAL_SERVICE_TOKEN in .env
make db-migrate    # creates payment_service
pnpm dev           # or `make dev-services` from the root
```

payment-service needs:
- **Kafka**, for `trip.completed` and `trip.cancelled` in and its events out;
- **Redis**, to push live payment prompts to riders, for auth-service's deny list, and for the simulator's state;
- **platform-service**, for the payment methods and provider order in Settings → Payments.

## How a trip is settled

| Payment method | When | Ledger entry `trip-settlement:<tripId>` |
|---|---|---|
| Cash | On `trip.completed` | beneficiary − (commission + VAT), commission +, VAT + |
| Mobile money / card | When the provider confirms the charge | provider clearing − fare, beneficiary + (fare − commission − VAT), commission +, VAT + |
| Mobile money / card, last retry failed | After the last retry | rider receivable − fare, the rest as above (the driver is paid anyway) |
| Company account | On `trip.completed` | company receivable − fare, the rest as above |

The default rule is 15% commission, at least 10 ETB, plus VAT of 15% of the commission. Default limits:
- **Warning:** at −300 ETB.
- **Cash trips pause:** at −500 ETB.
- **All trips stop:** at −1,000 ETB.

Finance changes these per city under Money → Commission and limits.

## Providers

`src/gateways/`:
- **`types.ts`:** what a provider must do (charge, payout, refund, query, parse a webhook).
- **`telebirr.ts`, `cbebirr.ts`, `chapa.ts`:** each provider's callback format and signature check. Each file header lists the real API calls.
- **`simulated.ts`:** sends each provider's requests to `simulator.ts`.

To go live with a provider, replace its requests with HTTP calls to the provider and keep its callback parser. For telebirr, also switch its signature check from HMAC to the RSA public key.

| Simulator setting | Effect |
|---|---|
| `SIM_AUTO_APPROVE_SECONDS=8` | Charges approve themselves after 8 s (the rider approving on their phone). With `0`, use the payment page (`checkoutUrl`) and choose **Pay**, **Decline** or **Insufficient funds** |
| `SIM_PAYOUT_SECONDS=3` | Payouts finish after 3 s. A destination ending in `0000` fails ("account closed") and goes back on the balance |
| `SIM_DROP_WEBHOOKS=0.5` | Drops half the callbacks; reconciliation recovers them after `RECONCILE_AFTER_SECONDS` |

## API (under `/api/payments`)

| Who | Endpoints |
|---|---|
| Drivers and fleet owners | `GET balances/me`, `GET balances/org/:orgId`, `GET balances/:id`, `GET balances/:id/statement`, `GET/POST balances/:id/top-ups`, `PUT balances/:id/payout-method`, `GET top-ups/:id` |
| Riders | `GET trips/:tripId`, `POST payments/:id/pay` (pay now), `GET/PUT me/preferences` (mobile money provider) |
| Finance and support | `GET overview`, `GET ledger/integrity`, `GET balances`, `GET payments`, `GET payments/:id`, `POST payments/:id/reconcile`, `POST payments/:id/refunds`, `GET refunds`, `POST refunds/:id/approve\|reject`, `POST top-ups/manual`, `GET top-ups`, `POST top-ups/:id/approve\|reject`, `POST settlements/run`, `GET payouts`, `GET payouts/:id`, `POST payouts/:id/approve\|reject`, `GET rules?cityId=`, `GET rules/pending`, `POST rules/changes`, `POST rules/changes/:id/approve\|reject\|cancel`, `GET gateways` |
| Public | `GET methods`, `POST webhooks/:provider` (provider callbacks, signature-checked), `GET/POST sim/checkout/:ref` (simulator only, never in production) |
| Internal | `GET /internal/balances/state` (fleet-service at session start), `/internal/ops/outbox`, `/internal/ops/integrations` (system page) |

Events out: `trip.settled`, `payment.action_required`, `payment.captured`, `payment.failed`, `balance.state_changed`, `balance.topped_up`, `balance.payment_due`, `payout.sent`, `payout.failed`, `refund.succeeded`, `refund.failed`, `audit.recorded`.

## Background jobs (`src/jobs.ts`)

| Every | Job |
|---|---|
| 15 s | Start due charge retries, and charges interrupted between the database commit and the provider call |
| 1 min | Reconcile: ask providers about charges, top-ups, payouts and refunds whose callback never came |
| 5 min | Mark dues past their deadline as overdue (this blocks the balance), expire old proposals, and recompute states when a scheduled policy takes effect |
| 10 min | Run the weekly settlement on Monday at 00:00 Addis time (`SETTLEMENT_SCHEDULE=weekly`) |
| 1 h | Check ledger integrity (each balance equals the sum of its postings, and all accounts sum to 0) |

## Tests

```bash
pnpm test                    # unit: money rules, every provider's callback format and signature
pnpm test:integration        # real Postgres (payment_service_test), the simulator, Kafka replaced by direct calls
```
