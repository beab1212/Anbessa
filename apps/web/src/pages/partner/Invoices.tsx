// Partner portal: a company's monthly invoices (payment-service GET /api/payments/org/:orgId/invoices,
// corporate:read_invoices @ ORG). Company account admins see their own company's invoices only;
// each opens with its lines, payments and a CSV download.

import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { allowed, api } from "../../lib/api";
import { birr, dayAndTime } from "../../lib/format";
import { INVOICE_LABEL, invoiceTone, periodLabel, type Invoice, type InvoiceDetail } from "../../lib/money2";
import { useSession } from "../../lib/session";
import { Drawer, Empty, Notice, PageHead, Pill, Problem, Stat } from "../../components/ui";
import { InvoiceBody } from "../money/Invoices";

export function CompanyInvoicesPage() {
  const { orgId = "" } = useParams();
  const { partner } = useSession();
  const p = partner.principal;
  const may = allowed(p, "corporate:read_invoices", { orgId });
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["org-invoices", orgId], enabled: may,
    queryFn: () => api<{ orgId: string; owedMinor: number; invoices: Invoice[] }>("partner", `/api/payments/org/${orgId}/invoices`),
  });
  const rows = q.data?.invoices ?? [];
  const unpaid = rows.filter((i) => i.status === "ISSUED");

  if (partner.loading) return <p className="muted">Loading…</p>;
  if (!may) return <div className="page"><Notice tone="error">Only the company account's admins can see its invoices.</Notice></div>;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead title="Invoices" lede="One invoice a month for the rides billed to your company account. Pay by bank transfer quoting the invoice number." />
      {q.data ? (
        <div className="stats">
          <Stat label="Owed now" value={birr(q.data.owedMinor)} sub="including rides not invoiced yet" />
          <Stat label="Unpaid invoices" value={unpaid.length} sub={unpaid.length ? birr(unpaid.reduce((s, i) => s + i.outstandingMinor, 0)) : undefined} alert={unpaid.some((i) => i.overdue)} />
        </div>
      ) : null}
      <Problem error={q.error} />
      {q.isPending ? <p className="muted">Loading…</p> : null}
      {q.data && rows.length === 0 ? <Empty title="No invoices yet.">Your first invoice is issued after the end of the month you start riding.</Empty> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Month</th><th>Number</th><th className="num">Total</th><th className="num">Outstanding</th><th>Status</th><th>Due</th></tr></thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => setOpen(i.id)}>
                  <td>{periodLabel(i.period)}</td>
                  <td className="mono">{i.number}</td>
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
      {open ? <OneInvoice orgId={orgId} id={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function OneInvoice({ orgId, id, onClose }: { orgId: string; id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["org-invoices", orgId, id], queryFn: () => api<InvoiceDetail>("partner", `/api/payments/org/${orgId}/invoices/${id}`) });
  return (
    <Drawer title={q.data ? `${q.data.number} · ${periodLabel(q.data.period)}` : "Invoice"} wide onClose={onClose}>
      <Problem error={q.error} />
      {q.isPending ? <p className="small muted">Loading…</p> : null}
      {q.data ? (
        <InvoiceBody invoice={q.data} surface="partner" csvPath={`/api/payments/org/${orgId}/invoices/${id}/csv`} tripLink={(t) => `/partner/org/${orgId}/trips/${t}`} />
      ) : null}
    </Drawer>
  );
}
