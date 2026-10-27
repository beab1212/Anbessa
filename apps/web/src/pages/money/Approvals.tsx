// Money decisions that need a second person (Payment.md §15, Role.md §11): cash and bank top-ups,
// refunds, payout batches, commission rules and balance policies. Whoever asked can't approve.
// Pending shows what waits; History shows what was decided. Each list is only asked for when the
// person's roles let payment-service answer it, so nobody sees a 403 for a list they can't have.

import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { allowed, api } from "../../lib/api";
import { download } from "../../lib/admin";
import { birr, CITY_NAMES, dayAndTime, shortId } from "../../lib/format";
import {
  anyInAnyCity, BATCH_LABEL, batchTone, canListTopUps, canReadPayouts, CHANGE_LABEL, CHANNEL_LABEL, citiesWithAny, csvName, decided, percent,
  PAYMENT_READERS, PROVIDER_LABEL, REFUND_CSV, REFUND_LABEL, refundTone, RULE_DECIDERS, RULE_VIEWERS, TOP_UP_CSV, TOP_UP_LABEL, topUpTone, toCsv,
  type PayoutBatch, type Refund, type RuleChange, type TopUp,
} from "../../lib/money";
import { useSession } from "../../lib/session";
import { Drawer, Empty, Notice, PageHead, Pill, Problem, TextArea } from "../../components/ui";
import { useStaffNames } from "../admin/Approvals";
import { BatchDetail } from "./Payouts";
import { MoreMoneyApprovals } from "./Adjustments";
import { PaymentDrawer } from "./Payments";

type Decision = "approve" | "reject";
type Names = (id: string | null | undefined) => string;

export function MoneyApprovalsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "history" ? "history" : "pending";
  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead title="Money approvals" lede="Cash and bank top-ups, refunds, payouts and rule changes wait here for a second person." />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "pending"} onClick={() => setParams({})}>Pending</button>
        <button role="tab" aria-selected={tab === "history"} onClick={() => setParams({ tab: "history" })}>History</button>
      </div>
      {tab === "pending" ? <Pending /> : <History />}
    </div>
  );
}

// ── pending ────────────────────────────────────────────────────────────────

function Pending() {
  const { staff } = useSession();
  const p = staff.principal!;
  const qc = useQueryClient();
  const name = useStaffNames();
  const topUps = useQuery({
    queryKey: ["money", "approvals", "top-ups"], enabled: canListTopUps(p),
    queryFn: () => api<{ topUps: TopUp[] }>("staff", "/api/payments/top-ups?status=PENDING_APPROVAL").then((r) => r.topUps),
  });
  const refunds = useQuery({
    queryKey: ["money", "approvals", "refunds"], enabled: anyInAnyCity(p, PAYMENT_READERS),
    queryFn: () => api<{ refunds: Refund[] }>("staff", "/api/payments/refunds?status=PENDING_APPROVAL").then((r) => r.refunds),
  });
  const batches = useQuery({
    queryKey: ["money", "approvals", "payouts"], enabled: canReadPayouts(p),
    queryFn: () => api<{ batches: PayoutBatch[] }>("staff", "/api/payments/payouts").then((r) => r.batches.filter((b) => b.status === "PENDING_APPROVAL")),
  });
  const rules = useQuery({
    queryKey: ["money", "approvals", "rules"], enabled: anyInAnyCity(p, RULE_DECIDERS),
    queryFn: () => api<{ changes: RuleChange[] }>("staff", "/api/payments/rules/pending").then((r) => r.changes),
  });
  const done = () => void qc.invalidateQueries({ queryKey: ["money"] });
  const all = [topUps, refunds, batches, rules];
  const loading = all.some((x) => x.isLoading);
  const empty = all.every((x) => !x.data || x.data.length === 0);

  return (
    <>
      <Problem error={topUps.error} />
      <Problem error={refunds.error} />
      <Problem error={batches.error} />
      <Problem error={rules.error} />
      {loading ? <p className="small muted">Loading what's waiting…</p> : null}
      {empty && !loading && all.every((x) => !x.error) ? <Empty title="No refunds, top-ups, payouts or rule changes waiting." /> : null}
      {/* adjustments, write-offs, limit exceptions and incentives waiting (they say so when empty) */}
      <MoreMoneyApprovals />

      {batches.data?.map((b) => (
        <Card key={b.id} title={`Payouts for ${b.cycleEnd}: ${birr(b.totalMinor)} to ${b.lineCount} account${b.lineCount === 1 ? "" : "s"}`} who={b.preparedBy ? name(b.preparedBy) : "the weekly run"} at={b.createdAt}
          mine={b.preparedBy === p.userId} canDecide={allowed(p, "payout:approve")} path={`/api/payments/payouts/${b.id}`} onDone={done}
          approveNote={`This sends ${birr(b.totalMinor)} to ${b.lineCount} account${b.lineCount === 1 ? "" : "s"} through their providers right away. It can't be undone.`}>
          <p className="small" style={{ margin: 0 }}>{b.duesCreated} payment due notice{b.duesCreated === 1 ? "" : "s"} were sent to balances below zero. <Link to="/staff/money/payouts">See the lines</Link></p>
        </Card>
      ))}

      {topUps.data?.map((t) => (
        <Card key={t.id} title={`${CHANNEL_LABEL[t.channel]}: ${birr(t.amountMinor)}`} who={name(t.createdBy)} at={t.createdAt}
          mine={t.createdBy === p.userId} canDecide={allowed(p, "topup:approve_cash")} path={`/api/payments/top-ups/${t.id}`} onDone={done}
          approveNote={`This credits ${birr(t.amountMinor)} to balance ${shortId(t.accountId)}. Check receipt ${t.receiptNo ?? ""} first.`}>
          <p className="small" style={{ margin: 0 }}>To <Link to={`/staff/money/balances/${t.accountId}`}>balance {shortId(t.accountId)}</Link> · receipt {t.receiptNo}{t.note ? ` · ${t.note}` : ""}</p>
        </Card>
      ))}

      {refunds.data?.map((r) => (
        <Card key={r.id} title={`Refund ${birr(r.amountMinor)} of ${birr(r.payment?.amountMinor)}`} who={name(r.requestedBy)} at={r.createdAt}
          mine={r.requestedBy === p.userId} canDecide={allowed(p, "refund:approve", r.payment ? { cityId: r.payment.cityId } : {})} path={`/api/payments/refunds/${r.id}`} onDone={done}
          approveNote={`This sends ${birr(r.amountMinor)} back to the rider through ${PROVIDER_LABEL[r.payment?.provider ?? ""] ?? r.payment?.provider ?? "the provider"}${r.driverAtFault ? " and takes it from the driver's balance" : ""}.`}>
          <p className="small" style={{ margin: 0 }}>
            “{r.reason}” · {r.driverAtFault ? "charged to the driver's balance" : "platform goodwill"}
            {r.payment ? <> · <Link to={`/staff/trips/${r.payment.tripId}`}>trip {shortId(r.payment.tripId)}</Link> · {CITY_NAMES[r.payment.cityId] ?? r.payment.cityId}</> : null}
          </p>
        </Card>
      ))}

      {rules.data?.map((c) => (
        <Card key={c.id} title={`${c.kind === "COMMISSION_RULE" ? "Commission rule" : "Balance limits"} for ${CITY_NAMES[c.cityId] ?? c.cityId}`} who={name(c.makerId)} at={c.createdAt}
          mine={c.makerId === p.userId} canDecide={allowed(p, c.kind === "COMMISSION_RULE" ? "commission_rule:approve" : "balance_policy:approve", { cityId: c.cityId })}
          path={`/api/payments/rules/changes/${c.id}`} canCancel onDone={done}
          approveNote={c.kind === "BALANCE_POLICY" ? "Every balance in the city is checked against the new limits; some drivers may lose cash trips." : "Trips completed after it takes effect use the new commission."}>
          <p className="small" style={{ margin: 0 }}>{describeRuleChange(c)} · “{c.reason}” · expires {dayAndTime(c.expiresAt)} · <Link to={`/staff/money/rules?city=${c.cityId}`}>rules</Link></p>
        </Card>
      ))}
    </>
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

function Card({ title, who, at, mine, canDecide, canCancel = false, path, onDone, approveNote, children }: {
  title: string; who: string; at: string; mine: boolean; canDecide: boolean; canCancel?: boolean; path: string; onDone: () => void; approveNote: string; children: React.ReactNode;
}) {
  const [step, setStep] = useState<"idle" | "approve" | "reject" | "cancel">("idle");
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
        step === "cancel" ? (
          <div className="stack" style={{ gap: "0.5rem" }}>
            <p className="small" style={{ margin: 0 }}>Withdraw your proposal? It won't take effect, and you can propose again.</p>
            <div className="row" style={{ gap: "0.5rem" }}>
              <button className="btn danger" disabled={decide.isPending} onClick={() => decide.mutate("cancel")}>Withdraw</button>
              <button className="btn secondary" disabled={decide.isPending} onClick={() => setStep("idle")}>Back</button>
            </div>
          </div>
        ) : (
          <div className="row" style={{ gap: "0.5rem" }}>
            <Pill tone="amber">waiting for someone else</Pill>
            {canCancel ? <button className="btn secondary" onClick={() => setStep("cancel")}>Withdraw…</button> : null}
          </div>
        )
      ) : canDecide ? (
        step === "reject" ? (
          <form onSubmit={(e) => { e.preventDefault(); decide.mutate("reject"); }}>
            <TextArea label="Why not" value={reason} onChange={(e) => setReason(e.target.value)} hint="The person who asked sees this" />
            <div className="row" style={{ gap: "0.5rem" }}>
              <button className="btn danger" disabled={decide.isPending || reason.trim().length < 3}>Reject</button>
              <button type="button" className="btn secondary" onClick={() => setStep("idle")}>Back</button>
            </div>
          </form>
        ) : step === "approve" ? (
          <div className="stack" style={{ gap: "0.5rem" }}>
            <Notice>{approveNote}</Notice>
            <div className="row" style={{ gap: "0.5rem" }}>
              <button className="btn" disabled={decide.isPending} onClick={() => decide.mutate("approve")}>{decide.isPending ? "Approving…" : "Yes, approve"}</button>
              <button className="btn secondary" disabled={decide.isPending} onClick={() => setStep("idle")}>Back</button>
            </div>
          </div>
        ) : (
          <div className="row" style={{ gap: "0.5rem" }}>
            <button className="btn" onClick={() => setStep("approve")}>Approve…</button>
            <button className="btn secondary" onClick={() => setStep("reject")}>Reject</button>
          </div>
        )
      ) : <span className="xs muted">Someone with the approving role decides this.</span>}
    </section>
  );
}

// ── history ────────────────────────────────────────────────────────────────

type Kind = "refunds" | "top-ups" | "payouts" | "rules";

function History() {
  const { staff } = useSession();
  const p = staff.principal!;
  const name = useStaffNames();
  const kinds = ([
    ["refunds", "Refunds", anyInAnyCity(p, PAYMENT_READERS)],
    ["top-ups", "Top-ups", canListTopUps(p)],
    ["payouts", "Payouts", canReadPayouts(p)],
    ["rules", "Rule changes", anyInAnyCity(p, RULE_VIEWERS)],
  ] as [Kind, string, boolean][]).filter(([, , ok]) => ok);
  const [picked, setPicked] = useState<Kind | null>(null);
  const kind = kinds.find(([k]) => k === picked)?.[0] ?? kinds[0]?.[0] ?? null;
  if (!kind) return <Empty title="Nothing to show.">Your roles don't include any decided money lists.</Empty>;
  return (
    <>
      {kinds.length > 1 ? (
        <div className="chips">
          {kinds.map(([k, label]) => <button key={k} className="chip" aria-pressed={kind === k} onClick={() => setPicked(k)}>{label}</button>)}
        </div>
      ) : null}
      {kind === "refunds" ? <RefundHistory name={name} /> : kind === "top-ups" ? <TopUpHistory name={name} /> : kind === "payouts" ? <PayoutHistory name={name} /> : <RuleHistory name={name} />}
    </>
  );
}

const REFUND_STATES: [string, string][] = [["", "All decided"], ["PROCESSING", "Sending"], ["SUCCEEDED", "Refunded"], ["FAILED", "Failed"], ["REJECTED", "Rejected"]];

function RefundHistory({ name }: { name: Names }) {
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["money", "history", "refunds", status],
    queryFn: () => api<{ refunds: Refund[] }>("staff", `/api/payments/refunds${status ? `?status=${status}` : ""}`).then((r) => decided(r.refunds)),
  });
  const rows = q.data ?? [];
  return (
    <section className="stack" style={{ gap: "0.75rem" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
        <div className="chips">{REFUND_STATES.map(([s, l]) => <button key={s} className="chip" aria-pressed={status === s} onClick={() => setStatus(s)}>{l}</button>)}</div>
        {rows.length ? <button className="btn secondary" onClick={() => download(csvName("refunds"), toCsv(rows, REFUND_CSV))}><Download /> Export CSV ({rows.length})</button> : null}
      </div>
      <p className="xs muted" style={{ margin: 0 }}>The newest 100 in the cities you handle money in.</p>
      <Problem error={q.error} />
      {q.isPending ? <p className="small muted">Loading refunds…</p> : null}
      {q.isSuccess && rows.length === 0 ? <Empty title="No decided refunds." /> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Asked</th><th>Trip</th><th className="num">Refund</th><th>Status</th><th>Decided</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => setOpen(r.paymentId)}>
                  <td className="small">{dayAndTime(r.createdAt)}<div className="xs muted">by {name(r.requestedBy)}</div></td>
                  <td>{r.payment ? <><Link className="mono" to={`/staff/trips/${r.payment.tripId}`} onClick={(e) => e.stopPropagation()}>{shortId(r.payment.tripId)}</Link><div className="xs muted">{CITY_NAMES[r.payment.cityId] ?? r.payment.cityId}</div></> : "—"}</td>
                  <td className="num mono">{birr(r.amountMinor)}<div className="xs muted">of {birr(r.payment?.amountMinor)}</div></td>
                  <td><Pill tone={refundTone(r.status)}>{REFUND_LABEL[r.status] ?? r.status}</Pill><div className="xs muted">“{r.reason}”{r.driverAtFault ? " · driver at fault" : ""}</div></td>
                  <td className="small">{r.approvedBy ? name(r.approvedBy) : "—"}{r.decidedAt ? <div className="xs muted">{dayAndTime(r.decidedAt)}</div> : null}{r.decisionReason || r.failure ? <div className="xs muted">{r.decisionReason ?? r.failure}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {open ? <PaymentDrawer id={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

const TOP_UP_STATES: [string, string][] = [["", "All decided"], ["SUCCEEDED", "Credited"], ["REJECTED", "Rejected"], ["FAILED", "Failed"]];
const CHANNELS: [string, string][] = [["", "Every way"], ["OFFICE_CASH", "Cash at an office"], ["BANK_TRANSFER", "Bank transfer"], ["MOBILE_MONEY", "Mobile money"]];

function TopUpHistory({ name }: { name: Names }) {
  const [status, setStatus] = useState("");
  const [channel, setChannel] = useState("OFFICE_CASH");
  const [open, setOpen] = useState<string | null>(null);
  const qs = new URLSearchParams({ ...(status ? { status } : {}), ...(channel ? { channel } : {}) }).toString();
  const q = useQuery({
    queryKey: ["money", "history", "top-ups", qs],
    queryFn: () => api<{ topUps: TopUp[] }>("staff", `/api/payments/top-ups${qs ? `?${qs}` : ""}`).then((r) => decided(r.topUps, ["PENDING_APPROVAL", "PENDING", "ACTION_REQUIRED"])),
  });
  const rows = q.data ?? [];
  return (
    <section className="stack" style={{ gap: "0.75rem" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
        <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
          <div className="chips">{CHANNELS.map(([s, l]) => <button key={s} className="chip" aria-pressed={channel === s} onClick={() => setChannel(s)}>{l}</button>)}</div>
          <div className="chips">{TOP_UP_STATES.map(([s, l]) => <button key={s} className="chip" aria-pressed={status === s} onClick={() => setStatus(s)}>{l}</button>)}</div>
        </div>
        {rows.length ? <button className="btn secondary" onClick={() => download(csvName("top-ups"), toCsv(rows, TOP_UP_CSV))}><Download /> Export CSV ({rows.length})</button> : null}
      </div>
      <p className="xs muted" style={{ margin: 0 }}>The newest 100 that match, every city.</p>
      <Problem error={q.error} />
      {q.isPending ? <p className="small muted">Loading top-ups…</p> : null}
      {q.isSuccess && rows.length === 0 ? <Empty title="No decided top-ups." /> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>How</th><th>Balance</th><th className="num">Amount</th><th>Status</th><th>Recorded · approved</th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="clickable" onClick={() => setOpen(t.id)}>
                  <td className="small">{dayAndTime(t.createdAt)}</td>
                  <td className="small">{CHANNEL_LABEL[t.channel]}{t.receiptNo ? <div className="xs muted mono">{t.receiptNo}</div> : null}</td>
                  <td><Link to={`/staff/money/balances/${t.accountId}`} onClick={(e) => e.stopPropagation()}>{shortId(t.accountId)}</Link></td>
                  <td className="num mono">{birr(t.amountMinor)}</td>
                  <td><Pill tone={topUpTone(t.status)}>{TOP_UP_LABEL[t.status] ?? t.status}</Pill></td>
                  <td className="small">{t.channel === "MOBILE_MONEY" ? "the owner" : name(t.createdBy)}{t.approvedBy ? ` · ${name(t.approvedBy)}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {open ? <TopUpDrawer id={open} name={name} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

function TopUpDrawer({ id, name, onClose }: { id: string; name: Names; onClose: () => void }) {
  const q = useQuery({ queryKey: ["money", "top-up", id], queryFn: () => api<TopUp>("staff", `/api/payments/top-ups/${id}`) });
  const t = q.data;
  return (
    <Drawer title={t ? `${CHANNEL_LABEL[t.channel]}: ${birr(t.amountMinor)}` : "Top-up"} onClose={onClose}>
      <Problem error={q.error} />
      {q.isPending ? <p className="small muted">Loading…</p> : null}
      {t ? (
        <dl className="kv">
          <dt>Status</dt><dd><Pill tone={topUpTone(t.status)}>{TOP_UP_LABEL[t.status] ?? t.status}</Pill></dd>
          <dt>Balance</dt><dd><Link to={`/staff/money/balances/${t.accountId}`}>{shortId(t.accountId)}</Link></dd>
          {t.provider ? <><dt>Provider</dt><dd>{PROVIDER_LABEL[t.provider] ?? t.provider}</dd></> : null}
          {t.receiptNo ? <><dt>{t.channel === "BANK_TRANSFER" ? "Bank transaction" : "Receipt"}</dt><dd className="mono">{t.receiptNo}</dd></> : null}
          {t.note ? <><dt>Note</dt><dd className="small">{t.note}</dd></> : null}
          <dt>Recorded</dt><dd className="small">{dayAndTime(t.createdAt)} · {t.channel === "MOBILE_MONEY" ? "by the owner" : name(t.createdBy)}</dd>
          {t.approvedBy ? <><dt>{t.status === "REJECTED" ? "Rejected by" : "Approved by"}</dt><dd className="small">{name(t.approvedBy)}</dd></> : null}
          {t.completedAt ? <><dt>Finished</dt><dd className="small">{dayAndTime(t.completedAt)}</dd></> : null}
          {t.failure ? <><dt>Reason</dt><dd className="small">{t.failure}</dd></> : null}
        </dl>
      ) : null}
    </Drawer>
  );
}

function PayoutHistory({ name }: { name: Names }) {
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["money", "payouts"], refetchInterval: 15_000, queryFn: () => api<{ batches: PayoutBatch[] }>("staff", "/api/payments/payouts").then((r) => r.batches) });
  const rows = decided(q.data ?? []);
  return (
    <section className="stack" style={{ gap: "0.75rem" }}>
      <p className="xs muted" style={{ margin: 0 }}>The latest 30 weekly settlements. Open one for its lines.</p>
      <Problem error={q.error} />
      {q.isPending ? <p className="small muted">Loading payouts…</p> : null}
      {q.isSuccess && rows.length === 0 ? <Empty title="No decided payout batches." /> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Week ending</th><th className="num">Total</th><th>Accounts</th><th>Status</th><th>Prepared · decided</th></tr></thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} className="clickable" onClick={() => setOpen(b.id)}>
                  <td className="small">{b.cycleEnd}</td>
                  <td className="num mono">{birr(b.totalMinor)}</td>
                  <td className="small">{b.lineCount}</td>
                  <td><Pill tone={batchTone(b.status)}>{BATCH_LABEL[b.status] ?? b.status}</Pill>{b.rejectReason ? <div className="xs muted">{b.rejectReason}</div> : null}</td>
                  <td className="small">{b.preparedBy ? name(b.preparedBy) : "weekly run"} · {b.approvedBy ? name(b.approvedBy) : "—"}{b.decidedAt ? <div className="xs muted">{dayAndTime(b.decidedAt)}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {open ? <Drawer title="Payout batch" wide onClose={() => setOpen(null)}><BatchDetail id={open} name={name} /></Drawer> : null}
    </section>
  );
}

function RuleHistory({ name }: { name: Names }) {
  const { staff } = useSession();
  const cities = citiesWithAny(staff.principal, RULE_VIEWERS);
  const [picked, setPicked] = useState<string | null>(null);
  const city = picked && cities.includes(picked) ? picked : (cities[0] ?? null);
  const q = useQuery({
    queryKey: ["money", "rules", city], enabled: !!city,
    queryFn: () => api<{ changes: RuleChange[] }>("staff", `/api/payments/rules?cityId=${city}`),
  });
  const rows = decided(q.data?.changes ?? []);
  if (!city) return <Empty title="No city to show." />;
  return (
    <section className="stack" style={{ gap: "0.75rem" }}>
      {cities.length > 1 ? <div className="chips">{cities.map((c) => <button key={c} className="chip" aria-pressed={city === c} onClick={() => setPicked(c)}>{CITY_NAMES[c] ?? c}</button>)}</div> : null}
      <p className="xs muted" style={{ margin: 0 }}>The latest 30 proposals for {CITY_NAMES[city] ?? city}. <Link to={`/staff/money/rules?city=${city}`}>What's in force</Link></p>
      <Problem error={q.error} />
      {q.isPending ? <p className="small muted">Loading rule changes…</p> : null}
      {q.isSuccess && rows.length === 0 ? <Empty title="No decided rule changes in this city." /> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Proposed</th><th>What</th><th>Status</th><th>Decided</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="small">{dayAndTime(c.createdAt)}<div className="xs muted">by {name(c.makerId)}</div></td>
                    <td className="small"><strong>{c.kind === "COMMISSION_RULE" ? "Commission" : "Limits"}</strong>: {describeRuleChange(c)}<div className="xs muted">“{c.reason}”</div></td>
                    <td><Pill tone={c.status === "EXECUTED" ? "green" : c.status === "REJECTED" ? "red" : "grey"}>{CHANGE_LABEL[c.status] ?? c.status.toLowerCase()}</Pill></td>
                    <td className="small">{c.checkerId ? name(c.checkerId) : "—"}{c.decidedAt ? <div className="xs muted">{dayAndTime(c.decidedAt)}</div> : null}{c.decisionReason ? <div className="xs muted">{c.decisionReason}</div> : null}</td>
                  </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
