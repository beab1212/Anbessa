// Development sign-in accounts (DEV_LOGIN=on, `seed:dev`). The credentials are fixed and
// public on purpose: they only exist in a database seeded by `seed:dev`, which refuses to run
// outside NODE_ENV=development, and the routes that use them are refused in production.

import { createHmac } from "node:crypto";
import type { RoleCode } from "@ride-app/shared-authz";

export const DEV_PASSWORD = "anbessa-dev-password";

/** Raw TOTP secret. Better Auth uses its UTF-8 bytes as the HMAC-SHA1 key (30 s, 6 digits). */
export const DEV_TOTP_SECRET = "anbessa-dev-totp-secret-not-real";

export const DEV_CITY = "addis-ababa";

export interface DevOrg {
  slug: string;
  name: string;
  kind: "FLEET" | "CORPORATE";
  legalName: string;
  tin: string;
}

export const DEV_ORGS: DevOrg[] = [
  { slug: "dev-fleet", name: "Selam Transport (dev)", kind: "FLEET", legalName: "Selam Transport PLC", tin: "0900000101" },
  { slug: "dev-corporate", name: "Abay Bank (dev)", kind: "CORPORATE", legalName: "Abay Bank S.C.", tin: "0900000201" },
];

interface Base {
  key: string;
  name: string;
  /** What the account is for, shown on the sign-in page. */
  label: string;
}

export interface DevStaff extends Base {
  surface: "staff";
  email: string;
  /** City-scoped roles are granted in DEV_CITY. */
  roles: RoleCode[];
}

export interface DevPartner extends Base {
  surface: "partner";
  phone: string;
  memberships: { org: string; role: RoleCode }[];
  /** used from the phone app (drivers); the web sign-in panel leaves these out */
  app?: "phone";
}

export type DevAccount = DevStaff | DevPartner;

const staff = (key: string, name: string, label: string, roles: RoleCode[]): DevStaff => ({
  surface: "staff", key, name, label, email: `${key}@staff.anbessa.test`, roles,
});

export const DEV_ACCOUNTS: DevAccount[] = [
  staff("super-admin", "Tigist Alemu", "Super admin", ["SUPER_ADMIN"]),
  staff("super-admin-2", "Dawit Bekele", "Second super admin (approves requests)", ["SUPER_ADMIN"]),
  staff("dispatcher", "Hana Girma", "Dispatcher", ["DISPATCHER"]),
  staff("call-center", "Yonas Tesfaye", "Call center agent", ["CALL_CENTER_AGENT"]),
  staff("onboarding", "Meron Haile", "Onboarding officer", ["ONBOARDING_OFFICER"]),
  staff("safety", "Biruk Assefa", "Safety officer", ["SAFETY_OFFICER"]),
  staff("ops-floor", "Selam Kebede", "Ops floor (dispatch, call center, onboarding, safety)", ["DISPATCHER", "CALL_CENTER_AGENT", "ONBOARDING_OFFICER", "SAFETY_OFFICER"]),
  staff("support", "Eden Wolde", "Support agent (asks for refunds)", ["SUPPORT_AGENT"]),
  staff("operations-manager", "Henok Abebe", "Operations manager (proposes commission and limits)", ["OPERATIONS_MANAGER"]),
  staff("finance-officer", "Mahlet Fikru", "Finance officer (records cash, runs settlement)", ["FINANCE_OFFICER"]),
  staff("finance-manager", "Bereket Lemma", "Finance manager (approves money)", ["FINANCE_MANAGER"]),
  { surface: "partner", key: "fleet-owner", name: "Abebe Kassa", label: "Fleet owner", phone: "+251900000101", memberships: [{ org: "dev-fleet", role: "FLEET_OWNER" }] },
  { surface: "partner", key: "corporate-admin", name: "Liya Mekonnen", label: "Company account admin", phone: "+251900000201", memberships: [{ org: "dev-corporate", role: "CORPORATE_ADMIN" }] },
  { surface: "partner", key: "corporate-coordinator", name: "Samuel Tadesse", label: "Company travel desk (books rides)", phone: "+251900000202", memberships: [{ org: "dev-corporate", role: "CORPORATE_COORDINATOR" }] },
  { surface: "partner", key: "employee", name: "Ruth Desta", label: "Company employee (rider)", phone: "+251900000203", memberships: [{ org: "dev-corporate", role: "CORPORATE_EMPLOYEE" }] },
  { surface: "partner", key: "new-partner", name: "Kebede Worku", label: "New partner, no company yet", phone: "+251900000301", memberships: [] },
  // drivers (fleet-service's seed:dev gives them applications, documents and cars)
  { surface: "partner", app: "phone", key: "fleet-driver", name: "Tesfaye Alemu", label: "Fleet driver (Selam Transport)", phone: "+251900000102", memberships: [{ org: "dev-fleet", role: "FLEET_DRIVER" }] },
  { surface: "partner", app: "phone", key: "driver-applicant", name: "Mulugeta Bekele", label: "Owner-driver waiting for review", phone: "+251900000401", memberships: [] },
  { surface: "partner", app: "phone", key: "driver-active", name: "Almaz Tadesse", label: "Owner-driver, approved", phone: "+251900000402", memberships: [] },
  // a rider for the phone app (trip requests, payments)
  { surface: "partner", app: "phone", key: "rider", name: "Sara Getachew", label: "Rider", phone: "+251900000501", memberships: [] },
];

/** RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits) over the secret's UTF-8 bytes, like Better Auth. */
export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", Buffer.from(secret, "utf8")).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** The authenticator code a dev staff account would show right now. */
export const devTotp = (at = Date.now()) => totp(DEV_TOTP_SECRET, at);

/** Keeps the last console OTP per phone so the dev sign-in can read it (never in production). */
export function createOtpInbox(ttlMs = 5 * 60_000) {
  const codes = new Map<string, { code: string; at: number }>();
  return {
    put(phoneNumber: string, code: string) {
      codes.set(phoneNumber, { code, at: Date.now() });
    },
    latest(phoneNumber: string): string | undefined {
      const hit = codes.get(phoneNumber);
      if (!hit || Date.now() - hit.at > ttlMs) return undefined;
      return hit.code;
    },
  };
}

export type OtpInbox = ReturnType<typeof createOtpInbox>;
