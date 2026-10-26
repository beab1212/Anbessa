// GET /api/trips/:id/parties: the people and car on a trip as the other side sees them. The rider
// gets the driver's name and the car (plate, make, model, colour); the driver gets the rider's
// name; staff get both. Never phone numbers: a name that is still the placeholder phone number is
// left out. Cached per trip for 60 s; an unreachable upstream degrades to nulls, not an error.

import type { Redis } from "ioredis";
import type { Principal } from "@ride-app/shared-authz";
import type { Logger } from "@ride-app/shared-utils";
import type { Trip } from "../generated/prisma/client.js";
import type { PartiesClient, PublicVehicle } from "../lib/clients.js";

const TTL_SECONDS = 60;

interface Parties {
  driverName: string | null;
  riderName: string | null;
  vehicle: Omit<PublicVehicle, "id"> | null;
}

/** Sign-up stores the phone number as the name until the person sets one. */
const shownName = (name: string | null) => (name && !/^\+?[\d\s-]{7,}$/.test(name.trim()) ? name.trim() : null);

export function createParties(deps: { redis: Redis; client: PartiesClient; logger: Logger }) {
  const { redis, client, logger } = deps;

  async function load(t: Trip): Promise<Parties> {
    const key = `trip:parties:${t.id}:${t.driverUserId ?? "-"}:${t.vehicleId ?? "-"}`;
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as Parties;
    const safe = async <T>(what: string, p: Promise<T>) => {
      try {
        return await p;
      } catch (err) {
        logger.warn({ err, tripId: t.id }, `parties: ${what} unavailable`);
        return null;
      }
    };
    const [riderName, driverName, vehicle] = await Promise.all([
      safe("rider name", client.userName(t.riderUserId)),
      t.driverUserId ? safe("driver name", client.userName(t.driverUserId)) : null,
      t.vehicleId ? safe("vehicle", client.vehicle(t.vehicleId)) : null,
    ]);
    const parties: Parties = {
      riderName: shownName(riderName),
      driverName: shownName(driverName),
      vehicle: vehicle ? { plateNumber: vehicle.plateNumber, vehicleType: vehicle.vehicleType, make: vehicle.make, model: vehicle.model, color: vehicle.color } : null,
    };
    await redis.set(key, JSON.stringify(parties), "EX", TTL_SECONDS);
    return parties;
  }

  return {
    /** The view for this reader (the trip must already be readable by them). */
    async forTrip(t: Trip, p: Principal) {
      const parties = await load(t);
      const staff = p.audience === "ride-admin";
      const rider = p.userId === t.riderUserId || p.userId === t.bookedByUserId;
      const driver = !!t.driverUserId && p.userId === t.driverUserId;
      return {
        tripId: t.id,
        driver: (rider || staff) && t.driverUserId ? { name: parties.driverName, rating: null } : null,
        vehicle: (rider || staff) ? parties.vehicle : null,
        rider: driver || staff ? { name: parties.riderName } : null,
      };
    },
  };
}

export type PartiesService = ReturnType<typeof createParties>;
