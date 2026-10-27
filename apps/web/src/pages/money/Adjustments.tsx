// Balance adjustments (Payment.md §15, workflow 13): a manual credit (goodwill, a fee reversed, a
// lost-item return) or debit (a correction) to a driver's or fleet's balance. Support agents ask in
// their city (up to 1,000 ETB), finance officers anywhere; a finance manager approves, never the
// person who asked. Also home to the pieces the other control pages share: the decision buttons,
// the balance field, and `MoreMoneyApprovals` (the controls' cards for the Money approvals inbox).

import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { allowed, api, newIdempotencyKey } from "../../lib/api";
import { download } from "../../lib/admin";
import { birr, CITY_NAMES, dayAndTime, shortId } from "../../lib/format";
import { csvName, inAnyCity, isUuid, toCsv, toMinor } from "../../lib/money";
import {
  ADJUSTMENT_CSV, CATEGORIES, CATEGORY_LABEL, describeIncentive, describeOverride, LIMITS, REQUEST_LABEL, requestTone, signedBirr,
  type Adjustment, type Direction, type PendingControls,
} from "../../lib/money2";
import { useSession } from "../../lib/session";
import { Empty, Field, Notice, PageHead, Pill, Problem, SelectField, TextArea } from "../../components/ui";
import { useStaffNames } from "../admin/Approvals";

// ── shared by the control pages ────────────────────────────────────────────

/** A balance named by account id (uuid) or by the reference code its owner quotes (ANB-…). */
export function balanceRef(input: string): { accountId: string } | { referenceCode: string } | null {
  const v = input.trim();
  if (!v) return null;
  if (isUuid(v)) return { accountId: v };
  return /^ANB-[A-Z0-9]{6}$/i.test(v) ? { referenceCode: v.toUpperCase() } : null;
}

export function BalanceField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const bad = value.trim() !== "" && !balanceRef(value);
  return (
    <Field label="Balance" placeholder="ANB-7K2Q9X or the account id" value={value} onChange={(e) => onChange(e.target.value)}
      hint={bad ? "That's neither a reference code (ANB-…) nor an account id." : "The reference code the driver or fleet quotes, or the account id from the balance page."} />
  );
}

/**
 * Approve / reject / withdraw buttons for one request (`POST {path}/{approve|reject|cancel}`).
 * The person who asked sees "waiting for someone else" (and may withdraw); nobody approves their own.
 */
export function DecisionBar({ path, mine, canDecide, approveNote, onDone, rejectNeedsReason = true }: {
  path: string; mine: boolean; canDecide: boolean; approveNote: string; onDone: () => void; rejectNeedsReason?: boolean;
}) {
  const [step, setStep] = useState<"idle" | "approve" | "reject" | "cancel">("idle");
  const [reason, setReason] = useState("");
  const decide = useMutation({
    mutationFn: (d: "approve" | "reject" | "cancel") => api("staff", `${path}/${d}`, { body: reason.trim() ? { reason: reason.trim() } : {} }),
    onSuccess: () => { setStep("idle"); setReason(""); onDone(); },
  });
  return (
    <div className="stack" style={{ gap: "0.5rem" }}>
      <Problem error={decide.error} />
      {mine ? (
        step === "cancel" ? (
          <div className="row" style={{ gap: "0.5rem" }}>
            <span className="small">Withdraw it? Nothing happens, and you can ask again.</span>
            <button className="btn danger" disabled={decide.isPending} onClick={() => decide.mutate("cancel")}>Withdraw</button>
            <button className="btn secondary" disabled={decide.isPending} onClick={() => setStep("idle")}>Back</button>
          </div>
        ) : (
          <div className="row" style={{ gap: "0.5rem" }}>
            <Pill tone="amber">waiting for someone else</Pill>
            <button className="btn secondary" onClick={() => setStep("cancel")}>Withdraw…</button>
          </div>
        )
      ) : canDecide ? (
        step === "reject" ? (
          <form onSubmit={(e) => { e.preventDefault(); decide.mutate("reject"); }}>
            <TextArea label="Why not" value={reason} onChange={(e) => setReason(e.target.value)} hint="The person who asked sees this" />
            <div className="row" style={{ gap: "0.5rem" }}>
              <button className="btn danger" disabled={decide.isPending || (rejectNeedsReason && reason.trim().length < 3)}>Reject</button>
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
    </div>
  );
}

/** "Fleet ABC123" / "Driver ABC123" linking to the balance page. */
export function OwnerLink({ accountId, beneficiary, referenceCode }: { accountId: string; beneficiary?: { type: string; id: string } | undefined; referenceCode?: string | undefined }) {
  const p = useSession().staff.principal;
  const label = `${beneficiary?.type === "ORGANIZATION" ? "Fleet" : "Driver"} ${referenceCode ?? shortId(accountId)}`;
  return inAnyCity(p, "balance:read") ? <Link to={`/staff/money/balances/${accountId}`}>{label}</Link> : <span>{label}</span>;
}

// ── the page ───────────────────────────────────────────────────────────────

const STATUSES: [string, string][] = [["PENDING_APPROVAL", "Waiting"], ["", "All"], ["EXECUTED", "Done"], ["REJECTED", "Rejected"], ["CANCELLED", "Withdrawn"], ["EXPIRED", "Expired"]];

export function AdjustmentsPage() {
  const { staff } = useSession();
  const p = staff.principal;
  const qc = useQueryClient();
  const name = useStaffNames();
  const [params] = useSearchParams();
  const [status, setStatus] = useState("PENDING_APPROVAL");
  const [asking, setAsking] = useState(!!params.get("account"));
  const account = params.get("account");
  const qs = new URLSearchParams({ ...(status ? { status } : {}), ...(account && isUuid(account) ? { accountId: account } : {}) }).toString();
  const q = useQuery({
    queryKey: ["money", "adjustments", qs],
    queryFn: () => api<{ adjustments: Adjustment[] }>("staff", `/api/payments/adjustments${qs ? `?${qs}` : ""}`).then((r) => r.adjustments),
  });
  const rows = q.data ?? [];
  const done = () => void qc.invalidateQueries({ queryKey: ["money"] });
  const canAsk = inAnyCity(p, "adjustment:request");

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Balance adjustments"
        lede="Credits and debits by hand: goodwill, a fee reversed, a correction. Someone asks, a finance manager approves."
        right={canAsk ? <button className="btn" onClick={() => setAsking((v) => !v)}>{asking ? "Close" : "Ask for an adjustment"}</button> : null}
      />
      {asking && canAsk ? <AskAdjustment initial={account ?? ""} onDone={() => { setAsking(false); setStatus("PENDING_APPROVAL"); done(); }} /> : null}
      <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
        <div className="chips">{STATUSES.map(([s, l]) => <button key={s} className="chip" aria-pressed={status === s} onClick={() => setStatus(s)}>{l}</button>)}</div>
        {rows.length ? <button className="btn secondary" onClick={() => download(csvName("adjustments"), toCsv(rows, ADJUSTMENT_CSV))}><Download /> Export CSV ({rows.length})</button> : null}
      </div>
      {account ? <p className="xs muted" style={{ margin: 0 }}>Only balance {shortId(account)}. <Link to="/staff/money/adjustments">Show all</Link></p> : <p className="xs muted" style={{ margin: 0 }}>The newest 100 in the cities you handle money in.</p>}
      <Problem error={q.error} />
      {q.isPending ? <p className="small muted">Loading adjustments…</p> : null}
      {q.isSuccess && rows.length === 0 ? <Empty title={status === "PENDING_APPROVAL" ? "Nothing waiting." : "No adjustments."} /> : null}
      {rows.map((a) => (
        <section key={a.id} className="card pad stack" style={{ gap: "0.5rem" }}>
          <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
            <strong>{signedBirr(a.direction, a.amountMinor)} · {CATEGORY_LABEL[a.category]} · <OwnerLink accountId={a.accountId} beneficiary={a.beneficiary} referenceCode={a.referenceCode} /></strong>
            <Pill tone={requestTone(a.status)}>{REQUEST_LABEL[a.status] ?? a.status}</Pill>
          </div>
          <p className="small" style={{ margin: 0 }}>
            “{a.reason}” · {CITY_NAMES[a.cityId] ?? a.cityId}
            {a.ticketId ? ` · ticket ${a.ticketId}` : ""}
            {a.tripId ? <> · <Link to={`/staff/trips/${a.tripId}`}>trip {shortId(a.tripId)}</Link></> : null}
            {a.balanceMinor !== undefined ? ` · balance now ${birr(a.balanceMinor)}` : ""}
          </p>
          <p className="xs muted" style={{ margin: 0 }}>
            asked by {name(a.requestedBy)} · {dayAndTime(a.createdAt)}
            {a.decidedBy && a.status !== "PENDING_APPROVAL" ? ` · ${a.status === "CANCELLED" ? "withdrawn" : `decided by ${name(a.decidedBy)}`} ${dayAndTime(a.decidedAt)}` : ""}
            {a.decisionReason ? ` · “${a.decisionReason}”` : ""}
            {a.status === "PENDING_APPROVAL" ? ` · expires ${dayAndTime(a.expiresAt)}` : ""}
          </p>
          {a.status === "PENDING_APPROVAL" ? (
            <DecisionBar path={`/api/payments/adjustments/${a.id}`} mine={a.requestedBy === p?.userId} canDecide={allowed(p, "adjustment:approve", { cityId: a.cityId })} onDone={done}
              approveNote={adjustmentNote(a)} />
          ) : null}
        </section>
      ))}
    </div>
  );
}

const adjustmentNote = (a: Adjustment) =>
  `This ${a.direction === "CREDIT" ? "credits" : "debits"} ${birr(a.amountMinor)} ${a.direction === "CREDIT" ? "to" : "from"} the balance at once${a.balanceMinor !== undefined ? ` (now ${birr(a.balanceMinor)}, after ${birr(a.balanceMinor + (a.direction === "CREDIT" ? a.amountMinor : -a.amountMinor))})` : ""}. ${a.direction === "CREDIT" ? "The platform pays for it." : ""}`;

function AskAdjustment({ initial, onDone }: { initial: string; onDone: () => void }) {
  const p = useSession().staff.principal;
  const [balance, setBalance] = useState(initial);
  const [direction, setDirection] = useState<Direction>("CREDIT");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]!);
  const [reason, setReason] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [tripId, setTripId] = useState("");
  const [key] = useState(newIdempotencyKey);
  const ref = balanceRef(balance);
  const minor = toMinor(amount);
  const cityOnly = !allowed(p, "adjustment:request");
  const send = useMutation({
    mutationFn: () => api<Adjustment>("staff", "/api/payments/adjustments", {
      idempotencyKey: key,
      body: { ...ref, direction, amountMinor: minor, category, reason: reason.trim(), ...(ticketId.trim() ? { ticketId: ticketId.trim() } : {}), ...(isUuid(tripId) ? { tripId: tripId.trim() } : {}) },
    }),
    onSuccess: onDone,
  });
  const ok = !!ref && !!minor && reason.trim().length >= 5 && (tripId.trim() === "" || isUuid(tripId));
  return (
    <form className="card pad stack" style={{ gap: "0.75rem" }} onSubmit={(e) => { e.preventDefault(); if (ok) send.mutate(); }}>
      <BalanceField value={balance} onChange={setBalance} />
      <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap" }}>
        <SelectField label="Direction" value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
          <option value="CREDIT">Credit (the balance goes up)</option>
          <option value="DEBIT">Debit (the balance goes down)</option>
        </SelectField>
        <Field label="Amount (ETB)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
          hint={cityOnly ? `Up to ${birr(LIMITS.adjustmentCityStaffMaxMinor)} from city staff` : `Up to ${birr(LIMITS.adjustmentMaxMinor)}`} />
        <SelectField label="Why" value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
        </SelectField>
      </div>
      <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} hint="At least 5 characters. The approver and the audit log see it." />
      <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap" }}>
        <Field label="Ticket (optional)" value={ticketId} onChange={(e) => setTicketId(e.target.value)} />
        <Field label="Trip id (optional)" value={tripId} onChange={(e) => setTripId(e.target.value)} />
      </div>
      <p className="xs muted" style={{ margin: 0 }}>Credits to one balance are capped at {birr(LIMITS.adjustmentCreditPer30DaysMinor)} per 30 days. The request expires after 7 days without a decision.</p>
      <Problem error={send.error} />
      <div className="row"><button className="btn" disabled={!ok || send.isPending}>{send.isPending ? "Sending…" : "Ask for approval"}</button></div>
    </form>
  );
}

// ── for the Money approvals inbox ──────────────────────────────────────────

/**
 * The controls' pending requests as cards (adjustments, write-offs, overrides, incentives), each
 * with its decision buttons. Mount inside Money approvals → Pending. Renders nothing when empty.
 */
export function MoreMoneyApprovals() {
  const p = useSession().staff.principal;
  const qc = useQueryClient();
  const name = useStaffNames();
  const q = useQuery({
    queryKey: ["money", "approvals", "controls"],
    queryFn: () => api<PendingControls>("staff", "/api/payments/approvals/pending"),
  });
  const done = () => void qc.invalidateQueries({ queryKey: ["money"] });
  const d = q.data;
  if (q.error) return <Problem error={q.error} />;
  if (!d) return null;
  const card = (key: string, title: React.ReactNode, who: string, at: string, body: React.ReactNode, bar: React.ReactNode) => (
    <section key={key} className="card pad stack" style={{ gap: "0.5rem" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
        <strong>{title}</strong>
        <span className="xs muted">asked by {who} · {dayAndTime(at)}</span>
      </div>
      <p className="small" style={{ margin: 0 }}>{body}</p>
      {bar}
    </section>
  );
  return (
    <>
      {d.adjustments.map((a) => card(a.id, <>Adjustment {signedBirr(a.direction, a.amountMinor)} · {CATEGORY_LABEL[a.category]}</>, name(a.requestedBy), a.createdAt,
        <>“{a.reason}” · <OwnerLink accountId={a.accountId} beneficiary={a.beneficiary} referenceCode={a.referenceCode} />{a.balanceMinor !== undefined ? ` (balance ${birr(a.balanceMinor)})` : ""} · <Link to="/staff/money/adjustments">adjustments</Link></>,
        <DecisionBar path={`/api/payments/adjustments/${a.id}`} mine={a.requestedBy === p?.userId} canDecide={allowed(p, "adjustment:approve", { cityId: a.cityId })} onDone={done} approveNote={adjustmentNote(a)} />))}
      {d.writeOffs.map((w) => card(w.id, <>Write off {birr(w.amountMinor)}</>, name(w.requestedBy), w.createdAt,
        <>“{w.reason}” · <OwnerLink accountId={w.accountId} beneficiary={w.beneficiary} referenceCode={w.referenceCode} /> · <Link to="/staff/money/write-offs">write-offs</Link></>,
        <DecisionBar path={`/api/payments/write-offs/${w.id}`} mine={w.requestedBy === p?.userId} canDecide={allowed(p, "writeoff:approve", { cityId: w.cityId })} onDone={done}
          approveNote={`This forgives ${birr(w.amountMinor)} as bad debt: the balance goes to zero and its payment dues close as written off. If the balance moved since, approval is refused.`} />))}
      {d.overrides.map((o) => card(o.id, <>Limits exception: {describeOverride(o)}</>, name(o.requestedBy), o.createdAt,
        <>“{o.reason}” · <OwnerLink accountId={o.accountId} beneficiary={o.beneficiary} referenceCode={o.referenceCode} /> · {dayAndTime(o.validFrom)} → {dayAndTime(o.validUntil)} · <Link to="/staff/money/overrides">overrides</Link></>,
        <DecisionBar path={`/api/payments/policy-overrides/${o.id}`} mine={o.requestedBy === p?.userId} canDecide={allowed(p, "policy_override:approve", { cityId: o.cityId })} onDone={done}
          approveNote="The balance is held to these limits instead of the city's for the window; its state is recomputed at once." />))}
      {d.incentives.map((x) => card(x.id, <>Incentive “{x.name}”: {describeIncentive(x)}</>, name(x.proposedBy), x.createdAt,
        <>{CITY_NAMES[x.cityId] ?? x.cityId} · {dayAndTime(x.startsAt)} → {dayAndTime(x.endsAt)} · budget {birr(x.budgetMinor)} · “{x.reason}” · <Link to="/staff/money/incentives">incentives</Link></>,
        <DecisionBar path={`/api/payments/incentives/${x.id}`} mine={x.proposedBy === p?.userId} canDecide={allowed(p, "incentive:approve", { cityId: x.cityId })} onDone={done}
          approveNote={`When the window closes, every driver with ${x.targetTrips} trips gets ${birr(x.rewardMinor)} on their balance, first come first served, up to ${birr(x.budgetMinor)} in total.`} />))}
    </>
  );
}
