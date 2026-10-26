import { useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Truck } from "lucide-react";
import type { Trip } from "@ride-app/shared-types";
import { allowed, api, authCall, newIdempotencyKey } from "../../lib/api";
import { birr, CITIES, CITY_NAMES, dayAndTime, phone as fmtPhone, phoneToPlaceholderEmail, placeholderEmailToPhone, shortId, toE164 } from "../../lib/format";
import { useSession } from "../../lib/session";
import { PlacePicker, type Place } from "../../components/PlacePicker";
import { CityMap } from "../../components/map/CityMap";
import { DropoffMarker, PickupMarker, TripLine } from "../../components/map/markers";
import { Empty, Field, Notice, PageHead, Pill, Problem, SelectField } from "../../components/ui";

export interface Org {
  id: string;
  name: string;
  slug: string;
  kind: "FLEET" | "CORPORATE";
  cityId: string;
  legalName?: string;
  tin?: string;
  status: "PENDING" | "VERIFIED" | "SUSPENDED";
  createdAt: string;
}

interface FullOrg extends Org {
  members: { id: string; userId: string; role: string; createdAt: string; user: { name: string; email: string } }[];
  invitations: { id: string; email: string; role: string; status: string; expiresAt: string }[];
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
  const org = useQuery({
    queryKey: ["org", orgId],
    queryFn: () => authCall<FullOrg>("partner", `/organization/get-full-organization?organizationId=${orgId}`),
  });
  const [raw, setRaw] = useState("");
  const [role, setRole] = useState("");
  const invite = useMutation({
    mutationFn: (a: { phone: string; role: string }) => authCall("partner", "/organization/invite-member", { email: phoneToPlaceholderEmail(a.phone), role: a.role, organizationId: orgId }),
    onSuccess: () => { setRaw(""); void qc.invalidateQueries({ queryKey: ["org", orgId] }); },
  });
  const cancelInvite = useMutation({
    mutationFn: (invitationId: string) => authCall("partner", "/organization/cancel-invitation", { invitationId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["org", orgId] }),
  });
  const remove = useMutation({
    mutationFn: (memberId: string) => authCall("partner", "/organization/remove-member", { memberIdOrEmail: memberId, organizationId: orgId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["org", orgId] }),
  });

  if (org.isLoading) return <p className="muted">Loading…</p>;
  if (org.error) return <Problem error={org.error} />;
  const o = org.data!;
  const fleet = o.kind === "FLEET";
  const p = partner.principal;
  const manages = allowed(p, "org:manage_members", { orgId: o.id });
  const books = !fleet && allowed(p, "trip:create_on_behalf", { orgId: o.id });
  const inviteRoles = fleet ? ["fleet_driver"] : ["employee", "corporate_coordinator"];
  const chosenRole = role || inviteRoles[0]!;
  const e164 = toE164(raw);
  const pendingInvites = o.invitations.filter((i) => i.status === "pending");

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title={o.name}
        lede={<>{fleet ? "Fleet" : "Company account"} · {CITY_NAMES[o.cityId] ?? o.cityId} · {o.legalName} · TIN <span className="mono">{o.tin}</span></>}
        right={o.status === "VERIFIED" ? <Pill tone="green">verified</Pill> : o.status === "PENDING" ? <Pill tone="amber">waiting for verification</Pill> : <Pill tone="red">suspended</Pill>}
      />

      {o.status === "PENDING" ? <Notice>Our onboarding team is checking your details. Inviting {fleet ? "drivers" : "people"}{fleet ? "" : " and booking rides"} opens once you're verified.</Notice> : null}
      {o.status === "SUSPENDED" ? <Notice tone="error">This account is suspended. Contact Anbessa support.</Notice> : null}
      <Problem error={invite.error ?? cancelInvite.error ?? remove.error} />

      <div className="two-col wide-left">
        <section className="card">
          <div className="card-head"><h2>{fleet ? "Drivers" : "People"} <span className="muted mono small">{o.members.length}</span></h2></div>
          <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead><tr><th>Who</th><th>Role</th><th>Since</th><th /></tr></thead>
            <tbody>
              {o.members.map((m) => (
                <tr key={m.id}>
                  <td className="mono">{who(m)}</td>
                  <td>{m.role.split(",").map((r) => ROLE_WORD[r] ?? r).join(", ")}</td>
                  <td className="small muted">{dayAndTime(m.createdAt)}</td>
                  <td>{manages && m.userId !== p?.userId && !m.role.includes("owner") && !m.role.includes("corporate_admin") ? <button className="link danger" onClick={() => confirm(`Remove ${who(m)}?`) && remove.mutate(m.id)}>remove</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {pendingInvites.length ? (
            <>
              <h3 className="label" style={{ margin: "1.2rem 0.9rem 0.2rem" }}>Invited, not joined yet</h3>
              <table className="table">
                <tbody>
                  {pendingInvites.map((i) => (
                    <tr key={i.id}>
                      <td className="mono">{fmtPhone(placeholderEmailToPhone(i.email))}</td>
                      <td>{ROLE_WORD[i.role] ?? i.role}</td>
                      <td className="muted">until {dayAndTime(i.expiresAt)}</td>
                      <td>{manages ? <button className="link" onClick={() => cancelInvite.mutate(i.id)}>withdraw</button> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
          </div>
        </section>

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
        </aside>
      </div>
    </div>
  );
}

/** Workflow 11: a coordinator books for an employee on the company account. */
export function CorporateBooking() {
  const { orgId } = useParams();
  const org = useQuery({ queryKey: ["org", orgId], queryFn: () => authCall<FullOrg>("partner", `/organization/get-full-organization?organizationId=${orgId}`) });
  const [riderId, setRiderId] = useState("");
  const [pickup, setPickup] = useState<Place | null>(null);
  const [dropoff, setDropoff] = useState<Place | null>(null);
  const [quote, setQuote] = useState<{ id: string; fareMinor: number; distanceMeters: number } | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [idemKey] = useState(newIdempotencyKey);
  const fit = useMemo(() => [pickup, dropoff].filter((x): x is Place => !!x), [pickup, dropoff]);
  const getQuote = useMutation({
    mutationFn: () => api<{ quotes: { id: string; fareMinor: number; distanceMeters: number }[] }>("partner", "/api/trips/estimates", { body: { pickup, dropoff, vehicleTypes: ["economy"], pickupAddress: pickup!.name, dropoffAddress: dropoff!.name } }),
    onSuccess: (r) => setQuote(r.quotes[0] ?? null),
  });
  const book = useMutation({
    mutationFn: () => api<Trip>("partner", "/api/trips", { body: { quoteId: quote!.id, paymentMethod: "CORPORATE", billingOrgId: orgId, riderUserId: riderId }, idempotencyKey: idemKey }),
    onSuccess: setTrip,
  });

  if (org.isLoading) return <p className="muted">Loading…</p>;
  if (org.error) return <Problem error={org.error} />;
  const o = org.data!;
  const riders = o.members.filter((m) => m.role.includes("employee") || m.role.includes("corporate_coordinator") || m.role.includes("corporate_admin"));

  if (trip) {
    return (
      <div className="page stack" style={{ maxWidth: "36rem" }}>
        <PageHead title={<>Booked <span className="mono">{shortId(trip.id)}</span></>} />
        <Notice tone="ok">Requested on {o.name}'s account for {birr(trip.fare.estimateMinor)}. The rider sees the driver in their app.</Notice>
        <div><Link className="btn secondary" to={`/partner/org/${o.id}`}>Back to {o.name}</Link></div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHead title="Book a ride" lede={`Billed to ${o.name}. The rider needs the Anbessa app with the phone number on this account.`} />
      <Problem error={getQuote.error ?? book.error} />
      <div className="two-col">
        <section className="card pad">
          {riders.length === 0 ? <Empty title="No one to book for.">Invite people to this account first.</Empty> : (
            <fieldset className="options">
              <legend className="label">Who's riding</legend>
              {riders.map((m) => (
                <label key={m.userId} className="option"><input type="radio" name="rider" checked={riderId === m.userId} onChange={() => setRiderId(m.userId)} /> <span className="mono">{who(m)}</span></label>
              ))}
            </fieldset>
          )}
          <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "0.4rem 0 1rem" }} />
          <PlacePicker label="Pickup" cityId={o.cityId} surface="partner" value={pickup} onChange={(x) => { setPickup(x); setQuote(null); }} />
          <PlacePicker label="Destination" cityId={o.cityId} surface="partner" value={dropoff} onChange={(x) => { setDropoff(x); setQuote(null); }} />
          {quote ? (
            <>
              <p style={{ fontSize: "1.25rem", margin: "0 0 0.75rem" }}><strong className="mono">{birr(quote.fareMinor)}</strong> <span className="muted small">· {(quote.distanceMeters / 1000).toFixed(1)} km · fixed price</span></p>
              <button className="btn block" disabled={!riderId || book.isPending} onClick={() => book.mutate()}>Request the ride</button>
            </>
          ) : (
            <button className="btn secondary block" disabled={!pickup || !dropoff || getQuote.isPending} onClick={() => getQuote.mutate()}>Get the fare</button>
          )}
        </section>
        <div style={{ minHeight: "22rem", position: "relative" }}>
          <CityMap cityId={o.cityId} fit={fit} boxed>
            {pickup && dropoff ? <TripLine id="corporate-booking" from={pickup} to={dropoff} /> : null}
            {pickup ? <PickupMarker lat={pickup.lat} lng={pickup.lng} label="Pickup" /> : null}
            {dropoff ? <DropoffMarker lat={dropoff.lat} lng={dropoff.lng} label="Destination" /> : null}
          </CityMap>
        </div>
      </div>
    </div>
  );
}
