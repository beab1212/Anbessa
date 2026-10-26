import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Activity, Banknote, Building2, CarFront, CheckCheck, ClipboardCheck, CreditCard, Gauge, HandCoins, IdCard, KeyRound, Landmark, LayoutDashboard, LogOut, Map as MapIcon, MapPinned, Megaphone, Percent, Phone, PlugZap, ScrollText, Search, ShieldAlert, SlidersHorizontal, UserCog, Users, UsersRound, Wallet, type LucideProps } from "lucide-react";
import { roleInfo, type Principal } from "@ride-app/shared-authz";
import { useClientConfig } from "../lib/platform";
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
  "/staff/drivers": MapIcon,
  "/staff/review": ClipboardCheck,
  "/staff/fleet/drivers": IdCard,
  "/staff/fleet/vehicles": CarFront,
  "/staff/admin": Gauge,
  "/staff/admin/users": Users,
  "/staff/admin/roles": KeyRound,
  "/staff/admin/approvals": CheckCheck,
  "/staff/admin/settings": SlidersHorizontal,
  "/staff/admin/cities": MapPinned,
  "/staff/admin/announcements": Megaphone,
  "/staff/admin/system": Activity,
  "/staff/admin/audit": ScrollText,
  "/staff/phone": Phone,
  "/staff/trips": Search,
  "/staff/onboarding": Building2,
  "/staff/safety": ShieldAlert,
  "/staff/people": UserCog,
  "/staff/money": Landmark,
  "/staff/money/balances": Wallet,
  "/staff/money/payments": CreditCard,
  "/staff/money/approvals": HandCoins,
  "/staff/money/payouts": Banknote,
  "/staff/money/rules": Percent,
  "/staff/money/providers": PlugZap,
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
  const words = [...new Set(p.roles.map((r) => ROLE_WORD[r.role] ?? roleInfo(r.role)?.label.toLowerCase() ?? r.role.toLowerCase()))];
  return words.length ? words.join(", ") : "no roles yet";
}

export function Shell({ surface, sections, principal, topbar }: { surface: Surface; sections: { title: string; items: Section[] }[]; principal: Principal; topbar?: ReactNode }) {
  const { signOut } = useSession();
  const navigate = useNavigate();
  const clock = useAddisClock();
  const { pathname } = useLocation();
  const items = sections.flatMap((s) => s.items);
  // the most specific item wins (/staff/admin/users over /staff/admin)
  const current = items.filter((i) => pathname === i.to || pathname.startsWith(`${i.to}/`)).sort((a, b) => b.to.length - a.to.length)[0];
  const config = useClientConfig();
  const audience = surface === "staff" ? "staff" : "partner";
  const banners = (config?.announcements ?? []).filter((a) => a.audiences.includes(audience));
  const paused = !!config?.maintenance.newTripsPaused;
  const flush = !!current?.to && ["/staff/board", "/staff/drivers", "/staff/phone"].includes(current.to);

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
                  <NavLink key={item.to} to={item.to} end={items.some((o) => o.to.startsWith(`${item.to}/`))} className={({ isActive }) => (isActive ? "active" : "")}>
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
        {paused ? <span className="pill red" title={config?.maintenance.message}>new trips paused</span> : null}
        <span className="spacer" />
        <span className="clock">{clock}</span>
        <button className="btn ghost sm" onClick={async () => { await signOut(surface); navigate("/sign-in"); }}>
          <LogOut /> Sign out
        </button>
      </header>
      <main className={`content ${flush ? "flush" : ""}`}>
        {!flush && (banners.length || paused) ? (
          <div className="banners">
            {paused ? <div className="alert error" role="status"><strong>Maintenance:</strong>&nbsp;{config?.maintenance.message}</div> : null}
            {banners.map((a) => (
              <div key={a.id} className={`alert ${a.severity === "warning" ? "error" : "info"}`} role="status"><strong>{a.title}</strong>&nbsp;· {a.body}</div>
            ))}
          </div>
        ) : null}
        <Outlet />
      </main>
    </div>
  );
}
