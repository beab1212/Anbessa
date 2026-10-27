// Partner portal: a company's trips (trip-service GET /api/trips/org/:orgId) — rides billed to a
// company account, or rides driven in a fleet's cars — and what a company account has been charged
// (payment-service GET /api/payments/org/:orgId/payments).

import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { Principal } from "@ride-app/shared-authz";
import { allowed, api } from "../../lib/api";
import { birr, dayAndTime, shortId, STATUS_LABEL } from "../../lib/format";
import { useSession } from "../../lib/session";
import { METHOD_WORD, qs, rangeProblem, TRIP_STATUSES, type OrgCharges, type TripPage } from "../../lib/reports";
import { Empty, Field, Notice, PageHead, Problem, SelectField, Stat, TripStatus } from "../../components/ui";

type OrgRole = "billing" | "fleet";

/** Fleet roles see the fleet's cars' trips; company account roles see the trips billed to them. */
export function orgRoleOf(p: Principal | null, orgId: string): OrgRole | null {
  const a = p?.roles.find((r) => r.scope === "ORG" && r.orgId === orgId);
  if (!a) return null;
  return a.role.startsWith("FLEET_") ? "fleet" : "billing";
}

export function CompanyTripsPage() {
  const { orgId = "" } = useParams();
  const { partner } = useSession();
  const p = partner.principal;
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get("role");
  const role: OrgRole = fromUrl === "billing" || fromUrl === "fleet" ? fromUrl : (orgRoleOf(p, orgId) ?? "billing");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const problem = from && to ? rangeProblem(from, to) : null;
  const may = allowed(p, "trip:read", { orgId });

  const query = qs({ role, status, from, to, limit: 50 });
  const q = useInfiniteQuery({
    queryKey: ["org-trips", orgId, query],
    enabled: may && !problem,
    initialPageParam: "",
    getNextPageParam: (last: TripPage) => last.next ?? undefined,
    queryFn: ({ pageParam }) => api<TripPage>("partner", `/api/trips/org/${orgId}${query}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`),
  });
  const rows = q.data?.pages.flatMap((pg) => pg.trips) ?? [];

  if (partner.loading) return <p className="muted">Loading…</p>;
  if (!may) return <div className="page"><Notice tone="error">You can't see this company's trips. Ask the company's admin or owner.</Notice></div>;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Trips"
        lede={role === "fleet" ? "Trips driven in your company's cars, newest first." : "Trips billed to your company account, newest first."}
        right={
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={role === "billing"} onClick={() => setParams({ role: "billing" }, { replace: true })}>Billed to us</button>
            <button role="tab" aria-selected={role === "fleet"} onClick={() => setParams({ role: "fleet" }, { replace: true })}>In our cars</button>
          </div>
        }
      />
      <div className="card pad audit-filters">
        <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">any</option>
          {TRIP_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>)}
        </SelectField>
        <Field label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Field label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      {problem ? <div className="alert error" role="alert"><span>{problem}</span></div> : null}
      <Problem error={q.error} />
      {q.isLoading && !problem ? <p className="muted">Loading…</p> : null}
      {q.data && rows.length === 0 ? <Empty title="No trips yet." /> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Trip</th><th>Requested</th><th>Status</th><th>From → to</th><th>Car</th><th>Payment</th><th className="num">Fare</th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="mono small"><Link to={`/partner/org/${orgId}/trips/${t.id}`}>{shortId(t.id)}</Link></td>
                  <td className="small">{dayAndTime(t.times.requestedAt)}</td>
                  <td><TripStatus status={t.status} label={STATUS_LABEL[t.status] ?? t.status} /></td>
                  <td className="small">{t.pickup.address ?? "pin"} → {t.dropoff.address ?? "pin"}</td>
                  <td className="small">{t.vehicleType}</td>
                  <td className="small">{METHOD_WORD[t.paymentMethod] ?? t.paymentMethod}</td>
                  <td className="num">{birr(t.fare.finalMinor ?? t.fare.estimateMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {q.hasNextPage ? <div><button className="btn ghost" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Older trips</button></div> : null}
    </div>
  );
}

const PURPOSE_WORD: Record<string, string> = { TRIP_FARE: "trip fare", CANCELLATION_FEE: "cancellation fee" };

/** What a company account owes and every charge to it (corporate admin, payment:read @ ORG). */
export function CompanyChargesPage() {
  const { orgId = "" } = useParams();
  const { partner } = useSession();
  const may = allowed(partner.principal, "payment:read", { orgId });
  const q = useInfiniteQuery({
    queryKey: ["org-charges", orgId],
    enabled: may,
    initialPageParam: "",
    getNextPageParam: (last: OrgCharges) => last.next ?? undefined,
    queryFn: ({ pageParam }) => api<OrgCharges>("partner", `/api/payments/org/${orgId}/payments${qs({ limit: 50, before: pageParam })}`),
  });
  const rows = q.data?.pages.flatMap((pg) => pg.charges) ?? [];

  if (partner.loading) return <p className="muted">Loading…</p>;
  if (!may) return <div className="page"><Notice tone="error">You can't see this company's charges. Ask the company's admin.</Notice></div>;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead title="Charges" lede="Rides and cancellation fees billed to your company account. Invoiced monthly." />
      <Problem error={q.error} />
      {q.data ? <div className="stats"><Stat label="Owed now" value={birr(q.data.pages[0]!.owedMinor)} /></div> : null}
      {q.isLoading ? <p className="muted">Loading…</p> : null}
      {q.data && rows.length === 0 ? <Empty title="Nothing charged yet." /> : null}
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>What</th><th>Trip</th><th>Car</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="small">{dayAndTime(c.at)}</td>
                  <td className="small">{c.purpose ? PURPOSE_WORD[c.purpose] : (c.memo ?? c.kind.toLowerCase().replace(/_/g, " "))}</td>
                  <td className="mono small">{c.tripId ? <Link to={`/partner/org/${orgId}/trips/${c.tripId}`}>{shortId(c.tripId)}</Link> : "—"}</td>
                  <td className="small">{c.vehicleType ?? "—"}</td>
                  <td className="num">{birr(c.amountMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {q.hasNextPage ? <div><button className="btn ghost" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Older charges</button></div> : null}
    </div>
  );
}
