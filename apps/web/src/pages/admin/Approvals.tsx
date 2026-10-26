// One inbox for everything that needs a second person (Role.md §11): staff role grants, permission
// changes and super-admin MFA resets (auth-service), and sensitive settings (platform-service).
// You can't approve what you asked for; you can withdraw it.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { allowed, api } from "../../lib/api";
import { ACTION_LABEL, showValue, type Approval, type SettingChange, type SettingsOverview, type UserRow } from "../../lib/admin";
import { CITY_NAMES, dayAndTime, shortId } from "../../lib/format";
import { useSession } from "../../lib/session";
import { Empty, Notice, PageHead, Pill, Problem, TextArea } from "../../components/ui";
import { describeApproval } from "./Roles";

/** Staff names by id (the people who ask and decide are staff). */
export function useStaffNames() {
  const { staff } = useSession();
  const q = useQuery({
    queryKey: ["admin-users", "staff-names"],
    enabled: allowed(staff.principal, "user:read_masked"),
    staleTime: 5 * 60_000,
    queryFn: () => api<{ users: UserRow[] }>("staff", "/api/identity/users?kind=staff&limit=100").then((r) => r.users),
  });
  return (id: string | null | undefined) => (id ? q.data?.find((u) => u.id === id)?.name ?? shortId(id) : "—");
}

type Item =
  | { source: "identity"; a: Approval }
  | { source: "settings"; c: SettingChange };

export function ApprovalsPage() {
  const { staff } = useSession();
  const p = staff.principal!;
  const qc = useQueryClient();
  const name = useStaffNames();
  const [status, setStatus] = useState<"PENDING" | "EXECUTED" | "REJECTED" | "EXPIRED" | "CANCELLED">("PENDING");
  const identityVisible = ["role:request", "role:approve", "authz:propose", "authz:approve", "staff:manage"].some((perm) => allowed(p, perm as never));
  const settingsVisible = allowed(p, "settings:read");
  const identity = useQuery({
    queryKey: ["approvals", "all", status],
    enabled: identityVisible,
    queryFn: () => api<{ approvals: Approval[] }>("staff", `/api/identity/approvals?status=${status}`).then((r) => r.approvals),
  });
  const settings = useQuery({
    queryKey: ["setting-changes", status],
    enabled: settingsVisible,
    queryFn: () => api<{ changes: SettingChange[] }>("staff", `/api/platform/settings/changes?status=${status}`).then((r) => r.changes),
  });
  const defs = useQuery({ queryKey: ["admin-settings"], enabled: settingsVisible, queryFn: () => api<SettingsOverview>("staff", "/api/platform/settings") });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["approvals"] });
    void qc.invalidateQueries({ queryKey: ["setting-changes"] });
    void qc.invalidateQueries({ queryKey: ["admin-settings"] });
    void qc.invalidateQueries({ queryKey: ["admin-authz"] });
  };

  const items: Item[] = [
    ...(identity.data ?? []).map((a) => ({ source: "identity" as const, a })),
    ...(settings.data ?? []).map((c) => ({ source: "settings" as const, c })),
  ].sort((x, y) => (x.source === "identity" ? x.a.createdAt : x.c.createdAt).localeCompare(y.source === "identity" ? y.a.createdAt : y.c.createdAt) * (status === "PENDING" ? 1 : -1));

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead title="Approvals" lede="Changes that need a second person. Requests expire after 7 days." />
      <div className="tabs" role="tablist">
        {(["PENDING", "EXECUTED", "REJECTED", "EXPIRED", "CANCELLED"] as const).map((s) => (
          <button key={s} role="tab" aria-selected={status === s} onClick={() => setStatus(s)}>
            {{ PENDING: "Waiting", EXECUTED: "Approved", REJECTED: "Rejected", EXPIRED: "Expired", CANCELLED: "Withdrawn" }[s]}
          </button>
        ))}
      </div>
      <Problem error={identity.error ?? settings.error} />
      {!identity.isLoading && !settings.isLoading && items.length === 0 ? <Empty title={status === "PENDING" ? "Nothing waiting." : "None."} /> : null}
      <div className="stack" style={{ gap: "0.75rem" }}>
        {items.map((it) =>
          it.source === "identity"
            ? <IdentityCard key={it.a.id} a={it.a} me={p.userId} name={name} onDone={refresh} />
            : <SettingCard key={it.c.id} c={it.c} me={p.userId} name={name} defs={defs.data} onDone={refresh} />,
        )}
      </div>
    </div>
  );
}

function Decide({ mine, onApprove, onReject, onCancel, pending }: { mine: boolean; pending: boolean; onApprove: () => void; onReject: (reason: string) => void; onCancel: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  if (mine) {
    return (
      <div className="row" style={{ gap: "0.5rem" }}>
        <span className="small muted">You asked; another super admin decides.</span>
        <button className="btn ghost sm" disabled={pending} onClick={onCancel}>Withdraw</button>
      </div>
    );
  }
  if (rejecting) {
    return (
      <form className="stack" style={{ gap: "0.5rem", width: "100%" }} onSubmit={(e) => { e.preventDefault(); onReject(reason.trim()); }}>
        <TextArea label="Why not" value={reason} onChange={(e) => setReason(e.target.value)} hint="They see this" />
        <div className="row" style={{ gap: "0.5rem" }}>
          <button className="btn danger sm" disabled={pending || reason.trim().length < 5}>Reject</button>
          <button type="button" className="btn ghost sm" onClick={() => setRejecting(false)}>Back</button>
        </div>
      </form>
    );
  }
  return (
    <div className="row" style={{ gap: "0.5rem" }}>
      <button className="btn sm" disabled={pending} onClick={onApprove}>Approve</button>
      <button className="btn secondary sm" disabled={pending} onClick={() => setRejecting(true)}>Reject…</button>
    </div>
  );
}

function IdentityCard({ a, me, name, onDone }: { a: Approval; me: string; name: (id: string | null) => string; onDone: () => void }) {
  const [result, setResult] = useState<{ temporaryPassword?: string } | null>(null);
  const act = useMutation({
    mutationFn: (x: { op: "approve" | "reject" | "cancel"; reason?: string }) => api<{ temporaryPassword?: string }>("staff", `/api/identity/approvals/${a.id}/${x.op}`, { body: x.reason ? { reason: x.reason } : {} }),
    onSuccess: (r) => {
      if (r?.temporaryPassword) setResult(r);
      onDone();
    },
  });
  const target = typeof a.payload.userId === "string" ? a.payload.userId : null;
  return (
    <article className="card pad stack" style={{ gap: "0.5rem" }}>
      <div className="row between" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="row" style={{ gap: "0.5rem" }}>
            <strong>{ACTION_LABEL[a.action] ?? a.action}</strong>
            {a.status !== "PENDING" ? <Pill tone={a.status === "EXECUTED" ? "green" : "grey"}>{a.status.toLowerCase()}</Pill> : null}
          </div>
          <div className="small" style={{ marginTop: "0.2rem" }}>
            {a.action === "role:grant" ? (
              <><strong>{String(a.payload.role)}</strong>{a.payload.cityId ? ` in ${CITY_NAMES[String(a.payload.cityId)] ?? a.payload.cityId}` : " everywhere"} for <Link to={`/staff/admin/users/${target}`}>{name(target)}</Link></>
            ) : a.action === "staff:reset_mfa" ? (
              <>new temporary password and authenticator for <Link to={`/staff/admin/users/${target}`}>{name(target)}</Link></>
            ) : <span className="mono">{describeApproval(a)}</span>}
          </div>
          <div className="xs muted" style={{ marginTop: "0.25rem" }}>
            Asked by {a.makerId === me ? "you" : name(a.makerId)} · {dayAndTime(a.createdAt)} · “{a.reason}”
            {a.checkerId ? <> · decided by {a.checkerId === me ? "you" : name(a.checkerId)}{a.decisionReason ? ` (“${a.decisionReason}”)` : ""}</> : null}
          </div>
        </div>
        {a.status === "PENDING" ? <span className="xs muted">expires {dayAndTime(a.expiresAt)}</span> : null}
      </div>
      <Problem error={act.error} />
      {result?.temporaryPassword ? (
        <div className="handover"><div className="label">Give this temporary password to them in person. It's shown once.</div><p className="secret">{result.temporaryPassword}</p></div>
      ) : null}
      {a.status === "PENDING" ? (
        <Decide mine={a.makerId === me} pending={act.isPending} onApprove={() => act.mutate({ op: "approve" })} onReject={(reason) => act.mutate({ op: "reject", reason })} onCancel={() => act.mutate({ op: "cancel" })} />
      ) : null}
    </article>
  );
}

function SettingCard({ c, me, name, defs, onDone }: { c: SettingChange; me: string; name: (id: string | null) => string; defs?: SettingsOverview; onDone: () => void }) {
  const def = defs?.definitions.find((d) => d.key === c.key);
  const current = c.cityId ? defs?.cities[c.cityId]?.[c.key] ?? defs?.global[c.key] : defs?.global[c.key];
  const act = useMutation({
    mutationFn: (x: { op: "approve" | "reject" | "cancel"; reason?: string }) => api("staff", `/api/platform/settings/changes/${c.id}/${x.op}`, { body: x.reason ? { reason: x.reason } : {} }),
    onSuccess: onDone,
  });
  return (
    <article className="card pad stack" style={{ gap: "0.5rem" }}>
      <div className="row" style={{ gap: "0.5rem" }}>
        <strong>Change a setting</strong>
        <Pill tone="amber">sensitive</Pill>
        {c.status !== "PENDING" ? <Pill tone={c.status === "EXECUTED" ? "green" : "grey"}>{c.status.toLowerCase()}</Pill> : null}
      </div>
      <div className="small">
        <strong>{def?.label ?? c.key}</strong>{c.cityId ? ` in ${CITY_NAMES[c.cityId] ?? c.cityId}` : ""}: {showValue(def, current ?? def?.default)} → <strong>{showValue(def, c.value)}</strong>
      </div>
      <div className="xs muted">Asked by {c.makerId === me ? "you" : name(c.makerId)} · {dayAndTime(c.createdAt)} · “{c.reason}”</div>
      {c.key === "maintenance.newTrips" && c.value === true ? <Notice tone="error">Approving pauses every new trip request until someone turns it off.</Notice> : null}
      <Problem error={act.error} />
      {c.status === "PENDING" ? (
        <Decide mine={c.makerId === me} pending={act.isPending} onApprove={() => act.mutate({ op: "approve" })} onReject={(reason) => act.mutate({ op: "reject", reason })} onCancel={() => act.mutate({ op: "cancel" })} />
      ) : null}
    </article>
  );
}
