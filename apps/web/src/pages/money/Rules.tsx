// Commission and balance limits per city (Payment.md §7–§8). Operations proposes a new version,
// finance approves it (maker ≠ checker). Past trips keep the rule they were settled with.

import { Fragment, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { allowed, api } from "../../lib/api";
import { birr, CITIES, CITY_NAMES, dayAndTime } from "../../lib/format";
import { percent, toMinor, type RuleChange } from "../../lib/money";
import { useSession } from "../../lib/session";
import { Drawer, Field, Notice, PageHead, Pill, Problem, SelectField, TextArea } from "../../components/ui";
import { describeRuleChange } from "./Approvals";

interface Rule { id: string | null; model: string; rateBp: number | null; fixedMinor: number | null; minMinor: number | null; maxMinor: number | null; vehicleType: string | null; beneficiaryId: string | null; validFrom: string; validTo: string | null; inForce: boolean }
interface Policy { mode: string; warningMinor: number; cashLimitMinor: number; hardLimitMinor: number; prepaidMinimumMinor: number; dueDays: number; minPaymentBp: number; minPayoutMinor: number; taxBasis: string; vatRateBp: number; validFrom: string | null; builtIn?: boolean }
interface RulesOverview { cityId: string; defaults: { rule: Rule; policy: Policy }; policy: Policy; rules: Rule[]; policies: Policy[]; changes: RuleChange[] }

const describeRule = (r: Pick<Rule, "model" | "rateBp" | "fixedMinor" | "minMinor" | "maxMinor">) =>
  r.model === "PERCENT" ? `${percent(r.rateBp)}${r.minMinor !== null ? `, at least ${birr(r.minMinor)}` : ""}${r.maxMinor !== null ? `, at most ${birr(r.maxMinor)}` : ""}`
    : r.model === "FIXED_PER_TRIP" ? `${birr(r.fixedMinor)} per trip` : "no commission";

export function RulesPage() {
  const { staff } = useSession();
  const p = staff.principal;
  const [params, setParams] = useSearchParams();
  const city = params.get("city") ?? CITIES[0]!;
  const [proposing, setProposing] = useState<"COMMISSION_RULE" | "BALANCE_POLICY" | null>(null);
  const q = useQuery({ queryKey: ["money", "rules", city], queryFn: () => api<RulesOverview>("staff", `/api/payments/rules?cityId=${city}`) });
  const o = q.data;
  const inForce = o?.rules.filter((r) => r.inForce) ?? [];
  const scheduled = o?.rules.filter((r) => !r.inForce && new Date(r.validFrom) > new Date()) ?? [];

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Commission and limits"
        lede="Operations proposes, finance approves. Changes apply to trips completed after they take effect."
        right={
          <>
            {allowed(p, "commission_rule:propose", { cityId: city }) ? <button className="btn secondary" onClick={() => setProposing("COMMISSION_RULE")}>Propose a commission</button> : null}
            {allowed(p, "balance_policy:propose", { cityId: city }) ? <button className="btn secondary" onClick={() => setProposing("BALANCE_POLICY")}>Propose limits</button> : null}
          </>
        }
      />
      <div className="chips">
        {CITIES.map((c) => <button key={c} className="chip" aria-pressed={city === c} onClick={() => setParams({ city: c })}>{CITY_NAMES[c] ?? c}</button>)}
      </div>
      <Problem error={q.error} />
      {o ? (
        <div className="two-col">
          <section className="card">
            <div className="card-head"><h2>Commission</h2></div>
            <div className="card-body">
              {inForce.length === 0 ? <p className="small" style={{ marginTop: 0 }}><strong>{describeRule(o.defaults.rule)}</strong> <span className="muted">(default; no rule approved for this city yet)</span></p> : null}
              <dl className="kv">
                {inForce.map((r) => (
                  <Fragment key={r.id}><dt>{r.vehicleType ?? "every vehicle type"}{r.beneficiaryId ? " (contract)" : ""}</dt><dd><strong>{describeRule(r)}</strong> <span className="xs muted">since {dayAndTime(r.validFrom)}</span></dd></Fragment>
                ))}
                {scheduled.map((r) => (
                  <Fragment key={r.id}><dt>{r.vehicleType ?? "every vehicle type"}</dt><dd>{describeRule(r)} <Pill tone="amber">from {dayAndTime(r.validFrom)}</Pill></dd></Fragment>
                ))}
              </dl>
              <p className="xs muted" style={{ marginBottom: 0 }}>VAT on top: {percent(o.policy.vatRateBp)} of {o.policy.taxBasis === "FULL_FARE" ? "the fare" : "the commission"}.</p>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h2>Balance limits</h2>{o.policy.builtIn ? <span className="xs muted">default</span> : null}</div>
            <div className="card-body">
              <dl className="kv">
                <dt>Mode</dt><dd>{o.policy.mode === "PREPAID" ? `prepaid (at least ${birr(o.policy.prepaidMinimumMinor)})` : "postpaid"}</dd>
                <dt>Warning</dt><dd className="mono">{birr(o.policy.warningMinor)}</dd>
                <dt>Cash trips pause</dt><dd className="mono">{birr(o.policy.cashLimitMinor)}</dd>
                <dt>All trips stop</dt><dd className="mono">{birr(o.policy.hardLimitMinor)}</dd>
                <dt>Payment due</dt><dd>within {o.policy.dueDays} days, at least {percent(o.policy.minPaymentBp)}</dd>
                <dt>Smallest payout</dt><dd className="mono">{birr(o.policy.minPayoutMinor)}</dd>
              </dl>
            </div>
          </section>
        </div>
      ) : null}
      {o?.changes.length ? (
        <section className="card">
          <div className="card-head"><h2>Proposals</h2></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When</th><th>What</th><th>Status</th></tr></thead>
              <tbody>
                {o.changes.map((c) => (
                  <tr key={c.id}>
                    <td className="small">{dayAndTime(c.createdAt)}</td>
                    <td className="small">{describeRuleChange(c)}<div className="xs muted">“{c.reason}”{c.decisionReason ? ` · decision: ${c.decisionReason}` : ""}</div></td>
                    <td><Pill tone={c.status === "EXECUTED" ? "green" : c.status === "PENDING" ? "amber" : "grey"}>{c.status === "EXECUTED" ? "approved" : c.status.toLowerCase()}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {proposing && o ? <ProposeDrawer kind={proposing} cityId={city} current={o.policy} onClose={() => setProposing(null)} /> : null}
    </div>
  );
}

function ProposeDrawer({ kind, cityId, current, onClose }: { kind: "COMMISSION_RULE" | "BALANCE_POLICY"; cityId: string; current: Policy; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [validFrom, setValidFrom] = useState("");
  // commission
  const [model, setModel] = useState("PERCENT");
  const [vehicleType, setVehicleType] = useState("");
  const [rate, setRate] = useState("15");
  const [fixed, setFixed] = useState("10");
  const [min, setMin] = useState("10");
  const [max, setMax] = useState("");
  // limits (birr)
  const b = (minor: number) => String(minor / 100);
  const [mode, setMode] = useState(current.mode);
  const [warning, setWarning] = useState(b(current.warningMinor));
  const [cashLimit, setCashLimit] = useState(b(current.cashLimitMinor));
  const [hardLimit, setHardLimit] = useState(b(current.hardLimitMinor));
  const [prepaidMin, setPrepaidMin] = useState(b(current.prepaidMinimumMinor));
  const [dueDays, setDueDays] = useState(String(current.dueDays));
  const [minPayment, setMinPayment] = useState(String(current.minPaymentBp / 100));
  const [minPayout, setMinPayout] = useState(b(current.minPayoutMinor));
  const [vat, setVat] = useState(String(current.vatRateBp / 100));
  const [taxBasis, setTaxBasis] = useState(current.taxBasis);

  const signedMinor = (s: string) => Math.round(Number(s) * 100);
  const optional = (s: string) => (s.trim() === "" ? null : toMinor(s));
  const payload = kind === "COMMISSION_RULE"
    ? {
        model, vehicleType: vehicleType || null, rateBp: model === "PERCENT" ? Math.round(Number(rate) * 100) : null,
        fixedMinor: model === "FIXED_PER_TRIP" ? toMinor(fixed) : null, minMinor: model === "PERCENT" ? optional(min) : null, maxMinor: model === "PERCENT" ? optional(max) : null,
        validFrom: validFrom ? new Date(validFrom).toISOString() : null,
      }
    : {
        mode, warningMinor: -Math.abs(signedMinor(warning)), cashLimitMinor: -Math.abs(signedMinor(cashLimit)), hardLimitMinor: -Math.abs(signedMinor(hardLimit)),
        prepaidMinimumMinor: Math.max(0, signedMinor(prepaidMin)), dueDays: Number(dueDays), minPaymentBp: Math.round(Number(minPayment) * 100),
        minPayoutMinor: Math.max(0, signedMinor(minPayout)), taxBasis, vatRateBp: Math.round(Number(vat) * 100),
        validFrom: validFrom ? new Date(validFrom).toISOString() : null,
      };
  const propose = useMutation({
    mutationFn: () => api("staff", "/api/payments/rules/changes", { body: { kind, cityId, payload, reason: reason.trim() } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["money"] }),
  });

  return (
    <Drawer title={`${kind === "COMMISSION_RULE" ? "Commission" : "Balance limits"} for ${CITY_NAMES[cityId] ?? cityId}`} onClose={onClose}>
      {propose.isSuccess ? (
        <div className="stack" style={{ gap: "0.75rem" }}>
          <Notice tone="ok">Proposed. A finance manager approves it under Money approvals.</Notice>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); propose.mutate(); }}>
          <Problem error={propose.error} />
          {kind === "COMMISSION_RULE" ? (
            <>
              <SelectField label="Kind" value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="PERCENT">Percentage of the fare</option>
                <option value="FIXED_PER_TRIP">Fixed amount per trip</option>
                <option value="ZERO">No commission (promotion)</option>
              </SelectField>
              <SelectField label="Applies to" value={vehicleType} onChange={(e) => setVehicleType(e.target.value)}>
                <option value="">Every vehicle type</option>
                <option value="economy">Economy</option>
                <option value="comfort">Comfort</option>
                <option value="minivan">Minivan</option>
              </SelectField>
              {model === "PERCENT" ? (
                <>
                  <Field label="Rate (%)" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
                  <Field label="At least (ETB, optional)" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} />
                  <Field label="At most (ETB, optional)" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} />
                </>
              ) : model === "FIXED_PER_TRIP" ? <Field label="Per trip (ETB)" inputMode="decimal" value={fixed} onChange={(e) => setFixed(e.target.value)} /> : null}
            </>
          ) : (
            <>
              <SelectField label="Mode" value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="POSTPAID">Postpaid (may owe up to the limits)</option>
                <option value="PREPAID">Prepaid (must keep a minimum)</option>
              </SelectField>
              {mode === "PREPAID" ? <Field label="Minimum balance (ETB)" inputMode="decimal" value={prepaidMin} onChange={(e) => setPrepaidMin(e.target.value)} /> : (
                <>
                  <Field label="Warn when owing (ETB)" inputMode="decimal" value={warning} onChange={(e) => setWarning(e.target.value)} />
                  <Field label="Pause cash trips when owing (ETB)" inputMode="decimal" value={cashLimit} onChange={(e) => setCashLimit(e.target.value)} />
                  <Field label="Stop all trips when owing (ETB)" inputMode="decimal" value={hardLimit} onChange={(e) => setHardLimit(e.target.value)} />
                </>
              )}
              <Field label="Days to pay a due" inputMode="numeric" value={dueDays} onChange={(e) => setDueDays(e.target.value)} />
              <Field label="Minimum payment (% of the due)" inputMode="decimal" value={minPayment} onChange={(e) => setMinPayment(e.target.value)} />
              <Field label="Smallest payout (ETB)" inputMode="decimal" value={minPayout} onChange={(e) => setMinPayout(e.target.value)} />
              <Field label="VAT (%)" inputMode="decimal" value={vat} onChange={(e) => setVat(e.target.value)} />
              <SelectField label="VAT on" value={taxBasis} onChange={(e) => setTaxBasis(e.target.value)}>
                <option value="COMMISSION">The commission</option>
                <option value="FULL_FARE">The whole fare</option>
              </SelectField>
            </>
          )}
          <Field label="Takes effect (optional)" type="datetime-local" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} hint="Empty: as soon as it's approved" />
          <TextArea label="Why" value={reason} onChange={(e) => setReason(e.target.value)} hint="5+ characters; the approver sees it" />
          <button className="btn" disabled={propose.isPending || reason.trim().length < 5}>Propose</button>
        </form>
      )}
    </Drawer>
  );
}
