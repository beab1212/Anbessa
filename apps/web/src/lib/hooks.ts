import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Permission } from "@ride-app/shared-authz";
import type { Trip } from "@ride-app/shared-types";
import { api, citiesFor } from "./api";
import { CITIES } from "./format";
import { useSession } from "./session";

/** The current time, ticking every `ms`: a stable "now" for a render. */
export function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** The staff member's cities for a permission, and the one they're looking at. */
export function useStaffCity(permission: Permission) {
  const { staff } = useSession();
  const cities = citiesFor(staff.principal, permission, CITIES);
  const [picked, setPicked] = useState<string | null>(null);
  return { cities, cityId: picked && cities.includes(picked) ? picked : (cities[0] ?? null), setCityId: setPicked };
}

export interface LiveDriver {
  driverId: string;
  status: "available" | "on_trip" | "offline";
  vehicleType: string;
  vehicleId: string;
  tripId?: string;
  lat?: number;
  lng?: number;
  heading?: number;
  at?: number;
  stale: boolean;
}

export function useCityDrivers(cityId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["drivers", cityId],
    enabled: !!cityId && enabled,
    refetchInterval: 5000,
    queryFn: () => api<{ drivers: LiveDriver[] }>("staff", `/api/locations/cities/${cityId}/drivers`).then((r) => r.drivers),
  });
}

export function useBoard(cityId: string | null) {
  return useQuery({
    queryKey: ["board", cityId],
    enabled: !!cityId,
    refetchInterval: 8000,
    queryFn: () => api<{ trips: Trip[] }>("staff", `/api/trips/board?cityId=${cityId}`).then((r) => r.trips),
  });
}
