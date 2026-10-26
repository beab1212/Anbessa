// Staff and their roles (Auth.md §9.3): every staff account with its roles, sign-in health and last
// sign-in (access review), revoking a role (immediate), asking for a role (a second super admin
// approves, under Approvals) and creating staff accounts. Custom roles appear here once approved.

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, UserPlus, X } from "lucide-react";
import { grantableStaffRoles } from "@ride-app/shared-authz";
import { allowed, api } from "../../lib/api";
import { daysSince, type Approval, type UserRow } from "../../lib/admin";
import { CITIES, CITY_NAMES, dayAndTime } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { Drawer, Empty, Field, Notice, PageHead, Pill, Problem, SelectField, TextArea } from "../../components/ui";
import { roleChip } from "../admin/Users";

export function People() {
  const { staff } = useSession();
  const me = staff.principal!;
  const navigate = useNavigate();
  const canManage = allowed(me, "staff:manage");
  const canRequest = allowed(me, "role:request");
  const [creating, setCreating] = useState(false);
  const [asking, setAsking] = useState<UserRow | "pick" | null>(null);
  const [revoking, setRevoking] = useState<{ user: UserRow; role: UserRow["roles"][number] } | null>(null);
  const [q, setQ] = useState("");
  const list = useQuery({
    queryKey: ["admin-users", "staff", q],
    queryFn: () => api<{ users: UserRow[] }>("staff", `/api/identity/users?kind=staff&limit=100${q.trim().length >= 2 ? `&q=${encodeURIComponent(q.trim())}` : ""}`).then((r) => r.users),
  });
  const pending = useQuery({
    queryKey: ["approvals", "role:grant", "PENDING"],
    enabled: canRequest || allowed(me, "role:approve"),
    queryFn: () => api<{ approvals: Approval[] }>("staff", "/api/identity/approvals?status=PENDING&action=role:grant").then((r) => r.approvals),
  });
  const now = useNow(60_000);
  const idle = (list.data ?? []).filter((u) => u.roles.length && (daysSince(u.lastSignInAt, now) ?? 999) > 30);

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Staff and roles"
        lede="Every role needs two people: one asks, another approves. Removing a role takes effect at once."
        right={
          <>
            {canRequest ? <button className="btn secondary" onClick={() => setAsking("pick")}><Plus /> Ask for a role</button> : null}
            {canManage ? <button className="btn" onClick={() => setCreating(true)}><UserPlus /> New staff account</button> : null}
          </>
        }
      />
      {pending.data?.length ? <Notice>{pending.data.length} role request{pending.data.length > 1 ? "s" : ""} waiting · <Link to="/staff/admin/approvals">Approvals</Link></Notice> : null}
      {idle.length ? <Notice>Access review: {idle.length} staff with roles haven't signed in for over 30 days ({idle.map((u) => u.name).join(", ")}).</Notice> : null}
      <input className="input" style={{ maxWidth: "20rem" }} placeholder="Search staff" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search staff" />
      <Problem error={list.error} />
      {list.data?.length === 0 ? <Empty title="No staff match." /> : null}
      {list.data?.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Roles</th><th>Sign-in</th><th>Last sign-in</th><th /></tr></thead>
            <tbody>
              {list.data.map((u) => {
                const days = daysSince(u.lastSignInAt, now);
                return (
                  <tr key={u.id}>
                    <td>
                      <button className="link" style={{ fontWeight: 600 }} onClick={() => navigate(`/staff/admin/users/${u.id}`)}>{u.name}</button>
                      <div className="xs muted">{u.email}</div>
                      {u.status === "SUSPENDED" ? <Pill tone="red">suspended</Pill> : null}
                    </td>
                    <td>
                      <div className="row" style={{ gap: "0.35rem", flexWrap: "wrap" }}>
                        {u.roles.length === 0 ? <span className="xs muted">no roles</span> : null}
                        {u.roles.map((r) => (
                          <span key={`${r.role}-${r.cityId ?? ""}`} className="role-chip">
                            {roleChip(r)}
                            {canManage && u.id !== me.userId ? <button aria-label={`Remove ${r.label}`} title="Remove this role" onClick={() => setRevoking({ user: u, role: r })}><X /></button> : null}
                          </span>
                        ))}
                        {canRequest ? <button className="link xs" onClick={() => setAsking(u)}>+ role</button> : null}
                      </div>
                    </td>
                    <td>{u.twoFactorEnabled ? <Pill tone="green">authenticator</Pill> : <Pill tone="amber">setup not finished</Pill>}</td>
                    <td className="small">
                      {u.lastSignInAt ? dayAndTime(u.lastSignInAt) : <span className="muted">never</span>}
                      {u.roles.length && days !== null && days > 30 ? <div className="xs" style={{ color: "var(--warning)" }}>{days} days ago</div> : null}
                    </td>
                    <td />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {creating ? <CreateStaff onClose={() => setCreating(false)} /> : null}
      {asking ? <AskRole staff={list.data ?? []} preset={asking === "pick" ? null : asking} onClose={() => setAsking(null)} /> : null}
      {revoking ? <RevokeRole user={revoking.user} role={revoking.role} onClose={() => setRevoking(null)} /> : null}
    </div>
  );
}

function CreateStaff({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const create = useMutation({
    mutationFn: () => api<{ userId: string; email: string; temporaryPassword: string }>("staff", "/api/identity/staff-accounts", { body: { name: name.trim(), email: email.trim() } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin-users"] }),
  });
  return (
    <Drawer title="New staff account" onClose={onClose}>
      {create.data ? (
        <div className="stack" style={{ gap: "0.75rem" }}>
          <div className="handover">
            <div className="label">Give this to {create.data.email} in person. It's shown once.</div>
            <p className="secret">{create.data.temporaryPassword}</p>
            <p className="small">They get no roles until they change this password, add an authenticator, and a role is approved.</p>
          </div>
          <button className="btn secondary" onClick={onClose}>Done, hide it</button>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Problem error={create.error} />
          <Field label="Full name" required value={name} onChange={(e) => setName(e.target.value)} />
          <Field label="Work email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn" disabled={create.isPending}>Create account</button>
        </form>
      )}
    </Drawer>
  );
}

function AskRole({ staff, preset, onClose }: { staff: UserRow[]; preset: UserRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const roles = grantableStaffRoles();
  const [userId, setUserId] = useState(preset?.id ?? "");
  const [role, setRole] = useState(roles.find((r) => r.code === "DISPATCHER")?.code ?? roles[0]!.code);
  const [cityId, setCityId] = useState(CITIES[0]!);
  const [reason, setReason] = useState("");
  const info = roles.find((r) => r.code === role)!;
  const cityScoped = info.storage.type === "member";
  const ask = useMutation({
    mutationFn: () => api("staff", "/api/identity/staff-role-requests", { body: { userId, role, ...(cityScoped ? { cityId } : {}), reason: reason.trim() } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["approvals"] }),
  });
  return (
    <Drawer title="Ask for a role" onClose={onClose}>
      {ask.isSuccess ? (
        <div className="stack" style={{ gap: "0.75rem" }}>
          <Notice tone="ok">Requested. Another super admin approves it under Approvals.</Notice>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); ask.mutate(); }}>
          <Problem error={ask.error} />
          <SelectField label="For" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose a staff member…</option>
            {staff.filter((u) => u.status !== "SUSPENDED").map((u) => <option key={u.id} value={u.id}>{u.name} · {u.email}</option>)}
          </SelectField>
          <SelectField label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => <option key={r.code} value={r.code}>{r.label}{r.builtIn ? "" : " (custom)"}</option>)}
          </SelectField>
          {cityScoped ? (
            <SelectField label="City" value={cityId} onChange={(e) => setCityId(e.target.value)}>
              {CITIES.map((c) => <option key={c} value={c}>{CITY_NAMES[c] ?? c}</option>)}
            </SelectField>
          ) : <p className="small muted">This role works in every city.</p>}
          <TextArea label="Why" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="New hire for the Bole call center, starts Monday" hint="10+ characters" />
          <button className="btn" disabled={ask.isPending || !userId || reason.trim().length < 10}>Send for approval</button>
        </form>
      )}
    </Drawer>
  );
}

function RevokeRole({ user, role, onClose }: { user: UserRow; role: UserRow["roles"][number]; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const revoke = useMutation({
    mutationFn: () => api("staff", "/api/identity/staff-roles/revoke", { body: { userId: user.id, role: role.role, ...(role.cityId ? { cityId: role.cityId } : {}), reason: reason.trim() } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-users"] });
      onClose();
    },
  });
  return (
    <Drawer title={`Remove ${roleChip(role)} from ${user.name}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); revoke.mutate(); }}>
        <p className="small muted">Takes effect at once: their current access is refused and their next sign-in won't have the role.</p>
        <Problem error={revoke.error} />
        <TextArea label="Why" value={reason} onChange={(e) => setReason(e.target.value)} hint="10+ characters; it goes into the audit log" />
        <button className="btn danger" disabled={revoke.isPending || reason.trim().length < 10}>Remove the role</button>
      </form>
    </Drawer>
  );
}
