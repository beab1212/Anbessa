import { CITY_NAMES } from "../lib/format";

/** Staff work city by city; most only have one, so this is just a label then. */
export function CityPicker({ cities, value, onChange }: { cities: string[]; value: string | null; onChange: (c: string) => void }) {
  if (cities.length <= 1) return <span className="pill grey">{value ? CITY_NAMES[value] ?? value : "no city"}</span>;
  return (
    <select className="select" aria-label="City" value={value ?? ""} onChange={(e) => onChange(e.target.value)} style={{ width: "auto", height: "2rem", fontSize: "0.8125rem" }}>
      {cities.map((c) => <option key={c} value={c}>{CITY_NAMES[c] ?? c}</option>)}
    </select>
  );
}
