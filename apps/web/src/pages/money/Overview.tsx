// Money overview (payment-service /api/payments/overview): what the platform holds at each
// provider, what drivers and companies owe and are owed, the last 7 days' commission, and what is
// waiting for finance. Plus the ledger integrity check.
//
// /overview is platform-wide: payment-service answers it only for balance:read or
// report:read_finance held everywhere. A city support agent (balance:read in one city) gets a
// city view instead, built from the city-scoped lists (balances, refunds, payments).

import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { allowed, api, citiesFor } from "../../lib/api";
import { birr, CITIES, CITY_NAMES, shortId } from "../../lib/format";
import {
  anyInAnyCity, everywhere, PAYMENT_LABEL, PAYMENT_READERS, PROVIDER_LABEL, queryString, STATE_LABEL, stateTone,
  type BalanceRow, type BalanceState, type Payment, type Refund,
} from "../../lib/money";
import { useSession } from "../../lib/session";
import { Empty, Notice, PageHead, Pill, Problem, Stat } from "../../components/ui";

export interface Overview {
  accounts: Record<string, { positiveMinor: number; negativeMinor: number; count: number }>;
  providers: { provider: string; balanceMinor: number }[];
  states: Partial<Record<BalanceState, number>>;
  payments: Record<string, { count: number; amountMinor: number }>;
  topUps: Record<string, number>;
  refunds: Record<string, number>;
  openBatches: { id: string; status: string; totalMinor: number; cycleEnd: string }[];
  last7Days: { fareMinor: number; commissionMinor: number; vatMinor: number; tripsByMethod: Record<string, number> };
}

interface Integrity { ok: boolean; totalMinor: number; accounts: number; entries: number; mismatched: { code: string; cachedMinor: number; actualMinor: number }[] }

export function MoneyOverviewPage() {
  const { staff } = useSession();
  const p = staff.principal;
  const global = everywhere(p, "balance:read") || everywhere(p, "report:read_finance");
  return global ? <PlatformOverview /> : <CityOverview />;
}

function PlatformOverview() {
  const { staff } = useSession();
  const p = staff.principal;
  const q = useQuery({ queryKey: ["money", "overview"], refetchInterval: 30_000, queryFn: () => api<Overview>("staff", "/api/payments/overview") });
  const integrity = useQuery({
    queryKey: ["money", "integrity"], enabled: allowed(p, "report:read_finance") || allowed(p, "system:read"),
    refetchInterval: 5 * 60_000, queryFn: () => api<Integrity>("staff", "/api/payments/ledger/integrity"),
  });
  const o = q.data;
  const ben = o?.accounts.BENEFICIARY_BALANCE;
  const waiting = (o?.topUps.PENDING_APPROVAL ?? 0) + (o?.refunds.PENDING_APPROVAL ?? 0) + (o?.openBatches.filter((b) => b.status === "PENDING_APPROVAL").length ?? 0);
  const trips = o ? Object.entries(o.last7Days.tripsByMethod).map(([m, n]) => `${m.toLowerCase().replace("_", " ")} ${n}`).join(" · ") : undefined;

  return (
    <div className="page stack" style={{ gap: "1.25rem" }}>
      <PageHead title="Money" lede="Balances, payments and payouts across the platform. Amounts refresh on their own." />
      <Problem error={q.error} />
      {q.isPending ? <p className="small muted">Loading the overview…</p> : null}
      {integrity.data && !integrity.data.ok ? (
        <Notice tone="error">The ledger check failed: {integrity.data.mismatched.length} account balances differ from their postings. Engineering has been alerted in the logs.</Notice>
      ) : null}
      {waiting ? <Notice>{waiting} money decision{waiting > 1 ? "s" : ""} waiting · <Link to="/staff/money/approvals">Money approvals</Link></Notice> : null}

      <section>
        <h2 className="section-title">Last 7 days</h2>
        <div className="stats">
          <Stat label="Fares settled" value={o ? birr(o.last7Days.fareMinor) : "—"} sub={trips} />
          <Stat label="Commission" value={o ? birr(o.last7Days.commissionMinor) : "—"} />
          <Stat label="VAT collected" value={o ? birr(o.last7Days.vatMinor) : "—"} />
        </div>
      </section>

      <section>
        <h2 className="section-title">Drivers and fleets</h2>
        <div className="stats">
          <Stat label="We owe them" value={ben ? birr(ben.positiveMinor) : "—"} sub="positive balances, paid out weekly" />
          <Stat label="They owe us" value={ben ? birr(Math.abs(ben.negativeMinor)) : "—"} sub="commission on cash trips" alert={(o?.states.BLOCKED ?? 0) > 0} />
          <Stat
            label="Taking every trip"
            value={o ? (o.states.OK ?? 0) : "—"}
            sub={o ? (["WARNING", "CASH_BLOCKED", "BLOCKED"] as const).map((s) => `${STATE_LABEL[s].toLowerCase()} ${o.states[s] ?? 0}`).join(" · ") : undefined}
          />
        </div>
      </section>

      <section>
        <h2 className="section-title">Riders and companies</h2>
        <div className="stats">
          <Stat label="Waiting for the payer" value={o?.payments.ACTION_REQUIRED?.count ?? 0} sub={o?.payments.ACTION_REQUIRED ? birr(o.payments.ACTION_REQUIRED.amountMinor) : undefined} />
          <Stat label="Will be asked again" value={o?.payments.RETRY_SCHEDULED?.count ?? 0} />
          <Stat label="Riders owe" value={birr(Math.abs(o?.accounts.RIDER_RECEIVABLE?.negativeMinor ?? 0))} sub="failed charges and cash cancellation fees" alert={(o?.payments.FAILED?.count ?? 0) > 0} />
          <Stat label="Companies owe" value={birr(Math.abs(o?.accounts.CORPORATE_RECEIVABLE?.negativeMinor ?? 0))} sub="company account rides, invoiced monthly" />
        </div>
      </section>

      {o ? (
        <section className="card">
          <div className="card-head"><h2>Rider payments by status</h2><Link className="small" to="/staff/money/payments">payments</Link></div>
          <div className="card-body">
            <dl className="kv">
              {Object.entries(o.payments).map(([s, x]) => <Fragment key={s}><dt>{PAYMENT_LABEL[s] ?? s}</dt><dd className="mono">{x.count} · {birr(x.amountMinor)}</dd></Fragment>)}
              {Object.keys(o.payments).length === 0 ? <dd className="muted">No payments yet.</dd> : null}
            </dl>
            <p className="xs muted" style={{ marginBottom: 0 }}>
              Top-ups: {Object.entries(o.topUps).map(([s, n]) => `${s.toLowerCase().replace(/_/g, " ")} ${n}`).join(" · ") || "none"}. Refunds: {Object.entries(o.refunds).map(([s, n]) => `${s.toLowerCase().replace(/_/g, " ")} ${n}`).join(" · ") || "none"}.
            </p>
          </div>
        </section>
      ) : null}

      <div className="two-col">
        <section className="card">
          <div className="card-head"><h2>At the providers</h2><Link className="small" to="/staff/money/providers">providers</Link></div>
          <div className="card-body">
            <p className="xs muted" style={{ marginTop: 0 }}>Negative: money a provider collected for us and holds. Positive: payouts and refunds sent out of it.</p>
            <dl className="kv">
              {(o?.providers ?? []).map((x) => <Fragment key={x.provider}><dt>{PROVIDER_LABEL[x.provider] ?? x.provider}</dt><dd className="mono">{birr(x.balanceMinor)}</dd></Fragment>)}
              {o && o.providers.length === 0 ? <dd className="muted">Nothing yet.</dd> : null}
            </dl>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h2>Ledger</h2></div>
          <div className="card-body">
            {integrity.data ? (
              <dl className="kv">
                <dt>Integrity</dt><dd>{integrity.data.ok ? <Pill tone="green">balanced</Pill> : <Pill tone="red">mismatch</Pill>}</dd>
                <dt>All accounts</dt><dd className="mono">{birr(integrity.data.totalMinor)} <span className="xs muted">(always 0)</span></dd>
                <dt>Accounts · entries</dt><dd>{integrity.data.accounts} · {integrity.data.entries}</dd>
              </dl>
            ) : <p className="small muted" style={{ margin: 0 }}>{integrity.error ? "You can't run the integrity check." : "Checking…"}</p>}
            {o?.openBatches.length ? (
              <p className="small" style={{ marginBottom: 0 }}>
                Payouts: {o.openBatches.map((b) => <Link key={b.id} to="/staff/money/payouts" style={{ marginRight: "0.5rem" }}>{b.cycleEnd} ({b.status === "SENDING" ? "sending" : "waiting"}, {birr(b.totalMinor)})</Link>)}
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

const STATES: BalanceState[] = ["OK", "WARNING", "CASH_BLOCKED", "BLOCKED"];

/** For balance:read in some cities only: what the city-scoped lists say about one city. */
function CityOverview() {
  const { staff } = useSession();
  const p = staff.principal;
  const cities = citiesFor(p, "balance:read", CITIES);
  const [picked, setPicked] = useState<string | null>(null);
  const city = picked && cities.includes(picked) ? picked : (cities[0] ?? null);
  const balancesPath = (extra: Record<string, string | number>) => `/api/payments/balances?${queryString({ cityId: city, ...extra })}`;
  const worst = useQuery({
    queryKey: ["money", "city-overview", city, "worst"], enabled: !!city, refetchInterval: 30_000,
    queryFn: () => api<{ total: number; balances: BalanceRow[] }>("staff", balancesPath({ limit: 5 })),
  });
  const byState = useQueries({
    queries: STATES.map((state) => ({
      queryKey: ["money", "city-overview", city, "state", state], enabled: !!city, refetchInterval: 30_000,
      queryFn: () => api<{ total: number }>("staff", balancesPath({ state, limit: 1 })).then((r) => r.total),
    })),
  });
  const readsPayments = anyInAnyCity(p, PAYMENT_READERS);
  const refunds = useQuery({
    queryKey: ["money", "approvals", "refunds"], enabled: readsPayments,
    queryFn: () => api<{ refunds: Refund[] }>("staff", "/api/payments/refunds?status=PENDING_APPROVAL").then((r) => r.refunds),
  });
  const waiting = useQuery({
    queryKey: ["money", "city-overview", "payments", "ACTION_REQUIRED"], enabled: readsPayments, refetchInterval: 30_000,
    queryFn: () => api<{ payments: Payment[] }>("staff", "/api/payments/payments?status=ACTION_REQUIRED&limit=100").then((r) => r.payments),
  });
  const failed = useQuery({
    queryKey: ["money", "city-overview", "payments", "FAILED"], enabled: readsPayments, refetchInterval: 30_000,
    queryFn: () => api<{ payments: Payment[] }>("staff", "/api/payments/payments?status=FAILED&limit=100").then((r) => r.payments),
  });
  if (!city) return <div className="page"><PageHead title="Money" /><Empty title="No city to show.">Your roles don't include balances in any city.</Empty></div>;
  const inCity = <T extends { cityId: string }>(rows: T[] | undefined) => rows?.filter((x) => x.cityId === city);
  const pendingRefunds = refunds.data?.filter((r) => r.payment?.cityId === city);
  const waitingHere = inCity(waiting.data);
  const failedHere = inCity(failed.data);
  const count = (i: number) => byState[i]?.data;
  const atCap = (rows: unknown[] | undefined) => (rows?.length ?? 0) >= 100;

  return (
    <div className="page stack" style={{ gap: "1.25rem" }}>
      <PageHead title="Money" lede={`Balances and rider payments in ${CITY_NAMES[city] ?? city}. Amounts refresh on their own.`} />
      <Notice>
        Platform totals (provider holdings, commission, the ledger check) need a finance role for every city. This page shows what your city roles cover.
      </Notice>
      {cities.length > 1 ? (
        <div className="chips">{cities.map((c) => <button key={c} className="chip" aria-pressed={city === c} onClick={() => setPicked(c)}>{CITY_NAMES[c] ?? c}</button>)}</div>
      ) : null}
      <Problem error={worst.error ?? byState.find((x) => x.error)?.error ?? refunds.error ?? waiting.error ?? failed.error} />
      {pendingRefunds?.length ? <Notice>{pendingRefunds.length} refund{pendingRefunds.length > 1 ? "s" : ""} in {CITY_NAMES[city] ?? city} waiting · <Link to="/staff/money/approvals">Money approvals</Link></Notice> : null}

      <section>
        <h2 className="section-title">Drivers and fleets</h2>
        <div className="stats">
          <Stat label="Balances" value={worst.data?.total ?? "—"} sub={<Link to="/staff/money/balances">see them all</Link>} />
          {STATES.map((s, i) => (
            <Stat key={s} label={STATE_LABEL[s]} value={count(i) ?? "—"} alert={s === "BLOCKED" && (count(i) ?? 0) > 0} />
          ))}
        </div>
      </section>

      {readsPayments ? (
        <section>
          <h2 className="section-title">Riders</h2>
          <div className="stats">
            <Stat label="Waiting for the payer" value={waitingHere ? `${waitingHere.length}${atCap(waiting.data) ? "+" : ""}` : "—"} sub={waitingHere ? birr(waitingHere.reduce((n, x) => n + x.amountMinor, 0)) : undefined} />
            <Stat label="Failed (riders owe)" value={failedHere ? `${failedHere.length}${atCap(failed.data) ? "+" : ""}` : "—"} sub={failedHere ? birr(failedHere.reduce((n, x) => n + x.amountMinor, 0)) : undefined} alert={(failedHere?.length ?? 0) > 0} />
            <Stat label="Refunds waiting" value={pendingRefunds?.length ?? "—"} />
          </div>
          <p className="xs muted" style={{ margin: "0.5rem 0 0" }}>Counted from the newest 100 payments in each state across your cities.</p>
        </section>
      ) : null}

      <section className="card">
        <div className="card-head"><h2>Owing the most</h2><Link className="small" to="/staff/money/balances">balances</Link></div>
        {worst.isPending ? <div className="card-body"><p className="small muted" style={{ margin: 0 }}>Loading…</p></div> : null}
        {worst.data?.balances.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Who</th><th className="num">Balance</th><th>State</th></tr></thead>
              <tbody>
                {worst.data.balances.map((b) => (
                  <tr key={b.accountId}>
                    <td><Link to={`/staff/money/balances/${b.accountId}`}>{b.beneficiary.type === "ORGANIZATION" ? "Fleet" : "Driver"} {shortId(b.beneficiary.id)}</Link> <span className="xs muted mono">{b.referenceCode}</span></td>
                    <td className="num mono" style={{ color: b.balanceMinor < 0 ? "var(--danger)" : undefined }}>{birr(b.balanceMinor)}</td>
                    <td><Pill tone={stateTone(b.state)}>{STATE_LABEL[b.state]}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : worst.isSuccess ? <div className="card-body"><p className="small muted" style={{ margin: 0 }}>No balances in this city yet.</p></div> : null}
      </section>
    </div>
  );
}
