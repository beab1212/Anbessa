import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import type { Trip } from "@ride-app/shared-types";
import { allowed, api, newIdempotencyKey } from "../../lib/api";
import { birr, CITY_NAMES, clock, dayAndTime, shortId, STATUS_LABEL } from "../../lib/format";
import { useCityDrivers } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { CityMap } from "../../components/map/CityMap";
import { DriverMarker, DropoffMarker, PickupMarker, TripLine } from "../../components/map/markers";
import { Pill, Problem, TripStatus, tripTone } from "../../components/ui";
import { PAYMENT_LABEL, paymentTone, PROVIDER_LABEL, type Payment } from "../../lib/money";
import { PaymentDrawer } from "../money/Payments";

/** Find a trip by id, and read it like a log entry: what happened when, and what it cost. */
export function TripDetail() {
  const { tripId } = useParams();
  const navigate = useNavigate();
  const [lookup, setLookup] = useState(tripId ?? "");

  return (
    <div className="page">
      <form className="row" style={{ marginBottom: "1.25rem" }} onSubmit={(e) => { e.preventDefault(); navigate(`/staff/trips/${lookup.trim()}`); }}>
        <input className="input mono" style={{ maxWidth: "28rem" }} aria-label="Trip id" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="Paste the full trip id" />
        <button className="btn secondary" disabled={lookup.trim().length < 36}><Search /> Open</button>
      </form>
      {tripId ? <TripSheet id={tripId} /> : <p className="muted small">Support and safety: paste the id from a ticket or the board.</p>}
    </div>
  );
}

function TripSheet({ id }: { id: string }) {
  const { staff } = useSession();
  const qc = useQueryClient();
  const trip = useQuery({ queryKey: ["trip", id], queryFn: () => api<Trip>("staff", `/api/trips/${id}`), retry: false, refetchInterval: 8000 });
  const t = trip.data;
  // the driver's live position comes from the city ops map (location:read_live), not the rider's trip feed
  const onRoad = !!t?.driver && (t.status === "matched" || t.status === "en_route" || t.status === "in_progress");
  const cityDrivers = useCityDrivers(t?.cityId ?? null, onRoad && allowed(staff.principal, "location:read_live", { cityId: t?.cityId }));
  const driver = onRoad ? cityDrivers.data?.find((d) => d.driverId === t!.driver!.userId && d.lat !== undefined) : undefined;
  const cancel = useMutation({
    mutationFn: () => api<Trip>("staff", `/api/trips/${id}/cancel`, { body: { reason: "STAFF_DECISION" }, idempotencyKey: newIdempotencyKey() }),
    onSuccess: (x) => qc.setQueryData(["trip", id], x),
  });
  const fit = useMemo(() => (t ? [t.pickup, t.dropoff] : []), [t]);

  if (trip.isLoading) return <p className="muted">Loading…</p>;
  if (trip.error) return <Problem error={trip.error} />;
  if (!t) return null;
  const canCancel = allowed(staff.principal, "trip:cancel", { cityId: t.cityId }) && ["requested", "matched", "en_route"].includes(t.status);

  const log: [string, string | null, string][] = [
    ["Requested", t.times.requestedAt, `${t.channel.toLowerCase().replace("_", " ")} · ${t.vehicleType}`],
    ["Driver assigned", t.times.matchedAt, t.driver ? `driver ${shortId(t.driver.userId)} · car ${t.driver.vehicleId ?? "—"}` : ""],
    ["Arrived at pickup", t.times.arrivedAt, ""],
    ["Rider picked up", t.times.startedAt, ""],
    ["Dropped off", t.times.completedAt, t.route.durationSeconds ? `${Math.round(t.route.durationSeconds / 60)} min ride` : ""],
    ["Cancelled", t.times.cancelledAt, t.cancellation ? `by ${t.cancellation.by.toLowerCase()} · ${t.cancellation.reason.toLowerCase().replace(/_/g, " ")}` : ""],
  ];
  const events = log.filter(([, at]) => at);

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
        {canCancel ? <button className="btn danger" disabled={cancel.isPending} onClick={() => confirm("Cancel this trip? Staff cancellations are free for the rider.") && cancel.mutate()}>Cancel trip</button> : null}
      </header>
      <Problem error={cancel.error} />

      <div className="two-col wide-left">
        <div className="stack">
          <div style={{ height: "22rem", position: "relative" }}>
            <CityMap cityId={t.cityId} fit={fit} boxed>
              <TripLine id={t.id} from={t.pickup} to={t.dropoff} />
              <PickupMarker lat={t.pickup.lat} lng={t.pickup.lng} tone={tripTone(t.status)} label="Pickup" />
              <DropoffMarker lat={t.dropoff.lat} lng={t.dropoff.lng} label="Drop-off" />
              {driver ? <DriverMarker lat={driver.lat!} lng={driver.lng!} heading={driver.heading} onTrip stale={driver.stale} title={`driver ${shortId(driver.driverId)}`} /> : null}
            </CityMap>
          </div>
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
                <dt>Rider</dt><dd className="mono">{shortId(t.riderUserId)}</dd>
              </dl>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Money</h2></div>
          <div className="card-body">
            <dl className="kv" style={{ gridTemplateColumns: "1fr auto" }}>
              <dt>Quoted fare</dt><dd className="num mono">{birr(t.fare.estimateMinor)}</dd>
              <dt>Waiting</dt><dd className="num mono">{birr(t.fare.waitingFeeMinor)}</dd>
              <dt><strong>Charged</strong></dt><dd className="num mono"><strong>{birr(t.fare.finalMinor)}</strong></dd>
              {t.cancellation ? <><dt>Cancellation fee</dt><dd className="num mono">{birr(t.cancellation.feeMinor)}</dd><dt className="small">to the driver</dt><dd className="num mono small">{birr(t.cancellation.driverCompensationMinor)}</dd></> : null}
            </dl>
            <p className="small muted" style={{ marginTop: "0.9rem" }}>Paid by <strong>{t.paymentMethod.toLowerCase().replace("_", " ")}</strong>{t.billing.type === "CORPORATE" ? " on a company account" : ""}.</p>
            {t.status === "completed" || t.cancellation?.feeMinor ? <TripPayments tripId={t.id} /> : null}
          </div>
        </div>
      </div>
    </article>
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
