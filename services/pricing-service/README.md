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
