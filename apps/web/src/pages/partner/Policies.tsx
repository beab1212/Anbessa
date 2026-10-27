// Partner portal: a company account's ride policy (workflow 11 step 4). The corporate admin
// (corporate:manage_policies @ ORG) sets the allowed cars, days, hours, the most a ride may cost,
// the monthly budget and whether a trip purpose is required. trip-service checks every ride billed
// to the company against it when the ride is requested or scheduled; employees and coordinators
// see the rules read-only. trip-service GET / PUT /api/trips/corporate/:orgId/policy.

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { allowed, authCall } from "../../lib/api";
import { birr } from "../../lib/format";
import { toMinor } from "../../lib/money";
import { useClientConfig } from "../../lib/platform";
import { useSession } from "../../lib/session";
import { vehicleOptions } from "../../lib/trips";
import {
  DAY_SHORT, hhmmToMinutes, minutesToHhmm, policySummary, savePolicy, useCorporatePolicy, WEEK, type CorporatePolicy, type PolicyInput,
} from "../../lib/trips2";
import { Empty, Field, Notice, PageHead, Problem, Stat } from "../../components/ui";

interface OrgInfo { id: string; name: string; kind: "FLEET" | "CORPORATE"; cityId: string; status: string }

export const useOrgInfo = (orgId: string) =>
  useQuery({ queryKey: ["org", orgId], enabled: !!orgId, queryFn: () => authCall<OrgInfo>("partner", `/organization/get-full-organization?organizationId=${orgId}`) });

const etbText = (minor: number | null) => (minor === null ? "" : String(minor / 100));

export function CompanyPoliciesPage() {
  const { orgId = "" } = useParams();
  const { partner } = useSession();
  const p = partner.principal;
  const org = useOrgInfo(orgId);
  const mayEdit = allowed(p, "corporate:manage_policies", { orgId });
  const mayRead = mayEdit || allowed(p, "trip:bill_corporate", { orgId });
  const policy = useCorporatePolicy(orgId, mayRead);

  if (partner.loading || org.isLoading) return <p className="muted">Loading…</p>;
  if (org.error) return <div className="page"><Problem error={org.error} /></div>;
  const o = org.data!;
  const back = <p className="xs muted" style={{ margin: 0 }}><Link to={`/partner/org/${o.id}`}>{o.name}</Link> / ride policy</p>;
  if (o.kind !== "CORPORATE") return <div className="page stack">{back}<Empty title="Ride policies are for company accounts." /></div>;
  if (!mayRead) return <div className="page stack">{back}<Notice tone="error">You can't see this company's ride policy. Ask the company's admin.</Notice></div>;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      {back}
      <PageHead
        title="Ride policy"
        lede={`Every ride billed to ${o.name} is checked against these rules when it's booked. A ride that breaks one is refused with the reason, and the rider can pay personally instead. Times are Addis Ababa time.`}
      />
      <Problem error={policy.error} />
      {policy.isLoading ? <p className="muted">Loading…</p> : null}
      {policy.data ? (
        <>
          <div className="stats">
            <Stat
              label={`Spent in ${policy.data.month}`}
              value={birr(policy.data.spentThisMonthMinor)}
              sub={policy.data.monthlyBudgetMinor !== null ? `of ${birr(policy.data.monthlyBudgetMinor)} budget · rides and booked rides` : "rides and booked rides, no budget set"}
              alert={policy.data.monthlyBudgetMinor !== null && policy.data.spentThisMonthMinor >= policy.data.monthlyBudgetMinor * 0.9}
            />
          </div>
          {mayEdit ? <PolicyForm key={policy.data.updatedAt ?? "new"} orgId={orgId} cityId={o.cityId} policy={policy.data} /> : (
            <div className="card pad">
              <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>{policySummary(policy.data, birr).map((line) => <li key={line}>{line}</li>)}</ul>
              <p className="xs muted" style={{ margin: "0.75rem 0 0" }}>Only the company's admin can change the policy.</p>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function PolicyForm({ orgId, cityId, policy }: { orgId: string; cityId: string; policy: CorporatePolicy }) {
  const qc = useQueryClient();
  const config = useClientConfig();
  const choices = vehicleOptions(config, cityId);
  const [types, setTypes] = useState<string[]>(policy.allowedVehicleTypes);
  const [days, setDays] = useState<number[]>(policy.allowedDays);
  const [anyTime, setAnyTime] = useState(policy.startMinute === null);
  const [start, setStart] = useState(policy.startMinute !== null ? minutesToHhmm(policy.startMinute) : "06:00");
  const [end, setEnd] = useState(policy.endMinute !== null ? minutesToHhmm(policy.endMinute) : "22:00");
  const [maxFare, setMaxFare] = useState(etbText(policy.maxFareMinor));
  const [budget, setBudget] = useState(etbText(policy.monthlyBudgetMinor));
  const [purpose, setPurpose] = useState(policy.requirePurpose);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (body: PolicyInput) => savePolicy(orgId, body),
    onSuccess: () => {
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ["corporate-policy", orgId] });
    },
  });

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const startMin = anyTime ? null : hhmmToMinutes(start);
  const endMin = anyTime ? null : hhmmToMinutes(end);
  const fareMinor = maxFare.trim() ? toMinor(maxFare) : null;
  const budgetMinor = budget.trim() ? toMinor(budget) : null;
  const problem =
    !anyTime && (startMin === null || endMin === null) ? "Enter the hours as HH:MM."
      : !anyTime && startMin === endMin ? "The allowed hours can't start and end at the same time."
        : maxFare.trim() && !fareMinor ? "The most a ride may cost must be an amount in birr."
          : budget.trim() && !budgetMinor ? "The monthly budget must be an amount in birr."
            : null;
  const body: PolicyInput = {
    allowedVehicleTypes: types, allowedDays: days.length === 7 ? [] : days,
    startMinute: startMin, endMinute: endMin === 0 && startMin !== null ? 1440 : endMin,
    maxFareMinor: fareMinor ?? null, monthlyBudgetMinor: budgetMinor ?? null, requirePurpose: purpose,
  };

  return (
    <form className="card pad stack" style={{ gap: "1rem" }} onSubmit={(e) => { e.preventDefault(); setSaved(false); if (!problem) save.mutate(body); }}>
      <fieldset className="options">
        <legend className="label">Cars</legend>
        <p className="xs muted" style={{ margin: "0 0 0.4rem" }}>None ticked: any car the city offers.</p>
        {choices.map((c) => (
          <label key={c.code} className="option"><input type="checkbox" checked={types.includes(c.code)} onChange={() => setTypes(toggle(types, c.code))} /> <span>{c.name} <span className="muted small">· {c.seats}</span></span></label>
        ))}
      </fieldset>
      <fieldset className="options">
        <legend className="label">Days</legend>
        <p className="xs muted" style={{ margin: "0 0 0.4rem" }}>None or all ticked: every day.</p>
        <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap" }}>
          {WEEK.map((d) => <label key={d} className="option" style={{ margin: 0 }}><input type="checkbox" checked={days.includes(d)} onChange={() => setDays(toggle(days, d))} /> {DAY_SHORT[d]}</label>)}
        </div>
      </fieldset>
      <fieldset className="options">
        <legend className="label">Hours</legend>
        <label className="option"><input type="checkbox" checked={anyTime} onChange={(e) => setAnyTime(e.target.checked)} /> Any time of day</label>
        {!anyTime ? (
          <div className="row" style={{ gap: "0.75rem" }}>
            <Field label="From" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
            <Field label="Until" type="time" value={end} onChange={(e) => setEnd(e.target.value)} hint={startMin !== null && endMin !== null && startMin > endMin ? "Past midnight (e.g. night shifts)." : undefined} />
          </div>
        ) : null}
      </fieldset>
      <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap" }}>
        <Field label="Most a ride may cost (ETB)" inputMode="decimal" placeholder="no limit" value={maxFare} onChange={(e) => setMaxFare(e.target.value)} />
        <Field label="Monthly budget (ETB)" inputMode="decimal" placeholder="no limit" value={budget} onChange={(e) => setBudget(e.target.value)} hint="Rides billed this calendar month, plus rides booked ahead for it." />
      </div>
      <label className="option"><input type="checkbox" checked={purpose} onChange={(e) => setPurpose(e.target.checked)} /> Ask for a trip purpose or cost centre on every ride</label>
      {problem ? <div className="alert error" role="alert"><span>{problem}</span></div> : null}
      <Problem error={save.error} />
      {saved && !save.isPending ? <Notice tone="ok">Saved. New bookings follow it from now on; rides already booked or under way aren't affected.</Notice> : null}
      <div className="row" style={{ gap: "0.75rem" }}>
        <button className="btn" disabled={save.isPending || !!problem}>Save policy</button>
        {policy.updatedAt ? <span className="xs muted">Last changed {new Date(policy.updatedAt).toLocaleString("en-GB", { timeZone: "Africa/Addis_Ababa" })}</span> : <span className="xs muted">No policy yet: any ride is allowed.</span>}
      </div>
    </form>
  );
}
