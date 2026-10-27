// Incidents (workflow 14 §C): opened from an SOS, a safety ticket or by hand; investigated with
// notes; resolved with an outcome. Suspensions happen in auth-service (the Suspend page); the
// decision is then recorded here as an action, so the incident tells the whole story.

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { allowed, citiesFor, newIdempotencyKey } from "../../lib/api";
import { CITIES, CITY_NAMES, dayAndTime, shortId } from "../../lib/format";
import { useStaffCity } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import {
  ACTION_LABEL, CATEGORY_LABEL, INCIDENT_ACTION_KINDS, INCIDENT_CATEGORIES, INCIDENT_CATEGORY_LABEL, INCIDENT_OUTCOMES, INCIDENT_OUTCOME_LABEL,
  INCIDENT_SEVERITIES, INCIDENT_STATUSES, INCIDENT_STATUS_LABEL, INCIDENT_STATUS_TONE, SEVERITY_TONE, SOS_OUTCOME_LABEL, SOS_STATUS_LABEL, SOS_STATUS_TONE,
  TICKET_STATUS_LABEL, TICKET_STATUS_TONE, isUuid, supportApi, words,
  type IncidentActionKind, type IncidentCategory, type IncidentOutcome, type IncidentSeverity,
} from "../../lib/support";
import { addisLocalToIso } from "../staff/Safety";
import { CityPicker } from "../../components/CityPicker";
import { Drawer, Empty, Field, Notice, PageHead, Pill, Problem, SelectField, TextArea } from "../../components/ui";

const uuids = (s: string) => s.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

export function IncidentsPage() {
  const { cities, cityId, setCityId } = useStaffCity("incident:manage");
  const [status, setStatus] = useState("");
  const [severity, setSeverity] = useState("");
  const [category, setCategory] = useState("");
  const [creating, setCreating] = useState(false);
  const list = useInfiniteQuery({
    queryKey: ["incidents", cityId, status, severity, category],
    enabled: !!cityId,
    refetchInterval: 30_000,
    initialPageParam: "",
    getNextPageParam: (last: { next: string | null }) => last.next ?? undefined,
    queryFn: ({ pageParam }) => supportApi.incidents({ cityId, status, severity, category }, pageParam || undefined),
  });
  const rows = list.data?.pages.flatMap((p) => p.incidents) ?? [];

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Incidents"
        lede="Safety investigations: what happened, who was involved, and what was decided. Records are kept for good."
        right={<>{cityId ? <button className="btn" onClick={() => setCreating(true)}><Plus /> Open incident</button> : null}<CityPicker cities={cities} value={cityId} onChange={setCityId} /></>}
      />
      {!cityId ? <Notice>You don't manage incidents in any city.</Notice> : null}
      <div className="chips">
        {["", ...INCIDENT_STATUSES].map((s) => <button key={s} className="chip" aria-pressed={status === s} onClick={() => setStatus(s)}>{s ? INCIDENT_STATUS_LABEL[s as keyof typeof INCIDENT_STATUS_LABEL] : "All"}</button>)}
      </div>
      <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
        <SelectField label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
          <option value="">Any</option>
          {INCIDENT_SEVERITIES.map((s) => <option key={s} value={s}>{words(s)}</option>)}
        </SelectField>
        <SelectField label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Any</option>
          {INCIDENT_CATEGORIES.map((c) => <option key={c} value={c}>{INCIDENT_CATEGORY_LABEL[c]}</option>)}
        </SelectField>
      </div>
      <Problem error={list.error} />
      {list.isPending && cityId ? <p className="small muted">Loading…</p> : null}
      {list.isSuccess && rows.length === 0 ? <Empty title="No incidents match." /> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>#</th><th>Summary</th><th>Category</th><th>From</th><th>Opened</th><th>Severity</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td className="mono"><Link to={`/staff/safety/incidents/${i.id}`}>{i.ref}</Link></td>
                  <td><Link to={`/staff/safety/incidents/${i.id}`}>{i.summary.length > 90 ? `${i.summary.slice(0, 90)}…` : i.summary}</Link></td>
                  <td className="small">{INCIDENT_CATEGORY_LABEL[i.category]}</td>
                  <td className="small">{words(i.source)}</td>
                  <td className="small">{dayAndTime(i.createdAt)}</td>
                  <td><Pill tone={SEVERITY_TONE[i.severity]}>{words(i.severity)}</Pill></td>
                  <td><Pill tone={INCIDENT_STATUS_TONE[i.status]}>{INCIDENT_STATUS_LABEL[i.status]}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.hasNextPage ? <button className="btn secondary" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more</button> : null}
      {creating && cityId ? <CreateIncident cityId={cityId} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function CreateIncident({ cityId: initialCity, onClose }: { cityId: string; onClose: () => void }) {
  const { staff } = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const cities = citiesFor(staff.principal, "incident:manage", CITIES);
  const [f, setF] = useState({ cityId: initialCity, category: "OTHER" as IncidentCategory, severity: "HIGH" as IncidentSeverity, summary: "", tripId: "", users: "", ticketId: "" });
  const [key] = useState(newIdempotencyKey);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const users = uuids(f.users);
  const ok = f.summary.trim().length >= 5 && (!f.tripId.trim() || isUuid(f.tripId)) && (!f.ticketId.trim() || isUuid(f.ticketId)) && users.every(isUuid);
  const create = useMutation({
    mutationFn: () => supportApi.openIncident({
      category: f.category, severity: f.severity, summary: f.summary.trim(), cityId: f.cityId,
      ...(f.tripId.trim() ? { tripId: f.tripId.trim().toLowerCase() } : {}),
      ...(users.length ? { subjectUserIds: users } : {}),
      ...(f.ticketId.trim() ? { ticketId: f.ticketId.trim().toLowerCase() } : {}),
    }, key),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ["incidents"] }); navigate(`/staff/safety/incidents/${r.incident.id}`); },
  });
  return (
    <Drawer title="Open an incident" onClose={onClose}>
      <form className="stack" style={{ gap: "0.5rem" }} onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Problem error={create.error} />
        {cities.length > 1 ? (
          <SelectField label="City" value={f.cityId} onChange={(e) => set("cityId", e.target.value)}>
            {cities.map((c) => <option key={c} value={c}>{CITY_NAMES[c] ?? c}</option>)}
          </SelectField>
        ) : null}
        <SelectField label="Category" value={f.category} onChange={(e) => set("category", e.target.value)}>
          {INCIDENT_CATEGORIES.map((c) => <option key={c} value={c}>{INCIDENT_CATEGORY_LABEL[c]}</option>)}
        </SelectField>
        <SelectField label="Severity" value={f.severity} onChange={(e) => set("severity", e.target.value)}>
          {INCIDENT_SEVERITIES.map((s) => <option key={s} value={s}>{words(s)}</option>)}
        </SelectField>
        <TextArea label="Summary" value={f.summary} onChange={(e) => set("summary", e.target.value)} rows={3} />
        <Field label="Trip id (optional)" value={f.tripId} onChange={(e) => set("tripId", e.target.value)} />
        <Field label="People involved (user ids, optional)" value={f.users} onChange={(e) => set("users", e.target.value)} hint="Separate with spaces or commas." />
        <Field label="From safety ticket (id, optional)" value={f.ticketId} onChange={(e) => set("ticketId", e.target.value)} hint="Its trip and people are copied." />
        <button className="btn" disabled={!ok || create.isPending}>Open incident</button>
      </form>
    </Drawer>
  );
}

// ── one incident ─────────────────────────────────────────────────────────────

export function IncidentPage() {
  const { id = "" } = useParams();
  const { staff } = useSession();
  const p = staff.principal;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["incidents", "one", id], refetchInterval: 20_000, queryFn: () => supportApi.incident(id) });
  const done = () => void qc.invalidateQueries({ queryKey: ["incidents"] });
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: done });
  const [note, setNote] = useState("");
  const [owner, setOwner] = useState("");
  const [action, setAction] = useState({ userId: "", kind: "SUSPENDED" as IncidentActionKind, until: "", reference: "", note: "" });
  const [outcome, setOutcome] = useState<IncidentOutcome>("CLEARED");
  const [outcomeNote, setOutcomeNote] = useState("");

  if (q.isPending) return <div className="page"><p className="small muted">Loading the incident…</p></div>;
  if (!q.data) return <div className="page stack"><PageHead title="Incident" /><Problem error={q.error} /><Link to="/staff/safety/incidents">Back to incidents</Link></div>;
  const { incident: i, notes, actions, sosAlerts, tickets } = q.data;
  const canManage = allowed(p, "incident:manage", { cityId: i.cityId });
  const live = i.status !== "RESOLVED";
  const untilIso = action.until ? addisLocalToIso(action.until) : null;
  const actionOk = isUuid(action.userId) && (!action.until || !!untilIso);

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title={<>Incident #{i.ref}</>}
        lede={<>{INCIDENT_CATEGORY_LABEL[i.category]} · {CITY_NAMES[i.cityId] ?? i.cityId} · opened {dayAndTime(i.createdAt)} ({words(i.source)})</>}
        right={<><Pill tone={SEVERITY_TONE[i.severity]}>{words(i.severity)}</Pill><Pill tone={INCIDENT_STATUS_TONE[i.status]}>{INCIDENT_STATUS_LABEL[i.status]}</Pill></>}
      />
      <Problem error={act.error ?? q.error} />
      <div className="two-col wide-left">
        <div className="stack" style={{ gap: "1rem" }}>
          <div className="card">
            <div className="card-head"><h2>Summary</h2></div>
            <div className="card-body">
              <p style={{ marginTop: 0, whiteSpace: "pre-wrap" }}>{i.summary}</p>
              <dl className="kv">
                <dt>Trip</dt><dd>{i.tripId ? <Link to={`/staff/trips/${i.tripId}`} className="mono">{shortId(i.tripId)}</Link> : "—"}</dd>
                <dt>People</dt><dd>{i.subjectUserIds.length ? i.subjectUserIds.map((u) => <Link key={u} to={`/staff/safety?user=${u}`} className="mono" style={{ marginRight: "0.5rem" }}>{shortId(u)}</Link>) : "—"}</dd>
                <dt>Owner</dt><dd>{i.ownerUserId ? (i.ownerUserId === p?.userId ? "you" : <span className="mono">{shortId(i.ownerUserId)}</span>) : "nobody"}</dd>
                {i.outcome ? <><dt>Outcome</dt><dd>{INCIDENT_OUTCOME_LABEL[i.outcome]}{i.outcomeNote ? <div className="small muted">{i.outcomeNote}</div> : null}</dd></> : null}
                {i.resolvedAt ? <><dt>Resolved</dt><dd className="small">{dayAndTime(i.resolvedAt)}{i.resolvedBy ? ` by ${shortId(i.resolvedBy)}` : ""}</dd></> : null}
              </dl>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>Investigation notes</h2></div>
            <div className="card-body stack" style={{ gap: "0.5rem" }}>
              {notes.length === 0 ? <p className="small muted">No notes yet.</p> : null}
              {notes.map((n) => (
                <div key={n.id} className="card pad">
                  <div className="xs muted">{n.authorUserId === p?.userId ? "You" : shortId(n.authorUserId)} · {dayAndTime(n.createdAt)}</div>
                  <p style={{ margin: "0.25rem 0 0", whiteSpace: "pre-wrap" }}>{n.body}</p>
                </div>
              ))}
              {canManage ? (
                <form className="stack" style={{ gap: "0.5rem" }} onSubmit={(e) => { e.preventDefault(); act.mutate(() => supportApi.incidentNote(id, note.trim())); setNote(""); }}>
                  <TextArea label="Add a note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Statements, evidence checked (GPS trace, ratings), calls made" />
                  <button className="btn secondary sm" disabled={!note.trim() || act.isPending}>Add note</button>
                </form>
              ) : null}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h2>Linked</h2></div>
            <div className="card-body stack" style={{ gap: "0.5rem" }}>
              {sosAlerts.length === 0 && tickets.length === 0 ? <p className="small muted">Nothing linked.</p> : null}
              {sosAlerts.map((a) => (
                <p key={a.id} className="small" style={{ margin: 0 }}>
                  SOS by the {a.role === "DRIVER" ? "driver" : "rider"} · {dayAndTime(a.triggeredAt)} · <Pill tone={SOS_STATUS_TONE[a.status]}>{SOS_STATUS_LABEL[a.status]}</Pill>
                  {a.outcome ? ` · ${SOS_OUTCOME_LABEL[a.outcome]}` : ""} · <Link to="/staff/safety/sos">SOS queue</Link>
                </p>
              ))}
              {tickets.map((t) => (
                <p key={t.id} className="small" style={{ margin: 0 }}>
                  Ticket <Link to={`/staff/support/tickets/${t.id}`}>#{t.ref} {t.subject}</Link> · {CATEGORY_LABEL[t.category]} · <Pill tone={TICKET_STATUS_TONE[t.status]}>{TICKET_STATUS_LABEL[t.status]}</Pill>
                </p>
              ))}
            </div>
          </div>
        </div>

        <div className="stack" style={{ gap: "1rem" }}>
          {canManage && live ? (
            <div className="card">
              <div className="card-head"><h2>Triage</h2></div>
              <div className="card-body stack" style={{ gap: "0.5rem" }}>
                <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
                  <SelectField label="Severity" value={i.severity} onChange={(e) => act.mutate(() => supportApi.updateIncident(id, { severity: e.target.value as IncidentSeverity }))}>
                    {INCIDENT_SEVERITIES.map((s) => <option key={s} value={s}>{words(s)}</option>)}
                  </SelectField>
                  <SelectField label="Category" value={i.category} onChange={(e) => act.mutate(() => supportApi.updateIncident(id, { category: e.target.value as IncidentCategory }))}>
                    {INCIDENT_CATEGORIES.map((c) => <option key={c} value={c}>{INCIDENT_CATEGORY_LABEL[c]}</option>)}
                  </SelectField>
                </div>
                <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
                  {i.status === "OPEN" ? <button className="btn secondary sm" disabled={act.isPending} onClick={() => act.mutate(() => supportApi.updateIncident(id, { status: "INVESTIGATING", ...(i.ownerUserId ? {} : { ownerUserId: p?.userId ?? null }) }))}>Start investigating</button> : null}
                  {i.ownerUserId !== p?.userId ? <button className="btn ghost sm" disabled={act.isPending} onClick={() => act.mutate(() => supportApi.updateIncident(id, { ownerUserId: p?.userId ?? null }))}>Make me the owner</button> : null}
                </div>
                <form className="row" style={{ gap: "0.5rem", alignItems: "flex-end" }} onSubmit={(e) => { e.preventDefault(); act.mutate(() => supportApi.updateIncident(id, { ownerUserId: owner.trim().toLowerCase() })); setOwner(""); }}>
                  <Field label="Owner (staff user id)" value={owner} onChange={(e) => setOwner(e.target.value)} />
                  <button className="btn secondary sm" disabled={!isUuid(owner) || act.isPending}>Set</button>
                </form>
              </div>
            </div>
          ) : null}

          <div className="card">
            <div className="card-head"><h2>Actions taken</h2></div>
            <div className="card-body stack" style={{ gap: "0.5rem" }}>
              {actions.length === 0 ? <p className="small muted">None recorded.</p> : null}
              {actions.map((a) => (
                <p key={a.id} className="small" style={{ margin: 0 }}>
                  <strong>{ACTION_LABEL[a.kind]}</strong> · <span className="mono">{shortId(a.userId)}</span>{a.until ? ` until ${dayAndTime(a.until)}` : ""}{a.reference ? ` · ref ${a.reference}` : ""}
                  <span className="xs muted"> · {dayAndTime(a.createdAt)}</span>{a.note ? <><br /><span className="xs muted">{a.note}</span></> : null}
                </p>
              ))}
              {canManage ? (
                <form className="stack" style={{ gap: "0.5rem" }} onSubmit={(e) => {
                  e.preventDefault();
                  act.mutate(() => supportApi.incidentAction(id, {
                    userId: action.userId.trim().toLowerCase(), kind: action.kind,
                    ...(untilIso ? { until: untilIso } : {}), ...(action.reference.trim() ? { reference: action.reference.trim() } : {}), ...(action.note.trim() ? { note: action.note.trim() } : {}),
                  }));
                  setAction({ userId: "", kind: "SUSPENDED", until: "", reference: "", note: "" });
                }}>
                  <Notice>Suspend or reinstate people on the <Link to="/staff/safety">Suspend</Link> page (auth-service ends their sessions at once), then record it here.</Notice>
                  <Field label="Person (user id)" value={action.userId} onChange={(e) => setAction((x) => ({ ...x, userId: e.target.value }))} />
                  <SelectField label="What was done" value={action.kind} onChange={(e) => setAction((x) => ({ ...x, kind: e.target.value as IncidentActionKind }))}>
                    {INCIDENT_ACTION_KINDS.map((k) => <option key={k} value={k}>{ACTION_LABEL[k]}</option>)}
                  </SelectField>
                  {action.kind === "SUSPENDED" ? <Field label="Until (Addis Ababa time, optional)" type="datetime-local" value={action.until} onChange={(e) => setAction((x) => ({ ...x, until: e.target.value }))} /> : null}
                  <Field label="Reference (optional)" value={action.reference} onChange={(e) => setAction((x) => ({ ...x, reference: e.target.value }))} placeholder="police case number" />
                  <TextArea label="Note (optional)" value={action.note} onChange={(e) => setAction((x) => ({ ...x, note: e.target.value }))} rows={2} />
                  <button className="btn secondary sm" disabled={!actionOk || act.isPending}>Record action</button>
                </form>
              ) : null}
            </div>
          </div>

          {canManage && live ? (
            <form className="card pad stack" style={{ gap: "0.5rem" }} onSubmit={(e) => { e.preventDefault(); act.mutate(() => supportApi.resolveIncident(id, outcome, outcomeNote.trim())); }}>
              <h3 className="section-title">Resolve</h3>
              <SelectField label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as IncidentOutcome)}>
                {INCIDENT_OUTCOMES.map((o) => <option key={o} value={o}>{INCIDENT_OUTCOME_LABEL[o]}</option>)}
              </SelectField>
              <TextArea label="Decision and reasons" value={outcomeNote} onChange={(e) => setOutcomeNote(e.target.value)} rows={3} />
              <button className="btn" disabled={outcomeNote.trim().length < 5 || act.isPending}>Resolve incident</button>
            </form>
          ) : null}
          {!canManage ? <Notice>You can't change incidents in this city.</Notice> : null}
        </div>
      </div>
    </div>
  );
}
