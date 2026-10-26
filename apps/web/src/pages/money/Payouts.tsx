// Weekly settlement and payouts (workflow 09 D): the run (Monday 00:00 Addis, or "run now" by a
// finance officer) pays positive balances and sends payment dues to negative ones. A finance
// manager approves each batch; each line then goes to its provider.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { allowed, api } from "../../lib/api";
import { birr, dayAndTime, shortId } from "../../lib/format";
import { PROVIDER_LABEL, type PayoutBatch } from "../../lib/money";
import { useSession } from "../../lib/session";
import { Empty, Notice, PageHead, Pill, Problem } from "../../components/ui";
import { useStaffNames } from "../admin/Approvals";

const BATCH_LABEL: Record<string, string> = { PENDING_APPROVAL: "waiting for approval", SENDING: "sending", COMPLETED: "done", REJECTED: "rejected" };
const LINE_TONE: Record<string, "green" | "amber" | "red" | "grey"> = { SUCCEEDED: "green", SENT: "amber", PENDING: "amber", FAILED: "red", SKIPPED: "grey" };

export function PayoutsPage() {
  const { staff } = useSession();
  const p = staff.principal;
  const qc = useQueryClient();
  const name = useStaffNames();
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["money", "payouts"], refetchInterval: 15_000, queryFn: () => api<{ batches: PayoutBatch[] }>("staff", "/api/payments/payouts").then((r) => r.batches) });
  const run = useMutation({
    mutationFn: () => api<{ batch: PayoutBatch; created: boolean }>("staff", "/api/payments/settlements/run", { body: {} }),
    onSuccess: (r) => {
      setOpen(r.batch.id);
      void qc.invalidateQueries({ queryKey: ["money"] });
    },
  });
  const current = open ?? list.data?.[0]?.id ?? null;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Payouts"
        lede="Every Monday at 00:00 positive balances above the minimum are paid out and balances below zero get a payment due. A finance manager approves each batch."
        right={allowed(p, "payout:prepare") ? <button className="btn" disabled={run.isPending} onClick={() => run.mutate()}>Run settlement now</button> : null}
      />
      <Problem error={list.error ?? run.error} />
      {run.data && !run.data.created ? <Notice>Today's settlement already ran; here it is.</Notice> : null}
      {list.data?.length === 0 ? <Empty title="No settlements yet." /> : null}
      {list.data?.length ? (
        <div className="chips">
          {list.data.map((b) => (
            <button key={b.id} className="chip" aria-pressed={current === b.id} onClick={() => setOpen(b.id)}>
              {b.cycleEnd} · {BATCH_LABEL[b.status] ?? b.status}
            </button>
          ))}
        </div>
      ) : null}
      {current ? <BatchDetail id={current} name={name} /> : null}
    </div>
  );
}

function BatchDetail({ id, name }: { id: string; name: (id: string | null) => string }) {
  const q = useQuery({ queryKey: ["money", "payout", id], refetchInterval: (s) => (s.state.data?.status === "SENDING" ? 3000 : 20_000), queryFn: () => api<PayoutBatch>("staff", `/api/payments/payouts/${id}`) });
  const b = q.data;
  if (!b) return <Problem error={q.error} />;
  const paid = b.lines?.filter((l) => l.status === "SUCCEEDED").reduce((n, l) => n + l.amountMinor, 0) ?? 0;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Settlement {b.cycleEnd}</h2>
        <Pill tone={b.status === "COMPLETED" ? "green" : b.status === "REJECTED" ? "red" : "amber"}>{BATCH_LABEL[b.status] ?? b.status}</Pill>
      </div>
      <div className="card-body">
        <p className="small" style={{ marginTop: 0 }}>
          {birr(b.totalMinor)} to {b.lineCount} account{b.lineCount === 1 ? "" : "s"} · {b.duesCreated} payment due notice{b.duesCreated === 1 ? "" : "s"} ·
          prepared by {b.preparedBy ? name(b.preparedBy) : "the weekly run"}{b.approvedBy ? ` · ${b.status === "REJECTED" ? "rejected" : "approved"} by ${name(b.approvedBy)}` : ""}
          {b.status !== "PENDING_APPROVAL" ? ` · ${birr(paid)} arrived` : ""}
          {b.status === "PENDING_APPROVAL" ? <> · <Link to="/staff/money/approvals">approve under Money approvals</Link></> : null}
        </p>
        {b.rejectReason ? <Notice tone="error">{b.rejectReason}</Notice> : null}
      </div>
      {b.lines?.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Balance</th><th>To</th><th className="num">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {b.lines.map((l) => (
                <tr key={l.id}>
                  <td><Link to={`/staff/money/balances/${l.accountId}`}>{l.beneficiary?.type === "ORGANIZATION" ? "Fleet" : "Driver"} {shortId(l.beneficiary?.id ?? l.accountId)}</Link><div className="xs muted mono">{l.referenceCode}</div></td>
                  <td className="small">{l.provider ? `${PROVIDER_LABEL[l.provider] ?? l.provider} ${l.destination ?? ""}` : <span className="muted">no payout method</span>}</td>
                  <td className="num mono">{birr(l.amountMinor)}</td>
                  <td><Pill tone={LINE_TONE[l.status] ?? "grey"}>{l.status === "SKIPPED" ? "rolled over" : l.status.toLowerCase()}</Pill>{l.failure ? <div className="xs muted">{l.failure}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="card-body"><p className="small muted" style={{ margin: 0 }}>Nobody had enough to pay out. Created {dayAndTime(b.createdAt)}.</p></div>}
    </section>
  );
}
