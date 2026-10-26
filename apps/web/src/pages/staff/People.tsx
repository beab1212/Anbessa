import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GRANTABLE_STAFF_ROLES, ROLES, type RoleCode } from "@ride-app/shared-authz";
import { allowed, api } from "../../lib/api";
import { CITIES, CITY_NAMES, dayAndTime, shortId } from "../../lib/format";
import { useSession } from "../../lib/session";
import { Empty, Field, Notice, PageHead, Pill, Problem, SelectField, Stat } from "../../components/ui";

interface RoleRequest {
  id: string;
  payload: { userId: string; role: RoleCode; cityId?: string };
  reason: string;
  makerId: string;
  checkerId: string | null;
  status: "PENDING" | "EXECUTED" | "REJECTED" | "EXPIRED";
  createdAt: string;
  expiresAt: string;
}

const roleName = (r: string) => r.toLowerCase().replace(/_/g, " ");

/**
 * Staff accounts and roles (Auth.md §9.3). One super admin asks, another approves: nobody
 * grants a role alone, and nobody approves their own request.
 */
export function People() {
  const { staff } = useSession();
  const me = staff.principal!;
  const qc = useQueryClient();
  const canManage = allowed(me, "staff:manage");
  const canRequest = allowed(me, "role:request");
  const canApprove = allowed(me, "role:approve");

  const requests = useQuery({
    queryKey: ["role-requests"],
    enabled: canRequest || canApprove,
    queryFn: () => api<RoleRequest[]>("staff", "/api/identity/staff-role-requests"),
  });
  const decide = useMutation({
    mutationFn: (a: { id: string; ok: boolean; reason?: string }) =>
      api("staff", `/api/identity/staff-role-requests/${a.id}/${a.ok ? "approve" : "reject"}`, { body: a.ok ? {} : { reason: a.reason } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["role-requests"] }),
  });

  const pending = (requests.data ?? []).filter((r) => r.status === "PENDING");
  const recent = (requests.data ?? []).filter((r) => r.status !== "PENDING").slice(0, 12);

  return (
    <div className="page stack" style={{ gap: "1.5rem" }}>
      <PageHead
        title="Staff and roles"
        lede="Every role needs two people: one asks, another approves. Requests expire after 7 days."
        right={pending.length ? <Stat label="Waiting for a second person" value={pending.length} alert /> : null}
      />
      <Problem error={requests.error ?? decide.error} />

      <section className="card">
        <div className="card-head"><h2>Waiting for approval</h2></div>
        {pending.length === 0 ? <Empty title="Nothing to approve." /> : (
          <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead><tr><th>Who</th><th>Role</th><th>Where</th><th>Why</th><th>Asked by</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {pending.map((r) => {
                const mine = r.makerId === me.userId;
                return (
                  <tr key={r.id} className={mine ? "" : "urgent"}>
                    <td className="mono">{shortId(r.payload.userId)}</td>
                    <td><strong>{roleName(r.payload.role)}</strong></td>
                    <td>{r.payload.cityId ? CITY_NAMES[r.payload.cityId] ?? r.payload.cityId : "everywhere"}</td>
                    <td className="small" style={{ maxWidth: "20rem" }}>{r.reason}</td>
                    <td className="mono small">{mine ? "you" : shortId(r.makerId)}</td>
                    <td className="small">{dayAndTime(r.expiresAt)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {mine ? <span className="small muted">needs another super admin</span> : canApprove ? (
                        <>
                          <button className="btn sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, ok: true })}>Approve</button>{" "}
                          <button className="link danger" onClick={() => {
                            const reason = prompt("Why reject? (10+ characters)");
                            if (reason && reason.trim().length >= 10) decide.mutate({ id: r.id, ok: false, reason: reason.trim() });
                          }}>reject</button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <div className="two-col">
        {canManage ? <CreateStaff /> : <div />}
        {canRequest ? <RequestRole onDone={() => qc.invalidateQueries({ queryKey: ["role-requests"] })} /> : null}
      </div>

      {recent.length ? (
        <section className="card">
          <div className="card-head"><h2>Decided recently</h2></div>
          <div style={{ overflowX: "auto" }}>
          <table className="table">
            <tbody>
              {recent.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{shortId(r.payload.userId)}</td>
                  <td>{roleName(r.payload.role)}</td>
                  <td>{r.payload.cityId ? CITY_NAMES[r.payload.cityId] ?? r.payload.cityId : "everywhere"}</td>
                  <td>{r.status === "EXECUTED" ? <Pill tone="green">granted</Pill> : <Pill tone="grey">{r.status.toLowerCase()}</Pill>}</td>
                  <td className="muted">{dayAndTime(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function CreateStaff() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [created, setCreated] = useState<{ userId: string; email: string; temporaryPassword: string } | null>(null);
  const create = useMutation({
    mutationFn: () => api<{ userId: string; email: string; temporaryPassword: string }>("staff", "/api/identity/staff-accounts", { body: { name: name.trim(), email: email.trim() } }),
    onSuccess: (r) => { setCreated(r); setName(""); setEmail(""); },
  });
  return (
    <section className="card">
      <div className="card-head"><h2>New staff account</h2></div>
      <div className="card-body">
      <Problem error={create.error} />
      {created ? (
        <div className="handover">
          <div className="label">Give this to {created.email} in person. It's shown once.</div>
          <p className="secret">{created.temporaryPassword}</p>
          <p className="small">User id <span className="mono">{created.userId}</span>. They get no roles until they change this password, add an authenticator, and a role is approved.</p>
          <button className="link" onClick={() => setCreated(null)}>done, hide it</button>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Full name" required value={name} onChange={(e) => setName(e.target.value)} />
          <Field label="Work email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn" disabled={create.isPending}>Create account</button>
        </form>
      )}
      </div>
    </section>
  );
}

function RequestRole({ onDone }: { onDone: () => void }) {
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<RoleCode>("DISPATCHER");
  const [cityId, setCityId] = useState(CITIES[0]!);
  const [reason, setReason] = useState("");
  const cityScoped = ROLES[role].storage.type === "member";
  const ask = useMutation({
    mutationFn: () => api("staff", "/api/identity/staff-role-requests", { body: { userId: userId.trim(), role, ...(cityScoped ? { cityId } : {}), reason: reason.trim() } }),
    onSuccess: () => { setUserId(""); setReason(""); onDone(); },
  });
  return (
    <section className="card">
      <div className="card-head"><h2>Ask for a role</h2></div>
      <div className="card-body">
      <Problem error={ask.error} />
      {ask.isSuccess ? <Notice tone="ok">Requested. Another super admin has to approve it.</Notice> : null}
      <form onSubmit={(e) => { e.preventDefault(); ask.mutate(); }}>
        <Field label="User id" className="mono" required value={userId} onChange={(e) => setUserId(e.target.value)} />
        <SelectField label="Role" value={role} onChange={(e) => setRole(e.target.value as RoleCode)}>
          {GRANTABLE_STAFF_ROLES.map((r) => <option key={r} value={r}>{roleName(r)}</option>)}
        </SelectField>
        {cityScoped ? (
          <SelectField label="City" value={cityId} onChange={(e) => setCityId(e.target.value)}>
            {CITIES.map((c) => <option key={c} value={c}>{CITY_NAMES[c]}</option>)}
          </SelectField>
        ) : <p className="small muted">This role works in every city.</p>}
        <div className="field">
          <label className="label" htmlFor="why">Why</label>
          <textarea id="why" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="New hire for the Bole call center, starts Monday" />
        </div>
        <button className="btn" disabled={ask.isPending || reason.trim().length < 10 || userId.trim().length < 36}>Send for approval</button>
      </form>
      </div>
    </section>
  );
}
