// Kafka events that change driver state in Redis (contracts: libs/shared-types/src/events.ts).
// Handlers are idempotent: replaying an event leaves the same state.

import type { Redis } from "ioredis";
import { z } from "zod";
import { applyBalanceState, assertCity, assertVehicleType, endTrip, goOffline, goOnline, reassignTrip, startTrip } from "@ride-app/shared-location";

const id = z.string().uuid();
const city = z.string().refine((c) => { try { assertCity(c); return true; } catch { return false; } }, "invalid city id");
const vehicleType = z.string().refine((t) => { try { assertVehicleType(t); return true; } catch { return false; } }, "invalid vehicle type");

export const schemas = {
  "driver.online": z.object({
    driverId: id, vehicleId: z.string().min(1).max(64), vehicleType, cityId: city,
    fleetOrgId: id.optional(), beneficiaryId: id.optional(), cashAllowed: z.boolean(), balanceState: z.string().max(20).optional(),
  }),
  "driver.offline": z.object({ driverId: id, reason: z.string().max(40) }),
  "trip.matched": z.object({ tripId: id, riderId: id, driverId: id, bookedById: id.optional(), billingOrgId: id.optional() }),
  "trip.completed": z.object({ tripId: id, driverId: id.optional() }),
  "trip.cancelled": z.object({ tripId: id, driverId: id.optional() }),
  // a dispatcher took a matched trip from its driver: to another driver, or back to matching (no toDriverId)
  "trip.reassigned": z.object({ tripId: id, riderId: id, fromDriverId: id, toDriverId: id.optional() }),
  // payment-service: cash trips pause at the cash limit, all trips when blocked (Payment.md §8)
  "balance.state_changed": z.object({
    beneficiary: z.object({ type: z.enum(["INDIVIDUAL", "ORGANIZATION"]), id }),
    state: z.enum(["OK", "WARNING", "CASH_BLOCKED", "BLOCKED"]), cashAllowed: z.boolean(),
  }),
};

export type Topic = keyof typeof schemas;
export const TOPICS = Object.keys(schemas) as Topic[];

export function createHandlers(redis: Redis): Record<Topic, (payload: unknown) => Promise<void>> {
  const ended = async (payload: unknown) => {
    const e = schemas["trip.completed"].parse(payload);
    if (e.driverId) await endTrip(redis, { tripId: e.tripId, driverId: e.driverId });
  };
  return {
    "driver.online": async (payload) => goOnline(redis, schemas["driver.online"].parse(payload)),
    "driver.offline": async (payload) => goOffline(redis, schemas["driver.offline"].parse(payload).driverId),
    "trip.matched": async (payload) => startTrip(redis, schemas["trip.matched"].parse(payload)),
    "trip.completed": ended,
    "trip.cancelled": ended,
    "trip.reassigned": async (payload) => reassignTrip(redis, schemas["trip.reassigned"].parse(payload)),
    "balance.state_changed": async (payload) => {
      const e = schemas["balance.state_changed"].parse(payload);
      await applyBalanceState(redis, { beneficiaryId: e.beneficiary.id, state: e.state, cashAllowed: e.cashAllowed });
    },
  };
}
