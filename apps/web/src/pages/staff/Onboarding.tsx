import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import type { Principal } from "@ride-app/shared-authz";
import { allowed, api, ApiError, citiesFor, newIdempotencyKey } from "../../lib/api";
import { CITIES, dayAndTime, since } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { CityPicker } from "../../components/CityPicker";
import { DocumentChecklist, useDocuments } from "../../components/Documents";
import { KIND_LABEL, statusTone, statusWord, vehicleName, type Vehicle } from "../../lib/fleet";
import { Drawer, Empty, Notice, PageHead, Pill, Problem, TextArea } from "../../components/ui";
import { canListMembers, canReinstateOrg, daysLeftWord, ORG_ROLE_WORD, type ExpiringDocuments, type OrgMembers } from "../../lib/fleet2";

interface Org {
  id: string;
  name: string;
  kind: "FLEET" | "CORPORATE";
  cityId: string;
  legalName: string | null;
  tin: string | null;
  status: "PENDING" | "VERIFIED" | "SUSPENDED";
  createdAt: string;
  members: number;
}

// ── pure helpers (tests/onboarding.test.ts) ─────────────────────────────────────

/** Cities where the person may open this page: any of the company permissions. */
export const COMPANY_PERMISSIONS = ["org:read", "org:suspend", "org:verify"] as const;
export function companyCities(p: Principal | null, all: string[]): string[] {
  const set = new Set(COMPANY_PERMISSIONS.flatMap((perm) => citiesFor(p, perm, all)));
  return all.filter((c) => set.has(c));
}

export interface CompanyPowers {
  verify: boolean;
  suspend: boolean;
  /** fleet-service: the company's papers (document:read), and deciding on them (document:review) */
  readDocuments: boolean;
  reviewDocuments: boolean;
  /** fleet-service: the company's cars (vehicle:read) */
  readVehicles: boolean;
}

export function companyPowers(p: Principal | null, cityId: string): CompanyPowers {
  const has = (perm: Parameters<typeof allowed>[1]) => allowed(p, perm, { cityId });
  return {
    verify: has("org:verify"),
    suspend: has("org:suspend"),
    readDocuments: has("document:read"),
    reviewDocuments: has("document:review"),
    readVehicles: has("vehicle:read"),
  };
}

/** What can be done to a company in this state. Lifting a suspension: canReinstateOrg (lib/fleet2). */
export function orgActions(status: Org["status"], powers: Pick<CompanyPowers, "verify" | "suspend">) {
  return {
    verify: status === "PENDING" && powers.verify,
    suspend: status !== "SUSPENDED" && powers.suspend,
  };
}

export const ORG_REASON_MIN = 10;
export const ORG_REASON_MAX = 500;

// ── page ─────────────────────────────────────────────────────────────────────

/** Workflow 03: companies wait here until an onboarding officer checks their TIN and papers. */
export function Onboarding() {
  const { staff } = useSession();
  const cities = companyCities(staff.principal, CITIES);
  const [picked, setPicked] = useState<string | null>(null);
  const cityId = picked && cities.includes(picked) ? picked : (cities[0] ?? null);
  const [status, setStatus] = useState<Org["status"]>("PENDING");
  const qc = useQueryClient();
  const orgs = useQuery({
    queryKey: ["orgs", cityId, status],
    enabled: !!cityId,
    queryFn: () => api<Org[]>("staff", `/api/identity/organizations?cityId=${cityId}&status=${status}`),
  });
  const verify = useMutation({
    mutationFn: (id: string) => api("staff", `/api/identity/organizations/${id}/verify`, { body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orgs"] }),
  });
  const [params, setParams] = useSearchParams();
  const openId = params.get("org");
  const [suspending, setSuspending] = useState<Org | null>(null);
  const [reinstating, setReinstating] = useState<Org | null>(null);
  const all = useQuery({ queryKey: ["orgs", cityId, "all"], enabled: !!cityId && !!openId, queryFn: () => api<Org[]>("staff", `/api/identity/organizations?cityId=${cityId}`) });
  const open = (orgs.data ?? []).find((o) => o.id === openId) ?? all.data?.find((o) => o.id === openId) ?? null;
  const powers = companyPowers(staff.principal, cityId ?? "");
  const list = orgs.data ?? [];
  const now = useNow(60_000);

  if (!cityId) return <div className="page"><Empty title="No city">Your roles don't include a city with companies.</Empty></div>;

  return (
    <div className="page">
      <PageHead
        title="Companies"
        lede="Fleet companies can't add drivers, and company accounts can't book, until they're verified here."
        right={<CityPicker cities={cities} value={cityId} onChange={setPicked} />}
      />
      <div className="tabs" role="tablist">
        {(["PENDING", "VERIFIED", "SUSPENDED"] as const).map((s) => (
          <button key={s} role="tab" aria-selected={status === s} className={status === s ? "on" : ""} onClick={() => setStatus(s)}>
            {s === "PENDING" ? "Waiting" : s === "VERIFIED" ? "Verified" : "Suspended"}
          </button>
        ))}
      </div>
      <Problem error={orgs.error ?? verify.error} />
      {orgs.isLoading ? <p className="muted small">Loading…</p> : null}
      {orgs.isSuccess && list.length === 0 ? <Empty title={status === "PENDING" ? "Nobody waiting." : "None."}>{status === "PENDING" ? "New registrations appear here." : null}</Empty> : null}
      {list.length ? (
        <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Company</th><th>Kind</th><th>TIN</th><th className="num">People</th><th>Registered</th><th /></tr></thead>
          <tbody>
            {list.map((o) => (
              <tr key={o.id} className={status === "PENDING" && now - new Date(o.createdAt).getTime() > 2 * 86_400_000 ? "urgent" : ""}>
                <td><strong>{o.name}</strong><div className="small muted">{o.legalName}</div></td>
                <td>{o.kind === "FLEET" ? <Pill tone="blue">fleet</Pill> : <Pill tone="amber">company account</Pill>}</td>
                <td className="mono">{o.tin ?? "—"}</td>
                <td className="num mono">{o.members}</td>
                <td className="small">{dayAndTime(o.createdAt)}<div className="muted">{since(o.createdAt, now)} ago</div></td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="btn ghost sm" onClick={() => setParams({ org: o.id })}><FileText /> Open</button>{" "}
                  {orgActions(o.status, powers).suspend ? (
                    <button className="link danger" onClick={() => setSuspending(o)}>suspend</button>
                  ) : null}
                  {canReinstateOrg(staff.principal, o) ? <button className="link" onClick={() => setReinstating(o)}>lift suspension</button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      ) : null}
      {open ? (
        <CompanyDrawer org={open} powers={companyPowers(staff.principal, open.cityId ?? cityId)} verifying={verify.isPending} verifyError={verify.error}
          onVerify={() => verify.mutate(open.id)} onSuspend={() => setSuspending(open)} onReinstate={() => setReinstating(open)} onClose={() => setParams({})} />
      ) : openId && all.isSuccess ? (
        <Drawer title="Company" onClose={() => setParams({})}>
          <Empty title="Not in this city.">The company isn't listed in this city. Pick another city above.</Empty>
        </Drawer>
      ) : null}
      {suspending ? <SuspendOrgDrawer org={suspending} onClose={() => setSuspending(null)} /> : null}
      {reinstating ? <ReinstateOrgDrawer org={reinstating} onClose={() => setReinstating(null)} /> : null}
    </div>
  );
}

/** The company's papers (fleet-service documents), its cars, and the decisions (auth-service). */
function CompanyDrawer({ org, powers, verifying, verifyError, onVerify, onSuspend, onReinstate, onClose }: {
  org: Org; powers: CompanyPowers; verifying: boolean; verifyError: unknown; onVerify: () => void; onSuspend: () => void; onReinstate: () => void; onClose: () => void;
}) {
  const { staff } = useSession();
  const reinstate = canReinstateOrg(staff.principal, org);
  const docs = useDocuments("staff", "ORGANIZATION", org.id, powers.readDocuments);
  const missing = docs.data?.missingForApproval ?? [];
  const actions = orgActions(org.status, powers);
  const verifyBlocked = !powers.readDocuments || !docs.isSuccess || missing.length > 0;
  return (
    <Drawer title={org.name} onClose={onClose} wide>
      <div className="stack" style={{ gap: "1rem" }}>
        <dl className="kv">
          <dt>Legal name</dt><dd>{org.legalName ?? "—"}</dd>
          <dt>TIN</dt><dd className="mono">{org.tin ?? "—"}</dd>
          <dt>Kind</dt><dd>{org.kind === "FLEET" ? "fleet company" : "company account"}</dd>
          <dt>Status</dt><dd><Pill tone={org.status === "VERIFIED" ? "green" : org.status === "PENDING" ? "amber" : "red"}>{org.status.toLowerCase()}</Pill></dd>
          <dt>People</dt><dd className="mono">{org.members}</dd>
          <dt>Registered</dt><dd className="small">{dayAndTime(org.createdAt)}</dd>
        </dl>
        {org.status === "SUSPENDED" ? (
          <Notice tone="error">
            Suspended. Its people can't act for it.{" "}
            {reinstate ? <button className="link" onClick={onReinstate}>Lift the suspension</button> : "Whoever may suspend companies in this city can lift it."}
          </Notice>
        ) : null}

        {actions.verify || actions.suspend ? (
          <div className="stack" style={{ gap: "0.5rem" }}>
            <Problem error={verifyError} />
            {actions.verify && powers.readDocuments && missing.length ? <Notice>Approve the {missing.map((k) => KIND_LABEL[k]?.toLowerCase() ?? k).join(" and ")} first.</Notice> : null}
            {actions.verify && !powers.readDocuments ? <Notice>Verifying needs the papers checked, and your roles can't open them in this city.</Notice> : null}
            <div className="row" style={{ gap: "0.5rem" }}>
              {actions.verify ? <button className="btn" disabled={verifying || verifyBlocked} onClick={onVerify}>{verifying ? "Verifying…" : `Verify ${org.name}`}</button> : null}
              {actions.suspend ? <button className="btn danger" onClick={onSuspend}>Suspend company</button> : null}
            </div>
          </div>
        ) : null}

        <section>
          <h3 className="section-title">Papers</h3>
          {powers.readDocuments ? (
            <>
              <p className="small muted" style={{ marginTop: 0 }}>Check that the business licence and TIN certificate name <strong>{org.legalName ?? org.name}</strong> and the TIN above.</p>
              <DocumentChecklist surface="staff" subjectType="ORGANIZATION" subjectId={org.id} mode="staff" canReview={powers.reviewDocuments} />
            </>
          ) : <p className="small muted" style={{ margin: 0 }}>Your roles don't include reading company documents in this city.</p>}
        </section>

        {org.kind === "FLEET" ? (
          <section>
            <h3 className="section-title">Cars</h3>
            {powers.readVehicles ? <CompanyCars orgId={org.id} cityId={org.cityId} /> : <p className="small muted" style={{ margin: 0 }}>Your roles don't include vehicles in this city.</p>}
          </section>
        ) : null}

        {org.kind === "FLEET" && powers.readDocuments ? (
          <section>
            <h3 className="section-title">Documents expiring</h3>
            <ExpiringPapers orgId={org.id} />
          </section>
        ) : null}

        {canListMembers(staff.principal, org.cityId) ? (
          <section>
            <h3 className="section-title">People</h3>
            <CompanyMembers orgId={org.id} />
          </section>
        ) : null}
      </div>
    </Drawer>
  );
}

function CompanyCars({ orgId, cityId }: { orgId: string; cityId: string }) {
  const cars = useQuery({
    queryKey: ["fleet-vehicles", "org", orgId],
    queryFn: () => api<{ vehicles: Vehicle[] }>("staff", `/api/fleet/vehicles?${new URLSearchParams({ ownerOrgId: orgId, cityId, limit: "200" })}`).then((r) => r.vehicles),
    retry: (n, err) => !(err instanceof ApiError && err.status === 403) && n < 2,
  });
  if (cars.isLoading) return <p className="muted small">Loading cars…</p>;
  if (cars.error) {
    return cars.error instanceof ApiError && cars.error.status === 403
      ? <p className="small muted" style={{ margin: 0 }}>Fleet-service doesn't let your roles list this company's cars yet. Find them under <Link to="/staff/fleet/vehicles">Vehicles</Link>.</p>
      : <Problem error={cars.error} />;
  }
  const list = cars.data ?? [];
  if (list.length === 0) return <p className="small muted" style={{ margin: 0 }}>No cars registered yet.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Plate</th><th>Vehicle</th><th>Type</th><th>Status</th></tr></thead>
        <tbody>
          {list.map((v) => (
            <tr key={v.id}>
              <td className="mono"><Link to={`/staff/fleet/vehicles/${v.id}`}><strong>{v.plateNumber}</strong></Link></td>
              <td className="small">{vehicleName(v)} <span className="xs muted">· {v.year}</span></td>
              <td className="small">{v.vehicleType} <span className="xs muted">· {v.seats} seats</span></td>
              <td><Pill tone={statusTone(v.status)}>{statusWord(v.status)}</Pill></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Suspending a company signs its people out of it at once (their permission versions move). */
function SuspendOrgDrawer({ org, onClose }: { org: Org; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [key] = useState(newIdempotencyKey);
  const n = reason.trim().length;
  const run = useMutation({
    mutationFn: () => api("staff", `/api/identity/organizations/${org.id}/suspend`, { body: { reason: reason.trim() }, idempotencyKey: key }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["orgs"] });
      void qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
  return (
    <Drawer title={`Suspend ${org.name}`} onClose={onClose}>
      {run.isSuccess ? (
        <div className="stack" style={{ gap: "0.75rem" }}>
          <Notice tone="ok">{org.name} is suspended.</Notice>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
      ) : (
        <form className="stack" style={{ gap: "0.75rem" }} onSubmit={(e) => { e.preventDefault(); if (n >= ORG_REASON_MIN) setConfirming(true); }}>
          <p className="small muted" style={{ margin: 0 }}>
            {org.kind === "FLEET" ? "Its owners and managers lose the fleet portal, and its cars can't be given to drivers." : "Its people can't book on the company account."}{" "}
            Anyone who may suspend companies here can lift it later, with a reason.
          </p>
          <Problem error={run.error} />
          <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} disabled={confirming} maxLength={ORG_REASON_MAX}
            placeholder="What happened, and the ticket or case number" hint={n < ORG_REASON_MIN ? `${ORG_REASON_MIN - n} more characters` : "Goes into the audit log with your name."} />
          {confirming ? (
            <>
              <Notice tone="error">Suspend {org.name} now?</Notice>
              <div className="row" style={{ gap: "0.5rem" }}>
                <button type="button" className="btn danger" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? "Suspending…" : "Yes, suspend"}</button>
                <button type="button" className="btn ghost" disabled={run.isPending} onClick={() => setConfirming(false)}>Back</button>
              </div>
            </>
          ) : (
            <div className="row" style={{ gap: "0.5rem" }}>
              <button className="btn danger" disabled={n < ORG_REASON_MIN}>Suspend</button>
              <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            </div>
          )}
        </form>
      )}
    </Drawer>
  );
}

/** The company's people (auth-service; phones masked) and its suspension history. */
function CompanyMembers({ orgId }: { orgId: string }) {
  const q = useQuery({ queryKey: ["org-members", orgId], queryFn: () => api<OrgMembers>("staff", `/api/identity/organizations/${orgId}/members`) });
  if (q.isLoading) return <p className="muted small">Loading people…</p>;
  if (q.error) return <Problem error={q.error} />;
  const d = q.data!;
  return (
    <div className="stack" style={{ gap: "0.75rem" }}>
      {d.members.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Nobody yet.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Phone</th><th>Role</th><th>Since</th></tr></thead>
            <tbody>
              {d.members.map((m) => (
                <tr key={m.userId}>
                  <td>{m.name}{m.suspended ? <> <Pill tone="red">account suspended</Pill></> : null}</td>
                  <td className="mono small">{m.phone ?? "—"}</td>
                  <td className="small">{m.roles.map((r) => ORG_ROLE_WORD[r] ?? r).join(", ")}</td>
                  <td className="small">{dayAndTime(m.since)}{m.validUntil ? <div className="xs muted">until {dayAndTime(m.validUntil)}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.pendingInvitations ? <p className="xs muted" style={{ margin: 0 }}>{d.pendingInvitations} invitation{d.pendingInvitations > 1 ? "s" : ""} not accepted yet.</p> : null}
      {d.suspensions.length ? (
        <div>
          <h4 className="small" style={{ margin: "0 0 0.3rem" }}>Suspensions</h4>
          <ul className="stack small" style={{ listStyle: "none", padding: 0, margin: 0, gap: "0.35rem" }}>
            {d.suspensions.map((x) => (
              <li key={x.id}>
                {dayAndTime(x.suspendedAt)}: {x.reason}
                {x.reinstatedAt ? <span className="muted"> · lifted {dayAndTime(x.reinstatedAt)}: {x.reinstateReason}</span> : <span className="muted"> · still in force</span>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** fleet-service: the company's and its cars' documents that expired or lapse soon (document:read). */
function ExpiringPapers({ orgId }: { orgId: string }) {
  const [days, setDays] = useState(30);
  const q = useQuery({ queryKey: ["fleet-expiring", orgId, days], queryFn: () => api<ExpiringDocuments>("staff", `/api/fleet/organizations/${orgId}/expiring-documents?days=${days}`) });
  return (
    <div className="stack" style={{ gap: "0.5rem" }}>
      <div className="row" style={{ gap: "0.4rem" }}>
        {[7, 30, 90].map((n) => <button key={n} type="button" className="chip" aria-pressed={days === n} onClick={() => setDays(n)}>{n} days</button>)}
      </div>
      <Problem error={q.error} />
      {q.isLoading ? <p className="muted small">Loading…</p> : null}
      {q.data && q.data.documents.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Nothing expired or expiring within {days} days.</p> : null}
      {q.data?.documents.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Document</th><th>For</th><th>Expiry</th><th>Status</th></tr></thead>
            <tbody>
              {q.data.documents.map((d) => (
                <tr key={d.id} className={d.daysLeft !== null && d.daysLeft < 0 ? "urgent" : ""}>
                  <td className="small">{KIND_LABEL[d.kind] ?? d.kind}</td>
                  <td className="small">{d.vehicle ? <Link className="mono" to={`/staff/fleet/vehicles/${d.vehicle.id}`}>{d.vehicle.plateNumber}</Link> : "the company"}</td>
                  <td className="small">{d.expiresAt ?? "—"}<div className="xs muted">{daysLeftWord(d.daysLeft)}</div></td>
                  <td><Pill tone={statusTone(d.status)}>{statusWord(d.status)}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

/** Lifting a suspension restores the status from before it (verified, or waiting) and its people's roles. */
function ReinstateOrgDrawer({ org, onClose }: { org: Org; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const n = reason.trim().length;
  const run = useMutation({
    mutationFn: () => api<{ status: string }>("staff", `/api/identity/organizations/${org.id}/reinstate`, { body: { reason: reason.trim() } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["orgs"] });
      void qc.invalidateQueries({ queryKey: ["org-members", org.id] });
      void qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
  return (
    <Drawer title={`Lift the suspension of ${org.name}`} onClose={onClose}>
      {run.isSuccess ? (
        <div className="stack" style={{ gap: "0.75rem" }}>
          <Notice tone="ok">{org.name} is {run.data.status === "PENDING" ? "back to waiting for verification" : "active again"}.</Notice>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
      ) : (
        <form className="stack" style={{ gap: "0.75rem" }} onSubmit={(e) => { e.preventDefault(); if (n >= ORG_REASON_MIN) run.mutate(); }}>
          <p className="small muted" style={{ margin: 0 }}>The company goes back to how it was before the suspension, and its people can act for it again within seconds. Cars suspended separately stay suspended.</p>
          <Problem error={run.error} />
          <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={ORG_REASON_MAX}
            placeholder="Why it may operate again: the case outcome, payment received…" hint={n < ORG_REASON_MIN ? `${ORG_REASON_MIN - n} more characters` : "Goes into the audit log with your name."} />
          <div className="row" style={{ gap: "0.5rem" }}>
            <button className="btn" disabled={run.isPending || n < ORG_REASON_MIN}>{run.isPending ? "Lifting…" : "Lift the suspension"}</button>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          </div>
        </form>
      )}
    </Drawer>
  );
}
