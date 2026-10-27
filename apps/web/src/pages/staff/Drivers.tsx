import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { allowed } from "../../lib/api";
import { clock, shortId, since } from "../../lib/format";
import { useCityDrivers, useNow, useStaffCity, type LiveDriver } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { carLine, driverState, filterDrivers, useTripParties, vehicleTypesOf, type DriverState } from "../../lib/trips";
import { CityMap } from "../../components/map/CityMap";
import { DriverMarker } from "../../components/map/markers";
import { CityPicker } from "../../components/CityPicker";
import { Drawer, Empty, Pill, Problem } from "../../components/ui";

const FILTERS: [DriverState, string][] = [["all", "All"], ["free", "Free"], ["trip", "On a trip"], ["silent", "Silent"]];

const statePill = (d: LiveDriver) => (d.stale ? <Pill tone="grey">silent</Pill> : d.status === "on_trip" ? <Pill tone="green">on a trip</Pill> : <Pill tone="blue">free</Pill>);

/** Ops map (location:read_live @ CITY): every online driver, live. */
export function Drivers() {
  const { cities, cityId, setCityId } = useStaffCity("location:read_live");
  const drivers = useCityDrivers(cityId);
  const [filter, setFilter] = useState<DriverState>("all");
  const [vehicleType, setVehicleType] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const list = useMemo(() => (drivers.data ?? []).filter((d) => d.lat !== undefined && d.lng !== undefined), [drivers.data]);
  const types = useMemo(() => vehicleTypesOf(list), [list]);
  // a type that has gone offline drops back to "all"
  const type = vehicleType === "all" || types.includes(vehicleType) ? vehicleType : "all";
  const ofType = useMemo(() => filterDrivers(list, { state: "all", vehicleType: type }), [list, type]);
  const shown = useMemo(() => filterDrivers(ofType, { state: filter, vehicleType: "all" }), [ofType, filter]);
  const counts = { free: ofType.filter((d) => driverState(d) === "free").length, trip: ofType.filter((d) => driverState(d) === "trip").length, silent: ofType.filter((d) => driverState(d) === "silent").length };
  const sel = list.find((d) => d.driverId === selected);
  const fit = useMemo(() => (sel ? [{ lat: sel.lat!, lng: sel.lng! }] : shown.map((d) => ({ lat: d.lat!, lng: d.lng! }))), [sel, shown]);
  const detail = list.find((d) => d.driverId === open) ?? null;
  const pick = (id: string) => {
    setSelected(id === selected ? null : id);
    setOpen(id === selected ? null : id);
  };

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
              onClick={() => pick(d.driverId)}
            />
          ))}
        </CityMap>
      </div>
      <aside className="panel">
        <div className="panel-head stack" style={{ gap: "0.6rem" }}>
          <div className="row between">
            <strong>Drivers online <span className="muted">{list.length}</span></strong>
            <CityPicker cities={cities} value={cityId} onChange={(c) => { setCityId(c); setSelected(null); setOpen(null); }} />
          </div>
          <div className="row between" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
            <div className="chips" role="group" aria-label="Driver state">
              {FILTERS.map(([f, label]) => (
                <button key={f} type="button" className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {label}{f !== "all" ? ` ${counts[f]}` : ""}
                </button>
              ))}
            </div>
            {types.length > 1 ? (
              <select className="select" aria-label="Car type" value={type} onChange={(e) => setVehicleType(e.target.value)} style={{ width: "auto", height: "2rem", fontSize: "0.8125rem" }}>
                <option value="all">All cars</option>
                {types.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            ) : null}
          </div>
        </div>
        <div className="panel-body" style={{ padding: 0, gap: 0 }}>
          <Problem error={drivers.error} />
          {drivers.isLoading ? <p className="muted small" style={{ padding: "0.75rem 1rem" }}>Loading drivers…</p> : null}
          {list.length === 0 && !drivers.isLoading && !drivers.error ? <Empty title="No one online">Drivers appear here from their first ping.</Empty> : null}
          {list.length > 0 && shown.length === 0 ? <Empty title="No match">No online driver matches these filters.</Empty> : null}
          {shown.length > 0 ? (
            <table className="table">
              <thead><tr><th>Driver</th><th>Car</th><th>State</th><th className="num">Ping</th></tr></thead>
              <tbody>
                {shown.map((d) => (
                  <tr
                    key={d.driverId} tabIndex={0} aria-selected={d.driverId === selected}
                    onClick={() => pick(d.driverId)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick(d.driverId))}
                    style={{ cursor: "pointer", background: d.driverId === selected ? "var(--accent-soft)" : undefined }}
                  >
                    <td className="mono">{shortId(d.driverId)}</td>
                    <td>{d.vehicleType}<div className="xs muted mono">{shortId(d.vehicleId)}</div></td>
                    <td>{statePill(d)}</td>
                    <td className="num mono">{clock(d.at ? new Date(d.at) : null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
        <div className="panel-foot xs muted">Silent = no ping for 20 s. Silent drivers leave matching until they ping again.</div>
      </aside>

      {detail ? <DriverDrawer driver={detail} cityId={cityId} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

/** One driver as the live feed sees them, with links to their record and current trip. */
function DriverDrawer({ driver: d, cityId, onClose }: { driver: LiveDriver; cityId: string; onClose: () => void }) {
  const { staff } = useSession();
  const now = useNow(5000);
  const canRecord = allowed(staff.principal, "driver:read", { cityId });
  const canTrip = allowed(staff.principal, "trip:read", { cityId });
  // the trip's parties carry the driver's name and plate; there's no name lookup for a free driver here
  const parties = useTripParties(d.tripId, canTrip);
  const p = parties.data;
  return (
    <Drawer title={p?.driver?.name ?? `Driver ${shortId(d.driverId)}`} onClose={onClose}>
      <div className="stack">
        <dl className="kv">
          <dt>State</dt><dd>{statePill(d)}</dd>
          <dt>Last ping</dt><dd>{clock(d.at ? new Date(d.at) : null)} <span className="muted small">· {d.at ? since(new Date(d.at), now) : "—"}</span></dd>
          <dt>Position</dt><dd className="mono small">{d.lat?.toFixed(5)}, {d.lng?.toFixed(5)}{d.heading !== undefined ? ` · heading ${Math.round(d.heading)}°` : ""}</dd>
          <dt>Car</dt><dd>{p?.vehicle ? <>{carLine(p.vehicle)} · <span className="mono">{p.vehicle.plateNumber}</span></> : d.vehicleType} <span className="mono xs muted">{d.vehicleId}</span></dd>
          <dt>Driver id</dt><dd className="mono xs">{d.driverId}</dd>
          {d.tripId ? <><dt>Trip</dt><dd className="mono small">{shortId(d.tripId)}{p?.rider?.name ? <span className="muted"> · rider {p.rider.name}</span> : null}</dd></> : null}
        </dl>
        {d.stale ? <p className="small muted" style={{ margin: 0 }}>No ping for over 20 s: the app may be closed or offline. Matching skips this driver until it pings again.</p> : null}
        <div className="row">
          {canRecord ? <Link className="btn secondary sm" to={`/staff/fleet/drivers/${d.driverId}`}>Driver record</Link> : null}
          {d.tripId && canTrip ? <Link className="btn ghost sm" to={`/staff/trips/${d.tripId}`}>Open trip</Link> : null}
        </div>
      </div>
    </Drawer>
  );
}
