// Corporate invoices (workflow 11 D): once an Addis Ababa month is over, finance issues each
// company's invoice from its CORPORATE_RECEIVABLE postings (one per company per month, numbered
// INV-YYYYMM-NNNNN, never changed afterwards) and applies the company's bank transfers until it is
// paid. `InvoiceBody` is shared with the company admins' page (partner/Invoices.tsx).

import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { allowed, api, newIdempotencyKey, type Surface } from "../../lib/api";
import { download } from "../../lib/admin";
import { birr, CITY_NAMES, dayAndTime, shortId } from "../../lib/format";
import { csvName, toCsv, toMinor } from "../../lib/money";
import {
  addisPeriod, INVOICE_CSV, INVOICE_LABEL, invoiceTone, periodLabel, previousPeriod, recentPeriods, type Invoice, type InvoiceDetail, type Uninvoiced,
} from "../../lib/money2";
import { useSession } from "../../lib/session";
import { Drawer, Empty, Field, PageHead, Pill, Problem, SelectField, Stat } from "../../components/ui";
import { useStaffNames } from "../admin/Approvals";

const KIND_WORD: Record<string, string> = { TRIP_SETTLEMENT: "Trip", CANCELLATION_FEE: "Cancellation fee" };

/** One invoice: totals, lines, payments and its CSV (from `csvPath`, with the surface's token). */
export function InvoiceBody({ invoice: i, surface, csvPath, tripLink }: { invoice: InvoiceDetail; surface: Surface; csvPath: string; tripLink?: (tripId: string) => string }) {
  const csv = useMutation({ mutationFn: () => api<string>(surface, csvPath), onSuccess: (text) => download(`${i.number}.csv`, typeof text === "string" ? text : String(text)) });
  return (
    <div className="stack" style={{ gap: "1rem" }}>
      <div className="stats">
        <Stat label="Total" value={birr(i.totalMinor)} sub={`${i.lineCount} line${i.lineCount === 1 ? "" : "s"}`} />
        <Stat label="Paid" value={birr(i.paidMinor)} sub={i.paidAt ? dayAndTime(i.paidAt) : undefined} />
        <Stat label="Outstanding" value={birr(i.outstandingMinor)} sub={`due ${dayAndTime(i.dueAt)}`} alert={i.overdue} />
      </div>
      <dl className="kv">
        <dt>Number</dt><dd className="mono">{i.number}</dd>
        <dt>Month</dt><dd>{periodLabel(i.period)} <span className="xs muted">({dayAndTime(i.periodStart)} → {dayAndTime(i.periodEnd)})</span></dd>
        <dt>Status</dt><dd><Pill tone={invoiceTone(i)}>{i.overdue ? "overdue" : INVOICE_LABEL[i.status] ?? i.status}</Pill></dd>
        <dt>Issued</dt><dd className="small">{dayAndTime(i.issuedAt)}</dd>
      </dl>
      <div className="row" style={{ gap: "0.5rem" }}>
        <button className="btn secondary" disabled={csv.isPending} onClick={() => csv.mutate()}><Download /> Download CSV</button>
      </div>
      <Problem error={csv.error} />
      {i.payments.length ? (
        <section className="stack" style={{ gap: "0.5rem" }}>
          <h3 style={{ margin: 0 }}>Payments</h3>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When</th><th>Bank reference</th><th className="num">Amount</th></tr></thead>
              <tbody>{i.payments.map((x) => <tr key={x.id}><td className="small">{dayAndTime(x.createdAt)}</td><td className="mono">{x.bankReference}</td><td className="num mono">{birr(x.amountMinor)}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      ) : null}
      <section className="stack" style={{ gap: "0.5rem" }}>
        <h3 style={{ margin: 0 }}>Lines</h3>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>What</th><th>Trip</th><th>City</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {i.lines.map((l) => (
                <tr key={l.id}>
                  <td className="small">{dayAndTime(l.at)}</td>
                  <td className="small">{KIND_WORD[l.kind] ?? l.kind}{l.vehicleType ? <div className="xs muted">{l.vehicleType}</div> : null}</td>
                  <td>{l.tripId ? (tripLink ? <Link className="mono" to={tripLink(l.tripId)}>{shortId(l.tripId)}</Link> : <span className="mono">{shortId(l.tripId)}</span>) : "—"}</td>
                  <td className="small">{l.cityId ? CITY_NAMES[l.cityId] ?? l.cityId : "—"}</td>
                  <td className="num mono">{birr(l.amountMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

const FILTERS: [string, string][] = [["", "All"], ["ISSUED", "Unpaid"], ["overdue", "Overdue"], ["PAID", "Paid"]];

export function InvoicesPage() {
  const p = useSession().staff.principal;
  const qc = useQueryClient();
  const periods = recentPeriods(addisPeriod(), 13);
  const [period, setPeriod] = useState(previousPeriod(addisPeriod()));
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const canIssue = allowed(p, "invoice:issue");
  const queue = useQuery({
    queryKey: ["money", "invoices", "uninvoiced", period],
    queryFn: () => api<Uninvoiced>("staff", `/api/payments/invoices/uninvoiced?period=${period}`),
  });
  const qs = new URLSearchParams({ period, ...(filter === "overdue" ? { overdue: "true" } : filter ? { status: filter } : {}) }).toString();
  const list = useQuery({
    queryKey: ["money", "invoices", qs],
    queryFn: () => api<{ invoices: Invoice[] }>("staff", `/api/payments/invoices?${qs}`).then((r) => r.invoices),
  });
  const rows = list.data ?? [];
  const done = () => void qc.invalidateQueries({ queryKey: ["money", "invoices"] });

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Corporate invoices"
        lede="Each company's month of corporate trips, invoiced once the month is over. Issued invoices never change; bank transfers are applied until they're paid."
        right={
          <SelectField label="Month" value={period} onChange={(e) => setPeriod(e.target.value)}>
            {periods.map((x) => <option key={x} value={x}>{periodLabel(x)}</option>)}
          </SelectField>
        }
      />

      <section className="card">
        <div className="card-head"><h2>To invoice for {periodLabel(period)}</h2>{queue.data?.open ? <span className="xs muted">the month isn't over yet</span> : null}</div>
        <div className="card-body stack" style={{ gap: "0.5rem" }}>
          <Problem error={queue.error} />
          {queue.isPending ? <p className="small muted">Loading…</p> : null}
          {queue.data && queue.data.companies.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Every company with charges this month is invoiced.</p> : null}
          {queue.data?.companies.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Company</th><th>Lines</th><th>First · last charge</th><th className="num">Total</th><th /></tr></thead>
                <tbody>
                  {queue.data.companies.map((c) => (
                    <tr key={c.orgId}>
                      <td className="mono">{shortId(c.orgId)}</td>
                      <td className="small">{c.lines}</td>
                      <td className="small">{dayAndTime(c.firstAt)}<div className="xs muted">{dayAndTime(c.lastAt)}</div></td>
                      <td className="num mono">{birr(c.totalMinor)}</td>
                      <td>{canIssue && !queue.data!.open ? <Issue orgId={c.orgId} period={period} onDone={(id) => { done(); setOpen(id); }} /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </section>

      <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
        <div className="chips">{FILTERS.map(([s, l]) => <button key={s} className="chip" aria-pressed={filter === s} onClick={() => setFilter(s)}>{l}</button>)}</div>
        {rows.length ? <button className="btn secondary" onClick={() => download(csvName(`invoices-${period}`), toCsv(rows, INVOICE_CSV))}><Download /> Export CSV ({rows.length})</button> : null}
      </div>
      <Problem error={list.error} />
      {list.isPending ? <p className="small muted">Loading invoices…</p> : null}
      {list.isSuccess && rows.length === 0 ? <Empty title={`No invoices for ${periodLabel(period)}.`} /> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Number</th><th>Company</th><th className="num">Total</th><th className="num">Outstanding</th><th>Status</th><th>Due</th></tr></thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => setOpen(i.id)}>
                  <td className="mono">{i.number}</td>
                  <td className="mono">{shortId(i.orgId)}</td>
                  <td className="num mono">{birr(i.totalMinor)}</td>
                  <td className="num mono">{birr(i.outstandingMinor)}</td>
                  <td><Pill tone={invoiceTone(i)}>{i.overdue ? "overdue" : INVOICE_LABEL[i.status] ?? i.status}</Pill></td>
                  <td className="small">{dayAndTime(i.dueAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {open ? <StaffInvoice id={open} canPay={canIssue} onClose={() => setOpen(null)} onDone={done} /> : null}
    </div>
  );
}

function Issue({ orgId, period, onDone }: { orgId: string; period: string; onDone: (id: string) => void }) {
  const [sure, setSure] = useState(false);
  const [key] = useState(newIdempotencyKey);
  const issue = useMutation({ mutationFn: () => api<InvoiceDetail>("staff", "/api/payments/invoices", { idempotencyKey: key, body: { orgId, period } }), onSuccess: (i) => onDone(i.id) });
  if (!sure) return <button className="btn secondary" onClick={() => setSure(true)}>Issue…</button>;
  return (
    <div className="stack" style={{ gap: "0.25rem" }}>
      <span className="xs muted">Once issued it can't be changed.</span>
      <div className="row" style={{ gap: "0.25rem" }}>
        <button className="btn" disabled={issue.isPending} onClick={() => issue.mutate()}>Issue</button>
        <button className="btn secondary" disabled={issue.isPending} onClick={() => setSure(false)}>Back</button>
      </div>
      <Problem error={issue.error} />
    </div>
  );
}

function StaffInvoice({ id, canPay, onClose, onDone }: { id: string; canPay: boolean; onClose: () => void; onDone: () => void }) {
  const name = useStaffNames();
  const q = useQuery({ queryKey: ["money", "invoices", "one", id], queryFn: () => api<InvoiceDetail>("staff", `/api/payments/invoices/${id}`) });
  const i = q.data;
  return (
    <Drawer title={i ? `${i.number} · company ${shortId(i.orgId)}` : "Invoice"} wide onClose={onClose}>
      <Problem error={q.error} />
      {q.isPending ? <p className="small muted">Loading…</p> : null}
      {i ? (
        <div className="stack" style={{ gap: "1rem" }}>
          <p className="xs muted" style={{ margin: 0 }}>Issued by {name(i.issuedBy)}{i.payments.length ? ` · payments applied by ${[...new Set(i.payments.map((x) => name(x.recordedBy)))].join(", ")}` : ""}</p>
          {canPay && i.status === "ISSUED" ? <RecordPayment invoice={i} onDone={() => { onDone(); void q.refetch(); }} /> : null}
          <InvoiceBody invoice={i} surface="staff" csvPath={`/api/payments/invoices/${i.id}/csv`} tripLink={(t) => `/staff/trips/${t}`} />
        </div>
      ) : null}
    </Drawer>
  );
}

function RecordPayment({ invoice, onDone }: { invoice: InvoiceDetail; onDone: () => void }) {
  const [amount, setAmount] = useState(() => (invoice.outstandingMinor / 100).toFixed(2));
  const [ref, setRef] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  const minor = toMinor(amount);
  const pay = useMutation({
    mutationFn: () => api<InvoiceDetail>("staff", `/api/payments/invoices/${invoice.id}/payments`, { idempotencyKey: key, body: { amountMinor: minor, bankReference: ref.trim() } }),
    onSuccess: () => { setRef(""); setKey(newIdempotencyKey()); onDone(); },
  });
  const ok = !!minor && minor <= invoice.outstandingMinor && /^[A-Za-z0-9/_.-]{3,60}$/.test(ref.trim());
  return (
    <form className="card pad stack" style={{ gap: "0.5rem" }} onSubmit={(e) => { e.preventDefault(); if (ok) pay.mutate(); }}>
      <strong>Apply a bank transfer</strong>
      <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap" }}>
        <Field label="Amount (ETB)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} hint={`${birr(invoice.outstandingMinor)} outstanding`} />
        <Field label="Bank reference" value={ref} onChange={(e) => setRef(e.target.value)} hint="The bank's transaction id; each is applied once." />
      </div>
      <Problem error={pay.error} />
      <div className="row"><button className="btn" disabled={!ok || pay.isPending}>{pay.isPending ? "Applying…" : "Apply payment"}</button></div>
    </form>
  );
}
