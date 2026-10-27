// /staff/account: the signed-in staff member's own account (profile, password, two-step backup codes, sessions).
// Admin surface (/api/admin-auth) cookie calls only. Backup codes live in component state while
// they're on screen: never cached, stored or logged.

import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { roleInfo } from "@ride-app/shared-authz";
import { ApiError, authCall } from "../../lib/api";
import { backupCodesText, deviceLabel, nameProblem, orderSessions, passwordProblem, type AuthSession, type StaffSessionInfo } from "../../lib/account";
import { CITY_NAMES, dayAndTime, since } from "../../lib/format";
import { useSession } from "../../lib/session";
import { Empty, Field, Notice, PageHead, Pill, Problem } from "../../components/ui";

const ME = ["staff-me"] as const;
const SESSIONS = ["staff-sessions"] as const;

export function StaffAccountPage() {
  const { staff } = useSession();
  const [params] = useSearchParams();
  const me = useQuery({ queryKey: ME, queryFn: () => authCall<StaffSessionInfo | null>("staff", "/get-session") });

  if (me.isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (me.error) return <div className="page"><Problem error={me.error} /></div>;
  if (!me.data) return <div className="page"><Empty title="Signed out.">Sign in again to see your account.</Empty></div>;
  const { user, session } = me.data;
  const roles = staff.principal?.roles ?? [];

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead title="My account" lede={<>Signed in as <span className="mono">{user.email}</span></>} />
      {params.get("backup") === "used" ? (
        <Notice>
          You signed in with a backup code; that code won't work again. If your authenticator is gone for good, ask a super admin to reset your sign-in.
          If you're running low on codes, make new ones below.
        </Notice>
      ) : null}
      <div className="two-col">
        <div className="stack" style={{ gap: "1rem", alignContent: "start" }}>
          <Profile name={user.name} />
          <section className="card">
            <div className="card-head"><h2>Your roles</h2></div>
            <div className="card-body">
              {roles.length === 0 ? <p className="small muted" style={{ margin: 0 }}>None yet. A super admin requests roles for you; a second one approves.</p> : (
                <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: "0.35rem" }}>
                  {roles.map((r) => (
                    <li key={`${r.role}-${r.cityId ?? ""}`} className="small">
                      {roleInfo(r.role)?.label ?? r.role}<span className="muted"> · {r.cityId ? CITY_NAMES[r.cityId] ?? r.cityId : "everywhere"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
          <ChangePassword />
          <BackupCodesCard email={user.email} twoFactor={!!user.twoFactorEnabled} />
        </div>
        <Sessions current={session} />
      </div>
    </div>
  );
}

function Profile({ name: current }: { name: string }) {
  const qc = useQueryClient();
  const [name, setName] = useState(current);
  const save = useMutation({
    mutationFn: () => authCall("staff", "/update-user", { name: name.trim() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ME }),
  });
  const problem = nameProblem(name);
  const changed = name.trim() !== current;
  return (
    <form className="card pad" onSubmit={(e) => { e.preventDefault(); if (changed && !problem) save.mutate(); }}>
      <h2 style={{ marginBottom: "0.25rem" }}>Your name</h2>
      <p className="small muted" style={{ marginBottom: "0.9rem" }}>Shown to other staff in the directory, approvals and the audit log.</p>
      <Problem error={save.error} />
      <Field label="Full name" required maxLength={120} value={name} onChange={(e) => { setName(e.target.value); save.reset(); }} autoComplete="name" hint={changed && problem ? problem : undefined} />
      <button className="btn" disabled={!changed || !!problem || save.isPending}>{save.isPending ? "Saving…" : "Save"}</button>
      {save.isSuccess ? <div style={{ marginTop: "0.75rem" }}><Notice tone="ok">Saved.</Notice></div> : null}
    </form>
  );
}

function ChangePassword() {
  const qc = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [others, setOthers] = useState(true);
  const change = useMutation({
    mutationFn: () => authCall("staff", "/change-password", { currentPassword: current, newPassword: next, revokeOtherSessions: others }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setRepeat("");
      void qc.invalidateQueries({ queryKey: SESSIONS });
    },
  });
  const problem = next || repeat ? passwordProblem(current, next, repeat) : null;
  const ready = current.length > 0 && next.length > 0 && !passwordProblem(current, next, repeat);
  return (
    <form className="card pad" onSubmit={(e) => { e.preventDefault(); if (ready) change.mutate(); }}>
      <h2 style={{ marginBottom: "0.25rem" }}>Password</h2>
      <p className="small muted" style={{ marginBottom: "0.9rem" }}>12 to 128 characters. A sentence you'll remember works well.</p>
      <Problem error={change.error instanceof ApiError && change.error.status === 400 ? new ApiError(400, change.error.code, "That isn't your current password, or the new one isn't allowed.") : change.error} />
      <Field label="Current password" type="password" autoComplete="current-password" required value={current} onChange={(e) => { setCurrent(e.target.value); change.reset(); }} />
      <Field label="New password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={next} onChange={(e) => { setNext(e.target.value); change.reset(); }} />
      <Field label="New password again" type="password" autoComplete="new-password" required value={repeat} onChange={(e) => { setRepeat(e.target.value); change.reset(); }} hint={problem ?? undefined} />
      <label className="row small" style={{ gap: "0.5rem", marginBottom: "0.9rem" }}>
        <input type="checkbox" checked={others} onChange={(e) => setOthers(e.target.checked)} />
        Sign out my other sessions
      </label>
      <button className="btn" disabled={!ready || change.isPending}>{change.isPending ? "Saving…" : "Change password"}</button>
      {change.isSuccess ? <div style={{ marginTop: "0.75rem" }}><Notice tone="ok">Password changed{others ? "; your other sessions are signed out" : ""}.</Notice></div> : null}
    </form>
  );
}

function BackupCodesCard({ email, twoFactor }: { email: string; twoFactor: boolean }) {
  const [stage, setStage] = useState<"idle" | "confirm">("idle");
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function generate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await authCall<{ backupCodes: string[] }>("staff", "/two-factor/generate-backup-codes", { password });
      setCodes(r.backupCodes);
      setStage("idle");
    } catch (err) {
      setError(err instanceof ApiError && (err.status === 400 || err.status === 401) ? new ApiError(err.status, err.code, "That password isn't right.") : err);
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head"><h2>Two-step sign-in</h2>{twoFactor ? <Pill tone="green">authenticator on</Pill> : <Pill tone="amber">no authenticator</Pill>}</div>
      <div className="card-body stack" style={{ gap: "0.75rem" }}>
        <p className="small muted" style={{ margin: 0 }}>
          You sign in with your password and a code from your authenticator app. Backup codes let you in if the phone is lost: each works once.
          Making new codes cancels all the old ones.
        </p>
        <Problem error={error} />
        {codes ? (
          <BackupCodes codes={codes} email={email} onDone={() => setCodes(null)} />
        ) : stage === "confirm" ? (
          <form onSubmit={generate}>
            <Notice>Your current backup codes stop working as soon as the new ones are made.</Notice>
            <div style={{ height: "0.75rem" }} />
            <Field label="Your password" type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            <div className="row" style={{ gap: "0.5rem" }}>
              <button className="btn danger" disabled={busy || !password}>{busy ? "Making…" : "Replace my backup codes"}</button>
              <button type="button" className="btn ghost" onClick={() => { setStage("idle"); setPassword(""); setError(null); }}>Cancel</button>
            </div>
          </form>
        ) : (
          <div><button className="btn secondary" disabled={!twoFactor} onClick={() => setStage("confirm")}>Make new backup codes</button></div>
        )}
      </div>
    </section>
  );
}

/** Backup codes, shown once, with a copy button. Also used by first-time setup. */
export function BackupCodes({ codes, email, onDone }: { codes: string[]; email?: string | null; onDone?: () => void }) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(backupCodesText(codes, email));
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  }
  return (
    <div className="handover">
      <span className="label">Backup codes: each works once. Save them now (a password manager, or printed and locked away); they aren't shown again.</span>
      <ul className="mono small" style={{ columns: 2, listStyle: "none", padding: 0, margin: "0.5rem 0", lineHeight: 1.9 }}>{codes.map((b) => <li key={b}>{b}</li>)}</ul>
      <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
        <button type="button" className="btn sm secondary" onClick={() => void copy()}><Copy /> {copied === "yes" ? "Copied" : "Copy codes"}</button>
        {onDone ? <button type="button" className="btn sm" onClick={() => confirm("Hide the codes? They can't be shown again; you'd have to make new ones.") && onDone()}>I've saved them</button> : null}
      </div>
      {copied === "failed" ? <p className="xs" style={{ color: "var(--danger)", margin: "0.5rem 0 0" }}>Couldn't copy. Select the codes and copy them by hand.</p> : null}
    </div>
  );
}

function Sessions({ current }: { current: AuthSession }) {
  const qc = useQueryClient();
  const { signOut } = useSession();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: SESSIONS, retry: false, queryFn: () => authCall<AuthSession[]>("staff", "/list-sessions") });
  const done = () => qc.invalidateQueries({ queryKey: SESSIONS });
  const revoke = useMutation({ mutationFn: (token: string) => authCall("staff", "/revoke-session", { token }), onSuccess: done });
  const revokeOthers = useMutation({ mutationFn: () => authCall("staff", "/revoke-other-sessions", {}), onSuccess: done });
  const sessions = orderSessions(list.data ?? [], current.token);
  const others = sessions.filter((s) => s.token !== current.token);
  const notFresh = list.error instanceof ApiError && (list.error.code === "SESSION_NOT_FRESH" || list.error.status === 403);

  return (
    <section className="card" style={{ alignSelf: "start" }}>
      <div className="card-head row between">
        <h2>Where you're signed in</h2>
        {others.length ? (
          <button className="btn sm ghost" disabled={revokeOthers.isPending} onClick={() => confirm(`Sign out of ${others.length} other session${others.length > 1 ? "s" : ""}? This browser stays signed in.`) && revokeOthers.mutate()}>Sign out everywhere else</button>
        ) : null}
      </div>
      <div className="card-body stack" style={{ gap: "0.75rem" }}>
        {notFresh ? (
          <Notice>For your safety the session list opens only soon after signing in. <button className="link" onClick={() => void signOut("staff").then(() => navigate("/sign-in/staff"))}>Sign in again</button> to see it.</Notice>
        ) : <Problem error={list.error} />}
        <Problem error={revoke.error ?? revokeOthers.error} />
        {list.isLoading ? <p className="muted small" style={{ margin: 0 }}>Loading…</p> : null}
        {sessions.map((s) => {
          const here = s.token === current.token;
          return (
            <div key={s.id} className="row between">
              <span className="small">
                <strong>{deviceLabel(s.userAgent)}</strong> {here ? <Pill tone="green">this browser</Pill> : null}
                <div className="xs muted">
                  {s.ipAddress ? <span className="mono">{s.ipAddress}</span> : null}{s.ipAddress ? " · " : ""}
                  signed in {dayAndTime(s.createdAt)} · active {since(s.updatedAt)}{since(s.updatedAt) === "just now" ? "" : " ago"} · ends {dayAndTime(s.expiresAt)}
                </div>
              </span>
              {here ? null : (
                <button className="link danger" disabled={revoke.isPending} onClick={() => confirm(`Sign out ${deviceLabel(s.userAgent)}?`) && revoke.mutate(s.token)}>sign out</button>
              )}
            </div>
          );
        })}
        {list.data && others.length === 0 ? <p className="xs muted" style={{ margin: 0 }}>No other sessions.</p> : null}
        <p className="xs muted" style={{ margin: 0 }}>Staff sessions end after 12 hours. Don't recognise one? Sign it out and change your password.</p>
      </div>
    </section>
  );
}
