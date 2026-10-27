# pricing-service

Quotes (workflow [05](../../docs/design/workflows/05-ride-booking-matching.md) part B). A rider, call center agent or company coordinator asks for an estimate. pricing-service then:

1. gets the route from mapping-service;
2. prices it with the city's live fare card (admin dashboard → Settings → Fares: base, per km, per minute, minimum; changes need a second super admin);
3. keeps one quote per vehicle type in Redis for `quote.ttlSeconds` (10 minutes).

trip-service reads the quote by id when the trip is requested (`GET /internal/quotes/:id`). The rider pays the quoted fare even if fares change in between.

Port **3004**. There's no database: quotes live in Redis.

```bash
make secrets   # INTERNAL_SERVICE_TOKEN in .env
pnpm dev       # or `make dev-services` from the root
```

| Endpoint | Who | What |
|---|---|---|
| `POST /api/pricing/estimates` | Anyone signed in (`ride-app` or `ride-admin`) | `{ pickup, dropoff, vehicleTypes?, pickupAddress?, dropoffAddress? }` → `{ quotes: [{ id, fareMinor, breakdown, distanceMeters, durationSeconds, approximate, expiresAt, … }] }`. Without `vehicleTypes`, every type offered in the city (admin → Cities and vehicles) |
| `GET /api/pricing/fares?cityId=` | Public | The city's fare card per vehicle type (cached 60 s) |
| `GET /internal/quotes/:id` | trip-service (service token) | The quote, or 404 when expired or unknown |
| `POST /internal/quotes` | trip-service (service token) | A fresh quote for a user (re-pricing a scheduled ride at dispatch); never a promo |

How the fare is worked out: base + km × per km + minutes × per minute, rounded to whole birr, at least the minimum fare. When OSRM is down, mapping-service answers with a straight-line estimate and the quote is marked `approximate`; the rider still pays the quoted fare.

Not built yet (workflow 15):
- versioned fare rules with scheduled changes;
- zones (airport fees, no-pickup areas);
- promotions;
- surge pricing.

```bash
pnpm test   # pricing and the HTTP API, with an in-memory quote store
```

## Documentation

Reference documentation for engineers (architecture, API, events, data model, integrations, configuration, operations): [docs/README.md](docs/README.md).

## Workflow 15 (zones, fare changes, promotions)

Since this addition the "Not built yet" list above is mostly done and pricing-service has a Postgres database (`pricing_service`) and Kafka:

- **Zones** per city (`zone:manage`): service areas, no-pickup areas, airport fees, surge (1–3×), applied to every new quote.
- **Fare changes** with maker–checker (`pricing:propose` → `pricing:approve`, another person): a new card per city and vehicle type from a time at least 24 h after approval (emergency: on approval); the approved rule replaces the Settings → Fares values for that city and type from then on. Impact preview on typical trips.
- **Promo codes** (`promo:manage`; budgets above 10 000 birr activated by `incentive:approve`): riders send `promoCode` with the estimate and get `discountMinor` / `payableMinor` on the quote; the discount is redeemed on `trip.completed` (`promo.redeemed`), and the code stops when its budget is used (`promo.exhausted`).

Still open: surge driven by demand (zones are static), FIRST_RIDE/REFERRAL promos, replaying last week's trips for the impact preview. See [docs/api.md](docs/api.md#workflow-15-zones-fare-changes-promos-added) and [docs/architecture.md](docs/architecture.md#workflow-15-rules-zones-and-promotions-added).

```bash
pnpm test:integration   # Postgres pricing_service_test + its own Redis on port 6398
```
