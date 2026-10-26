import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Upload } from "lucide-react";
import { api, ApiError, type Surface } from "../lib/api";
import { dayAndTime } from "../lib/format";
import { EXPIRING_KINDS, KIND_HINT, KIND_LABEL, statusTone, statusWord, UPLOAD_TYPES, uploadDocument, type Checklist, type FleetDocument, type SubjectType } from "../lib/fleet";
import { Drawer, Pill, Problem } from "./ui";

export const documentsKey = (subjectType: SubjectType, subjectId: string) => ["fleet-docs", subjectType, subjectId];

export function useDocuments(surface: Surface, subjectType: SubjectType, subjectId: string, enabled = true) {
  return useQuery({
    queryKey: documentsKey(subjectType, subjectId),
    enabled,
    queryFn: () => api<Checklist & { history: FleetDocument[] }>(surface, `/api/fleet/documents?${new URLSearchParams({ subjectType, subjectId })}`),
  });
}

function Validity({ doc }: { doc: FleetDocument }) {
  if (!doc.expiresAt) return null;
  return <span className={`xs ${doc.expiringSoon || doc.status === "EXPIRED" ? "" : "muted"}`} style={doc.expiringSoon ? { color: "var(--warning)" } : undefined}>valid until {doc.expiresAt}</span>;
}

/**
 * The documents a driver, vehicle or company needs. Owners upload and replace them;
 * staff with document:review open each one to approve or reject it.
 */
export function DocumentChecklist({ surface, subjectType, subjectId, mode, canReview = false, locked = false, onChange }: {
  surface: Surface;
  subjectType: SubjectType;
  subjectId: string;
  mode: "owner" | "staff";
  canReview?: boolean;
  /** owners can't change documents (e.g. while the vehicle is retired) */
  locked?: boolean;
  onChange?: () => void;
}) {
  const qc = useQueryClient();
  const docs = useDocuments(surface, subjectType, subjectId);
  const [viewing, setViewing] = useState<FleetDocument | null>(null);
  const [expiry, setExpiry] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const changed = () => {
    void qc.invalidateQueries({ queryKey: documentsKey(subjectType, subjectId) });
    onChange?.();
  };
  const upload = useMutation({
    mutationFn: (a: { kind: string; file: File; expiresAt?: string }) => uploadDocument(surface, { subjectType, subjectId, ...a }),
    onMutate: () => setError(null),
    onSuccess: changed,
    onError: setError,
  });

  if (docs.isLoading) return <p className="muted small">Loading documents…</p>;
  if (docs.error) return <Problem error={docs.error} />;

  return (
    <>
      <Problem error={error} />
      <ul className="doc-list">
        {docs.data!.documents.map(({ kind, expires, document: d }) => {
          const busy = upload.isPending && upload.variables?.kind === kind;
          return (
            <li key={kind}>
              <div>
                <div className="row" style={{ gap: "0.5rem" }}>
                  <strong>{KIND_LABEL[kind] ?? kind}</strong>
                  {d ? <Pill tone={statusTone(d.status)}>{statusWord(d.status)}</Pill> : <Pill tone="grey">missing</Pill>}
                  {d ? <Validity doc={d} /> : null}
                </div>
                <div className="xs muted" style={{ marginTop: "0.15rem" }}>
                  {d?.status === "REJECTED" ? <span style={{ color: "var(--danger)" }}>Rejected: {d.rejectReason}</span> : d ? `uploaded ${dayAndTime(d.createdAt)}` : KIND_HINT[kind]}
                </div>
              </div>
              <div className="doc-actions">
                {d ? (
                  <button type="button" className="btn ghost sm" onClick={() => setViewing(d)}>
                    <Eye /> {mode === "staff" && canReview && d.status === "PENDING" ? "Review" : "View"}
                  </button>
                ) : null}
                {mode === "owner" && !locked ? (
                  <>
                    {expires ? (
                      <input type="date" aria-label={`${KIND_LABEL[kind]} valid until`} value={expiry[kind] ?? ""} min={new Date().toISOString().slice(0, 10)}
                        onChange={(e) => setExpiry((x) => ({ ...x, [kind]: e.target.value }))} title="Valid until" />
                    ) : null}
                    <label className={`btn ${d ? "secondary" : ""} sm file-btn`} aria-disabled={busy}>
                      <Upload /> {busy ? "Uploading…" : d ? "Replace" : "Upload"}
                      <input type="file" accept={UPLOAD_TYPES.join(",")} disabled={busy} onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        if (expires && !expiry[kind]) {
                          setError(new ApiError(400, "expiry_required", `Set the date the ${KIND_LABEL[kind]?.toLowerCase()} is valid until, then choose the file`));
                          return;
                        }
                        upload.mutate({ kind, file, expiresAt: expires ? expiry[kind] : undefined });
                      }} />
                    </label>
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {viewing ? (
        <DocumentViewer surface={surface} doc={viewing} canReview={mode === "staff" && canReview} onClose={() => setViewing(null)} onReviewed={() => { setViewing(null); changed(); }} />
      ) : null}
    </>
  );
}

/** The file (signed URL, never cached) next to the reviewer's decision. Staff views are audited by fleet-service. */
export function DocumentViewer({ surface, doc, canReview, onClose, onReviewed }: { surface: Surface; doc: FleetDocument; canReview: boolean; onClose: () => void; onReviewed: () => void }) {
  const link = useQuery({
    queryKey: ["fleet-doc-url", doc.id],
    staleTime: 60_000,
    queryFn: () => api<{ url: string; contentType: string }>(surface, `/api/fleet/documents/${doc.id}/url`),
  });
  const [expiresAt, setExpiresAt] = useState(doc.expiresAt ?? "");
  const [reason, setReason] = useState("");
  const review = useMutation({
    mutationFn: (decision: "APPROVE" | "REJECT") =>
      api(surface, `/api/fleet/documents/${doc.id}/review`, { body: { decision, ...(decision === "APPROVE" && expiresAt ? { expiresAt } : {}), ...(decision === "REJECT" ? { reason } : {}) } }),
    onSuccess: onReviewed,
  });
  const pending = doc.status === "PENDING";

  return (
    <Drawer title={KIND_LABEL[doc.kind] ?? doc.kind} onClose={onClose} wide>
      <div className="doc-viewer">
        <div className="doc-frame">
          {link.isLoading ? <span className="muted small">Loading…</span> : null}
          <Problem error={link.error} />
          {link.data ? (
            link.data.contentType === "application/pdf"
              ? <iframe src={link.data.url} title={KIND_LABEL[doc.kind]} />
              : <img src={link.data.url} alt={KIND_LABEL[doc.kind]} />
          ) : null}
        </div>
        <div className="stack" style={{ gap: "0.9rem", alignContent: "start" }}>
          <dl className="kv">
            <dt>Status</dt><dd><Pill tone={statusTone(doc.status)}>{statusWord(doc.status)}</Pill></dd>
            <dt>Uploaded</dt><dd className="small">{dayAndTime(doc.createdAt)}</dd>
            {doc.expiresAt ? <><dt>Valid until</dt><dd className="small">{doc.expiresAt}</dd></> : null}
            {doc.rejectReason ? <><dt>Rejected</dt><dd className="small">{doc.rejectReason}</dd></> : null}
          </dl>
          {link.data ? <a className="small" href={link.data.url} target="_blank" rel="noreferrer">Open in a new tab</a> : null}
          {canReview && pending ? (
            <div className="stack" style={{ gap: "0.75rem" }}>
              <Problem error={review.error} />
              {EXPIRING_KINDS.includes(doc.kind) ? (
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor="doc-exp">Valid until (check it matches the document)</label>
                  <input id="doc-exp" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
                </div>
              ) : null}
              <button className="btn" disabled={review.isPending} onClick={() => review.mutate("APPROVE")}>Approve</button>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="label" htmlFor="doc-why">Or reject, and say why</label>
                <textarea id="doc-why" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Photo is blurry · name differs from the licence · expired" style={{ minHeight: "4rem" }} />
              </div>
              <button className="btn danger" disabled={review.isPending || reason.trim().length < 3} onClick={() => review.mutate("REJECT")}>Reject</button>
              <p className="xs muted" style={{ margin: 0 }}>Your view of this document is recorded in the audit log.</p>
            </div>
          ) : null}
        </div>
      </div>
    </Drawer>
  );
}
