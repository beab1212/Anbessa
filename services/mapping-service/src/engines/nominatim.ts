// Nominatim (self-hosted): /search and /reverse, JSON v2.

import type { LatLng } from "@ride-app/shared-location";
import type { BBox } from "../regions.js";
import { getJson } from "./http.js";

export interface Place extends LatLng {
  /** short name to show first ("Bole International Airport") */
  name: string;
  /** full address line */
  label: string;
  category: string;
  type: string;
}

interface NominatimPlace {
  lat: string;
  lon: string;
  name?: string;
  display_name: string;
  category?: string;
  type?: string;
}

const toPlace = (p: NominatimPlace): Place => ({
  lat: Number(p.lat),
  lng: Number(p.lon),
  name: p.name?.trim() || p.display_name.split(",")[0]!.trim(),
  label: p.display_name,
  category: p.category ?? "",
  type: p.type ?? "",
});

export function nominatimClient(baseUrl: string, timeoutMs: number, countryCodes: string) {
  // identifies us in the engine's logs (and is required by the public instance's usage policy)
  const headers = { "user-agent": "Anbessa mapping-service" };

  return {
    async search(q: { text: string; viewbox?: BBox; near?: LatLng; limit: number; language: string }): Promise<Place[]> {
      const url = new URL("/search", baseUrl);
      url.searchParams.set("q", q.text);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("countrycodes", countryCodes);
      url.searchParams.set("limit", String(q.limit));
      url.searchParams.set("accept-language", q.language);
      if (q.viewbox) {
        const b = q.viewbox;
        url.searchParams.set("viewbox", `${b.minLng},${b.maxLat},${b.maxLng},${b.minLat}`);
        url.searchParams.set("bounded", "1");
      }
      const rows = await getJson<NominatimPlace[]>("nominatim", url, timeoutMs, headers);
      return Array.isArray(rows) ? rows.map(toPlace) : [];
    },

    async reverse(p: LatLng, language: string): Promise<Place | null> {
      const url = new URL("/reverse", baseUrl);
      url.searchParams.set("lat", String(p.lat));
      url.searchParams.set("lon", String(p.lng));
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("zoom", "18");
      url.searchParams.set("accept-language", language);
      const row = await getJson<NominatimPlace & { error?: string }>("nominatim", url, timeoutMs, headers);
      return row && !row.error && row.display_name ? toPlace(row) : null;
    },
  };
}

export type NominatimClient = ReturnType<typeof nominatimClient>;
