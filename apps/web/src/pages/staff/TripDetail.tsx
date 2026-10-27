import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import type { Trip } from "@ride-app/shared-types";
import { allowed, api, newIdempotencyKey } from "../../lib/api";
import { birr, CITY_NAMES, clock, dayAndTime, shortId, STATUS_LABEL } from "../../lib/format";
import { useCityDrivers } from "../../lib/hooks";
import { ReassignButton, TripTrace } from "./Trace";
import { useSession } from "../../lib/session";
import { decodePolyline6 } from "../../lib/polyline";
import {
  cancelReasonLabel, carLine, initial, isCancellable, loadRecentTrips, looksLikeTripId, pushRecent, routeSummary, saveRecentTrips,
  STAFF_CANCEL_REASONS, useTripParties, type StaffCancelReason, type TripParties,
} from "../../lib/trips";
import { CityMap } from "../../components/map/CityMap";
import { DriverMarker, DropoffMarker, PickupMarker, RouteLine, TripLine } from "../../components/map/markers";
import { Drawer, Notice, Pill, Problem, TripStatus, tripTone } from "../../components/ui";
import { PAYMENT_LABEL, paymentTone, PROVIDER_LABEL, type Payment } from "../../lib/money";
import { PaymentDrawer } from "../money/Payments";

/** Find a trip by id, and read it like a log entry: what happened when, and what it cost. */
const EVENT_LABEL: Record<string, string> = { requested: "Requested", matched: "Driver assigned", en_route: "Driver on the way", in_progress: "Rider picked up", completed: "Dropped off", cancelled: "Cancelled" };

export function TripDetail() {
  const { tripId } = useParams();
  const [recent, setRecent] = useState<string[]>(loadRecentTrips);

  /** Remember a trip once it has loaded (this browser only, and only its id). */
  const remember = useCallback((id: string) =>
    setRecent((cur) => {
      if (cur[0] === id) return cur;
      const next = pushRecent(cur, id);
      saveRecentTrips(next);
      return next;
    }), []);
  const forget = () => {
    saveRecentTrips([]);
    setRecent([]);
  };
  const others = recent.filter((id) => id !== tripId);

  return (
    <div className="page">
      <LookupForm key={tripId ?? ""} initial={tripId ?? ""} />
      {others.length ? (
        <nav className="row small" aria-label="Recently opened trips" style={{ marginTop: "-0.5rem", marginBottom: "1.25rem", gap: "0.5rem", flexWrap: "wrap" }}>
          <span className="muted">Recently opened:</span>
          {others.map((id) => <Link key={id} className="chip mono" to={`/staff/trips/${id}`} title={id}>{shortId(id)}</Link>)}
          <button type="button" className="link xs" onClick={forget}>clear</button>
        </nav>
      ) : null}
      {tripId ? <TripSheet key={tripId} id={tripId} onLoaded={remember} /> : <p className="muted small">Support and safety: paste the id from a ticket or the board.</p>}
    </div>
  );
}

function LookupForm({ initial }: { initial: string }) {
  const navigate = useNavigate();
  const [lookup, setLookup] = useState(initial);
  return (
    <form className="row" style={{ marginBottom: "1.25rem" }} onSubmit={(e) => { e.preventDefault(); navigate(`/staff/trips/${lookup.trim()}`); }}>
      <input className="input mono" style={{ maxWidth: "28rem" }} aria-label="Trip id" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="Paste the full trip id" />
      <button className="btn secondary" disabled={!looksLikeTripId(lookup)}><Search /> Open</button>
    </form>
  );
}

function TripSheet({ id, onLoaded }: { id: string; onLoaded: (id: string) => void }) {
  const { staff } = useSession();
  const qc = useQueryClient();
  const [cancelling, setCancelling] = useState(false);
  const trip = useQuery({ queryKey: ["trip", id], queryFn: () => api<Trip>("staff", `/api/trips/${id}`), retry: false, refetchInterval: 8000 });
  const t = trip.data;
  const loaded = !!t;
  useEffect(() => {
    if (loaded) onLoaded(id);
  }, [loaded, id, onLoaded]);
  const parties = useTripParties(id, loaded);
  const historyQ = useQuery({
    queryKey: ["trip", id, "events"],
    enabled: !!id,
    refetchInterval: 15_000,
    queryFn: () => api<{ events: { at: string; from: string | null; to: string; actorId: string | null }[] }>("staff", `/api/trips/${id}/events`),
  });
  // the driver's live position comes from the city ops map (location:read_live), not the rider's trip feed
  const onRoad = !!t?.driver && (t.status === "matched" || t.status === "en_route" || t.status === "in_progress");
  const cityDrivers = useCityDrivers(t?.cityId ?? null, onRoad && allowed(staff.principal, "location:read_live", { cityId: t?.cityId }));
  const driver = onRoad ? cityDrivers.data?.find((d) => d.driverId === t!.driver!.userId && d.lat !== undefined) : undefined;
  const cancel = useMutation({
    mutationFn: (reason: StaffCancelReason) => api<Trip>("staff", `/api/trips/${id}/cancel`, { body: { reason }, idempotencyKey: newIdempotencyKey() }),
    onSuccess: (x) => {
      qc.setQueryData(["trip", id], x);
      setCancelling(false);
      void qc.invalidateQueries({ queryKey: ["board"] });
    },
  });
  const polyline = t?.route.polyline;
  const route = useMemo(() => (polyline ? decodePolyline6(polyline) : []), [polyline]);
  const fit = useMemo(() => (t ? (route.length > 1 ? route : [t.pickup, t.dropoff]) : []), [t, route]);

  if (trip.isLoading) return <p className="muted">Loading…</p>;
  if (trip.error) return <Problem error={trip.error} />;
  if (!t) return null;
  const canCancel = allowed(staff.principal, "trip:cancel", { cityId: t.cityId }) && isCancellable(t.status);
  const driverName = parties.data?.driver?.name;

  const log: [string, string | null, string][] = [
    ["Requested", t.times.requestedAt, `${t.channel.toLowerCase().replace("_", " ")} · ${t.vehicleType}`],
    ["Driver assigned", t.times.matchedAt, t.driver ? `${driverName ?? `driver ${shortId(t.driver.userId)}`} · ${parties.data?.vehicle?.plateNumber ?? `car ${t.driver.vehicleId ? shortId(t.driver.vehicleId) : "—"}`}` : ""],
    ["Arrived at pickup", t.times.arrivedAt, ""],
    ["Rider picked up", t.times.startedAt, ""],
    ["Dropped off", t.times.completedAt, t.route.durationSeconds ? `${Math.round(t.route.durationSeconds / 60)} min ride` : ""],
    ["Cancelled", t.times.cancelledAt, t.cancellation ? `by ${t.cancellation.by.toLowerCase()} · ${cancelReasonLabel(t.cancellation.reason).toLowerCase()}` : ""],
  ];
  // trip-service's own history (every status change, who made it) when it loads; the trip's
  // timestamps otherwise
  // arriving at the pickup is recorded as en_route → en_route
  const history = (historyQ.data?.events ?? []).map((e): [string, string | null, string] => [
    e.from === "en_route" && e.to === "en_route" ? "Arrived at pickup" : EVENT_LABEL[e.to] ?? e.to,
    e.at,
    e.actorId ? (e.actorId === t.driver?.userId ? "by the driver" : `by ${shortId(e.actorId)}`) : "by the system",
  ]);
  const events = history.length ? history : log.filter(([, at]) => at);
  const planned = routeSummary(t.route.estDistanceMeters, t.route.estDurationSeconds);
  const actual = t.route.distanceMeters !== null ? routeSummary(t.route.distanceMeters, t.route.durationSeconds) : "";

  return (
    <article className="stack">
      <header className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <div className="row" style={{ gap: "0.6rem" }}>
            <h1 className="mono">{shortId(t.id)}</h1>
            <TripStatus status={t.status} label={STATUS_LABEL[t.status] ?? t.status} />
            {t.flags?.map((f) => <Pill key={f} tone="red">{f.toLowerCase().replace(/_/g, " ")}</Pill>)}
          </div>
          <p>{CITY_NAMES[t.cityId] ?? t.cityId} · {dayAndTime(t.times.requestedAt)} · <span className="mono xs">{t.id}</span></p>
        </div>
        <div className="row" style={{ gap: "0.5rem" }}>
          <ReassignButton trip={t} onDone={(x) => qc.setQueryData(["trip", id], x)} />
          {canCancel ? <button className="btn danger" disabled={cancel.isPending} onClick={() => { cancel.reset(); setCancelling(true); }}>Cancel trip</button> : null}
        </div>
      </header>
      {cancel.data?.cancellation ? (
        <Notice tone="ok">
          Cancelled: {cancelReasonLabel(cancel.data.cancellation.reason).toLowerCase()}.{" "}
          {cancel.data.cancellation.feeMinor ? `The rider is charged a ${birr(cancel.data.cancellation.feeMinor)} cancellation fee.` : "No fee for the rider."}
        </Notice>
      ) : null}

      <div className="two-col wide-left">
        <div className="stack">
          <div style={{ height: "22rem", position: "relative" }}>
            <CityMap cityId={t.cityId} fit={fit} boxed>
              {route.length > 1 ? <RouteLine id={`trip-${t.id}`} points={route} /> : <TripLine id={t.id} from={t.pickup} to={t.dropoff} />}
              <PickupMarker lat={t.pickup.lat} lng={t.pickup.lng} tone={tripTone(t.status)} label="Pickup" />
              <DropoffMarker lat={t.dropoff.lat} lng={t.dropoff.lng} label="Drop-off" />
              {driver ? <DriverMarker lat={driver.lat!} lng={driver.lng!} heading={driver.heading} onTrip stale={driver.stale} title={driverName ?? `driver ${shortId(driver.driverId)}`} /> : null}
            </CityMap>
          </div>
          <p className="xs muted" style={{ margin: "-0.5rem 0 0" }}>
            {route.length > 1 ? "Road route as quoted" : "Straight line: this trip has no route line"}{planned ? ` · planned ${planned}` : ""}{actual ? ` · driven ${actual}` : ""}
          </p>
          {/* the driven GPS trace (trip:read_gps_trace; renders nothing without it) */}
          <TripTrace trip={t} />
          <div className="card">
            <div className="card-head"><h2>What happened</h2></div>
            <div className="card-body">
              <ul className="timeline">
                {events.map(([what, at, note], i) => (
                  <li key={what} className={i < events.length - 1 || t.status === "completed" || t.status === "cancelled" ? "done" : "now"}>
                    <span className="t">{clock(at)}</span>
                    <span className="dot" />
                    <span><strong>{what}</strong>{note ? <span className="muted small"> · {note}</span> : null}</span>
                  </li>
                ))}
              </ul>
              <dl className="kv" style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--border)" }}>
                <dt>From</dt><dd>{t.pickup.address ?? "—"} <span className="mono xs muted">{t.pickup.lat.toFixed(4)}, {t.pickup.lng.toFixed(4)}</span></dd>
                <dt>To</dt><dd>{t.dropoff.address ?? "—"} <span className="mono xs muted">{t.dropoff.lat.toFixed(4)}, {t.dropoff.lng.toFixed(4)}</span></dd>
              </dl>
            </div>
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>People</h2></div>
            <div className="card-body">
              <PartiesView trip={t} parties={parties.data} loading={parties.isLoading} failed={!!parties.error} />
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Money</h2></div>
            <div className="card-body">
              <dl className="kv" style={{ gridTemplateColumns: "1fr auto" }}>
                <dt>Quoted fare</dt><dd className="num mono">{birr(t.fare.estimateMinor)}</dd>
                <dt>Waiting</dt><dd className="num mono">{birr(t.fare.waitingFeeMinor)}</dd>
                <dt><strong>Charged</strong></dt><dd className="num mono"><strong>{birr(t.fare.finalMinor)}</strong></dd>
                {t.fare.promoDiscountMinor ? (
                  <>
                    <dt>Promo {t.fare.promoCode ? <span className="mono">{t.fare.promoCode}</span> : null}</dt><dd className="num mono">−{birr(t.fare.promoDiscountMinor)}</dd>
                    <dt>Rider pays</dt><dd className="num mono">{birr(t.fare.payableMinor)}</dd>
                  </>
                ) : null}
                {t.cancellation ? <><dt>Cancellation fee</dt><dd className="num mono">{birr(t.cancellation.feeMinor)}</dd><dt className="small">to the driver</dt><dd className="num mono small">{birr(t.cancellation.driverCompensationMinor)}</dd></> : null}
              </dl>
              <p className="small muted" style={{ marginTop: "0.9rem" }}>Paid by <strong>{t.paymentMethod.toLowerCase().replace("_", " ")}</strong>{t.billing.type === "CORPORATE" ? " on a company account" : ""}.</p>
              {t.status === "completed" || t.cancellation?.feeMinor ? <TripPayments tripId={t.id} /> : null}
            </div>
          </div>
        </div>
      </div>

      {cancelling ? <CancelTripDrawer trip={t} busy={cancel.isPending} error={cancel.error} onClose={() => setCancelling(false)} onCancel={(r) => cancel.mutate(r)} /> : null}
    </article>
  );
}

/** Rider, driver and car as trip-service resolves them; ids stay visible for tickets. */
export function PartiesView({ trip, parties, loading, failed }: { trip: Trip; parties: TripParties | undefined; loading: boolean; failed: boolean }) {
  const person = (role: string, name: string | null | undefined, photo: string | null | undefined, userId: string, extra?: ReactNode) => (
    <div className="shared-driver" style={{ padding: "0.6rem" }}>
      {photo ? <img src={photo} alt="" className="shared-avatar" /> : <div className="shared-avatar initials" aria-hidden="true">{initial(name)}</div>}
      <div style={{ minWidth: 0 }}>
        <div className="xs muted">{role}</div>
        <div className="shared-name">{name ?? <span className="muted">No name set</span>}</div>
        <div className="xs muted mono">{shortId(userId)}{extra}</div>
      </div>
    </div>
  );
  const v = parties?.vehicle;
  return (
    <div className="stack" style={{ gap: "0.6rem" }}>
      {failed ? <p className="xs muted" style={{ margin: 0 }}>Names aren't available right now; showing ids.</p> : null}
      {loading ? <p className="xs muted" style={{ margin: 0 }}>Loading names…</p> : null}
      {person("Rider", parties?.rider?.name, parties?.rider?.photo, trip.riderUserId)}
      {trip.driver ? (
        <>
          {person("Driver", parties?.driver?.name, parties?.driver?.photo, trip.driver.userId, parties?.driver?.rating ? <> · {parties.driver.rating.toFixed(1)} from {parties.driver.ratingCount}</> : null)}
          <div className="row between small" style={{ padding: "0 0.6rem" }}>
            <span>{v ? carLine(v) : <span className="muted">Car {trip.driver.vehicleId ? shortId(trip.driver.vehicleId) : "—"}</span>}</span>
            {v?.plateNumber ? <span className="shared-plate" style={{ marginLeft: 0 }}>{v.plateNumber}</span> : null}
          </div>
          <Link className="link small" style={{ padding: "0 0.6rem" }} to={`/staff/fleet/drivers/${trip.driver.userId}`}>Driver record</Link>
        </>
      ) : <p className="small muted" style={{ margin: 0 }}>No driver yet.</p>}
    </div>
  );
}

/** Pick why staff are cancelling; trip-service records the reason. */
export function CancelTripDrawer({ trip, busy, error, onClose, onCancel }: { trip: Trip; busy: boolean; error: unknown; onClose: () => void; onCancel: (r: StaffCancelReason) => void }) {
  const [reason, setReason] = useState<StaffCancelReason>("STAFF_DECISION");
  return (
    <Drawer title={`Cancel trip ${shortId(trip.id)}`} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); onCancel(reason); }}>
        <Problem error={error} />
        <fieldset className="options">
          <legend className="label">Reason</legend>
          {STAFF_CANCEL_REASONS.map(([code, label]) => (
            <label key={code} className="option">
              <input type="radio" name="cancel-reason" checked={reason === code} onChange={() => setReason(code)} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <Notice>Staff cancellations are free: the rider pays no fee and the driver gets no compensation.</Notice>
        <div className="row">
          <button className="btn danger" disabled={busy}>{busy ? "Cancelling…" : "Cancel the trip"}</button>
          <button type="button" className="btn ghost" onClick={onClose}>Keep it</button>
        </div>
      </form>
    </Drawer>
  );
}

interface TripMoney {
  payments: Payment[];
  settlements: { purpose: string; paymentMethod: string; fareMinor: number; commissionMinor: number; vatMinor: number; earningsMinor: number; settledAt: string; beneficiaryAccountId: string | null }[];
}

/** payment-service's side of the trip: the charge (if digital) and how it was settled. */
function TripPayments({ tripId }: { tripId: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["money", "trip", tripId], refetchInterval: 10_000, retry: false, queryFn: () => api<TripMoney>("staff", `/api/payments/trips/${tripId}`) });
  if (q.error) return <p className="xs muted">Payment details aren't available{q.error instanceof Error && q.error.message ? `: ${q.error.message}` : ""}.</p>;
  if (!q.data) return null;
  return (
    <div style={{ marginTop: "0.9rem", paddingTop: "0.9rem", borderTop: "1px solid var(--border)" }}>
      {q.data.payments.map((p) => (
        <p key={p.id} className="small" style={{ margin: "0 0 0.4rem" }}>
          <button className="link" onClick={() => setOpen(p.id)}>{p.purpose === "TRIP_FARE" ? "Fare" : "Fee"} by {PROVIDER_LABEL[p.provider] ?? p.provider}</button>{" "}
          <Pill tone={paymentTone(p.status)}>{PAYMENT_LABEL[p.status] ?? p.status}</Pill>
        </p>
      ))}
      {q.data.settlements.map((s) => (
        <dl key={s.purpose} className="kv" style={{ gridTemplateColumns: "1fr auto", margin: "0.4rem 0 0" }}>
          <dt className="small">Commission</dt><dd className="num mono small">{birr(s.commissionMinor)}</dd>
          {s.vatMinor ? <><dt className="small">VAT</dt><dd className="num mono small">{birr(s.vatMinor)}</dd></> : null}
          <dt className="small">Driver's balance</dt><dd className="num mono small">{s.earningsMinor > 0 ? "+" : ""}{birr(s.earningsMinor)}</dd>
        </dl>
      ))}
      {q.data.payments.length === 0 && q.data.settlements.length === 0 ? <p className="xs muted" style={{ margin: 0 }}>Not settled yet.</p> : null}
      {open ? <PaymentDrawer id={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
