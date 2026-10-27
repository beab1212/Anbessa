// Phase 2D: vehicle ownership transfers (rule V9, maker–checker), manual vehicle suspension,
// organisation reinstatement and members (auth-service), and a fleet's expiring documents.
// Types, words, and the pure rules the pages use to show or hide actions (services check again).

import type { Principal } from "@ride-app/shared-authz";
import { allowed } from "./api";
import type { FleetDocument, Vehicle } from "./fleet";

export type OwnerType = "INDIVIDUAL" | "ORGANIZATION";
export type TransferStatus = "REQUESTED" | "PENDING" | "EXECUTED" | "REJECTED" | "CANCELLED" | "EXPIRED";

export interface VehicleTransfer {
  id: string;
  vehicleId: string;
  cityId: string;
  status: TransferStatus;
  from: { type: OwnerType; id: string; name: string | null };
  to: { type: OwnerType; id: string; name: string | null };
  reason: string;
  /** the owner who asked (null when staff started it) */
  requestedBy: string | null;
  /** the officer who proposed it */
  makerId: string | null;
  /** the officer who approved or rejected it */
  checkerId: string | null;
  decisionNote: string | null;
  expiresAt: string;
  decidedAt: string | null;
  createdAt: string;
  vehicle?: { plateNumber: string; make: string; model: string; color: string; status: string };
}

export interface OrgMember {
  userId: string;
  name: string;
  /** always masked */
  phone: string | null;
  roles: string[];
  since: string;
  validUntil: string | null;
  suspended: boolean;
}

export interface OrgSuspension {
  id: string;
  previousStatus: "PENDING" | "VERIFIED";
  reason: string;
  suspendedBy: string;
  suspendedAt: string;
  reinstatedBy: string | null;
  reinstatedAt: string | null;
  reinstateReason: string | null;
}

export interface OrgMembers {
  orgId: string;
  status: string;
  pendingInvitations: number;
  members: OrgMember[];
  suspensions: OrgSuspension[];
}

export interface ExpiringDocuments {
  orgId: string;
  days: number;
  until: string;
  documents: (FleetDocument & { daysLeft: number | null; vehicle: Pick<Vehicle, "id" | "plateNumber" | "status"> | null })[];
}

// ── words ─────────────────────────────────────────────────────────────────────

export const TRANSFER_WORD: Record<TransferStatus, string> = {
  REQUESTED: "asked by the owner", PENDING: "waiting for a second officer", EXECUTED: "done",
  REJECTED: "rejected", CANCELLED: "withdrawn", EXPIRED: "expired",
};
export const transferTone = (s: TransferStatus): "amber" | "green" | "red" | "grey" =>
  s === "REQUESTED" || s === "PENDING" ? "amber" : s === "EXECUTED" ? "green" : s === "REJECTED" ? "red" : "grey";

export const isOpenTransfer = (t: Pick<VehicleTransfer, "status">) => t.status === "REQUESTED" || t.status === "PENDING";

export const ORG_ROLE_WORD: Record<string, string> = {
  fleet_owner: "fleet owner", fleet_driver: "driver", corporate_admin: "admin", corporate_coordinator: "coordinator", employee: "employee",
};

/** "owner-driver Abebe" / "a fleet company" with a name lookup for companies. */
export function ownerLabel(o: VehicleTransfer["from"], orgName?: (id: string) => string | undefined) {
  if (o.type === "INDIVIDUAL") return o.name ? `owner-driver ${o.name}` : "an owner-driver";
  return orgName?.(o.id) ?? "a fleet company";
}

/** Days left as words: "expired 3 days ago", "today", "in 10 days". */
export function daysLeftWord(n: number | null): string {
  if (n === null) return "no date";
  if (n < 0) return `expired ${-n} day${n === -1 ? "" : "s"} ago`;
  if (n === 0) return "expires today";
  return `in ${n} day${n === 1 ? "" : "s"}`;
}

export const REASON_MIN = 10;

// ── who may do what (UI only; fleet-service and auth-service check again) ─────

/** Staff actions on one transfer, for this person, in the transfer's city. */
export function transferActions(p: Principal | null, t: VehicleTransfer) {
  const officer = allowed(p, "vehicle:transfer", { cityId: t.cityId });
  const me = p?.userId;
  const open = isOpenTransfer(t);
  return {
    endorse: open && officer && t.status === "REQUESTED",
    approve: open && officer && t.status === "PENDING" && t.makerId !== me,
    reject: open && officer && t.makerId !== me,
    cancel: open && !!me && (t.requestedBy === me || t.makerId === me),
    /** the maker waits for someone else */
    waitingForOther: open && t.status === "PENDING" && t.makerId === me,
  };
}

/** Manual vehicle suspension: driver:suspend / driver:reinstate in the vehicle's city. */
export function vehicleSuspendActions(p: Principal | null, v: Pick<Vehicle, "status" | "cityId">) {
  return {
    suspend: v.status === "VERIFIED" && allowed(p, "driver:suspend", { cityId: v.cityId }),
    reinstate: v.status === "SUSPENDED" && allowed(p, "driver:reinstate", { cityId: v.cityId }),
  };
}

/** Lifting a company suspension: whoever may suspend it (org:suspend in its city). */
export const canReinstateOrg = (p: Principal | null, org: { status: string; cityId: string }) =>
  org.status === "SUSPENDED" && allowed(p, "org:suspend", { cityId: org.cityId });

/** Members list: org:read or org:suspend in the company's city. */
export const canListMembers = (p: Principal | null, cityId: string) =>
  allowed(p, "org:read", { cityId }) || allowed(p, "org:suspend", { cityId });

/** Fleet portal: the fleet may ask to hand over a car it may dispose of (vehicle:retire). */
export const fleetMayAskTransfer = (p: Principal | null, orgId: string, v: Pick<Vehicle, "status">) =>
  v.status !== "RETIRED" && allowed(p, "vehicle:retire", { orgId });

/** Turns the fleet portal's form into the API body; null while incomplete. */
export function transferBody(form: { target: "driver" | "company"; driverId: string; orgId: string; reason: string }) {
  const reason = form.reason.trim();
  if (reason.length < REASON_MIN) return null;
  if (form.target === "driver") return form.driverId ? { toOwnerType: "INDIVIDUAL" as const, toOwnerId: form.driverId, reason } : null;
  const id = form.orgId.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? { toOwnerType: "ORGANIZATION" as const, toOwnerId: id, reason } : null;
}
