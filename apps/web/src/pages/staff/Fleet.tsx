// Onboarding of drivers and vehicles (workflow 02, part B): the city review queue, the driver and
// vehicle directories, and one record page each, where documents are reviewed and the driver or
// vehicle approved.

import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight } from "lucide-react";
import type { Permission } from "@ride-app/shared-authz";
import { allowed, api } from "../../lib/api";
import { CITIES, CITY_NAMES, dayAndTime, shortId, since } from "../../lib/format";
import {
  KIND_LABEL, statusTone, statusWord, vehicleName,
  type Driver, type DriverDetail, type DriverStatus, type ReviewQueue, type Vehicle, type VehicleDetail, type VehicleStatus,
} from "../../lib/fleet";
import { useNow, useStaffCity } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { CityPicker } from "../../components/CityPicker";
import { DocumentChecklist } from "../../components/Documents";
import { Drawer, Empty, Notice, PageHead, Pill, Problem, SelectField, Stat, TextArea } from "../../components/ui";
import {
  isOpenTransfer, ownerLabel, REASON_MIN, TRANSFER_WORD, transferActions, transferTone, vehicleSuspendActions,
  type OwnerType, type VehicleTransfer,
} from "../../lib/fleet2";

interface OrgRow {
  id: string;
  name: string;
  kind: "FLEET" | "CORPORATE";
  legalName: string | null;
  status: string;
}

/** Company names for a city (org:read). Staff without it see short ids instead. */
function useOrgNames(cityId: string | null) {
  const { staff } = useSession();
  const enabled = !!cityId && allowed(staff.principal, "org:read", { cityId });
  const q = useQuery({ queryKey: ["orgs", cityId, "all"], enabled, queryFn: () => api<OrgRow[]>("staff", `/api/identity/organizations?cityId=${cityId}`) });
  return (id: string | null) => (id ? q.data?.find((o) => o.id === id) : undefined);
}

const StatusPill = ({ status }: { status: string }) => <Pill tone={statusTone(status)}>{statusWord(status)}</Pill>;

function Chips<T extends string>({ value, onChange, options }: { value: T | ""; onChange: (v: T | "") => void; options: [T | "", string][] }) {
  return (
    <div className="chips">
      {options.map(([v, label]) => (
        <button key={v || "all"} type="button" className="chip" aria-pressed={value === v} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

/** fleet-service lists have no cursor: the first page is 50, then up to its maximum of 200. */
const PAGE = 50;
const MAX_LIST = 200;

function MoreRows({ shown, limit, onMore }: { shown: number; limit: number; onMore: () => void }) {
  if (shown < limit) return null;
  return limit < MAX_LIST
    ? <div><button className="btn ghost sm" onClick={onMore}>Show more</button></div>
    : <p className="xs muted" style={{ margin: 0 }}>Showing the latest {MAX_LIST}. Narrow it down with the filters.</p>;
}

const REASON_WORD: Record<string, string> = { DOCUMENT_EXPIRED: "document expired", SAFETY: "safety", ONBOARDING: "documents", TRANSFERRED: "new owner" };

// ── review queue ──────────────────────────────────────────────────────────────

export function ReviewQueuePage() {
  const { cities, cityId, setCityId } = useStaffCity("document:review");
  const [tab, setTab] = useState<"drivers" | "vehicles" | "companies" | "transfers">("drivers");
  const now = useNow(60_000);
  const navigate = useNavigate();
  const queue = useQuery({ queryKey: ["fleet-queue", cityId], enabled: !!cityId, refetchInterval: 30_000, queryFn: () => api<ReviewQueue>("staff", `/api/fleet/review/queue?cityId=${cityId}`) });
  const org = useOrgNames(cityId);
  const { staff } = useSession();
  const transfersAllowed = !!cityId && allowed(staff.principal, "vehicle:transfer", { cityId });
  const transfers = useQuery({
    queryKey: ["fleet-transfers", cityId],
    enabled: transfersAllowed,
    refetchInterval: 60_000,
    queryFn: () => api<{ transfers: VehicleTransfer[] }>("staff", `/api/fleet/transfers?cityId=${cityId}&limit=200`).then((r) => r.transfers.filter(isOpenTransfer)),
  });
  const q = queue.data;
  const oldest = (iso: string | null | undefined) => (iso ? now - new Date(iso).getTime() > 24 * 3600_000 : false);

  if (!cityId) return <div className="page"><Empty title="No city">Your roles don't include a city to review.</Empty></div>;

  return (
    <div className="page stack" style={{ gap: "1.25rem" }}>
      <PageHead
        title="Review queue"
        lede="Drivers, vehicles and companies waiting for a document check, oldest first. The target is 24 hours."
        right={<CityPicker cities={cities} value={cityId} onChange={setCityId} />}
      />
      <div className="stats">
        <Stat label="Drivers waiting" value={q?.drivers.length ?? "–"} alert={q?.drivers.some((d) => oldest(d.submittedAt))} sub={q?.drivers[0]?.submittedAt ? `oldest ${since(q.drivers[0].submittedAt, now)}` : undefined} />
        <Stat label="Vehicles waiting" value={q?.vehicles.length ?? "–"} alert={q?.vehicles.some((v) => oldest(v.submittedAt))} sub={q?.vehicles[0]?.submittedAt ? `oldest ${since(q.vehicles[0].submittedAt, now)}` : undefined} />
        <Stat label="Company documents" value={q?.organizations.length ?? "–"} />
        <Stat label="Expiring within 30 days" value={q?.expiringSoon ?? "–"} sub="approved documents" />
      </div>
      <Problem error={queue.error} />

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "drivers"} onClick={() => setTab("drivers")}>Drivers {q ? `· ${q.drivers.length}` : ""}</button>
        <button role="tab" aria-selected={tab === "vehicles"} onClick={() => setTab("vehicles")}>Vehicles {q ? `· ${q.vehicles.length}` : ""}</button>
        <button role="tab" aria-selected={tab === "companies"} onClick={() => setTab("companies")}>Companies {q ? `· ${q.organizations.length}` : ""}</button>
        {transfersAllowed ? <button role="tab" aria-selected={tab === "transfers"} onClick={() => setTab("transfers")}>Ownership transfers {transfers.data ? `· ${transfers.data.length}` : ""}</button> : null}
      </div>

      {queue.isLoading ? <p className="muted small">Loading…</p> : null}
      {q && tab === "drivers" ? (
        q.drivers.length === 0 ? <Empty title="No driver applications waiting." /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Driver</th><th>Licence</th><th>Waiting</th><th className="num">Documents to check</th><th /></tr></thead>
              <tbody>
                {q.drivers.map((d) => (
                  <tr key={d.userId} className={oldest(d.submittedAt) ? "urgent" : ""} style={{ cursor: "pointer" }} onClick={() => navigate(`/staff/fleet/drivers/${d.userId}`)}>
                    <td><strong>{d.fullName}</strong></td>
                    <td className="mono">{d.licenseNumber}</td>
                    <td className="small">{since(d.submittedAt, now)}</td>
                    <td className="num mono">{d.pendingDocuments}</td>
                    <td className="num"><ChevronRight size={16} className="muted" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
      {q && tab === "vehicles" ? (
        q.vehicles.length === 0 ? <Empty title="No vehicles waiting." /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Plate</th><th>Vehicle</th><th>Owner</th><th>Waiting</th><th className="num">Documents to check</th><th /></tr></thead>
              <tbody>
                {q.vehicles.map((v) => (
                  <tr key={v.id} className={oldest(v.submittedAt) ? "urgent" : ""} style={{ cursor: "pointer" }} onClick={() => navigate(`/staff/fleet/vehicles/${v.id}`)}>
                    <td className="mono"><strong>{v.plateNumber}</strong></td>
                    <td>{vehicleName(v)}<div className="xs muted">{v.vehicleType} · {v.seats} seats · {v.year}</div></td>
                    <td className="small">{v.ownerType === "INDIVIDUAL" ? "owner-driver" : org(v.ownerOrgId)?.name ?? `company ${shortId(v.ownerOrgId!)}`}</td>
                    <td className="small">{since(v.submittedAt, now)}</td>
                    <td className="num mono">{v.pendingDocuments}</td>
                    <td className="num"><ChevronRight size={16} className="muted" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
      {q && tab === "companies" ? (
        q.organizations.length === 0 ? <Empty title="No company documents waiting." /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Company</th><th>Status</th><th>Waiting</th><th className="num">Documents to check</th><th /></tr></thead>
              <tbody>
                {q.organizations.map((o) => {
                  const row = org(o.orgId);
                  return (
                    <tr key={o.orgId} style={{ cursor: "pointer" }} onClick={() => navigate(`/staff/onboarding?org=${o.orgId}`)}>
                      <td><strong>{row?.name ?? shortId(o.orgId)}</strong><div className="xs muted">{row?.kind === "FLEET" ? "fleet" : row ? "company account" : ""}</div></td>
                      <td>{row ? <StatusPill status={row.status === "PENDING" ? "PENDING_REVIEW" : row.status} /> : null}</td>
                      <td className="small">{since(o.oldest, now)}</td>
                      <td className="num mono">{o.pendingDocuments}</td>
                      <td className="num"><ChevronRight size={16} className="muted" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : null}
      {tab === "transfers" && transfersAllowed ? (
        <div className="stack" style={{ gap: "0.75rem" }}>
          <p className="small muted" style={{ margin: 0 }}>A car changing owner (sold by a driver to a fleet, the reverse, or between fleets). One officer proposes, a different officer approves; the car then needs its documents checked again under the new owner.</p>
          <Problem error={transfers.error} />
          {transfers.isLoading ? <p className="muted small">Loading…</p> : null}
          {transfers.data && transfers.data.length === 0 ? <Empty title="No transfers waiting." /> : null}
          {transfers.data?.map((t) => <TransferItem key={t.id} t={t} orgName={(id) => org(id)?.name} showVehicle />)}
        </div>
      ) : null}
    </div>
  );
}

// ── ownership transfers ───────────────────────────────────────────────────────

/** One transfer with what this officer may do: propose an owner's request, approve, reject, withdraw. */
function TransferItem({ t, orgName, showVehicle = false }: { t: VehicleTransfer; orgName: (id: string) => string | undefined; showVehicle?: boolean }) {
  const { staff } = useSession();
  const qc = useQueryClient();
  const actions = transferActions(staff.principal, t);
  const act = useMutation({
    mutationFn: (a: { path: string; body?: object }) => api("staff", `/api/fleet/transfers/${t.id}/${a.path}`, { body: a.body ?? {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["fleet-transfers"] });
      void qc.invalidateQueries({ queryKey: ["fleet-vehicle", t.vehicleId] });
      void qc.invalidateQueries({ queryKey: ["fleet-vehicles"] });
    },
  });
  return (
    <div className="card">
      <div className="card-body stack" style={{ gap: "0.4rem" }}>
        <div className="row between" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
          <span className="small">
            {showVehicle && t.vehicle ? <><Link className="mono" to={`/staff/fleet/vehicles/${t.vehicleId}`}><strong>{t.vehicle.plateNumber}</strong></Link> · </> : null}
            {ownerLabel(t.from, orgName)} → <strong>{ownerLabel(t.to, orgName)}</strong>
          </span>
          <Pill tone={transferTone(t.status)}>{TRANSFER_WORD[t.status]}</Pill>
        </div>
        <span className="small">{t.reason}</span>
        <span className="xs muted">
          {t.requestedBy ? "asked by the owner" : "started by staff"} · {dayAndTime(t.createdAt)}
          {isOpenTransfer(t) ? ` · expires ${dayAndTime(t.expiresAt)}` : t.decidedAt ? ` · decided ${dayAndTime(t.decidedAt)}` : ""}
          {t.decisionNote ? ` · note: ${t.decisionNote}` : ""}
        </span>
        <Problem error={act.error} />
        {actions.waitingForOther ? <span className="xs muted">You proposed it: a different officer approves.</span> : null}
        {actions.endorse || actions.approve || actions.reject || actions.cancel ? (
          <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
            {actions.endorse ? <button className="btn secondary sm" disabled={act.isPending} onClick={() => act.mutate({ path: "endorse" })}>Propose it (you're the first officer)</button> : null}
            {actions.approve ? (
              <button className="btn sm" disabled={act.isPending} onClick={() => confirm("Approve the transfer? Its driving session and fleet authorisations end, and the new owner uploads a registration in their name.") && act.mutate({ path: "approve" })}>Approve transfer</button>
            ) : null}
            {actions.reject ? (
              <ReasonAction label="Reject" title="Reject the transfer" hint="e.g. the sale contract isn't signed by the company" minLength={REASON_MIN} danger pending={act.isPending}
                onConfirm={(reason) => act.mutateAsync({ path: "reject", body: { reason } })} />
            ) : null}
            {actions.cancel ? <button className="btn ghost sm" disabled={act.isPending} onClick={() => act.mutate({ path: "cancel" })}>Withdraw</button> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** An officer starts a transfer (they are the maker): to a driver of the city, or a verified fleet. */
function StartTransfer({ v, onClose }: { v: VehicleDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const [type, setType] = useState<OwnerType>(v.ownerType === "INDIVIDUAL" ? "ORGANIZATION" : "INDIVIDUAL");
  const [search, setSearch] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const drivers = useQuery({
    queryKey: ["fleet-drivers", "transfer", v.cityId, search.trim()],
    enabled: type === "INDIVIDUAL" && search.trim().length >= 2,
    queryFn: () => api<{ drivers: Driver[] }>("staff", `/api/fleet/drivers?${new URLSearchParams({ cityId: v.cityId, q: search.trim(), limit: "20" })}`).then((r) => r.drivers),
  });
  const fleets = useQuery({
    queryKey: ["orgs", v.cityId, "VERIFIED"],
    enabled: type === "ORGANIZATION",
    queryFn: () => api<OrgRow[]>("staff", `/api/identity/organizations?cityId=${v.cityId}&status=VERIFIED`),
  });
  const run = useMutation({
    mutationFn: () => api("staff", `/api/fleet/vehicles/${v.id}/transfers`, { body: { toOwnerType: type, toOwnerId: to, reason: reason.trim() } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["fleet-transfers"] });
      onClose();
    },
  });
  const choices = type === "ORGANIZATION" ? (fleets.data ?? []).filter((o) => o.kind === "FLEET" && o.id !== v.ownerOrgId) : (drivers.data ?? []).filter((d) => d.userId !== v.ownerUserId);
  return (
    <Drawer title={`Transfer ${v.plateNumber} to a new owner`} onClose={onClose}>
      <form className="stack" style={{ gap: "0.5rem" }} onSubmit={(e) => { e.preventDefault(); run.mutate(); }}>
        <p className="small muted" style={{ margin: 0 }}>You propose it; a different onboarding officer approves. Then the car's session and fleet authorisations end, and the new owner uploads a registration in their name (the other documents are checked again).</p>
        <Problem error={run.error ?? fleets.error ?? drivers.error} />
        <SelectField label="New owner" value={type} onChange={(e) => { setType(e.target.value as OwnerType); setTo(""); }}>
          <option value="INDIVIDUAL">A driver (owner-driver)</option>
          <option value="ORGANIZATION">A fleet company</option>
        </SelectField>
        {type === "INDIVIDUAL" ? (
          <div className="field">
            <label className="label" htmlFor="transfer-search">Find the driver</label>
            <input id="transfer-search" className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or last 4 of the licence" />
          </div>
        ) : null}
        <SelectField label={type === "INDIVIDUAL" ? "Driver" : "Company"} value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose…</option>
          {type === "ORGANIZATION"
            ? (choices as OrgRow[]).map((o) => <option key={o.id} value={o.id}>{o.name}{o.legalName ? ` (${o.legalName})` : ""}</option>)
            : (choices as Driver[]).map((d) => <option key={d.userId} value={d.userId}>{d.fullName} · {d.licenseNumber} · {statusWord(d.status)}</option>)}
        </SelectField>
        <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The sale and its paperwork, e.g. contract number" maxLength={500}
          hint={reason.trim().length < REASON_MIN ? `at least ${REASON_MIN} characters` : "Goes into the audit log with your name."} />
        <div><button className="btn" disabled={run.isPending || !to || reason.trim().length < REASON_MIN}>Propose the transfer</button></div>
      </form>
    </Drawer>
  );
}

// ── directories ───────────────────────────────────────────────────────────────

export function DriverDirectory() {
  const { cities, cityId, setCityId } = useStaffCity("driver:read");
  const [status, setStatus] = useState<DriverStatus | "">("");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const navigate = useNavigate();
  const params = new URLSearchParams({ cityId: cityId ?? "", limit: String(limit), ...(status ? { status } : {}), ...(q.trim().length >= 2 ? { q: q.trim() } : {}) });
  const list = useQuery({
    queryKey: ["fleet-drivers", params.toString()],
    enabled: !!cityId,
    placeholderData: (prev) => prev,
    queryFn: () => api<{ drivers: Driver[] }>("staff", `/api/fleet/drivers?${params}`).then((r) => r.drivers),
  });

  if (!cityId) return <div className="page"><Empty title="No city">Your roles don't include a city.</Empty></div>;
  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead title="Drivers" lede="Every driver application and active driver in the city." right={<CityPicker cities={cities} value={cityId} onChange={setCityId} />} />
      <div className="row between" style={{ flexWrap: "wrap", gap: "0.75rem" }}>
        <Chips value={status} onChange={(s) => { setStatus(s); setLimit(PAGE); }} options={[["", "All"], ["APPLIED", "Applying"], ["PENDING_REVIEW", "Waiting for review"], ["ACTIVE", "Active"], ["SUSPENDED", "Suspended"]]} />
        <input className="input" style={{ maxWidth: "18rem" }} placeholder="Name or last 4 of the licence" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} aria-label="Search drivers" />
      </div>
      <Problem error={list.error} />
      {list.isLoading ? <p className="muted small">Loading…</p> : null}
      {list.data && list.data.length === 0 ? <Empty title="No drivers match." /> : null}
      {list.data?.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Driver</th><th>Licence</th><th>Status</th><th>Applied</th><th>Active since</th></tr></thead>
            <tbody>
              {list.data.map((d) => (
                <tr key={d.userId} style={{ cursor: "pointer" }} onClick={() => navigate(`/staff/fleet/drivers/${d.userId}`)}>
                  <td><strong>{d.fullName}</strong></td>
                  <td className="mono">{d.licenseNumber}</td>
                  <td><StatusPill status={d.status} />{d.statusReason && REASON_WORD[d.statusReason] ? <span className="xs muted"> {REASON_WORD[d.statusReason]}</span> : null}</td>
                  <td className="small">{dayAndTime(d.createdAt)}</td>
                  <td className="small">{d.activatedAt ? dayAndTime(d.activatedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.data ? <MoreRows shown={list.data.length} limit={limit} onMore={() => setLimit(MAX_LIST)} /> : null}
    </div>
  );
}

export function VehicleDirectory() {
  const { cities, cityId, setCityId } = useStaffCity("vehicle:read");
  const [status, setStatus] = useState<VehicleStatus | "">("");
  const [owner, setOwner] = useState<"" | "INDIVIDUAL" | "ORGANIZATION">("");
  const [plate, setPlate] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const navigate = useNavigate();
  const org = useOrgNames(cityId);
  const list = useQuery({
    queryKey: ["fleet-vehicles", cityId, status, limit],
    enabled: !!cityId,
    placeholderData: (prev) => prev,
    queryFn: () => api<{ vehicles: Vehicle[] }>("staff", `/api/fleet/vehicles?${new URLSearchParams({ cityId: cityId ?? "", limit: String(limit), ...(status ? { status } : {}) })}`).then((r) => r.vehicles),
  });
  // fleet-service filters by city and status; owner and plate narrow what was loaded
  const needle = plate.replace(/[\s-]/g, "").toUpperCase();
  const rows = (list.data ?? []).filter((v) => (!owner || v.ownerType === owner) && (!needle || v.plateNumber.replace(/[\s-]/g, "").toUpperCase().includes(needle)));

  if (!cityId) return <div className="page"><Empty title="No city">Your roles don't include a city.</Empty></div>;
  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead title="Vehicles" lede="Owner-drivers' cars and fleet cars registered in the city." right={<CityPicker cities={cities} value={cityId} onChange={setCityId} />} />
      <Chips value={status} onChange={(s) => { setStatus(s); setLimit(PAGE); }} options={[["", "All"], ["PENDING_REVIEW", "Waiting for review"], ["VERIFIED", "Verified"], ["SUSPENDED", "Suspended"], ["REJECTED", "Rejected"], ["DRAFT", "Draft"], ["RETIRED", "Retired"]]} />
      <div className="row between" style={{ flexWrap: "wrap", gap: "0.75rem" }}>
        <Chips value={owner} onChange={setOwner} options={[["", "Any owner"], ["INDIVIDUAL", "Owner-drivers"], ["ORGANIZATION", "Fleet cars"]]} />
        <input className="input" style={{ maxWidth: "14rem" }} placeholder="Plate" value={plate} onChange={(e) => setPlate(e.target.value)} aria-label="Filter by plate" />
      </div>
      <Problem error={list.error} />
      {list.isLoading ? <p className="muted small">Loading…</p> : null}
      {list.data && rows.length === 0 ? <Empty title="No vehicles match.">{list.data.length >= limit && limit < MAX_LIST ? "Only the latest are loaded; show more to search further." : null}</Empty> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Plate</th><th>Vehicle</th><th>Type</th><th>Owner</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/staff/fleet/vehicles/${v.id}`)}>
                  <td className="mono"><strong>{v.plateNumber}</strong></td>
                  <td>{vehicleName(v)} <span className="xs muted">· {v.year}</span></td>
                  <td>{v.vehicleType} <span className="xs muted">· {v.seats} seats</span></td>
                  <td className="small">{v.ownerType === "INDIVIDUAL" ? "owner-driver" : org(v.ownerOrgId)?.name ?? `company ${shortId(v.ownerOrgId!)}`}</td>
                  <td><StatusPill status={v.status} />{v.statusReason && REASON_WORD[v.statusReason] ? <span className="xs muted"> {REASON_WORD[v.statusReason]}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.data ? <MoreRows shown={list.data.length} limit={limit} onMore={() => setLimit(MAX_LIST)} /> : null}
    </div>
  );
}

// ── decisions ─────────────────────────────────────────────────────────────────

/** A button that opens a drawer asking for a written reason, then runs the action. */
function ReasonAction({ label, title, hint, minLength = 3, danger = false, onConfirm, pending }: {
  label: string; title: string; hint: string; minLength?: number; danger?: boolean; pending: boolean; onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      <button className={`btn ${danger ? "danger" : "secondary"}`} onClick={() => setOpen(true)}>{label}</button>
      {open ? (
        <Drawer title={title} onClose={() => setOpen(false)}>
          <form onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            onConfirm(reason.trim()).then(() => setOpen(false), setError);
          }}>
            <Problem error={error} />
            <div className="field">
              <label className="label" htmlFor="reason">Reason</label>
              <textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={hint} autoFocus />
              <span className="hint">{reason.trim().length < minLength ? `at least ${minLength} characters` : "They see this, and it goes into the audit log."}</span>
            </div>
            <button className={`btn ${danger ? "danger" : ""}`} disabled={pending || reason.trim().length < minLength}>{label}</button>
          </form>
        </Drawer>
      ) : null}
    </>
  );
}

function useCan() {
  const { staff } = useSession();
  return (permission: Permission, cityId: string | undefined) => !!cityId && allowed(staff.principal, permission, { cityId });
}

function Missing({ kinds, what, verb = "approving" }: { kinds: string[]; what: string; verb?: string }) {
  if (!kinds.length) return <span className="small" style={{ color: "var(--success)" }}><CheckCircle2 size={14} style={{ verticalAlign: "-2px" }} /> all documents approved</span>;
  return <span className="small muted">Approve {kinds.map((k) => KIND_LABEL[k]?.toLowerCase() ?? k).join(", ")} before {verb} the {what}.</span>;
}

function SessionCard({ session }: { session: { startedAt: string; vehicleId: string; driverUserId: string } | null; children?: ReactNode }) {
  return (
    <div className="card">
      <div className="card-head"><h2>Right now</h2></div>
      <div className="card-body small">
        {session ? <>Online since {dayAndTime(session.startedAt)} · <Link to={`/staff/fleet/vehicles/${session.vehicleId}`}>vehicle</Link> · <Link to={`/staff/fleet/drivers/${session.driverUserId}`}>driver</Link></> : <span className="muted">Offline</span>}
      </div>
    </div>
  );
}

// ── driver record ─────────────────────────────────────────────────────────────

export function DriverRecord() {
  const { userId } = useParams();
  const qc = useQueryClient();
  const can = useCan();
  const driver = useQuery({ queryKey: ["fleet-driver", userId], queryFn: () => api<DriverDetail>("staff", `/api/fleet/drivers/${userId}`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["fleet-driver", userId] });
    void qc.invalidateQueries({ queryKey: ["fleet-queue"] });
    void qc.invalidateQueries({ queryKey: ["fleet-drivers"] });
  };
  const act = useMutation({
    mutationFn: (a: { path: string; body?: object }) => api("staff", `/api/fleet/drivers/${userId}/${a.path}`, { body: a.body ?? {} }),
    onSuccess: refresh,
  });

  if (driver.isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (driver.error) return <div className="page"><Problem error={driver.error} /></div>;
  const d = driver.data!;
  const city = d.cityId;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <p className="xs muted" style={{ margin: 0 }}><Link to="/staff/fleet/drivers">Drivers</Link> / {d.fullName}</p>
      <PageHead
        title={<span className="row" style={{ gap: "0.6rem" }}>{d.fullName} <StatusPill status={d.status} /></span>}
        lede={<>Licence <span className="mono">{d.licenseNumber}</span> · {CITY_NAMES[city] ?? city} · applied {dayAndTime(d.createdAt)}{d.activatedAt ? ` · active since ${dayAndTime(d.activatedAt)}` : ""}</>}
        right={
          <>
            {d.status === "PENDING_REVIEW" && can("driver:verify", city) ? (
              <>
                <ReasonAction label="Request changes" title="Send the application back" hint="What they need to fix, e.g. retake the photo in daylight" pending={act.isPending}
                  onConfirm={(reason) => act.mutateAsync({ path: "request-changes", body: { reason } })} />
                <button className="btn" disabled={act.isPending || d.missingForApproval.length > 0 || !can("driver:activate", city)} onClick={() => act.mutate({ path: "approve" })}
                  title={can("driver:activate", city) ? undefined : "Activating a driver needs the driver:activate permission"}>Approve driver</button>
              </>
            ) : null}
            {d.status !== "SUSPENDED" && can("driver:suspend", city) ? (
              <ReasonAction label="Suspend" title={`Suspend ${d.fullName}`} hint="Incident or ticket number and what happened" minLength={10} danger pending={act.isPending}
                onConfirm={(reason) => act.mutateAsync({ path: "suspend", body: { reason } })} />
            ) : null}
            {d.status === "SUSPENDED" && can("driver:reinstate", city) ? (
              <ReasonAction label="Reinstate" title={`Reinstate ${d.fullName}`} hint="Why they may drive again" minLength={10} pending={act.isPending}
                onConfirm={(reason) => act.mutateAsync({ path: "reinstate", body: { reason } })} />
            ) : null}
          </>
        }
      />
      <Problem error={act.error} />
      {d.reviewNote ? <Notice tone={d.status === "SUSPENDED" ? "error" : "info"}>{d.status === "SUSPENDED" ? "Suspended" : "Last note"}: {d.reviewNote}</Notice> : null}
      {d.status === "SUSPENDED" && d.statusReason === "DOCUMENT_EXPIRED" ? <Notice tone="error">Suspended because a document expired. The driver uploads the renewed one and resubmits.</Notice> : null}
      {d.status === "PENDING_REVIEW" ? <div><Missing kinds={d.missingForApproval} what="driver" /></div> : null}
      {d.status === "PENDING_REVIEW" && !can("driver:activate", city) ? <p className="small muted" style={{ margin: 0 }}>You can send the application back; approving it needs someone who may activate drivers.</p> : null}
      {d.status === "SUSPENDED" && can("driver:reinstate", city) && d.missingForApproval.length ? <div><Missing kinds={d.missingForApproval} what="driver" verb="reinstating" /></div> : null}

      <div className="two-col wide-left">
        <section className="card">
          <div className="card-head"><h2>Documents</h2></div>
          <div className="card-body" style={{ paddingTop: "0.25rem" }}>
            <DocumentChecklist surface="staff" subjectType="DRIVER" subjectId={d.userId} mode="staff" canReview={can("document:review", city)} onChange={refresh} />
          </div>
        </section>
        <div className="stack" style={{ gap: "1rem", alignContent: "start" }}>
          <div className="card">
            <div className="card-head"><h2>Vehicles</h2></div>
            <div className="card-body">
              {d.vehicles.length + d.fleetVehicles.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No vehicle yet. Fleet drivers get one from their fleet owner.</p> : null}
              <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: "0.5rem" }}>
                {d.vehicles.map((v) => (
                  <li key={v.id} className="row between"><Link to={`/staff/fleet/vehicles/${v.id}`} className="mono">{v.plateNumber}</Link><span className="small muted">own car</span><StatusPill status={v.status} /></li>
                ))}
                {d.fleetVehicles.map((v) => (
                  <li key={v.id} className="row between"><Link to={`/staff/fleet/vehicles/${v.id}`} className="mono">{v.plateNumber}</Link><span className="small muted">fleet car · {v.authorization.status.toLowerCase()}</span><StatusPill status={v.status} /></li>
                ))}
              </ul>
            </div>
          </div>
          <SessionCard session={d.session} />
          {CITIES.some((c) => can("user:suspend", c)) ? (
            <div className="card">
              <div className="card-head"><h2>Account</h2></div>
              <div className="card-body small">
                Suspending the driver stops driving only. To lock the whole account (rider app too), use <Link to={`/staff/safety?user=${d.userId}`}>Suspend</Link>.
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── vehicle record ────────────────────────────────────────────────────────────

export function VehicleRecord() {
  const { id } = useParams();
  const qc = useQueryClient();
  const can = useCan();
  const vehicle = useQuery({ queryKey: ["fleet-vehicle", id], queryFn: () => api<VehicleDetail>("staff", `/api/fleet/vehicles/${id}`) });
  const org = useOrgNames(vehicle.data?.cityId ?? null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["fleet-vehicle", id] });
    void qc.invalidateQueries({ queryKey: ["fleet-queue"] });
    void qc.invalidateQueries({ queryKey: ["fleet-vehicles"] });
  };
  const act = useMutation({
    mutationFn: (a: { path: string; body?: object }) => api("staff", `/api/fleet/vehicles/${id}/${a.path}`, { body: a.body ?? {} }),
    onSuccess: refresh,
  });
  const { staff } = useSession();
  const transfers = useQuery({
    queryKey: ["fleet-transfers", "vehicle", id],
    queryFn: () => api<{ transfers: VehicleTransfer[] }>("staff", `/api/fleet/vehicles/${id}/transfers`).then((r) => r.transfers),
  });
  const [transferring, setTransferring] = useState(false);

  if (vehicle.isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (vehicle.error) return <div className="page"><Problem error={vehicle.error} /></div>;
  const v = vehicle.data!;
  const company = org(v.ownerOrgId);
  const suspendable = vehicleSuspendActions(staff.principal, v);
  const openTransfer = transfers.data?.find(isOpenTransfer);

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <p className="xs muted" style={{ margin: 0 }}><Link to="/staff/fleet/vehicles">Vehicles</Link> / {v.plateNumber}</p>
      <PageHead
        title={<span className="row" style={{ gap: "0.6rem" }}><span className="mono">{v.plateNumber}</span> <StatusPill status={v.status} /></span>}
        lede={<>{vehicleName(v)} · {v.year} · {v.vehicleType}, {v.seats} seats · {CITY_NAMES[v.cityId] ?? v.cityId}</>}
        right={
          <>
            {v.status === "PENDING_REVIEW" && can("vehicle:verify", v.cityId) ? (
              <>
                <ReasonAction label="Reject" title={`Reject ${v.plateNumber}`} hint="e.g. the registration names someone else" danger pending={act.isPending}
                  onConfirm={(reason) => act.mutateAsync({ path: "reject", body: { reason } })} />
                <button className="btn" disabled={act.isPending || v.missingForApproval.length > 0} onClick={() => act.mutate({ path: "approve" })}>Approve vehicle</button>
              </>
            ) : null}
            {suspendable.suspend ? (
              <ReasonAction label="Suspend vehicle" title={`Take ${v.plateNumber} off the road`} hint="Incident or ticket number and what happened. Its driving session ends now." minLength={REASON_MIN} danger pending={act.isPending}
                onConfirm={(reason) => act.mutateAsync({ path: "suspend", body: { reason, category: can("vehicle:verify", v.cityId) ? "ONBOARDING" : "SAFETY" } })} />
            ) : null}
            {suspendable.reinstate ? (
              <ReasonAction label="Reinstate vehicle" title={`Put ${v.plateNumber} back on the road`} hint="Why it may take trips again" minLength={REASON_MIN} pending={act.isPending}
                onConfirm={(reason) => act.mutateAsync({ path: "reinstate", body: { reason } })} />
            ) : null}
          </>
        }
      />
      <Problem error={act.error} />
      {v.reviewNote ? <Notice tone={v.status === "REJECTED" ? "error" : "info"}>Last note: {v.reviewNote}</Notice> : null}
      {v.statusReason === "DOCUMENT_EXPIRED" ? <Notice tone="error">Suspended because a document expired. The owner uploads the renewed one and resubmits.</Notice> : null}
      {v.status === "SUSPENDED" && (v.statusReason === "SAFETY" || v.statusReason === "ONBOARDING") ? <Notice tone="error">Suspended by staff ({REASON_WORD[v.statusReason]}). Reinstating needs every document approved and in date.</Notice> : null}
      {v.statusReason === "TRANSFERRED" ? <Notice>New owner: the registration in their name is needed, and the other documents are checked again before the car takes trips.</Notice> : null}

      <div className="two-col wide-left">
        <section className="card">
          <div className="card-head"><h2>Documents</h2>{v.status === "PENDING_REVIEW" ? <Missing kinds={v.missingForApproval} what="vehicle" /> : null}</div>
          <div className="card-body" style={{ paddingTop: "0.25rem" }}>
            <p className="small muted" style={{ marginTop: 0 }}>
              The registration must name {v.ownerType === "INDIVIDUAL" ? "the driver" : <>the company: <strong>{company?.legalName ?? company?.name ?? "its legal name"}</strong></>} (rule V2).
            </p>
            <DocumentChecklist surface="staff" subjectType="VEHICLE" subjectId={v.id} mode="staff" canReview={can("document:review", v.cityId)} onChange={refresh} />
          </div>
        </section>
        <div className="stack" style={{ gap: "1rem", alignContent: "start" }}>
          <div className="card">
            <div className="card-head"><h2>Owner</h2></div>
            <div className="card-body small">
              {v.ownerType === "INDIVIDUAL"
                ? <>Owner-driver · <Link to={`/staff/fleet/drivers/${v.ownerUserId}`}>open the driver</Link></>
                : <>
                    {company ? <strong>{company.name}</strong> : `Company ${shortId(v.ownerOrgId!)}`}
                    {company ? <> · <Pill tone={company.status === "VERIFIED" ? "green" : company.status === "SUSPENDED" ? "red" : "amber"}>{company.status.toLowerCase()}</Pill></> : null}
                    {can("org:read", v.cityId) || can("org:suspend", v.cityId) ? <> · <Link to={`/staff/onboarding?org=${v.ownerOrgId}`}>open the company</Link></> : null}
                  </>}
            </div>
          </div>
          {v.ownerType === "ORGANIZATION" ? (
            <div className="card">
              <div className="card-head"><h2>Drivers allowed</h2></div>
              <div className="card-body">
                {v.authorizations.filter((a) => a.status === "ACTIVE").length === 0 ? <p className="small muted" style={{ margin: 0 }}>The fleet owner hasn't given this car to anyone.</p> : null}
                <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: "0.4rem" }}>
                  {v.authorizations.filter((a) => a.status === "ACTIVE").map((a) => (
                    <li key={a.driverUserId} className="row between small">
                      <Link to={`/staff/fleet/drivers/${a.driverUserId}`} className="mono">{shortId(a.driverUserId)}</Link>
                      <span className="muted">{a.validUntil ? `until ${dayAndTime(a.validUntil)}` : "no end date"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
          <SessionCard session={v.session} />
          <div className="card">
            <div className="card-head"><h2>Ownership transfers</h2></div>
            <div className="card-body stack" style={{ gap: "0.5rem" }}>
              <Problem error={transfers.error} />
              {transfers.data && transfers.data.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Never changed owner.</p> : null}
              {transfers.data?.map((t) => <TransferItem key={t.id} t={t} orgName={(oid) => org(oid)?.name} />)}
              {!openTransfer && v.status !== "RETIRED" && can("vehicle:transfer", v.cityId) ? (
                <div><button className="btn secondary sm" onClick={() => setTransferring(true)}>Start a transfer</button></div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {transferring ? <StartTransfer v={v} onClose={() => setTransferring(false)} /> : null}
    </div>
  );
}
