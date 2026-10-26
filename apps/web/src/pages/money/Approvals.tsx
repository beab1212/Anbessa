// Money decisions that need a second person (Payment.md §15, Role.md §11): cash and bank top-ups,
// refunds, payout batches, commission rules and balance policies. Whoever asked can't approve.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { allowed, api } from "../../lib/api";
import { birr, CITY_NAMES, dayAndTime, shortId } from "../../lib/format";
import { CHANNEL_LABEL, percent, type PayoutBatch, type Refund, type RuleChange, type TopUp } from "../../lib/money";
import { useSession } from "../../lib/session";
import { Empty, PageHead, Pill, Problem, TextArea } from "../../components/ui";
import { useStaffNames } from "../admin/Approvals";

type Decision = "approve" | "reject";

export function MoneyApprovalsPage() {
  const { staff } = useSession();
  const p = staff.principal!;
  const qc = useQueryClient();
  const name = useStaffNames();
  const topUps = useQuery({
    queryKey: ["money", "approvals", "top-ups"], enabled: allowed(p, "topup:record_cash") || allowed(p, "topup:approve_cash"),
    queryFn: () => api<{ topUps: TopUp[] }>("staff", "/api/payments/top-ups?status=PENDING_APPROVAL").then((r) => r.topUps),
  });
  const refunds = useQuery({
    queryKey: ["money", "approvals", "refunds"],
    queryFn: () => api<{ refunds: Refund[] }>("staff", "/api/payments/refunds?status=PENDING_APPROVAL").then((r) => r.refunds),
  });
  const batches = useQuery({
    queryKey: ["money", "approvals", "payouts"], enabled: allowed(p, "payout:prepare") || allowed(p, "payout:approve"),
    queryFn: () => api<{ batches: PayoutBatch[] }>("staff", "/api/payments/payouts").then((r) => r.batches.filter((b) => b.status === "PENDING_APPROVAL")),
  });
  const rules = useQuery({
    queryKey: ["money", "approvals", "rules"],
    queryFn: () => api<{ changes: RuleChange[] }>("staff", "/api/payments/rules/pending").then((r) => r.changes),
  });
  const done = () => void qc.invalidateQueries({ queryKey: ["money"] });
  const empty = [topUps.data, refunds.data, batches.data, rules.data].every((x) => !x || x.length === 0);

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead title="Money approvals" lede="Cash and bank top-ups, refunds, payouts and rule changes wait here for a second person." />
      <Problem error={topUps.error ?? batches.error} />
      {empty && !topUps.isLoading && !refunds.isLoading ? <Empty title="Nothing waiting." /> : null}

      {batches.data?.map((b) => (
        <Card key={b.id} title={`Payouts for ${b.cycleEnd}: ${birr(b.totalMinor)} to ${b.lineCount} account${b.lineCount === 1 ? "" : "s"}`} who={b.preparedBy ? name(b.preparedBy) : "the weekly run"} at={b.createdAt}
          mine={b.preparedBy === p.userId} canDecide={allowed(p, "payout:approve")} path={`/api/payments/payouts/${b.id}`} onDone={done}>
          <p className="small" style={{ margin: 0 }}>{b.duesCreated} payment due notice{b.duesCreated === 1 ? "" : "s"} were sent to balances below zero. <Link to="/staff/money/payouts">See the lines</Link></p>
        </Card>
      ))}

      {topUps.data?.map((t) => (
        <Card key={t.id} title={`${CHANNEL_LABEL[t.channel]}: ${birr(t.amountMinor)}`} who={name(t.createdBy)} at={t.createdAt}
          mine={t.createdBy === p.userId} canDecide={allowed(p, "topup:approve_cash")} path={`/api/payments/top-ups/${t.id}`} onDone={done}>
          <p className="small" style={{ margin: 0 }}>To <Link to={`/staff/money/balances/${t.accountId}`}>balance {shortId(t.accountId)}</Link> · receipt {t.receiptNo}{t.note ? ` · ${t.note}` : ""}</p>
        </Card>
      ))}

      {refunds.data?.map((r) => (
        <Card key={r.id} title={`Refund ${birr(r.amountMinor)} of ${birr(r.payment?.amountMinor)}`} who={name(r.requestedBy)} at={r.createdAt}
          mine={r.requestedBy === p.userId} canDecide={allowed(p, "refund:approve", r.payment ? { cityId: r.payment.cityId } : {})} path={`/api/payments/refunds/${r.id}`} onDone={done}>
          <p className="small" style={{ margin: 0 }}>
            “{r.reason}” · {r.driverAtFault ? "charged to the driver's balance" : "platform goodwill"}
            {r.payment ? <> · <Link to={`/staff/trips/${r.payment.tripId}`}>trip {shortId(r.payment.tripId)}</Link></> : null}
          </p>
        </Card>
      ))}

      {rules.data?.map((c) => (
        <Card key={c.id} title={`${c.kind === "COMMISSION_RULE" ? "Commission rule" : "Balance limits"} for ${CITY_NAMES[c.cityId] ?? c.cityId}`} who={name(c.makerId)} at={c.createdAt}
          mine={c.makerId === p.userId} canDecide={allowed(p, c.kind === "COMMISSION_RULE" ? "commission_rule:approve" : "balance_policy:approve", { cityId: c.cityId })}
          path={`/api/payments/rules/changes/${c.id}`} canCancel onDone={done}>
          <p className="small" style={{ margin: 0 }}>{describeRuleChange(c)} · “{c.reason}” · <Link to={`/staff/money/rules?city=${c.cityId}`}>rules</Link></p>
        </Card>
      ))}
    </div>
  );
}

export function describeRuleChange(c: Pick<RuleChange, "kind" | "payload">): string {
  const x = c.payload as Record<string, number | string | null>;
  const from = x.validFrom ? ` from ${dayAndTime(String(x.validFrom))}` : " from approval";
  if (c.kind === "COMMISSION_RULE") {
    const who = `${x.vehicleType ? `${x.vehicleType} trips` : "all trips"}${x.beneficiaryId ? ` of ${shortId(String(x.beneficiaryId))}` : ""}`;
    const what = x.model === "PERCENT"
      ? `${percent(Number(x.rateBp))}${x.minMinor !== null && x.minMinor !== undefined ? `, at least ${birr(Number(x.minMinor))}` : ""}${x.maxMinor !== null && x.maxMinor !== undefined ? `, at most ${birr(Number(x.maxMinor))}` : ""}`
      : x.model === "FIXED_PER_TRIP" ? `${birr(Number(x.fixedMinor))} per trip` : "no commission";
    return `${what} on ${who}${from}`;
  }
  return `${x.mode === "PREPAID" ? `prepaid, minimum ${birr(Number(x.prepaidMinimumMinor))}` : `warning ${birr(Number(x.warningMinor))}, cash paused ${birr(Number(x.cashLimitMinor))}, blocked ${birr(Number(x.hardLimitMinor))}`}; pay within ${x.dueDays} days (${percent(Number(x.minPaymentBp))} minimum); VAT ${percent(Number(x.vatRateBp))} on ${x.taxBasis === "FULL_FARE" ? "the fare" : "the commission"}${from}`;
}

function Card({ title, who, at, mine, canDecide, canCancel = false, path, onDone, children }: {
  title: string; who: string; at: string; mine: boolean; canDecide: boolean; canCancel?: boolean; path: string; onDone: () => void; children: React.ReactNode;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const decide = useMutation({
    mutationFn: (d: Decision | "cancel") => api("staff", `${path}/${d}`, { body: reason.trim() ? { reason: reason.trim() } : {} }),
    onSuccess: onDone,
  });
  return (
    <section className="card pad stack" style={{ gap: "0.5rem" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
        <strong>{title}</strong>
        <span className="xs muted">asked by {who} · {dayAndTime(at)}</span>
      </div>
      {children}
      <Problem error={decide.error} />
      {mine ? (
        <div className="row" style={{ gap: "0.5rem" }}>
          <Pill tone="amber">waiting for someone else</Pill>
          {canCancel ? <button className="btn secondary" disabled={decide.isPending} onClick={() => decide.mutate("cancel")}>Withdraw</button> : null}
        </div>
      ) : canDecide ? (
        rejecting ? (
          <form onSubmit={(e) => { e.preventDefault(); decide.mutate("reject"); }}>
            <TextArea label="Why not" value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="row" style={{ gap: "0.5rem" }}>
              <button className="btn danger" disabled={decide.isPending || reason.trim().length < 3}>Reject</button>
              <button type="button" className="btn secondary" onClick={() => setRejecting(false)}>Back</button>
            </div>
          </form>
        ) : (
          <div className="row" style={{ gap: "0.5rem" }}>
            <button className="btn" disabled={decide.isPending} onClick={() => decide.mutate("approve")}>Approve</button>
            <button className="btn secondary" onClick={() => setRejecting(true)}>Reject</button>
          </div>
        )
      ) : <span className="xs muted">Someone with the approving role decides this.</span>}
    </section>
  );
}
