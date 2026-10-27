// Support tickets (workflow 13): the city queue with filters, one ticket with its thread (staff ↔
// requester, plus internal notes only staff see), and the agent's actions. Refunds themselves are
// asked for under Rider payments (payment-service); the refund id is linked here.

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { allowed, citiesFor, newIdempotencyKey } from "../../lib/api";
import { CITIES, CITY_NAMES, birr, dayAndTime, shortId } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import {
  CATEGORY_LABEL, DEFAULT_PRIORITY, PRIORITIES, PRIORITY_TONE, REFUND_STATUS_TONE, REQUESTER_LABEL, RESOLUTIONS, RESOLUTION_LABEL, SLA_MINUTES,
  SOURCE_LABEL, TICKET_CATEGORIES, TICKET_STATUSES, TICKET_STATUS_LABEL, TICKET_STATUS_TONE, LOST_LABEL, LOST_TONE,
  isUuid, minutesWords, slaWords, supportApi, words,
  type Priority, type Resolution, type Ticket, type TicketCategory, type TicketFilters,
} from "../../lib/support";
import { Drawer, Empty, Field, Notice, PageHead, Pill, Problem, SelectField, TextArea } from "../../components/ui";

const PAGE = 50;
const REOPEN_DAYS = 7;

function TicketPills({ t, now }: { t: Ticket; now: number }) {
  const sla = slaWords(t, now);
  return (
    <span className="row" style={{ gap: "0.35rem", flexWrap: "wrap" }}>
      <Pill tone={PRIORITY_TONE[t.priority]} pulse={t.priority === "P1" && t.status === "OPEN"}>{t.priority}</Pill>
      <Pill tone={TICKET_STATUS_TONE[t.status]}>{TICKET_STATUS_LABEL[t.status]}</Pill>
      {t.overdue || sla.late ? <Pill tone="red">{sla.text}</Pill> : null}
    </span>
  );
}

// ── list ─────────────────────────────────────────────────────────────────────

export function TicketsPage() {
  const { staff } = useSession();
  const p = staff.principal;
  const now = useNow(60_000);
  const cities = citiesFor(p, "ticket:read", CITIES);
  const [f, setF] = useState<TicketFilters>({ status: "", category: "", priority: "", assignee: "", overdue: false, q: "" });
  const [cityId, setCityId] = useState("");
  const [creating, setCreating] = useState(false);
  const set = (k: keyof TicketFilters, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const filters: TicketFilters = { ...f, cityId: cityId || null, q: f.q?.trim() };
  const list = useInfiniteQuery({
    queryKey: ["support", "tickets", filters],
    refetchInterval: 30_000,
    initialPageParam: "",
    getNextPageParam: (last: { next: string | null }) => last.next ?? undefined,
    queryFn: ({ pageParam }) => supportApi.tickets(filters, pageParam || undefined, PAGE),
  });
  const rows = list.data?.pages.flatMap((pg) => pg.tickets) ?? [];
  const canCreate = CITIES.some((c) => allowed(p, "ticket:create", { cityId: c }));
  const filtered = !!(f.status || f.category || f.priority || f.assignee || f.overdue || f.q || cityId);

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Support tickets"
        lede="Every problem riders, drivers and companies report, with its first-response deadline. Safety tickets go to the safety officers too."
        right={canCreate ? <button className="btn" onClick={() => setCreating(true)}><Plus /> Log ticket for a caller</button> : null}
      />
      <div className="chips">
        {["", ...TICKET_STATUSES].map((s) => (
          <button key={s} className="chip" aria-pressed={f.status === s} onClick={() => set("status", s)}>{s ? TICKET_STATUS_LABEL[s as Ticket["status"]] : "All"}</button>
        ))}
        <button className="chip" aria-pressed={!!f.overdue} onClick={() => set("overdue", !f.overdue)}>Overdue</button>
      </div>
      <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
        {cities.length > 1 ? (
          <SelectField label="City" value={cityId} onChange={(e) => setCityId(e.target.value)}>
            <option value="">All my cities</option>
            {cities.map((c) => <option key={c} value={c}>{CITY_NAMES[c] ?? c}</option>)}
          </SelectField>
        ) : null}
        <SelectField label="Category" value={f.category} onChange={(e) => set("category", e.target.value)}>
          <option value="">Any</option>
          {TICKET_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
        </SelectField>
        <SelectField label="Priority" value={f.priority} onChange={(e) => set("priority", e.target.value)}>
          <option value="">Any</option>
          {PRIORITIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </SelectField>
        <SelectField label="Assigned" value={f.assignee} onChange={(e) => set("assignee", e.target.value)}>
          <option value="">Anyone</option>
          <option value="me">To me</option>
          <option value="none">Nobody</option>
        </SelectField>
        <Field label="Search" value={f.q} onChange={(e) => set("q", e.target.value)} placeholder="words or ticket number" />
        {filtered ? <button className="btn ghost" onClick={() => { setF({ status: "", category: "", priority: "", assignee: "", overdue: false, q: "" }); setCityId(""); }}>Clear filters</button> : null}
      </div>
      <Problem error={list.error} />
      {list.isPending ? <p className="small muted">Loading tickets…</p> : null}
      {list.isSuccess && rows.length === 0 ? <Empty title={filtered ? "No tickets match." : "No tickets. Nice."} /> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>#</th><th>Subject</th><th>Category</th><th>From</th><th>Opened</th><th>Response</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((t) => {
                const sla = slaWords(t, now);
                return (
                  <tr key={t.id}>
                    <td className="mono"><Link to={`/staff/support/tickets/${t.id}`}>{t.ref}</Link></td>
                    <td><Link to={`/staff/support/tickets/${t.id}`}>{t.subject}</Link><div className="xs muted">{CITY_NAMES[t.cityId] ?? t.cityId}{t.assigneeUserId ? ` · ${t.assigneeUserId === p?.userId ? "yours" : `with ${shortId(t.assigneeUserId)}`}` : " · unassigned"}</div></td>
                    <td className="small">{CATEGORY_LABEL[t.category]}</td>
                    <td className="small">{REQUESTER_LABEL[t.requester.kind]} <span className="xs muted">{SOURCE_LABEL[t.source]}</span></td>
                    <td className="small">{dayAndTime(t.createdAt)}</td>
                    <td className="small" style={sla.late || t.overdue ? { color: "var(--danger)", fontWeight: 600 } : undefined}>{sla.text}</td>
                    <td><Pill tone={PRIORITY_TONE[t.priority]}>{t.priority}</Pill> <Pill tone={TICKET_STATUS_TONE[t.status]}>{TICKET_STATUS_LABEL[t.status]}</Pill></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.hasNextPage ? (
        <div className="row" style={{ gap: "0.5rem" }}>
          <button className="btn secondary" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? "Loading…" : "Load more"}</button>
          <span className="small muted">{rows.length} shown</span>
        </div>
      ) : null}
      {creating ? <CreateTicket onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function CreateTicket({ onClose }: { onClose: () => void }) {
  const { staff } = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const cities = citiesFor(staff.principal, "ticket:create", CITIES);
  const [form, setForm] = useState({ requesterUserId: "", tripId: "", cityId: cities[0] ?? "", category: "TRIP" as TicketCategory, subject: "", description: "" });
  const [key] = useState(newIdempotencyKey);
  const set = (k: keyof typeof form, v: string) => setForm((x) => ({ ...x, [k]: v }));
  const tripId = form.tripId.trim();
  const create = useMutation({
    mutationFn: () => supportApi.createTicket({
      requesterUserId: form.requesterUserId.trim().toLowerCase(), category: form.category, subject: form.subject.trim(), description: form.description.trim(), source: "PHONE",
      ...(tripId ? { tripId: tripId.toLowerCase() } : { cityId: form.cityId }),
    }, key),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["support"] });
      navigate(`/staff/support/tickets/${r.ticket.id}`);
    },
  });
  const ok = isUuid(form.requesterUserId) && (!tripId || isUuid(tripId)) && (tripId || form.cityId) && form.subject.trim().length >= 3 && form.description.trim().length >= 3;
  return (
    <Drawer title="Log a ticket for a caller" onClose={onClose}>
      <form className="stack" style={{ gap: "0.5rem" }} onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Problem error={create.error} />
        <Field label="Caller's user id" value={form.requesterUserId} onChange={(e) => set("requesterUserId", e.target.value)} placeholder="find them under Users" hint="They see the ticket and your replies in the app." />
        <Field label="Trip id (optional)" value={form.tripId} onChange={(e) => set("tripId", e.target.value)} hint="With a trip, the ticket goes to the trip's city." />
        {!tripId && cities.length > 1 ? (
          <SelectField label="City" value={form.cityId} onChange={(e) => set("cityId", e.target.value)}>
            {cities.map((c) => <option key={c} value={c}>{CITY_NAMES[c] ?? c}</option>)}
          </SelectField>
        ) : null}
        <SelectField label="Category" value={form.category} onChange={(e) => set("category", e.target.value)}>
          {TICKET_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]} · {DEFAULT_PRIORITY[c]}, answer within {minutesWords(SLA_MINUTES[c])}</option>)}
        </SelectField>
        {form.category === "SAFETY" ? <Notice tone="error">Safety tickets are P1 and open an incident for the safety officers. If someone is in danger now, call the police first.</Notice> : null}
        <Field label="Subject" value={form.subject} onChange={(e) => set("subject", e.target.value)} placeholder="Charged twice for one trip" />
        <TextArea label="What happened" value={form.description} onChange={(e) => set("description", e.target.value)} rows={5} />
        <button className="btn" disabled={!ok || create.isPending}>{create.isPending ? "Saving…" : "Create ticket"}</button>
      </form>
    </Drawer>
  );
}

// ── one ticket ───────────────────────────────────────────────────────────────

export function TicketPage() {
  const { id = "" } = useParams();
  const { staff } = useSession();
  const p = staff.principal;
  const now = useNow(30_000);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["support", "ticket", id], refetchInterval: 15_000, queryFn: () => supportApi.ticket(id) });
  const done = () => void qc.invalidateQueries({ queryKey: ["support"] });
  const act = useMutation({ mutationFn: (f: () => Promise<unknown>) => f(), onSuccess: done });

  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);
  const [assignee, setAssignee] = useState("");
  const [resolution, setResolution] = useState<Resolution>("EXPLAINED");
  const [resolveNote, setResolveNote] = useState("");
  const [reopenReason, setReopenReason] = useState("");
  const [refundId, setRefundId] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const send = useMutation({
    mutationFn: () => supportApi.message(id, reply.trim(), internal),
    onSuccess: () => { setReply(""); done(); },
  });

  if (q.isPending) return <div className="page"><p className="small muted">Loading the ticket…</p></div>;
  if (!q.data) return <div className="page stack"><PageHead title="Ticket" /><Problem error={q.error} /><Link to="/staff/support/tickets">Back to tickets</Link></div>;
  const { ticket: t, messages, refunds, lostItem } = q.data;
  const canUpdate = allowed(p, "ticket:update", { cityId: t.cityId });
  const live = t.status !== "RESOLVED" && t.status !== "CLOSED";
  const sla = slaWords(t, now);
  const reopenOpen = t.status === "RESOLVED" && !!t.resolvedAt && now - new Date(t.resolvedAt).getTime() < REOPEN_DAYS * 86_400_000;
  const amountMinor = refundAmount.trim() ? Math.round(Number(refundAmount) * 100) : undefined;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title={<>#{t.ref} · {t.subject}</>}
        lede={<>{CATEGORY_LABEL[t.category]} · {CITY_NAMES[t.cityId] ?? t.cityId} · opened {dayAndTime(t.createdAt)} {SOURCE_LABEL[t.source]}</>}
        right={<TicketPills t={t} now={now} />}
      />
      <Problem error={act.error ?? q.error} />
      <div className="two-col wide-left">
        <div className="stack" style={{ gap: "1rem" }}>
          <div className="card">
            <div className="card-head"><h2>Conversation</h2></div>
            <div className="card-body stack" style={{ gap: "0.75rem" }}>
              <div className="card pad" style={{ background: "var(--surface-2)" }}>
                <div className="xs muted">{REQUESTER_LABEL[t.requester.kind]} · {dayAndTime(t.createdAt)}</div>
                <p style={{ margin: "0.25rem 0 0", whiteSpace: "pre-wrap" }}>{t.description}</p>
              </div>
              {messages.map((m) => (
                <div key={m.id} className="card pad" style={m.internal ? { background: "var(--warning-soft)", borderStyle: "dashed" } : m.authorKind === "STAFF" ? { background: "var(--accent-soft)" } : undefined}>
                  <div className="xs muted">
                    {m.authorKind === "REQUESTER" ? REQUESTER_LABEL[t.requester.kind] : m.authorKind === "SYSTEM" ? "System" : m.authorUserId === p?.userId ? "You" : `Staff ${m.authorUserId ? shortId(m.authorUserId) : ""}`}
                    {m.internal ? " · internal note, staff only" : ""} · {dayAndTime(m.createdAt)}
                  </div>
                  <p style={{ margin: "0.25rem 0 0", whiteSpace: "pre-wrap" }}>{m.body}</p>
                </div>
              ))}
              {canUpdate && t.status !== "CLOSED" ? (
                <form className="stack" style={{ gap: "0.5rem" }} onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
                  <Problem error={send.error} />
                  <TextArea label={internal ? "Internal note (only staff see it)" : "Reply to the person"} value={reply} onChange={(e) => setReply(e.target.value)} rows={3}
                    hint={internal ? undefined : "They see it in the app. Never share phone numbers."} />
                  <div className="row" style={{ gap: "0.75rem" }}>
                    <label className="row small" style={{ gap: "0.4rem" }}><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note</label>
                    <button className={internal ? "btn secondary" : "btn"} disabled={!reply.trim() || send.isPending}>{internal ? "Add note" : "Send reply"}</button>
                  </div>
                </form>
              ) : null}
            </div>
          </div>
        </div>

        <div className="stack" style={{ gap: "1rem" }}>
          <div className="card">
            <div className="card-head"><h2>Details</h2></div>
            <div className="card-body">
              <dl className="kv">
                <dt>Requester</dt><dd>{REQUESTER_LABEL[t.requester.kind]} <span className="mono xs">{shortId(t.requester.userId)}</span>{t.requester.orgId ? <span className="xs muted"> · org {shortId(t.requester.orgId)}</span> : null}</dd>
                <dt>Trip</dt><dd>{t.tripId ? <Link to={`/staff/trips/${t.tripId}`} className="mono">{shortId(t.tripId)}</Link> : "—"}</dd>
                <dt>Assigned</dt><dd>{t.assigneeUserId ? (t.assigneeUserId === p?.userId ? "you" : <span className="mono">{shortId(t.assigneeUserId)}</span>) : "nobody"}</dd>
                <dt>First answer</dt><dd style={sla.late ? { color: "var(--danger)" } : undefined}>{t.firstRespondedAt ? dayAndTime(t.firstRespondedAt) : `${sla.text} (by ${dayAndTime(t.firstResponseDueAt)})`}</dd>
                {t.resolution ? <><dt>Decision</dt><dd>{RESOLUTION_LABEL[t.resolution]}{t.resolutionNote ? <div className="small muted">{t.resolutionNote}</div> : null}</dd></> : null}
                {t.resolvedAt ? <><dt>Resolved</dt><dd className="small">{dayAndTime(t.resolvedAt)}</dd></> : null}
                {t.closedAt ? <><dt>Closed</dt><dd className="small">{dayAndTime(t.closedAt)}</dd></> : null}
                {t.reopenCount ? <><dt>Reopened</dt><dd className="small">{t.reopenCount}×</dd></> : null}
                {t.incidentId ? <><dt>Incident</dt><dd><Link to={`/staff/safety/incidents/${t.incidentId}`}>open the incident</Link></dd></> : null}
              </dl>
              {lostItem ? (
                <p className="small" style={{ marginTop: "0.75rem" }}>Lost item: <Pill tone={LOST_TONE[lostItem.status]}>{LOST_LABEL[lostItem.status]}</Pill> <Link to="/staff/support/lost-items">Lost items</Link></p>
              ) : null}
            </div>
          </div>

          {canUpdate ? (
            <div className="card">
              <div className="card-head"><h2>Actions</h2></div>
              <div className="card-body stack" style={{ gap: "0.75rem" }}>
                {live ? (
                  <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
                    {t.assigneeUserId !== p?.userId ? <button className="btn secondary sm" disabled={act.isPending} onClick={() => act.mutate(() => supportApi.claim(id))}>Take it</button> : null}
                    {t.assigneeUserId ? <button className="btn ghost sm" disabled={act.isPending} onClick={() => act.mutate(() => supportApi.assign(id, null))}>Unassign</button> : null}
                    {t.status !== "IN_PROGRESS" ? <button className="btn ghost sm" disabled={act.isPending} onClick={() => act.mutate(() => supportApi.setStatus(id, "IN_PROGRESS"))}>Working on it</button> : null}
                    {t.status !== "WAITING_REQUESTER" ? <button className="btn ghost sm" disabled={act.isPending} onClick={() => act.mutate(() => supportApi.setStatus(id, "WAITING_REQUESTER"))}>Waiting for the person</button> : null}
                    <button className="btn ghost sm" disabled={act.isPending} onClick={() => act.mutate(() => supportApi.setStatus(id, "CLOSED"))}>Close without decision</button>
                  </div>
                ) : null}
                {live ? (
                  <form className="row" style={{ gap: "0.5rem", alignItems: "flex-end" }} onSubmit={(e) => { e.preventDefault(); act.mutate(() => supportApi.assign(id, assignee.trim().toLowerCase())); setAssignee(""); }}>
                    <Field label="Give to (staff user id)" value={assignee} onChange={(e) => setAssignee(e.target.value)} />
                    <button className="btn secondary sm" disabled={!isUuid(assignee) || act.isPending}>Assign</button>
                  </form>
                ) : null}
                {live ? (
                  <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
                    <SelectField label="Priority" value={t.priority} onChange={(e) => act.mutate(() => supportApi.updateTicket(id, { priority: e.target.value as Priority }))}>
                      {PRIORITIES.map((x) => <option key={x} value={x}>{x}</option>)}
                    </SelectField>
                    <SelectField label="Category" value={t.category} onChange={(e) => act.mutate(() => supportApi.updateTicket(id, { category: e.target.value as TicketCategory }))}>
                      {TICKET_CATEGORIES.map((x) => <option key={x} value={x}>{CATEGORY_LABEL[x]}</option>)}
                    </SelectField>
                  </div>
                ) : null}
                {live ? (
                  <form className="stack" style={{ gap: "0.5rem" }} onSubmit={(e) => { e.preventDefault(); act.mutate(() => supportApi.resolve(id, resolution, resolveNote.trim())); setResolveNote(""); }}>
                    <h3 className="section-title">Resolve</h3>
                    <SelectField label="Decision" value={resolution} onChange={(e) => setResolution(e.target.value as Resolution)}>
                      {RESOLUTIONS.map((x) => <option key={x} value={x}>{RESOLUTION_LABEL[x]}</option>)}
                    </SelectField>
                    {resolution === "ESCALATE_SAFETY" ? <p className="xs muted">Opens an incident for the safety officers if there is none.</p> : null}
                    <TextArea label="What you decided and why" value={resolveNote} onChange={(e) => setResolveNote(e.target.value)} rows={3} hint="The person sees the decision." />
                    <button className="btn" disabled={resolveNote.trim().length < 3 || act.isPending}>Resolve</button>
                  </form>
                ) : null}
                {reopenOpen ? (
                  <form className="row" style={{ gap: "0.5rem", alignItems: "flex-end" }} onSubmit={(e) => { e.preventDefault(); act.mutate(() => supportApi.reopen(id, reopenReason.trim())); setReopenReason(""); }}>
                    <Field label="Reopen: why" value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} />
                    <button className="btn secondary sm" disabled={reopenReason.trim().length < 3 || act.isPending}>Reopen</button>
                  </form>
                ) : t.status === "RESOLVED" ? <p className="xs muted">Resolved more than {REOPEN_DAYS} days ago: it can't be reopened.</p> : null}
              </div>
            </div>
          ) : <Notice>You can read this ticket but not change it.</Notice>}

          <div className="card">
            <div className="card-head"><h2>Refunds</h2></div>
            <div className="card-body stack" style={{ gap: "0.5rem" }}>
              {refunds.length === 0 ? <p className="small muted">None linked. Ask for a refund under <Link to="/staff/money/payments">Rider payments</Link>, then link its id here.</p> : null}
              {refunds.map((r) => (
                <p key={r.refundId} className="small" style={{ margin: 0 }}>
                  <span className="mono">{shortId(r.refundId)}</span> · {r.amountMinor !== null ? birr(r.amountMinor) : "amount not given"} · <Pill tone={REFUND_STATUS_TONE[r.status]}>{words(r.status)}</Pill>
                  {r.note ? <span className="xs muted"> · {r.note}</span> : null}
                </p>
              ))}
              {canUpdate ? (
                <form className="row" style={{ gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap" }} onSubmit={(e) => {
                  e.preventDefault();
                  act.mutate(() => supportApi.linkRefund(id, { refundId: refundId.trim().toLowerCase(), ...(amountMinor ? { amountMinor } : {}) }));
                  setRefundId(""); setRefundAmount("");
                }}>
                  <Field label="Refund id" value={refundId} onChange={(e) => setRefundId(e.target.value)} />
                  <Field label="Amount (ETB, optional)" inputMode="decimal" value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} />
                  <button className="btn secondary sm" disabled={!isUuid(refundId) || (amountMinor !== undefined && !(amountMinor > 0)) || act.isPending}>Link refund</button>
                </form>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
