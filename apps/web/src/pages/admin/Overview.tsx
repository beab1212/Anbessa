// Administration overview: today's numbers, people, onboarding, system health, and what is waiting
// for a decision. Aggregates only (report:read); each block shows when its service answers.
// Global report readers see every city or pick one; city-scoped readers pick among their cities.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { allowed, api } from "../../lib/api";
import { reportScope, statsPath } from "../../lib/account";
import { CITIES, CITY_NAMES } from "../../lib/format";
import type { Approval, SettingChange } from "../../lib/admin";
import { useSession } from "../../lib/session";
import { Notice, PageHead, Pill, Problem, Stat } from "../../components/ui";
import { systemAlerts, useSystem } from "./System";

interface IdentityStats {
  cityId: string | null;
  users: number; staff: number; riders: number; drivers: number; guests: number; suspended: number; signups24h: number; signups7d: number;
  activeSessions: { app: number; admin: number }; staffWithoutMfa: number; organizations: { kind: string; status: string; count: number }[];
}
interface TripStats { requested: number; completed: number; cancelled: number; active: number; completionRate: number | null; avgSecondsToMatch: number | null; byChannel: Record<string, number> }
interface FleetStats { drivers: Record<string, number>; vehicles: Record<string, number>; pendingDocuments: number; online: number }

const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);

export function OverviewPage() {
  const { staff } = useSession();
  const p = staff.principal;
  const scope = reportScope(p, CITIES);
  const reports = scope.global || scope.cities.length > 0;
  // null = every city (global readers only); city-scoped readers always look at one of theirs
  const [picked, setPicked] = useState<string | null>(null);
  const cityId = picked && scope.cities.includes(picked) ? picked : scope.global ? null : (scope.cities[0] ?? null);
  const identity = useQuery({ queryKey: ["stats", "identity", cityId], enabled: reports, refetchInterval: 60_000, queryFn: () => api<IdentityStats>("staff", statsPath("/api/identity/stats", cityId)) });
  const trips = useQuery({ queryKey: ["stats", "trips", cityId], enabled: reports, refetchInterval: 30_000, queryFn: () => api<TripStats>("staff", statsPath("/api/trips/stats", cityId)) });
  const fleet = useQuery({ queryKey: ["stats", "fleet", cityId], enabled: reports, refetchInterval: 60_000, queryFn: () => api<FleetStats>("staff", statsPath("/api/fleet/stats", cityId)) });
  const where = cityId ? CITY_NAMES[cityId] ?? cityId : "every city";
  const system = useSystem(allowed(p, "system:read"));
  const approvals = useQuery({
    queryKey: ["approvals", "overview"],
    enabled: allowed(p, "role:approve") || allowed(p, "authz:approve"),
    queryFn: () => api<{ approvals: Approval[] }>("staff", "/api/identity/approvals?status=PENDING").then((r) => r.approvals),
  });
  const settingChanges = useQuery({
    queryKey: ["setting-changes", "PENDING"],
    enabled: allowed(p, "settings:read"),
    queryFn: () => api<{ changes: SettingChange[] }>("staff", "/api/platform/settings/changes?status=PENDING").then((r) => r.changes),
  });
  const waiting = (approvals.data?.filter((a) => a.makerId !== p?.userId).length ?? 0) + (settingChanges.data?.filter((c) => c.makerId !== p?.userId).length ?? 0);
  const alerts = systemAlerts(system.data);
  const i = identity.data;
  const t = trips.data;
  const f = fleet.data;

  return (
    <div className="page stack" style={{ gap: "1.25rem" }}>
      <PageHead
        title="Overview"
        lede={reports ? `The platform today in ${where}. Numbers refresh on their own.` : "The platform today."}
        right={reports && (scope.global || scope.cities.length > 1) ? (
          <select className="select" aria-label="City" value={cityId ?? ""} onChange={(e) => setPicked(e.target.value || null)} style={{ width: "auto", height: "2rem", fontSize: "0.8125rem" }}>
            {scope.global ? <option value="">All cities</option> : null}
            {scope.cities.map((c) => <option key={c} value={c}>{CITY_NAMES[c] ?? c}</option>)}
          </select>
        ) : reports && cityId ? <Pill>{where}</Pill> : null}
      />
      {alerts.map((a) => <Notice key={a} tone="error">{a} · <Link to="/staff/admin/system">System</Link></Notice>)}
      {waiting ? <Notice>{waiting} change{waiting > 1 ? "s" : ""} waiting for your decision · <Link to="/staff/admin/approvals">Approvals</Link></Notice> : null}

      {reports ? (
        <>
          <section>
            <h2 className="section-title">Trips today</h2>
            <Problem error={trips.error} />
            <div className="stats">
              <Stat label="Requested" value={t?.requested ?? "—"} sub={t ? Object.entries(t.byChannel).map(([c, n]) => `${c.toLowerCase().replace("_", " ")} ${n}`).join(" · ") : undefined} />
              <Stat label="On the road now" value={t?.active ?? "—"} />
              <Stat label="Completed" value={t?.completed ?? "—"} sub={t ? `${pct(t.completionRate)} of finished trips` : undefined} />
              <Stat label="Time to find a driver" value={t?.avgSecondsToMatch ? `${Math.round(t.avgSecondsToMatch)} s` : "—"} sub="average today" />
            </div>
          </section>
          <section>
            <h2 className="section-title">People</h2>
            <Problem error={identity.error} />
            {i?.cityId ? <p className="xs muted" style={{ margin: "0 0 0.5rem" }}>Accounts aren't tied to a city, so account numbers are for the whole platform; staff and companies are {where}'s.</p> : null}
            <div className="stats">
              <Stat label="Accounts" value={i?.users ?? "—"} sub={i ? `${i.riders} riders · ${i.drivers} drivers · ${i.guests} guests` : undefined} />
              <Stat label="New" value={i?.signups24h ?? "—"} sub={i ? `last 24 h · ${i.signups7d} this week` : undefined} />
              <Stat label="Signed in now" value={i ? i.activeSessions.app + i.activeSessions.admin : "—"} sub={i ? `${i.activeSessions.admin} staff${i.cityId ? ` of ${where}` : ""}` : undefined} />
              <Stat label="Suspended" value={i?.suspended ?? "—"} alert={(i?.staffWithoutMfa ?? 0) > 0} sub={i?.staffWithoutMfa ? `${i.staffWithoutMfa} staff without an authenticator` : undefined} />
            </div>
          </section>
          <section>
            <h2 className="section-title">Drivers and vehicles</h2>
            <Problem error={fleet.error} />
            <div className="stats">
              <Stat label="Active drivers" value={f?.drivers.ACTIVE ?? (f ? 0 : "—")} sub={f ? `${f.drivers.PENDING_REVIEW ?? 0} waiting for review · ${f.drivers.SUSPENDED ?? 0} suspended` : undefined} />
              <Stat label="Online" value={f?.online ?? "—"} />
              <Stat label="Verified vehicles" value={f?.vehicles.VERIFIED ?? (f ? 0 : "—")} sub={f ? `${f.vehicles.PENDING_REVIEW ?? 0} waiting · ${f.vehicles.SUSPENDED ?? 0} suspended` : undefined} />
              <Stat label="Documents to review" value={f?.pendingDocuments ?? "—"} alert={(f?.pendingDocuments ?? 0) > 20} />
            </div>
          </section>
          {i?.organizations.length ? (
            <p className="small muted" style={{ margin: 0 }}>
              Companies: {i.organizations.map((o) => `${o.count} ${o.kind === "FLEET" ? "fleet" : "company account"}${o.count === 1 ? "" : "s"} ${o.status.toLowerCase()}`).join(" · ")}
            </p>
          ) : null}
        </>
      ) : null}

      {system.data ? (
        <section>
          <h2 className="section-title">System</h2>
          <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap" }}>
            {system.data.services.map((s) => (
              <Pill key={s.name} tone={s.status === "up" ? "green" : s.status === "degraded" ? "amber" : "red"}>{s.name.replace("-service", "")}</Pill>
            ))}
            <Link className="small" to="/staff/admin/system" style={{ marginLeft: "0.5rem" }}>details</Link>
          </div>
        </section>
      ) : null}
    </div>
  );
}
