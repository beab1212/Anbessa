import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Building2, Car, LayoutDashboard, LogOut, Phone, Search, ShieldAlert, UserCog, UsersRound, type LucideProps } from "lucide-react";
import type { Principal } from "@ride-app/shared-authz";
import type { Surface } from "../lib/api";
import { useSession } from "../lib/session";
import { Brand } from "./ui";

export interface Section {
  to: string;
  label: string;
  icon?: ComponentType<LucideProps>;
  badge?: number;
}

export const ICONS: Record<string, ComponentType<LucideProps>> = {
  "/staff/board": LayoutDashboard,
  "/staff/drivers": Car,
  "/staff/phone": Phone,
  "/staff/trips": Search,
  "/staff/onboarding": Building2,
  "/staff/safety": ShieldAlert,
  "/staff/people": UserCog,
  "/partner/register": Building2,
};

function useAddisClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Addis_Ababa" });
}

const ROLE_WORD: Record<string, string> = {
  SUPER_ADMIN: "super admin", CALL_CENTER_AGENT: "call center", DISPATCHER: "dispatch", SUPPORT_AGENT: "support",
  ONBOARDING_OFFICER: "onboarding", SAFETY_OFFICER: "safety", OPERATIONS_MANAGER: "operations", MARKETING: "marketing",
  ANALYST: "analyst", FINANCE_OFFICER: "finance", FINANCE_MANAGER: "finance manager", AUDITOR: "auditor", REGULATOR: "regulator",
  FLEET_OWNER: "fleet owner", CORPORATE_ADMIN: "company admin", CORPORATE_COORDINATOR: "coordinator", RIDER: "rider", DRIVER: "driver",
};

export function roleSummary(p: Principal): string {
  const words = [...new Set(p.roles.map((r) => ROLE_WORD[r.role] ?? r.role.toLowerCase()))];
  return words.length ? words.join(", ") : "no roles yet";
}

export function Shell({ surface, sections, principal, topbar }: { surface: Surface; sections: { title: string; items: Section[] }[]; principal: Principal; topbar?: ReactNode }) {
  const { signOut } = useSession();
  const navigate = useNavigate();
  const clock = useAddisClock();
  const { pathname } = useLocation();
  const current = sections.flatMap((s) => s.items).find((i) => pathname.startsWith(i.to));

  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand subtitle={surface === "staff" ? "Operations" : "Partner portal"} />
        <nav className="nav" aria-label="Sections">
          {sections.filter((s) => s.items.length).map((s) => (
            <div key={s.title}>
              <h4>{s.title}</h4>
              {s.items.map((item) => {
                const Icon = item.icon ?? ICONS[item.to] ?? UsersRound;
                return (
                  <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : "")}>
                    <Icon />
                    <span>{item.label}</span>
                    {item.badge ? <span className="badge">{item.badge}</span> : null}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="muted xs">{roleSummary(principal)}</div>
        </div>
      </aside>
      <header className="topbar">
        <h1>{current?.label ?? "Anbessa"}</h1>
        {topbar}
        <span className="spacer" />
        <span className="clock">{clock}</span>
        <button className="btn ghost sm" onClick={async () => { await signOut(surface); navigate("/sign-in"); }}>
          <LogOut /> Sign out
        </button>
      </header>
      <main className={`content ${current?.to && ["/staff/board", "/staff/drivers", "/staff/phone"].includes(current.to) ? "flush" : ""}`}>
        <Outlet />
      </main>
    </div>
  );
}
