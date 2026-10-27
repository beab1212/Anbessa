// Partner portal: what a fleet's cars made (payment-service GET /api/payments/earnings/org/:orgId,
// earnings:read @ ORG) — totals, per Addis day and per driver.

import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { allowed, api } from "../../lib/api";
import { birr, shortId } from "../../lib/format";
import { useSession } from "../../lib/session";
import { dayLabel, defaultRange, qs, rangeProblem, type EarningsPeriod, type FleetEarnings } from "../../lib/reports";
import { BarChart } from "../../components/BarChart";
import { Empty, Field, Notice, PageHead, Problem, Stat } from "../../components/ui";

const PERIODS: [EarningsPeriod, string][] = [["today", "Today"], ["week", "This week"], ["month", "This month"], ["custom", "Pick dates"]];
const compactBirr = (minor: number) => Math.round(minor / 100).toLocaleString("en-GB");

export function FleetEarningsPage() {
  const { orgId = "" } = useParams();
  const { partner } = useSession();
  const may = allowed(partner.principal, "earnings:read", { orgId });
  const [period, setPeriod] = useState<EarningsPeriod>("week");
  const [range, setRange] = useState(defaultRange);
  const problem = period === "custom" ? rangeProblem(range.from, range.to) : null;
  const query = qs({ period, ...(period === "custom" ? range : {}) });

  const q = useQuery({
    queryKey: ["fleet-earnings", orgId, query],
    enabled: may && !problem,
    queryFn: () => api<FleetEarnings>("partner", `/api/payments/earnings/org/${orgId}${query}`),
  });

  if (partner.loading) return <p className="muted">Loading…</p>;
  if (!may) return <div className="page"><Notice tone="error">Only the fleet's owner can see its earnings.</Notice></div>;
  const s = q.data;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Earnings"
        lede="Trips settled for your company's cars, in Addis Ababa days. Net is what the fleet made after commission and VAT."
        right={
          <div className="tabs" role="tablist">
            {PERIODS.map(([k, label]) => <button key={k} role="tab" aria-selected={period === k} onClick={() => setPeriod(k)}>{label}</button>)}
          </div>
        }
      />
      {period === "custom" ? (
        <div className="card pad audit-filters">
          <Field label="From" type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          <Field label="To" type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </div>
      ) : null}
      {problem ? <div className="alert error" role="alert"><span>{problem}</span></div> : null}
      <Problem error={q.error} />
      {q.isLoading && !problem ? <p className="muted">Loading…</p> : null}
      {s ? (
        <>
          <div className="stats">
            <Stat label="Trips" value={s.trips} sub={s.cancellations ? `${s.cancellations} cancellation fees` : undefined} />
            <Stat label="Gross fares" value={birr(s.grossMinor)} />
            <Stat label="Commission" value={birr(s.commissionMinor)} />
            <Stat label="VAT" value={birr(s.vatMinor)} />
            <Stat label="Net" value={birr(s.netMinor)} sub={`balance ${s.balanceChangeMinor >= 0 ? "+" : ""}${birr(s.balanceChangeMinor)}`} />
            <Stat label="Cash collected" value={birr(s.cashCollectedMinor)} sub="kept by drivers" />
          </div>
          {s.byDay.length === 0 ? <Empty title="No settled trips in this period." /> : (
            <>
              <div className="card pad">
                <h2 className="section-title">Per day (ETB)</h2>
                <BarChart
                  title="Gross and net per day"
                  rows={s.byDay}
                  label={(d) => dayLabel(d.day)}
                  format={compactBirr}
                  value={(d, k) => (k === "gross" ? d.grossMinor : d.netMinor)}
                  series={[{ key: "gross", label: "gross", color: "var(--info)" }, { key: "net", label: "net", color: "var(--success)" }]}
                />
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Day</th><th className="num">Trips</th><th className="num">Gross</th><th className="num">Net</th></tr></thead>
                  <tbody>
                    {s.byDay.map((d) => (
                      <tr key={d.day}><td className="small">{d.day}</td><td className="num">{d.trips}</td><td className="num">{birr(d.grossMinor)}</td><td className="num">{birr(d.netMinor)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {s.byDriver.length ? (
            <div className="card">
              <div className="card-head"><strong>By driver</strong></div>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Driver</th><th className="num">Trips</th><th className="num">Gross</th><th className="num">Net</th></tr></thead>
                  <tbody>
                    {s.byDriver.map((d) => (
                      <tr key={d.driverId}><td className="mono small" title={d.driverId}>{shortId(d.driverId)}</td><td className="num">{d.trips}</td><td className="num">{birr(d.grossMinor)}</td><td className="num">{birr(d.netMinor)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
