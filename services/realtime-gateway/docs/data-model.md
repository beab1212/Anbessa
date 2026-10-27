# realtime-gateway: data model

realtime-gateway has **no SQL database** (no `prisma/`, no migrations; `.env.example` says "No direct DB for this service"). `docker-compose.dev.yml` lists Postgres under the `db` profile, which the service doesn't use. In-process state is limited to per-socket variables (`lastPingAt`, the deny-recheck timer) and the Kafka counters. Everything else is in Redis.

## Redis keys the gateway touches

The location keys are defined in `libs/shared-location/src/keys.ts` and fully described in location-service's [data-model.md](../../location-service/docs/data-model.md).

| Key | Type | Gateway access | Where |
|---|---|---|---|
| `driver:{driverId}` | hash | `HGETALL` before each ping; `HSET lat lng at stale=0 [heading]`, `EXPIRE 900` on accept | `recordPing` |
| `geo:{city}:{vehicleType}:available` / `:busy` | GEO | `GEOADD` into the set matching `status` (`available` → available, `on_trip` → busy), `ZREM` from the other | `recordPing` |
| `seen:{city}` | sorted set | `ZADD <server now ms> driverId` | `recordPing` |
| `trip:{tripId}:last` | hash | `HSET driverId lat lng at stale [heading]`, `EXPIRE 3600`, only while `on_trip` | `recordPing` |
| `trip:{tripId}:members` | set | `SISMEMBER` on `trip:subscribe` | `isTripMember` |
| `deny:{userId}` | key (written by auth-service) | `EXISTS` at handshake and every 60 s per socket | `auth.middleware.ts`, `server.ts` |
| `pv:{userId}` | string (written by auth-service) | `GET` at handshake: the user's current permission version | `auth.middleware.ts` |
| Socket.io adapter keys/channels | pub/sub | room membership and broadcasts | `@socket.io/redis-adapter` |

The gateway never creates a driver: a ping for a driver without a hash (or with `status = offline`) is refused with `not_online` and writes nothing. The gateway never writes `status`, `tripId`, `cityId` or `vehicleType`.

## Per-socket data

| Field | Set at | Content |
|---|---|---|
| `socket.data.userId` | handshake | token `sub` |
| `socket.data.principal` | handshake | `Principal` from `libs/shared-authz`: `userId`, `audience` (`ride-app`), `roles`, `permissionVersion`, `amr`, `actor?` |
