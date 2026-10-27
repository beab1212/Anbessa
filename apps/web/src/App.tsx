import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { can, type Permission, type Principal } from "@ride-app/shared-authz";
import { CITIES } from "./lib/format";
import { useSession } from "./lib/session";
import { Shell, type Section } from "./components/Shell";
import { Empty } from "./components/ui";
import { PartnerSignIn, SignInChooser, StaffSignIn } from "./pages/SignIn";
import { SharedTrip } from "./pages/public/SharedTrip";
import { StaffSetup } from "./pages/staff/Setup";
import { Board } from "./pages/staff/Board";
import { Drivers } from "./pages/staff/Drivers";
import { PhoneBooking } from "./pages/staff/PhoneBooking";
import { TripDetail } from "./pages/staff/TripDetail";
import { Onboarding } from "./pages/staff/Onboarding";
import { Safety } from "./pages/staff/Safety";
import { People } from "./pages/staff/People";
import { CorporateBooking, OrgPage, PartnerHome, RegisterCompany, useOrgs } from "./pages/partner/Partner";
import { FleetVehiclePage } from "./pages/partner/Fleet";
import { PartnerTripPage } from "./pages/partner/Trip";
import { PartnerDriverPage } from "./pages/partner/Driver";
import { PartnerAccountPage } from "./pages/partner/Account";
import { StaffAccountPage } from "./pages/staff/Account";
import { ZonesPage } from "./pages/ops/Zones";
import { PricingPage } from "./pages/ops/Pricing";
import { PromosPage } from "./pages/marketing/Promos";
import { CampaignsPage } from "./pages/marketing/Campaigns";
import { canSeeCampaigns, canSeePricing, canSeePromos, canSeeZones } from "./lib/marketing";
import { StaffScheduledPage } from "./pages/staff/Scheduled";
import { TripTracePage } from "./pages/staff/Trace";
import { RegulatoryReportPage } from "./pages/reports/Regulatory";
import { CompanyPoliciesPage } from "./pages/partner/Policies";
import { CompanyScheduledPage } from "./pages/partner/Scheduled";
import { AdjustmentsPage } from "./pages/money/Adjustments";
import { WriteOffsPage } from "./pages/money/WriteOffs";
import { OverridesPage } from "./pages/money/Overrides";
import { IncentivesPage } from "./pages/money/Incentives";
import { InvoicesPage } from "./pages/money/Invoices";
import { CompanyInvoicesPage } from "./pages/partner/Invoices";
import { canSeeAdjustments, canSeeIncentives, canSeeInvoices, canSeeOverrides, canSeeWriteOffs, CONTROL_DECIDERS } from "./lib/money2";
import { TripSearchPage } from "./pages/staff/TripSearch";
import { ReportsPage } from "./pages/reports/Reports";
import { CompanyChargesPage, CompanyTripsPage } from "./pages/partner/CompanyTrips";
import { FleetEarningsPage } from "./pages/partner/FleetEarnings";
import { TicketPage, TicketsPage } from "./pages/support/Tickets";
import { LostItemsPage } from "./pages/support/LostItems";
import { SosQueuePage } from "./pages/safety/SosQueue";
import { IncidentPage, IncidentsPage } from "./pages/safety/Incidents";
import { OverviewPage } from "./pages/admin/Overview";
import { UserPage, UsersPage } from "./pages/admin/Users";
import { RolesPage } from "./pages/admin/Roles";
import { ApprovalsPage } from "./pages/admin/Approvals";
import { SettingsPage } from "./pages/admin/Settings";
import { CitiesPage } from "./pages/admin/Cities";
import { AnnouncementsPage } from "./pages/admin/Announcements";
import { SystemPage } from "./pages/admin/System";
import { AuditPage } from "./pages/admin/Audit";
import { useClientConfig } from "./lib/platform";
import { MoneyOverviewPage } from "./pages/money/Overview";
import { BalancePage, BalancesPage } from "./pages/money/Balances";
import { PaymentsPage } from "./pages/money/Payments";
import { MoneyApprovalsPage } from "./pages/money/Approvals";
import { PayoutsPage } from "./pages/money/Payouts";
import { RulesPage } from "./pages/money/Rules";
import { ProvidersPage } from "./pages/money/Providers";

/** Who sees the Approvals inbox: anyone who asks for or decides maker–checker changes. */
const APPROVERS: Permission[] = ["role:request", "role:approve", "staff:manage", "authz:propose", "authz:approve", "settings:propose", "settings:approve"];

/** Who sees Money approvals: anyone who records, asks for or decides a money change (Payment.md §15). */
const MONEY_APPROVERS: Permission[] = [
  "topup:record_cash", "topup:approve_cash", "refund:request", "refund:approve", "payout:prepare", "payout:approve",
  "commission_rule:propose", "commission_rule:approve", "balance_policy:propose", "balance_policy:approve",
  // adjustments, write-offs, limit exceptions, incentives (lib/money2.ts)
  ...CONTROL_DECIDERS,
];
const RULE_READERS: Permission[] = ["commission_rule:propose", "commission_rule:approve", "balance_policy:propose", "balance_policy:approve", "commission:read"];
import { DriverDirectory, DriverRecord, ReviewQueuePage, VehicleDirectory, VehicleRecord } from "./pages/staff/Fleet";

/** Has the permission in any city (staff pages pick the city inside). */
const inAnyCity = (p: Principal, permission: Permission) => CITIES.some((cityId) => can(p, permission, { cityId })) || can(p, permission);

/** The staff index, built from the token's roles: you only see what you can do. */
export function staffSections(p: Principal, flags: { phoneBooking?: boolean } = {}): { title: string; items: Section[] }[] {
  const item = (ok: boolean, to: string, label: string) => (ok ? [{ to, label }] : []);
  return [
    {
      title: "Today",
      items: [
        ...item(inAnyCity(p, "trip:read"), "/staff/board", "Live board"),
        ...item(inAnyCity(p, "location:read_live"), "/staff/drivers", "Live map"),
        ...item(inAnyCity(p, "trip:create_on_behalf") && flags.phoneBooking !== false, "/staff/phone", "Book by phone"),
        ...item(inAnyCity(p, "trip:read"), "/staff/trips", "Find a trip"),
        ...item(inAnyCity(p, "trip:read"), "/staff/search", "Search trips"),
        ...item(inAnyCity(p, "trip:read"), "/staff/scheduled", "Scheduled rides"),
      ],
    },
    {
      title: "Support and safety",
      items: [
        ...item(inAnyCity(p, "sos:respond"), "/staff/safety/sos", "SOS alerts"),
        ...item(inAnyCity(p, "incident:manage"), "/staff/safety/incidents", "Incidents"),
        ...item(inAnyCity(p, "ticket:read"), "/staff/support/tickets", "Tickets"),
        ...item(inAnyCity(p, "lost_item:manage"), "/staff/support/lost-items", "Lost items"),
      ],
    },
    {
      title: "Onboarding",
      items: [
        ...item(inAnyCity(p, "document:review"), "/staff/review", "Review queue"),
        ...item(inAnyCity(p, "driver:read"), "/staff/fleet/drivers", "Drivers"),
        ...item(inAnyCity(p, "vehicle:read"), "/staff/fleet/vehicles", "Vehicles"),
        ...item(inAnyCity(p, "org:read") || inAnyCity(p, "org:suspend"), "/staff/onboarding", "Companies"),
      ],
    },
    {
      title: "Accounts",
      items: [...item(inAnyCity(p, "user:suspend"), "/staff/safety", "Suspend")],
    },
    {
      title: "Money",
      items: [
        ...item(inAnyCity(p, "balance:read") || can(p, "report:read_finance"), "/staff/money", "Overview"),
        ...item(inAnyCity(p, "balance:read"), "/staff/money/balances", "Balances"),
        ...item(inAnyCity(p, "balance:read") || inAnyCity(p, "refund:request") || can(p, "refund:approve"), "/staff/money/payments", "Rider payments"),
        ...item(MONEY_APPROVERS.some((perm) => inAnyCity(p, perm)), "/staff/money/approvals", "Money approvals"),
        ...item(can(p, "payout:prepare") || can(p, "payout:approve"), "/staff/money/payouts", "Payouts"),
        ...item(canSeeAdjustments(p), "/staff/money/adjustments", "Adjustments"),
        ...item(canSeeWriteOffs(p), "/staff/money/write-offs", "Write-offs"),
        ...item(canSeeOverrides(p), "/staff/money/overrides", "Limit exceptions"),
        ...item(canSeeIncentives(p), "/staff/money/incentives", "Incentives"),
        ...item(canSeeInvoices(p), "/staff/money/invoices", "Invoices"),
        ...item(RULE_READERS.some((perm) => inAnyCity(p, perm)), "/staff/money/rules", "Commission and limits"),
        ...item(can(p, "balance:read") || can(p, "report:read_finance") || can(p, "system:read"), "/staff/money/providers", "Payment providers"),
      ],
    },
    {
      title: "Administration",
      items: [
        ...item(inAnyCity(p, "report:read") || can(p, "system:read"), "/staff/admin", "Overview"),
        ...item(inAnyCity(p, "report:read") || can(p, "report:read_finance"), "/staff/reports", "Reports"),
        ...item(inAnyCity(p, "report:read_regulatory"), "/staff/reports/regulatory", "Regulatory report"),
        ...item(inAnyCity(p, "user:read_masked"), "/staff/admin/users", "Users"),
        ...item(can(p, "role:request") || can(p, "role:approve") || can(p, "staff:manage"), "/staff/people", "Staff and roles"),
        ...item(can(p, "authz:read"), "/staff/admin/roles", "Roles and permissions"),
        ...item(APPROVERS.some((perm) => can(p, perm)), "/staff/admin/approvals", "Approvals"),
        ...item(can(p, "settings:read"), "/staff/admin/settings", "Settings"),
        ...item(can(p, "settings:read"), "/staff/admin/cities", "Cities and vehicles"),
        ...item(can(p, "announcement:manage"), "/staff/admin/announcements", "Announcements"),
        ...item(can(p, "system:read"), "/staff/admin/system", "System"),
        ...item(can(p, "audit_log:read"), "/staff/admin/audit", "Audit log"),
      ],
    },
    {
      title: "Pricing and marketing",
      items: [
        ...item(canSeePricing(p), "/staff/ops/pricing", "Fares"),
        ...item(canSeeZones(p), "/staff/ops/zones", "Zones"),
        ...item(canSeePromos(p), "/staff/marketing/promos", "Promo codes"),
        ...item(canSeeCampaigns(p), "/staff/marketing/campaigns", "Campaigns"),
      ],
    },
    { title: "You", items: [{ to: "/staff/account", label: "My account" }] },
  ];
}

function firstStaffPage(p: Principal) {
  // "My account" is always there; land on the first real work page when there is one
  return staffSections(p).flatMap((s) => s.items).find((i) => i.to !== "/staff/account")?.to ?? "/staff/account";
}

function StaffArea() {
  const { staff } = useSession();
  const config = useClientConfig();
  if (staff.loading) return null;
  if (!staff.principal) return <Navigate to="/sign-in/staff" replace />;
  if (staff.claims?.setup) return <StaffSetup />;
  return <Shell surface="staff" principal={staff.principal} sections={staffSections(staff.principal, { phoneBooking: config?.features.phoneBooking })} />;
}

function PartnerArea() {
  const { partner } = useSession();
  const orgs = useOrgs();
  if (partner.loading) return null;
  if (!partner.principal) return <Navigate to="/sign-in/partner" replace />;
  const sections: { title: string; items: Section[] }[] = [
    { title: "Companies", items: [...(orgs.data ?? []).map((o) => ({ to: `/partner/org/${o.id}`, label: o.name })), { to: "/partner/register", label: "Register a company" }] },
    { title: "You", items: [{ to: "/partner/account", label: "My account" }] },
  ];
  return <Shell surface="partner" principal={partner.principal} sections={sections} />;
}

/** Book by phone obeys the `phoneBooking` switch in client-config (the menu hides it too). */
function PhoneBookingGate() {
  const config = useClientConfig();
  if (config?.features.phoneBooking === false) {
    return <Empty title="Booking by phone is switched off.">An admin can switch it back on in Settings → Feature flags.</Empty>;
  }
  return <PhoneBooking />;
}

function Guard({ ok, children }: { ok: (p: Principal) => boolean; children: ReactNode }) {
  const { staff } = useSession();
  if (!staff.principal) return null;
  return ok(staff.principal) ? <>{children}</> : <NoAccess />;
}

function NoAccess() {
  return (
    <Empty title="Nothing here for your roles.">
      If you need this page, ask a super admin to request the role for you. It takes a second super admin to approve it.
    </Empty>
  );
}

function Home() {
  const { staff, partner } = useSession();
  if (staff.loading || partner.loading) return null;
  if (staff.principal) return <Navigate to={staff.claims?.setup ? "/staff" : firstStaffPage(staff.principal)} replace />;
  if (partner.principal) return <Navigate to="/partner" replace />;
  return <Navigate to="/sign-in" replace />;
}

function StaffIndex() {
  const { staff } = useSession();
  return staff.principal ? <Navigate to={firstStaffPage(staff.principal)} replace /> : null;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/t/:token" element={<SharedTrip />} />
        <Route path="/sign-in" element={<SignInChooser />} />
        <Route path="/sign-in/staff" element={<StaffSignIn />} />
        <Route path="/sign-in/partner" element={<PartnerSignIn />} />

        <Route path="/staff" element={<StaffArea />}>
          <Route index element={<StaffIndex />} />
          <Route path="board" element={<Guard ok={(p) => inAnyCity(p, "trip:read")}><Board /></Guard>} />
          <Route path="drivers" element={<Guard ok={(p) => inAnyCity(p, "location:read_live")}><Drivers /></Guard>} />
          <Route path="phone" element={<Guard ok={(p) => inAnyCity(p, "trip:create_on_behalf")}><PhoneBookingGate /></Guard>} />
          <Route path="trips" element={<Guard ok={(p) => inAnyCity(p, "trip:read")}><TripDetail /></Guard>} />
          <Route path="trips/:tripId" element={<Guard ok={(p) => inAnyCity(p, "trip:read")}><TripDetail /></Guard>} />
          <Route path="onboarding" element={<Guard ok={(p) => inAnyCity(p, "org:read") || inAnyCity(p, "org:suspend")}><Onboarding /></Guard>} />
          <Route path="review" element={<Guard ok={(p) => inAnyCity(p, "document:review")}><ReviewQueuePage /></Guard>} />
          <Route path="fleet/drivers" element={<Guard ok={(p) => inAnyCity(p, "driver:read")}><DriverDirectory /></Guard>} />
          <Route path="fleet/drivers/:userId" element={<Guard ok={(p) => inAnyCity(p, "driver:read")}><DriverRecord /></Guard>} />
          <Route path="fleet/vehicles" element={<Guard ok={(p) => inAnyCity(p, "vehicle:read")}><VehicleDirectory /></Guard>} />
          <Route path="fleet/vehicles/:id" element={<Guard ok={(p) => inAnyCity(p, "vehicle:read")}><VehicleRecord /></Guard>} />
          <Route path="safety" element={<Guard ok={(p) => inAnyCity(p, "user:suspend")}><Safety /></Guard>} />
          <Route path="people" element={<Guard ok={(p) => can(p, "role:request") || can(p, "role:approve") || can(p, "staff:manage")}><People /></Guard>} />
          <Route path="admin" element={<Guard ok={(p) => inAnyCity(p, "report:read") || can(p, "system:read")}><OverviewPage /></Guard>} />
          <Route path="admin/users" element={<Guard ok={(p) => inAnyCity(p, "user:read_masked")}><UsersPage /></Guard>} />
          <Route path="admin/users/:id" element={<Guard ok={(p) => inAnyCity(p, "user:read_masked")}><UserPage /></Guard>} />
          <Route path="admin/roles" element={<Guard ok={(p) => can(p, "authz:read")}><RolesPage /></Guard>} />
          <Route path="admin/approvals" element={<Guard ok={(p) => APPROVERS.some((perm) => can(p, perm))}><ApprovalsPage /></Guard>} />
          <Route path="admin/settings" element={<Guard ok={(p) => can(p, "settings:read")}><SettingsPage /></Guard>} />
          <Route path="admin/cities" element={<Guard ok={(p) => can(p, "settings:read")}><CitiesPage /></Guard>} />
          <Route path="admin/announcements" element={<Guard ok={(p) => can(p, "announcement:manage")}><AnnouncementsPage /></Guard>} />
          <Route path="admin/system" element={<Guard ok={(p) => can(p, "system:read")}><SystemPage /></Guard>} />
          <Route path="admin/audit" element={<Guard ok={(p) => can(p, "audit_log:read")}><AuditPage /></Guard>} />
          <Route path="money" element={<Guard ok={(p) => inAnyCity(p, "balance:read") || can(p, "report:read_finance")}><MoneyOverviewPage /></Guard>} />
          <Route path="money/balances" element={<Guard ok={(p) => inAnyCity(p, "balance:read")}><BalancesPage /></Guard>} />
          <Route path="money/balances/:accountId" element={<Guard ok={(p) => inAnyCity(p, "balance:read")}><BalancePage /></Guard>} />
          <Route path="money/payments" element={<Guard ok={(p) => inAnyCity(p, "balance:read") || inAnyCity(p, "refund:request") || can(p, "refund:approve")}><PaymentsPage /></Guard>} />
          <Route path="money/approvals" element={<Guard ok={(p) => MONEY_APPROVERS.some((perm) => inAnyCity(p, perm))}><MoneyApprovalsPage /></Guard>} />
          <Route path="money/payouts" element={<Guard ok={(p) => can(p, "payout:prepare") || can(p, "payout:approve")}><PayoutsPage /></Guard>} />
          <Route path="money/adjustments" element={<Guard ok={canSeeAdjustments}><AdjustmentsPage /></Guard>} />
          <Route path="money/write-offs" element={<Guard ok={canSeeWriteOffs}><WriteOffsPage /></Guard>} />
          <Route path="money/overrides" element={<Guard ok={canSeeOverrides}><OverridesPage /></Guard>} />
          <Route path="money/incentives" element={<Guard ok={canSeeIncentives}><IncentivesPage /></Guard>} />
          <Route path="money/invoices" element={<Guard ok={canSeeInvoices}><InvoicesPage /></Guard>} />
          <Route path="money/rules" element={<Guard ok={(p) => RULE_READERS.some((perm) => inAnyCity(p, perm))}><RulesPage /></Guard>} />
          <Route path="money/providers" element={<Guard ok={(p) => can(p, "balance:read") || can(p, "report:read_finance") || can(p, "system:read")}><ProvidersPage /></Guard>} />
          <Route path="search" element={<Guard ok={(p) => inAnyCity(p, "trip:read")}><TripSearchPage /></Guard>} />
          <Route path="scheduled" element={<Guard ok={(p) => inAnyCity(p, "trip:read")}><StaffScheduledPage /></Guard>} />
          <Route path="trips/:tripId/trace" element={<Guard ok={(p) => inAnyCity(p, "trip:read_gps_trace")}><TripTracePage /></Guard>} />
          <Route path="reports/regulatory" element={<Guard ok={(p) => inAnyCity(p, "report:read_regulatory")}><RegulatoryReportPage /></Guard>} />
          <Route path="reports" element={<Guard ok={(p) => inAnyCity(p, "report:read") || can(p, "report:read_finance")}><ReportsPage /></Guard>} />
          <Route path="safety/sos" element={<Guard ok={(p) => inAnyCity(p, "sos:respond")}><SosQueuePage /></Guard>} />
          <Route path="safety/incidents" element={<Guard ok={(p) => inAnyCity(p, "incident:manage")}><IncidentsPage /></Guard>} />
          <Route path="safety/incidents/:id" element={<Guard ok={(p) => inAnyCity(p, "incident:manage")}><IncidentPage /></Guard>} />
          <Route path="support/tickets" element={<Guard ok={(p) => inAnyCity(p, "ticket:read")}><TicketsPage /></Guard>} />
          <Route path="support/tickets/:id" element={<Guard ok={(p) => inAnyCity(p, "ticket:read")}><TicketPage /></Guard>} />
          <Route path="support/lost-items" element={<Guard ok={(p) => inAnyCity(p, "lost_item:manage")}><LostItemsPage /></Guard>} />
          <Route path="ops/zones" element={<Guard ok={canSeeZones}><ZonesPage /></Guard>} />
          <Route path="ops/pricing" element={<Guard ok={canSeePricing}><PricingPage /></Guard>} />
          <Route path="marketing/promos" element={<Guard ok={canSeePromos}><PromosPage /></Guard>} />
          <Route path="marketing/campaigns" element={<Guard ok={canSeeCampaigns}><CampaignsPage /></Guard>} />
          <Route path="account" element={<StaffAccountPage />} />
          <Route path="none" element={<NoAccess />} />
        </Route>

        <Route path="/partner" element={<PartnerArea />}>
          <Route index element={<PartnerHome />} />
          <Route path="register" element={<RegisterCompany />} />
          <Route path="org/:orgId" element={<OrgPage />} />
          <Route path="org/:orgId/book" element={<CorporateBooking />} />
          <Route path="org/:orgId/vehicles/:vehicleId" element={<FleetVehiclePage />} />
          <Route path="org/:orgId/trips" element={<CompanyTripsPage />} />
          <Route path="org/:orgId/trips/:tripId" element={<PartnerTripPage />} />
          <Route path="org/:orgId/earnings" element={<FleetEarningsPage />} />
          <Route path="org/:orgId/charges" element={<CompanyChargesPage />} />
          <Route path="org/:orgId/invoices" element={<CompanyInvoicesPage />} />
          <Route path="org/:orgId/policy" element={<CompanyPoliciesPage />} />
          <Route path="org/:orgId/scheduled" element={<CompanyScheduledPage />} />
          <Route path="org/:orgId/drivers/:userId" element={<PartnerDriverPage />} />
          <Route path="account" element={<PartnerAccountPage />} />
        </Route>

        <Route path="*" element={<div style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: "1rem" }}><Empty title="No such page."><a href="/">Back to the start</a></Empty></div>} />
      </Routes>
    </BrowserRouter>
  );
}

