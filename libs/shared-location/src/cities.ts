// Where Anbessa operates. Shared by mapping-service (bounds geocoding, refuses requests
// outside the service area) and trip-service (which city a pickup belongs to).

import type { LatLng } from "./geo.js";

export interface BBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/** Ethiopia */
export const SERVICE_AREA: BBox = { minLng: 32.9, minLat: 3.3, maxLng: 48.1, maxLat: 15.0 };
export const COUNTRY_CODES = "et";

/** Served cities (ids match auth-service's `city` table). */
export const CITIES: Record<string, BBox> = {
  "addis-ababa": { minLng: 38.63, minLat: 8.83, maxLng: 38.92, maxLat: 9.1 },
  hawassa: { minLng: 38.42, minLat: 6.98, maxLng: 38.54, maxLat: 7.12 },
};

export const inBox = (p: LatLng, b: BBox) => p.lng >= b.minLng && p.lng <= b.maxLng && p.lat >= b.minLat && p.lat <= b.maxLat;
export const inServiceArea = (p: LatLng) => inBox(p, SERVICE_AREA);

/** The served city containing the point, if any. */
export function cityAt(p: LatLng): string | undefined {
  return Object.entries(CITIES).find(([, box]) => inBox(p, box))?.[0];
}
