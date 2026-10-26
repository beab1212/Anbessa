// Money overview (payment-service /api/payments/overview): what the platform holds at each
// provider, what drivers and companies owe and are owed, the last 7 days' commission, and what is
// waiting for finance. Plus the ledger integrity check.

import { Fragment } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { allowed, api } from "../../lib/api";
import { birr } from "../../lib/format";
import { PROVIDER_LABEL, STATE_LABEL, type BalanceState } from "../../lib/money";
import { useSession } from "../../lib/session";
import { Notice, PageHead, Pill, Problem, Stat } from "../../components/ui";

interface Overview {
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
