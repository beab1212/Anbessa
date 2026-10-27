// GET /api/trips/:id/parties: the people and car on a trip as the other side sees them. The rider
// gets the driver's name and the car (plate, make, model, colour); the driver gets the rider's
// name; staff get both. Never phone numbers: a name that is still the placeholder phone number is
// left out. Cached per trip for 60 s; an unreachable upstream degrades to nulls, not an error.

import type { Redis } from "ioredis";
import { can, type Principal } from "@ride-app/shared-authz";
import type { Logger } from "@ride-app/shared-utils";
import type { Trip } from "../generated/prisma/client.js";
import type { PartiesClient, PublicVehicle } from "../lib/clients.js";

const TTL_SECONDS = 60;

interface Parties {
  driverName: string | null;
  driverPhoto: string | null;
  riderName: string | null;
  riderPhoto: string | null;
  vehicle: Omit<PublicVehicle, "id"> | null;
}

/** Sign-up stores the phone number as the name until the person sets one. */
const shownName = (name: string | null) => (name && !/^\+?[\d\s-]{7,}$/.test(name.trim()) ? name.trim() : null);

export function createParties(deps: { redis: Redis; client: PartiesClient; logger: Logger; ratingOf?: (userId: string) => Promise<{ average: number | null; count: number }> }) {
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
    const [rider, driver, vehicle] = await Promise.all([
      safe("rider", client.user(t.riderUserId)),
      t.driverUserId ? safe("driver", client.user(t.driverUserId)) : null,
      t.vehicleId ? safe("vehicle", client.vehicle(t.vehicleId)) : null,
    ]);
    const parties: Parties = {
      riderName: shownName(rider?.name ?? null),
      riderPhoto: rider?.image ?? null,
      driverName: shownName(driver?.name ?? null),
      driverPhoto: driver?.image ?? null,
      vehicle: vehicle ? { plateNumber: vehicle.plateNumber, vehicleType: vehicle.vehicleType, make: vehicle.make, model: vehicle.model, color: vehicle.color } : null,
    };
    await redis.set(key, JSON.stringify(parties), "EX", TTL_SECONDS);
    return parties;
  }

  return {
    /** For a share link's viewer: the driver's first name and photo and the car, nothing more. */
    async forShare(t: Trip) {
      if (!t.driverUserId) return { driver: null, vehicle: null };
      const parties = await load(t);
      return { driver: { firstName: parties.driverName?.split(/\s+/)[0] ?? null, photo: parties.driverPhoto }, vehicle: parties.vehicle };
    },

    /** The view for this reader (the trip must already be readable by them). */
    async forTrip(t: Trip, p: Principal) {
      const parties = await load(t);
      const staff = p.audience === "ride-admin";
      const rider = p.userId === t.riderUserId || p.userId === t.bookedByUserId;
      const driver = !!t.driverUserId && p.userId === t.driverUserId;
      // the company the trip is billed to sees what its rider sees (who's driving, which car);
      // the fleet that owns the car sees its driver and car, not the rider
      const company = !staff && !!t.billingOrgId && can(p, "trip:read", { orgId: t.billingOrgId });
      const fleet = !staff && t.vehicleOwnerType === "ORGANIZATION" && !!t.beneficiaryId && can(p, "trip:read", { orgId: t.beneficiaryId });
      const seesDriver = rider || staff || company || fleet;
      // the driver's average shows once it means something (three ratings)
      const r = seesDriver && t.driverUserId && deps.ratingOf ? await deps.ratingOf(t.driverUserId).catch(() => null) : null;
      return {
        tripId: t.id,
        driver: seesDriver && t.driverUserId ? { name: parties.driverName, photo: parties.driverPhoto, rating: r && r.count >= 3 ? r.average : null, ratingCount: r?.count ?? 0 } : null,
        vehicle: seesDriver ? parties.vehicle : null,
        rider: driver || staff || company ? { name: parties.riderName, photo: parties.riderPhoto } : null,
      };
    },
  };
}

export type PartiesService = ReturnType<typeof createParties>;
