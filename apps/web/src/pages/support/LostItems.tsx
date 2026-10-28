// Lost items (workflow 13 §D): riders report, the driver (or their fleet) answers found / not found
// in the app, support arranges the return through messages. Nobody's phone number is shown here:
// the thread is the only channel (masked calls are not built yet).

import { useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { allowed } from "../../lib/api";
import { CITY_NAMES, dayAndTime, shortId } from "../../lib/format";
import { useStaffCity } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { LOST_ITEM_STATUSES, LOST_LABEL, LOST_NEXT, LOST_TONE, supportApi, type LostItemStatus } from "../../lib/support";
import { CityPicker } from "../../components/CityPicker";
import { Drawer, Empty, Notice, PageHead, Pill, Problem, TextArea } from "../../components/ui";

const AUTHOR: Record<string, string> = { RIDER: "Rider", DRIVER: "Driver", FLEET: "Fleet", STAFF: "Support" };

export function LostItemsPage() {
  const { cities, cityId, setCityId } = useStaffCity("lost_item:manage");
  const [status, setStatus] = useState<LostItemStatus | "">("REPORTED");
  const [open, setOpen] = useState<string | null>(null);
  const list = useInfiniteQuery({
    queryKey: ["support", "lost-items", cityId, status],
    enabled: !!cityId,
    refetchInterval: 30_000,
    initialPageParam: "",
    getNextPageParam: (last: { next: string | null }) => last.next ?? undefined,
    queryFn: ({ pageParam }) => supportApi.lostItems({ cityId, status }, pageParam || undefined),
  });
  const rows = list.data?.pages.flatMap((p) => p.lostItems) ?? [];

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Lost items"
        lede="Things riders left in a car. The driver answers in the app; you help arrange the return. Reports not found after 48 hours close on their own."
        right={<CityPicker cities={cities} value={cityId} onChange={setCityId} />}
      />
      {!cityId ? <Notice>You don't handle lost items in any city.</Notice> : null}
      <div className="chips">
        {(["", ...LOST_ITEM_STATUSES] as const).map((s) => (
          <button key={s} className="chip" aria-pressed={status === s} onClick={() => setStatus(s)}>{s ? LOST_LABEL[s] : "All"}</button>
        ))}
      </div>
      <Problem error={list.error} />
      {list.isPending && cityId ? <p className="small muted">Loading…</p> : null}
      {list.isSuccess && rows.length === 0 ? <Empty title="Nothing here." /> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Reported</th><th>Item</th><th>Trip</th><th>Driver's answer</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id} className="clickable" onClick={() => setOpen(l.id)}>
                  <td className="small">{dayAndTime(l.createdAt)}</td>
                  <td>{l.description.length > 80 ? `${l.description.slice(0, 80)}…` : l.description}</td>
                  <td><Link to={`/staff/trips/${l.tripId}`} className="mono" onClick={(e) => e.stopPropagation()}>{shortId(l.tripId)}</Link></td>
                  <td className="small">{l.respondedAt ? dayAndTime(l.respondedAt) : <span className="muted">no answer yet</span>}{l.driverNotFoundCount > 1 ? <div className="xs" style={{ color: "var(--danger)" }}>{l.driverNotFoundCount} "not found" lately</div> : null}</td>
                  <td><Pill tone={LOST_TONE[l.status]}>{LOST_LABEL[l.status]}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.hasNextPage ? <button className="btn secondary" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more</button> : null}
      {open ? <LostItemDrawer id={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function LostItemDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { staff } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["support", "lost-item", id], refetchInterval: 15_000, queryFn: () => supportApi.lostItem(id) });
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const done = () => void qc.invalidateQueries({ queryKey: ["support"] });
  const send = useMutation({ mutationFn: () => supportApi.lostItemMessage(id, body.trim()), onSuccess: () => { setBody(""); done(); } });
  const move = useMutation({ mutationFn: (s: LostItemStatus) => supportApi.lostItemStatus(id, s, note.trim() || undefined), onSuccess: () => { setNote(""); done(); } });
  const d = q.data;
  const l = d?.lostItem;
  const canManage = !!l && allowed(staff.principal, "lost_item:manage", { cityId: l.cityId });

  return (
    <Drawer title={l ? `Lost item · ${LOST_LABEL[l.status]}` : "Lost item"} onClose={onClose} wide>
      <Problem error={q.error ?? move.error} />
      {l && d ? (
        <div className="stack" style={{ gap: "0.75rem" }}>
          <dl className="kv">
            <dt>Item</dt><dd style={{ whiteSpace: "pre-wrap" }}>{l.description}</dd>
            <dt>Status</dt><dd><Pill tone={LOST_TONE[l.status]}>{LOST_LABEL[l.status]}</Pill></dd>
            <dt>Trip</dt><dd><Link to={`/staff/trips/${l.tripId}`} className="mono">{shortId(l.tripId)}</Link> · {CITY_NAMES[l.cityId] ?? l.cityId}</dd>
            <dt>Rider</dt><dd className="mono">{shortId(l.riderUserId)}</dd>
            <dt>Driver</dt><dd className="mono">{l.driverUserId ? shortId(l.driverUserId) : "—"}{l.fleetOrgId ? <span className="xs muted"> · fleet {shortId(l.fleetOrgId)}</span> : null}</dd>
            {l.driverNote ? <><dt>Driver says</dt><dd>{l.driverNote}</dd></> : null}
            <dt>Ticket</dt><dd><Link to={`/staff/support/tickets/${l.ticketId}`}>open the ticket</Link></dd>
            <dt>Reported</dt><dd className="small">{dayAndTime(l.createdAt)}</dd>
            {l.returnedAt ? <><dt>Returned</dt><dd className="small">{dayAndTime(l.returnedAt)}</dd></> : null}
            {l.closedAt ? <><dt>Closed</dt><dd className="small">{dayAndTime(l.closedAt)}</dd></> : null}
          </dl>
          {l.driverNotFoundCount > 1 ? (
            <Notice tone="error"><AlertTriangle size={14} /> This driver answered "not found" {l.driverNotFoundCount} times in the last 90 days. Consider a closer look.</Notice>
          ) : null}

          <section className="stack" style={{ gap: "0.5rem" }}>
            <h3 className="section-title">Messages</h3>
            {d.messages.length === 0 ? <p className="small muted">No messages yet.</p> : null}
            {d.messages.map((m) => (
              <div key={m.id} className="card pad" style={m.authorKind === "STAFF" ? { background: "var(--accent-soft)" } : undefined}>
                <div className="xs muted">{AUTHOR[m.authorKind] ?? m.authorKind}{"internal" in m && m.internal ? " · internal note" : ""} · {dayAndTime(m.createdAt)}</div>
                <p style={{ margin: "0.25rem 0 0", whiteSpace: "pre-wrap" }}>{m.body}</p>
              </div>
            ))}
            {canManage && l.status !== "CLOSED" ? (
              <form className="stack" style={{ gap: "0.5rem" }} onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
                <Problem error={send.error} />
                <TextArea label="Message to the rider and the driver" value={body} onChange={(e) => setBody(e.target.value)} rows={3} hint="Both see it. Agree a place and time; never share phone numbers." />
                <button className="btn secondary" disabled={!body.trim() || send.isPending}>Send</button>
              </form>
            ) : null}
          </section>

          {canManage && LOST_NEXT[l.status].length ? (
            <section className="stack" style={{ gap: "0.5rem" }}>
              <h3 className="section-title">Change status</h3>
              <TextArea label="Internal note (staff only)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} hint="Only staff see it. To tell the rider and the driver, send a message above." />
              <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
                {LOST_NEXT[l.status].map((s) => (
                  <button key={s} className={s === "RETURNED" ? "btn" : "btn secondary"} disabled={move.isPending} onClick={() => move.mutate(s)}>{LOST_LABEL[s]}</button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}
