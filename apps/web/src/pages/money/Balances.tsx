// Driver and fleet balances (balance:read): the most negative first, filtered by state, kind and
// city; search by reference code or id. A balance's page shows the statement and lets finance
// record cash paid at an office.

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { allowed, api, citiesFor } from "../../lib/api";
import { download } from "../../lib/admin";
import { birr, CITIES, CITY_NAMES, shortId } from "../../lib/format";
import { BALANCE_CSV, csvName, everywhere, queryString, STATE_LABEL, stateTone, toCsv, type Balance, type BalanceRow, type BalanceState } from "../../lib/money";
import { useSession } from "../../lib/session";
import { Empty, PageHead, Pill, Problem } from "../../components/ui";
import { BalancePanel, RecordCashDrawer } from "./BalancePanel";

const PAGE = 50;

export function BalancesPage() {
  const { staff } = useSession();
  const navigate = useNavigate();
  const [state, setState] = useState<BalanceState | "">("");
  const [type, setType] = useState<"" | "INDIVIDUAL" | "ORGANIZATION">("");
  const [q, setQ] = useState("");
  const [cityId, setCityId] = useState("");
  const [offset, setOffset] = useState(0);
  const [recording, setRecording] = useState(false);
  // the list is limited to the cities where the person holds balance:read; asking for another city is a 403
  const cities = citiesFor(staff.principal, "balance:read", CITIES);
  const global = everywhere(staff.principal, "balance:read");
  const city = cityId && cities.includes(cityId) ? cityId : "";
  const params = queryString({ limit: PAGE, offset, state, type, cityId: city, q: q.trim().length >= 3 ? q.trim() : "" });
  const list = useQuery({ queryKey: ["money", "balances", params], queryFn: () => api<{ total: number; balances: BalanceRow[] }>("staff", `/api/payments/balances?${params}`) });
  const reset = () => setOffset(0);
  const rows = list.data?.balances ?? [];

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Balances"
        lede="What each driver and fleet company owes or is owed. Cash trips add commission owed; card and mobile money trips add earnings."
        right={
          <>
            {rows.length ? <button className="btn secondary" onClick={() => download(csvName("balances"), toCsv(rows, BALANCE_CSV))}><Download /> Export CSV ({rows.length})</button> : null}
            {allowed(staff.principal, "topup:record_cash") ? <button className="btn secondary" onClick={() => setRecording(true)}>Record cash or a bank transfer</button> : null}
          </>
        }
      />
      {cities.length > 1 ? (
        <div className="chips" aria-label="City">
          <button className="chip" aria-pressed={city === ""} onClick={() => { setCityId(""); reset(); }}>{global ? "Every city" : "All my cities"}</button>
          {cities.map((c) => <button key={c} className="chip" aria-pressed={city === c} onClick={() => { setCityId(c); reset(); }}>{CITY_NAMES[c] ?? c}</button>)}
        </div>
      ) : cities.length === 1 && !global ? <p className="small muted" style={{ margin: 0 }}>Balances in {CITY_NAMES[cities[0]!] ?? cities[0]}, the city you handle.</p> : null}
      <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
        <div className="chips">
          <button className="chip" aria-pressed={state === ""} onClick={() => { setState(""); reset(); }}>All</button>
          {(["WARNING", "CASH_BLOCKED", "BLOCKED"] as const).map((s) => (
            <button key={s} className="chip" aria-pressed={state === s} onClick={() => { setState(s); reset(); }}>{STATE_LABEL[s]}</button>
          ))}
        </div>
        <div className="chips">
          <button className="chip" aria-pressed={type === "INDIVIDUAL"} onClick={() => { setType(type === "INDIVIDUAL" ? "" : "INDIVIDUAL"); reset(); }}>Owner-drivers</button>
          <button className="chip" aria-pressed={type === "ORGANIZATION"} onClick={() => { setType(type === "ORGANIZATION" ? "" : "ORGANIZATION"); reset(); }}>Fleets</button>
        </div>
        <input className="input" style={{ maxWidth: "16rem" }} placeholder="Reference code or id" value={q} onChange={(e) => { setQ(e.target.value); reset(); }} aria-label="Search balances" />
      </div>
      <Problem error={list.error} />
      {list.isPending ? <p className="small muted">Loading balances…</p> : null}
      {list.data?.balances.length === 0 ? <Empty title="No balances match." /> : null}
      {list.data?.balances.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Who</th><th>City</th><th className="num">Balance</th><th>State</th><th>Reference</th></tr></thead>
            <tbody>
              {list.data.balances.map((b) => (
                <tr key={b.accountId} className="clickable" onClick={() => navigate(`/staff/money/balances/${b.accountId}`)}>
                  <td>
                    <Link to={`/staff/money/balances/${b.accountId}`} onClick={(e) => e.stopPropagation()}>{b.beneficiary.type === "ORGANIZATION" ? "Fleet" : "Driver"} {shortId(b.beneficiary.id)}</Link>
                    {b.payoutReady ? null : <div className="xs muted">no payout method</div>}
                  </td>
                  <td className="small">{CITY_NAMES[b.cityId] ?? b.cityId}</td>
                  <td className="num mono" style={{ color: b.balanceMinor < 0 ? "var(--danger)" : undefined }}>{birr(b.balanceMinor)}</td>
                  <td><Pill tone={stateTone(b.state)}>{STATE_LABEL[b.state]}</Pill></td>
                  <td className="mono small">{b.referenceCode}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.data && list.data.total > PAGE ? (
        <div className="row" style={{ gap: "0.5rem" }}>
          <button className="btn secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
          <span className="small muted">{offset + 1}–{Math.min(offset + PAGE, list.data.total)} of {list.data.total}</span>
          <button className="btn secondary" disabled={offset + PAGE >= list.data.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
        </div>
      ) : null}
      {recording ? <RecordCashDrawer onClose={() => setRecording(false)} /> : null}
    </div>
  );
}

export function BalancePage() {
  const { accountId } = useParams();
  const { staff } = useSession();
  const q = useQuery({ queryKey: ["money", "balance", accountId], refetchInterval: 15_000, queryFn: () => api<Balance>("staff", `/api/payments/balances/${accountId}`) });
  const b = q.data;
  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title={b ? `${b.beneficiary.type === "ORGANIZATION" ? "Fleet" : "Driver"} ${shortId(b.beneficiary.id)}` : "Balance"}
        lede={b ? <>{CITY_NAMES[b.cityId] ?? b.cityId} · {b.beneficiary.type === "ORGANIZATION" ? <Link to={`/staff/onboarding`}>company</Link> : <Link to={`/staff/fleet/drivers/${b.beneficiary.id}`}>driver record</Link>}</> : undefined}
        right={<Link className="btn secondary" to="/staff/money/balances">All balances</Link>}
      />
      <Problem error={q.error} />
      {b ? <BalancePanel surface="staff" balance={b} recordCash={allowed(staff.principal, "topup:record_cash")} /> : null}
    </div>
  );
}
