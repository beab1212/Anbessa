// Write-offs (Payment.md §16, workflow 09 E): the debt of a balance whose payment due has stayed
// overdue (90 days by default) is written off as bad debt. A finance officer asks for the whole
// debt; a finance manager approves. Approval is refused if the balance moved since the request.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { allowed, api, newIdempotencyKey } from "../../lib/api";
import { download } from "../../lib/admin";
import { birr, CITY_NAMES, dayAndTime } from "../../lib/format";
import { csvName, STATE_LABEL, stateTone, toCsv } from "../../lib/money";
import { REQUEST_LABEL, requestTone, WRITE_OFF_CSV, type WriteOff, type WriteOffCandidate } from "../../lib/money2";
import { useSession } from "../../lib/session";
import { Empty, PageHead, Pill, Problem, TextArea } from "../../components/ui";
import { useStaffNames } from "../admin/Approvals";
import { DecisionBar, OwnerLink } from "./Adjustments";

const STATUSES: [string, string][] = [["PENDING_APPROVAL", "Waiting"], ["", "All"], ["EXECUTED", "Written off"], ["REJECTED", "Rejected"], ["CANCELLED", "Withdrawn"], ["EXPIRED", "Expired"]];

export function WriteOffsPage() {
  const p = useSession().staff.principal;
  const qc = useQueryClient();
  const name = useStaffNames();
  const [status, setStatus] = useState("PENDING_APPROVAL");
  const done = () => void qc.invalidateQueries({ queryKey: ["money"] });
  const candidates = useQuery({
    queryKey: ["money", "write-offs", "candidates"],
    queryFn: () => api<{ afterDays: number; candidates: WriteOffCandidate[] }>("staff", "/api/payments/write-offs/candidates"),
  });
  const q = useQuery({
    queryKey: ["money", "write-offs", status],
    queryFn: () => api<{ writeOffs: WriteOff[] }>("staff", `/api/payments/write-offs${status ? `?status=${status}` : ""}`).then((r) => r.writeOffs),
  });
  const rows = q.data ?? [];
  const canAsk = allowed(p, "writeoff:request");
  const after = candidates.data?.afterDays ?? 90;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead title="Write-offs" lede={`Debt overdue for ${after} days or more can be written off as bad debt. A finance officer asks, a finance manager approves.`} />

      <section className="card">
        <div className="card-head"><h2>Eligible now</h2><span className="xs muted">below zero, overdue {after}+ days, no open request</span></div>
        <div className="card-body stack" style={{ gap: "0.5rem" }}>
          <Problem error={candidates.error} />
          {candidates.isPending ? <p className="small muted">Loading…</p> : null}
          {candidates.data && candidates.data.candidates.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No balance is eligible.</p> : null}
          {candidates.data?.candidates.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Balance</th><th>City</th><th className="num">Owes</th><th>State</th><th>Overdue since</th><th /></tr></thead>
                <tbody>
                  {candidates.data.candidates.map((c) => (
                    <Candidate key={c.accountId} c={c} canAsk={canAsk} onDone={done} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </section>

      <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
        <div className="chips">{STATUSES.map(([s, l]) => <button key={s} className="chip" aria-pressed={status === s} onClick={() => setStatus(s)}>{l}</button>)}</div>
        {rows.length ? <button className="btn secondary" onClick={() => download(csvName("write-offs"), toCsv(rows, WRITE_OFF_CSV))}><Download /> Export CSV ({rows.length})</button> : null}
      </div>
      <Problem error={q.error} />
      {q.isPending ? <p className="small muted">Loading write-offs…</p> : null}
      {q.isSuccess && rows.length === 0 ? <Empty title={status === "PENDING_APPROVAL" ? "Nothing waiting." : "No write-offs."} /> : null}
      {rows.map((w) => (
        <section key={w.id} className="card pad stack" style={{ gap: "0.5rem" }}>
          <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
            <strong>{birr(w.amountMinor)} · <OwnerLink accountId={w.accountId} beneficiary={w.beneficiary} referenceCode={w.referenceCode} /></strong>
            <Pill tone={requestTone(w.status)}>{REQUEST_LABEL[w.status] ?? w.status}</Pill>
          </div>
          <p className="small" style={{ margin: 0 }}>“{w.reason}” · {CITY_NAMES[w.cityId] ?? w.cityId}{w.balanceMinor !== undefined ? ` · balance now ${birr(w.balanceMinor)}` : ""}</p>
          <p className="xs muted" style={{ margin: 0 }}>
            asked by {name(w.requestedBy)} · {dayAndTime(w.createdAt)}
            {w.decidedBy && w.status !== "PENDING_APPROVAL" ? ` · ${w.status === "CANCELLED" ? "withdrawn" : `decided by ${name(w.decidedBy)}`} ${dayAndTime(w.decidedAt)}` : ""}
            {w.decisionReason ? ` · “${w.decisionReason}”` : ""}
          </p>
          {w.status === "PENDING_APPROVAL" ? (
            <DecisionBar path={`/api/payments/write-offs/${w.id}`} mine={w.requestedBy === p?.userId} canDecide={allowed(p, "writeoff:approve", { cityId: w.cityId })} onDone={done}
              approveNote={`This forgives ${birr(w.amountMinor)} as bad debt: the balance goes to zero and its payment dues close as written off. If the balance moved since the request, approval is refused.`} />
          ) : null}
        </section>
      ))}
    </div>
  );
}

function Candidate({ c, canAsk, onDone }: { c: WriteOffCandidate; canAsk: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [key] = useState(newIdempotencyKey);
  const ask = useMutation({
    mutationFn: () => api("staff", "/api/payments/write-offs", { idempotencyKey: key, body: { accountId: c.accountId, reason: reason.trim() } }),
    onSuccess: () => { setOpen(false); onDone(); },
  });
  return (
    <>
      <tr>
        <td><OwnerLink accountId={c.accountId} beneficiary={c.beneficiary} referenceCode={c.referenceCode} /></td>
        <td className="small">{CITY_NAMES[c.cityId] ?? c.cityId}</td>
        <td className="num mono">{birr(-c.balanceMinor)}</td>
        <td><Pill tone={stateTone(c.state)}>{STATE_LABEL[c.state] ?? c.state}</Pill></td>
        <td className="small">{dayAndTime(c.overdueSince)}<div className="xs muted">{c.overdueDays} days</div></td>
        <td>{canAsk ? <button className="btn secondary" onClick={() => setOpen((v) => !v)}>{open ? "Close" : "Ask to write off…"}</button> : null}</td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={6}>
            <form className="stack" style={{ gap: "0.5rem" }} onSubmit={(e) => { e.preventDefault(); ask.mutate(); }}>
              <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} hint="E.g. the driver left the platform; collection attempts failed." />
              <Problem error={ask.error} />
              <div className="row"><button className="btn" disabled={reason.trim().length < 5 || ask.isPending}>Ask to write off {birr(-c.balanceMinor)}</button></div>
            </form>
          </td>
        </tr>
      ) : null}
    </>
  );
}
