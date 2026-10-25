// OSRM HTTP API v1 (car profile): /route, /table, /nearest. Coordinates are lng,lat.

import type { LatLng } from "@ride-app/shared-location";
import { EngineError, getJson } from "./http.js";

interface OsrmResponse {
  code: string;
  message?: string;
}

export interface RouteResult {
  distanceMeters: number;
  durationSeconds: number;
  /** encoded polyline, precision 6 (when requested) */
  geometry?: string;
}

export interface TableResult {
  /** seconds; null where no route exists */
  durations: (number | null)[][];
  distances: (number | null)[][];
}

export interface SnapResult extends LatLng {
  name: string;
  distanceMeters: number;
}

const coord = (p: LatLng) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;

export function osrmClient(baseUrl: string, timeoutMs: number) {
  async function call<T extends OsrmResponse>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const body = await getJson<T>("osrm", url, timeoutMs);
    if (body.code === "NoRoute" || body.code === "NoSegment") throw new EngineError("osrm", body.code, 404);
    if (body.code !== "Ok") throw new EngineError("osrm", body.code ?? "error", 400);
    return body;
  }

  return {
    async route(points: LatLng[], withGeometry: boolean): Promise<RouteResult> {
      const r = await call<OsrmResponse & { routes: { distance: number; duration: number; geometry?: string }[] }>(
        `/route/v1/driving/${points.map(coord).join(";")}`,
        { overview: withGeometry ? "full" : "false", geometries: "polyline6", steps: "false", alternatives: "false" },
      );
      const best = r.routes[0];
      if (!best) throw new EngineError("osrm", "NoRoute", 404);
      return {
        distanceMeters: Math.round(best.distance),
        durationSeconds: Math.round(best.duration),
        ...(withGeometry && best.geometry ? { geometry: best.geometry } : {}),
      };
    },

    async table(sources: LatLng[], destinations: LatLng[]): Promise<TableResult> {
      const all = [...sources, ...destinations];
      const r = await call<OsrmResponse & { durations: (number | null)[][]; distances: (number | null)[][] }>(
        `/table/v1/driving/${all.map(coord).join(";")}`,
        {
          sources: sources.map((_, i) => i).join(";"),
          destinations: destinations.map((_, i) => i + sources.length).join(";"),
          annotations: "duration,distance",
        },
      );
      const round = (m: (number | null)[][]) => m.map((row) => row.map((v) => (v === null ? null : Math.round(v))));
      return { durations: round(r.durations), distances: round(r.distances) };
    },

    async nearest(p: LatLng): Promise<SnapResult> {
      const r = await call<OsrmResponse & { waypoints: { location: [number, number]; distance: number; name: string }[] }>(
        `/nearest/v1/driving/${coord(p)}`,
        { number: "1" },
      );
      const w = r.waypoints[0];
      if (!w) throw new EngineError("osrm", "NoSegment", 404);
      return { lng: w.location[0], lat: w.location[1], name: w.name, distanceMeters: Math.round(w.distance) };
    },
  };
}

export type OsrmClient = ReturnType<typeof osrmClient>;
