# location-service: data model

location-service has **no SQL database**: no `prisma/` folder, no migrations, no `DATABASE_URL`. (`docker-compose.dev.yml` lists Postgres under the `db` profile, which this service doesn't use.) All state is in Redis, shared with realtime-gateway and partly with trip-service and auth-service.

The key builders are in `libs/shared-location/src/keys.ts`. City ids must match `^[a-z0-9-]{1,40}$` and vehicle types `^[a-z0-9_]{1,30}$`; anything else throws before a key is built. City keys use a **hash tag** `{cityId}` so all of a city's keys map to one Redis Cluster slot.

## Keys

| Key pattern | Type | Contents | TTL | Written by | Read by |
|---|---|---|---|---|---|
| `geo:{city}:{vehicleType}:available` | GEO (sorted set) | member = driverId, position of the last ping | none (members removed explicitly) | gateway (`recordPing`), location (`startTrip`/`endTrip`/`goOnline`/`goOffline`, sweeper) | location (`nearbyAvailable`) |
| `geo:{city}:{vehicleType}:busy` | GEO | drivers `on_trip` | none | same | not read by any query in code (kept for symmetry and the sweeper) |
| `seen:{city}` | sorted set | member = driverId, score = **server** time of the last accepted ping (unix ms) | none | gateway (`ZADD`), location (sweeper `ZREM` of lost drivers, `goOffline`, `goOnline` on city change) | location (sweeper, ops map) |
| `vtypes:{city}` | set | vehicle types that have had a driver online in the city | none, never cleaned | location (`goOnline`) | location (sweeper, public nearby) |
| `location:cities` | set | city ids that have had a driver online | none, never cleaned | location (`goOnline`) | location (sweeper) |
| `driver:{driverId}` | hash | see below | **15 min**, refreshed by every accepted ping, `goOnline`, `goOffline` | gateway, location | gateway, location, trip-service (through `GET /internal/drivers/:id`) |
| `offer:driver:{driverId}` | string | tripId of the open offer (soft lock) | `EX offerSeconds` (trip-service setting) | trip-service (`SET NX EX`), deleted by trip-service and by location's `startTrip` | location (`EXISTS` in `nearbyAvailable`) |
| `trip:{tripId}:last` | hash | `driverId`, `lat`, `lng`, `at` (device ms), `stale` (`"0"`), `heading?` | 3600 s, refreshed on each on-trip ping; set to 300 s by `endTrip` | gateway (`recordPing`, only while `on_trip`) | location (`tripDriver`) |
| `trip:{tripId}:members` | set | riderId and driverId, plus the booker (`bookedById`) for phone and company bookings | 12 h from `trip.matched`; 300 s after `trip.completed`/`cancelled` | location (`startTrip`, `endTrip`) | gateway (`trip:subscribe`), location (`tripDriver`) |
| `trip:{tripId}:billing_org` | string | the company the trip is billed to (`billingOrgId`); only for company trips | 12 h from `trip.matched`; 300 s after `trip.completed`/`cancelled` | location (`startTrip`, `endTrip`) | location (`tripDriver`: `trip:read` holders for that org may watch the car) |
| `balance:{beneficiaryId}` | hash | `state`, `cashAllowed` (`"1"`/`"0"`), `at` (ms) | 30 days | location (`applyBalanceState`) | location (`goOnline`) |
| `beneficiary:{beneficiaryId}:drivers` | set | online drivers earning for that beneficiary | 24 h, refreshed by `goOnline` | location (`goOnline`, `goOffline`, `applyBalanceState` cleanup) | location (`applyBalanceState`) |
| `lock:sweep:{city}` | string | random owner id of the replica sweeping this round | `PX max(1000, SWEEP_INTERVAL_MS - 500)` | location (sweeper) | location (sweeper) |

Keys used by the shared authz library (not the location layout):

| Key / channel | Purpose |
|---|---|
| `authz:changed` (pub/sub channel) | permission matrix changed: re-fetch the snapshot (`libs/shared-authz/src/sync.ts`) |

location-service does not read `deny:{userId}` or `pv:{userId}` (realtime-gateway does).

## `driver:{driverId}` fields

All values are strings. `parseState()` in `drivers.ts` returns `null` (driver unknown) if `status`, `cityId` or `vehicleType` is missing.

| Field | Values | Set by |
|---|---|---|
| `status` | `available` \| `on_trip` \| `offline` | `goOnline`, `startTrip`, `endTrip`, `goOffline` |
| `cityId` | city id | `goOnline` |
| `vehicleType` | e.g. `economy` | `goOnline` |
| `vehicleId` | fleet-service vehicle id | `goOnline` |
| `fleetOrgId` | uuid or `""` | `goOnline` |
| `beneficiaryId` | uuid or `""` | `goOnline` |
| `tripId` | uuid or `""` | `startTrip` (set), `endTrip`/`goOffline` (cleared), `goOnline` (kept while `on_trip`) |
| `cashAllowed` | `"1"` / `"0"` | `goOnline`, `applyBalanceState` |
| `balanceState` | `OK` \| `WARNING` \| `CASH_BLOCKED` \| `BLOCKED` \| `""` | `goOnline`, `applyBalanceState` |
| `lat`, `lng` | decimal degrees | `recordPing` |
| `heading` | degrees, only when the ping had a finite heading | `recordPing` |
| `at` | device time of the last accepted ping, unix ms | `recordPing` |
| `stale` | `"1"` (set by the sweeper) / `"0"` (reset by every ping and `goOnline`) | sweeper, `recordPing`, `goOnline` |

## Timing constants (`LOCATION_TIMING`, `PING_LIMITS`)

| Constant | Value | Used for |
|---|---|---|
| `staleAfterMs` | 20 000 | sweeper threshold and the freshness filter in `nearbyAvailable` |
| `lostAfterMs` | 600 000 (10 min) | `driver.connection_lost` |
| `stateTtlSeconds` | 900 (15 min) | `driver:{id}` TTL |
| `tripMembersTtlSeconds` | 43 200 (12 h) | `trip:{id}:members`, `trip:{id}:billing_org` |
| `tripLastTtlSeconds` | 3600 | `trip:{id}:last` |
| `maxAccuracyMeters` | 100 | ping check |
| `maxSpeedMps` | 200 km/h | ping check |
| `maxClockSkewMs` | 5000 | ping check |

None of these are configurable through the environment; only the sweep interval is (`SWEEP_INTERVAL_MS`).

## Rebuild after data loss

From the comment in `drivers.ts`: everything is rebuildable. After a Redis flush or failover without persistence, `driver:{id}` hashes are gone, so pings answer `not_online` until fleet-service publishes a new `driver.online` for each driver (the code has no replay mechanism for that). `trip:{id}:members` would also be lost, so riders can't join trip rooms until the next `trip.matched`, which for a running trip doesn't happen.
