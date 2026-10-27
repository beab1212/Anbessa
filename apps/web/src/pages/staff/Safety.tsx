// Safety: find a person, see their account state, suspend (optionally until a date) or reinstate.
// Suspension takes effect at once (Auth.md §9.5): every session ends and every service refuses the
// user's tokens. Staff accounts are suspended by super admins only (staff:manage).

import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Search, ShieldCheck, ShieldOff } from "lucide-react";
import { allowed, api, citiesFor, newIdempotencyKey } from "../../lib/api";
import type { UserDetail, UserRow } from "../../lib/admin";
import { CITIES, CITY_NAMES, dayAndTime } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { AuditTrail, roleChip, statusPill } from "../admin/Users";
import { Drawer, Empty, Notice, PageHead, Pill, Problem, SelectField, TextArea } from "../../components/ui";

// ── pure helpers (tests/safety.test.ts) ─────────────────────────────────────────

export const isUserId = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());

/** Addis Ababa is UTC+3 all year (no daylight saving). */
const ADDIS_OFFSET_MS = 3 * 3600_000;

/** A `datetime-local` value, read as Addis Ababa time, as an ISO instant. null if it isn't one. */
export function addisLocalToIso(local: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/.exec(local.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:00+03:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** `now` as a `datetime-local` value in Addis Ababa time (for the input's `min`). */
export const addisLocalNow = (now: number) => new Date(now + ADDIS_OFFSET_MS).toISOString().slice(0, 16);

export const REASON_MIN = 10;
export const REASON_MAX = 500;

/** What still stops the form from being sent (auth-service: reason 10–500 characters, `until` in the future). */
export function actionProblems(input: { reason: string; until?: string; now: number }): string[] {
  const out: string[] = [];
  const n = input.reason.trim().length;
  if (n < REASON_MIN) out.push(`Reason: ${REASON_MIN - n} more characters`);
  if (n > REASON_MAX) out.push(`Reason: ${REASON_MAX} characters at most`);
  if (input.until) {
    const iso = addisLocalToIso(input.until);
    if (!iso) out.push("Until: not a date and time");
    else if (Date.parse(iso) <= input.now) out.push("Until: must be in the future");
  }
  return out;
}

// ── page ─────────────────────────────────────────────────────────────────────

export function Safety() {
  const [params, setParams] = useSearchParams();
  const openId = params.get("user");
  const [q, setQ] = useState("");
  const [suspendedOnly, setSuspendedOnly] = useState(false);
  const text = q.trim();
  const pastedId = isUserId(text);
  const query = new URLSearchParams({ q: text, limit: "25", ...(suspendedOnly ? { status: "suspended" } : {}) });
  const list = useQuery({
    queryKey: ["safety-users", query.toString()],
    enabled: text.length >= 2 && !pastedId,
    queryFn: () => api<{ users: UserRow[]; next: string | null }>("staff", `/api/identity/users?${query}`),
  });
  const open = (id: string) => setParams({ user: id });

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead title="Suspend" lede="Use this after an incident, a confirmed fraud case or a police request. The reason goes into the audit log with your name." />
      <div className="card">
        <div className="card-body stack" style={{ gap: "0.75rem" }}>
          <form className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); if (pastedId) open(text.toLowerCase()); }}>
            <Search size={16} className="muted" />
            <input className="input" style={{ flex: "1 1 18rem", maxWidth: "28rem" }} value={q} onChange={(e) => setQ(e.target.value)} autoFocus
              placeholder="Name, last 4+ digits of the phone, or paste a user id" aria-label="Find a person" />
            <button type="button" className="chip" aria-pressed={suspendedOnly} onClick={() => setSuspendedOnly((s) => !s)}>Suspended only</button>
          </form>
          {pastedId ? (
            <div className="row" style={{ gap: "0.5rem" }}>
              <span className="small muted">That's a user id.</span>
              <button className="btn sm" onClick={() => open(text.toLowerCase())}>Open <span className="mono">{text.slice(0, 8)}…</span></button>
            </div>
          ) : text.length < 2 ? <p className="xs muted" style={{ margin: 0 }}>Type at least 2 characters. The id is on the trip, the ticket or the driver record.</p> : null}
        </div>
      </div>

      {list.error ? (
        <>
          <Problem error={list.error} />
          <p className="small muted" style={{ margin: 0 }}>You can still paste the person's user id above.</p>
        </>
      ) : null}
      {list.isLoading && !pastedId && text.length >= 2 ? <p className="muted small">Searching…</p> : null}
      {list.data && list.data.users.length === 0 ? <Empty title="Nobody matches.">Try the last digits of their phone number, or paste their user id.</Empty> : null}
      {list.data?.users.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Phone</th><th>Roles</th><th>Status</th><th>Joined</th><th /></tr></thead>
            <tbody>
              {list.data.users.map((u) => (
                <tr key={u.id} style={{ cursor: "pointer" }} onClick={() => open(u.id)}>
                  <td><strong>{u.name}</strong>{u.staff ? <> <Pill tone="blue">staff</Pill></> : null}</td>
                  <td className="mono small">{u.phone ?? (u.email ? <span className="muted">{u.email}</span> : "—")}</td>
                  <td className="small">{u.roles.length ? u.roles.map(roleChip).join(", ") : <span className="muted">none</span>}</td>
                  <td>{statusPill(u.status)}</td>
                  <td className="small">{dayAndTime(u.createdAt)}</td>
                  <td className="num"><ChevronRight size={16} className="muted" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.data?.next ? <p className="xs muted" style={{ margin: 0 }}>More people match. Add more of the name or phone number to narrow it down.</p> : null}

      {openId ? <PersonDrawer key={openId} userId={openId} onClose={() => setParams({})} /> : null}
    </div>
  );
}

// ── one person ─────────────────────────────────────────────────────────────────

type Mode = "suspend" | "reinstate";

function PersonDrawer({ userId, onClose }: { userId: string; onClose: () => void }) {
  const { staff } = useSession();
  const p = staff.principal;
  const user = useQuery({ queryKey: ["safety-user", userId], queryFn: () => api<UserDetail>("staff", `/api/identity/users/${userId}`) });
  const [mode, setMode] = useState<Mode | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const u = user.data;
  const me = userId === p?.userId;
  const staffTarget = !!u?.staff;
  // staff accounts: super admins (staff:manage); everyone else: safety officers in the handling city
  const suspendCities = staffTarget ? (allowed(p, "staff:manage") ? CITIES : []) : citiesFor(p, "user:suspend", CITIES);
  const reinstateCities = staffTarget ? (allowed(p, "staff:manage") ? CITIES : []) : citiesFor(p, "user:reinstate", CITIES);
  const known = !!u;
  const suspended = u?.status === "SUSPENDED";
  const canSuspend = !me && suspendCities.length > 0 && (!known || !suspended);
  const canReinstate = reinstateCities.length > 0 && (!known || suspended);
  const isDriver = !!u?.roles.some((r) => r.role === "DRIVER");

  return (
    <Drawer title={u ? u.name : "Person"} onClose={onClose} wide>
      <div className="stack" style={{ gap: "1rem" }}>
        {user.isLoading ? <p className="muted small">Loading…</p> : null}
        {user.error ? (
          <>
            <Problem error={user.error} />
            <Notice>The account details can't be shown, but you can still act on this id. Check it against the ticket first: <span className="mono">{userId}</span></Notice>
          </>
        ) : null}
        {u ? (
          <>
            <dl className="kv">
              <dt>Status</dt><dd>{statusPill(u.status)}{u.staff ? <> <Pill tone="blue">staff</Pill></> : null}</dd>
              <dt>Phone</dt><dd className="mono">{u.phone ?? "—"}</dd>
              {u.email ? <><dt>Email</dt><dd className="mono small">{u.email}</dd></> : null}
              <dt>Roles</dt><dd className="small">{u.roles.length ? u.roles.map(roleChip).join(", ") : <span className="muted">none</span>}</dd>
              <dt>Joined</dt><dd className="small">{dayAndTime(u.createdAt)}</dd>
              <dt>Id</dt><dd className="mono xs">{u.id}</dd>
            </dl>
            {suspended ? <Notice tone="error">Suspended{u.banExpires ? ` until ${dayAndTime(u.banExpires)}` : " until reinstated"}{u.banReason ? `: ${u.banReason}` : ""}</Notice> : null}
            {u.memberships.filter((m) => m.kind !== "STAFF_CITY").length ? (
              <div className="small">
                <div className="label">Companies</div>
                {u.memberships.filter((m) => m.kind !== "STAFF_CITY").map((m) => (
                  <div key={m.organizationId}><strong>{m.organizationName}</strong> <span className="muted">· {m.kind === "FLEET" ? "fleet" : "company account"} · {m.roles.join(", ").toLowerCase()} · {m.status.toLowerCase()}</span></div>
                ))}
              </div>
            ) : null}
            {isDriver && CITIES.some((c) => allowed(p, "driver:read", { cityId: c })) ? (
              <p className="small" style={{ margin: 0 }}>Driver: <Link to={`/staff/fleet/drivers/${u.id}`}>open the driver record</Link> to suspend driving only.</p>
            ) : null}
          </>
        ) : null}

        {me ? <Notice>This is your own account. Ask someone else to act on it.</Notice> : null}
        {staffTarget && !allowed(p, "staff:manage") ? <Notice>Staff accounts are suspended and reinstated by super admins only.</Notice> : null}
        {done ? <Notice tone="ok">{done}</Notice> : null}

        {!mode && !user.isLoading ? (
          <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
            {canSuspend ? <button className="btn danger" onClick={() => { setDone(null); setMode("suspend"); }}><ShieldOff /> Suspend</button> : null}
            {canReinstate ? <button className={`btn ${known ? "" : "secondary"}`} onClick={() => { setDone(null); setMode("reinstate"); }}><ShieldCheck /> Reinstate</button> : null}
          </div>
        ) : null}
        {mode ? (
          <ActionForm mode={mode} userId={userId} name={u?.name ?? null} staffTarget={staffTarget}
            cities={mode === "suspend" ? suspendCities : reinstateCities}
            onCancel={() => setMode(null)}
            onDone={(msg) => { setMode(null); setDone(msg); }} />
        ) : null}

        {allowed(p, "audit_log:read") ? (
          <section>
            <h3 className="section-title">Recent actions on this account</h3>
            <AuditTrail resourceId={userId} />
          </section>
        ) : null}
      </div>
    </Drawer>
  );
}

function ActionForm({ mode, userId, name, staffTarget, cities, onCancel, onDone }: {
  mode: Mode; userId: string; name: string | null; staffTarget: boolean; cities: string[]; onCancel: () => void; onDone: (message: string) => void;
}) {
  const qc = useQueryClient();
  const now = useNow(30_000);
  const [cityId, setCityId] = useState(cities[0] ?? "");
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [key] = useState(newIdempotencyKey);
  const problems = actionProblems({ reason, until: mode === "suspend" ? until : undefined, now });
  const untilIso = mode === "suspend" && until ? addisLocalToIso(until) : null;
  const who = name ?? "this account";
  const run = useMutation({
    mutationFn: () =>
      api("staff", `/api/identity/users/${userId}/${mode}`, {
        body: { reason: reason.trim(), cityId, ...(untilIso ? { until: untilIso } : {}) },
        idempotencyKey: key,
      }),
    onSuccess: () => {
      for (const k of [["safety-user", userId], ["safety-users"], ["admin-user", userId], ["admin-users"], ["audit"]]) void qc.invalidateQueries({ queryKey: k });
      onDone(mode === "suspend"
        ? `Suspended${untilIso ? ` until ${dayAndTime(untilIso)}` : ""}. Their sessions are closed and their tokens refused.`
        : "Reinstated. They can sign in again.");
    },
  });

  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); if (problems.length === 0) setConfirming(true); }}>
      <div className="card-head"><h2>{mode === "suspend" ? `Suspend ${who}` : `Reinstate ${who}`}</h2></div>
      <div className="card-body stack" style={{ gap: "0.75rem" }}>
        <p className="small muted" style={{ margin: 0 }}>
          {mode === "suspend"
            ? "They're signed out everywhere at once and can't sign in. Their app and any open trip screens stop working."
            : "They can sign in again straight away."}
        </p>
        <Problem error={run.error} />
        {!staffTarget && cities.length > 1 ? (
          <SelectField label="City handling the case" value={cityId} onChange={(e) => setCityId(e.target.value)} disabled={confirming}>
            {cities.map((c) => <option key={c} value={c}>{CITY_NAMES[c] ?? c}</option>)}
          </SelectField>
        ) : null}
        <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} disabled={confirming} maxLength={REASON_MAX}
          placeholder="What happened, and the ticket or incident number" hint={problems.find((x) => x.startsWith("Reason")) ?? "Goes into the audit log with your name."} />
        {mode === "suspend" ? (
          <div className="field">
            <label className="label" htmlFor="suspend-until">Until (optional, Addis Ababa time)</label>
            <input id="suspend-until" type="datetime-local" value={until} min={addisLocalNow(now)} onChange={(e) => setUntil(e.target.value)} disabled={confirming} />
            <span className="hint">{problems.find((x) => x.startsWith("Until")) ?? (until ? "The suspension lifts by itself then." : "Leave empty to keep it until someone reinstates them.")}</span>
          </div>
        ) : null}
        {confirming ? (
          <div className="stack" style={{ gap: "0.5rem" }}>
            <Notice tone={mode === "suspend" ? "error" : "info"}>
              {mode === "suspend" ? `Suspend ${who} ${untilIso ? `until ${dayAndTime(untilIso)}` : "until reinstated"}` : `Reinstate ${who}`}
              {!staffTarget ? ` · handled in ${CITY_NAMES[cityId] ?? cityId}` : ""}. This takes effect now.
            </Notice>
            <div className="row" style={{ gap: "0.5rem" }}>
              <button type="button" className={`btn ${mode === "suspend" ? "danger" : ""}`} disabled={run.isPending} onClick={() => run.mutate()}>
                {run.isPending ? "Working…" : mode === "suspend" ? "Yes, suspend now" : "Yes, reinstate"}
              </button>
              <button type="button" className="btn ghost" disabled={run.isPending} onClick={() => setConfirming(false)}>Back</button>
            </div>
          </div>
        ) : (
          <div className="row" style={{ gap: "0.5rem" }}>
            <button className={`btn ${mode === "suspend" ? "danger" : ""}`} disabled={problems.length > 0 || !cityId}>{mode === "suspend" ? "Suspend" : "Reinstate"}</button>
            <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          </div>
        )}
      </div>
    </form>
  );
}
