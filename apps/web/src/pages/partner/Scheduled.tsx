// Partner portal: rides booked ahead on a company account (workflows 11 C and 12). Admins and
// coordinators see every scheduled ride billed to the company, book one for an employee or guest,
// and cancel it (free until it starts matching). trip-service /api/trips/scheduled.

import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus } from "lucide-react";
import { allowed, api, ApiError, authCall, newIdempotencyKey } from "../../lib/api";
import { birr, clock, dayAndTime } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { useClientConfig } from "../../lib/platform";
import { useSession } from "../../lib/session";
import { vehicleOptions } from "../../lib/trips";
import {
  addisInputToIso, cancelScheduled, isoToAddisInput, policySummary, scheduleProblem, useCorporatePolicy, useScheduled, type ScheduledRide,
} from "../../lib/trips2";
import { PlacePicker, type Place } from "../../components/PlacePicker";
import { Drawer, Empty, Field, Notice, PageHead, Problem, SelectField } from "../../components/ui";
import { memberName, type Member } from "./Fleet";
import { ScheduledTable } from "../staff/Scheduled";

interface OrgFull { id: string; name: string; kind: "FLEET" | "CORPORATE"; cityId: string; status: string; members: Member[] }
interface Quote { id: string; vehicleType: string; fareMinor: number; distanceMeters: number; expiresAt: string }

const RIDER_ROLES = ["employee", "corporate_coordinator", "corporate_admin"];

export function CompanyScheduledPage() {
  const { orgId = "" } = useParams();
  const { partner } = useSession();
  const p = partner.principal;
  const now = useNow(30_000);
  const qc = useQueryClient();
  const [status, setStatus] = useState<"upcoming" | "all">("upcoming");
  const [booking, setBooking] = useState(false);
  const org = useQuery({ queryKey: ["org", orgId, "full"], enabled: !!orgId, queryFn: () => authCall<OrgFull>("partner", `/organization/get-full-organization?organizationId=${orgId}`) });
  const may = allowed(p, "trip:read", { orgId });
  const mayBook = allowed(p, "trip:create_on_behalf", { orgId }) && allowed(p, "trip:bill_corporate", { orgId });
  const mayCancel = allowed(p, "trip:cancel", { orgId });
  const list = useScheduled("partner", { orgId, status }, may);
  const cancel = useMutation({
    mutationFn: (id: string) => cancelScheduled("partner", id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["scheduled"] }),
  });
  const names = useMemo(() => new Map((org.data?.members ?? []).map((m) => [m.userId, memberName(m)])), [org.data]);

  if (partner.loading || org.isLoading) return <p className="muted">Loading…</p>;
  if (org.error) return <div className="page"><Problem error={org.error} /></div>;
  const o = org.data!;
  const back = <p className="xs muted" style={{ margin: 0 }}><Link to={`/partner/org/${o.id}`}>{o.name}</Link> / rides booked ahead</p>;
  if (o.kind !== "CORPORATE") return <div className="page stack">{back}<Empty title="Booking ahead is for company accounts." /></div>;
  if (!may) return <div className="page stack">{back}<Notice tone="error">You can't see this company's rides. Ask the company's admin.</Notice></div>;
  const rows = list.data ?? [];

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      {back}
      <PageHead
        title="Rides booked ahead"
        lede="Booked from 30 minutes to 7 days ahead and billed to the company. A driver is found about 15 minutes before the pickup (30 at night). Cancelling is free until then."
        right={
          <>
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={status === "upcoming"} onClick={() => setStatus("upcoming")}>Upcoming</button>
              <button role="tab" aria-selected={status === "all"} onClick={() => setStatus("all")}>All</button>
            </div>
            {mayBook && o.status === "VERIFIED" ? <button className="btn" onClick={() => setBooking(true)}><CalendarPlus /> Book ahead</button> : null}
          </>
        }
      />
      <Problem error={list.error ?? cancel.error} />
      {list.isLoading ? <p className="muted">Loading…</p> : null}
      {list.data && rows.length === 0 ? <Empty title={status === "upcoming" ? "Nothing booked ahead." : "No rides booked ahead yet."} /> : null}
      {rows.length ? (
        <ScheduledTable
          rows={rows} now={now} busy={cancel.isPending}
          tripLink={(id) => `/partner/org/${orgId}/trips/${id}`}
          riderName={(id) => names.get(id) ?? null}
          onCancel={mayCancel ? (s: ScheduledRide) => confirm(`Cancel the ${dayAndTime(s.scheduledFor)} ride? It's free.`) && cancel.mutate(s.id) : undefined}
        />
      ) : null}
      {booking ? <BookAheadDrawer org={o} onClose={() => setBooking(false)} onBooked={() => { setBooking(false); void qc.invalidateQueries({ queryKey: ["scheduled"] }); }} /> : null}
    </div>
  );
}

function BookAheadDrawer({ org, onClose, onBooked }: { org: OrgFull; onClose: () => void; onBooked: (s: ScheduledRide) => void }) {
  const { partner } = useSession();
  const config = useClientConfig();
  const now = useNow(5000);
  const policy = useCorporatePolicy(org.id);
  const riders = org.members.filter((m) => m.role.split(",").map((r) => r.trim()).some((r) => RIDER_ROLES.includes(r)));
  const [riderId, setRiderId] = useState("");
  const [pickup, setPickup] = useState<Place | null>(null);
  const [dropoff, setDropoff] = useState<Place | null>(null);
  const choices = vehicleOptions(config, org.cityId).filter((c) => !policy.data?.allowedVehicleTypes.length || policy.data.allowedVehicleTypes.includes(c.code));
  const [vehicleType, setVehicleType] = useState("");
  const chosenType = choices.some((c) => c.code === vehicleType) ? vehicleType : (choices[0]?.code ?? "");
  const [when, setWhen] = useState(() => isoToAddisInput(Date.now() + 2 * 3600_000).slice(0, 14) + "00");
  const [purpose, setPurpose] = useState("");
  const [quote, setQuote] = useState<(Quote & { key: string }) | null>(null);
  const iso = addisInputToIso(when);
  const timeProblem = scheduleProblem(iso, now);

  const getQuote = useMutation({
    mutationFn: () => api<{ quotes: Quote[] }>("partner", "/api/pricing/estimates", {
      body: { pickup: { lat: pickup!.lat, lng: pickup!.lng }, dropoff: { lat: dropoff!.lat, lng: dropoff!.lng }, vehicleTypes: [chosenType], pickupAddress: pickup!.name, dropoffAddress: dropoff!.name },
    }),
    onSuccess: (r) => setQuote(r.quotes[0] ? { ...r.quotes[0], key: newIdempotencyKey() } : null),
  });
  const book = useMutation({
    mutationFn: (q: Quote & { key: string }) => api<ScheduledRide>("partner", "/api/trips/scheduled", {
      body: { quoteId: q.id, paymentMethod: "CORPORATE", billingOrgId: org.id, riderUserId: riderId, scheduledFor: iso, ...(purpose.trim() ? { purpose: purpose.trim() } : {}) },
      idempotencyKey: q.key,
    }),
    onSuccess: onBooked,
  });
  const reset = () => { setQuote(null); getQuote.reset(); book.reset(); };
  const fresh = quote && Date.parse(quote.expiresAt) > now;
  const err = book.error ?? getQuote.error;
  const switchedOff = err instanceof ApiError && err.code === "feature_disabled";

  return (
    <Drawer title="Book a ride ahead" onClose={onClose} wide>
      <div className="stack">
        {policy.data ? <Notice>{org.name}'s policy: {policySummary(policy.data, birr).join(" · ")}.</Notice> : null}
        {switchedOff ? <Notice tone="error">Booking ahead is switched off by Anbessa for now. Book the ride when it's needed instead.</Notice> : <Problem error={err} />}
        <SelectField label="Who's riding" value={riderId} onChange={(e) => { setRiderId(e.target.value); reset(); }}>
          <option value="">Choose…</option>
          {riders.map((m) => <option key={m.userId} value={m.userId}>{memberName(m)}{m.userId === partner.principal?.userId ? " (you)" : ""}</option>)}
        </SelectField>
        <Field label="Pickup time (Addis Ababa)" type="datetime-local" value={when} onChange={(e) => { setWhen(e.target.value); reset(); }} hint={timeProblem ?? undefined} />
        <PlacePicker label="Pickup" cityId={org.cityId} surface="partner" value={pickup} onChange={(x) => { setPickup(x); reset(); }} />
        <PlacePicker label="Destination" cityId={org.cityId} surface="partner" value={dropoff} onChange={(x) => { setDropoff(x); reset(); }} />
        <SelectField label="Car" value={chosenType} onChange={(e) => { setVehicleType(e.target.value); reset(); }}>
          {choices.map((c) => <option key={c.code} value={c.code}>{c.name} · {c.seats}</option>)}
        </SelectField>
        <Field label={policy.data?.requirePurpose ? "Trip purpose or cost centre (required)" : "Trip purpose or cost centre"} value={purpose} maxLength={200} onChange={(e) => setPurpose(e.target.value)} />
        {quote && fresh ? (
          <>
            <p style={{ fontSize: "1.2rem", margin: 0 }}>
              <strong className="mono">{birr(quote.fareMinor)}</strong> <span className="muted small">· {(quote.distanceMeters / 1000).toFixed(1)} km · at most this; re-priced shortly before the pickup and never higher</span>
            </p>
            <p className="xs muted" style={{ margin: 0 }}>Book before {clock(quote.expiresAt)} to keep this price.</p>
            <button className="btn block" disabled={!riderId || !!timeProblem || book.isPending} onClick={() => book.mutate(quote)}>Book for {iso ? dayAndTime(iso) : "…"}</button>
          </>
        ) : (
          <button className="btn secondary block" disabled={!pickup || !dropoff || !chosenType || getQuote.isPending} onClick={() => getQuote.mutate()}>Get the fare</button>
        )}
        {!riderId && quote ? <p className="xs muted" style={{ margin: 0 }}>Choose who's riding first.</p> : null}
      </div>
    </Drawer>
  );
}
