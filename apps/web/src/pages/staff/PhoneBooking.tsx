import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Phone, RotateCcw } from "lucide-react";
import type { Trip } from "@ride-app/shared-types";
import type { LatLng } from "@ride-app/shared-location";
import { api, newIdempotencyKey } from "../../lib/api";
import { birr, phone as fmtPhone, shortId, toE164 } from "../../lib/format";
import { useStaffCity } from "../../lib/hooks";
import { CityMap } from "../../components/map/CityMap";
import { DropoffMarker, PickupMarker, TripLine } from "../../components/map/markers";
import { CityPicker } from "../../components/CityPicker";
import { PlacePicker, type Place } from "../../components/PlacePicker";
import { Empty, Field, Notice, Problem, Stat } from "../../components/ui";

interface Quote {
  id: string;
  vehicleType: string;
  fareMinor: number;
  distanceMeters: number;
  durationSeconds: number;
  approximate: boolean;
  expiresAt: string;
}

const VEHICLES = [
  { id: "economy", name: "Economy", seats: "4 seats" },
  { id: "comfort", name: "Comfort", seats: "4 seats, newer cars" },
  { id: "minivan", name: "Minivan", seats: "7 seats" },
];

/**
 * Workflow 10: a caller without the app. The agent finds or creates the caller's account by phone
 * number (a guest the caller can claim later), books on their behalf, and reads the fare out.
 * Places come from search or a tap on the map (reverse-geocoded for the label).
 */
export function PhoneBooking() {
  const { cities, cityId, setCityId } = useStaffCity("trip:create_on_behalf");
  const [raw, setRaw] = useState("");
  const [rider, setRider] = useState<{ userId: string; created: boolean; phone: string } | null>(null);
  const [pickup, setPickup] = useState<Place | null>(null);
  const [dropoff, setDropoff] = useState<Place | null>(null);
  const [vehicle, setVehicle] = useState("economy");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [pay, setPay] = useState<"CASH" | "MOBILE_MONEY">("CASH");
  const [trip, setTrip] = useState<Trip | null>(null);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const e164 = toE164(raw);
  const fit = useMemo(() => [pickup, dropoff].filter((p): p is Place => !!p), [pickup, dropoff]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const findCaller = () =>
    run(async () => {
      const r = await api<{ userId: string; created: boolean }>("staff", "/api/identity/guests", { body: { phoneNumber: e164, cityId } });
      setRider({ ...r, phone: e164! });
    });

  const getQuote = () =>
    run(async () => {
      const r = await api<{ quotes: Quote[] }>("staff", "/api/trips/estimates", {
        body: { pickup, dropoff, vehicleTypes: [vehicle], pickupAddress: pickup!.name, dropoffAddress: dropoff!.name },
      });
      setQuote(r.quotes[0] ?? null);
    });

  const book = () =>
    run(async () => {
      setTrip(await api<Trip>("staff", "/api/trips", { body: { quoteId: quote!.id, paymentMethod: pay, riderUserId: rider!.userId }, idempotencyKey: idemKey }));
    });

  function setPlace(which: "pickup" | "dropoff", p: Place | null) {
    (which === "pickup" ? setPickup : setDropoff)(p);
    setQuote(null);
  }

  /** A tap on the map fills the pickup first, then the destination. */
  async function placeFromMap(at: LatLng) {
    if (!rider || trip) return;
    const which = !pickup ? "pickup" : !dropoff ? "dropoff" : null;
    if (!which) return;
    const pin: Place = { name: "Pin on the map", label: `${at.lat.toFixed(4)}, ${at.lng.toFixed(4)}`, ...at };
    setPlace(which, pin);
    try {
      const r = await api<{ name?: string; label?: string }>("staff", `/api/maps/reverse?${new URLSearchParams({ lat: String(at.lat), lng: String(at.lng) })}`);
      if (r.name || r.label) (which === "pickup" ? setPickup : setDropoff)((cur) => (cur === pin ? { ...pin, name: r.name || r.label!, label: r.name ? r.label : undefined } : cur));
    } catch {
      // address lookup offline: the coordinates are enough to book
    }
  }

  function nextCaller() {
    setRaw("");
    setRider(null);
    setPickup(null);
    setDropoff(null);
    setVehicle("economy");
    setQuote(null);
    setPay("CASH");
    setTrip(null);
    setIdemKey(newIdempotencyKey());
    setError(null);
  }

  if (!cityId) return <div className="content"><Empty title="No city">You don't have a city to book in.</Empty></div>;

  const step = trip ? 3 : quote ? 2 : rider ? 1 : 0;
  const stepClass = (i: number) => (i < step ? "done" : i === step ? "now" : "");

  return (
    <div className="workspace left">
      <aside className="panel">
        <div className="panel-head stack" style={{ gap: "0.6rem" }}>
          <div className="row between">
            <strong>Book by phone</strong>
            <CityPicker cities={cities} value={cityId} onChange={setCityId} />
          </div>
          <div className="steps" style={{ margin: 0 }}>
            <span className={stepClass(0)}>Caller</span>
            <span className={stepClass(1)}>Route</span>
            <span className={stepClass(2)}>Fare</span>
          </div>
        </div>

        <div className="panel-body">
          <Problem error={error} />

          {trip ? (
            <>
              <Notice tone="ok">Trip <span className="mono">{shortId(trip.id)}</span> requested for {fmtPhone(rider?.phone)}. Matching runs for up to 2 minutes; call back if no driver is found.</Notice>
              <div className="handover">
                <span className="label">Read this to the caller</span>
                <p style={{ margin: "0.4rem 0 0" }}><em>"Your ride from {pickup?.name} costs about {birr(trip.fare.estimateMinor)}, paid {pay === "CASH" ? "in cash to the driver" : "by mobile money"}. Your trip number is {shortId(trip.id)}."</em></p>
              </div>
              <div className="row">
                <Link className="btn" to={`/staff/trips/${trip.id}`}>Follow this trip</Link>
                <button className="btn secondary" onClick={nextCaller}><RotateCcw /> Next caller</button>
              </div>
            </>
          ) : (
            <>
              <section>
                <p className="small muted" style={{ marginBottom: "0.5rem" }}><Phone size={14} style={{ verticalAlign: "-2px" }} /> "Which number are you calling from?"</p>
                {rider ? (
                  <div className="place-chosen">
                    <span>
                      <strong className="mono">{fmtPhone(rider.phone)}</strong>
                      <span className="muted small"> · {rider.created ? "new caller, guest account created" : "known caller"}</span>
                    </span>
                    <button type="button" className="link" onClick={() => { setRider(null); setQuote(null); }}>change</button>
                  </div>
                ) : (
                  <form onSubmit={(e) => { e.preventDefault(); void findCaller(); }}>
                    <Field className="big" label="Caller's mobile" inputMode="tel" value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="09 11 22 33 44" hint={e164 ? fmtPhone(e164) : "09… or 07…"} />
                    <button className="btn block" disabled={busy || !e164}>Find caller</button>
                  </form>
                )}
              </section>

              {rider ? (
                <section>
                  <p className="small muted" style={{ marginBottom: "0.5rem" }}>"Where should the driver pick you up, and where are you going?"</p>
                  <PlacePicker label="Pickup" cityId={cityId} surface="staff" value={pickup} onChange={(p) => setPlace("pickup", p)} hint={!pickup ? "Or tap the map" : undefined} />
                  <PlacePicker label="Destination" cityId={cityId} surface="staff" value={dropoff} onChange={(p) => setPlace("dropoff", p)} hint={pickup && !dropoff ? "Or tap the map" : undefined} />
                  <fieldset className="options">
                    <legend className="label">Car</legend>
                    {VEHICLES.map((v) => (
                      <label key={v.id} className="option">
                        <input type="radio" name="vehicle" checked={vehicle === v.id} onChange={() => { setVehicle(v.id); setQuote(null); }} />
                        <span><strong>{v.name}</strong> <span className="muted small">{v.seats}</span></span>
                      </label>
                    ))}
                  </fieldset>
                  {!quote ? <button className="btn secondary block" disabled={busy || !pickup || !dropoff} onClick={() => void getQuote()}>Get the fare</button> : null}
                </section>
              ) : null}

              {quote ? (
                <section>
                  <p className="small muted" style={{ marginBottom: "0.5rem" }}>"It's {birr(quote.fareMinor)}. Cash to the driver, or mobile money?"</p>
                  <div style={{ marginBottom: "0.9rem" }}>
                    <Stat label="Fare, fixed" value={<span className="mono">{birr(quote.fareMinor)}</span>} sub={<span className="mono">{(quote.distanceMeters / 1000).toFixed(1)} km · {Math.round(quote.durationSeconds / 60)} min drive</span>} />
                  </div>
                  {quote.approximate ? <Notice>Routing is offline, so distance and time are straight-line estimates. The caller still pays the quoted fare.</Notice> : null}
                  <fieldset className="options">
                    <legend className="label">Payment</legend>
                    <label className="option"><input type="radio" name="pay" checked={pay === "CASH"} onChange={() => setPay("CASH")} /> <span>Cash to the driver</span></label>
                    <label className="option"><input type="radio" name="pay" checked={pay === "MOBILE_MONEY"} onChange={() => setPay("MOBILE_MONEY")} /> <span>Mobile money</span></label>
                  </fieldset>
                  <button className="btn block lg" disabled={busy} onClick={() => void book()}>Request the ride</button>
                </section>
              ) : null}
            </>
          )}
        </div>
      </aside>

      <div className="map-area">
        <CityMap cityId={cityId} fit={fit} onClick={(p) => void placeFromMap(p)}>
          {pickup && dropoff ? <TripLine id="phone-booking" from={pickup} to={dropoff} /> : null}
          {pickup ? <PickupMarker lat={pickup.lat} lng={pickup.lng} tone="amber" label="Pickup" /> : null}
          {dropoff ? <DropoffMarker lat={dropoff.lat} lng={dropoff.lng} label="Destination" /> : null}
        </CityMap>
      </div>
    </div>
  );
}
