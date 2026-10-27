// Promo codes (workflow 15 part D). Marketing creates a code as a draft and activates it; a budget
// above the threshold is activated by a finance manager instead (incentive:approve, not the
// creator). Riders enter the code at estimate time; the discount is counted when the trip completes.

import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { can } from "@ride-app/shared-authz";
import { birr, CITIES, CITY_NAMES, dayAndTime, shortId } from "../../lib/format";
import {
  budgetUse, describePromo, PROMO_CODE, PROMO_LABEL, PROMO_STATUSES, PROMO_VIEWERS, promosApi, promoTone,
  type Promo, type PromoInput, type PromoStatus,
} from "../../lib/marketing";
import { citiesWithAny, toMinor } from "../../lib/money";
import { useSession } from "../../lib/session";
import { Drawer, Empty, Field, Notice, PageHead, Pill, Problem, SelectField, TextArea } from "../../components/ui";
import { useStaffNames } from "../admin/Approvals";

const VEHICLE_TYPES = ["economy", "comfort", "minivan"];
const localInput = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function PromosPage() {
  const { staff } = useSession();
  const p = staff.principal;
  const cities = citiesWithAny(p, PROMO_VIEWERS, CITIES);
  const [params, setParams] = useSearchParams();
  const city = params.get("city") ?? "";
  const status = (params.get("status") ?? "") as PromoStatus | "";
  const [editing, setEditing] = useState<Promo | "new" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["promos", city, status],
    enabled: cities.length > 0,
    queryFn: () => promosApi.list({ cityId: city || undefined, status: status || undefined }),
  });
  const canCreate = cities.some((cityId) => can(p!, "promo:manage", { cityId }));
  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next);
  };

  if (!cities.length) return <div className="page"><PageHead title="Promo codes" /><Empty title="Nothing to show.">Your roles don't include promo:manage or incentive:approve.</Empty></div>;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Promo codes"
        lede={`One code per trip. The rider pays less; the driver's earning doesn't change. Budgets above ${birr(q.data?.approvalThresholdMinor ?? 1_000_000)} are activated by finance.`}
        right={canCreate ? <button className="btn" onClick={() => setEditing("new")}>New promo</button> : null}
      />
      <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap" }}>
        <SelectField label="City" value={city} onChange={(e) => setFilter("city", e.target.value)}>
          <option value="">All my cities</option>
          {cities.map((c) => <option key={c} value={c}>{CITY_NAMES[c] ?? c}</option>)}
        </SelectField>
        <SelectField label="Status" value={status} onChange={(e) => setFilter("status", e.target.value)}>
          <option value="">Any</option>
          {PROMO_STATUSES.map((s) => <option key={s} value={s}>{PROMO_LABEL[s]}</option>)}
        </SelectField>
      </div>
      <Problem error={q.error} />
      {q.isPending ? <p className="small muted">Loading promos…</p> : null}
      {q.data && q.data.promos.length === 0 ? <Empty title="No promos here yet." /> : null}
      {q.data?.promos.length ? (
        <section className="card">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Code</th><th>Discount</th><th>Where</th><th>When</th><th>Budget</th><th>Status</th></tr></thead>
              <tbody>
                {q.data.promos.map((x) => (
                  <tr key={x.id} onClick={() => setOpen(x.id)} style={{ cursor: "pointer" }}>
                    <td><strong className="mono">{x.code}</strong><div className="xs muted">{x.name}</div></td>
                    <td className="small">{describePromo(x, birr)}<div className="xs muted">{x.perUserLimit}× per rider{x.maxRedemptions ? ` · ${x.maxRedemptions} in total` : ""}</div></td>
                    <td className="small">{x.cityIds.length ? x.cityIds.map((c) => CITY_NAMES[c] ?? c).join(", ") : "every city"}<div className="xs muted">{x.vehicleTypes.length ? x.vehicleTypes.join(", ") : "every vehicle type"}</div></td>
                    <td className="small">{dayAndTime(x.startsAt)}<div className="xs muted">until {dayAndTime(x.endsAt)}</div></td>
                    <td className="small">
                      <BudgetBar promo={x} />
                      <div className="xs muted">{birr(x.spentMinor)} of {birr(x.budgetMinor)} · {x.redemptionCount} trips</div>
                    </td>
                    <td><Pill tone={promoTone(x.status)}>{PROMO_LABEL[x.status]}</Pill>{x.status === "DRAFT" && x.needsFinanceApproval ? <div className="xs muted">needs finance</div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {editing ? <PromoForm promo={editing === "new" ? null : editing} cities={cities.filter((c) => can(p!, "promo:manage", { cityId: c }))} onClose={() => setEditing(null)} /> : null}
      {open ? <PromoDrawer id={open} onClose={() => setOpen(null)} onEdit={(x) => { setOpen(null); setEditing(x); }} /> : null}
    </div>
  );
}

function BudgetBar({ promo }: { promo: Promo }) {
  const used = budgetUse(promo);
  const spent = promo.budgetMinor ? Math.min(1, promo.spentMinor / promo.budgetMinor) : 0;
  const color = used >= 0.8 ? "var(--red, #dc2626)" : "var(--accent, #d97706)";
  return (
    <div style={{ height: 6, borderRadius: 3, background: "var(--border, #e5e7eb)", overflow: "hidden", position: "relative", minWidth: 90 }} title={`${Math.round(used * 100)}% used or promised`}>
      <div style={{ position: "absolute", inset: 0, width: `${used * 100}%`, background: color, opacity: 0.35 }} />
      <div style={{ position: "absolute", inset: 0, width: `${spent * 100}%`, background: color }} />
    </div>
  );
}

function PromoDrawer({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (p: Promo) => void }) {
  const { staff } = useSession();
  const p = staff.principal;
  const name = useStaffNames();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["promo", id], queryFn: () => promosApi.get(id) });
  const red = useQuery({ queryKey: ["promo", id, "redemptions"], queryFn: () => promosApi.redemptions(id) });
  const act = useMutation({
    mutationFn: (a: "activate" | "pause" | "resume" | "archive") => promosApi.act(id, a),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["promo"] }).then(() => qc.invalidateQueries({ queryKey: ["promos"] })),
  });
  const x = q.data;
  const manage = !!x && !!p && (x.cityIds.length ? x.cityIds.every((cityId) => can(p, "promo:manage", { cityId })) : can(p, "promo:manage"));
  const approver = !!x && !!p && (x.cityIds.length ? x.cityIds.every((cityId) => can(p, "incentive:approve", { cityId })) : can(p, "incentive:approve"));
  const canActivate = !!x && x.status === "DRAFT" && (x.needsFinanceApproval ? approver && x.createdBy !== p?.userId : manage);

  return (
    <Drawer title={x ? <span className="mono">{x.code}</span> : "Promo"} onClose={onClose} wide>
      <Problem error={q.error ?? act.error} />
      {x ? (
        <div className="stack" style={{ gap: "0.75rem" }}>
          <div className="row" style={{ gap: "0.5rem" }}><Pill tone={promoTone(x.status)}>{PROMO_LABEL[x.status]}</Pill><strong>{x.name}</strong></div>
          {x.description ? <p className="small" style={{ margin: 0 }}>{x.description}</p> : null}
          <dl className="kv">
            <dt>Discount</dt><dd>{describePromo(x, birr)}</dd>
            <dt>Cities</dt><dd>{x.cityIds.length ? x.cityIds.map((c) => CITY_NAMES[c] ?? c).join(", ") : "every city"}</dd>
            <dt>Vehicle types</dt><dd>{x.vehicleTypes.length ? x.vehicleTypes.join(", ") : "all"}</dd>
            <dt>Valid</dt><dd>{dayAndTime(x.startsAt)} → {dayAndTime(x.endsAt)}</dd>
            <dt>Limits</dt><dd>{x.perUserLimit}× per rider{x.maxRedemptions ? `, ${x.maxRedemptions} trips in total` : ""}</dd>
            <dt>Budget</dt><dd><BudgetBar promo={x} /><span className="small">{birr(x.spentMinor)} spent{x.bookedMinor ? `, ${birr(x.bookedMinor)} promised on ${x.bookedCount} booked trips` : ""}, of {birr(x.budgetMinor)} ({x.fundedBy === "PLATFORM" ? "platform" : "partner"} funded)</span></dd>
            <dt>Created</dt><dd>{name(x.createdBy)} · {dayAndTime(x.createdAt)}</dd>
            {x.activatedBy ? <><dt>Activated</dt><dd>{name(x.activatedBy)} · {dayAndTime(x.activatedAt)}</dd></> : null}
          </dl>
          {x.status === "DRAFT" && x.needsFinanceApproval ? (
            <Notice>{x.createdBy === p?.userId ? "This budget needs a finance manager to activate it." : approver ? "Check the budget, then activate." : "Waiting for a finance manager to activate it."}</Notice>
          ) : null}
          <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
            {canActivate ? <button className="btn" disabled={act.isPending} onClick={() => act.mutate("activate")}>Activate</button> : null}
            {manage && x.status === "DRAFT" ? <button className="btn secondary" onClick={() => onEdit(x)}>Edit</button> : null}
            {manage && x.status === "ACTIVE" ? <button className="btn secondary" disabled={act.isPending} onClick={() => act.mutate("pause")}>Pause</button> : null}
            {manage && x.status === "PAUSED" ? <button className="btn secondary" disabled={act.isPending} onClick={() => act.mutate("resume")}>Resume</button> : null}
            {manage && ["DRAFT", "PAUSED", "EXPIRED", "EXHAUSTED"].includes(x.status) ? <button className="btn ghost" disabled={act.isPending} onClick={() => act.mutate("archive")}>Archive</button> : null}
          </div>
          <h3 style={{ margin: "0.5rem 0 0" }}>Redeemed trips</h3>
          <Problem error={red.error} />
          {red.data?.redemptions.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>When</th><th>Trip</th><th>Fare</th><th>Discount</th></tr></thead>
                <tbody>
                  {red.data.redemptions.map((r) => (
                    <tr key={r.id}>
                      <td className="small">{dayAndTime(r.redeemedAt)}</td>
                      <td className="mono small">{shortId(r.tripId)}</td>
                      <td className="mono small">{birr(r.fareMinor)}</td>
                      <td className="mono small">{birr(r.discountMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="small muted" style={{ margin: 0 }}>None yet.</p>}
        </div>
      ) : <p className="small muted">Loading…</p>}
    </Drawer>
  );
}

function PromoForm({ promo, cities, onClose }: { promo: Promo | null; cities: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [now] = useState(() => Date.now());
  const [code, setCode] = useState(promo?.code ?? "");
  const [name, setName] = useState(promo?.name ?? "");
  const [description, setDescription] = useState(promo?.description ?? "");
  const [type, setType] = useState<Promo["type"]>(promo?.type ?? "PERCENT_OFF");
  const [percent, setPercent] = useState(String(promo?.percentOff ?? 20));
  const [amount, setAmount] = useState(promo?.amountOffMinor ? String(promo.amountOffMinor / 100) : "50");
  const [cap, setCap] = useState(promo?.maxDiscountMinor ? String(promo.maxDiscountMinor / 100) : "100");
  const [cityIds, setCityIds] = useState<string[]>(promo?.cityIds ?? (cities[0] ? [cities[0]] : []));
  const [vehicleTypes, setVehicleTypes] = useState<string[]>(promo?.vehicleTypes ?? []);
  const [startsAt, setStartsAt] = useState(localInput(promo?.startsAt ?? new Date(now).toISOString()));
  const [endsAt, setEndsAt] = useState(localInput(promo?.endsAt ?? new Date(now + 14 * 86_400_000).toISOString()));
  const [perUser, setPerUser] = useState(String(promo?.perUserLimit ?? 1));
  const [maxRedemptions, setMaxRedemptions] = useState(promo?.maxRedemptions ? String(promo.maxRedemptions) : "");
  const [budget, setBudget] = useState(promo ? String(promo.budgetMinor / 100) : "5000");
  const [fundedBy, setFundedBy] = useState<Promo["fundedBy"]>(promo?.fundedBy ?? "PLATFORM");

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const input: PromoInput = {
    code: code.trim().toUpperCase(), name: name.trim(), description: description.trim() || null, type,
    percentOff: type === "PERCENT_OFF" ? Number(percent) : null,
    amountOffMinor: type === "AMOUNT_OFF" ? toMinor(amount) : null,
    maxDiscountMinor: type === "PERCENT_OFF" && cap.trim() ? toMinor(cap) : null,
    cityIds, vehicleTypes, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(),
    perUserLimit: Number(perUser), maxRedemptions: maxRedemptions.trim() ? Number(maxRedemptions) : null,
    budgetMinor: toMinor(budget) ?? 0, fundedBy,
  };
  const valid = PROMO_CODE.test(code.trim()) && input.name && cityIds.length > 0 && input.budgetMinor > 0
    && (type === "PERCENT_OFF" ? input.percentOff! >= 1 && input.percentOff! <= 100 : (input.amountOffMinor ?? 0) > 0)
    && new Date(endsAt).getTime() > new Date(startsAt).getTime() && Number(perUser) >= 1;
  const save = useMutation({
    mutationFn: () => (promo ? promosApi.update(promo.id, input) : promosApi.create(input)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["promos"] });
      void qc.invalidateQueries({ queryKey: ["promo"] });
      onClose();
    },
  });

  return (
    <Drawer title={promo ? `Edit ${promo.code}` : "New promo"} onClose={onClose} wide>
      <div className="stack" style={{ gap: "0.75rem" }}>
        <div className="two-col">
          <Field label="Code" value={code} maxLength={32} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="MESKEL20" hint="3–32 letters, digits, _ or -" />
          <Field label="Name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Meskel weekend" />
        </div>
        <TextArea label="Description (optional)" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="two-col">
          <SelectField label="Discount" value={type} onChange={(e) => setType(e.target.value as Promo["type"])}>
            <option value="PERCENT_OFF">Percent off</option>
            <option value="AMOUNT_OFF">Fixed amount off</option>
          </SelectField>
          {type === "PERCENT_OFF"
            ? <Field label="Percent" inputMode="numeric" value={percent} onChange={(e) => setPercent(e.target.value)} />
            : <Field label="Amount (birr)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </div>
        {type === "PERCENT_OFF" ? <Field label="At most per trip (birr, optional)" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} /> : null}
        <div className="field">
          <span className="label">Cities</span>
          <div className="chips">{cities.map((c) => <button key={c} type="button" className="chip" aria-pressed={cityIds.includes(c)} onClick={() => setCityIds(toggle(cityIds, c))}>{CITY_NAMES[c] ?? c}</button>)}</div>
        </div>
        <div className="field">
          <span className="label">Vehicle types (none = all)</span>
          <div className="chips">{VEHICLE_TYPES.map((v) => <button key={v} type="button" className="chip" aria-pressed={vehicleTypes.includes(v)} onClick={() => setVehicleTypes(toggle(vehicleTypes, v))}>{v}</button>)}</div>
        </div>
        <div className="two-col">
          <Field label="Starts" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          <Field label="Ends" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </div>
        <div className="two-col">
          <Field label="Uses per rider" inputMode="numeric" value={perUser} onChange={(e) => setPerUser(e.target.value)} />
          <Field label="Trips in total (optional)" inputMode="numeric" value={maxRedemptions} onChange={(e) => setMaxRedemptions(e.target.value)} />
        </div>
        <div className="two-col">
          <Field label="Budget (birr)" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} hint="The code stops when discounts reach it." />
          <SelectField label="Funded by" value={fundedBy} onChange={(e) => setFundedBy(e.target.value as Promo["fundedBy"])}>
            <option value="PLATFORM">Anbessa</option>
            <option value="PARTNER">A partner</option>
          </SelectField>
        </div>
        <Problem error={save.error} />
        <div className="row" style={{ gap: "0.5rem" }}>
          <button className="btn" disabled={!valid || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : promo ? "Save draft" : "Create draft"}</button>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Drawer>
  );
}
