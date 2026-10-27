// Weekly settlement and payouts (workflow 09 D): the run (Monday 00:00 Addis, or "run now" by a
// finance officer) pays positive balances and sends payment dues to negative ones. A finance
// manager approves each batch; each line then goes to its provider.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { allowed, api } from "../../lib/api";
import { download } from "../../lib/admin";
import { birr, dayAndTime, shortId } from "../../lib/format";
import { BATCH_LABEL, batchTone, csvName, lineTotals, PAYOUT_LINE_CSV, PROVIDER_LABEL, toCsv, type PayoutBatch } from "../../lib/money";
import { useSession } from "../../lib/session";
import { Empty, Notice, PageHead, Pill, Problem } from "../../components/ui";
import { useStaffNames } from "../admin/Approvals";

const LINE_TONE: Record<string, "green" | "amber" | "red" | "grey"> = { SUCCEEDED: "green", SENT: "amber", PENDING: "amber", FAILED: "red", SKIPPED: "grey" };
const LINE_LABEL: Record<string, string> = { PENDING: "waiting", SENT: "sent", SUCCEEDED: "arrived", FAILED: "failed", SKIPPED: "rolled over" };

export function PayoutsPage() {
  const { staff } = useSession();
  const p = staff.principal;
  const qc = useQueryClient();
  const name = useStaffNames();
  const [open, setOpen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const list = useQuery({ queryKey: ["money", "payouts"], refetchInterval: 15_000, queryFn: () => api<{ batches: PayoutBatch[] }>("staff", "/api/payments/payouts").then((r) => r.batches) });
  const run = useMutation({
    mutationFn: () => api<{ batch: PayoutBatch; created: boolean }>("staff", "/api/payments/settlements/run", { body: {} }),
    onSuccess: (r) => {
      setOpen(r.batch.id);
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ["money"] });
    },
  });
  const current = open ?? list.data?.[0]?.id ?? null;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Payouts"
        lede="Every Monday at 00:00 positive balances above the minimum are paid out and balances below zero get a payment due. A finance manager approves each batch."
        right={allowed(p, "payout:prepare") && !confirming ? <button className="btn" disabled={run.isPending} onClick={() => setConfirming(true)}>Run settlement now</button> : null}
      />
      {confirming ? (
        <section className="card pad stack" style={{ gap: "0.5rem" }}>
          <strong>Run today's settlement now?</strong>
          <p className="small" style={{ margin: 0 }}>This prepares a payout batch for every positive balance above the minimum and sends a payment due to every balance below zero. Nothing is paid until a finance manager approves the batch. If today's settlement already ran, you get that one.</p>
          <div className="row" style={{ gap: "0.5rem" }}>
            <button className="btn" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? "Running…" : "Yes, run it"}</button>
            <button className="btn secondary" disabled={run.isPending} onClick={() => setConfirming(false)}>Back</button>
          </div>
        </section>
      ) : null}
      <Problem error={list.error ?? run.error} />
      {run.data && !run.data.created ? <Notice>Today's settlement already ran; here it is.</Notice> : null}
      {list.isPending ? <p className="small muted">Loading settlements…</p> : null}
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

/** One batch with its lines (GET /api/payments/payouts/:id). Also used under Money approvals → History. */
export function BatchDetail({ id, name }: { id: string; name: (id: string | null) => string }) {
  const [only, setOnly] = useState("");
  const q = useQuery({ queryKey: ["money", "payout", id], refetchInterval: (s) => (s.state.data?.status === "SENDING" ? 3000 : 20_000), queryFn: () => api<PayoutBatch>("staff", `/api/payments/payouts/${id}`) });
  const b = q.data;
  if (!b) return q.error ? <Problem error={q.error} /> : <p className="small muted">Loading the batch…</p>;
  const lines = b.lines ?? [];
  const totals = lineTotals(lines);
  const shown = only ? lines.filter((l) => l.status === only) : lines;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Settlement {b.cycleEnd}</h2>
        <div className="row" style={{ gap: "0.5rem" }}>
          {lines.length ? <button className="btn ghost sm" onClick={() => download(csvName(`payouts-${b.cycleEnd}`), toCsv(lines, PAYOUT_LINE_CSV))}><Download /> CSV ({lines.length})</button> : null}
          <Pill tone={batchTone(b.status)}>{BATCH_LABEL[b.status] ?? b.status}</Pill>
        </div>
      </div>
      <div className="card-body">
        <Problem error={q.error} />
        <p className="small" style={{ marginTop: 0 }}>
          {birr(b.totalMinor)} to {b.lineCount} account{b.lineCount === 1 ? "" : "s"} · {b.duesCreated} payment due notice{b.duesCreated === 1 ? "" : "s"} ·
          prepared by {b.preparedBy ? name(b.preparedBy) : "the weekly run"} on {dayAndTime(b.createdAt)}
          {b.approvedBy ? ` · ${b.status === "REJECTED" ? "rejected" : "approved"} by ${name(b.approvedBy)}${b.decidedAt ? ` on ${dayAndTime(b.decidedAt)}` : ""}` : ""}
          {b.status === "PENDING_APPROVAL" ? <> · <Link to="/staff/money/approvals">approve under Money approvals</Link></> : null}
        </p>
        {b.rejectReason ? <Notice tone="error">{b.rejectReason}</Notice> : null}
        {lines.length ? (
          <div className="chips" aria-label="Line status">
            <button className="chip" aria-pressed={only === ""} onClick={() => setOnly("")}>All {lines.length}</button>
            {Object.entries(totals).map(([s, t]) => (
              <button key={s} className="chip" aria-pressed={only === s} onClick={() => setOnly(only === s ? "" : s)}>{LINE_LABEL[s] ?? s.toLowerCase()} {t.count} · {birr(t.amountMinor)}</button>
            ))}
          </div>
        ) : null}
      </div>
      {shown.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Balance</th><th>To</th><th className="num">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {shown.map((l) => (
                <tr key={l.id}>
                  <td><Link to={`/staff/money/balances/${l.accountId}`}>{l.beneficiary?.type === "ORGANIZATION" ? "Fleet" : "Driver"} {shortId(l.beneficiary?.id ?? l.accountId)}</Link><div className="xs muted mono">{l.referenceCode}</div></td>
                  <td className="small">{l.provider ? `${PROVIDER_LABEL[l.provider] ?? l.provider} ${l.destination ?? ""}` : <span className="muted">no payout method</span>}</td>
                  <td className="num mono">{birr(l.amountMinor)}</td>
                  <td>
                    <Pill tone={LINE_TONE[l.status] ?? "grey"}>{LINE_LABEL[l.status] ?? l.status.toLowerCase()}</Pill>
                    {l.failure ? <div className="xs muted">{l.failure}</div> : null}
                    {l.updatedAt ? <div className="xs muted">{dayAndTime(l.updatedAt)}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : lines.length === 0 ? <div className="card-body"><p className="small muted" style={{ margin: 0 }}>Nobody had enough to pay out.</p></div> : null}
    </section>
  );
}
