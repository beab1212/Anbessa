// /partner/account: the partner's own account (profile, invitations, sessions). App surface
// (/api/auth), cookie calls only; the phone number is the sign-in and can't be changed here.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, authCall } from "../../lib/api";
import { dayAndTime, phone as fmtPhone, placeholderEmailToPhone, since } from "../../lib/format";
import { deviceLabel, invitationOpen, looksLikePhone, type AuthSession, type SessionInfo, type UserInvitation } from "../../lib/partner";
import { useNow } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { Empty, Field, Notice, PageHead, Pill, Problem } from "../../components/ui";

const ROLE_WORD: Record<string, string> = {
  fleet_owner: "owner", fleet_driver: "driver", corporate_admin: "admin", corporate_coordinator: "travel desk (coordinator)", employee: "employee",
};

export function PartnerAccountPage() {
  const me = useQuery({ queryKey: ["partner-me"], queryFn: () => authCall<SessionInfo | null>("partner", "/get-session") });

  if (me.isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (me.error) return <div className="page"><Problem error={me.error} /></div>;
  if (!me.data) return <div className="page"><Empty title="Signed out.">Sign in again to see your account.</Empty></div>;
  const { user, session } = me.data;
  const phone = user.phoneNumber ?? placeholderEmailToPhone(user.email);

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead title="My account" lede={<>Signed in with <span className="mono">{fmtPhone(phone)}</span></>} />
      <div className="two-col">
        <div className="stack" style={{ gap: "1rem", alignContent: "start" }}>
          <Profile name={user.name} />
          <MyInvitations />
        </div>
        <Sessions current={session} />
      </div>
    </div>
  );
}

function Profile({ name: current }: { name: string }) {
  const qc = useQueryClient();
  const [name, setName] = useState(looksLikePhone(current) ? "" : current);
  const save = useMutation({
    mutationFn: () => authCall("partner", "/update-user", { name: name.trim() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["partner-me"] }),
  });
  const changed = name.trim().length > 0 && name.trim() !== current;
  return (
    <form className="card pad" onSubmit={(e) => { e.preventDefault(); if (changed) save.mutate(); }}>
      <h2 style={{ marginBottom: "0.25rem" }}>Your name</h2>
      <p className="small muted" style={{ marginBottom: "0.9rem" }}>Shown to your company's admins and, when you ride, to your driver.</p>
      <Problem error={save.error} />
      <Field label="Full name" required maxLength={80} value={name} onChange={(e) => { setName(e.target.value); save.reset(); }} placeholder="Selam Tesfaye" autoComplete="name" />
      <button className="btn" disabled={!changed || save.isPending}>Save</button>
      {save.isSuccess ? <div style={{ marginTop: "0.75rem" }}><Notice tone="ok">Saved.</Notice></div> : null}
    </form>
  );
}

function MyInvitations() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { refresh } = useSession();
  const list = useQuery({ queryKey: ["partner-my-invitations"], queryFn: () => authCall<UserInvitation[]>("partner", "/organization/list-user-invitations") });
  const accept = useMutation({
    mutationFn: (i: UserInvitation) => authCall("partner", "/organization/accept-invitation", { invitationId: i.id }).then(() => i),
    onSuccess: async (i) => {
      await qc.invalidateQueries({ queryKey: ["partner-my-invitations"] });
      await qc.invalidateQueries({ queryKey: ["my-orgs"] });
      await refresh("partner"); // the new role is in the next token
      navigate(`/partner/org/${i.organizationId}`);
    },
  });
  const reject = useMutation({
    mutationFn: (id: string) => authCall("partner", "/organization/reject-invitation", { invitationId: id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["partner-my-invitations"] }),
  });
  const now = useNow(60_000);
  const pending = (list.data ?? []).filter((i) => invitationOpen(i, now));
  const busy = accept.isPending || reject.isPending;

  return (
    <section className="card">
      <div className="card-head"><h2>Invitations to you</h2></div>
      <div className="card-body stack" style={{ gap: "0.75rem" }}>
        <Problem error={list.error ?? accept.error ?? reject.error} />
        {list.isLoading ? <p className="muted small" style={{ margin: 0 }}>Loading…</p> : null}
        {list.data && pending.length === 0 ? <p className="small muted" style={{ margin: 0 }}>None waiting. When a fleet or company invites your number, it shows up here and in the Anbessa app.</p> : null}
        {pending.map((i) => (
          <div key={i.id} className="row between">
            <span className="small">
              <strong>{i.organizationName ?? "A company"}</strong> invites you as {ROLE_WORD[i.role] ?? i.role}
              <span className="xs muted"> · until {dayAndTime(i.expiresAt)}</span>
            </span>
            <span className="row" style={{ gap: "0.4rem" }}>
              <button className="btn sm" disabled={busy} onClick={() => accept.mutate(i)}>Join</button>
              <button className="btn sm ghost" disabled={busy} onClick={() => confirm(`Decline the invitation from ${i.organizationName ?? "this company"}? They'd have to invite you again.`) && reject.mutate(i.id)}>Decline</button>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Sessions({ current }: { current: AuthSession }) {
  const qc = useQueryClient();
  const { signOut } = useSession();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ["partner-sessions"], retry: false, queryFn: () => authCall<AuthSession[]>("partner", "/list-sessions") });
  const done = () => qc.invalidateQueries({ queryKey: ["partner-sessions"] });
  const revoke = useMutation({ mutationFn: (token: string) => authCall("partner", "/revoke-session", { token }), onSuccess: done });
  const revokeOthers = useMutation({ mutationFn: () => authCall("partner", "/revoke-other-sessions", {}), onSuccess: done });
  const sessions = [...(list.data ?? [])].sort((a, b) => (a.token === current.token ? -1 : b.token === current.token ? 1 : b.updatedAt.localeCompare(a.updatedAt)));
  const others = sessions.filter((s) => s.token !== current.token);
  // Better Auth lists sessions only for a session signed in within the last day ("fresh")
  const notFresh = list.error instanceof ApiError && (list.error.code === "SESSION_NOT_FRESH" || list.error.status === 403);

  return (
    <section className="card" style={{ alignSelf: "start" }}>
      <div className="card-head row between">
        <h2>Where you're signed in</h2>
        {others.length ? (
          <button className="btn sm ghost" disabled={revokeOthers.isPending} onClick={() => confirm(`Sign out of ${others.length} other device${others.length > 1 ? "s" : ""}, including the Anbessa app on your phone?`) && revokeOthers.mutate()}>Sign out everywhere else</button>
        ) : null}
      </div>
      <div className="card-body stack" style={{ gap: "0.75rem" }}>
        {notFresh ? (
          <Notice>For your safety the device list opens only within a day of signing in. <button className="link" onClick={() => void signOut("partner").then(() => navigate("/sign-in/partner"))}>Sign in again</button> to see it.</Notice>
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
                  signed in {dayAndTime(s.createdAt)} · active {since(s.updatedAt)}{since(s.updatedAt) === "just now" ? "" : " ago"}
                </div>
              </span>
              {here ? null : (
                <button className="link danger" disabled={revoke.isPending} onClick={() => confirm(`Sign out ${deviceLabel(s.userAgent)}?`) && revoke.mutate(s.token)}>sign out</button>
              )}
            </div>
          );
        })}
        {list.data && others.length === 0 ? <p className="xs muted" style={{ margin: 0 }}>No other devices.</p> : null}
      </div>
    </section>
  );
}
