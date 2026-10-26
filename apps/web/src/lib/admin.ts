// Types and words for the Administration pages (auth-service directory and approvals,
// platform-service settings, audit-service).

import type { SettingDef } from "@ride-app/shared-settings";

export interface RoleRow {
  role: string;
  label: string;
  scope: "SELF" | "ORG" | "CITY" | "GLOBAL";
  cityId?: string;
  orgId?: string;
}

export interface UserRow {
  id: string;
  name: string;
  staff: boolean;
  email: string | null;
  phone: string | null;
  roles: RoleRow[];
  status: "ACTIVE" | "GUEST" | "SUSPENDED" | "DELETED";
  twoFactorEnabled: boolean;
  createdAt: string;
  lastSignInAt: string | null;
}

export interface UserDetail extends Omit<UserRow, "lastSignInAt"> {
  banReason: string | null;
  banExpires: string | null;
  mustChangePassword: boolean;
  permissionVersion: number;
  memberships: { organizationId: string; organizationName: string; kind: string; cityId: string; status: string; roles: string[]; since: string }[];
  sessions: { id: string; surface: string; ipAddress: string | null; userAgent: string | null; createdAt: string; lastActiveAt: string; expiresAt: string; active: boolean }[];
}

export interface Approval {
  id: string;
  action: string;
  payload: Record<string, unknown>;
  reason: string;
  makerId: string;
  checkerId: string | null;
  status: string;
  decisionReason: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

export interface SettingChange {
  id: string;
  key: string;
  cityId: string | null;
  value: unknown;
  reason: string;
  makerId: string;
  checkerId: string | null;
  status: string;
  createdAt: string;
  expiresAt: string;
}

export interface SettingsOverview {
  version: number;
  groups: string[];
  definitions: SettingDef[];
  global: Record<string, unknown>;
  cities: Record<string, Record<string, unknown>>;
  cityList: { id: string; name: string; enabled: boolean }[];
  pending: SettingChange[];
}

export interface AuditEntry {
  eventId: string;
  at: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  outcome: string;
  reason: string | null;
  service: string | null;
}

export const ACTION_LABEL: Record<string, string> = {
  "role:grant": "Grant a staff role",
  "authz:change": "Change a role's permissions",
  "staff:reset_mfa": "Reset a super admin's sign-in",
  "settings:change": "Change a setting",
};

export const SCOPE_WORD: Record<string, string> = { S: "own", O: "organisation", C: "city", G: "everywhere" };

/** "match.radiiMeters" value → words, with its unit. */
export function showValue(def: Pick<SettingDef, "type" | "unit" | "options"> | undefined, v: unknown): string {
  if (v === null || v === undefined) return "default";
  if (!def) return JSON.stringify(v);
  if (def.type === "bool") return v ? "on" : "off";
  if (def.type === "money") return `${((v as number) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} birr`;
  if (Array.isArray(v)) return `${v.join(", ")}${def.unit ? ` ${def.unit}` : ""}`;
  return `${String(v)}${def.unit ? ` ${def.unit}` : ""}`;
}

/** Trigger a file download for text fetched with the API client. */
export function download(filename: string, text: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const daysSince = (iso: string | null, now = Date.now()) => (iso ? Math.floor((now - new Date(iso).getTime()) / 86_400_000) : null);
