// mapping-service's route endpoint (service token, hard timeout). It answers with a straight-line
// estimate marked `approximate` while OSRM is down, so a quote is still possible.

import type { LatLng } from "@ride-app/shared-location";

export interface MappingClient {
  route(points: LatLng[]): Promise<{ distanceMeters: number; durationSeconds: number; approximate: boolean }>;
}

export function mappingClient(base: string, token: string): MappingClient {
  return {
    async route(points) {
      const res = await fetch(new URL("/internal/route", base), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ points }),
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) throw new Error(`mapping-service /internal/route: http ${res.status}`);
      return (await res.json()) as { distanceMeters: number; durationSeconds: number; approximate: boolean };
    },
  };
}
