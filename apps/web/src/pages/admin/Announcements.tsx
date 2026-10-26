// Banners for riders, drivers, partners and staff (platform-service), by city and time window.
// The apps and the web read them from the client configuration.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../../lib/api";
import { CITIES, CITY_NAMES, dayAndTime } from "../../lib/format";
import { Drawer, Empty, Field, PageHead, Pill, Problem, SelectField, TextArea } from "../../components/ui";

interface Announcement {
  id: string; title: string; body: string; severity: "info" | "warning"; audiences: string[]; cities: string[];
  startsAt: string; endsAt: string | null; archived: boolean; createdAt: string;
}

const AUDIENCES = [["rider", "Riders"], ["driver", "Drivers"], ["partner", "Fleets and companies"], ["staff", "Staff"]] as const;
const local = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "");

function state(a: Announcement, now = Date.now()) {
  if (a.archived) return ["archived", "grey"] as const;
  if (new Date(a.startsAt).getTime() > now) return ["scheduled", "blue"] as const;
  if (a.endsAt && new Date(a.endsAt).getTime() <= now) return ["ended", "grey"] as const;
  return ["showing", "green"] as const;
}

export function AnnouncementsPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["admin-announcements"], queryFn: () => api<{ announcements: Announcement[] }>("staff", "/api/platform/announcements").then((r) => r.announcements) });
  const [editing, setEditing] = useState<Announcement | "new" | null>(null);
  const archive = useMutation({
    mutationFn: (id: string) => api("staff", `/api/platform/announcements/${id}/archive`, { body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-announcements"] });
      void qc.invalidateQueries({ queryKey: ["client-config"] });
    },
  });
  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead title="Announcements" lede="Short banners in the apps and the web: holiday hours, new cities, service notices." right={<button className="btn" onClick={() => setEditing("new")}><Plus /> New announcement</button>} />
      <Problem error={list.error ?? archive.error} />
      {list.data?.length === 0 ? <Empty title="No announcements yet." /> : null}
      <div className="stack" style={{ gap: "0.6rem" }}>
        {list.data?.map((a) => {
          const [word, tone] = state(a);
          return (
            <article key={a.id} className="card pad">
              <div className="row between" style={{ alignItems: "flex-start" }}>
                <div>
                  <div className="row" style={{ gap: "0.5rem" }}><strong>{a.title}</strong><Pill tone={tone}>{word}</Pill>{a.severity === "warning" ? <Pill tone="amber">warning</Pill> : null}</div>
                  <p className="small" style={{ margin: "0.3rem 0" }}>{a.body}</p>
                  <div className="xs muted">
                    {a.audiences.map((x) => AUDIENCES.find(([k]) => k === x)?.[1] ?? x).join(", ")} · {a.cities.length ? a.cities.map((c) => CITY_NAMES[c] ?? c).join(", ") : "every city"} · from {dayAndTime(a.startsAt)}{a.endsAt ? ` to ${dayAndTime(a.endsAt)}` : ""}
                  </div>
                </div>
                {!a.archived ? (
                  <div className="row" style={{ gap: "0.5rem" }}>
                    <button className="link" onClick={() => setEditing(a)}>edit</button>
                    <button className="link danger" onClick={() => archive.mutate(a.id)}>archive</button>
                  </div>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
      {editing ? <AnnouncementDrawer a={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function AnnouncementDrawer({ a, onClose }: { a: Announcement | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    title: a?.title ?? "", body: a?.body ?? "", severity: a?.severity ?? "info", audiences: a?.audiences ?? ["rider"],
    cities: a?.cities ?? [], startsAt: local(a?.startsAt ?? new Date().toISOString()), endsAt: local(a?.endsAt ?? null),
  });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, startsAt: new Date(f.startsAt).toISOString(), endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : null };
      return a ? api("staff", `/api/platform/announcements/${a.id}`, { method: "PUT", body }) : api("staff", "/api/platform/announcements", { body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-announcements"] });
      void qc.invalidateQueries({ queryKey: ["client-config"] });
      onClose();
    },
  });
  const toggle = (list: string[], v: string, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));
  return (
    <Drawer title={a ? "Edit announcement" : "New announcement"} onClose={onClose}>
      <form className="stack" style={{ gap: "0.25rem" }} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Problem error={save.error} />
        <Field label="Title" required value={f.title} onChange={(e) => setF((x) => ({ ...x, title: e.target.value }))} maxLength={80} />
        <TextArea label="Message" value={f.body} onChange={(e) => setF((x) => ({ ...x, body: e.target.value }))} maxLength={500} />
        <SelectField label="Kind" value={f.severity} onChange={(e) => setF((x) => ({ ...x, severity: e.target.value as "info" | "warning" }))}>
          <option value="info">information</option>
          <option value="warning">warning</option>
        </SelectField>
        <span className="label">Who sees it</span>
        <div className="options">
          {AUDIENCES.map(([k, label]) => (
            <label key={k} className="option"><input type="checkbox" checked={f.audiences.includes(k)} onChange={(e) => setF((x) => ({ ...x, audiences: toggle(x.audiences, k, e.target.checked) }))} /> {label}</label>
          ))}
        </div>
        <span className="label">Where (none ticked = every city)</span>
        <div className="options">
          {CITIES.map((c) => (
            <label key={c} className="option"><input type="checkbox" checked={f.cities.includes(c)} onChange={(e) => setF((x) => ({ ...x, cities: toggle(x.cities, c, e.target.checked) }))} /> {CITY_NAMES[c] ?? c}</label>
          ))}
        </div>
        <div className="two-col" style={{ gap: "0 0.75rem" }}>
          <Field label="From" type="datetime-local" required value={f.startsAt} onChange={(e) => setF((x) => ({ ...x, startsAt: e.target.value }))} />
          <Field label="Until (optional)" type="datetime-local" value={f.endsAt} onChange={(e) => setF((x) => ({ ...x, endsAt: e.target.value }))} />
        </div>
        <button className="btn" disabled={save.isPending || f.audiences.length === 0}>{a ? "Save" : "Publish"}</button>
      </form>
    </Drawer>
  );
}
