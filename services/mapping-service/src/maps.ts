// Routing and geocoding for the rest of the system (architecture §10).
//
// - Every point must be inside the service area: the engines are never asked about anything else.
// - Results are cached in Redis. Coordinates are rounded to ~11 m first, so nearby requests share entries.
// - If OSRM is down or slow, route and table answers fall back to straight-line distance ×
//   a detour factor at an average city speed, flagged `approximate: true` (workflow 05, failures).
//   Approximate answers are never cached.

import { haversineMeters, type LatLng } from "@ride-app/shared-location";
import type { Logger } from "@ride-app/shared-utils";
import { badRequest, notFound } from "./lib/errors.js";
import { cacheKey, type Cache } from "./lib/cache.js";
import { EngineError, type Breaker } from "./engines/http.js";
import type { NominatimClient, Place } from "./engines/nominatim.js";
import type { OsrmClient, RouteResult, SnapResult, TableResult } from "./engines/osrm.js";
import { CITIES, inServiceArea } from "./regions.js";

export const LIMITS = { maxWaypoints: 10, maxTableCells: 625, maxTableSide: 50, maxSearchLength: 120 };

export const FALLBACK = {
  /** road distance ≈ straight line × this, typical for city grids */
  detourFactor: 1.35,
  /** average urban driving speed used when OSRM can't answer (22 km/h) */
  speedMps: 22 / 3.6,
};

const TTL = { route: 3600, table: 600, snap: 86_400, search: 86_400, reverse: 86_400 };

const round = (p: LatLng): LatLng => ({ lat: Math.round(p.lat * 1e4) / 1e4, lng: Math.round(p.lng * 1e4) / 1e4 });

function assertInArea(points: LatLng[]) {
  for (const p of points) if (!inServiceArea(p)) throw badRequest("location is outside the service area", "outside_service_area");
}

export function createMaps(deps: { osrm: OsrmClient; nominatim: NominatimClient; osrmBreaker: Breaker; nominatimBreaker: Breaker; cache: Cache; logger: Logger }) {
  const { osrm, nominatim, cache, logger } = deps;

  async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
    const hit = await cache.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await fn();
    await cache.set(key, value, ttl);
    return value;
  }

  /** OSRM failed for a reason other than "no route": log once per call and use the fallback. */
  const degraded = (op: string, err: unknown) => {
    if (err instanceof EngineError && err.status !== undefined && err.status < 500) throw err;
    logger.warn({ op, err: (err as Error).message }, "osrm unavailable, using straight-line estimate");
  };

  const estimate = (a: LatLng, b: LatLng) => {
    const meters = haversineMeters(a, b) * FALLBACK.detourFactor;
    return { distanceMeters: Math.round(meters), durationSeconds: Math.round(meters / FALLBACK.speedMps) };
  };

  return {
    async route(points: LatLng[], withGeometry = false): Promise<RouteResult & { approximate: boolean }> {
      if (points.length < 2 || points.length > LIMITS.maxWaypoints) throw badRequest(`2–${LIMITS.maxWaypoints} points required`);
      assertInArea(points);
      const pts = points.map(round);
      try {
        const r = await cached(cacheKey("route", [pts, withGeometry]), TTL.route, () => deps.osrmBreaker.run(() => osrm.route(pts, withGeometry)));
        return { ...r, approximate: false };
      } catch (err) {
        if (err instanceof EngineError && err.status === 404) throw notFound("route");
        degraded("route", err);
        let distanceMeters = 0;
        let durationSeconds = 0;
        for (let i = 1; i < points.length; i++) {
          const leg = estimate(points[i - 1]!, points[i]!);
          distanceMeters += leg.distanceMeters;
          durationSeconds += leg.durationSeconds;
        }
        return { distanceMeters, durationSeconds, approximate: true };
      }
    },

    async table(sources: LatLng[], destinations: LatLng[]): Promise<TableResult & { approximate: boolean }> {
      if (!sources.length || !destinations.length) throw badRequest("sources and destinations are required");
      if (sources.length > LIMITS.maxTableSide || destinations.length > LIMITS.maxTableSide || sources.length * destinations.length > LIMITS.maxTableCells) {
        throw badRequest(`at most ${LIMITS.maxTableCells} cells (${LIMITS.maxTableSide} per side)`);
      }
      assertInArea([...sources, ...destinations]);
      const s = sources.map(round);
      const d = destinations.map(round);
      try {
        const t = await cached(cacheKey("table", [s, d]), TTL.table, () => deps.osrmBreaker.run(() => osrm.table(s, d)));
        return { ...t, approximate: false };
      } catch (err) {
        degraded("table", err);
        const cells = sources.map((a) => destinations.map((b) => estimate(a, b)));
        return {
          durations: cells.map((row) => row.map((c) => c.durationSeconds)),
          distances: cells.map((row) => row.map((c) => c.distanceMeters)),
          approximate: true,
        };
      }
    },

    /** Snap a GPS point to the nearest road (pickup pins). Falls back to the point itself. */
    async snap(p: LatLng): Promise<SnapResult & { approximate: boolean }> {
      assertInArea([p]);
      try {
        const r = await cached(cacheKey("snap", round(p)), TTL.snap, () => deps.osrmBreaker.run(() => osrm.nearest(round(p))));
        return { ...r, approximate: false };
      } catch (err) {
        if (!(err instanceof EngineError && err.status === 404)) degraded("snap", err);
        return { ...p, name: "", distanceMeters: 0, approximate: true };
      }
    },

    async search(q: { text: string; cityId?: string; language?: string; limit?: number }): Promise<Place[]> {
      const text = q.text.trim().replace(/\s+/g, " ");
      if (text.length < 2 || text.length > LIMITS.maxSearchLength) throw badRequest(`query must be 2–${LIMITS.maxSearchLength} characters`);
      const viewbox = q.cityId ? CITIES[q.cityId] : undefined;
      if (q.cityId && !viewbox) throw badRequest("unknown city");
      const params = { text: text.toLowerCase(), cityId: q.cityId ?? "", language: q.language ?? "en", limit: Math.min(q.limit ?? 8, 10) };
      return cached(cacheKey("search", params), TTL.search, () =>
        deps.nominatimBreaker.run(() => nominatim.search({ text, viewbox, limit: params.limit, language: params.language })),
      ).then((places) => places.filter(inServiceArea));
    },

    async reverse(p: LatLng, language = "en"): Promise<Place> {
      assertInArea([p]);
      const place = await cached(cacheKey("reverse", [round(p), language]), TTL.reverse, () =>
        deps.nominatimBreaker.run(() => nominatim.reverse(round(p), language)),
      );
      if (!place) throw notFound("address");
      return place;
    },
  };
}

export type Maps = ReturnType<typeof createMaps>;
