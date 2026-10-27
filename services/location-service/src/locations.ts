// Read side of live location: matching candidates, ETA to pickup, ops map, trip tracking.

import type { Redis } from "ioredis";
import {
  cityAt, cityDrivers, getDriverState, haversineMeters, isTripMember, keys, nearbyAvailable,
  type DriverState, type LatLng, type NearbyDriver,
} from "@ride-app/shared-location";
import { authorize, type Principal } from "@ride-app/shared-authz";
import type { Logger } from "@ride-app/shared-utils";
import { notFound } from "./lib/errors.js";
import type { Mapping } from "./lib/mapping.js";

/** used when mapping-service can't answer: same assumptions as its own fallback */
const FALLBACK_SPEED_MPS = 22 / 3.6;
const FALLBACK_DETOUR = 1.35;

export interface NearbyQuery extends LatLng {
  cityId: string;
  vehicleType: string;
  radiusMeters: number;
  limit: number;
  cashOnly?: boolean;
}

export function createLocations(deps: { redis: Redis; mapping: Mapping; logger: Logger; now?: () => number }) {
  const { redis, mapping, logger } = deps;
  const now = deps.now ?? Date.now;

  return {
    /** Workflow 05, step 12: candidates nearest first. Ranking by ETA is the matcher's next step. */
    nearby: (q: NearbyQuery): Promise<NearbyDriver[]> => nearbyAvailable(redis, q, now()),

    /**
     * Workflow 05, step 6: "a driver can reach you in ~N min" on the quote screen.
     * Real driving time for the closest few drivers (OSRM table), straight-line estimate if mapping is down.
     */
    async etaToPickup(q: Omit<NearbyQuery, "radiusMeters" | "limit">) {
      const drivers = await nearbyAvailable(redis, { ...q, radiusMeters: 6000, limit: 5 }, now());
      if (drivers.length === 0) return { etaSeconds: null, driversNearby: 0, approximate: false };
      let durations: (number | null)[];
      let approximate: boolean;
      try {
        const t = await mapping.table(drivers.map((d) => ({ lat: d.lat, lng: d.lng })), [{ lat: q.lat, lng: q.lng }]);
        durations = t.durations.map((row) => row[0] ?? null);
        approximate = t.approximate;
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "mapping-service unavailable, estimating ETA");
        durations = drivers.map((d) => (haversineMeters(d, q) * FALLBACK_DETOUR) / FALLBACK_SPEED_MPS);
        approximate = true;
      }
      const known = durations.filter((d): d is number => d !== null);
      return { etaSeconds: known.length ? Math.round(Math.min(...known)) : null, driversNearby: drivers.length, approximate };
    },

    /**
     * Rider home: the cars around you. Anonymous (no ids, no plates), positions on a ~30 m grid,
     * at most 15 within 2 km, with the ETA of the nearest one. Every vehicle type of the city
     * unless one is asked for. Outside the served cities: nothing.
     */
    async nearbyPublic(q: LatLng & { vehicleType?: string }) {
      const cityId = cityAt(q);
      if (!cityId) return { cars: [], etaSeconds: null, driversNearby: 0, approximate: false };
      const types = q.vehicleType ? [q.vehicleType] : await redis.smembers(keys.vehicleTypes(cityId));
      const seen = new Map<string, NearbyDriver>();
      for (const vehicleType of types) {
        for (const d of await nearbyAvailable(redis, { ...q, cityId, vehicleType, radiusMeters: 2000, limit: 15 }, now())) seen.set(d.driverId, d);
      }
      const drivers = [...seen.values()].sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, 15);
      const grid = (v: number) => Math.round(v / 0.0003) * 0.0003;
      const cars = drivers.map((d) => ({ lat: Number(grid(d.lat).toFixed(4)), lng: Number(grid(d.lng).toFixed(4)), ...(d.heading !== undefined ? { heading: Math.round(d.heading) } : {}) }));
      const nearest = drivers[0];
      let etaSeconds: number | null = null;
      let approximate = false;
      if (nearest) {
        try {
          const t = await mapping.table([{ lat: nearest.lat, lng: nearest.lng }], [{ lat: q.lat, lng: q.lng }]);
          etaSeconds = t.durations[0]?.[0] ?? null;
          approximate = t.approximate;
        } catch {
          etaSeconds = Math.round((nearest.distanceMeters * FALLBACK_DETOUR) / FALLBACK_SPEED_MPS);
          approximate = true;
        }
      }
      return { cars, etaSeconds, driversNearby: drivers.length, approximate };
    },

    driver: (driverId: string) => getDriverState(redis, driverId),

    /** Ops map: every online driver in the city (location:read_live @ CITY). */
    async cityDrivers(principal: Principal, cityId: string) {
      authorize(principal, "location:read_live", { cityId });
      return (await cityDrivers(redis, cityId)).map(publicView);
    },

    /**
     * Rider screen: the trip's driver position. The trip's rider and driver may see it;
     * a fleet owner may see their own vehicle's driver (location:read_live @ ORG).
     */
    async tripDriver(principal: Principal, tripId: string) {
      const last = await redis.hgetall(keys.tripLast(tripId));
      const member = await isTripMember(redis, tripId, principal.userId);
      if (!member) {
        const driver = last.driverId ? await getDriverState(redis, last.driverId) : null;
        // 404 rather than 403: don't confirm that someone else's trip exists
        if (!driver?.fleetOrgId || driver.tripId !== tripId) throw notFound("trip");
        try {
          authorize(principal, "location:read_live", { orgId: driver.fleetOrgId });
        } catch {
          throw notFound("trip");
        }
      }
      if (!last.lat) throw notFound("driver position");
      return {
        tripId,
        driverId: last.driverId,
        lat: Number(last.lat),
        lng: Number(last.lng),
        heading: last.heading ? Number(last.heading) : undefined,
        at: Number(last.at),
      };
    },
  };
}

const publicView = (s: DriverState) => ({
  driverId: s.driverId,
  status: s.status,
  vehicleType: s.vehicleType,
  vehicleId: s.vehicleId,
  tripId: s.tripId,
  lat: s.lat,
  lng: s.lng,
  heading: s.heading,
  at: s.at,
  stale: s.stale,
});

export type Locations = ReturnType<typeof createLocations>;
