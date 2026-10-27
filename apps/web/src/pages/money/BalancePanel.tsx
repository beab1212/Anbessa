// One balance (Payment.md §5, §8): amount, state and limits, payment dues, the statement and
// top-ups. Owners (fleet owner on the partner surface) top up and set where payouts go; finance
// records cash paid at an office. Shared by the finance pages and the fleet's company page.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { allowed, api, newIdempotencyKey, type Surface } from "../../lib/api";
import { useSession } from "../../lib/session";
import { download } from "../../lib/admin";
import { birr, dayAndTime, shortId } from "../../lib/format";
import {
  CHANNEL_LABEL, csvName, ENTRY_LABEL, joinPages, nextBefore, PROVIDER_LABEL, STATE_LABEL, STATEMENT_CSV, stateTone, toCsv, toMinor, TOP_UP_LABEL, topUpTone,
  type Balance, type Provider, type StatementEntry, type TopUp,
} from "../../lib/money";
import { Drawer, Field, Notice, Pill, Problem, SelectField, TextArea } from "../../components/ui";

const STATE_TEXT: Record<string, string> = {
  OK: "Taking every trip.",
  WARNING: "Close to the cash limit: pay soon to keep cash trips.",
  CASH_BLOCKED: "Cash trips are paused; card and mobile money trips continue and repay the debt.",
  BLOCKED: "No trips until a payment comes in.",
};

/** Every enabled provider (GET /api/payments/methods), for filters. */
export function useProviders(surface: Surface = "staff") {
  return useQuery({ queryKey: ["money", "methods", "all", surface], staleTime: 5 * 60_000, queryFn: () => api<{ providers: Provider[] }>(surface, "/api/payments/methods").then((r) => r.providers) });
}

export function BalancePanel({ surface, balance, owner = false, recordCash = false }: { surface: Surface; balance: Balance; owner?: boolean; recordCash?: boolean }) {
  const [topUp, setTopUp] = useState(false);
  const [payoutMethod, setPayoutMethod] = useState(false);
  const [cash, setCash] = useState(false);
  const { staff } = useSession();
  const accountId = balance.accountId;
  // staff shortcuts into the money controls, prefilled with this balance
  const city = { cityId: balance.cityId };
  const canAdjust = surface === "staff" && !!accountId && allowed(staff.principal, "adjustment:request", city);
  const canOverride = surface === "staff" && !!accountId && allowed(staff.principal, "policy_override:request", city);
  const statement = useInfiniteQuery({
    queryKey: ["money", "statement", accountId], enabled: !!accountId,
    initialPageParam: "",
    getNextPageParam: nextBefore,
    queryFn: ({ pageParam }) => api<{ entries: StatementEntry[]; next: string | null }>(surface, `/api/payments/balances/${accountId}/statement?limit=30${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`),
  });
  const entries = joinPages(statement.data?.pages.map((pg) => pg.entries) ?? []);
  const topUps = useQuery({
    queryKey: ["money", "top-ups", accountId], enabled: !!accountId, refetchInterval: (q) => (q.state.data?.some((t) => t.status === "ACTION_REQUIRED") ? 3000 : false),
    queryFn: () => api<{ topUps: TopUp[] }>(surface, `/api/payments/balances/${accountId}/top-ups`).then((r) => r.topUps),
  });
  const p = balance.policy;
  const openDues = balance.dues.filter((d) => d.status === "OPEN" || d.status === "OVERDUE" || d.status === "MIN_PAID");

  return (
    <div className="stack" style={{ gap: "1rem" }}>
      <section className="card">
        <div className="card-head">
          <h2>Balance</h2>
          <Pill tone={stateTone(balance.state)}>{STATE_LABEL[balance.state]}</Pill>
        </div>
        <div className="card-body">
          <p style={{ fontSize: "1.75rem", margin: "0 0 0.25rem" }} className="mono">
            {balance.balanceMinor < 0 ? <>owes <strong>{birr(-balance.balanceMinor)}</strong></> : <strong>{birr(balance.balanceMinor)}</strong>}
          </p>
          <p className="small muted" style={{ marginTop: 0 }}>{STATE_TEXT[balance.state]}</p>
          <dl className="kv">
            <dt>Limits</dt>
            <dd className="small">
              {p.mode === "PREPAID" ? <>prepaid, at least {birr(p.prepaidMinimumMinor)}</> : <>warning {birr(p.warningMinor)} · cash paused {birr(p.cashLimitMinor)} · blocked {birr(p.hardLimitMinor)}</>}
              {p.builtIn ? <span className="xs muted"> (default)</span> : null}
            </dd>
            <dt>Payouts</dt>
            <dd className="small">
              {balance.payoutMethod ? <>{PROVIDER_LABEL[balance.payoutMethod.provider] ?? balance.payoutMethod.provider} {balance.payoutMethod.destination}</> : <span className="muted">no payout method: positive balances roll over</span>}
              <span className="xs muted"> · weekly, from {birr(p.minPayoutMinor)}</span>
            </dd>
            {balance.referenceCode ? <><dt>Bank transfer reference</dt><dd className="mono">{balance.referenceCode}</dd></> : null}
          </dl>
          {openDues.map((d) => (
            <Notice key={d.id} tone={d.status === "OVERDUE" ? "error" : "info"}>
              {d.status === "OVERDUE" ? "Overdue" : d.status === "MIN_PAID" ? "Minimum paid" : "Payment due"}: {birr(d.amountMinor - d.paidMinor)} left of {birr(d.amountMinor)}
              {d.status !== "MIN_PAID" ? <> · at least {birr(Math.max(0, d.minimumMinor - d.paidMinor))} by {dayAndTime(d.dueAt)}</> : null}
            </Notice>
          ))}
          <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
            {owner ? <button className="btn" onClick={() => setTopUp(true)} disabled={!accountId}>Top up</button> : null}
            {owner ? <button className="btn secondary" onClick={() => setPayoutMethod(true)} disabled={!accountId}>Payout method</button> : null}
            {recordCash && accountId ? <button className="btn secondary" onClick={() => setCash(true)}>Record cash or a bank transfer</button> : null}
            {canAdjust ? <Link className="btn secondary" to={`/staff/money/adjustments?account=${accountId}`}>Adjust</Link> : null}
            {canOverride ? <Link className="btn secondary" to={`/staff/money/overrides?account=${accountId}`}>Limit exception</Link> : null}
          </div>
        </div>
      </section>

      <Problem error={topUps.error} />
      {topUps.data?.length ? (
        <section className="card">
          <div className="card-head"><h2>Top-ups</h2></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When</th><th>How</th><th className="num">Amount</th><th>Status</th></tr></thead>
              <tbody>
                {topUps.data.map((t) => (
                  <tr key={t.id}>
                    <td className="small">{dayAndTime(t.createdAt)}</td>
                    <td className="small">{CHANNEL_LABEL[t.channel]}{t.provider && t.provider !== "bank" ? ` · ${PROVIDER_LABEL[t.provider] ?? t.provider}` : ""}{t.receiptNo ? <span className="xs muted"> · {t.receiptNo}</span> : null}</td>
                    <td className="num mono">{birr(t.amountMinor)}</td>
                    <td>
                      <Pill tone={topUpTone(t.status)}>{t.status === "ACTION_REQUIRED" ? "waiting for approval at the provider" : TOP_UP_LABEL[t.status] ?? t.status.toLowerCase()}</Pill>
                      {t.failure ? <div className="xs muted">{t.failure}</div> : null}
                      {t.checkoutUrl && owner ? <a className="xs" href={t.checkoutUrl} target="_blank" rel="noreferrer" style={{ marginLeft: "0.4rem" }}>open payment page</a> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="card">
        <div className="card-head">
          <h2>Statement</h2>
          <div className="row" style={{ gap: "0.5rem" }}>
            <span className="xs muted">every movement on this balance</span>
            {entries.length ? <button className="btn ghost sm" onClick={() => download(csvName(`statement-${shortId(accountId ?? "")}`), toCsv(entries, STATEMENT_CSV))}><Download /> CSV ({entries.length})</button> : null}
          </div>
        </div>
        {statement.error ? <div className="card-body"><Problem error={statement.error} /></div> : null}
        {statement.isPending && accountId ? <div className="card-body"><p className="small muted" style={{ margin: 0 }}>Loading the statement…</p></div> : null}
        {entries.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When</th><th>What</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="small">{dayAndTime(e.at)}</td>
                    <td className="small">{ENTRY_LABEL[e.kind] ?? e.kind}{e.memo ? <span className="xs muted"> · {e.memo}</span> : null}</td>
                    <td className="num mono" style={{ color: e.amountMinor < 0 ? "var(--danger)" : undefined }}>{e.amountMinor > 0 ? "+" : ""}{birr(e.amountMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : statement.isSuccess || !accountId ? <div className="card-body"><p className="small muted" style={{ margin: 0 }}>{accountId ? "No movements yet." : "No trips yet. The balance opens with the first trip or top-up."}</p></div> : null}
        {statement.hasNextPage ? (
          <div className="card-body row" style={{ gap: "0.5rem" }}>
            <button className="btn secondary" disabled={statement.isFetchingNextPage} onClick={() => void statement.fetchNextPage()}>{statement.isFetchingNextPage ? "Loading…" : "Load older"}</button>
            <span className="small muted">{entries.length} shown</span>
          </div>
        ) : null}
      </section>

      {topUp && accountId ? <TopUpDrawer surface={surface} balance={balance} onClose={() => setTopUp(false)} /> : null}
      {payoutMethod && accountId ? <PayoutMethodDrawer surface={surface} balance={balance} onClose={() => setPayoutMethod(false)} /> : null}
      {cash && accountId ? <RecordCashDrawer accountId={accountId} onClose={() => setCash(false)} /> : null}
    </div>
  );
}

function TopUpDrawer({ surface, balance, onClose }: { surface: Surface; balance: Balance; onClose: () => void }) {
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ["money", "methods", surface], queryFn: () => api<{ providers: Provider[] }>(surface, "/api/payments/methods").then((r) => r.providers.filter((x) => x.methods.includes("MOBILE_MONEY"))) });
  const [provider, setProvider] = useState("telebirr");
  const [amount, setAmount] = useState(balance.suggestedTopUpMinor ? String(balance.suggestedTopUpMinor / 100) : "");
  const [key] = useState(newIdempotencyKey);
  const go = useMutation({
    mutationFn: () => api<TopUp>(surface, `/api/payments/balances/${balance.accountId}/top-ups`, { body: { amountMinor: toMinor(amount), provider }, idempotencyKey: key }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: ["money"] });
      if (t.checkoutUrl) window.open(t.checkoutUrl, "_blank", "noopener");
    },
  });
  return (
    <Drawer title="Top up the balance" onClose={onClose}>
      {go.data ? (
        <div className="stack" style={{ gap: "0.75rem" }}>
          <Notice tone="ok">{go.data.instructions ?? "Approve the payment with your provider."} The balance updates as soon as the provider confirms.</Notice>
          {go.data.checkoutUrl ? <a className="btn secondary" href={go.data.checkoutUrl} target="_blank" rel="noreferrer">Open the payment page again</a> : null}
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); go.mutate(); }}>
          <Problem error={go.error} />
          <SelectField label="Pay with" value={provider} onChange={(e) => setProvider(e.target.value)}>
            {(providers.data ?? []).map((x) => <option key={x.provider} value={x.provider}>{x.label}{x.mode === "simulated" ? " (simulated)" : ""}</option>)}
          </SelectField>
          <Field label="Amount (ETB)" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)}
            hint={balance.suggestedTopUpMinor ? `${birr(balance.suggestedTopUpMinor)} brings the balance back to OK` : undefined} />
          <button className="btn" disabled={go.isPending || !toMinor(amount)}>Pay {toMinor(amount) ? birr(toMinor(amount)) : ""}</button>
        </form>
      )}
    </Drawer>
  );
}

function PayoutMethodDrawer({ surface, balance, onClose }: { surface: Surface; balance: Balance; onClose: () => void }) {
  const qc = useQueryClient();
  const [provider, setProvider] = useState(balance.payoutMethod?.provider ?? "telebirr");
  const [destination, setDestination] = useState("");
  const save = useMutation({
    mutationFn: () => api(surface, `/api/payments/balances/${balance.accountId}/payout-method`, { method: "PUT", body: { provider, destination } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["money"] });
      void qc.invalidateQueries({ queryKey: ["org-balance"] });
      onClose();
    },
  });
  return (
    <Drawer title="Where payouts go" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <p className="small muted">Positive balances are paid out weekly after a finance manager approves the batch.</p>
        <Problem error={save.error} />
        <SelectField label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="telebirr">telebirr (phone number)</option>
          <option value="cbebirr">CBE Birr (phone number)</option>
          <option value="chapa">Bank account (through Chapa)</option>
        </SelectField>
        <Field label={provider === "chapa" ? "Account number" : "Phone number"} required value={destination} onChange={(e) => setDestination(e.target.value)} placeholder={provider === "chapa" ? "1000123456789" : "+251 911 22 33 44"} />
        <button className="btn" disabled={save.isPending || destination.replace(/\D/g, "").length < 6}>Save</button>
      </form>
    </Drawer>
  );
}

export function RecordCashDrawer({ accountId, onClose }: { accountId?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [channel, setChannel] = useState<"OFFICE_CASH" | "BANK_TRANSFER">("OFFICE_CASH");
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState("");
  const [receiptNo, setReceiptNo] = useState("");
  const [note, setNote] = useState("");
  const [key] = useState(newIdempotencyKey);
  const record = useMutation({
    mutationFn: () => api<TopUp>("staff", "/api/payments/top-ups/manual", {
      body: { ...(accountId ? { accountId } : { referenceCode: reference.trim() }), channel, amountMinor: toMinor(amount), receiptNo: receiptNo.trim(), ...(note.trim() ? { note: note.trim() } : {}) },
      idempotencyKey: key,
    }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["money"] }),
  });
  return (
    <Drawer title="Record a payment" onClose={onClose}>
      {record.isSuccess ? (
        <div className="stack" style={{ gap: "0.75rem" }}>
          <Notice tone="ok">Recorded. A finance manager credits it under Money approvals.</Notice>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); record.mutate(); }}>
          <Problem error={record.error} />
          <SelectField label="How it was paid" value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
            <option value="OFFICE_CASH">Cash at an office</option>
            <option value="BANK_TRANSFER">Bank transfer</option>
          </SelectField>
          {accountId ? null : <Field label="Reference code" required value={reference} onChange={(e) => setReference(e.target.value)} placeholder="ANB-7K2Q9X" hint="Shown in the driver's app and on the fleet's page" />}
          <Field label="Amount (ETB)" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Field label={channel === "OFFICE_CASH" ? "Receipt number" : "Bank transaction id"} required value={receiptNo} onChange={(e) => setReceiptNo(e.target.value)} />
          <TextArea label="Note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Paid at the Bole office" />
          <button className="btn" disabled={record.isPending || !toMinor(amount) || receiptNo.trim().length < 3 || (!accountId && reference.trim().length < 5)}>Record for approval</button>
        </form>
      )}
    </Drawer>
  );
}
