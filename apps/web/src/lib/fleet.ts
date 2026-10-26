// fleet-service (drivers, vehicles, documents): types, labels, and the document upload flow.

import axios from "axios";
import { api, ApiError, type Surface } from "./api";

export type SubjectType = "DRIVER" | "VEHICLE" | "ORGANIZATION";
export type DocStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "SUPERSEDED";
export type DriverStatus = "APPLIED" | "PENDING_REVIEW" | "ACTIVE" | "SUSPENDED";
export type VehicleStatus = "DRAFT" | "PENDING_REVIEW" | "VERIFIED" | "REJECTED" | "SUSPENDED" | "RETIRED";

export interface FleetDocument {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  kind: string;
  status: DocStatus;
  contentType: string;
  sizeBytes: number;
  expiresAt: string | null;
  expiringSoon: boolean;
  rejectReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface Checklist {
  documents: { kind: string; required: boolean; expires: boolean; document: FleetDocument | null }[];
  missingForSubmit: string[];
  missingForApproval: string[];
}

export interface Session {
  id: string;
  driverUserId: string;
  vehicleId: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
}

export interface Driver {
  userId: string;
  status: DriverStatus;
  statusReason: string | null;
  reviewNote: string | null;
  fullName: string;
  licenseNumber: string;
  cityId: string;
  submittedAt: string | null;
  activatedAt: string | null;
  createdAt: string;
}

export interface Vehicle {
  id: string;
  plateNumber: string;
  ownerType: "INDIVIDUAL" | "ORGANIZATION";
  ownerUserId: string | null;
  ownerOrgId: string | null;
  vehicleType: string;
  make: string;
  model: string;
  year: number;
  color: string;
  seats: number;
  status: VehicleStatus;
  statusReason: string | null;
  reviewNote: string | null;
  cityId: string;
  submittedAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

export interface Authorization {
  driverUserId: string;
  status: "ACTIVE" | "REVOKED";
  validUntil: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export type VehicleDetail = Vehicle & Checklist & { authorizations: Authorization[]; session: Session | null };
export type DriverDetail = Driver & Checklist & {
  vehicles: Vehicle[];
  fleetVehicles: (Vehicle & { authorization: { status: string; validUntil: string | null } })[];
  session: Session | null;
};

export interface ReviewQueue {
  drivers: (Driver & { pendingDocuments: number })[];
  vehicles: (Vehicle & { pendingDocuments: number })[];
  organizations: { orgId: string; pendingDocuments: number; oldest: string | null }[];
  expiringSoon: number;
}

export interface FleetOverview {
  vehicles: VehicleDetail[];
  drivers: { userId: string; driver: { status: DriverStatus; statusReason: string | null; fullName: string; activatedAt: string | null } | null; session: Session | null }[];
}

// ── words ─────────────────────────────────────────────────────────────────────

export const KIND_LABEL: Record<string, string> = {
  LICENSE: "Driving licence", NATIONAL_ID: "National ID", PHOTO: "Photo of the driver", REGISTRATION: "Registration (libre)",
  INSURANCE: "Insurance", INSPECTION: "Annual inspection", BUSINESS_LICENSE: "Business licence", TIN: "TIN certificate",
};

/** Documents with an expiry date (fleet-service requires it for these). */
export const EXPIRING_KINDS = ["LICENSE", "INSURANCE", "INSPECTION"];

export const KIND_HINT: Record<string, string> = {
  LICENSE: "Front and back, the category readable", NATIONAL_ID: "Fayda or kebele ID", PHOTO: "A clear face photo",
  REGISTRATION: "Must name the owner: the driver, or the company's legal name", INSURANCE: "Third-party at least",
  INSPECTION: "This year's", BUSINESS_LICENSE: "Trade licence for transport", TIN: "Matches the TIN on the account",
};

type Tone = "amber" | "blue" | "green" | "red" | "grey";
const TONE: Record<string, Tone> = {
  APPLIED: "grey", DRAFT: "grey", PENDING_REVIEW: "amber", PENDING: "amber", ACTIVE: "green", VERIFIED: "green", APPROVED: "green",
  REJECTED: "red", SUSPENDED: "red", EXPIRED: "red", RETIRED: "grey", SUPERSEDED: "grey",
};
export const statusTone = (s: string): Tone => TONE[s] ?? "grey";

const WORD: Record<string, string> = {
  APPLIED: "applying", DRAFT: "draft", PENDING_REVIEW: "waiting for review", PENDING: "to review", ACTIVE: "active", VERIFIED: "verified",
  APPROVED: "approved", REJECTED: "rejected", SUSPENDED: "suspended", EXPIRED: "expired", RETIRED: "retired", SUPERSEDED: "replaced",
};
export const statusWord = (s: string) => WORD[s] ?? s.toLowerCase().replace(/_/g, " ");

export const VEHICLE_TYPES = [
  { id: "economy", name: "Economy", seats: [3, 4] },
  { id: "comfort", name: "Comfort", seats: [3, 4] },
  { id: "minivan", name: "Minivan", seats: [5, 8] },
] as const;

export const vehicleName = (v: Pick<Vehicle, "make" | "model" | "color">) => `${v.color} ${v.make} ${v.model}`;

// ── uploads ───────────────────────────────────────────────────────────────────

export const UPLOAD_TYPES = ["image/jpeg", "image/png", "application/pdf"];
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Ticket → straight PUT to storage (S3, or fleet-service locally) → confirm. */
export async function uploadDocument(surface: Surface, input: { subjectType: SubjectType; subjectId: string; kind: string; file: File; expiresAt?: string }) {
  const { file } = input;
  if (!UPLOAD_TYPES.includes(file.type)) throw new ApiError(400, "file_type", "Use a photo (JPEG or PNG) or a PDF");
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiError(400, "file_too_large", "Files must be under 10 MB");
  const t = await api<{ uploadUrl: string; headers: Record<string, string>; ticket: string }>(surface, "/api/fleet/documents/upload-url", {
    body: { subjectType: input.subjectType, subjectId: input.subjectId, kind: input.kind, contentType: file.type, sizeBytes: file.size, sha256: await sha256Hex(file) },
  });
  try {
    // no credentials: the signed URL is the permission
    await axios.put(t.uploadUrl, file, { headers: t.headers });
  } catch {
    throw new ApiError(0, "upload_failed", "The file didn't upload. Check your connection and try again.");
  }
  return api<FleetDocument>(surface, "/api/fleet/documents", { body: { ticket: t.ticket, ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) } });
}
