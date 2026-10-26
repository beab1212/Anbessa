import { useEffect, useId, useMemo, useState } from "react";
import { MapPin, X } from "lucide-react";
import { api, type Surface } from "../lib/api";

export interface Place {
  name: string;
  label?: string;
  lat: number;
  lng: number;
}

/**
 * Places dispatchers and call-center agents use every day. Shown first, and the only list
 * when address search (Nominatim) isn't available. Coordinates are approximate entrances.
 */
export const COMMON_PLACES: Record<string, Place[]> = {
  "addis-ababa": [
    { name: "Bole International Airport", label: "Departures, Bole", lat: 8.9779, lng: 38.7993 },
    { name: "Meskel Square", label: "Kirkos", lat: 9.0107, lng: 38.7613 },
    { name: "Piassa", label: "St George's Cathedral, Arada", lat: 9.0362, lng: 38.7507 },
    { name: "Merkato", label: "Addis Ketema", lat: 9.0309, lng: 38.738 },
    { name: "Arat Kilo", label: "Arada", lat: 9.0333, lng: 38.7631 },
    { name: "Sidist Kilo", label: "Addis Ababa University", lat: 9.0412, lng: 38.7614 },
    { name: "Edna Mall", label: "Bole", lat: 8.9946, lng: 38.7891 },
    { name: "Mexico Square", label: "Kirkos", lat: 9.0101, lng: 38.7451 },
    { name: "Megenagna", label: "Yeka", lat: 9.0204, lng: 38.8015 },
    { name: "CMC", label: "Yeka", lat: 9.0218, lng: 38.8436 },
  ],
};

export function PlacePicker({ label, cityId, surface, value, onChange, hint }: { label: string; cityId: string; surface: Surface; value: Place | null; onChange: (p: Place | null) => void; hint?: string }) {
  const id = useId();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState<{ q: string; places: Place[] } | null>(null);
  const [searchDown, setSearchDown] = useState(false);
  const text = q.trim();
  const local = useMemo(
    () => (COMMON_PLACES[cityId] ?? []).filter((p) => `${p.name} ${p.label ?? ""}`.toLowerCase().includes(text.toLowerCase())),
    [cityId, text],
  );

  useEffect(() => {
    if (text.length < 2) return;
    // debounced like the phone app (workflow 05 step 2)
    const t = setTimeout(async () => {
      try {
        const r = await api<{ results: Place[] }>(surface, `/api/maps/search?${new URLSearchParams({ q: text, cityId })}`);
        setSearchDown(false);
        setRemote({ q: text, places: r.results });
      } catch {
        setSearchDown(true);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [text, cityId, surface]);

  const common = COMMON_PLACES[cityId] ?? [];
  const results = remote?.q === text ? [...local, ...remote.places.filter((x) => !local.some((l) => l.name === x.name))].slice(0, 8) : local;
  const shown = text.length >= 2 ? results : common.slice(0, 6);

  if (value) {
    return (
      <div className="field">
        <span className="label">{label}</span>
        <div className="place-chosen">
          <MapPin />
          <span>
            <strong>{value.name}</strong>
            {value.label ? <span className="muted small"> · {value.label}</span> : null}
          </span>
          <button type="button" className="icon-btn" aria-label="Change" onClick={() => onChange(null)}><X /></button>
        </div>
      </div>
    );
  }

  return (
    <div className="field combobox">
      <label className="label" htmlFor={id}>{label}</label>
      <input id={id} className="input" value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} placeholder="Search a place or tap the map" autoComplete="off" />
      {hint ? <span className="hint">{hint}</span> : null}
      {open ? (
        <ul className="combobox-list" role="listbox">
          {shown.map((p) => (
            <li key={`${p.name}-${p.lat}`}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(p); setOpen(false); }}>
                <MapPin />
                <span><strong>{p.name}</strong>{p.label ? <span className="muted"> · {p.label}</span> : null}</span>
              </button>
            </li>
          ))}
          {shown.length === 0 ? <li className="muted small" style={{ padding: "0.5rem 0.75rem" }}>No matches.</li> : null}
          {searchDown ? <li className="muted xs" style={{ padding: "0.4rem 0.75rem" }}>Address search is offline: common places only.</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
