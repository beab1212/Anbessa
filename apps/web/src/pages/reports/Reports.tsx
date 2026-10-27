// Daily reports: trips per Addis day for a city (trip-service, report:read) and, for finance
// (report:read_finance), money per day (payment-service). Both export to CSV.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { allowed, api, citiesFor } from "../../lib/api";
import { birr, CITIES, CITY_NAMES } from "../../lib/format";
import { useSession } from "../../lib/session";
import {
  CHANNEL_WORD, dayLabel, defaultRange, downloadCsv, duration, METHOD_WORD, percentOf, qs, rangeProblem, SIDE_WORD, sumOf,
  type FinanceDailyReport, type FinanceDay, type TripDailyReport, type TripDay,
} from "../../lib/reports";
import { BarChart } from "../../components/BarChart";
import { Empty, Field, PageHead, Problem, Stat } from "../../components/ui";

const compactBirr = (minor: number) => Math.round(minor / 100).toLocaleString("en-GB");

export function ReportsPage() {
  const { staff } = useSession();
  const p = staff.principal;
  const global = allowed(p, "report:read");
  const cities = citiesFor(p, "report:read", CITIES);
  const finance = allowed(p, "report:read_finance");

  const [picked, setPicked] = useState<string | null>(null);
  // "" = all cities (global holders only)
  const cityId = picked !== null && (picked === "" ? global : cities.includes(picked)) ? picked : global ? "" : (cities[0] ?? "");
  const [range, setRange] = useState(defaultRange);
  const [tab, setTab] = useState<"trips" | "finance">("trips");
  const [csvError, setCsvError] = useState<unknown>(null);
  const problem = rangeProblem(range.from, range.to);
  const query = qs({ cityId: cityId || undefined, from: range.from, to: range.to });
  const shown = tab === "finance" && finance ? "finance" : "trips";

  async function exportCsv() {
    setCsvError(null);
    const base = shown === "finance" ? "/api/payments/reports/daily.csv" : "/api/trips/reports/daily.csv";
    try {
      await downloadCsv("staff", `${base}${query}`, `${shown}-${cityId || "all"}-${range.from}-${range.to}.csv`);
    } catch (err) {
      setCsvError(err);
    }
  }

  if (!global && cities.length === 0) return <div className="page"><Empty title="Nothing here for your roles." /></div>;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Reports"
        lede="Per day in Addis Ababa time. Trips by status, channel and vehicle type; money for finance."
        right={<button className="btn secondary" disabled={!!problem} onClick={() => void exportCsv()}><Download /> Download CSV</button>}
      />
      <div className="card pad audit-filters">
        <div className="field">
          <label className="label" htmlFor="report-city">City</label>
          <select id="report-city" className="select" value={cityId} onChange={(e) => setPicked(e.target.value)}>
            {global ? <option value="">All cities</option> : null}
            {(global ? CITIES : cities).map((c) => <option key={c} value={c}>{CITY_NAMES[c] ?? c}</option>)}
          </select>
        </div>
        <Field label="From" type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        <Field label="To" type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} />
      </div>
      {problem ? <div className="alert error" role="alert"><span>{problem}</span></div> : null}
      <Problem error={csvError} />
      {finance ? (
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={shown === "trips"} onClick={() => setTab("trips")}>Trips</button>
          <button role="tab" aria-selected={shown === "finance"} onClick={() => setTab("finance")}>Finance</button>
        </div>
      ) : null}
      {problem ? null : shown === "finance" ? <FinanceReport query={query} /> : <TripReport query={query} />}
    </div>
  );
}

function TripReport({ query }: { query: string }) {
  const q = useQuery({
    queryKey: ["reports", "trips", query],
    queryFn: () => api<TripDailyReport>("staff", `/api/trips/reports/daily${query}`),
  });
  if (q.error) return <Problem error={q.error} />;
  if (!q.data) return <p className="muted">Loading…</p>;
  const { days, totals } = q.data;
  const channels = [...new Set(days.flatMap((d) => Object.keys(d.byChannel)))].sort();
  const vehicleTypes = [...new Set(days.flatMap((d) => Object.keys(d.byVehicleType)))].sort();
  const sides = Object.entries(totals.cancellations.bySide).filter(([, n]) => n > 0);
  const reasons = Object.entries(totals.cancellations.byReason).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);

  return (
    <div className="stack" style={{ gap: "1rem" }}>
      <div className="stats">
        <Stat label="Requested" value={totals.requested} />
        <Stat label="Completed" value={totals.completed} sub={`${percentOf(totals.completionRate)} of ended trips`} />
        <Stat label="Cancelled" value={totals.cancelled} />
        <Stat label="Time to match" value={duration(totals.avgSecondsToMatch)} sub="average" />
        <Stat label="GMV (estimate)" value={birr(totals.gmvMinor)} sub={`fees ${birr(totals.cancelFeeMinor)}`} />
      </div>
      <div className="card pad">
        <h2 className="section-title">Trips per day</h2>
        <BarChart<TripDay>
          title="Requested and completed trips per day"
          rows={days}
          label={(d) => dayLabel(d.date)}
          value={(d, k) => (k === "requested" ? d.requested : k === "completed" ? d.completed : d.cancelled)}
          series={[
            { key: "requested", label: "requested", color: "var(--info)" },
            { key: "completed", label: "completed", color: "var(--success)" },
            { key: "cancelled", label: "cancelled", color: "var(--danger)" },
          ]}
        />
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Day</th><th className="num">Requested</th><th className="num">Completed</th><th className="num">Cancelled</th><th className="num">Active</th>
              <th className="num">Completion</th><th className="num">To match</th><th className="num">GMV</th>
              {channels.map((c) => <th key={c} className="num">{CHANNEL_WORD[c] ?? c}</th>)}
              {vehicleTypes.map((v) => <th key={v} className="num">{v}</th>)}
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.date}>
                <td className="small">{d.date}</td>
                <td className="num">{d.requested}</td>
                <td className="num">{d.completed}</td>
                <td className="num">{d.cancelled}</td>
                <td className="num">{d.active}</td>
                <td className="num">{percentOf(d.completionRate)}</td>
                <td className="num">{duration(d.avgSecondsToMatch)}</td>
                <td className="num">{birr(d.gmvMinor)}</td>
                {channels.map((c) => <td key={c} className="num">{d.byChannel[c]?.requested ?? 0}</td>)}
                {vehicleTypes.map((v) => <td key={v} className="num">{d.byVehicleType[v]?.requested ?? 0}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sides.length || reasons.length ? (
        <div className="card pad">
          <h2 className="section-title">Cancellations</h2>
          <dl className="kv">
            {sides.map(([side, n]) => <FragmentKV key={side} k={`by ${SIDE_WORD[side] ?? side}`} v={n} />)}
            {reasons.map(([reason, n]) => <FragmentKV key={reason} k={reason.toLowerCase().replace(/_/g, " ")} v={n} />)}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

function FragmentKV({ k, v }: { k: string; v: number }) {
  return <><dt>{k}</dt><dd>{v}</dd></>;
}

function FinanceReport({ query }: { query: string }) {
  const q = useQuery({
    queryKey: ["reports", "finance", query],
    queryFn: () => api<FinanceDailyReport>("staff", `/api/payments/reports/daily${query}`),
  });
  if (q.error) return <Problem error={q.error} />;
  if (!q.data) return <p className="muted">Loading…</p>;
  const { days, totals } = q.data;
  const methods = [...new Set(days.flatMap((d) => Object.keys(d.byMethod)))].sort();
  const collections = [...new Set(days.flatMap((d) => Object.keys(d.collections)))].sort();
  const topUps = [...new Set(days.flatMap((d) => Object.keys(d.topUps)))].sort();

  return (
    <div className="stack" style={{ gap: "1rem" }}>
      <div className="stats">
        <Stat label="Fares settled" value={birr(totals.fareMinor)} sub={`${totals.trips} trips`} />
        <Stat label="Commission" value={birr(totals.commissionMinor + totals.cancellationFees.commissionMinor)} sub={`fees ${birr(totals.cancellationFees.commissionMinor)}`} />
        <Stat label="VAT" value={birr(totals.vatMinor)} />
        <Stat label="Collected" value={birr(sumOf(totals.collections, (c) => c.amountMinor))} sub="rider payments" />
        <Stat label="Refunds" value={birr(totals.refunds.amountMinor)} sub={`${totals.refunds.count} refunds`} />
        <Stat label="Payouts" value={birr(totals.payouts.amountMinor)} sub={`${totals.payouts.count} lines`} />
      </div>
      <div className="card pad">
        <h2 className="section-title">Fares and commission per day (ETB)</h2>
        <BarChart<FinanceDay>
          title="Fares and commission per day"
          rows={days}
          label={(d) => dayLabel(d.date)}
          format={compactBirr}
          value={(d, k) => (k === "fare" ? d.fareMinor : d.commissionMinor)}
          series={[
            { key: "fare", label: "fares", color: "var(--info)" },
            { key: "commission", label: "commission", color: "var(--accent)" },
          ]}
        />
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Day</th><th className="num">Trips</th><th className="num">Fares</th><th className="num">Commission</th><th className="num">VAT</th>
              {methods.map((m) => <th key={m} className="num">{METHOD_WORD[m] ?? m} fares</th>)}
              {collections.map((m) => <th key={m} className="num">collected {METHOD_WORD[m] ?? m}</th>)}
              <th className="num">Cancel fees</th><th className="num">Refunds</th><th className="num">Payouts</th>
              {topUps.map((c) => <th key={c} className="num">top-ups {METHOD_WORD[c] ?? c}</th>)}
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.date}>
                <td className="small">{d.date}</td>
                <td className="num">{d.trips}</td>
                <td className="num">{birr(d.fareMinor)}</td>
                <td className="num">{birr(d.commissionMinor)}</td>
                <td className="num">{birr(d.vatMinor)}</td>
                {methods.map((m) => <td key={m} className="num">{birr(d.byMethod[m]?.fareMinor ?? 0)}</td>)}
                {collections.map((m) => <td key={m} className="num">{birr(d.collections[m]?.amountMinor ?? 0)}</td>)}
                <td className="num">{birr(d.cancellationFees.feeMinor)}</td>
                <td className="num">{birr(d.refunds.amountMinor)}</td>
                <td className="num">{birr(d.payouts.amountMinor)}</td>
                {topUps.map((c) => <td key={c} className="num">{birr(d.topUps[c]?.amountMinor ?? 0)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
