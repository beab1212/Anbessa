import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { can, type Permission, type Principal } from "@ride-app/shared-authz";
import { CITIES } from "./lib/format";
import { useSession } from "./lib/session";
import { Shell, type Section } from "./components/Shell";
import { Empty } from "./components/ui";
import { PartnerSignIn, SignInChooser, StaffSignIn } from "./pages/SignIn";
import { StaffSetup } from "./pages/staff/Setup";
import { Board } from "./pages/staff/Board";
import { Drivers } from "./pages/staff/Drivers";
import { PhoneBooking } from "./pages/staff/PhoneBooking";
import { TripDetail } from "./pages/staff/TripDetail";
import { Onboarding } from "./pages/staff/Onboarding";
import { Safety } from "./pages/staff/Safety";
import { People } from "./pages/staff/People";
import { CorporateBooking, OrgPage, PartnerHome, RegisterCompany, useOrgs } from "./pages/partner/Partner";

/** Has the permission in any city (staff pages pick the city inside). */
const inAnyCity = (p: Principal, permission: Permission) => CITIES.some((cityId) => can(p, permission, { cityId })) || can(p, permission);

/** The staff index, built from the token's roles: you only see what you can do. */
export function staffSections(p: Principal): { title: string; items: Section[] }[] {
  const item = (ok: boolean, to: string, label: string) => (ok ? [{ to, label }] : []);
  return [
    {
      title: "Today",
      items: [
        ...item(inAnyCity(p, "trip:read"), "/staff/board", "Live board"),
        ...item(inAnyCity(p, "location:read_live"), "/staff/drivers", "Drivers"),
        ...item(inAnyCity(p, "trip:create_on_behalf"), "/staff/phone", "Book by phone"),
        ...item(inAnyCity(p, "trip:read"), "/staff/trips", "Find a trip"),
      ],
    },
    {
      title: "Accounts",
      items: [
        ...item(inAnyCity(p, "org:read"), "/staff/onboarding", "Companies"),
        ...item(inAnyCity(p, "user:suspend"), "/staff/safety", "Suspend"),
        ...item(can(p, "role:request") || can(p, "role:approve") || can(p, "staff:manage"), "/staff/people", "Staff and roles"),
      ],
    },
  ];
}

function firstStaffPage(p: Principal) {
  return staffSections(p).flatMap((s) => s.items)[0]?.to ?? "/staff/none";
}

function StaffArea() {
  const { staff } = useSession();
  if (staff.loading) return null;
  if (!staff.principal) return <Navigate to="/sign-in/staff" replace />;
  if (staff.claims?.setup) return <StaffSetup />;
  return <Shell surface="staff" principal={staff.principal} sections={staffSections(staff.principal)} />;
}

function PartnerArea() {
  const { partner } = useSession();
  const orgs = useOrgs();
  if (partner.loading) return null;
  if (!partner.principal) return <Navigate to="/sign-in/partner" replace />;
  const sections: { title: string; items: Section[] }[] = [
    { title: "Companies", items: [...(orgs.data ?? []).map((o) => ({ to: `/partner/org/${o.id}`, label: o.name })), { to: "/partner/register", label: "Register a company" }] },
  ];
  return <Shell surface="partner" principal={partner.principal} sections={sections} />;
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
        <Route path="/sign-in" element={<SignInChooser />} />
        <Route path="/sign-in/staff" element={<StaffSignIn />} />
        <Route path="/sign-in/partner" element={<PartnerSignIn />} />

        <Route path="/staff" element={<StaffArea />}>
          <Route index element={<StaffIndex />} />
          <Route path="board" element={<Guard ok={(p) => inAnyCity(p, "trip:read")}><Board /></Guard>} />
          <Route path="drivers" element={<Guard ok={(p) => inAnyCity(p, "location:read_live")}><Drivers /></Guard>} />
          <Route path="phone" element={<Guard ok={(p) => inAnyCity(p, "trip:create_on_behalf")}><PhoneBooking /></Guard>} />
          <Route path="trips" element={<Guard ok={(p) => inAnyCity(p, "trip:read")}><TripDetail /></Guard>} />
          <Route path="trips/:tripId" element={<Guard ok={(p) => inAnyCity(p, "trip:read")}><TripDetail /></Guard>} />
          <Route path="onboarding" element={<Guard ok={(p) => inAnyCity(p, "org:read")}><Onboarding /></Guard>} />
          <Route path="safety" element={<Guard ok={(p) => inAnyCity(p, "user:suspend")}><Safety /></Guard>} />
          <Route path="people" element={<Guard ok={(p) => can(p, "role:request") || can(p, "role:approve") || can(p, "staff:manage")}><People /></Guard>} />
          <Route path="none" element={<NoAccess />} />
        </Route>

        <Route path="/partner" element={<PartnerArea />}>
          <Route index element={<PartnerHome />} />
          <Route path="register" element={<RegisterCompany />} />
          <Route path="org/:orgId" element={<OrgPage />} />
          <Route path="org/:orgId/book" element={<CorporateBooking />} />
        </Route>

        <Route path="*" element={<div style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: "1rem" }}><Empty title="No such page."><a href="/">Back to the start</a></Empty></div>} />
      </Routes>
    </BrowserRouter>
  );
}

