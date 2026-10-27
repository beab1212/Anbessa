// Fleet portal (workflow 03, parts B–D): company cars with their documents, which drivers may use
// each car, and the company's own papers. Company accounts use the documents part only.

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Car, ChevronRight, Plus } from "lucide-react";
import { allowed, api, authCall } from "../../lib/api";
import { dayAndTime, phone as fmtPhone, placeholderEmailToPhone } from "../../lib/format";
import {
  KIND_LABEL, statusTone, statusWord, VEHICLE_TYPES, vehicleName,
  type FleetOverview, type Vehicle, type VehicleDetail,
} from "../../lib/fleet";
import { useSession } from "../../lib/session";
import { DocumentChecklist, useDocuments } from "../../components/Documents";
import { Drawer, Empty, Field, Notice, PageHead, Pill, Problem, SelectField, TextArea } from "../../components/ui";
import { fleetMayAskTransfer, isOpenTransfer, REASON_MIN, TRANSFER_WORD, transferBody, transferTone, type VehicleTransfer } from "../../lib/fleet2";

export interface Member {
  id: string;
  userId: string;
  role: string;
  createdAt: string;
  user: { name: string; email: string };
}

export const memberName = (m: Pick<Member, "user">) => {
  const p = placeholderEmailToPhone(m.user.email);
  return p ? fmtPhone(p) : m.user.name;
};

const StatusPill = ({ status }: { status: string }) => <Pill tone={statusTone(status)}>{statusWord(status)}</Pill>;

/** Vehicles, drivers' onboarding status and who's driving, for one fleet. */
export function useFleetOverview(orgId: string, members: Member[], enabled = true) {
  const ids = members.filter((m) => m.role.includes("fleet_driver")).map((m) => m.userId).sort();
  return useQuery({
    queryKey: ["fleet-overview", orgId, ids.join(",")],
    enabled,
    refetchInterval: 30_000,
    queryFn: () => api<FleetOverview>("partner", `/api/fleet/organizations/${orgId}/overview?members=${ids.join(",")}`),
  });
}

/** The fleet's driver column: where they are in onboarding, which cars they may use, whether they're online. */
export function DriverCell({ overview, userId }: { overview: FleetOverview | undefined; userId: string }) {
  if (!overview) return null;
  const d = overview.drivers.find((x) => x.userId === userId);
  const cars = overview.vehicles.filter((v) => v.authorizations.some((a) => a.driverUserId === userId && a.status === "ACTIVE"));
  return (
    <div className="small">
      {d?.driver ? <StatusPill status={d.driver.status} /> : <span className="muted">hasn't applied in the app yet</span>}
      {d?.session ? <> <Pill tone="green" pulse>online</Pill></> : null}
      {cars.length ? <div className="xs muted" style={{ marginTop: "0.2rem" }}>{cars.map((c) => c.plateNumber).join(", ")}</div> : null}
    </div>
  );
}

// ── vehicles tab ──────────────────────────────────────────────────────────────

export function FleetVehicles({ orgId, verified, members }: { orgId: string; verified: boolean; members: Member[] }) {
  const { partner } = useSession();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const overview = useFleetOverview(orgId, members);
  const canAdd = verified && allowed(partner.principal, "vehicle:register", { orgId });
  const vehicles = overview.data?.vehicles ?? [];
  const live = vehicles.filter((v) => v.status !== "RETIRED");
  const [showRetired, setShowRetired] = useState(false);
  const retired = useQuery({
    queryKey: ["fleet-retired", orgId],
    enabled: showRetired,
    queryFn: () => api<{ vehicles: Vehicle[] }>("partner", `/api/fleet/vehicles?ownerOrgId=${orgId}&status=RETIRED`).then((r) => r.vehicles),
  });

  return (
    <div className="stack" style={{ gap: "1rem" }}>
      <div className="row between">
        <p className="small muted" style={{ margin: 0 }}>Cars owned by the company. Each one needs its registration (naming the company), insurance and inspection before it can take trips.</p>
        {canAdd ? <button className="btn" onClick={() => setAdding(true)}><Plus /> Add vehicle</button> : null}
      </div>
      {!verified ? <Notice>You can add vehicles once the company is verified.</Notice> : null}
      <Problem error={overview.error} />
      {overview.isLoading ? <p className="muted small">Loading…</p> : null}
      {overview.data && live.length === 0 ? <Empty title="No vehicles yet.">{canAdd ? "Add your first car." : null}</Empty> : null}
      {live.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Plate</th><th>Vehicle</th><th>Status</th><th>Drivers</th><th>Right now</th><th /></tr></thead>
            <tbody>
              {live.map((v) => {
                const allowedDrivers = v.authorizations.filter((a) => a.status === "ACTIVE");
                const driving = v.session ? members.find((m) => m.userId === v.session!.driverUserId) : undefined;
                return (
                  <tr key={v.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/partner/org/${orgId}/vehicles/${v.id}`)}>
                    <td className="mono"><strong>{v.plateNumber}</strong></td>
                    <td>{vehicleName(v)}<div className="xs muted">{v.vehicleType} · {v.seats} seats · {v.year}</div></td>
                    <td>
                      <StatusPill status={v.status} />
                      {v.status === "DRAFT" || v.status === "REJECTED" ? <div className="xs muted">{v.missingForSubmit.length ? `${v.missingForSubmit.length} document${v.missingForSubmit.length > 1 ? "s" : ""} to upload` : "ready to submit"}</div> : null}
                      {v.documents.some((d) => d.document?.expiringSoon) ? <div className="xs" style={{ color: "var(--warning)" }}>a document expires soon</div> : null}
                    </td>
                    <td className="small">{allowedDrivers.length || <span className="muted">none</span>}</td>
                    <td className="small">{v.session ? <><Pill tone="green" pulse>online</Pill> {driving ? memberName(driving) : ""}</> : <span className="muted">parked</span>}</td>
                    <td className="num"><ChevronRight size={16} className="muted" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="row between">
        <label className="row small" style={{ gap: "0.4rem", cursor: "pointer" }}>
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show cars removed from the fleet
        </label>
      </div>
      {showRetired ? (
        <section className="card">
          <div className="card-head"><h2>Removed from the fleet {retired.data ? <span className="muted mono small">{retired.data.length}</span> : null}</h2></div>
          <Problem error={retired.error} />
          {retired.isLoading ? <p className="muted small" style={{ padding: "0 0.9rem" }}>Loading…</p> : null}
          {retired.data && retired.data.length === 0 ? <div className="card-body"><p className="small muted" style={{ margin: 0 }}>No removed cars.</p></div> : null}
          {retired.data?.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Plate</th><th>Vehicle</th><th>Added</th><th /></tr></thead>
                <tbody>
                  {retired.data.map((v) => (
                    <tr key={v.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/partner/org/${orgId}/vehicles/${v.id}`)}>
                      <td className="mono">{v.plateNumber}</td>
                      <td>{vehicleName(v)}<div className="xs muted">{v.vehicleType} · {v.seats} seats · {v.year}</div></td>
                      <td className="small muted">{dayAndTime(v.createdAt)}</td>
                      <td className="num"><ChevronRight size={16} className="muted" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}
      <OpenTransfers orgId={orgId} />
      {adding ? <AddVehicle orgId={orgId} onClose={() => setAdding(false)} onAdded={(v) => navigate(`/partner/org/${orgId}/vehicles/${v.id}`)} /> : null}
    </div>
  );
}

/** Cars on their way out of, or into, the company (ownership transfers waiting for our onboarding team). */
function OpenTransfers({ orgId }: { orgId: string }) {
  const { partner } = useSession();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["fleet-transfers", "org", orgId],
    enabled: allowed(partner.principal, "vehicle:read", { orgId }),
    queryFn: () => api<{ transfers: VehicleTransfer[] }>("partner", `/api/fleet/transfers?ownerOrgId=${orgId}&limit=100`).then((r) => r.transfers),
  });
  const open = (q.data ?? []).filter(isOpenTransfer);
  if (!open.length && !q.error) return null;
  return (
    <section className="card">
      <div className="card-head"><h2>Ownership changes in progress</h2></div>
      <div className="card-body stack" style={{ gap: "0.4rem" }}>
        <Problem error={q.error} />
        {open.map((t) => {
          const outgoing = t.from.type === "ORGANIZATION" && t.from.id === orgId;
          return (
            <div key={t.id} className="row between small" style={{ cursor: outgoing ? "pointer" : undefined }} onClick={() => outgoing && navigate(`/partner/org/${orgId}/vehicles/${t.vehicleId}`)}>
              <span><span className="mono">{t.vehicle?.plateNumber}</span> · {outgoing ? `leaving the fleet → ${t.to.type === "INDIVIDUAL" ? t.to.name ?? "a driver" : "another company"}` : "coming to the fleet"}</span>
              <Pill tone={transferTone(t.status)}>{TRANSFER_WORD[t.status]}</Pill>
            </div>
          );
        })}
        <p className="xs muted" style={{ margin: 0 }}>Our onboarding team checks each change (two people). A car that arrives needs a registration naming the company before it takes trips.</p>
      </div>
    </section>
  );
}

function AddVehicle({ orgId, onClose, onAdded }: { orgId: string; onClose: () => void; onAdded: (v: Vehicle) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ plateNumber: "", vehicleType: "economy", make: "", model: "", year: String(new Date().getFullYear() - 5), color: "", seats: "4" });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const type = VEHICLE_TYPES.find((t) => t.id === form.vehicleType)!;
  const add = useMutation({
    mutationFn: () => api<Vehicle>("partner", "/api/fleet/vehicles", {
      body: { ownerType: "ORGANIZATION", ownerOrgId: orgId, ...form, year: Number(form.year), seats: Number(form.seats) },
    }),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: ["fleet-overview", orgId] });
      onAdded(v);
    },
  });
  return (
    <Drawer title="Add a company vehicle" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <Problem error={add.error} />
        <Field label="Plate number" className="mono" required value={form.plateNumber} onChange={set("plateNumber")} placeholder="3-A12345 AA" />
        <SelectField label="Service" value={form.vehicleType} onChange={(e) => {
          const t = VEHICLE_TYPES.find((x) => x.id === e.target.value)!;
          setForm((f) => ({ ...f, vehicleType: t.id, seats: String(Math.min(Math.max(Number(f.seats), t.seats[0]), t.seats[1])) }));
        }}>
          {VEHICLE_TYPES.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.seats[0]}–{t.seats[1]} seats)</option>)}
        </SelectField>
        <div className="two-col" style={{ gap: "0 0.75rem" }}>
          <Field label="Make" required value={form.make} onChange={set("make")} placeholder="Toyota" />
          <Field label="Model" required value={form.model} onChange={set("model")} placeholder="Corolla" />
          <Field label="Year" required inputMode="numeric" value={form.year} onChange={set("year")} />
          <Field label="Colour" required value={form.color} onChange={set("color")} placeholder="White" />
        </div>
        <Field label="Passenger seats" required inputMode="numeric" value={form.seats} onChange={set("seats")} hint={`${type.seats[0]}–${type.seats[1]} for ${type.name}`} />
        <button className="btn" disabled={add.isPending}>Add, then upload documents</button>
      </form>
    </Drawer>
  );
}

// ── one vehicle ───────────────────────────────────────────────────────────────

export function FleetVehiclePage() {
  const { orgId, vehicleId } = useParams();
  const { partner } = useSession();
  const qc = useQueryClient();
  const org = useQuery({
    queryKey: ["org", orgId],
    queryFn: () => authCall<{ name: string; legalName?: string; members: Member[] }>("partner", `/organization/get-full-organization?organizationId=${orgId}`),
  });
  const vehicle = useQuery({ queryKey: ["fleet-vehicle", vehicleId], queryFn: () => api<VehicleDetail>("partner", `/api/fleet/vehicles/${vehicleId}`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["fleet-vehicle", vehicleId] });
    void qc.invalidateQueries({ queryKey: ["fleet-overview", orgId] });
    void qc.invalidateQueries({ queryKey: ["fleet-retired", orgId] });
  };
  const submit = useMutation({ mutationFn: () => api("partner", `/api/fleet/vehicles/${vehicleId}/submit`, { body: {} }), onSuccess: refresh });
  const retire = useMutation({ mutationFn: () => api("partner", `/api/fleet/vehicles/${vehicleId}/retire`, { body: {} }), onSuccess: refresh });
  const [driverId, setDriverId] = useState("");
  const [until, setUntil] = useState("");
  const grant = useMutation({
    mutationFn: () => api("partner", `/api/fleet/vehicles/${vehicleId}/authorizations`, { body: { driverUserId: driverId, ...(until ? { validUntil: `${until}T23:59:59+03:00` } : {}) } }),
    onSuccess: () => { setDriverId(""); setUntil(""); refresh(); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api("partner", `/api/fleet/vehicles/${vehicleId}/authorizations/${id}`, { method: "DELETE" }), onSuccess: refresh });
  const transfers = useQuery({
    queryKey: ["fleet-transfers", "vehicle", vehicleId],
    queryFn: () => api<{ transfers: VehicleTransfer[] }>("partner", `/api/fleet/vehicles/${vehicleId}/transfers`).then((r) => r.transfers),
  });
  const withdraw = useMutation({
    mutationFn: (id: string) => api("partner", `/api/fleet/transfers/${id}/cancel`, { body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["fleet-transfers"] }),
  });
  const [transferring, setTransferring] = useState(false);

  if (vehicle.isLoading || org.isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (vehicle.error || org.error) return <div className="page"><Problem error={vehicle.error ?? org.error} /></div>;
  const v = vehicle.data!;
  const o = org.data!;
  const p = partner.principal;
  const canAuthorize = allowed(p, "vehicle:authorize_driver", { orgId });
  const canEdit = allowed(p, "document:upload", { orgId }) && v.status !== "RETIRED";
  const drivers = o.members.filter((m) => m.role.includes("fleet_driver"));
  const active = v.authorizations.filter((a) => a.status === "ACTIVE");
  const nameOf = (userId: string) => {
    const m = o.members.find((x) => x.userId === userId);
    return m ? memberName(m) : "former member";
  };
  const submittable = ["DRAFT", "REJECTED"].includes(v.status) || (v.status === "SUSPENDED" && v.statusReason === "DOCUMENT_EXPIRED");

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <p className="xs muted" style={{ margin: 0 }}><Link to={`/partner/org/${orgId}?tab=vehicles`}>{o.name} · vehicles</Link> / {v.plateNumber}</p>
      <PageHead
        title={<span className="row" style={{ gap: "0.6rem" }}><span className="mono">{v.plateNumber}</span> <StatusPill status={v.status} /></span>}
        lede={<>{vehicleName(v)} · {v.year} · {v.vehicleType}, {v.seats} seats</>}
        right={
          <>
            {submittable && canEdit ? (
              <button className="btn" disabled={submit.isPending || v.missingForSubmit.length > 0} onClick={() => submit.mutate()}>Submit for review</button>
            ) : null}
            {v.status !== "RETIRED" && allowed(p, "vehicle:retire", { orgId }) ? (
              <button className="btn ghost" disabled={retire.isPending} onClick={() => confirm(`Remove ${v.plateNumber} from the fleet? Drivers lose access and it can't take trips.`) && retire.mutate()}>Remove from fleet</button>
            ) : null}
          </>
        }
      />
      <Problem error={submit.error ?? retire.error} />
      {v.status === "DRAFT" ? <Notice>Upload the three documents, then submit. Our onboarding team checks them, usually within a day.</Notice> : null}
      {v.status === "PENDING_REVIEW" ? <Notice>Waiting for our onboarding team. You'll see the result here.</Notice> : null}
      {v.status === "REJECTED" ? <Notice tone="error">Not approved: {v.reviewNote}. Replace the documents marked rejected, then submit again.</Notice> : null}
      {v.statusReason === "DOCUMENT_EXPIRED" ? <Notice tone="error">Suspended: a document expired. Upload the renewed one and submit again; the car can't take trips until then.</Notice> : null}
      {v.status === "SUSPENDED" && (v.statusReason === "SAFETY" || v.statusReason === "ONBOARDING") ? <Notice tone="error">Suspended by our team{v.reviewNote ? `: ${v.reviewNote}` : ""}. Contact support; the car can't take trips until it's reinstated.</Notice> : null}
      {v.statusReason === "TRANSFERRED" ? <Notice>This car just changed owner. Upload a registration naming <strong>{o.legalName ?? o.name}</strong>, then submit; the other documents are checked again.</Notice> : null}
      {submittable && v.missingForSubmit.length ? <p className="small muted" style={{ margin: 0 }}>Still needed: {v.missingForSubmit.map((k) => KIND_LABEL[k]?.toLowerCase() ?? k).join(", ")}.</p> : null}

      <div className="two-col wide-left">
        <section className="card">
          <div className="card-head"><h2>Documents</h2></div>
          <div className="card-body" style={{ paddingTop: "0.25rem" }}>
            <p className="small muted" style={{ marginTop: 0 }}>The registration must name <strong>{o.legalName ?? o.name}</strong>.</p>
            <DocumentChecklist surface="partner" subjectType="VEHICLE" subjectId={v.id} mode="owner" locked={!canEdit || v.status === "PENDING_REVIEW"} onChange={refresh} />
          </div>
        </section>
        <div className="stack" style={{ gap: "1rem", alignContent: "start" }}>
          <div className="card">
            <div className="card-head"><h2>Who may drive it</h2></div>
            <div className="card-body stack" style={{ gap: "0.75rem" }}>
              <Problem error={grant.error ?? revoke.error} />
              {active.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Nobody yet.</p> : (
                <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: "0.4rem" }}>
                  {active.map((a) => (
                    <li key={a.driverUserId} className="row between small">
                      {allowed(p, "driver:read", { orgId }) ? <Link className="mono" to={`/partner/org/${orgId}/drivers/${a.driverUserId}`}>{nameOf(a.driverUserId)}</Link> : <span className="mono">{nameOf(a.driverUserId)}</span>}
                      <span className="muted">{a.validUntil ? `until ${dayAndTime(a.validUntil)}` : ""}</span>
                      {canAuthorize ? <button className="link danger" disabled={revoke.isPending} onClick={() => confirm(`Take ${v.plateNumber} away from ${nameOf(a.driverUserId)}? They can't drive it until you allow them again.`) && revoke.mutate(a.driverUserId)}>take away</button> : null}
                    </li>
                  ))}
                </ul>
              )}
              {canAuthorize && v.status !== "RETIRED" ? (
                drivers.length === 0 ? <p className="xs muted" style={{ margin: 0 }}>Invite drivers on the People tab first.</p> : (
                  <form className="stack" style={{ gap: "0.5rem" }} onSubmit={(e) => { e.preventDefault(); grant.mutate(); }}>
                    <SelectField label="Give it to" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
                      <option value="">Choose a driver…</option>
                      {drivers.filter((m) => !active.some((a) => a.driverUserId === m.userId)).map((m) => <option key={m.userId} value={m.userId}>{memberName(m)}</option>)}
                    </SelectField>
                    <Field label="Until (optional)" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
                    <div><button className="btn secondary" disabled={!driverId || grant.isPending}><Car /> Allow</button></div>
                  </form>
                )
              ) : null}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Right now</h2></div>
            <div className="card-body small">
              {v.session ? <><Pill tone="green" pulse>online</Pill> {nameOf(v.session.driverUserId)} since {dayAndTime(v.session.startedAt)}</> : <span className="muted">Parked</span>}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Change of owner</h2></div>
            <div className="card-body stack" style={{ gap: "0.5rem" }}>
              <Problem error={transfers.error ?? withdraw.error} />
              {(transfers.data ?? []).map((t) => (
                <div key={t.id} className="small stack" style={{ gap: "0.15rem" }}>
                  <div className="row between">
                    <span>{t.to.type === "ORGANIZATION" ? (t.to.id === orgId ? "to this company" : "to another company") : `to ${t.to.name ?? "a driver"}`}</span>
                    <Pill tone={transferTone(t.status)}>{TRANSFER_WORD[t.status]}</Pill>
                  </div>
                  <span className="xs muted">{dayAndTime(t.createdAt)} · {t.reason}{t.decisionNote && t.status === "REJECTED" ? ` · ${t.decisionNote}` : ""}</span>
                  {isOpenTransfer(t) && t.requestedBy === p?.userId ? <div><button className="link danger" disabled={withdraw.isPending} onClick={() => withdraw.mutate(t.id)}>withdraw</button></div> : null}
                </div>
              ))}
              {fleetMayAskTransfer(p, orgId!, v) && !(transfers.data ?? []).some(isOpenTransfer) && v.ownerOrgId === orgId ? (
                <div><button className="btn ghost sm" onClick={() => setTransferring(true)}>Hand this car to a new owner</button></div>
              ) : null}
              {transfers.data && transfers.data.length === 0 && !fleetMayAskTransfer(p, orgId!, v) ? <p className="small muted" style={{ margin: 0 }}>No changes.</p> : null}
            </div>
          </div>
        </div>
      </div>
      {transferring ? <AskTransfer vehicleId={v.id} plate={v.plateNumber} drivers={drivers} onClose={() => setTransferring(false)} /> : null}
    </div>
  );
}

/** The fleet asks to hand a car over (sold to one of its drivers, or to another company); our team decides. */
function AskTransfer({ vehicleId, plate, drivers, onClose }: { vehicleId: string; plate: string; drivers: Member[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ target: "driver" as "driver" | "company", driverId: "", orgId: "", reason: "" });
  const body = transferBody(form);
  const run = useMutation({
    mutationFn: () => api("partner", `/api/fleet/vehicles/${vehicleId}/transfers`, { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["fleet-transfers"] });
      onClose();
    },
  });
  return (
    <Drawer title={`Hand ${plate} to a new owner`} onClose={onClose}>
      <form className="stack" style={{ gap: "0.5rem" }} onSubmit={(e) => { e.preventDefault(); if (body) run.mutate(); }}>
        <p className="small muted" style={{ margin: 0 }}>Our onboarding team checks the sale (two people). When it goes through, the car leaves the fleet: its drivers lose access and the new owner registers it in their name.</p>
        <Problem error={run.error} />
        <SelectField label="New owner" value={form.target} onChange={(e) => setForm((f) => ({ ...f, target: e.target.value as "driver" | "company" }))}>
          <option value="driver">One of our drivers (they'll own and drive it)</option>
          <option value="company">Another fleet company</option>
        </SelectField>
        {form.target === "driver" ? (
          <SelectField label="Driver" value={form.driverId} onChange={(e) => setForm((f) => ({ ...f, driverId: e.target.value }))}>
            <option value="">Choose a driver…</option>
            {drivers.map((m) => <option key={m.userId} value={m.userId}>{memberName(m)}</option>)}
          </SelectField>
        ) : (
          <Field label="The other company's Anbessa ID" className="mono" value={form.orgId} onChange={(e) => setForm((f) => ({ ...f, orgId: e.target.value }))}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" hint="They find it in the address of their fleet portal (/partner/org/…)." />
        )}
        <TextArea label="Reason" value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} maxLength={500}
          placeholder="The sale, e.g. contract number and date" hint={form.reason.trim().length < REASON_MIN ? `at least ${REASON_MIN} characters` : "Our team sees this."} />
        <div><button className="btn" disabled={!body || run.isPending}>Ask for the transfer</button></div>
      </form>
    </Drawer>
  );
}

// ── company documents tab ─────────────────────────────────────────────────────

export function CompanyDocuments({ orgId, kind, status }: { orgId: string; kind: "FLEET" | "CORPORATE"; status: string }) {
  const { partner } = useSession();
  const docs = useDocuments("partner", "ORGANIZATION", orgId);
  const canUpload = allowed(partner.principal, "document:upload", { orgId });
  const missing = docs.data?.missingForSubmit ?? [];
  return (
    <section className="card">
      <div className="card-head"><h2>Company documents</h2></div>
      <div className="card-body" style={{ paddingTop: "0.25rem" }}>
        <p className="small muted" style={{ marginTop: 0 }}>
          {status === "PENDING"
            ? `Our onboarding team checks these before verifying the ${kind === "FLEET" ? "fleet" : "company account"}.`
            : "Keep these current. Replace them when they're renewed."}
          {missing.length && status === "PENDING" ? ` Still needed: ${missing.map((k) => KIND_LABEL[k]?.toLowerCase() ?? k).join(", ")}.` : ""}
        </p>
        <DocumentChecklist surface="partner" subjectType="ORGANIZATION" subjectId={orgId} mode="owner" locked={!canUpload} />
      </div>
    </section>
  );
}
