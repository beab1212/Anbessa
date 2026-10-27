// Find trips (trip-service GET /api/trips/search, trip:read in the city, or everywhere): filter by
// city, status, dates, channel, payment, people, vehicle, company or a trip id prefix; newest first.

import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { allowed, api, citiesFor } from "../../lib/api";
import { birr, CITIES, CITY_NAMES, dayAndTime, shortId, STATUS_LABEL } from "../../lib/format";
import { useSession } from "../../lib/session";
import {
  CHANNEL_WORD, CHANNELS, EMPTY_SEARCH, METHOD_WORD, PAYMENT_METHODS, qs, rangeProblem, TRIP_STATUSES,
  type TripPage, type TripSearchFilters,
} from "../../lib/reports";
import { Empty, Field, PageHead, Problem, SelectField, TripStatus } from "../../components/ui";

export function TripSearchPage() {
  const { staff } = useSession();
  const p = staff.principal;
  const global = allowed(p, "trip:read");
  const cities = citiesFor(p, "trip:read", CITIES);
  const firstCity = global ? "" : (cities[0] ?? "");
  const [form, setForm] = useState<TripSearchFilters>({ ...EMPTY_SEARCH, cityId: firstCity });
  const [applied, setApplied] = useState<TripSearchFilters>({ ...EMPTY_SEARCH, cityId: firstCity });
  const [formError, setFormError] = useState<string | null>(null);
  const set = (k: keyof TripSearchFilters) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const query = qs({ ...applied, q: applied.q.trim(), riderUserId: applied.riderUserId.trim(), driverUserId: applied.driverUserId.trim(), vehicleId: applied.vehicleId.trim(), billingOrgId: applied.billingOrgId.trim(), limit: 50 });
  const q = useInfiniteQuery({
    queryKey: ["trip-search", query],
    enabled: global || !!applied.cityId,
    initialPageParam: "",
    getNextPageParam: (last: TripPage) => last.next ?? undefined,
    queryFn: ({ pageParam }) => api<TripPage>("staff", `/api/trips/search${query}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`),
  });
  const rows = q.data?.pages.flatMap((pg) => pg.trips) ?? [];

  function submit(e: FormEvent) {
    e.preventDefault();
    if (form.from && form.to) {
      const problem = rangeProblem(form.from, form.to);
      if (problem) return setFormError(problem);
    }
    if (form.q.trim() && !/^[0-9a-fA-F-]{1,36}$/.test(form.q.trim())) return setFormError("A trip id has only 0–9, a–f and dashes.");
    setFormError(null);
    setApplied(form);
  }

  if (!global && cities.length === 0) return <div className="page"><Empty title="Nothing here for your roles." /></div>;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead title="Find a trip" lede="Search trips by city, date, status, people, vehicle or company. Newest first." />
      <form className="card pad stack" onSubmit={submit} style={{ gap: "0.5rem" }}>
        <div className="audit-filters">
          <SelectField label="City" value={form.cityId} onChange={set("cityId")}>
            {global ? <option value="">All cities</option> : null}
            {(global ? CITIES : cities).map((c) => <option key={c} value={c}>{CITY_NAMES[c] ?? c}</option>)}
          </SelectField>
          <Field label="Trip id starts with" className="mono" value={form.q} onChange={set("q")} placeholder="0193a…" />
          <SelectField label="Status" value={form.status} onChange={set("status")}>
            <option value="">any</option>
            {TRIP_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>)}
          </SelectField>
          <Field label="From" type="date" value={form.from} onChange={set("from")} />
          <Field label="To" type="date" value={form.to} onChange={set("to")} />
          <SelectField label="Channel" value={form.channel} onChange={set("channel")}>
            <option value="">any</option>
            {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_WORD[c]}</option>)}
          </SelectField>
          <SelectField label="Payment" value={form.paymentMethod} onChange={set("paymentMethod")}>
            <option value="">any</option>
            {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{METHOD_WORD[m]}</option>)}
          </SelectField>
          <Field label="Rider (user id)" className="mono" value={form.riderUserId} onChange={set("riderUserId")} />
          <Field label="Driver (user id)" className="mono" value={form.driverUserId} onChange={set("driverUserId")} />
          <Field label="Vehicle id" className="mono" value={form.vehicleId} onChange={set("vehicleId")} />
          <Field label="Company (org id)" className="mono" value={form.billingOrgId} onChange={set("billingOrgId")} />
        </div>
        <div className="row" style={{ gap: "0.5rem" }}>
          <button className="btn" type="submit"><Search /> Search</button>
          <button className="btn ghost" type="button" onClick={() => { const empty = { ...EMPTY_SEARCH, cityId: firstCity }; setForm(empty); setApplied(empty); setFormError(null); }}>Clear</button>
        </div>
      </form>
      {formError ? <div className="alert error" role="alert"><span>{formError}</span></div> : null}
      <Problem error={q.error} />
      {q.isLoading ? <p className="muted">Loading…</p> : null}
      {q.data && rows.length === 0 ? <Empty title="No trips match these filters." /> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Trip</th><th>Requested</th><th>Status</th><th>City</th><th>From → to</th><th>Channel</th><th>Payment</th><th className="num">Fare</th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="mono small"><Link to={`/staff/trips/${t.id}`}>{shortId(t.id)}</Link></td>
                  <td className="small">{dayAndTime(t.times.requestedAt)}</td>
                  <td><TripStatus status={t.status} label={STATUS_LABEL[t.status] ?? t.status} /></td>
                  <td className="small">{CITY_NAMES[t.cityId] ?? t.cityId}</td>
                  <td className="small">{t.pickup.address ?? "pin"} → {t.dropoff.address ?? "pin"}</td>
                  <td className="small">{CHANNEL_WORD[t.channel] ?? t.channel}</td>
                  <td className="small">{METHOD_WORD[t.paymentMethod] ?? t.paymentMethod}</td>
                  <td className="num">{birr(t.fare.finalMinor ?? t.fare.estimateMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {q.hasNextPage ? <div><button className="btn ghost" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Older trips</button></div> : null}
    </div>
  );
}
