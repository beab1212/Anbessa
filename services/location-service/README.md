# location-service

The **read side of live location** ([Database.md §10](../../docs/design/Database.md#10-hot-path-live-location-in-redis), [workflow 04](../../docs/design/workflows/04-driver-shift.md)):

- keeps each driver's state in Redis from **events**: `driver.online` / `driver.offline` (fleet-service), `trip.matched` / `trip.completed` / `trip.cancelled` (trip-service);
- answers **"who's near this pickup?"** for matching, nearest first, without stale, offline, busy or already-offered drivers;
- gives the **ETA to pickup** for quotes (OSRM driving time through mapping-service);
- runs the **staleness sweeper**: no ping for 20 s → out of matching until pings resume; 10 min without a ping or a trip → `driver.connection_lost` (fleet-service ends the session);
- serves the **ops map** (staff) and the **rider's trip view**.

Pings are written by **realtime-gateway** (every ~4 s per driver), using the same `libs/shared-location` code, so writer and reader can't disagree about the key layout.

## Quick start

```bash
docker compose -f docker-compose.dev.yml up -d   # Redis, Redpanda
pnpm install
make -C ../.. secrets                             # .env + the shared INTERNAL_SERVICE_TOKEN
pnpm dev                                          # http://localhost:3003
```

Drivers normally go online through **fleet-service**, which publishes `driver.online` to Kafka. For a quick test without it (or without Kafka), put a driver online with the development route. It only exists when `NODE_ENV=development`:

```bash
TOKEN=$(grep ^INTERNAL_SERVICE_TOKEN= .env | cut -d= -f2)
curl -XPOST localhost:3003/internal/dev/drivers/<driver user id>/online -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"vehicleId":"v-1","vehicleType":"economy","cityId":"addis-ababa","cashAllowed":true}'
```

Then the driver's app (signed in with a `DRIVER` token) can stream `location:update` to realtime-gateway, and the driver appears in `/internal/drivers/nearby`.

## API

| Route | Auth | Purpose |
|---|---|---|
| `GET /internal/drivers/nearby?cityId&vehicleType&lat&lng&radiusMeters=2000&limit=20&cashOnly=false` | `Bearer $INTERNAL_SERVICE_TOKEN` | Matching candidates, nearest first (workflow 05, step 12) |
| `GET /internal/eta-to-pickup?cityId&vehicleType&lat&lng` | service token | `{ etaSeconds, driversNearby, approximate }` for the quote screen |
| `GET /internal/drivers/:driverId` | service token | One driver's live state |
| `POST /internal/dev/drivers/:id/online` · `/offline` | service token, **development only** | Stand-in for fleet-service |
| `GET /api/locations/cities/:cityId/drivers` | staff token with `location:read_live` in that city (dispatcher, safety officer, operations manager) | Ops map |
| `GET /api/locations/trips/:tripId/driver` | app token: the trip's rider or driver, or the vehicle's fleet owner (`location:read_live @ ORG`) | Last driver position (fallback while the socket reconnects). Anyone else gets `404` |

## Events

| Topic | Direction | Effect |
|---|---|---|
| `driver.online` | in | `driver:{id}` = available, with city, vehicle type, cash eligibility, fleet org |
| `driver.offline` | in | out of every geo set; later pings are ignored |
| `trip.matched` | in | driver → busy set; rider and driver become the trip's members |
| `trip.completed` / `trip.cancelled` | in | driver → available; the trip view stays for 5 more minutes |
| `driver.connection_lost` | out | fleet-service ends the session |

Payloads are validated against the contracts in `libs/shared-types/src/events.ts`. Invalid events are logged and skipped, while Redis errors make Kafka retry. Handlers are idempotent.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Hot reload |
| `pnpm test:integration` | Real Redis in a throwaway container on port 6392 (needs Docker): geo index, filters, sweeper and its lock, lost drivers, trips, ETA with and without mapping-service, access control, dev routes |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | |

See `.env.example` for every variable.

## Documentation

Reference documentation (architecture, API, events, data model, integrations, configuration, operations): [docs/README.md](docs/README.md).
