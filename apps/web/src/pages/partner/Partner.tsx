import { useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Truck } from "lucide-react";
import type { Trip } from "@ride-app/shared-types";
import { allowed, api, authCall, http, newIdempotencyKey } from "../../lib/api";
import { birr, CITIES, CITY_NAMES, clock, dayAndTime, phone as fmtPhone, phoneToPlaceholderEmail, placeholderEmailToPhone, shortId, toE164 } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import {
  bookedTrips, imageToDataUrl, invitationOpen, quoteUsable, rememberBookedTrip, roleList, switchedRole, vehicleChoices,
  type Fare, type Invitation,
} from "../../lib/partner";
import { useClientConfig } from "../../lib/platform";
import { decodePolyline6 } from "../../lib/polyline";
import { useSession } from "../../lib/session";
import { PlacePicker, type Place } from "../../components/PlacePicker";
import { CityMap } from "../../components/map/CityMap";
import { DropoffMarker, PickupMarker, RouteLine, TripLine } from "../../components/map/markers";
import { Drawer, Empty, Field, Notice, PageHead, Pill, Problem, SelectField } from "../../components/ui";
import { CompanyDocuments, DriverCell, FleetVehicles, useFleetOverview, type Member } from "./Fleet";
import { BalancePanel } from "../money/BalancePanel";
import type { Balance } from "../../lib/money";

export interface Org {
  id: string;
  name: string;
  slug: string;
  kind: "FLEET" | "CORPORATE";
  cityId: string;
  legalName?: string;
  tin?: string;
  status: "PENDING" | "VERIFIED" | "SUSPENDED";
  logo?: string | null;
  createdAt: string;
}

interface FullOrg extends Org {
  members: Member[];
  invitations: Invitation[];
}

/** pricing-service quote (POST /api/pricing/estimates), the fields the booking page shows. */
interface Quote {
  id: string;
  vehicleType: string;
  fareMinor: number;
  distanceMeters: number;
  durationSeconds: number;
  etaToPickupSeconds: number | null;
  driversNearby: number;
  expiresAt?: string;
}

export const useOrgs = () =>
  useQuery({ queryKey: ["my-orgs"], queryFn: () => authCall<Org[]>("partner", "/organization/list") });

const ROLE_WORD: Record<string, string> = {
  fleet_owner: "owner", fleet_driver: "driver", corporate_admin: "admin", corporate_coordinator: "coordinator", employee: "employee",
};

const who = (m: { user: { name: string; email: string } }) => {
  const p = placeholderEmailToPhone(m.user.email);
  return p ? fmtPhone(p) : m.user.name;
};

/** /partner — straight to the only company, the list if several, the form if none. */
export function PartnerHome() {
  const orgs = useOrgs();
  if (orgs.isLoading) return <p className="muted">Loading…</p>;
  if (orgs.error) return <Problem error={orgs.error} />;
  const list = orgs.data ?? [];
  if (list.length === 0) return <Navigate to="/partner/register" replace />;
  if (list.length === 1) return <Navigate to={`/partner/org/${list[0]!.id}`} replace />;
  return (
    <div className="page">
      <PageHead title="Your companies" />
      <ul className="choose" style={{ maxWidth: "36rem" }}>
        {list.map((o) => (
          <li key={o.id}>
            <Link to={`/partner/org/${o.id}`}>
              {o.kind === "FLEET" ? <Truck /> : <Building2 />}
              <span><strong>{o.name}</strong><span>{o.kind === "FLEET" ? "fleet" : "company account"} · {CITY_NAMES[o.cityId] ?? o.cityId} · {o.status.toLowerCase()}</span></span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Workflow 03 / 11: register a fleet company or a company account. It starts PENDING. */
export function RegisterCompany() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { refresh } = useSession();
  const [kind, setKind] = useState<"FLEET" | "CORPORATE">("FLEET");
  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [tin, setTin] = useState("");
  const [cityId, setCityId] = useState(CITIES[0]!);
  const create = useMutation({
    mutationFn: () => {
      const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}-${crypto.randomUUID().slice(0, 6)}`;
      return authCall<Org>("partner", "/organization/create", { name: name.trim(), slug, kind, cityId, legalName: legalName.trim(), tin: tin.trim() });
    },
    onSuccess: async (org) => {
      await qc.invalidateQueries({ queryKey: ["my-orgs"] });
      await refresh("partner"); // you are now its owner / admin
      navigate(`/partner/org/${org.id}`);
    },
  });

  return (
    <div className="page">
      <PageHead title="Register your company" lede="We check the TIN against the business licence before the account goes live. Until then you can look around, but not invite people or book." />
      <form className="card pad" style={{ maxWidth: "34rem" }} onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Problem error={create.error} />
        <fieldset className="options">
          <legend className="label">What kind</legend>
          <label className="option"><input type="radio" checked={kind === "FLEET"} onChange={() => setKind("FLEET")} /> <span><strong>Fleet company</strong><br /><span className="muted small">You own cars and other people drive them. Earnings from your cars go to the company.</span></span></label>
          <label className="option"><input type="radio" checked={kind === "CORPORATE"} onChange={() => setKind("CORPORATE")} /> <span><strong>Company account</strong><br /><span className="muted small">Your staff ride on the company, and you get one invoice.</span></span></label>
        </fieldset>
        <Field label="Name people know you by" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Selam Transport" />
        <Field label="Legal name (as on the licence)" required value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="Selam Transport PLC" />
        <Field label="TIN" required inputMode="numeric" pattern="\d{10}" maxLength={10} className="mono" value={tin} onChange={(e) => setTin(e.target.value.replace(/\D/g, ""))} hint="10 digits" />
        <SelectField label="City" value={cityId} onChange={(e) => setCityId(e.target.value)}>
          {CITIES.map((c) => <option key={c} value={c}>{CITY_NAMES[c]}</option>)}
        </SelectField>
        <button className="btn" disabled={create.isPending || tin.length !== 10}>Register</button>
      </form>
    </div>
  );
}

/** One company: its status, its people, invitations by phone, and booking for company accounts. */
export function OrgPage() {
  const { orgId } = useParams();
  const { partner } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const org = useQuery({
    queryKey: ["org", orgId],
    queryFn: () => authCall<FullOrg>("partner", `/organization/get-full-organization?organizationId=${orgId}`),
  });
  const p = partner.principal;
  const manages = allowed(p, "org:manage_members", { orgId });
  const invitations = useQuery({
    queryKey: ["org-invitations", orgId],
    enabled: manages,
    queryFn: () => authCall<Invitation[]>("partner", `/organization/list-invitations?organizationId=${orgId}`),
  });
  const refreshOrg = () => {
    void qc.invalidateQueries({ queryKey: ["org", orgId] });
    void qc.invalidateQueries({ queryKey: ["org-invitations", orgId] });
  };
  const [raw, setRaw] = useState("");
  const [role, setRole] = useState("");
  const invite = useMutation({
    mutationFn: (a: { phone: string; role: string }) => authCall("partner", "/organization/invite-member", { email: phoneToPlaceholderEmail(a.phone), role: a.role, organizationId: orgId }),
    onSuccess: () => { setRaw(""); refreshOrg(); },
  });
  const cancelInvite = useMutation({
    mutationFn: (invitationId: string) => authCall("partner", "/organization/cancel-invitation", { invitationId }),
    onSuccess: refreshOrg,
  });
  const remove = useMutation({
    mutationFn: (memberId: string) => authCall("partner", "/organization/remove-member", { memberIdOrEmail: memberId, organizationId: orgId }),
    onSuccess: refreshOrg,
  });
  const changeRole = useMutation({
    mutationFn: (a: { memberId: string; role: string }) => authCall("partner", "/organization/update-member-role", { memberId: a.memberId, role: a.role, organizationId: orgId }),
    onSuccess: refreshOrg,
  });
  const [editing, setEditing] = useState(false);
  const [tripRef, setTripRef] = useState("");
  const [params, setParams] = useSearchParams();
  const isFleet = org.data?.kind === "FLEET";
  const overview = useFleetOverview(orgId!, org.data?.members ?? [], isFleet && allowed(p, "vehicle:read", { orgId }));

  if (org.isLoading) return <p className="muted">Loading…</p>;
  if (org.error) return <Problem error={org.error} />;
  const o = org.data!;
  const fleet = o.kind === "FLEET";
  const edits = allowed(p, "org:update", { orgId: o.id });
  const books = !fleet && allowed(p, "trip:create_on_behalf", { orgId: o.id });
  const readsTrips = allowed(p, "trip:read", { orgId: o.id });
  const readsDrivers = fleet && allowed(p, "driver:read", { orgId: o.id });
  const inviteRoles = fleet ? ["fleet_driver"] : ["employee", "corporate_coordinator"];
  const chosenRole = role || inviteRoles[0]!;
  const e164 = toE164(raw);
  const allInvites = invitations.data ?? o.invitations;
  const pendingInvites = allInvites.filter((i) => i.status === "pending");
  const booked = !fleet && readsTrips ? bookedTrips(o.id) : [];
  const tabs = [
    ["people", fleet ? "Drivers and people" : "People"],
    ...(fleet && allowed(p, "vehicle:read", { orgId: o.id }) ? [["vehicles", "Vehicles"]] : []),
    ...(fleet && o.status === "VERIFIED" && allowed(p, "balance:read", { orgId: o.id }) ? [["balance", "Balance"]] : []),
    ...(allowed(p, "document:upload", { orgId: o.id }) ? [["documents", "Documents"]] : []),
  ];
  const tab = tabs.some(([t]) => t === params.get("tab")) ? params.get("tab")! : "people";

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title={<span className="row" style={{ gap: "0.6rem" }}>{o.logo ? <img src={o.logo} alt="" style={{ width: "2.25rem", height: "2.25rem", objectFit: "contain", borderRadius: "0.4rem" }} /> : null}{o.name}</span>}
        lede={<>{fleet ? "Fleet" : "Company account"} · {CITY_NAMES[o.cityId] ?? o.cityId} · {o.legalName} · TIN <span className="mono">{o.tin}</span></>}
        right={
          <>
            {o.status === "VERIFIED" ? <Pill tone="green">verified</Pill> : o.status === "PENDING" ? <Pill tone="amber">waiting for verification</Pill> : <Pill tone="red">suspended</Pill>}
            {readsTrips ? <Link className="btn sm ghost" to={`/partner/org/${o.id}/trips`}>Trips</Link> : null}
            {fleet && allowed(p, "earnings:read", { orgId: o.id }) ? <Link className="btn sm ghost" to={`/partner/org/${o.id}/earnings`}>Earnings</Link> : null}
            {!fleet && allowed(p, "payment:read", { orgId: o.id }) ? <Link className="btn sm ghost" to={`/partner/org/${o.id}/charges`}>Charges</Link> : null}
            {!fleet && allowed(p, "corporate:read_invoices", { orgId: o.id }) ? <Link className="btn sm ghost" to={`/partner/org/${o.id}/invoices`}>Invoices</Link> : null}
            {!fleet && readsTrips ? <Link className="btn sm ghost" to={`/partner/org/${o.id}/scheduled`}>Booked ahead</Link> : null}
            {!fleet && (allowed(p, "corporate:manage_policies", { orgId: o.id }) || allowed(p, "trip:bill_corporate", { orgId: o.id })) ? <Link className="btn sm ghost" to={`/partner/org/${o.id}/policy`}>Ride policy</Link> : null}
            {edits ? <button className="btn sm ghost" onClick={() => setEditing(true)}>Edit name and logo</button> : null}
          </>
        }
      />

      {o.status === "PENDING" ? <Notice>Our onboarding team is checking your details. Inviting {fleet ? "drivers" : "people"}{fleet ? "" : " and booking rides"} opens once you're verified.</Notice> : null}
      {o.status === "SUSPENDED" ? <Notice tone="error">This account is suspended. Contact Anbessa support.</Notice> : null}
      <Problem error={invite.error ?? cancelInvite.error ?? remove.error ?? changeRole.error} />

      {tabs.length > 1 ? (
        <div className="tabs" role="tablist">
          {tabs.map(([t, label]) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setParams(t === "people" ? {} : { tab: t! })}>{label}</button>)}
        </div>
      ) : null}
      {tab === "vehicles" ? <FleetVehicles orgId={o.id} verified={o.status === "VERIFIED"} members={o.members} /> : null}
      {tab === "documents" ? <CompanyDocuments orgId={o.id} kind={o.kind} status={o.status} /> : null}
      {tab === "balance" ? <FleetBalance orgId={o.id} cityId={o.cityId} owner={allowed(p, "topup:create", { orgId: o.id })} /> : null}

      {tab === "people" ? <div className="two-col wide-left">
        <div className="stack" style={{ gap: "1rem", alignContent: "start" }}>
        <section className="card">
          <div className="card-head"><h2>{fleet ? "Drivers" : "People"} <span className="muted mono small">{o.members.length}</span></h2></div>
          <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead><tr><th>Who</th><th>Role</th>{fleet ? <th>As a driver</th> : null}<th>Since</th><th /></tr></thead>
            <tbody>
              {o.members.map((m) => {
                const isDriver = roleList(m.role).includes("fleet_driver");
                const next = !fleet && manages && m.userId !== p?.userId ? switchedRole(m.role) : null;
                return (
                  <tr key={m.id}>
                    <td className="mono">{isDriver && readsDrivers ? <Link to={`/partner/org/${o.id}/drivers/${m.userId}`}>{who(m)}</Link> : who(m)}</td>
                    <td>{roleList(m.role).map((r) => ROLE_WORD[r] ?? r).join(", ")}</td>
                    {fleet ? <td>{isDriver ? <DriverCell overview={overview.data} userId={m.userId} /> : null}</td> : null}
                    <td className="small muted">{dayAndTime(m.createdAt)}</td>
                    <td className="num"><span className="row" style={{ gap: "0.6rem", justifyContent: "flex-end" }}>
                      {next ? (
                        <button className="link" disabled={changeRole.isPending} onClick={() => confirm(next === "corporate_coordinator"
                          ? `Make ${who(m)} a coordinator? They can book and cancel rides for anyone on ${o.name}.`
                          : `Make ${who(m)} an employee? They stop booking for others.`) && changeRole.mutate({ memberId: m.id, role: next })}>
                          make {ROLE_WORD[next]}
                        </button>
                      ) : null}
                      {manages && m.userId !== p?.userId && !m.role.includes("owner") && !m.role.includes("corporate_admin") ? <button className="link danger" disabled={remove.isPending} onClick={() => confirm(`Remove ${who(m)} from ${o.name}?${isDriver ? " They lose access to every company car." : ""}`) && remove.mutate(m.id)}>remove</button> : null}
                    </span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {manages ? (
            <>
              <h3 className="label" style={{ margin: "1.2rem 0.9rem 0.2rem" }}>Invited, not joined yet</h3>
              {invitations.error ? <div style={{ padding: "0 0.9rem" }}><Problem error={invitations.error} /></div> : null}
              {pendingInvites.length === 0 ? <p className="small muted" style={{ margin: "0.3rem 0.9rem 0.9rem" }}>No open invitations.</p> : (
                <table className="table">
                  <tbody>
                    {pendingInvites.map((i) => {
                      const open = invitationOpen(i);
                      const phone = fmtPhone(placeholderEmailToPhone(i.email) ?? i.email);
                      return (
                        <tr key={i.id}>
                          <td className="mono">{phone}</td>
                          <td>{ROLE_WORD[i.role] ?? i.role}</td>
                          <td className="muted small">{open ? `until ${dayAndTime(i.expiresAt)}` : <Pill>expired {dayAndTime(i.expiresAt)}</Pill>}</td>
                          <td><button className="link" disabled={cancelInvite.isPending} onClick={() => confirm(`Withdraw the invitation to ${phone}?`) && cancelInvite.mutate(i.id)}>{open ? "withdraw" : "clear"}</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </>
          ) : null}
          </div>
        </section>

        {readsTrips ? (
          <section className="card">
            <div className="card-head"><h2>Trips</h2></div>
            <div className="card-body stack" style={{ gap: "0.75rem" }}>
              {!fleet ? (
                <>
                  <p className="small muted" style={{ margin: 0 }}>There's no company trip list yet. These are the rides booked from <strong>this browser tab</strong>; they're forgotten when it closes.</p>
                  {booked.length === 0 ? <p className="xs muted" style={{ margin: 0 }}>None booked here yet.</p> : (
                    <table className="table">
                      <tbody>
                        {booked.map((b) => (
                          <tr key={b.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/partner/org/${o.id}/trips/${b.id}`)}>
                            <td className="mono"><Link to={`/partner/org/${o.id}/trips/${b.id}`}>{shortId(b.id)}</Link></td>
                            <td className="small">{b.rider}<div className="xs muted">{b.from} → {b.to}</div></td>
                            <td className="small muted">{dayAndTime(b.at)}</td>
                            <td className="num mono small">{birr(b.fareMinor)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              ) : <p className="small muted" style={{ margin: 0 }}>Open a trip in one of your cars by its id (from a receipt or support).</p>}
              <form className="row" onSubmit={(e) => { e.preventDefault(); navigate(`/partner/org/${o.id}/trips/${tripRef.trim()}`); }}>
                <input className="input mono" aria-label="Trip id" style={{ flex: 1 }} value={tripRef} onChange={(e) => setTripRef(e.target.value)} placeholder="Full trip id" />
                <button className="btn secondary sm" disabled={!/^[0-9a-f-]{36}$/i.test(tripRef.trim())}>Open</button>
              </form>
            </div>
          </section>
        ) : null}
        </div>

        <aside className="stack">
          {manages && o.status === "VERIFIED" ? (
            <form className="card pad" onSubmit={(e) => { e.preventDefault(); if (e164) invite.mutate({ phone: e164, role: chosenRole }); }}>
              <h2 style={{ marginBottom: "0.25rem" }}>Invite by phone</h2>
              <p className="small muted" style={{ marginBottom: "0.9rem" }}>They get an SMS and accept in the Anbessa app with the same number.</p>
              <Field className="big" label="Mobile number" inputMode="tel" value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="09 11 22 33 44" hint={e164 ? fmtPhone(e164) : " "} />
              {inviteRoles.length > 1 ? (
                <SelectField label="As" value={chosenRole} onChange={(e) => setRole(e.target.value)}>
                  {inviteRoles.map((r) => <option key={r} value={r}>{ROLE_WORD[r]}</option>)}
                </SelectField>
              ) : null}
              <button className="btn" disabled={!e164 || invite.isPending}>Send invitation</button>
              {invite.isSuccess ? <div style={{ marginTop: "0.75rem" }}><Notice tone="ok">Invitation sent.</Notice></div> : null}
            </form>
          ) : null}
          {books && o.status === "VERIFIED" ? (
            <div className="card pad">
              <h2 style={{ marginBottom: "0.25rem" }}>Book a ride</h2>
              <p className="small muted" style={{ marginBottom: "0.9rem" }}>For someone on this account. Billed to {o.name}.</p>
              <Link className="btn secondary" to={`/partner/org/${o.id}/book`}>Book for someone</Link>
            </div>
          ) : null}
          {fleet && o.status === "VERIFIED" ? (
            <div className="card pad">
              <h2 style={{ marginBottom: "0.25rem" }}>Getting drivers on the road</h2>
              <ol className="small muted" style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem", lineHeight: 1.7 }}>
                <li>Invite them here by phone.</li>
                <li>They accept and apply as a driver in the Anbessa app (licence, ID, photo).</li>
                <li>Once we approve them, give them a car on the <button className="link" onClick={() => setParams({ tab: "vehicles" })}>Vehicles</button> tab.</li>
              </ol>
            </div>
          ) : null}
        </aside>
      </div> : null}
      {editing ? <EditCompany org={o} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}

/** Name and logo only: kind, city, TIN and legal name change through Anbessa (auth-service refuses them here). */
function EditCompany({ org, onClose }: { org: FullOrg; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(org.name);
  const [logo, setLogo] = useState<string | null>(org.logo ?? null);
  const [fileError, setFileError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => authCall<Org>("partner", "/organization/update", { organizationId: org.id, data: { name: name.trim(), logo } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["org", org.id] });
      await qc.invalidateQueries({ queryKey: ["my-orgs"] });
      onClose();
    },
  });
  return (
    <Drawer title="Company name and logo" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Problem error={save.error} />
        <Field label="Name people know you by" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="field">
          <span className="label">Logo</span>
          <div className="row" style={{ gap: "0.75rem" }}>
            {logo ? <img src={logo} alt="Current logo" style={{ width: "3.5rem", height: "3.5rem", objectFit: "contain", border: "1px solid var(--border)", borderRadius: "0.4rem" }} /> : <span className="small muted">No logo</span>}
            <label className="btn sm secondary" style={{ cursor: "pointer" }}>
              Choose an image
              <input type="file" accept="image/jpeg,image/png,image/webp" className="visually-hidden" onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                setFileError(null);
                imageToDataUrl(f).then(setLogo, (err: Error) => setFileError(err.message));
              }} />
            </label>
            {logo ? <button type="button" className="link danger" onClick={() => setLogo(null)}>remove</button> : null}
          </div>
          <span className="hint">{fileError ?? "Square works best. It's shrunk to a small image."}</span>
        </div>
        <dl className="kv" style={{ margin: "0.5rem 0 1rem" }}>
          <dt>Legal name</dt><dd>{org.legalName ?? "—"}</dd>
          <dt>TIN</dt><dd className="mono">{org.tin ?? "—"}</dd>
          <dt>Kind</dt><dd>{org.kind === "FLEET" ? "Fleet company" : "Company account"}</dd>
          <dt>City</dt><dd>{CITY_NAMES[org.cityId] ?? org.cityId}</dd>
        </dl>
        <p className="xs muted">To change the legal name, TIN, kind or city, contact Anbessa support: they're checked against your licence.</p>
        <button className="btn" disabled={save.isPending || !name.trim() || (name.trim() === org.name && logo === (org.logo ?? null))}>Save</button>
      </form>
    </Drawer>
  );
}

/** Workflow 11: a coordinator books for an employee on the company account. */
export function CorporateBooking() {
  const { orgId } = useParams();
  const navigate = useNavigate();
  const { partner } = useSession();
  const config = useClientConfig();
  const now = useNow(5000);
  const org = useQuery({ queryKey: ["org", orgId], queryFn: () => authCall<FullOrg>("partner", `/organization/get-full-organization?organizationId=${orgId}`) });
  const cityId = org.data?.cityId ?? null;
  const fares = useQuery({
    queryKey: ["fares", cityId],
    enabled: !!cityId,
    staleTime: 60_000,
    queryFn: () => http.get<{ fares: Fare[] }>(`/api/pricing/fares?cityId=${cityId}`).then((r) => r.data.fares),
  });
  const [riderId, setRiderId] = useState("");
  const [purpose, setPurpose] = useState("");
  const [vehicleType, setVehicleType] = useState("");
  const [pickup, setPickup] = useState<Place | null>(null);
  const [dropoff, setDropoff] = useState<Place | null>(null);
  const [quote, setQuote] = useState<(Quote & { key: string }) | null>(null);
  const [expired, setExpired] = useState(false);
  const fit = useMemo(() => [pickup, dropoff].filter((x): x is Place => !!x), [pickup, dropoff]);
  const route = useQuery({
    queryKey: ["route", pickup?.lat, pickup?.lng, dropoff?.lat, dropoff?.lng],
    enabled: !!pickup && !!dropoff,
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: () => api<{ polyline6: string; distanceMeters: number; durationSeconds: number; approximate: boolean }>("partner", `/api/maps/route?from=${pickup!.lat},${pickup!.lng}&to=${dropoff!.lat},${dropoff!.lng}`),
  });
  const polyline6 = route.data?.polyline6;
  const routePoints = useMemo(() => (polyline6 ? decodePolyline6(polyline6) : []), [polyline6]);
  const getQuote = useMutation({
    mutationFn: (type: string) => api<{ quotes: Quote[] }>("partner", "/api/pricing/estimates", { body: { pickup: { lat: pickup!.lat, lng: pickup!.lng }, dropoff: { lat: dropoff!.lat, lng: dropoff!.lng }, vehicleTypes: [type], pickupAddress: pickup!.name, dropoffAddress: dropoff!.name } }),
    // one Idempotency-Key per quote: a retry of the same request is safe, a new fare is a new request
    onSuccess: (r) => { setExpired(false); setQuote(r.quotes[0] ? { ...r.quotes[0], key: newIdempotencyKey() } : null); },
  });
  const book = useMutation({
    // purpose: the company's ride policy may require one (422 policy_violation without it)
    mutationFn: (q: Quote & { key: string }) => api<Trip>("partner", "/api/trips", { body: { quoteId: q.id, paymentMethod: "CORPORATE", billingOrgId: orgId, riderUserId: riderId, ...(purpose.trim() ? { purpose: purpose.trim() } : {}) }, idempotencyKey: q.key }),
    onSuccess: (t) => {
      const rider = org.data?.members.find((m) => m.userId === riderId);
      rememberBookedTrip({ id: t.id, orgId: orgId!, rider: rider ? who(rider) : shortId(riderId), from: pickup?.name ?? "", to: dropoff?.name ?? "", vehicleType: t.vehicleType, fareMinor: t.fare.estimateMinor, at: t.times.requestedAt });
      navigate(`/partner/org/${orgId}/trips/${t.id}`);
    },
  });
  const clearQuote = () => { setQuote(null); setExpired(false); getQuote.reset(); book.reset(); };

  if (org.isLoading) return <p className="muted">Loading…</p>;
  if (org.error) return <Problem error={org.error} />;
  const o = org.data!;
  const p = partner.principal;
  const back = <p className="xs muted" style={{ margin: 0 }}><Link to={`/partner/org/${o.id}`}>{o.name}</Link> / book a ride</p>;
  const refuse = (title: string, body: string) => <div className="page stack">{back}<Empty title={title}>{body}</Empty></div>;
  if (o.kind !== "CORPORATE") return refuse("Booking is for company accounts.", "Fleets earn from rides; they don't book them.");
  if (!allowed(p, "trip:create_on_behalf", { orgId: o.id }) || !allowed(p, "trip:bill_corporate", { orgId: o.id })) {
    return refuse("You can't book on this account.", `The admin and the travel desk (coordinators) of ${o.name} book rides. Ask your admin to make you a coordinator.`);
  }
  if (o.status !== "VERIFIED") return refuse("Not yet.", o.status === "PENDING" ? "Booking opens once Anbessa has verified the company." : "This account is suspended. Contact Anbessa support.");
  if (config && !config.features.corporateBooking) return refuse("Company booking is switched off.", "Anbessa has paused booking on company accounts for now. Riders can still book in the app.");

  const paused = !!config?.maintenance.newTripsPaused;
  const riders = o.members.filter((m) => ["employee", "corporate_coordinator", "corporate_admin"].some((r) => roleList(m.role).includes(r)));
  const fareByType = new Map((fares.data ?? []).map((f) => [f.vehicleType, f]));
  const choices = vehicleChoices(config, o.cityId).filter((c) => !fares.data || fareByType.has(c.code));
  const chosenType = choices.some((c) => c.code === vehicleType) ? vehicleType : (choices[0]?.code ?? "");
  const usable = quoteUsable(quote, now);
  const request = () => {
    if (!quote || !quoteUsable(quote)) { setQuote(null); setExpired(true); return; }
    book.mutate(quote);
  };

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      {back}
      <PageHead title="Book a ride" lede={`Billed to ${o.name}. The rider needs the Anbessa app with the phone number on this account.`} />
      {paused ? <Notice tone="error">{config?.maintenance.message || "New trips are paused for maintenance."} Try again shortly.</Notice> : null}
      <Problem error={getQuote.error ?? book.error} />
      <div className="two-col">
        <section className="card pad">
          {riders.length === 0 ? <Empty title="No one to book for.">Invite people to this account first.</Empty> : (
            <fieldset className="options">
              <legend className="label">Who's riding</legend>
              {riders.map((m) => (
                <label key={m.userId} className="option"><input type="radio" name="rider" checked={riderId === m.userId} onChange={() => setRiderId(m.userId)} /> <span className="mono">{who(m)}</span>{m.userId === p?.userId ? <span className="muted small"> (you)</span> : null}</label>
              ))}
            </fieldset>
          )}
          <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "0.4rem 0 1rem" }} />
          <PlacePicker label="Pickup" cityId={o.cityId} surface="partner" value={pickup} onChange={(x) => { setPickup(x); clearQuote(); }} />
          <PlacePicker label="Destination" cityId={o.cityId} surface="partner" value={dropoff} onChange={(x) => { setDropoff(x); clearQuote(); }} />
          {pickup && dropoff ? (
            <p className="small muted" style={{ margin: "-0.25rem 0 0.9rem" }}>
              {route.data ? <>{(route.data.distanceMeters / 1000).toFixed(1)} km · about {Math.max(1, Math.round(route.data.durationSeconds / 60))} min by road{route.data.approximate ? " (estimate: road routing is offline)" : ""}</> : route.isLoading ? "Finding the route…" : route.error ? "Route preview unavailable; the fare still uses the road distance." : null}
            </p>
          ) : null}

          <fieldset className="options">
            <legend className="label">Car</legend>
            {fares.error ? <p className="xs muted" style={{ margin: 0 }}>Rates unavailable right now; you'll see the fixed price before booking.</p> : null}
            {choices.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{fares.isLoading ? "Loading…" : "No car types are offered in this city right now."}</p> : null}
            {choices.map((c) => {
              const f = fareByType.get(c.code);
              return (
                <label key={c.code} className="option">
                  <input type="radio" name="vehicleType" checked={chosenType === c.code} onChange={() => { setVehicleType(c.code); clearQuote(); }} />
                  <span>
                    <strong>{c.name}</strong> <span className="muted small">· {c.seats} seats</span>
                    {f ? <><br /><span className="xs muted">{birr(f.baseMinor)} start + {birr(f.perKmMinor)}/km + {birr(f.perMinMinor)}/min · at least {birr(f.minFareMinor)} · waiting {birr(f.waitingPerMinMinor)}/min after the free minutes</span></> : null}
                  </span>
                </label>
              );
            })}
          </fieldset>

          {expired ? <Notice>That fare expired. Get a new one; it may have changed.</Notice> : null}
          {quote && usable ? (
            <>
              <p style={{ fontSize: "1.25rem", margin: "0 0 0.25rem" }}><strong className="mono">{birr(quote.fareMinor)}</strong> <span className="muted small">· {(quote.distanceMeters / 1000).toFixed(1)} km · fixed price</span></p>
              <p className="xs muted" style={{ margin: "0 0 0.75rem" }}>
                {quote.driversNearby ? `${quote.driversNearby} car${quote.driversNearby > 1 ? "s" : ""} nearby` : "No cars close right now; we'll keep looking for up to a couple of minutes"}
                {quote.etaToPickupSeconds ? ` · about ${Math.max(1, Math.round(quote.etaToPickupSeconds / 60))} min to the pickup` : ""}
                {quote.expiresAt ? ` · price held until ${clock(quote.expiresAt)}` : ""}
              </p>
              <Field label="Purpose (if your company asks for one)" value={purpose} maxLength={200} onChange={(e) => setPurpose(e.target.value)} placeholder="client meeting, airport run…" />
              {!riderId ? <p className="xs muted" style={{ margin: "0 0 0.5rem" }}>Choose who's riding first.</p> : null}
              <button className="btn block" disabled={!riderId || book.isPending || paused} onClick={request}>Request the ride</button>
              <Link className="btn ghost block" to={`/partner/org/${orgId}/scheduled`} style={{ marginTop: "0.5rem" }}>Book for later instead</Link>
            </>
          ) : (
            <button className="btn secondary block" disabled={!pickup || !dropoff || !chosenType || getQuote.isPending || paused} onClick={() => getQuote.mutate(chosenType)}>Get the fare</button>
          )}
        </section>
        <div style={{ minHeight: "22rem", position: "relative" }}>
          <CityMap cityId={o.cityId} fit={fit} boxed>
            {pickup && dropoff ? (routePoints.length > 1 ? <RouteLine id="corporate-booking" points={routePoints} /> : <TripLine id="corporate-booking" from={pickup} to={dropoff} />) : null}
            {pickup ? <PickupMarker lat={pickup.lat} lng={pickup.lng} label="Pickup" /> : null}
            {dropoff ? <DropoffMarker lat={dropoff.lat} lng={dropoff.lng} label="Destination" /> : null}
          </CityMap>
        </div>
      </div>
    </div>
  );
}

/** The fleet's one balance with the platform (Payment.md §11): every trip in its cars lands here. */
function FleetBalance({ orgId, cityId, owner }: { orgId: string; cityId: string; owner: boolean }) {
  const q = useQuery({
    queryKey: ["money", "org-balance", orgId], refetchInterval: 15_000,
    queryFn: () => api<Balance>("partner", `/api/payments/balances/org/${orgId}?cityId=${cityId}${owner ? "&open=true" : ""}`),
  });
  if (q.error) return <Problem error={q.error} />;
  if (!q.data) return <p className="muted">Loading…</p>;
  return (
    <div className="stack" style={{ gap: "1rem" }}>
      <p className="small muted" style={{ margin: 0 }}>
        Card and mobile money trips in your cars add what the driver earned; cash trips add the commission you owe. They net out, and the balance is
        settled weekly: paid out when positive, a payment due when negative. Cash trips pause for all your cars at the cash limit.
      </p>
      <BalancePanel surface="partner" balance={q.data} owner={owner} />
    </div>
  );
}
