// Driver live state in Redis (workflow 04, Database.md §10).
//
//   realtime-gateway   recordPing()                 every ~4 s per online driver
//   location-service   goOnline / goOffline         from driver.online / driver.offline
//                      startTrip / endTrip          from trip.matched / trip.completed|cancelled
//                      nearby / sweepCity           matching, quotes, staleness
//
// Everything here is rebuildable: after a Redis failover drivers reappear with their next ping
// (state comes back with the next driver.online, or stays until its TTL).

import type { Redis } from "ioredis";
import { checkPing, type Ping, type PingRejection } from "./geo.js";
import { keys, type GeoSet } from "./keys.js";

export type DriverStatus = "available" | "on_trip" | "offline";

export interface DriverState {
  driverId: string;
  status: DriverStatus;
  cityId: string;
  vehicleType: string;
  vehicleId: string;
  /** fleet organisation that owns the vehicle, if any (for location:read_live @ ORG) */
  fleetOrgId?: string;
  tripId?: string;
  cashAllowed: boolean;
  balanceState?: string;
  lat?: number;
  lng?: number;
  heading?: number;
  /** last accepted ping, unix ms */
  at?: number;
  /** removed from the geo index by the sweeper until pings resume */
  stale: boolean;
}

export const LOCATION_TIMING = {
  /** no ping for this long → out of the geo index (workflow 04, step 13) */
  staleAfterMs: 20_000,
  /** stale this long without a trip → reported as connection lost (step 14) */
  lostAfterMs: 10 * 60_000,
  /**
   * Driver hash TTL, refreshed on every ping and state change. Longer than lostAfterMs so the
   * sweeper still knows the driver's city and vehicle type when it reports them lost.
   */
  stateTtlSeconds: 15 * 60,
  tripMembersTtlSeconds: 12 * 3600,
  tripLastTtlSeconds: 3600,
};

const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));

function parseState(driverId: string, h: Record<string, string>): DriverState | null {
  if (!h.status || !h.cityId || !h.vehicleType) return null;
  return {
    driverId,
    status: h.status as DriverStatus,
    cityId: h.cityId,
    vehicleType: h.vehicleType,
    vehicleId: h.vehicleId ?? "",
    fleetOrgId: h.fleetOrgId || undefined,
    tripId: h.tripId || undefined,
    cashAllowed: h.cashAllowed === "1",
    balanceState: h.balanceState || undefined,
    lat: num(h.lat),
    lng: num(h.lng),
    heading: num(h.heading),
    at: num(h.at),
    stale: h.stale === "1",
  };
}

export async function getDriverState(redis: Redis, driverId: string): Promise<DriverState | null> {
  return parseState(driverId, await redis.hgetall(keys.driver(driverId)));
}

const setFor = (status: DriverStatus): GeoSet => (status === "on_trip" ? "busy" : "available");

// ── writes from realtime-gateway ──────────────────────────────────────────────

export type PingResult =
  | { accepted: true; state: DriverState }
  | { accepted: false; reason: PingRejection | "not_online" };

/** One round trip: GEOADD + ZREM other set + ZADD seen + HSET + EXPIRE (+ trip last position). */
export async function recordPing(redis: Redis, driverId: string, ping: Ping, now = Date.now()): Promise<PingResult> {
  const state = await getDriverState(redis, driverId);
  if (!state || state.status === "offline") return { accepted: false, reason: "not_online" };
  const previous = state.lat !== undefined && state.lng !== undefined && state.at !== undefined ? { lat: state.lat, lng: state.lng, at: state.at } : undefined;
  const rejected = checkPing(ping, previous, now);
  if (rejected) return { accepted: false, reason: rejected };

  const set = setFor(state.status);
  const other: GeoSet = set === "available" ? "busy" : "available";
  const fields: Record<string, string> = { lat: String(ping.lat), lng: String(ping.lng), at: String(ping.at), stale: "0" };
  if (ping.heading !== undefined && Number.isFinite(ping.heading)) fields.heading = String(ping.heading);

  const p = redis.pipeline()
    .geoadd(keys.geo(state.cityId, state.vehicleType, set), ping.lng, ping.lat, driverId)
    .zrem(keys.geo(state.cityId, state.vehicleType, other), driverId)
    .zadd(keys.seen(state.cityId), now, driverId)
    .hset(keys.driver(driverId), fields)
    .expire(keys.driver(driverId), LOCATION_TIMING.stateTtlSeconds);
  if (state.status === "on_trip" && state.tripId) {
    p.hset(keys.tripLast(state.tripId), { driverId, ...fields }).expire(keys.tripLast(state.tripId), LOCATION_TIMING.tripLastTtlSeconds);
  }
  await p.exec();
  return { accepted: true, state: { ...state, lat: ping.lat, lng: ping.lng, at: ping.at, heading: ping.heading ?? state.heading, stale: false } };
}

// ── writes from location-service (events) ─────────────────────────────────────

export interface OnlineInput {
  driverId: string;
  cityId: string;
  vehicleType: string;
  vehicleId: string;
  fleetOrgId?: string;
  cashAllowed: boolean;
  balanceState?: string;
}

/** driver.online: the driver is visible to matching from their first ping. */
export async function goOnline(redis: Redis, input: OnlineInput): Promise<void> {
  const previous = await getDriverState(redis, input.driverId);
  const p = redis.multi();
  if (previous && (previous.cityId !== input.cityId || previous.vehicleType !== input.vehicleType)) {
    // switched city or vehicle type: leave the old sets
    p.zrem(keys.geo(previous.cityId, previous.vehicleType, "available"), input.driverId)
      .zrem(keys.geo(previous.cityId, previous.vehicleType, "busy"), input.driverId)
      .zrem(keys.seen(previous.cityId), input.driverId);
  }
  p.del(keys.driver(input.driverId))
    .hset(keys.driver(input.driverId), {
      status: previous?.status === "on_trip" ? "on_trip" : "available",
      cityId: input.cityId,
      vehicleType: input.vehicleType,
      vehicleId: input.vehicleId,
      fleetOrgId: input.fleetOrgId ?? "",
      tripId: previous?.status === "on_trip" ? (previous.tripId ?? "") : "",
      cashAllowed: input.cashAllowed ? "1" : "0",
      balanceState: input.balanceState ?? "",
      stale: "0",
    })
    .expire(keys.driver(input.driverId), LOCATION_TIMING.stateTtlSeconds)
    .sadd(keys.cities(), input.cityId)
    .sadd(keys.vehicleTypes(input.cityId), input.vehicleType);
  await p.exec();
}

async function leaveGeoSets(redis: Redis, state: DriverState) {
  await redis.pipeline()
    .zrem(keys.geo(state.cityId, state.vehicleType, "available"), state.driverId)
    .zrem(keys.geo(state.cityId, state.vehicleType, "busy"), state.driverId)
    .zrem(keys.seen(state.cityId), state.driverId)
    .exec();
}

/** driver.offline: gone from matching at once. Pings are ignored until the next driver.online. */
export async function goOffline(redis: Redis, driverId: string): Promise<void> {
  const state = await getDriverState(redis, driverId);
  if (!state) return;
  await leaveGeoSets(redis, state);
  await redis.pipeline()
    .hset(keys.driver(driverId), { status: "offline", tripId: "" })
    .expire(keys.driver(driverId), LOCATION_TIMING.stateTtlSeconds)
    .exec();
}

/** trip.matched: the driver moves to the busy set; rider and driver may watch the trip. */
export async function startTrip(redis: Redis, input: { tripId: string; driverId: string; riderId: string }): Promise<void> {
  const state = await getDriverState(redis, input.driverId);
  const p = redis.multi()
    .sadd(keys.tripMembers(input.tripId), input.riderId, input.driverId)
    .expire(keys.tripMembers(input.tripId), LOCATION_TIMING.tripMembersTtlSeconds)
    .del(keys.offer(input.driverId));
  if (state && state.status !== "offline") {
    p.hset(keys.driver(input.driverId), { status: "on_trip", tripId: input.tripId });
    if (state.lat !== undefined && state.lng !== undefined && !state.stale) {
      p.zrem(keys.geo(state.cityId, state.vehicleType, "available"), input.driverId)
        .geoadd(keys.geo(state.cityId, state.vehicleType, "busy"), state.lng, state.lat, input.driverId);
    }
  }
  await p.exec();
}

/** trip.completed / trip.cancelled: back to available (if still online). */
export async function endTrip(redis: Redis, input: { tripId: string; driverId: string }): Promise<void> {
  const state = await getDriverState(redis, input.driverId);
  const p = redis.multi()
    // a short grace period so the rider screen can show the final position
    .expire(keys.tripMembers(input.tripId), 300)
    .expire(keys.tripLast(input.tripId), 300);
  if (state && state.status === "on_trip" && state.tripId === input.tripId) {
    p.hset(keys.driver(input.driverId), { status: "available", tripId: "" });
    if (state.lat !== undefined && state.lng !== undefined && !state.stale) {
      p.zrem(keys.geo(state.cityId, state.vehicleType, "busy"), input.driverId)
        .geoadd(keys.geo(state.cityId, state.vehicleType, "available"), state.lng, state.lat, input.driverId);
    }
  }
  await p.exec();
}

export async function isTripMember(redis: Redis, tripId: string, userId: string): Promise<boolean> {
  return (await redis.sismember(keys.tripMembers(tripId), userId)) === 1;
}

// ── reads (location-service) ──────────────────────────────────────────────────

export interface NearbyDriver {
  driverId: string;
  lat: number;
  lng: number;
  distanceMeters: number;
  heading?: number;
  cashAllowed: boolean;
  balanceState?: string;
  vehicleId: string;
  /** last ping, unix ms */
  at: number;
}

/**
 * Matching candidates (workflow 05, step 12): GEOSEARCH the available set, nearest first,
 * then drop anyone stale, offline, on a trip or already holding an offer.
 */
export async function nearbyAvailable(
  redis: Redis,
  q: { cityId: string; vehicleType: string; lat: number; lng: number; radiusMeters: number; limit: number; cashOnly?: boolean },
  now = Date.now(),
): Promise<NearbyDriver[]> {
  const raw = (await redis.geosearch(
    keys.geo(q.cityId, q.vehicleType, "available"),
    "FROMLONLAT", q.lng, q.lat,
    "BYRADIUS", q.radiusMeters, "m",
    "ASC", "COUNT", Math.min(q.limit * 2, 100),
    "WITHCOORD", "WITHDIST",
  )) as [string, string, [string, string]][];
  if (raw.length === 0) return [];

  const p = redis.pipeline();
  for (const [id] of raw) p.hgetall(keys.driver(id)).exists(keys.offer(id));
  const res = (await p.exec()) ?? [];

  const out: NearbyDriver[] = [];
  raw.forEach(([driverId, dist, [lng, lat]], i) => {
    const state = parseState(driverId, (res[i * 2]?.[1] ?? {}) as Record<string, string>);
    const offered = res[i * 2 + 1]?.[1] === 1;
    if (!state || state.status !== "available" || state.stale || offered) return;
    if (state.at === undefined || now - state.at > LOCATION_TIMING.staleAfterMs) return;
    if (q.cashOnly && !state.cashAllowed) return;
    out.push({
      driverId, lat: Number(lat), lng: Number(lng), distanceMeters: Math.round(Number(dist)),
      heading: state.heading, cashAllowed: state.cashAllowed, balanceState: state.balanceState,
      vehicleId: state.vehicleId, at: state.at,
    });
  });
  return out.slice(0, q.limit);
}

/** Every online driver in a city with a position (ops map, location:read_live @ CITY). */
export async function cityDrivers(redis: Redis, cityId: string): Promise<DriverState[]> {
  const ids = await redis.zrange(keys.seen(cityId), "0", "-1");
  if (ids.length === 0) return [];
  const p = redis.pipeline();
  for (const id of ids) p.hgetall(keys.driver(id));
  const res = (await p.exec()) ?? [];
  return ids
    .map((id, i) => parseState(id, (res[i]?.[1] ?? {}) as Record<string, string>))
    .filter((s): s is DriverState => !!s && s.status !== "offline" && s.lat !== undefined);
}

// ── staleness sweeper (location-service) ──────────────────────────────────────

/**
 * Workflow 04, steps 13–14: drivers without a ping for 20 s leave the geo index (they come back
 * with their next ping). Stale for 10 min without a trip → returned as `lost` and forgotten,
 * so fleet-service can end the session.
 */
export async function sweepCity(redis: Redis, cityId: string, now = Date.now()): Promise<{ stale: string[]; lost: { driverId: string; lastSeen: number }[] }> {
  const staleIds = await redis.zrangebyscore(keys.seen(cityId), "-inf", String(now - LOCATION_TIMING.staleAfterMs));
  if (staleIds.length === 0) return { stale: [], lost: [] };
  const lostCutoff = now - LOCATION_TIMING.lostAfterMs;
  const scores = await redis.zmscore(keys.seen(cityId), ...staleIds);
  const types = await redis.smembers(keys.vehicleTypes(cityId));

  const stale: string[] = [];
  const lost: { driverId: string; lastSeen: number }[] = [];
  for (const [i, id] of staleIds.entries()) {
    const state = await getDriverState(redis, id);
    const p = redis.pipeline();
    // remove from every set of the city: the state (and its vehicle type) may be gone already
    for (const t of new Set([...types, ...(state ? [state.vehicleType] : [])])) {
      p.zrem(keys.geo(cityId, t, "available"), id).zrem(keys.geo(cityId, t, "busy"), id);
    }
    const lastSeen = Number(scores[i] ?? 0);
    if (lastSeen < lostCutoff && state?.status !== "on_trip") {
      p.zrem(keys.seen(cityId), id);
      lost.push({ driverId: id, lastSeen });
    } else {
      stale.push(id);
    }
    if (state && !state.stale) p.hset(keys.driver(id), "stale", "1");
    await p.exec();
  }
  return { stale, lost };
}
