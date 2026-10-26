// Onboarding and ownership rules (Role.md §6, workflows 02–04) as pure functions.

export type SubjectType = "DRIVER" | "VEHICLE" | "ORGANIZATION";
export type DocumentKind = "LICENSE" | "NATIONAL_ID" | "PHOTO" | "REGISTRATION" | "INSURANCE" | "INSPECTION" | "BUSINESS_LICENSE" | "TIN";

export const DOCUMENT_KINDS: Record<SubjectType, readonly DocumentKind[]> = {
  DRIVER: ["LICENSE", "NATIONAL_ID", "PHOTO"],
  VEHICLE: ["REGISTRATION", "INSURANCE", "INSPECTION"],
  ORGANIZATION: ["BUSINESS_LICENSE", "TIN"],
};

/** Documents that lapse: their expiry date is required, and the expiry job watches them. */
export const EXPIRING_KINDS: readonly DocumentKind[] = ["LICENSE", "INSURANCE", "INSPECTION"];

/** Vehicle types matching knows (same codes as trip-service and location-service), with allowed seats. */
export const VEHICLE_TYPES: Record<string, { seats: [number, number] }> = {
  economy: { seats: [3, 4] },
  comfort: { seats: [3, 4] },
  minivan: { seats: [5, 8] },
};

export const normalizePlate = (p: string) => p.trim().replace(/\s+/g, " ").toUpperCase();

export interface DocRow {
  id: string;
  kind: string;
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
}

/** Start of the given day (UTC); document expiry dates are whole days. */
export const dayOf = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export const isExpired = (doc: Pick<DocRow, "expiresAt">, now: Date) => !!doc.expiresAt && doc.expiresAt < dayOf(now);

/** The document that counts for each kind: the newest one that wasn't replaced. */
export function currentDocuments<T extends DocRow>(docs: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const d of [...docs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    if (d.status === "SUPERSEDED" || out.has(d.kind)) continue;
    out.set(d.kind, d);
  }
  return out;
}

/** Kinds still needed before the subject can go to review (missing, rejected or expired). */
export function missingForSubmit(subject: SubjectType, docs: readonly DocRow[], now: Date): DocumentKind[] {
  const current = currentDocuments(docs);
  return DOCUMENT_KINDS[subject].filter((k) => {
    const d = current.get(k);
    return !d || d.status === "REJECTED" || d.status === "EXPIRED" || isExpired(d, now);
  });
}

/** Kinds not yet approved (or approved but lapsed): approving the subject must wait for these. */
export function missingForApproval(subject: SubjectType, docs: readonly DocRow[], now: Date): DocumentKind[] {
  const current = currentDocuments(docs);
  return DOCUMENT_KINDS[subject].filter((k) => {
    const d = current.get(k);
    return !d || d.status !== "APPROVED" || isExpired(d, now);
  });
}

// ── going online (Role.md §6, "Going online: which vehicle is allowed?") ────────

export type DriveDenial =
  | "driver_not_active"
  | "documents_expired"
  | "vehicle_not_verified"
  | "vehicle_in_use"
  | "not_your_vehicle"
  | "not_in_this_fleet"
  | "not_authorized_for_vehicle";

export interface DriveCheck {
  driver: { userId: string; status: string } | null;
  driverDocsExpired: boolean;
  vehicle: { status: string; ownerType: string; ownerUserId: string | null; ownerOrgId: string | null };
  /** another driver's open session on this vehicle */
  vehicleBusy: boolean;
  /** fleet orgs the driver belongs to (FLEET_DRIVER / FLEET_OWNER roles in the token) */
  fleetOrgIds: readonly string[];
  authorization: { status: string; validUntil: Date | null } | null;
  now: Date;
}

/** null = may start a session with this vehicle; otherwise the first rule that fails. */
export function driveDenial(c: DriveCheck): DriveDenial | null {
  if (!c.driver || c.driver.status !== "ACTIVE") return "driver_not_active";
  if (c.driverDocsExpired) return "documents_expired";
  if (c.vehicle.status !== "VERIFIED") return "vehicle_not_verified";
  // ownership before availability, so a stranger never learns whether the car is out driving
  if (c.vehicle.ownerType === "INDIVIDUAL") {
    if (c.vehicle.ownerUserId !== c.driver.userId) return "not_your_vehicle"; // V6
  } else {
    if (!c.vehicle.ownerOrgId || !c.fleetOrgIds.includes(c.vehicle.ownerOrgId)) return "not_in_this_fleet"; // V7
    const a = c.authorization;
    if (!a || a.status !== "ACTIVE" || (a.validUntil && a.validUntil <= c.now)) return "not_authorized_for_vehicle";
  }
  return c.vehicleBusy ? "vehicle_in_use" : null; // V4
}

export const DENIAL_MESSAGE: Record<DriveDenial, string> = {
  driver_not_active: "Complete driver onboarding first",
  documents_expired: "A driver document has expired: upload the renewed one",
  vehicle_not_verified: "This vehicle isn't verified",
  vehicle_in_use: "This vehicle is already in use",
  not_your_vehicle: "You can only drive your own vehicle",
  not_in_this_fleet: "You aren't a driver of this vehicle's fleet",
  not_authorized_for_vehicle: "Your fleet owner hasn't given you this vehicle",
};
