import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Phone, RotateCcw } from "lucide-react";
import type { Trip } from "@ride-app/shared-types";
import type { LatLng } from "@ride-app/shared-location";
import { api, newIdempotencyKey } from "../../lib/api";
import { birr, phone as fmtPhone, shortId, toE164 } from "../../lib/format";
import { useStaffCity } from "../../lib/hooks";
import { useClientConfig } from "../../lib/platform";
import { decodePolyline6 } from "../../lib/polyline";
import { phoneMethods, providersFor, routeSummary, useFares, usePaymentMethods, useRoutePreview, vehicleOptions, type FareCard, type PhoneMethod } from "../../lib/trips";
import { CityMap } from "../../components/map/CityMap";
import { DropoffMarker, PickupMarker, RouteLine, TripLine } from "../../components/map/markers";
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

const PAY_LABEL: Record<PhoneMethod, string> = { CASH: "Cash to the driver", MOBILE_MONEY: "Mobile money" };

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
  const [vehicle, setVehicle] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [pay, setPay] = useState<PhoneMethod | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const e164 = toE164(raw);
  const config = useClientConfig();
  const vehicles = useMemo(() => (cityId ? vehicleOptions(config, cityId) : []), [config, cityId]);
  const fares = useFares(cityId);
  const methods = usePaymentMethods(cityId);
  const payOptions = phoneMethods(methods.data?.methods);
  // the choice falls back to the first offered option when the city (or its settings) change
  const car = vehicle && vehicles.some((v) => v.code === vehicle) ? vehicle : (vehicles[0]?.code ?? null);
  const payWith = pay && payOptions.includes(pay) ? pay : (payOptions[0] ?? null);
  const card = fares.data?.find((f) => f.vehicleType === car);
  const preview = useRoutePreview(pickup, dropoff);
  const line = preview.data?.polyline6;
  const road = useMemo(() => (line ? decodePolyline6(line) : []), [line]);
  const fit = useMemo(() => (road.length > 1 ? road : [pickup, dropoff].filter((p): p is Place => !!p)), [pickup, dropoff, road]);

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
      const r = await api<{ quotes: Quote[] }>("staff", "/api/pricing/estimates", {
        body: { pickup, dropoff, vehicleTypes: [car], pickupAddress: pickup!.name, dropoffAddress: dropoff!.name },
      });
      setQuote(r.quotes[0] ?? null);
    });

  const book = () =>
    run(async () => {
      setTrip(await api<Trip>("staff", "/api/trips", { body: { quoteId: quote!.id, paymentMethod: payWith, riderUserId: rider!.userId }, idempotencyKey: idemKey }));
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
    setVehicle(null);
    setQuote(null);
    setPay(null);
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
            <CityPicker cities={cities} value={cityId} onChange={(c) => { setCityId(c); setQuote(null); }} />
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
                <p style={{ margin: "0.4rem 0 0" }}><em>"Your ride from {pickup?.name} costs about {birr(trip.fare.estimateMinor)}, paid {trip.paymentMethod === "CASH" ? "in cash to the driver" : "by mobile money"}. Your trip number is {shortId(trip.id)}."</em></p>
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
                  {pickup && dropoff ? (
                    <p className="xs muted" style={{ margin: "0 0 0.75rem" }} aria-live="polite">
                      {preview.isLoading ? "Finding the road route…" : preview.data ? `By road: ${routeSummary(preview.data.distanceMeters, preview.data.durationSeconds)}${preview.data.approximate ? " (straight-line estimate, routing is offline)" : ""}` : preview.error ? "Road route unavailable; the fare is still quoted." : null}
                    </p>
                  ) : null}
                  {vehicles.length === 0 ? <Notice tone="error">No car types are offered in this city. Check Administration → Cities and vehicles.</Notice> : (
                    <fieldset className="options">
                      <legend className="label">Car</legend>
                      {vehicles.map((v) => (
                        <label key={v.code} className="option">
                          <input type="radio" name="vehicle" checked={car === v.code} onChange={() => { setVehicle(v.code); setQuote(null); }} />
                          <span><strong>{v.name}</strong> <span className="muted small">{v.seats}</span></span>
                        </label>
                      ))}
                    </fieldset>
                  )}
                  <FareCardLine card={card} loading={fares.isLoading} failed={!!fares.error} />
                  {!quote ? <button className="btn secondary block" disabled={busy || !pickup || !dropoff || !car} onClick={() => void getQuote()}>Get the fare</button> : null}
                </section>
              ) : null}

              {quote ? (
                <section>
                  <p className="small muted" style={{ marginBottom: "0.5rem" }}>"It's {birr(quote.fareMinor)}. Cash to the driver, or mobile money?"</p>
                  <div style={{ marginBottom: "0.9rem" }}>
                    <Stat label="Fare, fixed" value={<span className="mono">{birr(quote.fareMinor)}</span>} sub={<span className="mono">{(quote.distanceMeters / 1000).toFixed(1)} km · {Math.round(quote.durationSeconds / 60)} min drive</span>} />
                  </div>
                  {quote.approximate ? <Notice>Routing is offline, so distance and time are straight-line estimates. The caller still pays the quoted fare.</Notice> : null}
                  <Problem error={methods.error} />
                  {methods.data && payOptions.length === 0 ? <Notice tone="error">Neither cash nor mobile money is switched on in this city, so a phone booking can't be paid.</Notice> : (
                    <fieldset className="options">
                      <legend className="label">Payment</legend>
                      {payOptions.map((m) => {
                        const via = m === "MOBILE_MONEY" ? providersFor(m, methods.data?.providers) : "";
                        return (
                          <label key={m} className="option">
                            <input type="radio" name="pay" checked={payWith === m} onChange={() => setPay(m)} /> <span>{PAY_LABEL[m]}{via ? <span className="muted small"> · {via}</span> : null}</span>
                          </label>
                        );
                      })}
                    </fieldset>
                  )}
                  <button className="btn block lg" disabled={busy || !payWith || methods.isLoading} onClick={() => void book()}>Request the ride</button>
                </section>
              ) : null}
            </>
          )}
        </div>
      </aside>

      <div className="map-area">
        <CityMap cityId={cityId} fit={fit} onClick={(p) => void placeFromMap(p)}>
          {pickup && dropoff ? (road.length > 1 ? <RouteLine id="phone-booking" points={road} /> : <TripLine id="phone-booking" from={pickup} to={dropoff} />) : null}
          {pickup ? <PickupMarker lat={pickup.lat} lng={pickup.lng} tone="amber" label="Pickup" /> : null}
          {dropoff ? <DropoffMarker lat={dropoff.lat} lng={dropoff.lng} label="Destination" /> : null}
        </CityMap>
      </div>
    </div>
  );
}

/** The city's price list for the chosen car, so the agent can explain the fare. */
function FareCardLine({ card, loading, failed }: { card: FareCard | undefined; loading: boolean; failed: boolean }) {
  if (loading) return <p className="xs muted">Loading the fare card…</p>;
  if (failed || !card) return failed ? <p className="xs muted">Fare card unavailable; the quote still has the exact fare.</p> : null;
  return (
    <dl className="kv small" style={{ gridTemplateColumns: "1fr auto", margin: "0 0 0.9rem" }} aria-label="Fare card">
      <dt>Base</dt><dd className="num mono">{birr(card.baseMinor)}</dd>
      <dt>Per km</dt><dd className="num mono">{birr(card.perKmMinor)}</dd>
      <dt>Per minute</dt><dd className="num mono">{birr(card.perMinMinor)}</dd>
      <dt>Minimum fare</dt><dd className="num mono">{birr(card.minFareMinor)}</dd>
      <dt>Waiting, per minute</dt><dd className="num mono">{birr(card.waitingPerMinMinor)}</dd>
    </dl>
  );
}
