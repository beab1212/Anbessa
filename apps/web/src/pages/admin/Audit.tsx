// The audit log (audit-service): every staff action, permission and settings change, approval,
// suspension, document view and staff sign-in. Write-once; filter, page and export to CSV.

import { Fragment, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { api, http } from "../../lib/api";
import { download, type AuditEntry } from "../../lib/admin";
import { dayAndTime, shortId } from "../../lib/format";
import { Empty, Field, PageHead, Pill, Problem, SelectField } from "../../components/ui";
import { useStaffNames } from "./Approvals";

const FILTERS = ["actorId", "action", "resourceType", "resourceId", "outcome", "service", "from", "to"] as const;

export function AuditPage() {
  const [params, setParams] = useSearchParams();
  const name = useStaffNames();
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState<unknown>(null);
  const filters = Object.fromEntries(FILTERS.map((k) => [k, params.get(k) ?? ""]));
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v).map(([k, v]) => [k, k === "from" || k === "to" ? new Date(v).toISOString() : v]));
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const q = useInfiniteQuery({
    queryKey: ["audit-log", query.toString()],
    initialPageParam: "",
    getNextPageParam: (last: { next: string | null }) => last.next ?? undefined,
    queryFn: ({ pageParam }) => api<{ entries: AuditEntry[]; next: string | null }>("staff", `/api/audit/entries?${query}&limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
  });
  const rows = q.data?.pages.flatMap((p) => p.entries) ?? [];

  async function exportCsv() {
    setExporting(null);
    try {
      const res = await http.get<string>(`/api/audit/entries.csv?${query}`, { surface: "staff", responseType: "text" });
      download(`audit-${new Date().toISOString().slice(0, 10)}.csv`, res.data);
    } catch (err) {
      setExporting(err);
    }
  }

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Audit log"
        lede="Write-once record of staff actions, approvals, permission and settings changes, document views and staff sign-ins."
        right={<button className="btn secondary" onClick={() => void exportCsv()}><Download /> Export CSV</button>}
      />
      <Problem error={exporting} />
      <div className="card pad audit-filters">
        <Field label="Action starts with" value={filters.action} onChange={(e) => set("action", e.target.value)} placeholder="authz, settings:change, user:suspend" />
        <Field label="Person (actor id)" className="mono" value={filters.actorId} onChange={(e) => set("actorId", e.target.value.trim())} />
        <Field label="Resource id" className="mono" value={filters.resourceId} onChange={(e) => set("resourceId", e.target.value.trim())} />
        <SelectField label="Service" value={filters.service} onChange={(e) => set("service", e.target.value)}>
          <option value="">any</option>
          {["auth-service", "platform-service", "fleet-service", "audit-service"].map((s) => <option key={s} value={s}>{s}</option>)}
        </SelectField>
        <SelectField label="Outcome" value={filters.outcome} onChange={(e) => set("outcome", e.target.value)}>
          <option value="">any</option>
          {["EXECUTED", "PENDING_APPROVAL", "ALLOWED", "DENIED"].map((s) => <option key={s} value={s}>{s.toLowerCase().replace("_", " ")}</option>)}
        </SelectField>
        <Field label="From" type="datetime-local" value={filters.from} onChange={(e) => set("from", e.target.value)} />
        <Field label="To" type="datetime-local" value={filters.to} onChange={(e) => set("to", e.target.value)} />
      </div>
      <Problem error={q.error} />
      {q.data && rows.length === 0 ? <Empty title="Nothing recorded with these filters." /> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>On</th><th>Outcome</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <Fragment key={e.eventId}>
                  <tr style={{ cursor: "pointer" }} onClick={() => setOpen(open === e.eventId ? null : e.eventId)}>
                    <td className="small">{dayAndTime(e.at)}</td>
                    <td className="small">{e.actorId ? <Link to={`/staff/admin/users/${e.actorId}`} onClick={(ev) => ev.stopPropagation()}>{name(e.actorId)}</Link> : <span className="muted">system</span>}</td>
                    <td className="mono small">{e.action}</td>
                    <td className="small">{e.resourceType} <span className="mono xs muted">{e.resourceId.length > 30 ? shortId(e.resourceId) : e.resourceId}</span></td>
                    <td><Pill tone={e.outcome === "DENIED" ? "red" : e.outcome === "PENDING_APPROVAL" ? "amber" : "green"}>{e.outcome.toLowerCase().replace("_", " ")}</Pill></td>
                  </tr>
                  {open === e.eventId ? (
                    <tr>
                      <td colSpan={5} className="small" style={{ background: "var(--surface-2)" }}>
                        <dl className="kv">
                          <dt>Reason / detail</dt><dd>{e.reason ?? "—"}</dd>
                          <dt>Service</dt><dd className="mono">{e.service ?? "—"}</dd>
                          <dt>Resource</dt><dd className="mono">{e.resourceType} {e.resourceId}</dd>
                          <dt>Event</dt><dd className="mono xs">{e.eventId}</dd>
                        </dl>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {q.hasNextPage ? <div><button className="btn ghost" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Older entries</button></div> : null}
    </div>
  );
}
