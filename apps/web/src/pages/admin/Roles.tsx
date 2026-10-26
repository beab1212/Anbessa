// Roles and permissions (Role.md §8): the live matrix, a role editor that proposes changes for a
// second super admin to approve, and custom roles. Guardrails are checked as you edit.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Plus } from "lucide-react";
import { PERMISSION_GROUPS, PERMISSIONS, permissionGroup, type AuthzSnapshot, type RoleInfo, type ScopeLetter } from "@ride-app/shared-authz";
import { allowed, api } from "../../lib/api";
import { ACTION_LABEL, SCOPE_WORD, type Approval } from "../../lib/admin";
import { useSession } from "../../lib/session";
import { Drawer, Field, Notice, PageHead, Pill, Problem, SelectField, TextArea } from "../../components/ui";

type Draft = Record<string, ScopeLetter | null>;

const audienceWord = (r: RoleInfo) => (r.audience === "ride-admin" ? (r.storage.type === "member" ? "staff · per city" : "staff · everywhere") : "riders and partners");

/** Scope letters a role may hold (guardrails: staff C/G — city roles C only — customers S/O). */
function lettersFor(r: RoleInfo): ScopeLetter[] {
  if (r.audience === "ride-app") return ["S", "O"];
  return r.storage.type === "member" ? ["C"] : ["C", "G"];
}

function useAuthz() {
  return useQuery({ queryKey: ["admin-authz"], queryFn: () => api<AuthzSnapshot>("staff", "/api/identity/authz") });
}

export function RolesPage() {
  const { staff } = useSession();
  const p = staff.principal;
  const authz = useAuthz();
  const pending = useQuery({
    queryKey: ["approvals", "authz:change", "PENDING"],
    queryFn: () => api<{ approvals: Approval[] }>("staff", "/api/identity/approvals?status=PENDING&action=authz:change").then((r) => r.approvals),
  });
  const [tab, setTab] = useState<"roles" | "matrix">("roles");
  const [selected, setSelected] = useState<string>("DISPATCHER");
  const [creating, setCreating] = useState(false);
  const canPropose = allowed(p, "authz:propose");

  if (authz.isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (authz.error) return <div className="page"><Problem error={authz.error} /></div>;
  const snap = authz.data!;
  const roles = snap.roles.filter((r) => !r.archived);
  const role = roles.find((r) => r.code === selected) ?? roles[0]!;
  const waiting = new Set((pending.data ?? []).map((a) => String(a.payload.roleCode)));

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Roles and permissions"
        lede={<>What each role may do, and where. Every change needs a second super admin, and every service applies it within seconds. Matrix version <span className="mono">{snap.version}</span>.</>}
        right={canPropose ? <button className="btn" onClick={() => setCreating(true)}><Plus /> New custom role</button> : null}
      />
      {pending.data?.length ? (
        <Notice>{pending.data.length} change{pending.data.length > 1 ? "s" : ""} waiting for approval: {pending.data.map((a) => String(a.payload.roleCode)).join(", ")}. Decide them under Approvals.</Notice>
      ) : null}
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "roles"} onClick={() => setTab("roles")}>Edit a role</button>
        <button role="tab" aria-selected={tab === "matrix"} onClick={() => setTab("matrix")}>Whole matrix</button>
      </div>

      {tab === "roles" ? (
        <div className="roles-layout">
          <nav className="card" aria-label="Roles">
            {(["Staff", "Riders and partners", "Custom"] as const).map((group) => {
              const list = roles.filter((r) => (group === "Custom" ? !r.builtIn : r.builtIn && (group === "Staff") === (r.audience === "ride-admin")));
              if (!list.length) return null;
              return (
                <div key={group} style={{ padding: "0.5rem 0" }}>
                  <div className="label" style={{ padding: "0.25rem 1rem" }}>{group}</div>
                  {list.map((r) => (
                    <button key={r.code} className={`role-item ${r.code === role.code ? "on" : ""}`} onClick={() => setSelected(r.code)}>
                      <span>{r.label}</span>
                      <span className="xs muted mono">{Object.keys(snap.matrix[r.code] ?? {}).length}</span>
                      {waiting.has(r.code) ? <Pill tone="amber">pending</Pill> : null}
                    </button>
                  ))}
                </div>
              );
            })}
          </nav>
          <RoleEditor key={`${role.code}-${snap.version}`} role={role} grants={snap.matrix[role.code] ?? {}} canPropose={canPropose && !waiting.has(role.code)} pendingHere={waiting.has(role.code)} />
        </div>
      ) : (
        <MatrixTable snap={snap} />
      )}

      {creating ? <NewRole onClose={() => setCreating(false)} onCreated={() => setCreating(false)} /> : null}
    </div>
  );
}

function RoleEditor({ role, grants, canPropose, pendingHere }: { role: RoleInfo; grants: Partial<Record<string, ScopeLetter>>; canPropose: boolean; pendingHere: boolean }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>({});
  const [filter, setFilter] = useState("");
  const [reason, setReason] = useState("");
  const [proposing, setProposing] = useState(false);
  const letters = lettersFor(role);
  const changes = Object.entries(draft).filter(([perm, v]) => (grants[perm] ?? null) !== v);
  const set = changes.map(([permission, scope]) => ({ permission, scope }));
  const preview = useQuery({
    queryKey: ["authz-preview", role.code, JSON.stringify(set)],
    enabled: set.length > 0,
    queryFn: () => api<{ problems: string[] }>("staff", "/api/identity/authz/preview", { body: { roleCode: role.code, set } }),
  });
  const propose = useMutation({
    mutationFn: () => api("staff", "/api/identity/authz/changes", { body: { roleCode: role.code, set, reason } }),
    onSuccess: () => {
      setDraft({});
      setReason("");
      setProposing(false);
      void qc.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
  const archive = useMutation({
    mutationFn: (why: string) => api("staff", "/api/identity/authz/changes", { body: { roleCode: role.code, set: [], archive: true, reason: why } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["approvals"] }),
  });

  const value = (perm: string): ScopeLetter | null => (perm in draft ? draft[perm]! : (grants[perm] ?? null));
  const visible = PERMISSIONS.filter((perm) => !filter || perm.includes(filter.toLowerCase()) || permissionGroup(perm).toLowerCase().includes(filter.toLowerCase()));

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 style={{ marginBottom: "0.15rem" }}>{role.label} <span className="mono xs muted">{role.code}</span></h2>
          <div className="xs muted">{audienceWord(role)}{role.description ? ` · ${role.description}` : ""}</div>
        </div>
        <div className="row" style={{ gap: "0.5rem" }}>
          {!role.builtIn && canPropose ? (
            <button className="btn ghost sm" disabled={archive.isPending} onClick={() => {
              const why = prompt(`Why archive ${role.label}? (10+ characters)`);
              if (why && why.trim().length >= 10) archive.mutate(why.trim());
            }}><Archive /> Archive</button>
          ) : null}
          {canPropose ? <button className="btn" disabled={set.length === 0 || (preview.data?.problems.length ?? 0) > 0} onClick={() => setProposing(true)}>Propose {set.length || ""} change{set.length === 1 ? "" : "s"}</button> : null}
        </div>
      </div>
      <div className="card-body stack" style={{ gap: "0.75rem" }}>
        <Problem error={archive.error} />
        {archive.isSuccess ? <Notice tone="ok">Archiving sent for approval.</Notice> : null}
        {pendingHere ? <Notice>A change to this role is waiting for approval; edit again after it's decided.</Notice> : null}
        {preview.data?.problems.length ? <Notice tone="error">{preview.data.problems.join(" · ")}</Notice> : null}
        <input className="input" placeholder="Filter permissions (e.g. trip, refund, Money)" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter permissions" />
        {PERMISSION_GROUPS.map((g) => {
          const perms = visible.filter((perm) => permissionGroup(perm) === g.name);
          if (!perms.length) return null;
          return (
            <div key={g.name}>
              <div className="label" style={{ margin: "0.4rem 0" }}>{g.name}</div>
              <div className="perm-grid">
                {perms.map((perm) => {
                  const v = value(perm);
                  const changed = perm in draft && (grants[perm] ?? null) !== draft[perm];
                  return (
                    <label key={perm} className={`perm ${v ? "on" : ""} ${changed ? "changed" : ""}`}>
                      <input type="checkbox" checked={!!v} disabled={!canPropose}
                        onChange={(e) => setDraft((d) => ({ ...d, [perm]: e.target.checked ? (grants[perm] ?? letters.at(-1)!) : null }))} />
                      <span className="mono small">{perm}</span>
                      {v && letters.length > 1 ? (
                        <select value={v} disabled={!canPropose} onChange={(e) => setDraft((d) => ({ ...d, [perm]: e.target.value as ScopeLetter }))} aria-label={`${perm} scope`}>
                          {letters.map((l) => <option key={l} value={l}>{SCOPE_WORD[l]}</option>)}
                        </select>
                      ) : v ? <span className="xs muted">{SCOPE_WORD[v]}</span> : null}
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {proposing ? (
        <Drawer title={`Propose changes to ${role.label}`} onClose={() => setProposing(false)}>
          <form className="stack" style={{ gap: "0.75rem" }} onSubmit={(e) => { e.preventDefault(); propose.mutate(); }}>
            <Problem error={propose.error} />
            <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: "0.3rem" }}>
              {set.map((c) => (
                <li key={c.permission} className="small">
                  {c.scope ? <Pill tone="green">add</Pill> : <Pill tone="red">remove</Pill>} <span className="mono">{c.permission}</span>
                  {c.scope ? <span className="muted"> · {SCOPE_WORD[c.scope]}</span> : null}
                  {grants[c.permission] && c.scope ? <span className="xs muted"> (was {SCOPE_WORD[grants[c.permission]!]})</span> : null}
                </li>
              ))}
            </ul>
            <TextArea label="Why" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. dispatchers no longer cancel; support handles it" hint="10+ characters. The approver and the audit log see this." />
            <button className="btn" disabled={propose.isPending || reason.trim().length < 10}>Send for approval</button>
          </form>
        </Drawer>
      ) : null}
    </section>
  );
}

function MatrixTable({ snap }: { snap: AuthzSnapshot }) {
  const [who, setWho] = useState<"staff" | "partners">("staff");
  const roles = snap.roles.filter((r) => !r.archived && (who === "staff") === (r.audience === "ride-admin"));
  const perms = PERMISSIONS.filter((perm) => roles.some((r) => snap.matrix[r.code]?.[perm]));
  return (
    <div className="stack" style={{ gap: "0.75rem" }}>
      <div className="chips">
        <button className="chip" aria-pressed={who === "staff"} onClick={() => setWho("staff")}>Staff roles</button>
        <button className="chip" aria-pressed={who === "partners"} onClick={() => setWho("partners")}>Riders and partners</button>
      </div>
      <div className="table-wrap matrix">
        <table className="table">
          <thead>
            <tr><th>Permission</th>{roles.map((r) => <th key={r.code} title={r.code}><span className="vertical">{r.label}</span></th>)}</tr>
          </thead>
          <tbody>
            {perms.map((perm) => (
              <tr key={perm}>
                <td className="mono xs">{perm}</td>
                {roles.map((r) => {
                  const l = snap.matrix[r.code]?.[perm];
                  return <td key={r.code} className={`num ${l ? "cell-on" : ""}`} title={l ? SCOPE_WORD[l] : ""}>{l ?? ""}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="xs muted">S own · O organisation · C city · G everywhere.</p>
    </div>
  );
}

function NewRole({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [storage, setStorage] = useState<"city" | "global">("city");
  const [perms, setPerms] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [filter, setFilter] = useState("");
  const letter: ScopeLetter = storage === "city" ? "C" : "G";
  const create = useMutation({
    mutationFn: () => api("staff", "/api/identity/authz/changes", {
      body: { create: { label, ...(description ? { description } : {}), storage }, set: perms.map((permission) => ({ permission, scope: letter })), reason },
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["approvals"] });
      onCreated();
    },
  });
  const shown = useMemo(() => PERMISSIONS.filter((p) => !filter || p.includes(filter.toLowerCase())), [filter]);
  return (
    <Drawer title="New custom role" onClose={onClose} wide>
      <form className="stack" style={{ gap: "0.75rem" }} onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Problem error={create.error} />
        <p className="small muted" style={{ margin: 0 }}>Custom roles are staff roles. After a second super admin approves, you grant it to people under Staff and roles, like any other.</p>
        <div className="two-col">
          <Field label="Name" required value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Quality review" />
          <SelectField label="Works" value={storage} onChange={(e) => setStorage(e.target.value as "city" | "global")}>
            <option value="city">in one city (granted per city)</option>
            <option value="global">everywhere</option>
          </SelectField>
        </div>
        <Field label="What it's for (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
        <input className="input" placeholder="Filter permissions" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter permissions" />
        <div className="perm-grid" style={{ maxHeight: "40vh", overflowY: "auto" }}>
          {shown.map((perm) => (
            <label key={perm} className={`perm ${perms.includes(perm) ? "on" : ""}`}>
              <input type="checkbox" checked={perms.includes(perm)} onChange={(e) => setPerms((x) => (e.target.checked ? [...x, perm] : x.filter((p) => p !== perm)))} />
              <span className="mono small">{perm}</span>
            </label>
          ))}
        </div>
        <TextArea label="Why" value={reason} onChange={(e) => setReason(e.target.value)} hint="10+ characters" />
        <button className="btn" disabled={create.isPending || label.trim().length < 3 || reason.trim().length < 10}>Send for approval</button>
      </form>
    </Drawer>
  );
}

/** One approval request in words (used by the Approvals inbox). */
export function describeApproval(a: Approval) {
  const p = a.payload;
  if (a.action === "authz:change") {
    const set = (p.set as { permission: string; scope: string | null }[]) ?? [];
    const create = p.create as { label: string; storage: string } | undefined;
    return [
      create ? `create ${create.label} (${create.storage === "city" ? "per city" : "everywhere"})` : `role ${String(p.roleCode)}`,
      p.archive ? "archive it" : null,
      ...set.map((s) => (s.scope ? `+ ${s.permission} (${SCOPE_WORD[s.scope]})` : `− ${s.permission}`)),
    ].filter(Boolean).join(" · ");
  }
  return ACTION_LABEL[a.action] ?? a.action;
}
