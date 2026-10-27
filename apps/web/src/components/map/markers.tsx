import * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { LatLng } from "@ride-app/shared-location";
import { useMap } from "./CityMap";

interface MarkerProps extends LatLng {
  className: string;
  label?: string;
  title?: string;
  rotation?: number;
  anchor?: "center" | "bottom";
  zIndex?: number;
  onClick?: () => void;
  onHover?: (over: boolean) => void;
}

/** A DOM marker kept in sync with props. */
function DomMarker({ lat, lng, className, label, title, rotation, anchor = "center", zIndex, onClick, onHover }: MarkerProps) {
  const map = useMap();
  const ref = useRef<{ marker: maplibregl.Marker; el: HTMLDivElement; inner: HTMLDivElement } | null>(null);
  const handlers = useRef({ onClick, onHover });
  useEffect(() => {
    handlers.current = { onClick, onHover };
  });

  useEffect(() => {
    if (!map) return;
    const el = document.createElement("div");
    el.className = "mk";
    const inner = document.createElement("div");
    el.appendChild(inner);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      handlers.current.onClick?.();
    });
    el.addEventListener("mouseenter", () => handlers.current.onHover?.(true));
    el.addEventListener("mouseleave", () => handlers.current.onHover?.(false));
    const marker = new maplibregl.Marker({ element: el, anchor }).setLngLat([lng, lat]).addTo(map);
    ref.current = { marker, el, inner };
    return () => {
      marker.remove();
      ref.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, anchor]);

  useEffect(() => {
    const r = ref.current;
    if (!r) return;
    r.marker.setLngLat([lng, lat]);
    r.inner.className = className;
    r.inner.style.transform = rotation !== undefined ? `rotate(${rotation}deg)` : "";
    r.el.title = title ?? "";
    r.el.style.zIndex = zIndex !== undefined ? String(zIndex) : "";
    let lbl = r.el.querySelector<HTMLSpanElement>(".mk-label");
    if (label) {
      if (!lbl) {
        lbl = document.createElement("span");
        lbl.className = "mk-label";
        r.el.appendChild(lbl);
      }
      lbl.textContent = label;
    } else lbl?.remove();
  }, [map, lat, lng, className, label, title, rotation, zIndex]); // map: the marker may mount before the map exists

  return null;
}

export function DriverMarker(p: LatLng & { onTrip?: boolean; stale?: boolean; selected?: boolean; heading?: number; title?: string; onClick?: () => void; onHover?: (o: boolean) => void }) {
  return (
    <DomMarker
      lat={p.lat} lng={p.lng}
      className={`mk-driver ${p.onTrip ? "trip" : ""} ${p.stale ? "stale" : ""} ${p.selected ? "selected" : ""}`}
      rotation={p.heading} title={p.title} zIndex={p.selected ? 10 : 1} onClick={p.onClick} onHover={p.onHover}
    />
  );
}

export function PickupMarker(p: LatLng & { tone?: "amber" | "red" | "blue" | "green" | "grey"; selected?: boolean; label?: string; title?: string; onClick?: () => void }) {
  return (
    <DomMarker
      lat={p.lat} lng={p.lng} anchor="bottom"
      className={`mk-pin ${p.tone ?? "amber"} ${p.selected ? "selected" : ""}`}
      label={p.label} title={p.title} zIndex={p.selected ? 11 : 2} onClick={p.onClick}
    />
  );
}

export function DropoffMarker(p: LatLng & { label?: string }) {
  return <DomMarker lat={p.lat} lng={p.lng} className="mk-pin dropoff" label={p.label} zIndex={2} />;
}

/** A dashed straight line between two points (the planned route until route geometry is exposed). */
export function TripLine({ id, from, to }: { id: string; from: LatLng; to: LatLng }) {
  const map = useMap();
  useEffect(() => {
    if (!map) return;
    const src = `line-${id}`;
    const data: Parameters<maplibregl.GeoJSONSource["setData"]>[0] = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[from.lng, from.lat], [to.lng, to.lat]] } };
    const add = () => {
      if (map.getSource(src)) (map.getSource(src) as maplibregl.GeoJSONSource).setData(data);
      else {
        map.addSource(src, { type: "geojson", data });
        map.addLayer({ id: src, type: "line", source: src, paint: { "line-color": "#0f172a", "line-width": 2, "line-dasharray": [2, 2], "line-opacity": 0.7 } });
      }
    };
    if (map.isStyleLoaded()) add();
    else map.once("load", add);
    return () => {
      if (map.getLayer(src)) map.removeLayer(src);
      if (map.getSource(src)) map.removeSource(src);
    };
  }, [map, id, from.lat, from.lng, to.lat, to.lng]);
  return null;
}

/** A road line (casing + fill) through decoded route points. */
export function RouteLine({ id, points, color = "#d97706" }: { id: string; points: LatLng[]; color?: string }) {
  const map = useMap();
  const key = points.length ? `${points.length}:${points[0]!.lat},${points[0]!.lng}:${points.at(-1)!.lat},${points.at(-1)!.lng}` : "";
  useEffect(() => {
    if (!map || points.length < 2) return;
    const src = `route-${id}`;
    const data: Parameters<maplibregl.GeoJSONSource["setData"]>[0] = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: points.map((p) => [p.lng, p.lat]) } };
    const add = () => {
      if (map.getSource(src)) (map.getSource(src) as maplibregl.GeoJSONSource).setData(data);
      else {
        map.addSource(src, { type: "geojson", data });
        map.addLayer({ id: `${src}-casing`, type: "line", source: src, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 8 } });
        map.addLayer({ id: src, type: "line", source: src, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": color, "line-width": 5 } });
      }
    };
    if (map.isStyleLoaded()) add();
    else map.once("load", add);
    return () => {
      for (const l of [src, `${src}-casing`]) if (map.getLayer(l)) map.removeLayer(l);
      if (map.getSource(src)) map.removeSource(src);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, id, key, color]);
  return null;
}
