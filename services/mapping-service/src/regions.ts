// Where Anbessa operates. Requests outside the service area are refused before they reach
// the engines (they only hold Ethiopian data anyway). Per-city viewboxes bound geocoding,
// so "Bole" means Bole in Addis Ababa, not somewhere else in the country.

import type { LatLng } from "@ride-app/shared-location";

export interface BBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export const SERVICE_AREA: BBox = { minLng: 32.9, minLat: 3.3, maxLng: 48.1, maxLat: 15.0 }; // Ethiopia
export const COUNTRY_CODES = "et";

export const CITIES: Record<string, BBox> = {
  "addis-ababa": { minLng: 38.63, minLat: 8.83, maxLng: 38.92, maxLat: 9.1 },
  hawassa: { minLng: 38.42, minLat: 6.98, maxLng: 38.54, maxLat: 7.12 },
};

export const inBox = (p: LatLng, b: BBox) => p.lng >= b.minLng && p.lng <= b.maxLng && p.lat >= b.minLat && p.lat <= b.maxLat;
export const inServiceArea = (p: LatLng) => inBox(p, SERVICE_AREA);
