// location-service's ETA to the pickup, per vehicle type (service token, short timeout). Quotes
// still come when it can't answer: the ETA is simply unknown.

import type { LatLng } from "@ride-app/shared-location";

export interface EtaAnswer {
  etaSeconds: number | null;
  driversNearby: number;
  approximate: boolean;
}

export interface LocationClient {
  etaToPickup(q: LatLng & { cityId: string; vehicleType: string }): Promise<EtaAnswer>;
}

export function locationClient(base: string, token: string, timeoutMs = 1500): LocationClient {
  return {
    async etaToPickup(q) {
      const qs = new URLSearchParams({ lat: String(q.lat), lng: String(q.lng), cityId: q.cityId, vehicleType: q.vehicleType });
      const res = await fetch(new URL(`/internal/eta-to-pickup?${qs}`, base), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`location-service /internal/eta-to-pickup: http ${res.status}`);
      return (await res.json()) as EtaAnswer;
    },
  };
}

/** No location-service (tests, running alone): every ETA unknown. */
export const noLocation: LocationClient = { etaToPickup: async () => ({ etaSeconds: null, driversNearby: 0, approximate: false }) };
