// The matcher (workflow 05, part D): one driver at a time, nearest by driving time, widening
// the radius, for at most MATCH_TIMEOUT_SECONDS.
//
// State lives in Redis, not in a process, so any replica can continue a trip's matching:
//   match:due                ZSET tripId → when to look at it next (ms)
//   match:{trip}             HASH startedAt, radius index
//   match:{trip}:declined    SET  drivers who declined or let an offer expire
//   match:lease:{trip}       one worker per trip step (SET NX PX); a crashed worker's lease expires
//   offer:driver:{id}        soft reservation while an offer is open (SET NX EX), shared with location-service
//
// The database stays the source of truth: trip status, trip_offer rows, and the
// driver_active_trip primary key decide who really gets the trip.

import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { haversineMeters, keys as locationKeys } from "@ride-app/shared-location";
import type { Logger } from "@ride-app/shared-utils";
import type { Db } from "../db.js";
import type { LocationClient, MappingClient, NearbyDriver } from "../lib/clients.js";
import type { Realtime } from "../lib/realtime.js";
import { tripView, type MatchingControl } from "../trips/service.js";

const DUE = "match:due";
const state = (tripId: string) => `match:${tripId}`;
const declined = (tripId: string) => `match:${tripId}:declined`;
const lease = (tripId: string) => `match:lease:${tripId}`;
const STATE_TTL_SECONDS = 15 * 60;

export interface MatcherDeps {
  db: Db;
  redis: Redis;
  location: LocationClient;
  mapping: MappingClient;
  realtime: Realtime;
  logger: Logger;
  /**
   * Matching ran out of time: cancels the trip (NO_DRIVER_FOUND), or — a scheduled ride before its
   * pickup time — escalates it and returns true to keep searching from the smallest radius.
   */
  onTimeout: (tripId: string) => Promise<boolean | void>;
  /** read on every matching step, so settings changes apply to trips already searching */
  config: () => { timeoutSeconds: number; offerSeconds: number; radiiMeters: number[] };
  now?: () => number;
}

export function createMatcher(deps: MatcherDeps) {
  const { db, redis, location, mapping, realtime, logger } = deps;
  const now = deps.now ?? Date.now;
  const owner = randomUUID();
  let timer: NodeJS.Timeout | undefined;
  let busy = false;

  const control: MatchingControl = {
    async start(tripId) {
      await redis.multi()
        .del(state(tripId), declined(tripId))
        .hset(state(tripId), { startedAt: String(now()), radius: "0" })
        .expire(state(tripId), STATE_TTL_SECONDS)
        .zadd(DUE, now(), tripId)
        .exec();
    },
    async stop(tripId) {
      await redis.multi().zrem(DUE, tripId).del(state(tripId), declined(tripId)).exec();
    },
    async poke(tripId) {
      // only if still matching (XX: don't resurrect a finished trip)
      await redis.zadd(DUE, "XX", now(), tripId);
    },
  };

  /** Rank by real driving time (OSRM table via mapping-service); straight-line order if it's down. */
  async function rank(candidates: NearbyDriver[], pickup: { lat: number; lng: number }) {
    const top = candidates.slice(0, 10);
    try {
      const t = await mapping.table(top.map((d) => ({ lat: d.lat, lng: d.lng })), [pickup]);
      return top
        .map((d, i) => ({ ...d, etaSeconds: t.durations[i]?.[0] ?? null }))
        .filter((d) => d.etaSeconds !== null)
        .sort((a, b) => a.etaSeconds! - b.etaSeconds!);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "mapping-service unavailable, ranking by distance");
      return top.map((d) => ({ ...d, etaSeconds: Math.round((haversineMeters(d, pickup) * 1.35) / (22 / 3.6)) }));
    }
  }

  /** One step for one trip. Returns when to look again (ms), or null when matching is over. */
  async function step(tripId: string): Promise<number | null> {
    const config = deps.config();
    const trip = await db.trip.findUnique({ where: { id: tripId } });
    if (!trip || trip.status !== "requested") return null;
    const s = await redis.hgetall(state(tripId));
    const startedAt = Number(s.startedAt ?? now());
    let radius = Number(s.radius ?? 0);

    // an open offer: wait for it, or expire it
    const open = await db.tripOffer.findFirst({ where: { tripId, status: "OFFERED" } });
    if (open) {
      if (open.expiresAt.getTime() > now()) return open.expiresAt.getTime();
      await db.tripOffer.updateMany({ where: { id: open.id, status: "OFFERED" }, data: { status: "EXPIRED", answeredAt: new Date(now()) } });
      await redis.sadd(declined(tripId), open.driverUserId);
      realtime.toUser(open.driverUserId, "trip:offer_expired", { tripId, offerId: open.id });
    }

    if (now() - startedAt > config.timeoutSeconds * 1000) {
      if (await deps.onTimeout(tripId)) {
        await redis.multi().hset(state(tripId), { startedAt: String(now()), radius: "0" }).expire(state(tripId), STATE_TTL_SECONDS).exec();
        return now() + 1000;
      }
      return null;
    }

    const skip = new Set([...(await redis.smembers(declined(tripId))), trip.riderUserId, trip.bookedByUserId]);
    for (; radius < config.radiiMeters.length; radius++) {
      let candidates: NearbyDriver[];
      try {
        candidates = await location.nearby({
          cityId: trip.cityId, vehicleType: trip.vehicleType, lat: trip.pickupLat, lng: trip.pickupLng,
          radiusMeters: config.radiiMeters[radius]!, limit: 20, cashOnly: trip.paymentMethod === "CASH",
        });
      } catch (err) {
        logger.warn({ tripId, err: (err as Error).message }, "location-service unavailable, retrying");
        return now() + 2000;
      }
      candidates = candidates.filter((d) => !skip.has(d.driverId));
      if (candidates.length === 0) continue;

      for (const c of await rank(candidates, { lat: trip.pickupLat, lng: trip.pickupLng })) {
        // soft reservation: the driver isn't being offered another trip right now
        const reserved = await redis.set(locationKeys.offer(c.driverId), tripId, "EX", config.offerSeconds, "NX");
        if (reserved !== "OK") continue;
        const expiresAt = new Date(now() + config.offerSeconds * 1000);
        let offer;
        try {
          offer = await db.tripOffer.create({
            data: { tripId, driverUserId: c.driverId, etaSeconds: c.etaSeconds, distanceMeters: c.distanceMeters, expiresAt, offeredAt: new Date(now()) },
          });
        } catch {
          // another worker opened an offer for this trip meanwhile (ux_trip_offer_open)
          await redis.del(locationKeys.offer(c.driverId));
          return now() + 500;
        }
        await redis.hset(state(tripId), "radius", String(radius));
        const view = tripView(trip);
        realtime.toUser(c.driverId, "trip:offer", {
          tripId, offerId: offer.id, expiresAt: expiresAt.toISOString(), etaToPickupSeconds: c.etaSeconds,
          pickup: view.pickup, dropoff: view.dropoff, vehicleType: trip.vehicleType,
          fare: { estimateMinor: view.fare.estimateMinor, currency: view.fare.currency }, paymentMethod: trip.paymentMethod,
        });
        return expiresAt.getTime();
      }
    }
    // nobody free in the widest radius: keep looking there until the timeout
    await redis.hset(state(tripId), "radius", String(config.radiiMeters.length - 1));
    return now() + 3000;
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const due = await redis.zrangebyscore(DUE, "-inf", String(now()), "LIMIT", 0, 20);
      for (const tripId of due) {
        if ((await redis.set(lease(tripId), owner, "PX", 5000, "NX")) !== "OK") continue;
        try {
          const next = await step(tripId);
          if (next === null) await control.stop(tripId);
          else await redis.zadd(DUE, "XX", next, tripId);
        } catch (err) {
          logger.error({ tripId, err: (err as Error).message }, "matching step failed");
          await redis.zadd(DUE, "XX", now() + 2000, tripId);
        } finally {
          await redis.del(lease(tripId));
        }
      }
    } finally {
      busy = false;
    }
  }

  return {
    control,
    tick,
    step,
    start(intervalMs = 250) {
      timer = setInterval(() => void tick().catch((err) => logger.error({ err: (err as Error).message }, "matcher tick failed")), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
