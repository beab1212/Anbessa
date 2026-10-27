// Driver incentives (workflow 15 E): "N trips in city X between two dates earns Y". Operations
// proposes, a finance manager approves. When the window closes, payment-service pays every driver
// who reached the target, first come first served within the budget, once each.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { allowed, api, newIdempotencyKey } from "../../lib/api";
import { birr, CITIES, CITY_NAMES, dayAndTime, shortId } from "../../lib/format";
import { citiesWithAny, toMinor } from "../../lib/money";
import {
  describeIncentive, INCENTIVE_VIEWERS, isoToLocal, LIMITS, localToIso, REQUEST_LABEL, requestTone, type IncentiveDetail, type IncentiveProgram,
} from "../../lib/money2";
import { useSession } from "../../lib/session";
import { Drawer, Empty, Field, PageHead, Pill, Problem, SelectField, TextArea } from "../../components/ui";
import { useStaffNames } from "../admin/Approvals";
import { DecisionBar } from "./Adjustments";

const STATUSES: [string, string][] = [["", "All"], ["PENDING_APPROVAL", "Waiting"], ["APPROVED", "Running"], ["CLOSED", "Paid"], ["REJECTED", "Rejected"], ["EXPIRED", "Expired"]];

export function IncentivesPage() {
  const p = useSession().staff.principal;
  const qc = useQueryClient();
  const name = useStaffNames();
  const cities = citiesWithAny(p, INCENTIVE_VIEWERS, CITIES);
  const proposeCities = citiesWithAny(p, ["incentive:propose"], CITIES);
  const [status, setStatus] = useState("");
  const [proposing, setProposing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["money", "incentives", status],
    queryFn: () => api<{ incentives: IncentiveProgram[] }>("staff", `/api/payments/incentives${status ? `?status=${status}` : ""}`).then((r) => r.incentives),
  });
  const rows = q.data ?? [];
  const done = () => void qc.invalidateQueries({ queryKey: ["money"] });

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Driver incentives"
        lede="Quests like “20 trips this weekend earns 300 ETB”. Operations proposes, finance approves; drivers are paid when the window closes."
        right={proposeCities.length ? <button className="btn" onClick={() => setProposing((v) => !v)}>{proposing ? "Close" : "Propose an incentive"}</button> : null}
      />
      {proposing ? <Propose cities={proposeCities} onDone={() => { setProposing(false); done(); }} /> : null}
      <div className="chips">{STATUSES.map(([s, l]) => <button key={s} className="chip" aria-pressed={status === s} onClick={() => setStatus(s)}>{l}</button>)}</div>
      <p className="xs muted" style={{ margin: 0 }}>{cities.length > 1 ? "Every city you handle incentives in." : (CITY_NAMES[cities[0] ?? ""] ?? cities[0] ?? "")} The newest 100.</p>
      <Problem error={q.error} />
      {q.isPending ? <p className="small muted">Loading incentives…</p> : null}
      {q.isSuccess && rows.length === 0 ? <Empty title="No incentives." /> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Incentive</th><th>City</th><th>Window</th><th className="num">Budget</th><th>Status</th><th>Paid</th></tr></thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.id} className="clickable" onClick={() => setOpen(x.id)}>
                  <td><strong>{x.name}</strong><div className="xs muted">{describeIncentive(x)}</div></td>
                  <td className="small">{CITY_NAMES[x.cityId] ?? x.cityId}</td>
                  <td className="small">{dayAndTime(x.startsAt)}<div className="xs muted">→ {dayAndTime(x.endsAt)}</div></td>
                  <td className="num mono">{birr(x.budgetMinor)}</td>
                  <td><Pill tone={requestTone(x.status)}>{REQUEST_LABEL[x.status] ?? x.status}</Pill><div className="xs muted">by {name(x.proposedBy)}</div></td>
                  <td className="small">{x.status === "CLOSED" ? <>{x.awardsCount} driver{x.awardsCount === 1 ? "" : "s"} · {birr(x.spentMinor)}{x.qualifiedCount > x.awardsCount ? <div className="xs muted">{x.qualifiedCount - x.awardsCount} over budget</div> : null}</> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {open ? <Detail id={open} onClose={() => setOpen(null)} onDone={done} /> : null}
    </div>
  );
}

function Detail({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const p = useSession().staff.principal;
  const name = useStaffNames();
  const q = useQuery({ queryKey: ["money", "incentive", id], queryFn: () => api<IncentiveDetail>("staff", `/api/payments/incentives/${id}`) });
  const x = q.data;
  return (
    <Drawer title={x ? x.name : "Incentive"} wide onClose={onClose}>
      <Problem error={q.error} />
      {q.isPending ? <p className="small muted">Loading…</p> : null}
      {x ? (
        <div className="stack" style={{ gap: "1rem" }}>
          <dl className="kv">
            <dt>Status</dt><dd><Pill tone={requestTone(x.status)}>{REQUEST_LABEL[x.status] ?? x.status}</Pill></dd>
            <dt>Terms</dt><dd>{describeIncentive(x)} in {CITY_NAMES[x.cityId] ?? x.cityId}</dd>
            <dt>Window</dt><dd className="small">{dayAndTime(x.startsAt)} → {dayAndTime(x.endsAt)}</dd>
            <dt>Budget</dt><dd className="mono">{birr(x.budgetMinor)} <span className="xs muted">(up to {Math.floor(x.budgetMinor / x.rewardMinor)} drivers)</span></dd>
            <dt>Why</dt><dd className="small">“{x.reason}”</dd>
            <dt>Proposed</dt><dd className="small">{name(x.proposedBy)} · {dayAndTime(x.createdAt)}</dd>
            {x.decidedBy ? <><dt>Decided</dt><dd className="small">{name(x.decidedBy)} · {dayAndTime(x.decidedAt)}{x.decisionReason ? ` · “${x.decisionReason}”` : ""}</dd></> : null}
            {x.closedAt ? <><dt>Paid</dt><dd className="small">{dayAndTime(x.closedAt)} · {x.awardsCount} of {x.qualifiedCount} who qualified · {birr(x.spentMinor)}</dd></> : null}
          </dl>
          {x.status === "PENDING_APPROVAL" ? (
            <DecisionBar path={`/api/payments/incentives/${x.id}`} mine={x.proposedBy === p?.userId} canDecide={allowed(p, "incentive:approve", { cityId: x.cityId })}
              onDone={() => { onDone(); void q.refetch(); }}
              approveNote={`When the window closes, every driver with ${x.targetTrips} trips gets ${birr(x.rewardMinor)}, first come first served, up to ${birr(x.budgetMinor)} in total.`} />
          ) : null}
          {x.progress.length ? (
            <section className="stack" style={{ gap: "0.5rem" }}>
              <h3 style={{ margin: 0 }}>Drivers so far</h3>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Driver</th><th className="num">Trips</th><th>Reached the target</th><th className="num">Paid</th></tr></thead>
                  <tbody>
                    {x.progress.map((r) => {
                      const award = x.awards.find((a) => a.driverId === r.driverId && a.accountId === r.beneficiaryAccountId);
                      return (
                        <tr key={`${r.driverId}-${r.beneficiaryAccountId}`}>
                          <td className="mono">{shortId(r.driverId)}</td>
                          <td className="num">{r.trips}</td>
                          <td className="small">{r.reached ? dayAndTime(r.reachedAt) : "—"}</td>
                          <td className="num mono">{award ? birr(award.amountMinor) : x.status === "CLOSED" && r.reached ? <span className="xs muted">over budget</span> : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="xs muted" style={{ margin: 0 }}>Trips settled in the window, per balance the money went to (a fleet driver's reward goes to the fleet).</p>
            </section>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}

function Propose({ cities, onDone }: { cities: string[]; onDone: () => void }) {
  const [cityId, setCityId] = useState(cities[0] ?? "");
  const [nameText, setName] = useState("");
  const [vehicleType, setVehicleType] = useState("");
  const [target, setTarget] = useState("20");
  const [reward, setReward] = useState("");
  const [budget, setBudget] = useState("");
  const [from, setFrom] = useState(() => isoToLocal(Date.now() + 86_400_000));
  const [until, setUntil] = useState(() => isoToLocal(Date.now() + 8 * 86_400_000));
  const [reason, setReason] = useState("");
  const [key] = useState(newIdempotencyKey);
  const rewardMinor = toMinor(reward);
  const budgetMinor = toMinor(budget);
  const targetTrips = Number(target);
  const startsAt = localToIso(from);
  const endsAt = localToIso(until);
  const send = useMutation({
    mutationFn: () => api<IncentiveProgram>("staff", "/api/payments/incentives", {
      idempotencyKey: key,
      body: { cityId, name: nameText.trim(), vehicleType: vehicleType.trim() || null, targetTrips, rewardMinor, budgetMinor, startsAt, endsAt, reason: reason.trim() },
    }),
    onSuccess: onDone,
  });
  const ok = !!cityId && nameText.trim().length >= 3 && Number.isInteger(targetTrips) && targetTrips >= 1 && !!rewardMinor && !!budgetMinor && budgetMinor >= rewardMinor
    && !!startsAt && !!endsAt && reason.trim().length >= 5 && (vehicleType.trim() === "" || /^[a-z0-9_]{1,30}$/.test(vehicleType.trim()));
  return (
    <form className="card pad stack" style={{ gap: "0.75rem" }} onSubmit={(e) => { e.preventDefault(); if (ok) send.mutate(); }}>
      <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap" }}>
        {cities.length > 1 ? (
          <SelectField label="City" value={cityId} onChange={(e) => setCityId(e.target.value)}>
            {cities.map((c) => <option key={c} value={c}>{CITY_NAMES[c] ?? c}</option>)}
          </SelectField>
        ) : <Field label="City" value={CITY_NAMES[cityId] ?? cityId} disabled />}
        <Field label="Name drivers see" value={nameText} onChange={(e) => setName(e.target.value)} placeholder="Weekend rush" />
        <Field label="Vehicle type (optional)" value={vehicleType} onChange={(e) => setVehicleType(e.target.value)} placeholder="any" />
      </div>
      <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap" }}>
        <Field label="Trips to reach" inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value)} />
        <Field label="Reward per driver (ETB)" inputMode="decimal" value={reward} onChange={(e) => setReward(e.target.value)} hint={`At most ${birr(LIMITS.incentiveMaxRewardMinor)}`} />
        <Field label="Total budget (ETB)" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)}
          hint={rewardMinor && budgetMinor ? `pays up to ${Math.floor(budgetMinor / rewardMinor)} drivers` : `At most ${birr(LIMITS.incentiveMaxBudgetMinor)}`} />
      </div>
      <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap" }}>
        <Field label="Starts" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Field label="Ends" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} hint={`At most ${LIMITS.incentiveMaxDays} days`} />
      </div>
      <TextArea label="Why" value={reason} onChange={(e) => setReason(e.target.value)} hint="Finance sees this when deciding." />
      <Problem error={send.error} />
      <div className="row"><button className="btn" disabled={!ok || send.isPending}>{send.isPending ? "Sending…" : "Propose"}</button></div>
    </form>
  );
}
