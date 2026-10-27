// Internal HTTP clients (service token). Each call has a hard timeout; callers decide
// what a failure means.

import type { LatLng } from "@ride-app/shared-location";

async function call<T>(base: string, token: string, path: string, init: RequestInit = {}, timeoutMs = 2500): Promise<T> {
  const res = await fetch(new URL(path, base), {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) throw new NotFoundUpstream(path);
  if (!res.ok) throw new Error(`${new URL(base).port || base} ${path}: http ${res.status}`);
  return (await res.json()) as T;
}

export class NotFoundUpstream extends Error {}

export interface NearbyDriver {
  driverId: string;
  lat: number;
  lng: number;
  distanceMeters: number;
  cashAllowed: boolean;
  vehicleId: string;
  at: number;
}

export interface DriverLive {
  driverId: string;
  status: "available" | "on_trip" | "offline";
  cityId: string;
  vehicleType: string;
  vehicleId: string;
  fleetOrgId?: string;
  tripId?: string;
  cashAllowed: boolean;
  /** the beneficiary's balance state (payment-service); BLOCKED takes no trips at all */
  balanceState?: string;
  lat?: number;
  lng?: number;
  heading?: number;
  at?: number;
  stale: boolean;
}

export interface LocationClient {
  nearby(q: { cityId: string; vehicleType: string; lat: number; lng: number; radiusMeters: number; limit: number; cashOnly: boolean }): Promise<NearbyDriver[]>;
  driver(driverId: string): Promise<DriverLive | null>;
}

export function locationClient(base: string, token: string): LocationClient {
  return {
    async nearby(q) {
      const qs = new URLSearchParams(Object.entries(q).map(([k, v]): [string, string] => [k, String(v)]));
      return (await call<{ drivers: NearbyDriver[] }>(base, token, `/internal/drivers/nearby?${qs}`)).drivers;
    },
    async driver(driverId) {
      try {
        return await call<DriverLive>(base, token, `/internal/drivers/${driverId}`);
      } catch (err) {
        if (err instanceof NotFoundUpstream) return null;
        throw err;
      }
    },
  };
}

export interface MappingClient {
  table(sources: LatLng[], destinations: LatLng[]): Promise<{ durations: (number | null)[][]; approximate: boolean }>;
  route(points: LatLng[], geometry?: boolean): Promise<{ distanceMeters: number; durationSeconds: number; approximate: boolean; geometry?: string }>;
}

export function mappingClient(base: string, token: string): MappingClient {
  return {
    table: (sources, destinations) => call(base, token, "/internal/table", { method: "POST", body: JSON.stringify({ sources, destinations }) }),
    route: (points, geometry = false) => call(base, token, "/internal/route", { method: "POST", body: JSON.stringify({ points, geometry }) }),
  };
}

export interface PublicVehicle {
  id: string;
  plateNumber: string;
  vehicleType: string;
  make: string;
  model: string;
  color: string;
}

/** Who is on the other side of a trip: auth-service names, fleet-service cars. */
export interface PublicUser {
  name: string;
  /** a small photo as a data URL, when the person set one */
  image?: string | null;
}

export interface PartiesClient {
  user(userId: string): Promise<PublicUser | null>;
  vehicle(vehicleId: string): Promise<PublicVehicle | null>;
}

export function partiesClient(authBase: string, fleetBase: string, token: string): PartiesClient {
  const orNull = async <T>(p: Promise<T>) => {
    try {
      return await p;
    } catch (err) {
      if (err instanceof NotFoundUpstream) return null;
      throw err;
    }
  };
  return {
    user: (userId) => orNull(call<PublicUser>(authBase, token, `/internal/users/${userId}`)),
    vehicle: (vehicleId) => orNull(call<PublicVehicle>(fleetBase, token, `/internal/vehicles/${vehicleId}`)),
  };
}
