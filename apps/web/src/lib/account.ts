// Self-service account helpers (profile, password, two-step backup codes, sessions) and the small
// rules behind the Administration overview and user pages. Pure functions; unit-tested in
// tests/account.test.ts and tests/admin.test.ts.

import { can, type Permission, type Principal } from "@ride-app/shared-authz";

// ── Better Auth shapes (admin surface /api/admin-auth) ──────────────────────

export interface AuthSession {
  id: string;
  token: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** `GET /get-session` on the admin surface. */
export interface StaffSessionInfo {
  session: AuthSession;
  user: { id: string; name: string; email: string; image?: string | null; twoFactorEnabled?: boolean | null };
}

// ── profile and password ────────────────────────────────────────────────────

/** Same rule as staff account creation (auth-service: trimmed, 2–120 characters). null = fine. */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (n.length < 2) return "At least 2 characters.";
  if (n.length > 120) return "At most 120 characters.";
  return null;
}

/** Staff passwords: 12–128 characters (admin surface), not the current one, typed twice. null = fine. */
export function passwordProblem(current: string, next: string, repeat: string): string | null {
  if (next.length < 12) return "The new password needs at least 12 characters. A sentence works well.";
  if (next.length > 128) return "At most 128 characters.";
  if (next === current) return "Choose a password different from the current one.";
  if (repeat !== next) return "The two new passwords don't match.";
  return null;
}

// ── backup codes ────────────────────────────────────────────────────────────

/** What people type: spaces, and a dash typed by hand or not, are tolerated; case is kept. */
export const normalizeBackupCode = (input: string) => input.replace(/\s+/g, "");

/** The text put on the clipboard (never logged, never stored by the app). */
export function backupCodesText(codes: string[], email: string | null | undefined, at = new Date()): string {
  return [
    `Anbessa staff backup codes${email ? ` for ${email}` : ""}`,
    `Made ${at.toISOString().slice(0, 10)}. Each code works once. New codes replace these.`,
    "",
    ...codes,
    "",
  ].join("\n");
}

// ── sessions ────────────────────────────────────────────────────────────────

/** "Firefox on Linux" from a user agent; good enough to recognise your own devices. */
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Dart\//.test(ua) ? "Anbessa app" : null;
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}

/** This browser first, then the most recently active. */
export function orderSessions<T extends Pick<AuthSession, "token" | "updatedAt">>(list: T[], currentToken: string | null | undefined): T[] {
  return [...list].sort((a, b) => (a.token === currentToken ? -1 : b.token === currentToken ? 1 : b.updatedAt.localeCompare(a.updatedAt)));
}

// ── Administration: overview and users ──────────────────────────────────────

/**
 * Whose numbers the overview may show. Global report readers see every city (or one they pick);
 * city-scoped readers (dispatchers, support, onboarding, operations, marketing, analysts) see only
 * their cities, one at a time, since the services refuse "all cities" without a global grant.
 */
export function reportScope(p: Principal | null, allCities: string[]): { global: boolean; cities: string[] } {
  if (!p) return { global: false, cities: [] };
  const global = can(p, "report:read");
  return { global, cities: global ? allCities : allCities.filter((cityId) => can(p, "report:read", { cityId })) };
}

/** `/api/x/stats` or `/api/x/stats?cityId=…` (null = every city). */
export const statsPath = (base: string, cityId: string | null) => (cityId ? `${base}?cityId=${encodeURIComponent(cityId)}` : base);

/** Held in any city, or globally (for showing a link; the target page checks again). */
export const inAnyCity = (p: Principal | null, permission: Permission, allCities: string[]) =>
  !!p && (can(p, permission) || allCities.some((cityId) => can(p, permission, { cityId })));

export type SuspendFor = "" | "1d" | "7d" | "30d" | "date";
export const SUSPEND_FOR: { value: SuspendFor; label: string }[] = [
  { value: "", label: "Until someone reinstates them" },
  { value: "1d", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "date", label: "Until a date" },
];

/**
 * The `until` sent with a suspension: undefined = open-ended. A picked date ends at the start of
 * that day in Addis Ababa (UTC+3). Returns "invalid" for a missing or past date.
 */
export function suspendUntil(choice: SuspendFor, date: string, now = Date.now()): string | undefined | "invalid" {
  const DAY = 86_400_000;
  if (choice === "") return undefined;
  if (choice === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "invalid";
    const at = Date.parse(`${date}T00:00:00+03:00`);
    return Number.isNaN(at) || at <= now ? "invalid" : new Date(at).toISOString();
  }
  return new Date(now + { "1d": 1, "7d": 7, "30d": 30 }[choice] * DAY).toISOString();
}
