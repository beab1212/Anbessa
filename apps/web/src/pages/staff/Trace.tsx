// Staff trip tools from trip-service phase 2C, built to be mounted on existing pages:
//
//   <TripTrace trip={t} />       GPS trace of a trip (trip:read_gps_trace: dispatch and safety, CITY).
//                                Every read is audited, so it loads on request with a reason.
//   <ReassignButton trip={t} />  take a matched trip from its driver (trip:reassign: dispatch, CITY)
//   <TripTracePage />            /staff/trips/:tripId/trace, the trace on its own page (police exports)

import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, MapPinned, Shuffle } from "lucide-react";
import type { Trip } from "@ride-app/shared-types";
import { allowed, api, newIdempotencyKey } from "../../lib/api";
import { clock, dayAndTime, shortId } from "../../lib/format";
import { useCityDrivers } from "../../lib/hooks";
import { decodePolyline6 } from "../../lib/polyline";
import { downloadCsv, qs } from "../../lib/reports";
import { useSession } from "../../lib/session";
import { routeSummary } from "../../lib/trips";
import { isReassignable, reassignCandidates, splitTrace, useTripTrace } from "../../lib/trips2";
import { CityMap } from "../../components/map/CityMap";
import { DropoffMarker, PickupMarker, RouteLine } from "../../components/map/markers";
import { Drawer, Empty, Field, Notice, PageHead, Problem } from "../../components/ui";

type TraceTrip = Pick<Trip, "id" | "cityId" | "status" | "pickup" | "dropoff">;

/** The driven line of a trip, pickup leg and ride in two colours, with a CSV export. */
export function TripTrace({ trip }: { trip: TraceTrip }) {
  const { staff } = useSession();
  const may = allowed(staff.principal, "trip:read_gps_trace", { cityId: trip.cityId });
  const [reason, setReason] = useState("");
  const [asked, setAsked] = useState(false);
  const [csvError, setCsvError] = useState<unknown>(null);
  const trace = useTripTrace(trip.id, reason.trim(), may && asked);
  const polyline = trace.data?.polyline6;
  const meta = trace.data?.points;
  const legs = useMemo(() => (polyline && meta ? splitTrace(decodePolyline6(polyline), meta) : { toPickup: [], ride: [] }), [polyline, meta]);
  const fit = useMemo(() => [...legs.toPickup, ...legs.ride], [legs]);

  if (!may) return null;

  async function exportCsv() {
    setCsvError(null);
    try {
      await downloadCsv("staff", `/api/trips/${trip.id}/trace.csv${qs({ reason: reason.trim() })}`, `trip-${trip.id}-trace.csv`);
    } catch (err) {
      setCsvError(err);
    }
  }

  return (
    <div className="card">
      <div className="card-head"><h2>GPS trace</h2></div>
      <div className="card-body stack" style={{ gap: "0.75rem" }}>
        {!asked ? (
          <form className="stack" style={{ gap: "0.5rem" }} onSubmit={(e) => { e.preventDefault(); setAsked(true); }}>
            <p className="small muted" style={{ margin: 0 }}>The driver's recorded positions for this trip. Opening it is written to the audit log.</p>
            <Field label="Why you need it" placeholder="e.g. ticket 1042, incident 88, police request" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            <div><button className="btn secondary" disabled={!reason.trim()}><MapPinned /> Show the trace</button></div>
          </form>
        ) : null}
        <Problem error={trace.error ?? csvError} />
        {asked && trace.isLoading ? <p className="muted">Loading…</p> : null}
        {trace.data && trace.data.count === 0 ? <Empty title="No positions recorded for this trip.">The driver's app may have been offline, or the trip ended before the driver moved.</Empty> : null}
        {trace.data && trace.data.count > 0 ? (
          <>
            <div style={{ height: "20rem", position: "relative" }}>
              <CityMap cityId={trip.cityId} fit={fit} fitOnce boxed>
                {legs.toPickup.length > 1 ? <RouteLine id={`trace-pickup-${trip.id}`} points={legs.toPickup} color="#64748b" /> : null}
                {legs.ride.length > 1 ? <RouteLine id={`trace-ride-${trip.id}`} points={legs.ride} color="#2563eb" /> : null}
                <PickupMarker lat={trip.pickup.lat} lng={trip.pickup.lng} label="Pickup" />
                <DropoffMarker lat={trip.dropoff.lat} lng={trip.dropoff.lng} label="Drop-off" />
              </CityMap>
            </div>
            <dl className="kv">
              <dt>Recorded</dt><dd>{trace.data.count} points · {clock(trace.data.from)}–{clock(trace.data.to)}</dd>
              <dt>Ride driven</dt><dd>{trace.data.rideDistanceMeters !== null ? routeSummary(trace.data.rideDistanceMeters, null) : "—"} <span className="muted xs">(grey: to the pickup · blue: with the rider)</span></dd>
              <dt>All driving</dt><dd>{routeSummary(trace.data.totalDistanceMeters, null) || "—"}</dd>
            </dl>
            <p className="xs muted" style={{ margin: 0 }}>
              A point every {trace.data.thinning.minSeconds} s and {trace.data.thinning.minMeters} m of movement at most, plus one a minute when standing still. Straight lines between points.
            </p>
            <div className="row" style={{ gap: "0.5rem" }}>
              <button className="btn secondary sm" onClick={() => void exportCsv()}><Download /> Download CSV</button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** /staff/trips/:tripId/trace */
export function TripTracePage() {
  const { tripId = "" } = useParams();
  const trip = useQuery({ queryKey: ["trip", tripId], enabled: !!tripId, retry: false, queryFn: () => api<Trip>("staff", `/api/trips/${tripId}`) });
  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title={<>GPS trace <span className="mono">{shortId(tripId)}</span></>}
        lede={trip.data ? <>{trip.data.pickup.address ?? "pin"} → {trip.data.dropoff.address ?? "pin"} · {dayAndTime(trip.data.times.requestedAt)} · <Link to={`/staff/trips/${tripId}`}>trip details</Link></> : undefined}
      />
      <Problem error={trip.error} />
      {trip.isLoading ? <p className="muted">Loading…</p> : null}
      {trip.data ? <TripTrace trip={trip.data} /> : null}
    </div>
  );
}

/** "Reassign" for a matched or en-route trip: to a nearby free driver, or back to matching. */
export function ReassignButton({ trip, className = "btn sm secondary", onDone }: { trip: Trip; className?: string; onDone?: (t: Trip) => void }) {
  const { staff } = useSession();
  const [open, setOpen] = useState(false);
  if (!allowed(staff.principal, "trip:reassign", { cityId: trip.cityId }) || !isReassignable(trip.status)) return null;
  return (
    <>
      <button className={className} onClick={(e) => { e.stopPropagation(); setOpen(true); }}><Shuffle /> Reassign</button>
      {open ? <ReassignDrawer trip={trip} onClose={() => setOpen(false)} onDone={(t) => { setOpen(false); onDone?.(t); }} /> : null}
    </>
  );
}

function ReassignDrawer({ trip, onClose, onDone }: { trip: Trip; onClose: () => void; onDone: (t: Trip) => void }) {
  const qc = useQueryClient();
  const drivers = useCityDrivers(trip.cityId);
  const candidates = reassignCandidates(drivers.data, trip);
  const [reason, setReason] = useState("");
  const [manual, setManual] = useState("");
  const move = useMutation({
    mutationFn: (driverId: string | null) =>
      api<Trip>("staff", `/api/trips/${trip.id}/reassign`, { body: { ...(driverId ? { driverId } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) }, idempotencyKey: newIdempotencyKey() }),
    onSuccess: (t) => {
      qc.setQueryData(["trip", trip.id], t);
      void qc.invalidateQueries({ queryKey: ["board"] });
      onDone(t);
    },
  });
  const manualOk = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(manual.trim());

  return (
    <Drawer title={`Reassign trip ${shortId(trip.id)}`} onClose={onClose}>
      <div className="stack" onClick={(e) => e.stopPropagation()}>
        <Notice>
          The current driver{trip.driver ? <> (<span className="mono">{shortId(trip.driver.userId)}</span>)</> : null} loses the trip and is told so. The rider sees the new driver, or that we're finding one again.
        </Notice>
        <Problem error={move.error} />
        <Field label="Reason (kept with the trip and in the audit log)" placeholder="e.g. driver not moving, car broke down" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        <div>
          <div className="label">Free drivers nearby ({trip.vehicleType})</div>
          {drivers.isLoading ? <p className="muted small">Loading…</p> : null}
          {drivers.error ? <p className="small muted">Live positions unavailable. Use a driver id below, or send it back to matching.</p> : null}
          {drivers.data && candidates.length === 0 ? <p className="small muted">No free {trip.vehicleType} drivers online right now.</p> : null}
          <ul className="list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {candidates.map((d) => (
              <li key={d.driverId} className="row between" style={{ padding: "0.35rem 0", borderBottom: "1px solid var(--border)" }}>
                <span><span className="mono">{shortId(d.driverId)}</span> <span className="muted small">· {(d.meters / 1000).toFixed(1)} km from the pickup</span></span>
                <button className="btn sm" disabled={move.isPending} onClick={() => move.mutate(d.driverId)}>Give to this driver</button>
              </li>
            ))}
          </ul>
        </div>
        <form className="row" style={{ gap: "0.5rem", alignItems: "end" }} onSubmit={(e) => { e.preventDefault(); if (manualOk) move.mutate(manual.trim()); }}>
          <Field label="Or a driver id" className="mono" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="full driver id" />
          <button className="btn sm secondary" disabled={!manualOk || move.isPending}>Give</button>
        </form>
        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "0.25rem 0" }} />
        <div className="row between">
          <span className="small muted">Nobody suitable? Let matching find a driver again (the current one is skipped).</span>
          <button className="btn sm danger" disabled={move.isPending} onClick={() => move.mutate(null)}>Back to matching</button>
        </div>
      </div>
    </Drawer>
  );
}
