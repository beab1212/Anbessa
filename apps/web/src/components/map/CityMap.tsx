// A MapLibre map for one city. Markers are React children that register with the map
// through context, so pages only describe what's on the map, never how.

import * as maplibregl from "maplibre-gl";
import type { LngLatLike, Map as MapLibre } from "maplibre-gl";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CITIES, type LatLng } from "@ride-app/shared-location";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";

// MapLibre looks for its worker next to its own module, which isn't there once Vite has
// bundled it (dev or build). Point it at the worker file Vite serves / emits.
maplibregl.setWorkerUrl(workerUrl);

export const MAP_STYLE_URL = import.meta.env.VITE_MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/liberty";

const MapCtx = createContext<MapLibre | null>(null);
export const useMap = () => useContext(MapCtx);

export interface CityMapProps {
  cityId: string;
  /** when these change, the view fits them (plus padding); empty = the city box */
  fit?: LatLng[];
  /** fit only once, then leave the view to the user */
  fitOnce?: boolean;
  onClick?: (p: LatLng) => void;
  interactive?: boolean;
  /** `boxed` = sits inside the page with rounded corners, else fills its positioned parent */
  boxed?: boolean;
  children?: ReactNode;
}

export function CityMap({ cityId, fit, fitOnce = false, onClick, interactive = true, boxed = false, children }: CityMapProps) {
  const el = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibre | null>(null);
  const [offline, setOffline] = useState(false);
  const fitted = useRef(false);
  const onClickRef = useRef(onClick);
  useEffect(() => {
    onClickRef.current = onClick;
  });

  useEffect(() => {
    if (!el.current) return;
    const box = CITIES[cityId] ?? CITIES["addis-ababa"]!;
    const m = new maplibregl.Map({
      container: el.current,
      style: MAP_STYLE_URL,
      bounds: [box.minLng, box.minLat, box.maxLng, box.maxLat],
      fitBoundsOptions: { padding: 24 },
      attributionControl: { compact: true },
      interactive,
      dragRotate: false,
      pitchWithRotate: false,
    });
    if (interactive) m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    m.on("error", (e) => {
      // style or tile fetch failed: keep the panel usable, say so on the map
      if (/style|source|tile|fetch/i.test(String(e.error?.message ?? ""))) setOffline(true);
    });
    m.on("load", () => setOffline(false));
    m.on("click", (e) => onClickRef.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
    setMap(m);
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
      setMap(null);
    };
  }, [cityId, interactive]);

  const fitKey = fit?.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join("|") ?? "";
  useEffect(() => {
    if (!map) return;
    if (fitOnce && fitted.current) return;
    const box = CITIES[cityId] ?? CITIES["addis-ababa"]!;
    const pts = fit ?? [];
    if (pts.length === 0) {
      map.fitBounds([box.minLng, box.minLat, box.maxLng, box.maxLat], { padding: 24, duration: 0 });
      return;
    }
    fitted.current = true;
    if (pts.length === 1) {
      map.easeTo({ center: [pts[0]!.lng, pts[0]!.lat], zoom: Math.max(map.getZoom(), 14), duration: 300 });
      return;
    }
    const b = new maplibregl.LngLatBounds();
    for (const p of pts) b.extend([p.lng, p.lat] as LngLatLike);
    map.fitBounds(b, { padding: 80, maxZoom: 15, duration: 300 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fitKey, cityId, fitOnce]);

  const ctx = useMemo(() => map, [map]);
  return (
    <div className={`map ${boxed ? "boxed" : ""}`}>
      <div ref={el} style={{ position: "absolute", inset: 0 }} />
      {offline ? <div className="map-offline">Map tiles unavailable. Positions still update.</div> : null}
      <MapCtx.Provider value={ctx}>{children}</MapCtx.Provider>
    </div>
  );
}
