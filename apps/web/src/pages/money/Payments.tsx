// Rider payments (workflow 08): every charge to a rider by mobile money or card, its provider and
// state. Finance can check a charge with the provider; support and finance ask for refunds, which a
// finance manager approves under Money approvals.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { allowed, api, newIdempotencyKey } from "../../lib/api";
import { download } from "../../lib/admin";
import { birr, CITY_NAMES, dayAndTime, shortId } from "../../lib/format";
import {
  citiesWithAny, csvName, isUuid, joinPages, nextBefore, PAYMENT_CSV, PAYMENT_READERS, PAYMENT_LABEL, paymentTone, PROVIDER_LABEL, queryString, REFUND_LABEL, refundTone, toCsv, toMinor,
  type Payment,
} from "../../lib/money";
import { useSession } from "../../lib/session";
import { useProviders } from "./BalancePanel";
import { Drawer, Empty, Field, Notice, PageHead, Pill, Problem, SelectField, TextArea } from "../../components/ui";

const FILTERS: [string, string][] = [["", "All"], ["ACTION_REQUIRED", "Waiting for the payer"], ["RETRY_SCHEDULED", "Will ask again"], ["FAILED", "Failed"], ["SUCCEEDED", "Paid"], ["PARTIALLY_REFUNDED", "Partly refunded"], ["REFUNDED", "Refunded"]];
const PAGE = 50;


export function PaymentsPage() {
  const { staff } = useSession();
  const cities = citiesWithAny(staff.principal, PAYMENT_READERS);
  const [city, setCity] = useState("");
  const [status, setStatus] = useState("");
  const [provider, setProvider] = useState("");
  const [trip, setTrip] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const providers = useProviders();
  const tripId = isUuid(trip) ? trip.trim().toLowerCase() : "";
  const filters = queryString({ status, provider, tripId, cityId: city, limit: PAGE });
  const list = useInfiniteQuery({
    queryKey: ["money", "payments", filters], refetchInterval: 15_000,
    initialPageParam: "",
    getNextPageParam: nextBefore,
    queryFn: ({ pageParam }) => api<{ payments: Payment[]; next: string | null }>("staff", `/api/payments/payments?${filters}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`),
  });
  const rows = joinPages(list.data?.pages.map((p) => p.payments) ?? []);
  const tripTyped = trip.trim() !== "" && !tripId;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Rider payments"
        lede="Trip fares and cancellation fees paid by mobile money or card. Cash trips settle without a payment. You see the cities you handle money in."
        right={rows.length ? <button className="btn secondary" onClick={() => download(csvName("payments"), toCsv(rows, PAYMENT_CSV))}><Download /> Export CSV ({rows.length})</button> : null}
      />
      <div className="chips">
        {FILTERS.map(([s, label]) => <button key={s} className="chip" aria-pressed={status === s} onClick={() => setStatus(s)}>{label}</button>)}
      </div>
      {cities.length > 1 ? (
        <div className="chips" aria-label="City">
          <button className="chip" aria-pressed={city === ""} onClick={() => setCity("")}>All your cities</button>
          {cities.map((c) => <button key={c} className="chip" aria-pressed={city === c} onClick={() => setCity(c)}>{CITY_NAMES[c] ?? c}</button>)}
        </div>
      ) : null}
      <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
        <SelectField label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">Every provider</option>
          {(providers.data ?? []).map((x) => <option key={x.provider} value={x.provider}>{x.label}</option>)}
          <option value="none">None (no provider was enabled)</option>
        </SelectField>
        <Field label="Trip id" value={trip} onChange={(e) => setTrip(e.target.value)} placeholder="the trip's full id" hint={tripTyped ? "Paste the whole id (36 characters)." : undefined} />
        {status || provider || trip || city ? <button className="btn ghost" onClick={() => { setStatus(""); setProvider(""); setTrip(""); setCity(""); }}>Clear filters</button> : null}
      </div>
      <Problem error={list.error} />
      {list.isPending ? <p className="small muted">Loading payments…</p> : null}
      {list.isSuccess && rows.length === 0 ? <Empty title="No payments match." /> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Trip</th><th>For</th><th>Provider</th><th className="num">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => setOpen(p.id)}>
                  <td className="small">{dayAndTime(p.createdAt)}</td>
                  <td><Link to={`/staff/trips/${p.tripId}`} onClick={(e) => e.stopPropagation()} className="mono">{shortId(p.tripId)}</Link><div className="xs muted">{CITY_NAMES[p.cityId] ?? p.cityId}</div></td>
                  <td className="small">{p.purpose === "TRIP_FARE" ? "fare" : "cancellation fee"}</td>
                  <td className="small">{PROVIDER_LABEL[p.provider] ?? p.provider}</td>
                  <td className="num mono">{birr(p.amountMinor)}{p.refundedMinor ? <div className="xs muted">−{birr(p.refundedMinor)}</div> : null}</td>
                  <td><Pill tone={paymentTone(p.status)}>{PAYMENT_LABEL[p.status] ?? p.status}</Pill>{p.attempts > 1 ? <span className="xs muted"> · try {p.attempts}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.hasNextPage ? (
        <div className="row" style={{ gap: "0.5rem" }}>
          <button className="btn secondary" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? "Loading…" : "Load older"}</button>
          <span className="small muted">{rows.length} shown</span>
        </div>
      ) : rows.length > PAGE ? <p className="small muted">That's all of them ({rows.length}).</p> : null}
      {open ? <PaymentDrawer id={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

export function PaymentDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { staff } = useSession();
  const p = staff.principal;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["money", "payment", id], refetchInterval: 5000, queryFn: () => api<Payment>("staff", `/api/payments/payments/${id}`) });
  const check = useMutation({
    mutationFn: () => api<Payment>("staff", `/api/payments/payments/${id}/reconcile`, { body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["money"] }),
  });
  const pay = q.data;
  const [refunding, setRefunding] = useState(false);
  return (
    <Drawer title={pay ? `${birr(pay.amountMinor)} · ${pay.purpose === "TRIP_FARE" ? "trip fare" : "cancellation fee"}` : "Payment"} onClose={onClose}>
      <Problem error={q.error ?? check.error} />
      {pay ? (
        <div className="stack" style={{ gap: "0.75rem" }}>
          <dl className="kv">
            <dt>Status</dt><dd><Pill tone={paymentTone(pay.status)}>{PAYMENT_LABEL[pay.status] ?? pay.status}</Pill></dd>
            <dt>Provider</dt><dd>{PROVIDER_LABEL[pay.provider] ?? pay.provider} · {pay.method === "CARD" ? "card" : "mobile money"}</dd>
            <dt>Trip</dt><dd><Link to={`/staff/trips/${pay.tripId}`}>{shortId(pay.tripId)}</Link></dd>
            <dt>Tries</dt><dd>{pay.attempts}{pay.nextAttemptAt ? <span className="small muted"> · next {dayAndTime(pay.nextAttemptAt)}</span> : null}</dd>
            {pay.lastError ? <><dt>Last answer</dt><dd className="small">{pay.lastError}</dd></> : null}
            {pay.settledAsReceivable ? <><dt>Driver</dt><dd className="small">paid anyway; the rider owes this until they pay</dd></> : null}
            <dt>Started</dt><dd className="small">{dayAndTime(pay.createdAt)}</dd>
            {pay.completedAt ? <><dt>Finished</dt><dd className="small">{dayAndTime(pay.completedAt)}</dd></> : null}
          </dl>
          {pay.checkoutUrl ? <Notice>The rider was asked to approve. <a href={pay.checkoutUrl} target="_blank" rel="noreferrer">Payment page</a></Notice> : null}
          {pay.refunds?.length ? (
            <section>
              <h3 className="section-title">Refunds</h3>
              {pay.refunds.map((r) => (
                <p key={r.id} className="small" style={{ margin: "0.25rem 0" }}>
                  {birr(r.amountMinor)} · <Pill tone={refundTone(r.status)}>{REFUND_LABEL[r.status] ?? r.status}</Pill> · {r.reason}{r.driverAtFault ? " · from the driver's balance" : ""}
                  {r.decisionReason ? <span className="xs muted"> · decision: {r.decisionReason}</span> : null}{r.failure ? <span className="xs muted"> · {r.failure}</span> : null}
                </p>
              ))}
            </section>
          ) : null}
          <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
            {allowed(p, "commission:collect") && (pay.status === "ACTION_REQUIRED" || pay.status === "PENDING") ? <button className="btn secondary" disabled={check.isPending} onClick={() => check.mutate()}>Check with the provider</button> : null}
            {allowed(p, "refund:request", { cityId: pay.cityId }) && (pay.status === "SUCCEEDED" || pay.status === "PARTIALLY_REFUNDED") ? <button className="btn secondary" onClick={() => setRefunding(true)}>Ask for a refund</button> : null}
          </div>
          {refunding ? <RefundForm payment={pay} onDone={() => setRefunding(false)} /> : null}
        </div>
      ) : null}
    </Drawer>
  );
}

function RefundForm({ payment, onDone }: { payment: Payment; onDone: () => void }) {
  const qc = useQueryClient();
  const left = payment.amountMinor - payment.refundedMinor;
  const [amount, setAmount] = useState(String(left / 100));
  const [reason, setReason] = useState("");
  const [atFault, setAtFault] = useState(false);
  const [key] = useState(newIdempotencyKey);
  const minor = toMinor(amount);
  const tooMuch = !!minor && minor > left;
  const ask = useMutation({
    mutationFn: () => api("staff", `/api/payments/payments/${payment.id}/refunds`, { body: { amountMinor: toMinor(amount), reason: reason.trim(), driverAtFault: atFault }, idempotencyKey: key }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["money"] }),
  });
  if (ask.isSuccess) return <Notice tone="ok">Asked. A finance manager approves it under Money approvals. <button className="link" onClick={onDone}>Close</button></Notice>;
  return (
    <form className="card pad" onSubmit={(e) => { e.preventDefault(); ask.mutate(); }}>
      <Problem error={ask.error} />
      <Field label="Amount (ETB)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} hint={`up to ${birr(left)}`} />
      <TextArea label="Why" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The driver took a much longer route" hint="5+ characters; it goes into the audit log" />
      <label className="row small" style={{ gap: "0.4rem", margin: "0.25rem 0 0.75rem" }}>
        <input type="checkbox" checked={atFault} onChange={(e) => setAtFault(e.target.checked)} /> The driver was at fault (it comes out of their balance; otherwise the platform pays)
      </label>
      {tooMuch ? <p className="small" style={{ color: "var(--danger)" }}>At most {birr(left)} can still be refunded.</p> : null}
      <button className="btn" disabled={ask.isPending || !minor || tooMuch || reason.trim().length < 5}>Ask to refund {minor && !tooMuch ? birr(minor) : ""}</button>
    </form>
  );
}
