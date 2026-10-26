// Where Anbessa operates and what it offers (platform-service): cities with their map area, and the
// vehicle types (service levels) per city. Changes reach every service within seconds.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { allowed, api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { Drawer, Field, PageHead, Pill, Problem } from "../../components/ui";

interface City { id: string; name: string; timezone: string; enabled: boolean; minLat: number; minLng: number; maxLat: number; maxLng: number }
interface VehicleType { code: string; name: string; seatsMin: number; seatsMax: number; enabled: boolean; cities: string[] }

export function CitiesPage() {
  const { staff } = useSession();
  const canEdit = allowed(staff.principal, "city:manage");
  const cities = useQuery({ queryKey: ["admin-cities"], queryFn: () => api<{ cities: City[] }>("staff", "/api/platform/cities").then((r) => r.cities) });
  const types = useQuery({ queryKey: ["admin-vehicle-types"], queryFn: () => api<{ vehicleTypes: VehicleType[] }>("staff", "/api/platform/vehicle-types").then((r) => r.vehicleTypes) });
  const [city, setCity] = useState<City | "new" | null>(null);
  const [type, setType] = useState<VehicleType | "new" | null>(null);
  const name = (id: string) => cities.data?.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="page stack" style={{ gap: "1.25rem" }}>
      <PageHead title="Cities and vehicle types" lede="Where riders can book and drivers can work, and which service levels each city offers." />
      <Problem error={cities.error ?? types.error} />

      <section className="card">
        <div className="card-head"><h2>Cities</h2>{canEdit ? <button className="btn sm" onClick={() => setCity("new")}><Plus /> Add a city</button> : null}</div>
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead><tr><th>City</th><th>Status</th><th>Time zone</th><th>Map area (south-west → north-east)</th><th /></tr></thead>
            <tbody>
              {cities.data?.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.name}</strong> <span className="mono xs muted">{c.id}</span></td>
                  <td>{c.enabled ? <Pill tone="green">open</Pill> : <Pill tone="grey">closed</Pill>}</td>
                  <td className="small">{c.timezone}</td>
                  <td className="mono xs">{c.minLat.toFixed(3)}, {c.minLng.toFixed(3)} → {c.maxLat.toFixed(3)}, {c.maxLng.toFixed(3)}</td>
                  <td>{canEdit ? <button className="link" onClick={() => setCity(c)}>edit</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Vehicle types</h2>{canEdit ? <button className="btn sm" onClick={() => setType("new")}><Plus /> Add a type</button> : null}</div>
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead><tr><th>Type</th><th>Seats</th><th>Offered in</th><th>Status</th><th /></tr></thead>
            <tbody>
              {types.data?.map((t) => (
                <tr key={t.code}>
                  <td><strong>{t.name}</strong> <span className="mono xs muted">{t.code}</span></td>
                  <td className="mono">{t.seatsMin}–{t.seatsMax}</td>
                  <td className="small">{t.cities.length ? t.cities.map(name).join(", ") : "every city"}</td>
                  <td>{t.enabled ? <Pill tone="green">on</Pill> : <Pill tone="grey">off</Pill>}</td>
                  <td>{canEdit ? <button className="link" onClick={() => setType(t)}>edit</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="xs muted" style={{ padding: "0 1.1rem 1rem", margin: 0 }}>A new type also needs its fares (Settings → Fares, when the built-in fares are in use) before riders can be quoted.</p>
      </section>

      {city ? <CityDrawer city={city === "new" ? null : city} onClose={() => setCity(null)} /> : null}
      {type ? <TypeDrawer type={type === "new" ? null : type} cities={cities.data ?? []} onClose={() => setType(null)} /> : null}
    </div>
  );
}

function CityDrawer({ city, onClose }: { city: City | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    id: city?.id ?? "", name: city?.name ?? "", timezone: city?.timezone ?? "Africa/Addis_Ababa", enabled: city?.enabled ?? false,
    minLat: String(city?.minLat ?? ""), minLng: String(city?.minLng ?? ""), maxLat: String(city?.maxLat ?? ""), maxLng: String(city?.maxLng ?? ""),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name, timezone: f.timezone, enabled: f.enabled, bbox: { minLat: Number(f.minLat), minLng: Number(f.minLng), maxLat: Number(f.maxLat), maxLng: Number(f.maxLng) } };
      return city ? api("staff", `/api/platform/cities/${city.id}`, { method: "PUT", body }) : api("staff", "/api/platform/cities", { body: { id: f.id, ...body } });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-cities"] });
      void qc.invalidateQueries({ queryKey: ["client-config"] });
      onClose();
    },
  });
  return (
    <Drawer title={city ? `Edit ${city.name}` : "Add a city"} onClose={onClose}>
      <form className="stack" style={{ gap: "0.25rem" }} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Problem error={save.error} />
        {!city ? <Field label="Id" className="mono" required value={f.id} onChange={set("id")} placeholder="bahir-dar" hint="Lower case, dashes; can't change later" /> : null}
        <Field label="Name" required value={f.name} onChange={set("name")} />
        <Field label="Time zone" required value={f.timezone} onChange={set("timezone")} />
        <span className="label" style={{ marginTop: "0.5rem" }}>Map area: the box riders and drivers must be in</span>
        <div className="two-col" style={{ gap: "0 0.75rem" }}>
          <Field label="South (min latitude)" inputMode="decimal" required value={f.minLat} onChange={set("minLat")} />
          <Field label="West (min longitude)" inputMode="decimal" required value={f.minLng} onChange={set("minLng")} />
          <Field label="North (max latitude)" inputMode="decimal" required value={f.maxLat} onChange={set("maxLat")} />
          <Field label="East (max longitude)" inputMode="decimal" required value={f.maxLng} onChange={set("maxLng")} />
        </div>
        <label className="option" style={{ marginBottom: "0.75rem" }}>
          <input type="checkbox" checked={f.enabled} onChange={(e) => setF((x) => ({ ...x, enabled: e.target.checked }))} />
          <span><strong>Open</strong> <span className="muted small">riders can book and drivers can work here</span></span>
        </label>
        <button className="btn" disabled={save.isPending}>{city ? "Save" : "Add the city"}</button>
        <p className="xs muted">The city's staff team (for city roles) is created with it.</p>
      </form>
    </Drawer>
  );
}

function TypeDrawer({ type, cities, onClose }: { type: VehicleType | null; cities: City[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: type?.code ?? "", name: type?.name ?? "", seatsMin: String(type?.seatsMin ?? 3), seatsMax: String(type?.seatsMax ?? 4), enabled: type?.enabled ?? false, cities: type?.cities ?? [] });
  const save = useMutation({
    mutationFn: () => api("staff", `/api/platform/vehicle-types/${type?.code ?? f.code}`, { method: "PUT", body: { name: f.name, seatsMin: Number(f.seatsMin), seatsMax: Number(f.seatsMax), enabled: f.enabled, cities: f.cities } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-vehicle-types"] });
      void qc.invalidateQueries({ queryKey: ["client-config"] });
      onClose();
    },
  });
  return (
    <Drawer title={type ? `Edit ${type.name}` : "Add a vehicle type"} onClose={onClose}>
      <form className="stack" style={{ gap: "0.25rem" }} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Problem error={save.error} />
        {!type ? <Field label="Code" className="mono" required value={f.code} onChange={(e) => setF((x) => ({ ...x, code: e.target.value }))} placeholder="electric" hint="Lower case; drivers' apps and matching use it" /> : null}
        <Field label="Name" required value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} />
        <div className="two-col" style={{ gap: "0 0.75rem" }}>
          <Field label="Seats from" inputMode="numeric" value={f.seatsMin} onChange={(e) => setF((x) => ({ ...x, seatsMin: e.target.value }))} />
          <Field label="to" inputMode="numeric" value={f.seatsMax} onChange={(e) => setF((x) => ({ ...x, seatsMax: e.target.value }))} />
        </div>
        <span className="label">Offered in (none ticked = every city)</span>
        <div className="options">
          {cities.map((c) => (
            <label key={c.id} className="option">
              <input type="checkbox" checked={f.cities.includes(c.id)} onChange={(e) => setF((x) => ({ ...x, cities: e.target.checked ? [...x.cities, c.id] : x.cities.filter((y) => y !== c.id) }))} />
              {c.name}
            </label>
          ))}
        </div>
        <label className="option" style={{ marginBottom: "0.75rem" }}>
          <input type="checkbox" checked={f.enabled} onChange={(e) => setF((x) => ({ ...x, enabled: e.target.checked }))} />
          <span><strong>On</strong> <span className="muted small">riders can choose it</span></span>
        </label>
        <button className="btn" disabled={save.isPending}>Save</button>
      </form>
    </Drawer>
  );
}
