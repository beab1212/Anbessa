// The regulatory report (report:read_regulatory: the Transport Bureau's REGULATOR role and the
// internal AUDITOR): per Addis calendar month and city, trips, active drivers and vehicles,
// kilometres and safety incidents. Aggregates only. trip-service GET /api/trips/reports/regulatory.

import { useState } from "react";
import { Download } from "lucide-react";
import { allowed, citiesFor } from "../../lib/api";
import { CITIES, CITY_NAMES } from "../../lib/format";
import { downloadCsv, qs } from "../../lib/reports";
import { useSession } from "../../lib/session";
import { lastMonth, monthLabel, monthRangeProblem, regulatoryTotals, useRegulatory } from "../../lib/trips2";
import { Empty, Field, PageHead, Problem, Stat } from "../../components/ui";

const n = (v: number) => v.toLocaleString("en-GB");

export function RegulatoryReportPage() {
  const { staff } = useSession();
  const p = staff.principal;
  const global = allowed(p, "report:read_regulatory");
  const cities = citiesFor(p, "report:read_regulatory", CITIES);
  const [picked, setPicked] = useState<string | null>(null);
  // "" = every city (global holders only)
  const cityId = picked !== null && (picked === "" ? global : cities.includes(picked)) ? picked : global ? "" : (cities[0] ?? "");
  const [from, setFrom] = useState(lastMonth);
  const [to, setTo] = useState(lastMonth);
  const [csvError, setCsvError] = useState<unknown>(null);
  const problem = monthRangeProblem(from, to);
  const report = useRegulatory(cityId, from, to, !problem && (global || cities.length > 0));
  const rows = report.data?.rows ?? [];
  const totals = regulatoryTotals(rows);

  async function exportCsv() {
    setCsvError(null);
    try {
      await downloadCsv("staff", `/api/trips/reports/regulatory.csv${qs({ cityId, from, to })}`, `regulatory-${cityId || "all"}-${from}-${to}.csv`);
    } catch (err) {
      setCsvError(err);
    }
  }

  if (!global && cities.length === 0) return <div className="page"><Empty title="Nothing here for your roles." /></div>;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Regulatory report"
        lede="Monthly totals per city, in Addis Ababa time: trips, drivers and vehicles that completed a trip, distance driven, and safety incidents opened. No personal data."
        right={<button className="btn secondary" disabled={!!problem} onClick={() => void exportCsv()}><Download /> Download CSV</button>}
      />
      <div className="card pad audit-filters">
        <div className="field">
          <label className="label" htmlFor="regulatory-city">City</label>
          <select id="regulatory-city" className="select" value={cityId} onChange={(e) => setPicked(e.target.value)}>
            {global ? <option value="">All cities</option> : null}
            {(global ? CITIES : cities).map((c) => <option key={c} value={c}>{CITY_NAMES[c] ?? c}</option>)}
          </select>
        </div>
        <Field label="First month" type="month" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Field label="Last month" type="month" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      {problem ? <div className="alert error" role="alert"><span>{problem}</span></div> : null}
      <Problem error={report.error ?? csvError} />
      {report.isLoading && !problem ? <p className="muted">Loading…</p> : null}
      {report.data ? (
        <>
          <div className="stats">
            <Stat label="Trips completed" value={n(totals.tripsCompleted)} sub={`of ${n(totals.tripsRequested)} requested`} />
            <Stat label="Cancelled" value={n(totals.tripsCancelled)} sub={`${n(totals.tripsNoDriver)} with no driver found`} />
            <Stat label="Distance driven" value={`${n(totals.distanceKm)} km`} />
            <Stat label="Safety incidents" value={n(totals.safetyIncidents)} sub={`${n(totals.seriousIncidents)} high or critical`} alert={totals.seriousIncidents > 0} />
          </div>
          {rows.length === 0 ? <Empty title="No trips in these months." /> : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Month</th><th>City</th><th className="num">Requested</th><th className="num">Completed</th><th className="num">Cancelled</th>
                    <th className="num">No driver</th><th className="num">Active drivers</th><th className="num">Active vehicles</th><th className="num">km</th>
                    <th className="num">Incidents</th><th className="num">Serious</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.month}-${r.cityId}`}>
                      <td>{monthLabel(r.month)}</td>
                      <td>{CITY_NAMES[r.cityId] ?? r.cityId}</td>
                      <td className="num">{n(r.tripsRequested)}</td>
                      <td className="num">{n(r.tripsCompleted)}</td>
                      <td className="num">{n(r.tripsCancelled)}</td>
                      <td className="num">{n(r.tripsNoDriver)}</td>
                      <td className="num">{n(r.activeDrivers)}</td>
                      <td className="num">{n(r.activeVehicles)}</td>
                      <td className="num">{n(r.distanceKm)}</td>
                      <td className="num">{n(r.safetyIncidents)}</td>
                      <td className="num">{n(r.seriousIncidents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="xs muted" style={{ margin: 0 }}>
            Trips count by request month, completions by drop-off month. Active drivers and vehicles are distinct within a month and city, so they aren't added up across rows.
            Incidents are those opened by the safety team (support-service).
          </p>
        </>
      ) : null}
    </div>
  );
}
