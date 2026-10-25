// mapping-service client (the only way to reach OSRM).

import type { LatLng } from "@ride-app/shared-location";

export interface Mapping {
  table(sources: LatLng[], destinations: LatLng[]): Promise<{ durations: (number | null)[][]; approximate: boolean }>;
}

export function mappingClient(baseUrl: string, token: string, timeoutMs = 2500): Mapping {
  return {
    async table(sources, destinations) {
      const res = await fetch(new URL("/internal/table", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ sources, destinations }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`mapping-service ${res.status}`);
      return (await res.json()) as { durations: (number | null)[][]; approximate: boolean };
    },
  };
}
