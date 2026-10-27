// Policy overrides (Payment.md §13, §15): an exception to the city's balance limits for one driver
// or fleet, for a time window (a trusted fleet with a larger cash limit, a new driver kept prepaid).
// An onboarding officer asks in their city; a finance manager approves, and may revoke it early.

import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { allowed, api, newIdempotencyKey } from "../../lib/api";
import { birr, CITY_NAMES, dayAndTime } from "../../lib/format";
import { inAnyCity, STATE_LABEL, stateTone } from "../../lib/money";
import { describeOverride, isoToLocal, LIMITS, localToIso, REQUEST_LABEL, requestTone, signedMinor, type PolicyOverride } from "../../lib/money2";
import { useNow } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { Empty, Field, PageHead, Pill, Problem, SelectField, TextArea } from "../../components/ui";
import { useStaffNames } from "../admin/Approvals";
import { BalanceField, balanceRef, DecisionBar, OwnerLink } from "./Adjustments";

const STATUSES: [string, string][] = [["PENDING_APPROVAL", "Waiting"], ["APPROVED", "Approved"], ["", "All"], ["REVOKED", "Revoked"], ["REJECTED", "Rejected"], ["EXPIRED", "Expired"]];

export function OverridesPage() {
  const p = useSession().staff.principal;
  const qc = useQueryClient();
  const name = useStaffNames();
  const [params] = useSearchParams();
  const [status, setStatus] = useState("PENDING_APPROVAL");
  const [asking, setAsking] = useState(!!params.get("account"));
  const q = useQuery({
    queryKey: ["money", "overrides", status],
    queryFn: () => api<{ overrides: PolicyOverride[] }>("staff", `/api/payments/policy-overrides${status ? `?status=${status}` : ""}`).then((r) => r.overrides),
  });
  const rows = q.data ?? [];
  const done = () => void qc.invalidateQueries({ queryKey: ["money"] });
  const canAsk = inAnyCity(p, "policy_override:request");
  const now = useNow(60_000);

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Limit exceptions"
        lede="One balance held to different limits than its city's, for a window. Onboarding asks, a finance manager approves."
        right={canAsk ? <button className="btn" onClick={() => setAsking((v) => !v)}>{asking ? "Close" : "Ask for an exception"}</button> : null}
      />
      {asking && canAsk ? <AskOverride initial={params.get("account") ?? ""} onDone={() => { setAsking(false); setStatus("PENDING_APPROVAL"); done(); }} /> : null}
      <div className="chips">{STATUSES.map(([s, l]) => <button key={s} className="chip" aria-pressed={status === s} onClick={() => setStatus(s)}>{l}</button>)}</div>
      <Problem error={q.error} />
      {q.isPending ? <p className="small muted">Loading…</p> : null}
      {q.isSuccess && rows.length === 0 ? <Empty title={status === "PENDING_APPROVAL" ? "Nothing waiting." : "No exceptions."} /> : null}
      {rows.map((o) => (
        <section key={o.id} className="card pad stack" style={{ gap: "0.5rem" }}>
          <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem", flexWrap: "wrap" }}>
            <strong>{describeOverride(o)} · <OwnerLink accountId={o.accountId} beneficiary={o.beneficiary} referenceCode={o.referenceCode} /></strong>
            <span className="row" style={{ gap: "0.25rem" }}>
              {o.inForce ? <Pill tone="green">in force</Pill> : null}
              <Pill tone={requestTone(o.status)}>{REQUEST_LABEL[o.status] ?? o.status}</Pill>
            </span>
          </div>
          <p className="small" style={{ margin: 0 }}>
            {dayAndTime(o.validFrom)} → {dayAndTime(o.validUntil)} · {CITY_NAMES[o.cityId] ?? o.cityId} · “{o.reason}”
            {o.state ? <> · now <Pill tone={stateTone(o.state)}>{STATE_LABEL[o.state]}</Pill> at {birr(o.balanceMinor)}</> : null}
          </p>
          <p className="xs muted" style={{ margin: 0 }}>
            asked by {name(o.requestedBy)} · {dayAndTime(o.createdAt)}
            {o.decidedBy && o.status !== "PENDING_APPROVAL" && o.status !== "CANCELLED" ? ` · decided by ${name(o.decidedBy)} ${dayAndTime(o.decidedAt)}` : ""}
            {o.revokedBy ? ` · revoked by ${name(o.revokedBy)} ${dayAndTime(o.revokedAt)}` : ""}
            {o.decisionReason ? ` · “${o.decisionReason}”` : ""}
          </p>
          {o.status === "PENDING_APPROVAL" ? (
            <DecisionBar path={`/api/payments/policy-overrides/${o.id}`} mine={o.requestedBy === p?.userId} canDecide={allowed(p, "policy_override:approve", { cityId: o.cityId })} onDone={done}
              approveNote="The balance is held to these limits instead of the city's for the window; its state is recomputed at once (some trips may be allowed or paused)." />
          ) : o.status === "APPROVED" && new Date(o.validUntil).getTime() > now && allowed(p, "policy_override:approve", { cityId: o.cityId }) ? (
            <Revoke id={o.id} onDone={done} />
          ) : null}
        </section>
      ))}
    </div>
  );
}

function Revoke({ id, onDone }: { id: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const revoke = useMutation({ mutationFn: () => api("staff", `/api/payments/policy-overrides/${id}/revoke`, { body: { reason: reason.trim() } }), onSuccess: onDone });
  if (!open) return <div className="row"><button className="btn secondary" onClick={() => setOpen(true)}>Revoke…</button></div>;
  return (
    <form className="stack" style={{ gap: "0.5rem" }} onSubmit={(e) => { e.preventDefault(); revoke.mutate(); }}>
      <TextArea label="Why end it now" value={reason} onChange={(e) => setReason(e.target.value)} hint="The city's limits apply again at once." />
      <Problem error={revoke.error} />
      <div className="row" style={{ gap: "0.5rem" }}>
        <button className="btn danger" disabled={reason.trim().length < 5 || revoke.isPending}>Revoke</button>
        <button type="button" className="btn secondary" onClick={() => setOpen(false)}>Back</button>
      </div>
    </form>
  );
}

function AskOverride({ initial, onDone }: { initial: string; onDone: () => void }) {
  const [balance, setBalance] = useState(initial);
  const [mode, setMode] = useState<"" | "POSTPAID" | "PREPAID">("");
  const [warning, setWarning] = useState("");
  const [cash, setCash] = useState("");
  const [hard, setHard] = useState("");
  const [prepaid, setPrepaid] = useState("");
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState(() => isoToLocal(Date.now() + 30 * 86_400_000));
  const [reason, setReason] = useState("");
  const [key] = useState(newIdempotencyKey);
  const ref = balanceRef(balance);
  const limit = (v: string) => (v.trim() === "" ? null : signedMinor(v));
  const values = { warningMinor: limit(warning), cashLimitMinor: limit(cash), hardLimitMinor: limit(hard), prepaidMinimumMinor: limit(prepaid) };
  const negativeOk = [values.warningMinor, values.cashLimitMinor, values.hardLimitMinor].every((v) => v === null || v <= 0) && (values.prepaidMinimumMinor === null || values.prepaidMinimumMinor >= 0);
  const anything = mode !== "" || Object.values(values).some((v) => v !== null);
  const untilIso = localToIso(until);
  const send = useMutation({
    mutationFn: () => api<PolicyOverride>("staff", "/api/payments/policy-overrides", {
      idempotencyKey: key,
      body: { ...ref, mode: mode || null, ...values, validFrom: localToIso(from), validUntil: untilIso, reason: reason.trim() },
    }),
    onSuccess: onDone,
  });
  const ok = !!ref && anything && negativeOk && !!untilIso && reason.trim().length >= 5;
  return (
    <form className="card pad stack" style={{ gap: "0.75rem" }} onSubmit={(e) => { e.preventDefault(); if (ok) send.mutate(); }}>
      <BalanceField value={balance} onChange={setBalance} />
      <p className="xs muted" style={{ margin: 0 }}>Leave a field empty to keep the city's value. Limits are negative amounts in ETB (e.g. −1500). Every trip stops no lower than {birr(LIMITS.overrideHardLimitFloorMinor)}; a window lasts at most {LIMITS.overrideMaxDays} days.</p>
      <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap" }}>
        <SelectField label="Mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="">the city's</option>
          <option value="POSTPAID">postpaid</option>
          <option value="PREPAID">prepaid</option>
        </SelectField>
        <Field label="Warning (ETB)" value={warning} onChange={(e) => setWarning(e.target.value)} placeholder="−300" />
        <Field label="Cash trips pause (ETB)" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="−500" />
        <Field label="All trips stop (ETB)" value={hard} onChange={(e) => setHard(e.target.value)} placeholder="−1000" />
        <Field label="Prepaid minimum (ETB)" value={prepaid} onChange={(e) => setPrepaid(e.target.value)} placeholder="100" />
      </div>
      {!negativeOk ? <p className="small" role="alert" style={{ margin: 0 }}>Limits are zero or below; the prepaid minimum is zero or above.</p> : null}
      <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap" }}>
        <Field label="From (empty = on approval)" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Field label="Until" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
      </div>
      <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} hint="At least 5 characters. The approver and the audit log see it." />
      <Problem error={send.error} />
      <div className="row"><button className="btn" disabled={!ok || send.isPending}>{send.isPending ? "Sending…" : "Ask for approval"}</button></div>
    </form>
  );
}
