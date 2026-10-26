import { useMemo, useState } from "react";
import { clock, shortId } from "../../lib/format";
import { useCityDrivers, useStaffCity, type LiveDriver } from "../../lib/hooks";
import { CityMap } from "../../components/map/CityMap";
import { DriverMarker } from "../../components/map/markers";
import { CityPicker } from "../../components/CityPicker";
import { Empty, Pill, Problem } from "../../components/ui";

type Filter = "all" | "free" | "trip" | "silent";
const FILTERS: [Filter, string][] = [["all", "All"], ["free", "Free"], ["trip", "On a trip"], ["silent", "Silent"]];

const kind = (d: LiveDriver): Filter => (d.stale ? "silent" : d.status === "on_trip" ? "trip" : "free");

/** Ops map (location:read_live @ CITY): every online driver, live. */
export function Drivers() {
  const { cities, cityId, setCityId } = useStaffCity("location:read_live");
  const drivers = useCityDrivers(cityId);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const list = useMemo(() => (drivers.data ?? []).filter((d) => d.lat !== undefined && d.lng !== undefined), [drivers.data]);
  const shown = list.filter((d) => filter === "all" || kind(d) === filter);
  const counts = { free: list.filter((d) => kind(d) === "free").length, trip: list.filter((d) => kind(d) === "trip").length, silent: list.filter((d) => kind(d) === "silent").length };
  const sel = list.find((d) => d.driverId === selected);
  const fit = useMemo(() => (sel ? [{ lat: sel.lat!, lng: sel.lng! }] : shown.map((d) => ({ lat: d.lat!, lng: d.lng! }))), [sel, shown]);

  if (!cityId) return <div className="content"><Empty title="No city">Your roles don't include a city to watch.</Empty></div>;

  return (
    <div className="workspace">
      <div className="map-area">
        <div className="stats-float">
          <div className="stat"><span className="label">Free</span><div className="value">{counts.free}</div></div>
          <div className="stat"><span className="label">On a trip</span><div className="value">{counts.trip}</div></div>
          <div className={`stat ${counts.silent ? "urgent" : ""}`}><span className="label">Silent</span><div className="value">{counts.silent}</div></div>
        </div>
        <CityMap cityId={cityId} fit={fit} fitOnce={!sel}>
          {shown.map((d) => (
            <DriverMarker
              key={d.driverId} lat={d.lat!} lng={d.lng!} heading={d.heading} onTrip={d.status === "on_trip"} stale={d.stale}
              selected={d.driverId === selected} title={`${shortId(d.driverId)} · ${d.vehicleType}`}
              onClick={() => setSelected(d.driverId === selected ? null : d.driverId)}
            />
          ))}
        </CityMap>
      </div>
      <aside className="panel">
        <div className="panel-head stack" style={{ gap: "0.6rem" }}>
          <div className="row between">
            <strong>Drivers online <span className="muted">{list.length}</span></strong>
            <CityPicker cities={cities} value={cityId} onChange={setCityId} />
          </div>
          <div className="chips">
            {FILTERS.map(([f, label]) => (
              <button key={f} type="button" className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {label}{f !== "all" ? ` ${counts[f]}` : ""}
              </button>
            ))}
          </div>
        </div>
        <div className="panel-body" style={{ padding: 0, gap: 0 }}>
          <Problem error={drivers.error} />
          {list.length === 0 && !drivers.isLoading ? <Empty title="No one online">Drivers appear here from their first ping.</Empty> : null}
          <table className="table">
            <thead><tr><th>Driver</th><th>Car</th><th>State</th><th className="num">Ping</th></tr></thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.driverId} onClick={() => setSelected(d.driverId === selected ? null : d.driverId)} style={{ cursor: "pointer", background: d.driverId === selected ? "var(--accent-soft)" : undefined }}>
                  <td className="mono">{shortId(d.driverId)}</td>
                  <td>{d.vehicleType}<div className="xs muted mono">{d.vehicleId}</div></td>
                  <td>{d.stale ? <Pill tone="grey">silent</Pill> : d.status === "on_trip" ? <Pill tone="green">on a trip</Pill> : <Pill tone="blue">free</Pill>}</td>
                  <td className="num mono">{clock(d.at ? new Date(d.at) : null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel-foot xs muted">Silent = no ping for 20 s. Silent drivers leave matching until they ping again.</div>
      </aside>
    </div>
  );
}
