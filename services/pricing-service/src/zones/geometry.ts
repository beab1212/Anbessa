// Zone polygons: one closed ring of [lng, lat] pairs (GeoJSON order). Validation and
// point-in-polygon are done here, in plain arithmetic: city-sized polygons with at most a few
// hundred vertices, so planar math on degrees is accurate enough and needs no PostGIS.

import { CITIES, type LatLng } from "@ride-app/shared-location";

export type Ring = [number, number][];

export const MAX_VERTICES = 500;

export type GeometryProblem =
  | "too_few_points"
  | "too_many_points"
  | "invalid_coordinate"
  | "self_intersecting"
  | "outside_city"
  | "unknown_city"
  | "zero_area";

/** Close the ring if the caller left it open; drop consecutive duplicates. */
export function normalizeRing(points: [number, number][]): Ring {
  const out: Ring = [];
  for (const p of points) {
    const last = out.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push([p[0], p[1]]);
  }
  const first = out[0];
  const last = out.at(-1);
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) out.push([first[0], first[1]]);
  return out;
}

const orient = (a: [number, number], b: [number, number], c: [number, number]) => {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return v > 1e-15 ? 1 : v < -1e-15 ? -1 : 0;
};
const onSegment = (a: [number, number], b: [number, number], p: [number, number]) =>
  Math.min(a[0], b[0]) - 1e-12 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-12 && Math.min(a[1], b[1]) - 1e-12 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-12;

function segmentsIntersect(p1: [number, number], p2: [number, number], q1: [number, number], q2: [number, number]): boolean {
  const o1 = orient(p1, p2, q1);
  const o2 = orient(p1, p2, q2);
  const o3 = orient(q1, q2, p1);
  const o4 = orient(q1, q2, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, p2, q2)) return true;
  if (o3 === 0 && onSegment(q1, q2, p1)) return true;
  if (o4 === 0 && onSegment(q1, q2, p2)) return true;
  return false;
}

/** Twice the signed area (shoelace); 0 for a degenerate ring. */
export function signedArea2(ring: Ring): number {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
  return s;
}

/** null when the ring is a valid zone of `cityId`, else the first problem found. */
export function checkRing(ring: Ring, cityId: string): GeometryProblem | null {
  const box = CITIES[cityId];
  if (!box) return "unknown_city";
  // closed ring: n distinct vertices + the repeated first one
  if (ring.length < 4) return "too_few_points";
  if (ring.length > MAX_VERTICES + 1) return "too_many_points";
  for (const [lng, lat] of ring) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) return "invalid_coordinate";
    if (lng < box.minLng || lng > box.maxLng || lat < box.minLat || lat > box.maxLat) return "outside_city";
  }
  const n = ring.length - 1; // edges
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // adjacent edges share a vertex; so do the first and the last
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsIntersect(ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!)) return "self_intersecting";
    }
  }
  if (Math.abs(signedArea2(ring)) < 1e-10) return "zero_area";
  return null;
}

/** Ray casting; points on the boundary count as inside. */
export function containsPoint(ring: Ring, p: LatLng): boolean {
  const x = p.lng;
  const y = p.lat;
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (orient([xi, yi], [xj, yj], [x, y]) === 0 && onSegment([xi, yi], [xj, yj], [x, y])) return true;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const GEOMETRY_MESSAGES: Record<GeometryProblem, string> = {
  too_few_points: "a zone needs at least 3 distinct points",
  too_many_points: `a zone can have at most ${MAX_VERTICES} points`,
  invalid_coordinate: "a point is not a valid longitude/latitude",
  self_intersecting: "the outline crosses itself",
  outside_city: "the zone must be inside the city",
  unknown_city: "unknown city",
  zero_area: "the zone has no area",
};
