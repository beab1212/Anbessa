// SOS queue (workflow 14): alerts from riders and drivers in the city, the oldest unanswered first.
// The staff console polls every 5 s: realtime-gateway only admits ride-app tokens, so there is no
// socket push to staff. Dispatchers (sos:respond only) acknowledge and add notes; safety officers
// (also incident:manage) resolve and open incidents.

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Siren } from "lucide-react";
import { allowed, newIdempotencyKey } from "../../lib/api";
import { CITY_NAMES, dayAndTime, shortId } from "../../lib/format";
import { useNow, useStaffCity } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import {
  SOS_OUTCOMES, SOS_OUTCOME_LABEL, SOS_STATUS_LABEL, SOS_STATUS_TONE, secondsSince, supportApi, waitingWords,
  type SosAlert, type SosOutcome,
} from "../../lib/support";
import { CityPicker } from "../../components/CityPicker";
import { CityMap } from "../../components/map/CityMap";
import { PickupMarker } from "../../components/map/markers";
import { Empty, Field, Notice, PageHead, Pill, Problem, SelectField, TextArea } from "../../components/ui";

export function SosQueuePage() {
  const { cities, cityId, setCityId } = useStaffCity("sos:respond");
  const [view, setView] = useState<"active" | "resolved">("active");
  const [picked, setPicked] = useState<string | null>(null);
  const now = useNow(1000);
  const q = useQuery({
    queryKey: ["sos", "queue", cityId, view],
    enabled: !!cityId,
    refetchInterval: 5000,
    queryFn: () => supportApi.sosQueue(cityId!, view).then((r) => r.alerts),
  });
  const alerts = q.data ?? [];
  const open = alerts.filter((a) => a.status === "OPEN").length;
  const selected = alerts.find((a) => a.id === picked) ?? alerts[0] ?? null;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title={<>SOS {open ? <Pill tone="red" pulse>{open} waiting</Pill> : null}</>}
        lede="Acknowledge within 60 seconds, then call the person. This page refreshes every 5 seconds; keep it open."
        right={<CityPicker cities={cities} value={cityId} onChange={setCityId} />}
      />
      {!cityId ? <Notice>You don't respond to SOS alerts in any city.</Notice> : null}
      <div className="tabs">
        <button aria-selected={view === "active"} onClick={() => setView("active")}>Active</button>
        <button aria-selected={view === "resolved"} onClick={() => setView("resolved")}>Resolved</button>
      </div>
      <Problem error={q.error} />
      {q.isSuccess && alerts.length === 0 ? <Empty title={view === "active" ? "No active alerts." : "No resolved alerts."} /> : null}
      {alerts.length ? (
        <div className="two-col wide-left">
          <div className="stack" style={{ gap: "0.75rem" }}>
            {selected ? <AlertPanel key={selected.id} alert={selected} now={now} /> : null}
          </div>
          <div className="stack" style={{ gap: "0.5rem" }}>
            {alerts.map((a) => {
              const waiting = secondsSince(a.triggeredAt, now);
              return (
                <button key={a.id} className={`card pad selectable ${selected?.id === a.id ? "selected" : ""}`} style={{ textAlign: "left", ...(a.status === "OPEN" ? { borderColor: "var(--danger)" } : {}) }} onClick={() => setPicked(a.id)}>
                  <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem" }}>
                    <strong className="row" style={{ gap: "0.35rem" }}>{a.status === "OPEN" ? <Siren size={16} color="var(--danger)" /> : null}{a.role === "DRIVER" ? "Driver" : "Rider"} · trip {shortId(a.tripId)}</strong>
                    <Pill tone={SOS_STATUS_TONE[a.status]} pulse={a.status === "OPEN"}>{SOS_STATUS_LABEL[a.status]}</Pill>
                  </div>
                  <div className="xs muted">
                    {a.status === "OPEN" ? <span style={a.ackOverdue ? { color: "var(--danger)", fontWeight: 600 } : undefined}>waiting {waitingWords(waiting)}{a.ackOverdue ? " · past 60 s" : ""}</span> : dayAndTime(a.triggeredAt)}
                    {a.outcome ? ` · ${SOS_OUTCOME_LABEL[a.outcome]}` : ""}{!a.tripVerified ? " · trip not verified" : ""}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AlertPanel({ alert: a, now }: { alert: SosAlert; now: number }) {
  const { staff } = useSession();
  const p = staff.principal;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["sos", "alert", a.id], refetchInterval: 5000, queryFn: () => supportApi.sos(a.id) });
  const done = () => void qc.invalidateQueries({ queryKey: ["sos"] });
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<SosOutcome>("ASSISTED");
  const [resolveNote, setResolveNote] = useState("");
  const [reference, setReference] = useState("");
  const [incidentKey] = useState(newIdempotencyKey);
  const ack = useMutation({ mutationFn: () => supportApi.acknowledge(a.id), onSuccess: done });
  const addNote = useMutation({ mutationFn: () => supportApi.sosNote(a.id, note.trim()), onSuccess: () => { setNote(""); done(); } });
  const resolve = useMutation({
    mutationFn: () => supportApi.resolveSos(a.id, { outcome, note: resolveNote.trim(), ...(reference.trim() ? { emergencyReference: reference.trim() } : {}) }),
    onSuccess: done,
  });
  const incident = useMutation({
    mutationFn: () => supportApi.openIncident({ sosAlertId: a.id, category: "OTHER", severity: a.outcome === "ESCALATED" ? "CRITICAL" : "HIGH", summary: `From SOS on trip ${shortId(a.tripId)}` }, incidentKey),
    onSuccess: (r) => { done(); void qc.invalidateQueries({ queryKey: ["incidents"] }); navigate(`/staff/safety/incidents/${r.incident.id}`); },
  });
  const canRespond = allowed(p, "sos:respond", { cityId: a.cityId });
  const canManage = allowed(p, "incident:manage", { cityId: a.cityId });
  const live = a.status !== "RESOLVED";
  const loc = a.location;

  return (
    <>
      <div style={{ height: "20rem", position: "relative" }}>
        <CityMap cityId={a.cityId} fit={[{ lat: loc.lat, lng: loc.lng }]} boxed>
          <PickupMarker lat={loc.lat} lng={loc.lng} tone="red" label={`SOS · ${a.role === "DRIVER" ? "driver" : "rider"}`} />
        </CityMap>
      </div>
      <p className="xs muted" style={{ margin: "-0.5rem 0 0" }}>
        Last position {dayAndTime(loc.at)}{loc.accuracy !== null ? ` · ±${Math.round(loc.accuracy)} m` : ""} · {loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}
      </p>
      <Problem error={detail.error ?? ack.error ?? resolve.error ?? incident.error} />
      <div className="card">
        <div className="card-head"><h2>Alert</h2></div>
        <div className="card-body stack" style={{ gap: "0.75rem" }}>
          <dl className="kv">
            <dt>Status</dt><dd><Pill tone={SOS_STATUS_TONE[a.status]} pulse={a.status === "OPEN"}>{SOS_STATUS_LABEL[a.status]}</Pill>{a.status === "OPEN" ? <span className="small"> · waiting {waitingWords(secondsSince(a.triggeredAt, now))}</span> : null}</dd>
            <dt>Pressed by</dt><dd>{a.role === "DRIVER" ? "the driver" : "the rider"} <span className="mono xs">{shortId(a.userId)}</span>{a.source === "SYSTEM" ? " (automatic)" : ""}</dd>
            <dt>Trip</dt><dd><Link to={`/staff/trips/${a.tripId}`} className="mono">{shortId(a.tripId)}</Link> · {CITY_NAMES[a.cityId] ?? a.cityId}{!a.tripVerified ? <span className="xs" style={{ color: "var(--danger)" }}> · trip-service was down; not verified</span> : null}</dd>
            <dt>Rider / driver</dt><dd className="mono xs">{a.riderUserId ? shortId(a.riderUserId) : "—"} / {a.driverUserId ? shortId(a.driverUserId) : "—"}</dd>
            <dt>Pressed</dt><dd className="small">{dayAndTime(a.triggeredAt)}</dd>
            {a.acknowledgedAt ? <><dt>Acknowledged</dt><dd className="small">{dayAndTime(a.acknowledgedAt)}{a.acknowledgedBy ? ` by ${a.acknowledgedBy === p?.userId ? "you" : shortId(a.acknowledgedBy)}` : ""}</dd></> : null}
            {a.outcome ? <><dt>Outcome</dt><dd>{SOS_OUTCOME_LABEL[a.outcome]}{a.resolutionNote ? <div className="small muted">{a.resolutionNote}</div> : null}</dd></> : null}
            {a.emergencyReference ? <><dt>Emergency ref.</dt><dd className="mono">{a.emergencyReference}</dd></> : null}
            {a.incidentId ? <><dt>Incident</dt><dd><Link to={`/staff/safety/incidents/${a.incidentId}`}>open the incident</Link></dd></> : null}
          </dl>
          {canRespond && a.status === "OPEN" ? <button className="btn danger lg" disabled={ack.isPending} onClick={() => ack.mutate()}>Acknowledge, I'm calling them</button> : null}
          {canManage && !a.incidentId ? <button className="btn secondary" disabled={incident.isPending} onClick={() => incident.mutate()}>Open an incident</button> : null}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Notes</h2></div>
        <div className="card-body stack" style={{ gap: "0.5rem" }}>
          {(detail.data?.notes ?? []).map((n) => (
            <p key={n.id} className="small" style={{ margin: 0 }}><span className="xs muted">{dayAndTime(n.createdAt)} · {n.authorUserId === p?.userId ? "you" : shortId(n.authorUserId)}</span><br />{n.body}</p>
          ))}
          {detail.data && detail.data.notes.length === 0 ? <p className="small muted">No notes yet.</p> : null}
          {canRespond ? (
            <form className="stack" style={{ gap: "0.5rem" }} onSubmit={(e) => { e.preventDefault(); addNote.mutate(); }}>
              <Problem error={addNote.error} />
              <TextArea label="Add a note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Called the rider, no answer. Calling the driver." />
              <button className="btn secondary sm" disabled={!note.trim() || addNote.isPending}>Add note</button>
            </form>
          ) : null}
        </div>
      </div>

      {live ? (
        canRespond && canManage ? (
          <form className="card pad stack" style={{ gap: "0.5rem" }} onSubmit={(e) => { e.preventDefault(); resolve.mutate(); }}>
            <h3 className="section-title">Resolve</h3>
            <SelectField label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as SosOutcome)}>
              {SOS_OUTCOMES.map((o) => <option key={o} value={o}>{SOS_OUTCOME_LABEL[o]}</option>)}
            </SelectField>
            {outcome === "ESCALATED" ? <Field label="Emergency services reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="the number police gave you" /> : null}
            <TextArea label="What happened" value={resolveNote} onChange={(e) => setResolveNote(e.target.value)} rows={3} />
            <button className="btn" disabled={resolveNote.trim().length < 3 || resolve.isPending}>Resolve</button>
          </form>
        ) : canRespond ? <Notice>Only safety officers resolve alerts. Acknowledge and add notes; a safety officer decides.</Notice> : null
      ) : null}
    </>
  );
}
