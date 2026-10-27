// Trip facts from trip-service (GET /internal/trips/:id, service token). support-service never
// reads trip-service's database; it asks once when a ticket, lost item or SOS is created and keeps
// what it needs (city, parties) on its own rows.

import { AppError } from "./errors.js";

export interface TripFacts {
  id: string;
  status: string;
  cityId: string;
  riderUserId: string;
  bookedByUserId: string | null;
  driverUserId: string | null;
  billingOrgId: string | null;
  /** the fleet organisation for ORGANIZATION vehicles */
  fleetOrgId: string | null;
  completedAt: Date | null;
}

export interface TripLookup {
  /** null = no such trip. Throws TripServiceUnavailable when trip-service can't answer. */
  get(tripId: string): Promise<TripFacts | null>;
}

export class TripServiceUnavailable extends AppError {
  constructor() {
    super(503, "trip-service is unavailable; try again", "dependency_unavailable");
  }
}

interface InternalTrip {
  id: string;
  status: string;
  cityId: string;
  riderUserId: string;
  bookedByUserId?: string | null;
  driver: { userId: string } | null;
  billing: { orgId: string | null };
  beneficiary?: { type: "INDIVIDUAL" | "ORGANIZATION"; id: string } | null;
  times: { completedAt: string | null };
}

export function tripLookup(tripInternalUrl: string, token: string): TripLookup {
  return {
    async get(tripId) {
      let res: Response;
      try {
        res = await fetch(new URL(`/internal/trips/${tripId}`, tripInternalUrl), {
          headers: { authorization: `Bearer ${token}`, "x-service-name": "support-service" },
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        throw new TripServiceUnavailable();
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new TripServiceUnavailable();
      const t = (await res.json()) as InternalTrip;
      return {
        id: t.id,
        status: t.status,
        cityId: t.cityId,
        riderUserId: t.riderUserId,
        bookedByUserId: t.bookedByUserId ?? null,
        driverUserId: t.driver?.userId ?? null,
        billingOrgId: t.billing.orgId,
        fleetOrgId: t.beneficiary?.type === "ORGANIZATION" ? t.beneficiary.id : null,
        completedAt: t.times.completedAt ? new Date(t.times.completedAt) : null,
      };
    },
  };
}
