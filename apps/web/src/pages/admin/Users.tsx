// Every account: riders, drivers, partners, guests and staff. Search, then open one person to see
// their roles, organisations and sessions, sign them out everywhere, suspend or reinstate, reset a
// staff member's authenticator, and read what they did (audit log).

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, KeyRound, LogOut, Search, ShieldOff, ShieldCheck } from "lucide-react";
import { allowed, api } from "../../lib/api";
import { daysSince, type AuditEntry, type UserDetail, type UserRow } from "../../lib/admin";
import { CITIES, CITY_NAMES, dayAndTime } from "../../lib/format";
import { useSession } from "../../lib/session";
import { Drawer, Empty, Notice, PageHead, Pill, Problem, SelectField, TextArea } from "../../components/ui";

type Kind = "" | "staff" | "rider" | "driver" | "partner" | "guest";

export const statusPill = (s: string) =>
  s === "SUSPENDED" ? <Pill tone="red">suspended</Pill> : s === "GUEST" ? <Pill tone="grey">guest</Pill> : <Pill tone="green">active</Pill>;

export const roleChip = (r: { role: string; label: string; cityId?: string; scope: string }) =>
  `${r.label}${r.cityId ? ` · ${CITY_NAMES[r.cityId] ?? r.cityId}` : r.scope === "GLOBAL" ? " · everywhere" : ""}`;

export function UsersPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind>("");
  const [status, setStatus] = useState<"" | "active" | "suspended">("");
  const [cursor, setCursor] = useState<string[]>([]);
  const params = new URLSearchParams({ ...(q.trim().length >= 2 ? { q: q.trim() } : {}), ...(kind ? { kind } : {}), ...(status ? { status } : {}), ...(cursor.at(-1) ? { cursor: cursor.at(-1)! } : {}) });
  const list = useQuery({
    queryKey: ["admin-users", params.toString()],
    queryFn: () => api<{ users: UserRow[]; next: string | null }>("staff", `/api/identity/users?${params}`),
  });
  const reset = () => setCursor([]);

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead title="Users" lede="Everyone with an Anbessa account. Phone numbers are masked unless your role may see personal data." />
      <div className="row between" style={{ flexWrap: "wrap", gap: "0.75rem" }}>
        <div className="chips">
          {([["", "Everyone"], ["rider", "Riders"], ["driver", "Drivers"], ["partner", "Partners"], ["guest", "Guests"], ["staff", "Staff"]] as const).map(([k, label]) => (
            <button key={k} className="chip" aria-pressed={kind === k} onClick={() => { setKind(k); reset(); }}>{label}</button>
          ))}
          <button className="chip" aria-pressed={status === "suspended"} onClick={() => { setStatus(status === "suspended" ? "" : "suspended"); reset(); }}>Suspended only</button>
        </div>
        <div className="row" style={{ gap: "0.5rem" }}>
          <Search size={16} className="muted" />
          <input className="input" style={{ maxWidth: "18rem" }} placeholder="Name, email, last digits of a phone, or id" value={q} onChange={(e) => { setQ(e.target.value); reset(); }} aria-label="Search users" />
        </div>
      </div>
      <Problem error={list.error} />
      {list.data && list.data.users.length === 0 ? <Empty title="Nobody matches." /> : null}
      {list.data?.users.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Contact</th><th>Roles</th><th>Status</th><th>Joined</th><th>Last sign-in</th><th /></tr></thead>
            <tbody>
              {list.data.users.map((u) => (
                <tr key={u.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/staff/admin/users/${u.id}`)}>
                  <td><strong>{u.name}</strong>{u.staff ? <> <Pill tone="blue">staff</Pill></> : null}</td>
                  <td className="mono small">{u.email ?? u.phone ?? "—"}</td>
                  <td className="small">{u.roles.length ? u.roles.map(roleChip).join(", ") : <span className="muted">none</span>}</td>
                  <td>{statusPill(u.status)}{u.staff && !u.twoFactorEnabled ? <div className="xs" style={{ color: "var(--warning)" }}>no authenticator yet</div> : null}</td>
                  <td className="small">{dayAndTime(u.createdAt)}</td>
                  <td className="small">{u.lastSignInAt ? dayAndTime(u.lastSignInAt) : <span className="muted">never</span>}</td>
                  <td className="num"><ChevronRight size={16} className="muted" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="row" style={{ gap: "0.5rem" }}>
        {cursor.length ? <button className="btn ghost sm" onClick={() => setCursor((c) => c.slice(0, -1))}>Newer</button> : null}
        {list.data?.next ? <button className="btn ghost sm" onClick={() => setCursor((c) => [...c, list.data!.next!])}>Older</button> : null}
      </div>
    </div>
  );
}

/** What someone did, and what was done to them (audit-service). */
export function AuditTrail({ actorId, resourceId, hideActor }: { actorId?: string; resourceId?: string; hideActor?: string }) {
  const { staff } = useSession();
  const can = allowed(staff.principal, "audit_log:read");
  const params = new URLSearchParams({ ...(actorId ? { actorId } : {}), ...(resourceId ? { resourceId } : {}), limit: "20" });
  const q = useQuery({ queryKey: ["audit", params.toString()], enabled: can, queryFn: () => api<{ entries: AuditEntry[] }>("staff", `/api/audit/entries?${params}`).then((r) => r.entries) });
  if (!can) return null;
  return (
    <>
      <Problem error={q.error} />
      {q.data && q.data.filter((e) => e.actorId !== hideActor).length === 0 ? <p className="small muted" style={{ margin: 0 }}>Nothing recorded yet.</p> : null}
      <ul className="timeline">
        {q.data?.filter((e) => e.actorId !== hideActor).map((e) => (
          <li key={e.eventId} className="done">
            <span className="t">{dayAndTime(e.at)}</span>
            <span className="dot" />
            <span className="small audit-line" title={e.reason ?? ""}><span className="mono">{e.action}</span> <span className="muted">· {e.resourceType} · {e.service ?? ""}{e.reason ? ` · ${e.reason}` : ""}</span></span>
          </li>
        ))}
      </ul>
    </>
  );
}

export function UserPage() {
  const { id } = useParams();
  const { staff } = useSession();
  const p = staff.principal;
  const qc = useQueryClient();
  const user = useQuery({ queryKey: ["admin-user", id], queryFn: () => api<UserDetail>("staff", `/api/identity/users/${id}`) });
  const [dialog, setDialog] = useState<"signout" | "suspend" | "reinstate" | "mfa" | null>(null);

  if (user.isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (user.error) return <div className="page"><Problem error={user.error} /></div>;
  const u = user.data!;
  const me = u.id === p?.userId;
  const staffTarget = u.staff;
  const canSuspend = !me && (staffTarget ? allowed(p, "staff:manage") : CITIES.some((c) => allowed(p, "user:suspend", { cityId: c })));
  const canReinstate = staffTarget ? allowed(p, "staff:manage") : CITIES.some((c) => allowed(p, "user:reinstate", { cityId: c }));
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["admin-user", id] });
    void qc.invalidateQueries({ queryKey: ["admin-users"] });
    void qc.invalidateQueries({ queryKey: ["audit"] });
  };
  const idle = daysSince(u.sessions[0]?.createdAt ?? null);

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <p className="xs muted" style={{ margin: 0 }}><Link to="/staff/admin/users">Users</Link> / {u.name}</p>
      <div className="page-head">
        <div>
          <h1 className="row" style={{ gap: "0.6rem" }}>{u.name} {statusPill(u.status)} {staffTarget ? <Pill tone="blue">staff</Pill> : null}</h1>
          <p>{u.email ?? u.phone ?? "—"} · joined {dayAndTime(u.createdAt)} · <span className="mono xs">{u.id}</span></p>
        </div>
        <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
          {allowed(p, "session:revoke") ? <button className="btn secondary" onClick={() => setDialog("signout")}><LogOut /> Sign out everywhere</button> : null}
          {staffTarget && !me && allowed(p, "staff:manage") ? <button className="btn secondary" onClick={() => setDialog("mfa")}><KeyRound /> Reset sign-in</button> : null}
          {u.status !== "SUSPENDED" && canSuspend ? <button className="btn danger" onClick={() => setDialog("suspend")}><ShieldOff /> Suspend</button> : null}
          {u.status === "SUSPENDED" && canReinstate ? <button className="btn" onClick={() => setDialog("reinstate")}><ShieldCheck /> Reinstate</button> : null}
        </div>
      </div>
      {u.status === "SUSPENDED" ? <Notice tone="error">Suspended{u.banExpires ? ` until ${dayAndTime(u.banExpires)}` : ""}: {u.banReason}</Notice> : null}
      {staffTarget && (!u.twoFactorEnabled || u.mustChangePassword) ? <Notice>Setup not finished ({[!u.twoFactorEnabled && "no authenticator", u.mustChangePassword && "temporary password"].filter(Boolean).join(", ")}): their roles don't work until it is.</Notice> : null}
      {staffTarget && idle !== null && idle > 30 ? <Notice>Last sign-in {idle} days ago. Consider revoking roles they no longer use (access review).</Notice> : null}

      <div className="two-col wide-left">
        <div className="stack" style={{ gap: "1rem" }}>
          <section className="card">
            <div className="card-head"><h2>Sessions</h2><span className="xs muted">{u.sessions.filter((s) => s.active).length} active</span></div>
            {u.sessions.length === 0 ? <div className="card-body"><p className="small muted" style={{ margin: 0 }}>Never signed in.</p></div> : (
              <div style={{ overflowX: "auto" }}>
                <table className="table">
                  <thead><tr><th>Where</th><th>Device</th><th>Started</th><th>Last active</th><th /></tr></thead>
                  <tbody>
                    {u.sessions.map((s) => (
                      <tr key={s.id}>
                        <td>{s.surface === "admin" ? "staff dashboard" : "app / partner portal"}</td>
                        <td className="xs muted" style={{ maxWidth: "18rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.userAgent ?? ""}>{s.ipAddress ?? "—"} · {s.userAgent ?? ""}</td>
                        <td className="small">{dayAndTime(s.createdAt)}</td>
                        <td className="small">{dayAndTime(s.lastActiveAt)}</td>
                        <td>{s.active ? <Pill tone="green">active</Pill> : <Pill tone="grey">ended</Pill>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          {allowed(p, "audit_log:read") ? (
            <section className="card">
              <div className="card-head"><h2>What they did</h2><Link className="small" to={`/staff/admin/audit?actorId=${u.id}`}>open in the audit log</Link></div>
              <div className="card-body"><AuditTrail actorId={u.id} /></div>
            </section>
          ) : null}
        </div>
        <div className="stack" style={{ gap: "1rem", alignContent: "start" }}>
          <section className="card">
            <div className="card-head"><h2>Roles</h2>{staffTarget ? <Link className="small" to="/staff/people">manage</Link> : null}</div>
            <div className="card-body">
              {u.roles.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No roles.</p> : (
                <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: "0.35rem" }}>
                  {u.roles.map((r) => <li key={`${r.role}-${r.cityId ?? r.orgId ?? ""}`} className="small">{roleChip(r)}</li>)}
                </ul>
              )}
            </div>
          </section>
          {u.memberships.filter((m) => m.kind !== "STAFF_CITY").length ? (
            <section className="card">
              <div className="card-head"><h2>Organisations</h2></div>
              <div className="card-body">
                <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: "0.35rem" }}>
                  {u.memberships.filter((m) => m.kind !== "STAFF_CITY").map((m) => (
                    <li key={m.organizationId} className="small"><strong>{m.organizationName}</strong> <span className="muted">· {m.kind.toLowerCase()} · {m.roles.join(", ")} · {m.status.toLowerCase()}</span></li>
                  ))}
                </ul>
              </div>
            </section>
          ) : null}
          {allowed(p, "audit_log:read") ? (
            <section className="card">
              <div className="card-head"><h2>Done to this account</h2><span className="xs muted">by others</span></div>
              <div className="card-body"><AuditTrail resourceId={u.id} hideActor={u.id} /></div>
            </section>
          ) : null}
        </div>
      </div>

      {dialog ? <UserAction kind={dialog} user={u} onClose={() => setDialog(null)} onDone={refresh} /> : null}
    </div>
  );
}

function UserAction({ kind, user, onClose, onDone }: { kind: "signout" | "suspend" | "reinstate" | "mfa"; user: UserDetail; onClose: () => void; onDone: () => void }) {
  const { staff } = useSession();
  const [reason, setReason] = useState("");
  const cities = CITIES.filter((c) => allowed(staff.principal, kind === "reinstate" ? "user:reinstate" : "user:suspend", { cityId: c }));
  const [cityId, setCityId] = useState(cities[0] ?? CITIES[0]!);
  const run = useMutation({
    mutationFn: () => {
      const path = { signout: "sessions/revoke", suspend: "suspend", reinstate: "reinstate", mfa: "reset-mfa" }[kind];
      return api<{ temporaryPassword?: string; pendingApproval?: string }>("staff", `/api/identity/users/${user.id}/${path}`, { body: { reason, ...(kind === "suspend" || kind === "reinstate" ? { cityId } : {}) } });
    },
    onSuccess: onDone,
  });
  const title = { signout: "Sign out everywhere", suspend: `Suspend ${user.name}`, reinstate: `Reinstate ${user.name}`, mfa: `Reset ${user.name}'s sign-in` }[kind];
  const what = {
    signout: "Every session ends now, and their current access is refused. They can sign in again.",
    suspend: "They're signed out everywhere and can't sign in until reinstated. Open trip screens stop working.",
    reinstate: "They can sign in again.",
    mfa: "Their authenticator is removed and they get a new temporary password: at the next sign-in they set a password and enrol an authenticator again. For a super admin this needs a second super admin.",
  }[kind];
  return (
    <Drawer title={title} onClose={onClose}>
      {run.isSuccess ? (
        <div className="stack" style={{ gap: "0.75rem" }}>
          {run.data?.temporaryPassword ? (
            <div className="handover"><div className="label">Give this to them in person. It's shown once.</div><p className="secret">{run.data.temporaryPassword}</p></div>
          ) : run.data?.pendingApproval ? <Notice>Sent for approval: another super admin decides under Approvals.</Notice> : <Notice tone="ok">Done.</Notice>}
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
      ) : (
        <form className="stack" style={{ gap: "0.75rem" }} onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
          <p className="small muted" style={{ margin: 0 }}>{what}</p>
          <Problem error={run.error} />
          {(kind === "suspend" || kind === "reinstate") && !user.staff ? (
            <SelectField label="City handling the case" value={cityId} onChange={(e) => setCityId(e.target.value)}>
              {(cities.length ? cities : CITIES).map((c) => <option key={c} value={c}>{CITY_NAMES[c] ?? c}</option>)}
            </SelectField>
          ) : null}
          <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ticket number and what happened" hint="10+ characters; it goes into the audit log" />
          <button className={`btn ${kind === "suspend" ? "danger" : ""}`} disabled={run.isPending || reason.trim().length < 10}>{title}</button>
        </form>
      )}
    </Drawer>
  );
}
