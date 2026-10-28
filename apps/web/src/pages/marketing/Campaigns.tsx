// Campaigns (workflow 15 step 13): a push or an SMS to riders or drivers of one city, optionally
// only those active recently. Sent now or at a time; notification-service sends at a fixed rate,
// skips people who opted out, and waits out quiet hours (21:00–08:00).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { citiesFor } from "../../lib/api";
import { CITIES, CITY_NAMES, dayAndTime } from "../../lib/format";
import { CAMPAIGN_LABEL, campaignsApi, campaignTone, SMS_MAX, type Campaign, type CampaignInput } from "../../lib/marketing";
import { useSession } from "../../lib/session";
import { Drawer, Empty, Field, Notice, PageHead, Pill, Problem, SelectField, TextArea } from "../../components/ui";
import { useStaffNames } from "../admin/Approvals";

const AUDIENCE_LABEL = { RIDER: "Riders", DRIVER: "Drivers" } as const;

export function CampaignsPage() {
  const { staff } = useSession();
  const cities = citiesFor(staff.principal, "campaign:send", CITIES);
  const [city, setCity] = useState("");
  const [editing, setEditing] = useState<Campaign | "new" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["campaigns", city],
    enabled: cities.length > 0,
    refetchInterval: (query) => (query.state.data?.campaigns.some((c) => c.status === "SENDING" || c.status === "SCHEDULED") ? 5000 : false),
    queryFn: () => campaignsApi.list(city || undefined),
  });

  if (!cities.length) return <div className="page"><PageHead title="Campaigns" /><Empty title="Nothing to show.">Your roles don't include campaign:send in any city.</Empty></div>;
  const quiet = q.data?.quietHours;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Campaigns"
        lede={`Push or SMS to riders or drivers of a city. People who opted out are skipped${quiet && quiet.from !== quiet.to ? `; nothing is sent from ${String(quiet.from).padStart(2, "0")}:00 to ${String(quiet.to).padStart(2, "0")}:00` : ""}.`}
        right={<button className="btn" onClick={() => setEditing("new")}>New campaign</button>}
      />
      {cities.length > 1 ? (
        <div className="chips">
          <button className="chip" aria-pressed={city === ""} onClick={() => setCity("")}>All my cities</button>
          {cities.map((c) => <button key={c} className="chip" aria-pressed={city === c} onClick={() => setCity(c)}>{CITY_NAMES[c] ?? c}</button>)}
        </div>
      ) : null}
      <Problem error={q.error} />
      {q.isPending ? <p className="small muted">Loading campaigns…</p> : null}
      {q.data && q.data.campaigns.length === 0 ? <Empty title="No campaigns yet." /> : null}
      {q.data?.campaigns.length ? (
        <section className="card">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Message</th><th>To</th><th>When</th><th>Delivered</th><th>Status</th></tr></thead>
              <tbody>
                {q.data.campaigns.map((c) => (
                  <tr key={c.id} onClick={() => setOpen(c.id)} style={{ cursor: "pointer" }}>
                    <td className="small">{c.title ? <strong>{c.title}</strong> : null}<div className="xs muted" style={{ maxWidth: "40ch", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.body}</div></td>
                    <td className="small">{AUDIENCE_LABEL[c.audience]} · {CITY_NAMES[c.cityId] ?? c.cityId}<div className="xs muted">{c.channel === "PUSH" ? "push" : "SMS"}{c.lastActiveDays ? ` · active in the last ${c.lastActiveDays} days` : ""}</div></td>
                    <td className="small">{c.scheduledAt ? dayAndTime(c.scheduledAt) : "—"}</td>
                    <td className="small"><Counts c={c} /></td>
                    <td><Pill tone={campaignTone(c.status)} pulse={c.status === "SENDING"}>{CAMPAIGN_LABEL[c.status]}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {editing ? <CampaignForm campaign={editing === "new" ? null : editing} cities={cities} onClose={() => setEditing(null)} /> : null}
      {open ? <CampaignDrawer id={open} onClose={() => setOpen(null)} onEdit={(c) => { setOpen(null); setEditing(c); }} /> : null}
    </div>
  );
}

function Counts({ c }: { c: Campaign }) {
  if (c.status === "DRAFT" || c.status === "SCHEDULED") return <span className="muted">—</span>;
  return (
    <span>
      <strong>{c.counts.sent}</strong> sent of {c.targeted}
      {c.counts.pending ? <span className="muted"> · {c.counts.pending} to go</span> : null}
      {c.counts.skipped ? <span className="muted"> · {c.counts.skipped} skipped</span> : null}
      {c.counts.failed ? <span className="muted"> · {c.counts.failed} failed</span> : null}
    </span>
  );
}

function CampaignDrawer({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (c: Campaign) => void }) {
  const name = useStaffNames();
  const qc = useQueryClient();
  const me = useSession().staff.principal?.userId;
  const [later, setLater] = useState("");
  const q = useQuery({
    queryKey: ["campaign", id], queryFn: () => campaignsApi.get(id),
    refetchInterval: (query) => (query.state.data?.status === "SENDING" ? 3000 : false),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["campaign", id] });
    void qc.invalidateQueries({ queryKey: ["campaigns"] });
  };
  const schedule = useMutation({ mutationFn: (at?: string) => campaignsApi.schedule(id, at), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: () => campaignsApi.cancel(id), onSuccess: refresh });
  const approve = useMutation({ mutationFn: () => campaignsApi.approve(id), onSuccess: refresh });
  const c = q.data;
  // a large campaign needs a second person: never whoever wrote or scheduled it
  const mine = !!c && (c.createdBy === me || c.updatedBy === me);

  return (
    <Drawer title={c?.title ?? "Campaign"} onClose={onClose} wide>
      <Problem error={q.error ?? schedule.error ?? cancel.error ?? approve.error} />
      {c ? (
        <div className="stack" style={{ gap: "0.75rem" }}>
          <div className="row" style={{ gap: "0.5rem" }}><Pill tone={campaignTone(c.status)} pulse={c.status === "SENDING"}>{CAMPAIGN_LABEL[c.status]}</Pill><span className="small muted">{c.channel === "PUSH" ? "Push" : "SMS"}</span></div>
          <blockquote className="small" style={{ margin: 0, padding: "0.5rem 0.75rem", borderLeft: "3px solid var(--border, #e5e7eb)" }}>{c.title ? <strong>{c.title}<br /></strong> : null}{c.body}</blockquote>
          <dl className="kv">
            <dt>To</dt><dd>{AUDIENCE_LABEL[c.audience]} in {CITY_NAMES[c.cityId] ?? c.cityId}{c.lastActiveDays ? `, active in the last ${c.lastActiveDays} days` : ""}</dd>
            {c.audienceEstimate !== null && c.audienceEstimate !== undefined ? <><dt>Reaches now</dt><dd>about {c.audienceEstimate} people</dd></> : null}
            {c.scheduledAt ? <><dt>Scheduled</dt><dd>{dayAndTime(c.scheduledAt)}</dd></> : null}
            {c.startedAt ? <><dt>Started</dt><dd>{dayAndTime(c.startedAt)}</dd></> : null}
            {c.finishedAt ? <><dt>Finished</dt><dd>{dayAndTime(c.finishedAt)}</dd></> : null}
            {c.approvedBy ? <><dt>Approved</dt><dd>{name(c.approvedBy)}{c.approvedAt ? ` · ${dayAndTime(c.approvedAt)}` : ""}</dd></> : null}
            {c.status !== "DRAFT" && c.status !== "SCHEDULED" && c.status !== "AWAITING_APPROVAL" ? <><dt>Delivered</dt><dd><Counts c={c} /></dd></> : null}
            <dt>Created</dt><dd>{name(c.createdBy)} · {dayAndTime(c.createdAt)}</dd>
          </dl>
          {c.quietNow && (c.status === "DRAFT" || c.status === "SCHEDULED" || c.status === "SENDING") ? <Notice>It's quiet hours: sending waits until morning.</Notice> : null}
          {c.counts.skipped ? <p className="xs muted" style={{ margin: 0 }}>Skipped: no phone app registered (push) or no phone number on file (SMS), or cancelled.</p> : null}
          {c.status === "DRAFT" ? (
            <>
              <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
                <button className="btn" disabled={schedule.isPending} onClick={() => window.confirm(`Send to about ${c.audienceEstimate ?? 0} people now?`) && schedule.mutate(undefined)}>Send now</button>
                <button className="btn secondary" onClick={() => onEdit(c)}>Edit</button>
              </div>
              <div className="row" style={{ gap: "0.5rem", alignItems: "flex-end" }}>
                <Field label="Or send at" type="datetime-local" value={later} onChange={(e) => setLater(e.target.value)} />
                <button className="btn secondary" disabled={!later || schedule.isPending} onClick={() => schedule.mutate(new Date(later).toISOString())}>Schedule</button>
              </div>
            </>
          ) : null}
          {c.status === "AWAITING_APPROVAL" ? (
            mine ? (
              <Notice>This campaign reaches more than {c.approvalThreshold ?? 1000} people: another staff member with campaign rights in this city must approve it before it is sent.</Notice>
            ) : (
              <div className="row" style={{ gap: "0.5rem" }}>
                <button className="btn" disabled={approve.isPending} onClick={() => window.confirm(`Approve sending to about ${c.audienceEstimate ?? c.targeted} people?`) && approve.mutate()}>Approve and send</button>
              </div>
            )
          ) : null}
          {c.status === "DRAFT" || c.status === "AWAITING_APPROVAL" || c.status === "SCHEDULED" || c.status === "SENDING" ? (
            <div><button className="btn ghost" disabled={cancel.isPending} onClick={() => window.confirm("Cancel this campaign? Messages not sent yet won't go out.") && cancel.mutate()}>Cancel campaign</button></div>
          ) : null}
        </div>
      ) : <p className="small muted">Loading…</p>}
    </Drawer>
  );
}

function CampaignForm({ campaign, cities, onClose }: { campaign: Campaign | null; cities: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [cityId, setCityId] = useState(campaign?.cityId ?? cities[0]!);
  const [audience, setAudience] = useState<Campaign["audience"]>(campaign?.audience ?? "RIDER");
  const [channel, setChannel] = useState<Campaign["channel"]>(campaign?.channel ?? "PUSH");
  const [days, setDays] = useState(campaign?.lastActiveDays ? String(campaign.lastActiveDays) : "");
  const [title, setTitle] = useState(campaign?.title ?? "");
  const [body, setBody] = useState(campaign?.body ?? "");
  const lastActiveDays = days.trim() ? Number(days) : null;
  const input: CampaignInput = { cityId, audience, channel, lastActiveDays, title: channel === "PUSH" ? title.trim() : null, body: body.trim() };
  const size = useQuery({
    queryKey: ["campaign-audience", cityId, audience, channel, lastActiveDays],
    queryFn: () => campaignsApi.audience({ cityId, audience, channel, lastActiveDays }),
    enabled: lastActiveDays === null || (lastActiveDays >= 1 && lastActiveDays <= 365),
  });
  const limit = channel === "SMS" ? SMS_MAX : 500;
  const valid = input.body.length > 0 && input.body.length <= limit && (channel === "SMS" || !!input.title) && (lastActiveDays === null || (lastActiveDays >= 1 && lastActiveDays <= 365));
  const save = useMutation({
    mutationFn: () => (campaign ? campaignsApi.update(campaign.id, input) : campaignsApi.create(input)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["campaigns"] });
      void qc.invalidateQueries({ queryKey: ["campaign"] });
      onClose();
    },
  });

  return (
    <Drawer title={campaign ? "Edit campaign" : "New campaign"} onClose={onClose}>
      <div className="stack" style={{ gap: "0.75rem" }}>
        <SelectField label="City" value={cityId} onChange={(e) => setCityId(e.target.value)}>
          {cities.map((c) => <option key={c} value={c}>{CITY_NAMES[c] ?? c}</option>)}
        </SelectField>
        <SelectField label="To" value={audience} onChange={(e) => setAudience(e.target.value as Campaign["audience"])}>
          <option value="RIDER">Riders</option>
          <option value="DRIVER">Drivers</option>
        </SelectField>
        <Field label="Active in the last … days (optional)" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} placeholder="30" />
        <SelectField label="Channel" value={channel} onChange={(e) => setChannel(e.target.value as Campaign["channel"])}>
          <option value="PUSH">Push notification</option>
          <option value="SMS">SMS</option>
        </SelectField>
        {channel === "PUSH" ? <Field label="Title" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} /> : null}
        <TextArea label="Message" rows={4} value={body} maxLength={limit} onChange={(e) => setBody(e.target.value)} hint={`${body.trim().length}/${limit}${channel === "SMS" ? " · sent as “Anbessa: …”" : ""}`} />
        <p className="small" style={{ margin: 0 }}>{size.isPending ? "Counting…" : size.data !== undefined ? <>Reaches about <strong>{size.data}</strong> people now.</> : null}</p>
        <Problem error={size.error ?? save.error} />
        <div className="row" style={{ gap: "0.5rem" }}>
          <button className="btn" disabled={!valid || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save draft"}</button>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
        <p className="xs muted" style={{ margin: 0 }}>Drafts are sent from the campaign's page: now or at a set time.</p>
      </div>
    </Drawer>
  );
}
