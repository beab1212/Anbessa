// /partner/org/:orgId/trips/:tripId: a company trip (status, people, live car, cancel).
// Company accounts see the trips billed to them; fleets see trips in their cars.

import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Trip } from "@ride-app/shared-types";
import { allowed, api, ApiError, authCall, newIdempotencyKey } from "../../lib/api";
import { birr, CITY_NAMES, clock, dayAndTime, shortId, STATUS_LABEL } from "../../lib/format";
import { vehicleName, type VehicleDetail } from "../../lib/fleet";
import {
  BOOKER_CANCEL_REASONS, cancelFeeNote, CANCELLED_BY, isCancellable, isOnRoad, reasonWord,
} from "../../lib/partner";
import { decodePolyline6 } from "../../lib/polyline";
import { useNow } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { CityMap } from "../../components/map/CityMap";
import { DriverMarker, DropoffMarker, PickupMarker, RouteLine, TripLine } from "../../components/map/markers";
import { Drawer, Empty, Notice, PageHead, Problem, SelectField, TripStatus, tripTone } from "../../components/ui";
import { memberName, type Member } from "./Fleet";

interface Parties {
  tripId: string;
  driver: { name: string | null; photo: string | null; rating: number | null; ratingCount: number } | null;
  vehicle: { plateNumber: string; vehicleType: string; make: string; model: string; color: string } | null;
  rider: { name: string | null; photo: string | null } | null;
}

interface CarPosition {
  tripId: string;
  driverId: string;
  lat: number;
  lng: number;
  heading?: number;
  at: number;
}

const ENDED = ["completed", "cancelled"];

export function PartnerTripPage() {
  const { orgId, tripId } = useParams();
  const { partner } = useSession();
  const p = partner.principal;
  const qc = useQueryClient();
  const now = useNow(10_000);
  const org = useQuery({
    queryKey: ["org", orgId],
    queryFn: () => authCall<{ name: string; kind: "FLEET" | "CORPORATE"; cityId: string; members: Member[] }>("partner", `/organization/get-full-organization?organizationId=${orgId}`),
  });
  const mayRead = allowed(p, "trip:read", { orgId });
  const trip = useQuery({
    queryKey: ["partner-trip", tripId],
    enabled: mayRead,
    retry: false,
    refetchInterval: (q) => (q.state.data && ENDED.includes(q.state.data.status) ? false : 8000),
    queryFn: () => api<Trip>("partner", `/api/trips/${tripId}`),
  });
  const t = trip.data;
  const parties = useQuery({
    queryKey: ["partner-trip-parties", tripId, t?.driver?.userId ?? null],
    enabled: !!t,
    retry: false,
    queryFn: () => api<Parties>("partner", `/api/trips/${tripId}/parties`),
  });
  const onRoad = !!t?.driver && isOnRoad(t.status);
  const car = useQuery({
    queryKey: ["partner-trip-car", tripId],
    enabled: onRoad,
    retry: false,
    refetchInterval: (q) => (q.state.error ? 15_000 : 5000),
    queryFn: () => api<CarPosition>("partner", `/api/locations/trips/${tripId}/driver`),
  });
  // fleets: trip-service doesn't tell the fleet who drives or which car; fleet-service does
  const isFleet = org.data?.kind === "FLEET";
  const vehicleId = t?.driver?.vehicleId ?? null;
  const fleetCar = useQuery({
    queryKey: ["fleet-vehicle", vehicleId],
    enabled: isFleet && !!vehicleId && allowed(p, "vehicle:read", { orgId }),
    retry: false,
    queryFn: () => api<VehicleDetail>("partner", `/api/fleet/vehicles/${vehicleId}`),
  });

  const [cancelling, setCancelling] = useState<{ reason: string; key: string } | null>(null);
  const cancel = useMutation({
    mutationFn: (c: { reason: string; key: string }) => api<Trip>("partner", `/api/trips/${tripId}/cancel`, { body: { reason: c.reason }, idempotencyKey: c.key }),
    onSuccess: (x) => {
      qc.setQueryData(["partner-trip", tripId], x);
      setCancelling(null);
    },
  });

  const polyline = t?.route.polyline;
  const route = useMemo(() => (polyline ? decodePolyline6(polyline) : []), [polyline]);
  const position = onRoad ? car.data : undefined;
  const fit = useMemo(() => (t ? [t.pickup, t.dropoff] : []), [t]);

  if (org.isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (org.error) return <div className="page"><Problem error={org.error} /></div>;
  const o = org.data!;
  const crumb = <p className="xs muted" style={{ margin: 0 }}><Link to={`/partner/org/${orgId}`}>{o.name}</Link> / trip {tripId ? shortId(tripId) : ""}</p>;
  if (!mayRead) {
    return <div className="page stack">{crumb}<Empty title="You can't see this company's trips.">On a company account the admin and the travel desk can; on a fleet, the owner.</Empty></div>;
  }
  if (trip.isLoading) return <div className="page stack">{crumb}<p className="muted">Loading…</p></div>;
  if (trip.error instanceof ApiError && trip.error.status === 404) {
    return <div className="page stack">{crumb}<Empty title="No such trip for this company.">It may belong to another account, or the link is wrong.</Empty></div>;
  }
  if (trip.error || !t) return <div className="page stack">{crumb}<Problem error={trip.error} /></div>;

  const billedHere = t.billing.type === "CORPORATE" && t.billing.orgId === orgId;
  const canCancel = billedHere && isCancellable(t.status) && allowed(p, "trip:cancel", { orgId });
  const memberOf = (userId: string | undefined) => o.members.find((m) => m.userId === userId);
  const riderMember = memberOf(t.riderUserId);
  const riderName = parties.data?.rider?.name ?? (riderMember ? memberName(riderMember) : `rider ${shortId(t.riderUserId)}`);
  const driverMember = memberOf(t.driver?.userId);
  const driverName = parties.data?.driver?.name ?? (driverMember ? memberName(driverMember) : t.driver ? `driver ${shortId(t.driver.userId)}` : null);
  const vehicle = parties.data?.vehicle ?? (fleetCar.data ? { plateNumber: fleetCar.data.plateNumber, vehicleType: fleetCar.data.vehicleType, make: fleetCar.data.make, model: fleetCar.data.model, color: fleetCar.data.color } : null);
  const stale = position ? now - position.at > 60_000 : false;

  const log: [string, string | null, string][] = [
    ["Requested", t.times.requestedAt, `${t.channel === "CORPORATE_PORTAL" ? "booked on the company portal" : t.channel === "PHONE" ? "booked by phone" : "booked in the app"} · ${t.vehicleType}`],
    ["Driver assigned", t.times.matchedAt, driverName ?? ""],
    ["Driver at the pickup", t.times.arrivedAt, ""],
    ["Picked up", t.times.startedAt, ""],
    ["Dropped off", t.times.completedAt, t.route.durationSeconds ? `${Math.round(t.route.durationSeconds / 60)} min ride` : ""],
    ["Cancelled", t.times.cancelledAt, t.cancellation ? `by ${CANCELLED_BY[t.cancellation.by] ?? t.cancellation.by.toLowerCase()} · ${reasonWord(t.cancellation.reason)}` : ""],
  ];
  const events = log.filter(([, at]) => at);

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      {crumb}
      <PageHead
        title={<span className="row" style={{ gap: "0.6rem" }}><span className="mono">{shortId(t.id)}</span> <TripStatus status={t.status} label={STATUS_LABEL[t.status] ?? t.status} /></span>}
        lede={<>{CITY_NAMES[t.cityId] ?? t.cityId} · {dayAndTime(t.times.requestedAt)} · {t.pickup.address ?? "pickup"} → {t.dropoff.address ?? "destination"}</>}
        right={canCancel ? <button className="btn danger" onClick={() => { cancel.reset(); setCancelling({ reason: "CHANGED_PLANS", key: newIdempotencyKey() }); }}>Cancel trip</button> : null}
      />
      {!billedHere && !isFleet ? <Notice>This trip isn't billed to {o.name}.</Notice> : null}
      {t.pin && !ENDED.includes(t.status) ? <Notice>Trip PIN <strong className="mono">{t.pin}</strong>: the rider tells the driver this number at the pickup. Pass it on if they don't have the app open.</Notice> : null}
      {t.status === "cancelled" && t.cancellation ? (
        <Notice tone="error">Cancelled by {CANCELLED_BY[t.cancellation.by] ?? t.cancellation.by.toLowerCase()}: {reasonWord(t.cancellation.reason)}. {t.cancellation.feeMinor ? `Cancellation fee ${birr(t.cancellation.feeMinor)}.` : "No fee."}</Notice>
      ) : null}

      <div className="two-col wide-left">
        <div className="stack">
          <div style={{ height: "22rem", position: "relative" }}>
            <CityMap cityId={t.cityId} fit={fit} fitOnce boxed>
              {route.length > 1 ? <RouteLine id={`partner-${t.id}`} points={route} /> : <TripLine id={`partner-${t.id}`} from={t.pickup} to={t.dropoff} />}
              <PickupMarker lat={t.pickup.lat} lng={t.pickup.lng} tone={tripTone(t.status)} label="Pickup" />
              <DropoffMarker lat={t.dropoff.lat} lng={t.dropoff.lng} label="Destination" />
              {position ? <DriverMarker lat={position.lat} lng={position.lng} heading={position.heading} onTrip stale={stale} title={driverName ?? "driver"} /> : null}
            </CityMap>
          </div>
          {onRoad ? (
            <p className="xs muted" style={{ margin: 0 }}>
              {position
                ? <>Car position from {clock(new Date(position.at))}{stale ? " (no update for over a minute)" : ""}, refreshed every few seconds.</>
                : car.isLoading ? "Looking for the car…" : "The car's live position isn't available here. The rider follows it in the Anbessa app."}
            </p>
          ) : null}
          <div className="card">
            <div className="card-head"><h2>What happened</h2></div>
            <div className="card-body">
              <ul className="timeline">
                {events.map(([what, at, note], i) => (
                  <li key={what} className={i < events.length - 1 || ENDED.includes(t.status) ? "done" : "now"}>
                    <span className="t">{clock(at)}</span>
                    <span className="dot" />
                    <span><strong>{what}</strong>{note ? <span className="muted small"> · {note}</span> : null}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="stack" style={{ alignContent: "start" }}>
          <div className="card">
            <div className="card-head"><h2>People and car</h2></div>
            <div className="card-body">
              <dl className="kv">
                <dt>Rider</dt><dd className="mono">{riderName}</dd>
                <dt>Driver</dt>
                <dd>
                  {driverName ? (
                    isFleet && driverMember && allowed(p, "driver:read", { orgId }) ? <Link to={`/partner/org/${orgId}/drivers/${driverMember.userId}`}>{driverName}</Link> : driverName
                  ) : <span className="muted">{t.status === "requested" ? "finding one…" : "—"}</span>}
                  {parties.data?.driver?.rating ? <span className="muted small"> · {parties.data.driver.rating.toFixed(1)} ({parties.data.driver.ratingCount})</span> : null}
                </dd>
                <dt>Car</dt>
                <dd>
                  {vehicle ? (
                    <>
                      {isFleet && vehicleId ? <Link className="mono" to={`/partner/org/${orgId}/vehicles/${vehicleId}`}>{vehicle.plateNumber}</Link> : <span className="mono">{vehicle.plateNumber}</span>}
                      <span className="muted small"> · {vehicleName(vehicle)}</span>
                    </>
                  ) : <span className="muted">—</span>}
                </dd>
              </dl>
              <Problem error={parties.error} />
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Money</h2></div>
            <div className="card-body">
              <dl className="kv" style={{ gridTemplateColumns: "1fr auto" }}>
                <dt>Quoted fare</dt><dd className="num mono">{birr(t.fare.estimateMinor)}</dd>
                <dt>Paid waiting</dt><dd className="num mono">{birr(t.fare.waitingFeeMinor)}</dd>
                <dt><strong>Final fare</strong></dt><dd className="num mono"><strong>{birr(t.fare.finalMinor)}</strong></dd>
                {t.fare.promoDiscountMinor ? (
                  <>
                    <dt>Promo {t.fare.promoCode ? <span className="mono">{t.fare.promoCode}</span> : null}</dt><dd className="num mono">−{birr(t.fare.promoDiscountMinor)}</dd>
                    <dt>Rider pays</dt><dd className="num mono">{birr(t.fare.payableMinor)}</dd>
                  </>
                ) : null}
                {t.cancellation ? <><dt>Cancellation fee</dt><dd className="num mono">{birr(t.cancellation.feeMinor)}</dd></> : null}
              </dl>
              <p className="small muted" style={{ margin: "0.9rem 0 0" }}>
                {billedHere ? `On ${o.name}'s company account: the rider doesn't pay the driver.` : `Paid by ${t.paymentMethod.toLowerCase().replace("_", " ")}.`}
                {" "}The fare is fixed when booked; waiting after the free minutes at the pickup is added.
              </p>
            </div>
          </div>
        </div>
      </div>

      {cancelling ? (
        <Drawer title={`Cancel trip ${shortId(t.id)}`} onClose={() => setCancelling(null)}>
          <form onSubmit={(e) => { e.preventDefault(); cancel.mutate(cancelling); }}>
            <Problem error={cancel.error} />
            <SelectField label="Why" value={cancelling.reason} onChange={(e) => setCancelling({ reason: e.target.value, key: newIdempotencyKey() })}>
              {BOOKER_CANCEL_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </SelectField>
            {(() => {
              const note = cancelFeeNote(t, cancelling.reason);
              return <Notice tone={note.free ? "ok" : "info"}>{note.text}</Notice>;
            })()}
            <p className="small muted">{riderName} and the driver are told at once. This can't be undone; book again if the ride is still needed.</p>
            <div className="row">
              <button className="btn danger" disabled={cancel.isPending}>Cancel the trip</button>
              <button type="button" className="btn ghost" onClick={() => setCancelling(null)}>Keep it</button>
            </div>
          </form>
        </Drawer>
      ) : null}
    </div>
  );
}

