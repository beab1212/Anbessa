import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import type { Trip } from "@ride-app/shared-types";
import { haversineMeters } from "@ride-app/shared-location";
import { allowed, api, newIdempotencyKey } from "../../lib/api";
import { birr, since, shortId, STATUS_LABEL } from "../../lib/format";
import { useBoard, useCityDrivers, useNow, useStaffCity, type LiveDriver } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { CityMap } from "../../components/map/CityMap";
import { DriverMarker, PickupMarker } from "../../components/map/markers";
import { CityPicker } from "../../components/CityPicker";
import { Drawer, Empty, Pill, Problem, TripStatus, tripTone } from "../../components/ui";

const WAITING_TOO_LONG_MS = 60_000;
const where = (t: Trip) => t.pickup.address ?? `${t.pickup.lat.toFixed(3)}, ${t.pickup.lng.toFixed(3)}`;

/** Dispatcher live board (workflow 05, manual assignment): the map is the workspace. */
export function Board() {
  const { staff } = useSession();
  const p = staff.principal;
  const { cities, cityId, setCityId } = useStaffCity("trip:read");
  const board = useBoard(cityId);
  const canAssign = allowed(p, "trip:assign", { cityId: cityId ?? undefined });
  const canCancel = allowed(p, "trip:cancel", { cityId: cityId ?? undefined });
  const drivers = useCityDrivers(cityId, allowed(p, "location:read_live", { cityId: cityId ?? undefined }));
  const [selected, setSelected] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<Trip | null>(null);
  const [changed, setChanged] = useState<string | null>(null);
  const now = useNow(5000);
  const qc = useQueryClient();

  const act = useMutation({
    mutationFn: async (a: { kind: "assign"; tripId: string; driverId: string } | { kind: "cancel"; tripId: string }) =>
      a.kind === "assign"
        ? api<Trip>("staff", `/api/trips/${a.tripId}/assign`, { body: { driverId: a.driverId }, idempotencyKey: newIdempotencyKey() })
        : api<Trip>("staff", `/api/trips/${a.tripId}/cancel`, { body: { reason: "STAFF_DECISION" }, idempotencyKey: newIdempotencyKey() }),
    onSuccess: (t) => {
      setAssigning(null);
      setChanged(t.id);
      void qc.invalidateQueries({ queryKey: ["board"] });
      void qc.invalidateQueries({ queryKey: ["drivers"] });
    },
  });

  const trips = useMemo(() => board.data ?? [], [board.data]);
  const finding = trips.filter((t) => t.status === "requested");
  const late = finding.filter((t) => now - new Date(t.times.requestedAt).getTime() > WAITING_TOO_LONG_MS);
  const free = (drivers.data ?? []).filter((d) => d.status === "available" && !d.stale && d.lat !== undefined);
  const sel = trips.find((t) => t.id === selected) ?? null;
  const fit = useMemo(() => (sel ? [sel.pickup] : trips.map((t) => t.pickup)), [sel, trips]);

  if (!cityId) return <div className="content"><Empty title="No city">Your roles don't include a city to watch.</Empty></div>;

  return (
    <div className="workspace">
      <div className="map-area">
        <div className="stats-float">
          <div className={`stat ${late.length ? "urgent" : ""}`}>
            <span className="label">Finding a driver</span>
            <div className="value">{finding.length}</div>
            {late.length ? <div className="sub">{late.length} over a minute</div> : null}
          </div>
          <div className="stat"><span className="label">Driver on the way</span><div className="value">{trips.filter((t) => t.status === "matched" || t.status === "en_route").length}</div></div>
          <div className="stat"><span className="label">On a trip</span><div className="value">{trips.filter((t) => t.status === "in_progress").length}</div></div>
          {drivers.data ? <div className="stat"><span className="label">Free drivers</span><div className="value">{free.length}</div></div> : null}
        </div>
        <CityMap cityId={cityId} fit={fit} fitOnce={!sel}>
          {free.map((d) => <DriverMarker key={d.driverId} lat={d.lat!} lng={d.lng!} heading={d.heading} title={`driver ${shortId(d.driverId)} · ${d.vehicleType}`} />)}
          {trips.map((t) => (
            <PickupMarker
              key={t.id} lat={t.pickup.lat} lng={t.pickup.lng}
              tone={t.status === "requested" && now - new Date(t.times.requestedAt).getTime() > WAITING_TOO_LONG_MS ? "red" : tripTone(t.status)}
              selected={t.id === selected} label={t.id === selected ? shortId(t.id) : undefined}
              title={`${shortId(t.id)} · ${STATUS_LABEL[t.status]}`} onClick={() => setSelected(t.id === selected ? null : t.id)}
            />
          ))}
        </CityMap>
      </div>

      <aside className="panel">
        <div className="panel-head row between">
          <strong>Active trips <span className="muted">{trips.length}</span></strong>
          <CityPicker cities={cities} value={cityId} onChange={setCityId} />
        </div>
        <div className="panel-body">
          <Problem error={board.error ?? act.error} />
          {board.isLoading ? <p className="muted small">Loading the board…</p> : null}
          {!board.isLoading && trips.length === 0 ? <Empty title="Nothing on the road">No active trips in this city right now.</Empty> : null}
          {trips.map((t) => {
            const urgent = t.status === "requested" && now - new Date(t.times.requestedAt).getTime() > WAITING_TOO_LONG_MS;
            const cancellable = ["requested", "matched", "en_route"].includes(t.status);
            return (
              <div key={t.id} className={`card pad selectable trip-card ${t.id === selected ? "selected" : ""} ${changed === t.id ? "just-changed" : ""}`} onClick={() => setSelected(t.id === selected ? null : t.id)} style={{ padding: "0.75rem 0.85rem" }}>
                <div className="row between" style={{ marginBottom: "0.35rem" }}>
                  {urgent ? <Pill tone="red" pulse>waiting too long</Pill> : <TripStatus status={t.status} label={STATUS_LABEL[t.status] ?? t.status} />}
                  <span className="mono xs muted">{since(t.times.requestedAt, now)}</span>
                </div>
                <div style={{ fontWeight: 500 }}>{where(t)}</div>
                <div className="row between xs muted" style={{ marginTop: "0.25rem" }}>
                  <span>{t.vehicleType} · {t.paymentMethod.toLowerCase().replace("_", " ")} · {t.channel.toLowerCase().replace("_", " ")}</span>
                  <span className="mono">{birr(t.fare.estimateMinor)}</span>
                </div>
                {t.id === selected ? (
                  <div className="row" style={{ marginTop: "0.6rem", gap: "0.5rem" }} onClick={(e) => e.stopPropagation()}>
                    {canAssign && t.status === "requested" ? <button className="btn sm" onClick={() => setAssigning(t)}>Assign driver</button> : null}
                    {canCancel && cancellable ? <button className="btn danger sm" disabled={act.isPending} onClick={() => confirm(`Cancel trip ${shortId(t.id)}? The rider isn't charged.`) && act.mutate({ kind: "cancel", tripId: t.id })}>Cancel</button> : null}
                    <Link className="btn ghost sm" to={`/staff/trips/${t.id}`}><ExternalLink /> Details</Link>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="panel-foot xs muted">Refreshes every few seconds. Red pins have waited over a minute.</div>
      </aside>

      {assigning ? (
        <Drawer title={`Assign trip ${shortId(assigning.id)}`} onClose={() => setAssigning(null)}>
          <AssignPanel trip={assigning} drivers={free} busy={act.isPending} onAssign={(driverId) => act.mutate({ kind: "assign", tripId: assigning.id, driverId })} />
        </Drawer>
      ) : null}
    </div>
  );
}

function AssignPanel({ trip, drivers, busy, onAssign }: { trip: Trip; drivers: LiveDriver[]; busy: boolean; onAssign: (id: string) => void }) {
  const [manual, setManual] = useState("");
  const close = drivers
    .filter((d) => d.vehicleType === trip.vehicleType)
    .map((d) => ({ d, km: haversineMeters(trip.pickup, { lat: d.lat!, lng: d.lng! }) / 1000 }))
    .sort((a, b) => a.km - b.km)
    .slice(0, 5);
  return (
    <div className="stack">
      <div className="kv">
        <dt>Pickup</dt><dd>{where(trip)}</dd>
        <dt>Car</dt><dd>{trip.vehicleType}</dd>
        <dt>Payment</dt><dd>{trip.paymentMethod.toLowerCase().replace("_", " ")}</dd>
      </div>
      <div>
        <span className="label" style={{ marginBottom: "0.4rem" }}>Closest free {trip.vehicleType} drivers (straight line)</span>
        {close.length === 0 ? <p className="small muted">No free {trip.vehicleType} driver online in this city.</p> : (
          <div className="stack" style={{ gap: "0.4rem" }}>
            {close.map(({ d, km }) => (
              <div key={d.driverId} className="card row between" style={{ padding: "0.55rem 0.75rem" }}>
                <span><span className="mono">{shortId(d.driverId)}</span> <span className="muted xs">· {d.vehicleId}</span></span>
                <span className="row" style={{ gap: "0.6rem" }}>
                  <span className="mono xs muted">{km.toFixed(1)} km</span>
                  <button className="btn sm" disabled={busy} onClick={() => onAssign(d.driverId)}>Assign</button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); onAssign(manual.trim()); }}>
        <div className="field">
          <label className="label" htmlFor="manual-driver">Or paste a driver id</label>
          <input id="manual-driver" className="mono" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="01a1…" />
        </div>
        <button className="btn secondary" disabled={busy || manual.trim().length < 36}>Assign this driver</button>
      </form>
    </div>
  );
}
