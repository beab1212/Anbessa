// Live settings (platform-service): what each one does, its value everywhere and per city, and a
// typed editor. Ordinary changes apply within seconds; sensitive ones (★) wait for a second
// super admin under Approvals. Every change keeps who, when and why.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, RotateCcw } from "lucide-react";
import type { SettingDef } from "@ride-app/shared-settings";
import { allowed, api } from "../../lib/api";
import { showValue, type SettingsOverview } from "../../lib/admin";
import { CITY_NAMES, dayAndTime } from "../../lib/format";
import { useSession } from "../../lib/session";
import { Drawer, Notice, PageHead, Pill, Problem } from "../../components/ui";
import { useStaffNames } from "./Approvals";

export function SettingsPage() {
  const { staff } = useSession();
  const q = useQuery({ queryKey: ["admin-settings"], queryFn: () => api<SettingsOverview>("staff", "/api/platform/settings") });
  const [group, setGroup] = useState<string | null>(null);
  const [history, setHistory] = useState<SettingDef | null>(null);
  const canChange = allowed(staff.principal, "settings:propose");

  if (q.isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (q.error) return <div className="page"><Problem error={q.error} /></div>;
  const s = q.data!;
  const current = group ?? s.groups[0]!;
  const defs = s.definitions.filter((d) => d.group === current);

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead title="Settings" lede={<>How the platform behaves, changed live without a release. ★ changes need a second super admin. Version <span className="mono">{s.version}</span>.</>} />
      <div className="tabs" role="tablist" style={{ flexWrap: "wrap" }}>
        {s.groups.map((g) => (
          <button key={g} role="tab" aria-selected={current === g} onClick={() => setGroup(g)}>{g}</button>
        ))}
      </div>
      <div className="stack" style={{ gap: "0.75rem" }}>
        {defs.map((d) => <SettingRow key={d.key} def={d} s={s} canChange={canChange} onHistory={() => setHistory(d)} />)}
      </div>
      {history ? <HistoryDrawer def={history} onClose={() => setHistory(null)} /> : null}
    </div>
  );
}

function SettingRow({ def, s, canChange, onHistory }: { def: SettingDef; s: SettingsOverview; canChange: boolean; onHistory: () => void }) {
  const overrides = Object.entries(s.cities).filter(([, v]) => def.key in v).map(([cityId, v]) => ({ cityId, value: v[def.key] }));
  const pending = s.pending.filter((c) => c.key === def.key);
  const [editing, setEditing] = useState<{ cityId: string | null } | null>(null);
  const isSet = def.key in s.global;
  return (
    <section className="card pad">
      <div className="row between" style={{ alignItems: "flex-start", gap: "1rem" }}>
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: "0.5rem" }}>
            <strong>{def.label}</strong>
            {def.sensitive ? <Pill tone="amber">★ needs approval</Pill> : null}
            {def.scope === "city" ? <Pill tone="blue">per city</Pill> : null}
          </div>
          <p className="small muted" style={{ margin: "0.2rem 0 0" }}>{def.description}</p>
        </div>
        <div className="row" style={{ gap: "0.4rem", flexShrink: 0 }}>
          <button className="icon-btn" title="History" aria-label={`History of ${def.label}`} onClick={onHistory}><History /></button>
        </div>
      </div>
      <dl className="kv" style={{ marginTop: "0.75rem" }}>
        <dt>{def.scope === "city" ? "Everywhere" : "Value"}</dt>
        <dd>
          <strong>{showValue(def, isSet ? s.global[def.key] : def.default)}</strong>
          {!isSet ? <span className="xs muted"> (default)</span> : null}
          {canChange ? <button className="link" style={{ marginLeft: "0.75rem" }} onClick={() => setEditing({ cityId: null })}>change</button> : null}
        </dd>
        {overrides.map((o) => (
          <OverrideRow key={o.cityId} def={def} cityId={o.cityId} value={o.value} canChange={canChange} onEdit={() => setEditing({ cityId: o.cityId })} />
        ))}
      </dl>
      {def.scope === "city" && canChange ? (
        <select className="select" style={{ marginTop: "0.5rem", maxWidth: "16rem" }} value="" onChange={(e) => e.target.value && setEditing({ cityId: e.target.value })} aria-label={`Set ${def.label} for a city`}>
          <option value="">Set a different value for a city…</option>
          {s.cityList.filter((c) => !overrides.some((o) => o.cityId === c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      ) : null}
      {pending.map((c) => (
        <Notice key={c.id}>Waiting for approval: {c.cityId ? `${CITY_NAMES[c.cityId] ?? c.cityId}: ` : ""}{showValue(def, c.value)} (“{c.reason}”)</Notice>
      ))}
      {editing ? <EditSetting def={def} cityId={editing.cityId} s={s} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}

function OverrideRow({ def, cityId, value, canChange, onEdit }: { def: SettingDef; cityId: string; value: unknown; canChange: boolean; onEdit: () => void }) {
  return (
    <>
      <dt>{CITY_NAMES[cityId] ?? cityId}</dt>
      <dd>
        <strong>{showValue(def, value)}</strong>
        {canChange ? <button className="link" style={{ marginLeft: "0.75rem" }} onClick={onEdit}>change</button> : null}
      </dd>
    </>
  );
}

/** A typed input for one setting value. */
function ValueInput({ def, value, onChange }: { def: SettingDef; value: unknown; onChange: (v: unknown) => void }) {
  switch (def.type) {
    case "bool":
      return (
        <div className="options">
          {[true, false].map((b) => (
            <label key={String(b)} className="option"><input type="radio" checked={value === b} onChange={() => onChange(b)} /> {b ? "On" : "Off"}</label>
          ))}
        </div>
      );
    case "money":
      return (
        <div className="field">
          <label className="label" htmlFor="v">Birr</label>
          <input id="v" inputMode="decimal" value={typeof value === "number" ? value / 100 : ""} onChange={(e) => onChange(Math.round(Number(e.target.value) * 100))} />
          <span className="hint">{def.min !== undefined ? `${def.min / 100}–${(def.max ?? 0) / 100} birr` : ""}</span>
        </div>
      );
    case "int":
    case "number":
      return (
        <div className="field">
          <label className="label" htmlFor="v">{def.unit ?? "Value"}</label>
          <input id="v" inputMode="decimal" value={value === undefined || value === null ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
          <span className="hint">{def.min ?? "−∞"}–{def.max ?? "∞"}{def.unit ? ` ${def.unit}` : ""}</span>
        </div>
      );
    case "intList":
      return (
        <div className="field">
          <label className="label" htmlFor="v">Values, comma separated{def.unit ? ` (${def.unit})` : ""}</label>
          <input id="v" value={Array.isArray(value) ? value.join(", ") : ""} onChange={(e) => onChange(e.target.value.split(",").map((x) => x.trim()).filter(Boolean).map(Number))} />
          <span className="hint">each {def.min}–{def.max}</span>
        </div>
      );
    case "enumList": {
      const list = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="stack" style={{ gap: "0.4rem" }}>
          <span className="label">In this order</span>
          {list.map((v, i) => (
            <div key={v} className="row" style={{ gap: "0.5rem" }}>
              <span className="mono">{i + 1}. {v}</span>
              <button type="button" className="link" disabled={i === 0} onClick={() => onChange([...list.slice(0, i - 1), v, list[i - 1]!, ...list.slice(i + 1)])}>up</button>
              <button type="button" className="link danger" onClick={() => onChange(list.filter((x) => x !== v))}>remove</button>
            </div>
          ))}
          {def.options?.filter((o) => !list.includes(o)).map((o) => <button key={o} type="button" className="btn ghost sm" onClick={() => onChange([...list, o])}>Add {o}</button>)}
        </div>
      );
    }
    default:
      return (
        <div className="field">
          <label className="label" htmlFor="v">Text</label>
          {def.key === "maintenance.message"
            ? <textarea id="v" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />
            : <input id="v" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />}
        </div>
      );
  }
}

function EditSetting({ def, cityId, s, onClose }: { def: SettingDef; cityId: string | null; s: SettingsOverview; onClose: () => void }) {
  const qc = useQueryClient();
  const cityValue = cityId ? s.cities[cityId]?.[def.key] : undefined;
  const effective = cityValue ?? (def.key in s.global ? s.global[def.key] : def.default);
  const [value, setValue] = useState<unknown>(effective);
  const [reason, setReason] = useState("");
  const save = useMutation({
    mutationFn: (v: unknown) => api<{ status: string }>("staff", `/api/platform/settings/${def.key}`, { method: "PUT", body: { value: v, cityId, reason } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-settings"] });
      void qc.invalidateQueries({ queryKey: ["client-config"] });
      void qc.invalidateQueries({ queryKey: ["setting-changes"] });
    },
  });
  const done = save.isSuccess;
  const resettable = cityId ? cityValue !== undefined : def.key in s.global;
  return (
    <Drawer title={`${def.label}${cityId ? ` · ${CITY_NAMES[cityId] ?? cityId}` : ""}`} onClose={onClose}>
      {done ? (
        <div className="stack" style={{ gap: "0.75rem" }}>
          <Notice tone="ok">{save.data?.status === "PENDING_APPROVAL" ? "Sent for approval. It applies when another super admin approves it." : "Applied. Every service uses it within a few seconds."}</Notice>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
      ) : (
        <form className="stack" style={{ gap: "0.75rem" }} onSubmit={(e) => { e.preventDefault(); save.mutate(value); }}>
          <p className="small muted" style={{ margin: 0 }}>{def.description}</p>
          <Problem error={save.error} />
          <ValueInput def={def} value={value} onChange={setValue} />
          <div className="field">
            <label className="label" htmlFor="why">Why</label>
            <input id="why" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="It goes into the history and the audit log" />
          </div>
          {def.sensitive ? <Notice>This setting needs a second super admin: your change waits under Approvals.</Notice> : null}
          <div className="row" style={{ gap: "0.5rem" }}>
            <button className="btn" disabled={save.isPending || reason.trim().length < 5}>{def.sensitive ? "Send for approval" : "Apply"}</button>
            {resettable ? (
              <button type="button" className="btn ghost" disabled={save.isPending || reason.trim().length < 5} onClick={() => save.mutate(null)}>
                <RotateCcw /> {cityId ? "Use the value for everywhere" : "Back to the default"}
              </button>
            ) : null}
          </div>
        </form>
      )}
    </Drawer>
  );
}

function HistoryDrawer({ def, onClose }: { def: SettingDef; onClose: () => void }) {
  const name = useStaffNames();
  const q = useQuery({
    queryKey: ["settings-history", def.key],
    queryFn: () => api<{ history: { id: string; cityId: string | null; oldValue: unknown; newValue: unknown; changedBy: string; approvedBy: string | null; reason: string; at: string; version: number }[] }>("staff", `/api/platform/settings/history?key=${def.key}`).then((r) => r.history),
  });
  return (
    <Drawer title={`History · ${def.label}`} onClose={onClose}>
      <Problem error={q.error} />
      {q.data?.length === 0 ? <p className="muted small">Never changed: it has always been {showValue(def, def.default)}.</p> : null}
      <ul className="timeline">
        {q.data?.map((h) => (
          <li key={h.id} className="done">
            <span className="t">{dayAndTime(h.at)}</span>
            <span className="dot" />
            <span className="small">
              {h.cityId ? `${CITY_NAMES[h.cityId] ?? h.cityId}: ` : ""}{showValue(def, h.oldValue)} → <strong>{showValue(def, h.newValue)}</strong>
              <span className="muted"> · {name(h.changedBy)}{h.approvedBy ? `, approved by ${name(h.approvedBy)}` : ""} · “{h.reason}”</span>
            </span>
          </li>
        ))}
      </ul>
    </Drawer>
  );
}
