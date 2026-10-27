// /t/:token — a trip someone shared with you: where the car is, who's driving, the route.
// No sign-in; the token in the link is the only key. Polls every 5 s while the trip is on.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useParams } from "react-router-dom";
import type { LatLng } from "@ride-app/shared-location";
import { http } from "../../lib/api";
import { decodePolyline6 } from "../../lib/polyline";
import { CityMap } from "../../components/map/CityMap";
import { DriverMarker, DropoffMarker, PickupMarker, RouteLine } from "../../components/map/markers";

interface SharedTripView {
  status: "requested" | "matched" | "en_route" | "in_progress" | "completed" | "cancelled";
  pickup: { name: string | null } & LatLng;
  dropoff: { name: string | null } & LatLng;
  driver: { firstName: string | null; photo: string | null } | null;
  vehicle: { plateNumber: string; vehicleType: string; make: string; model: string; color: string } | null;
  position: { lat: number; lng: number; heading: number | null; at: string } | null;
  routePolyline: string | null;
  times: { matchedAt: string | null; arrivedAt: string | null; startedAt: string | null; endedAt: string | null };
  estDurationSeconds: number;
  expiresAt: string;
}

function headline(t: SharedTripView, who: string) {
  switch (t.status) {
    case "requested": return "Finding a driver";
    case "matched": return `${who} is on the way to the pickup`;
    case "en_route": return t.times.arrivedAt ? `${who} has arrived at the pickup` : `${who} is on the way to the pickup`;
    case "in_progress": return "On the way to the destination";
    case "completed": return "Arrived at the destination";
    case "cancelled": return "This trip was cancelled";
  }
}

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
};

export function SharedTrip() {
  const { token = "" } = useParams();
  const q = useQuery({
    queryKey: ["shared-trip", token],
    queryFn: async () => (await http.get<SharedTripView>(`/api/trips/shared/${encodeURIComponent(token)}`)).data,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === "completed" || s === "cancelled" || query.state.error ? false : 5000;
    },
    retry: (n, err) => n < 2 && (err as { status?: number }).status !== 404,
  });
  const t = q.data;
  const polyline = t?.routePolyline ?? null;
  const route = useMemo(() => (polyline ? decodePolyline6(polyline) : []), [polyline]);
  const fit = useMemo(() => (t ? [t.pickup, t.dropoff, ...(t.position ? [t.position] : [])] : []), [t]);

  if (q.isError) {
    const gone = (q.error as { status?: number }).status === 404;
    return (
      <div className="shared-page">
        <div className="shared-message">
          <h1>{gone ? "This link has ended" : "Can't load this trip"}</h1>
          <p>{gone ? "Shared trips stop showing 30 minutes after they end, or when the rider stops sharing." : "Check your connection and try again."}</p>
          {gone ? null : <button className="btn primary" onClick={() => q.refetch()}>Try again</button>}
        </div>
      </div>
    );
  }
  if (!t) return <div className="shared-page"><div className="shared-message"><p>Loading the trip…</p></div></div>;

  const who = t.driver?.firstName ?? "The driver";
  const live = t.status !== "completed" && t.status !== "cancelled";
  return (
    <div className="shared-page">
      <div className="shared-map">
        <CityMap cityId="addis-ababa" fit={fit} fitOnce>
          {route.length > 1 ? <RouteLine id="shared" points={route} /> : null}
          <PickupMarker lat={t.pickup.lat} lng={t.pickup.lng} tone="green" title="Pickup" />
          <DropoffMarker lat={t.dropoff.lat} lng={t.dropoff.lng} />
          {t.position ? <DriverMarker lat={t.position.lat} lng={t.position.lng} heading={t.position.heading ?? undefined} onTrip title={who} /> : null}
        </CityMap>
      </div>
      <section className="shared-card" aria-live="polite">
        <div className="shared-brand">Anbessa · shared trip</div>
        <h1>{headline(t, who)}</h1>
        {t.driver || t.vehicle ? (
          <div className="shared-driver">
            {t.driver?.photo ? <img src={t.driver.photo} alt="" className="shared-avatar" /> : <div className="shared-avatar initials">{who.slice(0, 1)}</div>}
            <div>
              <div className="shared-name">{who}</div>
              {t.vehicle ? <div className="shared-car">{t.vehicle.color} {t.vehicle.make} {t.vehicle.model}</div> : null}
            </div>
            {t.vehicle ? <div className="shared-plate">{t.vehicle.plateNumber}</div> : null}
          </div>
        ) : null}
        <ol className="shared-route">
          <li><span className="dot pickup" />{t.pickup.name ?? "Pickup"}</li>
          <li><span className="dot dropoff" />{t.dropoff.name ?? "Destination"}</li>
        </ol>
        <p className="shared-foot">
          {live ? (t.position ? `Car position updated ${ago(t.position.at)}.` : "Waiting for the car's position…") : `Link ends ${new Date(t.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`}
        </p>
      </section>
    </div>
  );
}
