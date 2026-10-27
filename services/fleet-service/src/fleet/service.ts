// Drivers, vehicles, documents, fleet authorisations and driving sessions (Role.md §6, §13.1–13.2;
// workflows 02, 03 and 04). Every method takes the caller's Principal and authorizes with the
// shared matrix before touching data.

import { v7 as uuidv7 } from "uuid";
import { authorize, can, citiesWith, type Permission, type Principal } from "@ride-app/shared-authz";
import { CITIES } from "@ride-app/shared-location";
import type { SettingsReader } from "@ride-app/shared-settings";
import type { Logger } from "@ride-app/shared-utils";
import { Prisma } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import type { AuthClient, BalanceClient } from "../lib/clients.js";
import type { PiiCrypto, Signer } from "../lib/crypto.js";
import { AppError, badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { EXTENSION, MAX_UPLOAD_BYTES, type ObjectStore, type UploadType, UPLOAD_URL_SECONDS, VIEW_URL_SECONDS } from "../lib/storage.js";
import { audit, writeOutbox, type FleetEvent } from "../outbox/outbox.js";
import {
  currentDocuments, dayOf, DENIAL_MESSAGE, DOCUMENT_KINDS, driveDenial, EXPIRING_KINDS, isExpired,
  missingForApproval, missingForSubmit, normalizePlate, VEHICLE_TYPES, type DocumentKind, type SubjectType,
} from "./rules.js";

type Tx = Prisma.TransactionClient;
type DriverRow = Prisma.DriverProfileGetPayload<object>;
type VehicleRow = Prisma.VehicleGetPayload<object>;
type DocumentRow = Prisma.DocumentGetPayload<object>;
type SessionRow = Prisma.DrivingSessionGetPayload<object>;
type TransferRow = Prisma.VehicleTransferGetPayload<object>;

export type OwnerType = "INDIVIDUAL" | "ORGANIZATION";
/** Transfers waiting this long without a decision expire (Role.md §11). */
export const TRANSFER_TTL_MS = 7 * 86_400_000;
const OPEN_TRANSFER = ["REQUESTED", "PENDING"];

export type EndReason = "DRIVER" | "CONNECTION_LOST" | "SUSPENDED" | "VEHICLE_UNAVAILABLE" | "FLEET_SUSPENDED" | "BALANCE_BLOCKED";

export interface FleetDeps {
  db: Db;
  pii: PiiCrypto;
  store: ObjectStore;
  tickets: Signer;
  auth: AuthClient;
  /** payment-service: a blocked balance can't go online (workflow 04 step 4) */
  balances?: BalanceClient;
  logger: Logger;
  now?: () => Date;
  expiryWarningDays?: number;
  settings?: SettingsReader;
}

interface UploadTicket {
  key: string;
  subjectType: SubjectType;
  subjectId: string;
  kind: DocumentKind;
  contentType: UploadType;
  sizeBytes: number;
  sha256: string;
  cityId: string;
  userId: string;
}

const self = (p: Principal) => ({ ownerUserIds: [p.userId] });
const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const parseDay = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw badRequest("invalid date (YYYY-MM-DD)");
  return d;
};
const isUnique = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/** Fleet organisations whose vehicles this person may drive (token claims, Role.md §4 attributes). */
const fleetOrgIdsOf = (p: Principal) =>
  p.roles.filter((a) => (a.role === "FLEET_DRIVER" || a.role === "FLEET_OWNER") && a.scope === "ORG" && a.orgId).map((a) => a.orgId!);

// ── views ─────────────────────────────────────────────────────────────────────

export function documentView(d: DocumentRow, now: Date, warningDays = 30) {
  const soon = new Date(dayOf(now).getTime() + warningDays * 86_400_000);
  return {
    id: d.id, subjectType: d.subjectType, subjectId: d.subjectId, kind: d.kind, status: d.status,
    contentType: d.contentType, sizeBytes: d.sizeBytes, expiresAt: isoDay(d.expiresAt),
    expiringSoon: d.status === "APPROVED" && !!d.expiresAt && d.expiresAt <= soon,
    rejectReason: d.rejectReason, uploadedBy: d.uploadedBy, reviewedBy: d.reviewedBy,
    reviewedAt: d.reviewedAt?.toISOString() ?? null, createdAt: d.createdAt.toISOString(),
  };
}

function checklist(subject: SubjectType, docs: DocumentRow[], now: Date, warningDays: number) {
  const current = currentDocuments(docs);
  return {
    documents: DOCUMENT_KINDS[subject].map((kind) => {
      const d = current.get(kind);
      return { kind, required: true, expires: EXPIRING_KINDS.includes(kind), document: d ? documentView(d, now, warningDays) : null };
    }),
    missingForSubmit: missingForSubmit(subject, docs, now),
    missingForApproval: missingForApproval(subject, docs, now),
  };
}

export function sessionView(s: SessionRow) {
  return { id: s.id, driverUserId: s.driverUserId, vehicleId: s.vehicleId, startedAt: s.startedAt.toISOString(), endedAt: s.endedAt?.toISOString() ?? null, endReason: s.endReason };
}

export function vehicleView(v: VehicleRow) {
  return {
    id: v.id, plateNumber: v.plateNumber, ownerType: v.ownerType, ownerUserId: v.ownerUserId, ownerOrgId: v.ownerOrgId,
    vehicleType: v.vehicleType, make: v.make, model: v.model, year: v.year, color: v.color, seats: v.seats,
    status: v.status, statusReason: v.statusReason, reviewNote: v.reviewNote, cityId: v.cityId,
    submittedAt: v.submittedAt?.toISOString() ?? null, verifiedAt: v.verifiedAt?.toISOString() ?? null, createdAt: v.createdAt.toISOString(),
  };
}

export function createFleetService(deps: FleetDeps) {
  const { db, pii, store, tickets, auth, logger } = deps;
  const now = deps.now ?? (() => new Date());
  // live settings (admin dashboard), with this service's env value as the default
  const warningDays = (): number => deps.settings?.get<number>("documents.expiryWarningDays") ?? deps.expiryWarningDays ?? 30;
  const reminderDays = (): number[] => deps.settings?.get<number[]>("documents.reminderDays") ?? [30, 7, 1];

  const driverView = (d: DriverRow, opts: { fullLicence: boolean }) => ({
    userId: d.userId, status: d.status, statusReason: d.statusReason, reviewNote: d.reviewNote, fullName: d.fullName,
    licenseNumber: opts.fullLicence ? pii.decrypt(d.licenseNumber) : `•••• ${d.licenseLast4}`,
    cityId: d.cityId, submittedAt: d.submittedAt?.toISOString() ?? null, activatedAt: d.activatedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  });

  const docsOf = (tx: Tx | Db, subjectType: SubjectType, subjectId: string) =>
    tx.document.findMany({ where: { subjectType, subjectId }, orderBy: { createdAt: "desc" } });

  const openSessionOfVehicle = (tx: Tx | Db, vehicleId: string) => tx.drivingSession.findFirst({ where: { vehicleId, endedAt: null } });
  const openSessionOfDriver = (tx: Tx | Db, driverUserId: string) => tx.drivingSession.findFirst({ where: { driverUserId, endedAt: null } });

  async function endSessionTx(tx: Tx, s: SessionRow, reason: EndReason) {
    await tx.drivingSession.update({ where: { id: s.id }, data: { endedAt: now(), endReason: reason } });
    await writeOutbox(tx, { topic: "driver.offline", key: s.driverUserId, payload: { driverId: s.driverUserId, reason } });
  }

  // ── access ──────────────────────────────────────────────────────────────────

  /** Who may act on a vehicle: its owner-driver, its fleet (permission @ ORG), or staff (permission @ CITY). */
  function vehicleAccess(p: Principal, v: VehicleRow, ownerPermission: Permission, staffPermission?: Permission) {
    if (v.ownerType === "INDIVIDUAL" && v.ownerUserId === p.userId) return "owner" as const;
    if (v.ownerType === "ORGANIZATION" && can(p, ownerPermission, { orgId: v.ownerOrgId })) return "fleet" as const;
    if (staffPermission && can(p, staffPermission, { cityId: v.cityId })) return "staff" as const;
    return null;
  }

  async function loadVehicle(id: string) {
    const v = await db.vehicle.findUnique({ where: { id } });
    if (!v) throw notFound("vehicle");
    return v;
  }

  async function loadDriver(tx: Tx | Db, userId: string) {
    const d = await tx.driverProfile.findUnique({ where: { userId } });
    if (!d) throw notFound("driver");
    return d;
  }

  async function verifiedFleet(orgId: string) {
    const org = await auth.organization(orgId);
    if (!org || org.kind !== "FLEET") throw badRequest("not a fleet company", "not_a_fleet");
    return org;
  }

  // ── driver application (workflow 02, part A) ───────────────────────────────

  async function apply(p: Principal, input: { fullName: string; licenseNumber: string; cityId: string }) {
    authorize(p, "driver:apply", self(p));
    if (!CITIES[input.cityId]) throw badRequest("Anbessa doesn't operate in this city yet", "unknown_city");
    const licence = input.licenseNumber.replace(/[\s-]/g, "").toUpperCase();
    if (!/^[A-Z0-9]{5,20}$/.test(licence)) throw badRequest("licence number: 5–20 letters and digits", "invalid_licence");
    const hash = pii.blindIndex(licence);
    try {
      const d = await db.$transaction(async (tx) => {
        if (await tx.driverProfile.findUnique({ where: { userId: p.userId } })) throw conflict("you have already applied", "already_applied");
        if (await tx.driverProfile.findUnique({ where: { licenseHash: hash } })) throw conflict("this licence is already registered; contact support", "licence_registered");
        const row = await tx.driverProfile.create({
          data: { userId: p.userId, fullName: input.fullName.trim(), licenseNumber: pii.encrypt(licence), licenseHash: hash, licenseLast4: licence.slice(-4), cityId: input.cityId },
        });
        await writeOutbox(tx, { topic: "driver.applied", key: p.userId, payload: { driverId: p.userId, cityId: input.cityId } });
        return row;
      });
      return driverView(d, { fullLicence: true });
    } catch (err) {
      if (isUnique(err)) throw conflict("this licence is already registered; contact support", "licence_registered");
      throw err;
    }
  }

  /** Everything the driver app needs: application, documents, own vehicles, fleet vehicles, session. */
  async function me(p: Principal) {
    const d = await db.driverProfile.findUnique({ where: { userId: p.userId } });
    const [docs, owned, auths, session] = await Promise.all([
      docsOf(db, "DRIVER", p.userId),
      db.vehicle.findMany({ where: { ownerType: "INDIVIDUAL", ownerUserId: p.userId, status: { not: "RETIRED" } }, orderBy: { createdAt: "asc" } }),
      db.vehicleAuthorization.findMany({ where: { driverUserId: p.userId, status: "ACTIVE" }, include: { vehicle: true } }),
      openSessionOfDriver(db, p.userId),
    ]);
    return {
      driver: d ? { ...driverView(d, { fullLicence: true }), ...checklist("DRIVER", docs, now(), warningDays()) } : null,
      vehicles: owned.map(vehicleView),
      fleetVehicles: auths.map((a) => ({ ...vehicleView(a.vehicle), authorization: { validUntil: a.validUntil?.toISOString() ?? null } })),
      session: session ? sessionView(session) : null,
    };
  }

  async function submitDriver(p: Principal) {
    authorize(p, "driver:apply", self(p));
    return db.$transaction(async (tx) => {
      const d = await loadDriver(tx, p.userId);
      const renewing = d.status === "SUSPENDED" && d.statusReason === "DOCUMENT_EXPIRED";
      if (d.status !== "APPLIED" && !renewing) throw conflict(`can't submit an application that is ${d.status.toLowerCase()}`, "invalid_state");
      const missing = missingForSubmit("DRIVER", await docsOf(tx, "DRIVER", p.userId), now());
      if (missing.length) throw new AppError(400, `upload these first: ${missing.join(", ")}`, "documents_missing");
      const row = await tx.driverProfile.update({ where: { userId: p.userId }, data: { status: "PENDING_REVIEW", statusReason: null, submittedAt: now() } });
      await writeOutbox(tx, { topic: "driver.submitted", key: p.userId, payload: { driverId: p.userId, cityId: d.cityId } });
      return driverView(row, { fullLicence: true });
    });
  }

  // ── vehicles ────────────────────────────────────────────────────────────────

  async function registerVehicle(p: Principal, input: {
    ownerType: "INDIVIDUAL" | "ORGANIZATION"; ownerOrgId?: string; plateNumber: string; vehicleType: string;
    make: string; model: string; year: number; color: string; seats: number;
  }) {
    const type = VEHICLE_TYPES[input.vehicleType];
    if (!type) throw badRequest(`vehicle type must be one of ${Object.keys(VEHICLE_TYPES).join(", ")}`, "invalid_vehicle_type");
    if (input.seats < type.seats[0] || input.seats > type.seats[1]) throw badRequest(`${input.vehicleType}: ${type.seats[0]}–${type.seats[1]} seats`, "invalid_seats");
    const thisYear = now().getUTCFullYear();
    if (input.year < 1990 || input.year > thisYear + 1) throw badRequest("invalid model year", "invalid_year");

    let cityId: string;
    let owner: { ownerUserId?: string; ownerOrgId?: string };
    if (input.ownerType === "INDIVIDUAL") {
      // an applicant registers their own car as part of applying (workflow 02 step 4)
      if (!can(p, "vehicle:register", self(p)) && !can(p, "driver:apply", self(p))) authorize(p, "vehicle:register", self(p));
      const d = await db.driverProfile.findUnique({ where: { userId: p.userId } });
      if (!d) throw badRequest("apply as a driver before adding your car", "not_a_driver");
      cityId = d.cityId;
      owner = { ownerUserId: p.userId };
    } else {
      if (!input.ownerOrgId) throw badRequest("ownerOrgId is required for a company vehicle");
      authorize(p, "vehicle:register", { orgId: input.ownerOrgId });
      const org = await verifiedFleet(input.ownerOrgId);
      if (org.status !== "VERIFIED") throw conflict("the company must be verified before it adds vehicles", "org_not_verified");
      cityId = org.cityId;
      owner = { ownerOrgId: org.id };
    }
    try {
      const v = await db.vehicle.create({
        data: {
          plateNumber: normalizePlate(input.plateNumber), ownerType: input.ownerType, ...owner, vehicleType: input.vehicleType,
          make: input.make.trim(), model: input.model.trim(), year: input.year, color: input.color.trim(), seats: input.seats, cityId,
        },
      });
      return vehicleView(v);
    } catch (err) {
      if (isUnique(err)) throw conflict("this plate is already registered; contact support", "plate_registered");
      throw err;
    }
  }

  async function vehicleDetail(v: VehicleRow) {
    const [docs, auths, session] = await Promise.all([
      docsOf(db, "VEHICLE", v.id),
      db.vehicleAuthorization.findMany({ where: { vehicleId: v.id }, orderBy: { createdAt: "asc" } }),
      openSessionOfVehicle(db, v.id),
    ]);
    return {
      ...vehicleView(v),
      ...checklist("VEHICLE", docs, now(), warningDays()),
      authorizations: auths.map((a) => ({
        driverUserId: a.driverUserId, status: a.status, validUntil: a.validUntil?.toISOString() ?? null,
        grantedBy: a.grantedBy, createdAt: a.createdAt.toISOString(), revokedAt: a.revokedAt?.toISOString() ?? null,
      })),
      session: session ? sessionView(session) : null,
    };
  }

  async function getVehicle(p: Principal, id: string) {
    const v = await loadVehicle(id);
    if (!vehicleAccess(p, v, "vehicle:read", "vehicle:read")) authorize(p, "vehicle:read", { cityId: v.cityId });
    return vehicleDetail(v);
  }

  async function listVehicles(p: Principal, q: { ownerOrgId?: string; cityId?: string; status?: string; limit: number }) {
    let where: Prisma.VehicleWhereInput;
    if (q.ownerOrgId && q.cityId && !can(p, "vehicle:read", { orgId: q.ownerOrgId })) {
      // city staff (onboarding officers) looking at a company: their city grant covers the company's
      // cars in that city
      authorize(p, "vehicle:read", { cityId: q.cityId });
      where = { ownerType: "ORGANIZATION", ownerOrgId: q.ownerOrgId, cityId: q.cityId };
    } else if (q.ownerOrgId) {
      authorize(p, "vehicle:read", { orgId: q.ownerOrgId });
      where = { ownerType: "ORGANIZATION", ownerOrgId: q.ownerOrgId };
    } else if (q.cityId) {
      authorize(p, "vehicle:read", { cityId: q.cityId });
      where = { cityId: q.cityId };
    } else {
      where = { ownerType: "INDIVIDUAL", ownerUserId: p.userId };
    }
    const rows = await db.vehicle.findMany({ where: { ...where, ...(q.status ? { status: q.status } : {}) }, orderBy: { createdAt: "desc" }, take: q.limit });
    return rows.map(vehicleView);
  }

  async function submitVehicle(p: Principal, id: string) {
    return db.$transaction(async (tx) => {
      const v = await tx.vehicle.findUnique({ where: { id } });
      if (!v) throw notFound("vehicle");
      if (!vehicleAccess(p, v, "vehicle:register")) throw forbidden("not your vehicle");
      const renewing = v.status === "SUSPENDED" && v.statusReason === "DOCUMENT_EXPIRED";
      if (!["DRAFT", "REJECTED"].includes(v.status) && !renewing) throw conflict(`can't submit a vehicle that is ${v.status.toLowerCase()}`, "invalid_state");
      const missing = missingForSubmit("VEHICLE", await docsOf(tx, "VEHICLE", id), now());
      if (missing.length) throw new AppError(400, `upload these first: ${missing.join(", ")}`, "documents_missing");
      const row = await tx.vehicle.update({ where: { id }, data: { status: "PENDING_REVIEW", statusReason: null, submittedAt: now(), version: { increment: 1 } } });
      await writeOutbox(tx, { topic: "vehicle.submitted", key: id, payload: { vehicleId: id, cityId: v.cityId, ownerType: v.ownerType } });
      return vehicleView(row);
    });
  }

  async function retireVehicle(p: Principal, id: string) {
    return db.$transaction(async (tx) => {
      const v = await tx.vehicle.findUnique({ where: { id } });
      if (!v) throw notFound("vehicle");
      if (!vehicleAccess(p, v, "vehicle:retire")) throw forbidden("not your vehicle");
      if (v.status === "RETIRED") return vehicleView(v);
      const s = await openSessionOfVehicle(tx, id);
      if (s) await endSessionTx(tx, s, "VEHICLE_UNAVAILABLE");
      await tx.vehicleAuthorization.updateMany({ where: { vehicleId: id, status: "ACTIVE" }, data: { status: "REVOKED", revokedAt: now() } });
      const row = await tx.vehicle.update({ where: { id }, data: { status: "RETIRED", statusReason: null, version: { increment: 1 } } });
      await writeOutbox(tx, { topic: "vehicle.retired", key: id, payload: { vehicleId: id, cityId: v.cityId, reason: "owner removed it", byUserId: p.userId } });
      return vehicleView(row);
    });
  }

  async function approveVehicle(p: Principal, id: string) {
    const v = await loadVehicle(id);
    authorize(p, "vehicle:verify", { cityId: v.cityId });
    if (v.ownerType === "ORGANIZATION") {
      const org = await verifiedFleet(v.ownerOrgId!);
      if (org.status !== "VERIFIED") throw conflict("verify the company first", "org_not_verified");
    }
    return db.$transaction(async (tx) => {
      const cur = await tx.vehicle.findUniqueOrThrow({ where: { id } });
      if (cur.status !== "PENDING_REVIEW") throw conflict(`the vehicle is ${cur.status.toLowerCase()}, not waiting for review`, "invalid_state");
      const missing = missingForApproval("VEHICLE", await docsOf(tx, "VEHICLE", id), now());
      if (missing.length) throw conflict(`approve these documents first: ${missing.join(", ")}`, "documents_not_approved");
      const row = await tx.vehicle.update({ where: { id }, data: { status: "VERIFIED", reviewNote: null, verifiedAt: now(), version: { increment: 1 } } });
      await writeOutbox(tx,
        { topic: "vehicle.verified", key: id, payload: { vehicleId: id, cityId: v.cityId, vehicleType: v.vehicleType, ownerType: v.ownerType, ownerId: (v.ownerUserId ?? v.ownerOrgId)!, byUserId: p.userId } },
        audit({ actorId: p.userId, action: "vehicle:verify", resource: { type: "vehicle", id }, outcome: "EXECUTED" }),
      );
      return vehicleView(row);
    });
  }

  async function rejectVehicle(p: Principal, id: string, reason: string) {
    const v = await loadVehicle(id);
    authorize(p, "vehicle:verify", { cityId: v.cityId });
    return db.$transaction(async (tx) => {
      const cur = await tx.vehicle.findUniqueOrThrow({ where: { id } });
      if (cur.status !== "PENDING_REVIEW") throw conflict(`the vehicle is ${cur.status.toLowerCase()}, not waiting for review`, "invalid_state");
      const row = await tx.vehicle.update({ where: { id }, data: { status: "REJECTED", reviewNote: reason, version: { increment: 1 } } });
      await writeOutbox(tx,
        { topic: "vehicle.rejected", key: id, payload: { vehicleId: id, cityId: v.cityId, reason, byUserId: p.userId } },
        audit({ actorId: p.userId, action: "vehicle:reject", resource: { type: "vehicle", id }, outcome: "EXECUTED", reason }),
      );
      return vehicleView(row);
    });
  }

  // ── fleet authorisations (workflow 03, part C) ─────────────────────────────

  async function authorizeDriver(p: Principal, vehicleId: string, input: { driverUserId: string; validUntil?: Date }) {
    const v = await loadVehicle(vehicleId);
    if (v.ownerType !== "ORGANIZATION") throw badRequest("only company vehicles are shared with drivers", "not_a_fleet_vehicle");
    authorize(p, "vehicle:authorize_driver", { orgId: v.ownerOrgId });
    if (v.status === "RETIRED") throw conflict("this vehicle is retired", "invalid_state");
    const m = await auth.membership(v.ownerOrgId!, input.driverUserId);
    if (!m || !m.roles.includes("fleet_driver")) throw badRequest("invite them as a driver of this fleet first", "not_a_fleet_driver");
    if (input.validUntil && input.validUntil <= now()) throw badRequest("validUntil must be in the future");
    return db.$transaction(async (tx) => {
      const a = await tx.vehicleAuthorization.upsert({
        where: { vehicleId_driverUserId: { vehicleId, driverUserId: input.driverUserId } },
        update: { status: "ACTIVE", grantedBy: p.userId, validUntil: input.validUntil ?? null, revokedAt: null },
        create: { vehicleId, driverUserId: input.driverUserId, grantedBy: p.userId, validUntil: input.validUntil ?? null },
      });
      await writeOutbox(tx, { topic: "vehicle.driver_authorized", key: vehicleId, payload: { vehicleId, driverId: input.driverUserId, orgId: v.ownerOrgId!, byUserId: p.userId } });
      return { vehicleId, driverUserId: a.driverUserId, status: a.status, validUntil: a.validUntil?.toISOString() ?? null };
    });
  }

  async function revokeDriver(p: Principal, vehicleId: string, driverUserId: string) {
    const v = await loadVehicle(vehicleId);
    if (v.ownerType !== "ORGANIZATION") throw badRequest("not a company vehicle", "not_a_fleet_vehicle");
    authorize(p, "vehicle:authorize_driver", { orgId: v.ownerOrgId });
    return db.$transaction(async (tx) => {
      const a = await tx.vehicleAuthorization.findUnique({ where: { vehicleId_driverUserId: { vehicleId, driverUserId } } });
      if (!a || a.status !== "ACTIVE") return { vehicleId, driverUserId, status: "REVOKED" };
      await tx.vehicleAuthorization.update({ where: { vehicleId_driverUserId: { vehicleId, driverUserId } }, data: { status: "REVOKED", revokedAt: now() } });
      const s = await tx.drivingSession.findFirst({ where: { vehicleId, driverUserId, endedAt: null } });
      if (s) await endSessionTx(tx, s, "VEHICLE_UNAVAILABLE");
      await writeOutbox(tx, { topic: "vehicle.driver_unauthorized", key: vehicleId, payload: { vehicleId, driverId: driverUserId, orgId: v.ownerOrgId!, byUserId: p.userId } });
      return { vehicleId, driverUserId, status: "REVOKED" };
    });
  }

  /** Fleet portal: the fleet's vehicles (with documents, drivers, who's driving) and its drivers' onboarding. */
  async function fleetOverview(p: Principal, orgId: string, memberIds: string[]) {
    authorize(p, "vehicle:read", { orgId });
    const vehicles = await db.vehicle.findMany({ where: { ownerType: "ORGANIZATION", ownerOrgId: orgId }, orderBy: { createdAt: "asc" } });
    const details = await Promise.all(vehicles.map(vehicleDetail));
    // only people auth-service confirms as members of this fleet
    const checked = await Promise.all(memberIds.slice(0, 100).map(async (id) => ((await auth.membership(orgId, id)) ? id : null)));
    const ids = checked.filter((x): x is string => !!x);
    const profiles = can(p, "driver:read", { orgId }) && ids.length ? await db.driverProfile.findMany({ where: { userId: { in: ids } } }) : [];
    const sessions = ids.length ? await db.drivingSession.findMany({ where: { driverUserId: { in: ids }, endedAt: null } }) : [];
    return {
      vehicles: details,
      drivers: ids.map((id) => {
        const d = profiles.find((x) => x.userId === id);
        const s = sessions.find((x) => x.driverUserId === id);
        return {
          userId: id,
          driver: d ? { status: d.status, statusReason: d.statusReason, fullName: d.fullName, activatedAt: d.activatedAt?.toISOString() ?? null } : null,
          session: s ? sessionView(s) : null,
        };
      }),
    };
  }

  // ── documents ───────────────────────────────────────────────────────────────

  /** Who may upload for a subject, and the subject's city (the reviewer's scope). */
  async function uploadScope(p: Principal, subjectType: SubjectType, subjectId: string): Promise<string> {
    if (subjectType === "DRIVER") {
      if (subjectId !== p.userId) throw forbidden("drivers upload their own documents");
      if (!can(p, "document:upload", self(p)) && !can(p, "driver:apply", self(p))) authorize(p, "document:upload", self(p));
      return (await loadDriver(db, p.userId)).cityId;
    }
    if (subjectType === "VEHICLE") {
      const v = await loadVehicle(subjectId);
      const access = vehicleAccess(p, v, "document:upload");
      if (!access) throw forbidden("not your vehicle");
      if (access === "owner" && !can(p, "document:upload", self(p)) && !can(p, "driver:apply", self(p))) authorize(p, "document:upload", self(p));
      if (v.status === "RETIRED") throw conflict("this vehicle is retired", "invalid_state");
      return v.cityId;
    }
    authorize(p, "document:upload", { orgId: subjectId });
    const org = await auth.organization(subjectId);
    if (!org || (org.kind !== "FLEET" && org.kind !== "CORPORATE")) throw notFound("organization");
    return org.cityId;
  }

  async function uploadTicket(p: Principal, input: { subjectType: SubjectType; subjectId: string; kind: DocumentKind; contentType: UploadType; sizeBytes: number; sha256: string }) {
    if (!DOCUMENT_KINDS[input.subjectType].includes(input.kind)) throw badRequest(`${input.kind} isn't a ${input.subjectType.toLowerCase()} document`, "invalid_kind");
    if (input.sizeBytes < 1 || input.sizeBytes > MAX_UPLOAD_BYTES) throw badRequest("files must be under 10 MB", "file_too_large");
    const cityId = await uploadScope(p, input.subjectType, input.subjectId);
    const key = `${input.subjectType.toLowerCase()}/${input.subjectId}/${input.kind.toLowerCase()}/${uuidv7()}.${EXTENSION[input.contentType]}`;
    const put = await store.presignPut(key, input.contentType, input.sizeBytes);
    const ticket = tickets.sign<UploadTicket>({ key, ...input, sha256: input.sha256.toLowerCase(), cityId, userId: p.userId }, UPLOAD_URL_SECONDS * 3);
    return { uploadUrl: put.url, headers: put.headers, ticket, expiresIn: UPLOAD_URL_SECONDS };
  }

  async function confirmUpload(p: Principal, input: { ticket: string; expiresAt?: string }) {
    const t = tickets.verify<UploadTicket>(input.ticket);
    if (!t || t.userId !== p.userId) throw badRequest("the upload ticket is invalid or expired; start the upload again", "invalid_ticket");
    const expiresAt = input.expiresAt ? parseDay(input.expiresAt) : null;
    if (EXPIRING_KINDS.includes(t.kind) && !expiresAt) throw badRequest(`${t.kind} needs its expiry date`, "expiry_required");
    if (expiresAt && expiresAt < dayOf(now())) throw badRequest("this document has already expired", "document_expired");
    const stored = await store.stat(t.key);
    if (!stored) throw badRequest("the file hasn't arrived; upload it, then confirm", "upload_missing");
    if (stored.size !== t.sizeBytes) throw badRequest("the uploaded file isn't the one announced (size differs)", "upload_mismatch");
    if (stored.sha256 && stored.sha256.toString("hex") !== t.sha256) throw badRequest("the uploaded file isn't the one announced (hash differs)", "upload_mismatch");
    const doc = await db.$transaction(async (tx) => {
      const existing = await tx.document.findFirst({ where: { objectKey: t.key } });
      if (existing) return existing; // confirmed twice
      await tx.document.updateMany({ where: { subjectType: t.subjectType, subjectId: t.subjectId, kind: t.kind, status: { not: "SUPERSEDED" } }, data: { status: "SUPERSEDED" } });
      return tx.document.create({
        data: {
          subjectType: t.subjectType, subjectId: t.subjectId, kind: t.kind, objectKey: t.key, contentType: t.contentType,
          sizeBytes: t.sizeBytes, sha256: new Uint8Array(Buffer.from(t.sha256, "hex")), expiresAt, cityId: t.cityId, uploadedBy: p.userId,
        },
      });
    });
    return documentView(doc, now(), warningDays());
  }

  /** May this person see the subject's documents? "staff" views are audited. */
  async function readAccess(p: Principal, d: Pick<DocumentRow, "subjectType" | "subjectId" | "cityId">): Promise<"owner" | "staff"> {
    if (d.subjectType === "DRIVER" && d.subjectId === p.userId) return "owner";
    if (d.subjectType === "VEHICLE") {
      const v = await db.vehicle.findUnique({ where: { id: d.subjectId } });
      if (v && vehicleAccess(p, v, "vehicle:read")) return "owner";
    }
    if (d.subjectType === "ORGANIZATION" && can(p, "document:upload", { orgId: d.subjectId })) return "owner";
    authorize(p, "document:read", { cityId: d.cityId });
    return "staff";
  }

  async function documentUrl(p: Principal, id: string) {
    const d = await db.document.findUnique({ where: { id } });
    if (!d) throw notFound("document");
    if ((await readAccess(p, d)) === "staff") {
      // every staff view of personal documents is audited (workflow 02 step 7)
      await db.$transaction((tx) => writeOutbox(tx, audit({ actorId: p.userId, action: "document:view", resource: { type: "document", id }, outcome: "ALLOWED" })));
    }
    return { url: await store.presignGet(d.objectKey), contentType: d.contentType, expiresIn: VIEW_URL_SECONDS };
  }

  async function subjectDocuments(p: Principal, subjectType: SubjectType, subjectId: string) {
    let cityId: string | undefined;
    if (subjectType === "ORGANIZATION") {
      if (!can(p, "document:upload", { orgId: subjectId })) {
        const org = await auth.organization(subjectId);
        if (!org) throw notFound("organization");
        cityId = org.cityId;
      }
    }
    const docs = await docsOf(db, subjectType, subjectId);
    await readAccess(p, { subjectType, subjectId, cityId: cityId ?? docs[0]?.cityId ?? "" });
    return { ...checklist(subjectType, docs, now(), warningDays()), history: docs.map((d) => documentView(d, now(), warningDays())) };
  }

  async function reviewDocument(p: Principal, id: string, input: { decision: "APPROVE" | "REJECT"; reason?: string; expiresAt?: string }) {
    const d = await db.document.findUnique({ where: { id } });
    if (!d) throw notFound("document");
    authorize(p, "document:review", { cityId: d.cityId });
    if (d.status !== "PENDING") throw conflict(`this document is ${d.status.toLowerCase()}`, "invalid_state");
    let data: Prisma.DocumentUpdateInput;
    if (input.decision === "APPROVE") {
      const expiresAt = input.expiresAt ? parseDay(input.expiresAt) : d.expiresAt;
      if (EXPIRING_KINDS.includes(d.kind as DocumentKind) && !expiresAt) throw badRequest("set the expiry date shown on the document", "expiry_required");
      if (expiresAt && expiresAt < dayOf(now())) throw badRequest("this document has expired; reject it instead", "document_expired");
      data = { status: "APPROVED", expiresAt, rejectReason: null };
    } else {
      if (!input.reason || input.reason.trim().length < 3) throw badRequest("say why, so they can fix it", "reason_required");
      data = { status: "REJECTED", rejectReason: input.reason.trim() };
    }
    const row = await db.$transaction(async (tx) => {
      const r = await tx.document.update({ where: { id }, data: { ...data, reviewedBy: p.userId, reviewedAt: now() } });
      await writeOutbox(tx, audit({ actorId: p.userId, action: `document:${input.decision.toLowerCase()}`, resource: { type: "document", id }, outcome: "EXECUTED", reason: input.reason }));
      return r;
    });
    return documentView(row, now(), warningDays());
  }

  // ── review (workflow 02, part B) ───────────────────────────────────────────

  async function queue(p: Principal, cityId: string) {
    if (!can(p, "driver:read", { cityId }) && !can(p, "vehicle:read", { cityId })) authorize(p, "document:review", { cityId });
    const [drivers, vehicles, orgDocs, pendingDocs, expiring] = await Promise.all([
      can(p, "driver:read", { cityId }) ? db.driverProfile.findMany({ where: { cityId, status: "PENDING_REVIEW" }, orderBy: { submittedAt: "asc" }, take: 200 }) : [],
      can(p, "vehicle:read", { cityId }) ? db.vehicle.findMany({ where: { cityId, status: "PENDING_REVIEW" }, orderBy: { submittedAt: "asc" }, take: 200 }) : [],
      db.document.groupBy({ by: ["subjectId"], where: { cityId, subjectType: "ORGANIZATION", status: "PENDING" }, _min: { createdAt: true }, _count: true }),
      db.document.groupBy({ by: ["subjectType", "subjectId"], where: { cityId, status: "PENDING" }, _count: true }),
      db.document.count({ where: { cityId, status: "APPROVED", expiresAt: { lte: new Date(dayOf(now()).getTime() + warningDays() * 86_400_000) } } }),
    ]);
    const pending = (type: string, id: string) => pendingDocs.find((g) => g.subjectType === type && g.subjectId === id)?._count ?? 0;
    return {
      drivers: drivers.map((d) => ({ ...driverView(d, { fullLicence: false }), pendingDocuments: pending("DRIVER", d.userId) })),
      vehicles: vehicles.map((v) => ({ ...vehicleView(v), pendingDocuments: pending("VEHICLE", v.id) })),
      organizations: orgDocs
        .map((g) => ({ orgId: g.subjectId, pendingDocuments: g._count, oldest: g._min.createdAt?.toISOString() ?? null }))
        .sort((a, b) => (a.oldest ?? "").localeCompare(b.oldest ?? "")),
      expiringSoon: expiring,
    };
  }

  async function listDrivers(p: Principal, q: { cityId: string; status?: string; q?: string; limit: number }) {
    authorize(p, "driver:read", { cityId: q.cityId });
    const rows = await db.driverProfile.findMany({
      where: {
        cityId: q.cityId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.q ? { OR: [{ fullName: { contains: q.q, mode: "insensitive" } }, { licenseLast4: q.q.slice(-4).toUpperCase() }] } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: q.limit,
    });
    return rows.map((d) => driverView(d, { fullLicence: false }));
  }

  async function getDriver(p: Principal, userId: string, orgId?: string) {
    const d = await loadDriver(db, userId);
    let full = d.userId === p.userId;
    if (!full) {
      if (orgId) {
        authorize(p, "driver:read", { orgId });
        if (!(await auth.membership(orgId, userId))) throw notFound("driver");
      } else {
        authorize(p, "driver:read", { cityId: d.cityId });
        full = can(p, "user:read_pii", { cityId: d.cityId });
        if (full) await db.$transaction((tx) => writeOutbox(tx, audit({ actorId: p.userId, action: "user:read_pii", resource: { type: "driver", id: userId }, outcome: "ALLOWED", reason: "licence number" })));
      }
    }
    const [docs, owned, auths, session] = await Promise.all([
      docsOf(db, "DRIVER", userId),
      db.vehicle.findMany({ where: { ownerType: "INDIVIDUAL", ownerUserId: userId }, orderBy: { createdAt: "asc" } }),
      db.vehicleAuthorization.findMany({ where: { driverUserId: userId }, include: { vehicle: true } }),
      openSessionOfDriver(db, userId),
    ]);
    return {
      ...driverView(d, { fullLicence: full }),
      ...checklist("DRIVER", docs, now(), warningDays()),
      vehicles: owned.map(vehicleView),
      fleetVehicles: auths.map((a) => ({ ...vehicleView(a.vehicle), authorization: { status: a.status, validUntil: a.validUntil?.toISOString() ?? null } })),
      session: session ? sessionView(session) : null,
    };
  }

  async function approveDriver(p: Principal, userId: string) {
    const d = await loadDriver(db, userId);
    authorize(p, "driver:verify", { cityId: d.cityId });
    authorize(p, "driver:activate", { cityId: d.cityId });
    return db.$transaction(async (tx) => {
      const cur = await loadDriver(tx, userId);
      if (cur.status !== "PENDING_REVIEW") throw conflict(`the application is ${cur.status.toLowerCase()}, not waiting for review`, "invalid_state");
      const missing = missingForApproval("DRIVER", await docsOf(tx, "DRIVER", userId), now());
      if (missing.length) throw conflict(`approve these documents first: ${missing.join(", ")}`, "documents_not_approved");
      const row = await tx.driverProfile.update({ where: { userId }, data: { status: "ACTIVE", statusReason: null, reviewNote: null, activatedAt: cur.activatedAt ?? now() } });
      await writeOutbox(tx,
        { topic: "driver.activated", key: userId, payload: { driverId: userId, cityId: d.cityId, byUserId: p.userId } },
        audit({ actorId: p.userId, action: "driver:activate", resource: { type: "driver", id: userId }, outcome: "EXECUTED" }),
      );
      // inside the transaction: if auth-service can't add the role, nothing changes and the officer retries
      await auth.setDriverRole(userId, true);
      return driverView(row, { fullLicence: false });
    }, { timeout: 15_000 });
  }

  async function requestChanges(p: Principal, userId: string, reason: string) {
    const d = await loadDriver(db, userId);
    authorize(p, "driver:verify", { cityId: d.cityId });
    return db.$transaction(async (tx) => {
      const cur = await loadDriver(tx, userId);
      if (cur.status !== "PENDING_REVIEW") throw conflict(`the application is ${cur.status.toLowerCase()}, not waiting for review`, "invalid_state");
      const row = await tx.driverProfile.update({ where: { userId }, data: { status: "APPLIED", reviewNote: reason } });
      await writeOutbox(tx, { topic: "driver.changes_requested", key: userId, payload: { driverId: userId, cityId: d.cityId, reason, byUserId: p.userId } });
      return driverView(row, { fullLicence: false });
    });
  }

  async function suspendDriver(p: Principal, userId: string, reason: string) {
    const d = await loadDriver(db, userId);
    authorize(p, "driver:suspend", { cityId: d.cityId });
    return db.$transaction(async (tx) => {
      const cur = await loadDriver(tx, userId);
      if (cur.status === "SUSPENDED") return driverView(cur, { fullLicence: false });
      const row = await tx.driverProfile.update({ where: { userId }, data: { status: "SUSPENDED", statusReason: "SAFETY", reviewNote: reason } });
      const s = await openSessionOfDriver(tx, userId);
      if (s) await endSessionTx(tx, s, "SUSPENDED");
      await writeOutbox(tx,
        { topic: "driver.suspended", key: userId, payload: { driverId: userId, cityId: d.cityId, reason, byUserId: p.userId } },
        audit({ actorId: p.userId, action: "driver:suspend", resource: { type: "driver", id: userId }, outcome: "EXECUTED", reason }),
      );
      // the DRIVER role goes too (auth bumps the permission version, so open tokens are refreshed);
      // inside the transaction like approval: if auth-service can't, nothing changes and staff retry
      await auth.setDriverRole(userId, false);
      return driverView(row, { fullLicence: false });
    }, { timeout: 15_000 });
  }

  async function reinstateDriver(p: Principal, userId: string, reason: string) {
    const d = await loadDriver(db, userId);
    authorize(p, "driver:reinstate", { cityId: d.cityId });
    return db.$transaction(async (tx) => {
      const cur = await loadDriver(tx, userId);
      if (cur.status !== "SUSPENDED") throw conflict("the driver isn't suspended", "invalid_state");
      const missing = missingForApproval("DRIVER", await docsOf(tx, "DRIVER", userId), now());
      if (missing.length) throw conflict(`these documents aren't valid: ${missing.join(", ")}. The driver uploads them and resubmits`, "documents_not_approved");
      const row = await tx.driverProfile.update({ where: { userId }, data: { status: "ACTIVE", statusReason: null, reviewNote: null } });
      await writeOutbox(tx,
        { topic: "driver.reinstated", key: userId, payload: { driverId: userId, cityId: d.cityId, byUserId: p.userId } },
        audit({ actorId: p.userId, action: "driver:reinstate", resource: { type: "driver", id: userId }, outcome: "EXECUTED", reason }),
      );
      // ACTIVE means holding the DRIVER role, whatever state the suspension started from
      await auth.setDriverRole(userId, true);
      return driverView(row, { fullLicence: false });
    }, { timeout: 15_000 });
  }

  // ── driving sessions (workflow 04, parts A and D) ──────────────────────────

  async function eligibility(p: Principal, v: VehicleRow, d: DriverRow | null, licenceExpired: boolean) {
    const [busy, a] = await Promise.all([
      db.drivingSession.findFirst({ where: { vehicleId: v.id, endedAt: null, driverUserId: { not: p.userId } } }),
      v.ownerType === "ORGANIZATION" ? db.vehicleAuthorization.findUnique({ where: { vehicleId_driverUserId: { vehicleId: v.id, driverUserId: p.userId } } }) : null,
    ]);
    return driveDenial({
      driver: d, driverDocsExpired: licenceExpired, vehicle: v, vehicleBusy: !!busy,
      fleetOrgIds: fleetOrgIdsOf(p), authorization: a, now: now(),
    });
  }

  async function licenceExpiredFor(userId: string) {
    const lic = currentDocuments(await docsOf(db, "DRIVER", userId)).get("LICENSE");
    return !lic || lic.status === "EXPIRED" || isExpired(lic, now());
  }

  /** The vehicles this driver could pick when going online, each with why it's not allowed (if it isn't). */
  async function drivableVehicles(p: Principal) {
    const d = await db.driverProfile.findUnique({ where: { userId: p.userId } });
    const expired = d ? await licenceExpiredFor(p.userId) : false;
    const [owned, auths] = await Promise.all([
      db.vehicle.findMany({ where: { ownerType: "INDIVIDUAL", ownerUserId: p.userId, status: { not: "RETIRED" } } }),
      db.vehicleAuthorization.findMany({ where: { driverUserId: p.userId, status: "ACTIVE" }, include: { vehicle: true } }),
    ]);
    const all = [...owned, ...auths.map((a) => a.vehicle).filter((v) => v.status !== "RETIRED")];
    return Promise.all(all.map(async (v) => {
      const denial = await eligibility(p, v, d, expired);
      return { ...vehicleView(v), canDrive: !denial, denial, message: denial ? DENIAL_MESSAGE[denial] : null };
    }));
  }

  async function startSession(p: Principal, vehicleId: string) {
    const [d, v] = await Promise.all([db.driverProfile.findUnique({ where: { userId: p.userId } }), db.vehicle.findUnique({ where: { id: vehicleId } })]);
    if (!v) throw notFound("vehicle");
    const current = await openSessionOfDriver(db, p.userId);
    if (current?.vehicleId === vehicleId) return sessionView(current);
    if (current) throw conflict("you're already online with another vehicle; go offline first", "already_online");
    const denial = await eligibility(p, v, d, d ? await licenceExpiredFor(p.userId) : false);
    if (denial) throw new AppError(denial === "vehicle_in_use" ? 409 : 403, DENIAL_MESSAGE[denial], denial);
    const fleetOrgId = v.ownerType === "ORGANIZATION" ? v.ownerOrgId! : undefined;
    // the balance earning for this car (Payment.md D1, §8): blocked can't go online
    const balance = (await deps.balances?.state(fleetOrgId ? "ORGANIZATION" : "INDIVIDUAL", fleetOrgId ?? p.userId)) ?? null;
    if (balance === null && deps.balances) logger.warn({ driverId: p.userId }, "payment-service unreachable at session start; matching uses the last published balance state");
    if (balance?.state === "BLOCKED") {
      throw new AppError(403, fleetOrgId
        ? "Your fleet's balance is blocked: the fleet owner must pay what's owed before its cars can go online"
        : "Your balance is blocked: pay what you owe to go online", "balance_blocked");
    }
    try {
      return await db.$transaction(async (tx) => {
        const s = await tx.drivingSession.create({ data: { driverUserId: p.userId, vehicleId } });
        await writeOutbox(tx, {
          topic: "driver.online", key: p.userId,
          payload: {
            driverId: p.userId, vehicleId, vehicleType: v.vehicleType, cityId: v.cityId, fleetOrgId, beneficiaryId: fleetOrgId ?? p.userId,
            balanceState: balance?.state ?? "OK", cashAllowed: balance?.cashAllowed ?? true,
          },
        });
        return sessionView(s);
      });
    } catch (err) {
      // the partial unique indexes (V4, V5) settle races between two devices or two drivers
      if (isUnique(err)) throw conflict("this vehicle or driver just went online elsewhere", "vehicle_in_use");
      throw err;
    }
  }

  async function currentSession(p: Principal) {
    const s = await openSessionOfDriver(db, p.userId);
    return s ? sessionView(s) : null;
  }

  async function endSession(driverUserId: string, reason: EndReason) {
    return db.$transaction(async (tx) => {
      const s = await openSessionOfDriver(tx, driverUserId);
      if (!s) return null;
      await endSessionTx(tx, s, reason);
      return sessionView({ ...s, endedAt: now(), endReason: reason });
    });
  }

  // ── manual vehicle suspension (Role.md §6 lifecycle: "safety action") ──────
  // The matrix has no vehicle:suspend: taking a car off the road uses the same permission as taking
  // a driver off the road (driver:suspend / driver:reinstate: onboarding officers for documents,
  // safety officers), in the vehicle's city.

  async function suspendVehicle(p: Principal, id: string, input: { reason: string; category: "SAFETY" | "ONBOARDING" }) {
    const v = await loadVehicle(id);
    authorize(p, "driver:suspend", { cityId: v.cityId });
    return db.$transaction(async (tx) => {
      const cur = await tx.vehicle.findUniqueOrThrow({ where: { id } });
      if (cur.status === "SUSPENDED") return vehicleView(cur);
      if (cur.status !== "VERIFIED") throw conflict(`only a verified vehicle can be suspended; this one is ${cur.status.toLowerCase()}`, "invalid_state");
      const row = await tx.vehicle.update({ where: { id }, data: { status: "SUSPENDED", statusReason: input.category, reviewNote: input.reason, version: { increment: 1 } } });
      // off the road now: the open session ends (workflow 04: VEHICLE_UNAVAILABLE)
      const s = await openSessionOfVehicle(tx, id);
      if (s) await endSessionTx(tx, s, "VEHICLE_UNAVAILABLE");
      await writeOutbox(tx,
        { topic: "vehicle.suspended", key: id, payload: { vehicleId: id, cityId: v.cityId, reason: input.reason, byUserId: p.userId } },
        audit({ actorId: p.userId, action: "vehicle:suspend", resource: { type: "vehicle", id }, outcome: "EXECUTED", reason: input.reason }),
      );
      return vehicleView(row);
    });
  }

  async function reinstateVehicle(p: Principal, id: string, reason: string) {
    const v = await loadVehicle(id);
    authorize(p, "driver:reinstate", { cityId: v.cityId });
    if (v.status !== "SUSPENDED") throw conflict("the vehicle isn't suspended", "invalid_state");
    if (v.ownerType === "ORGANIZATION") {
      const org = await verifiedFleet(v.ownerOrgId!);
      if (org.status !== "VERIFIED") throw conflict("the company isn't verified (or is suspended); lift that first", "org_not_verified");
    }
    return db.$transaction(async (tx) => {
      const cur = await tx.vehicle.findUniqueOrThrow({ where: { id } });
      if (cur.status !== "SUSPENDED") throw conflict("the vehicle isn't suspended", "invalid_state");
      const missing = missingForApproval("VEHICLE", await docsOf(tx, "VEHICLE", id), now());
      if (missing.length) throw conflict(`these documents aren't valid: ${missing.join(", ")}. The owner uploads them and resubmits`, "documents_not_approved");
      const row = await tx.vehicle.update({ where: { id }, data: { status: "VERIFIED", statusReason: null, reviewNote: null, version: { increment: 1 } } });
      await writeOutbox(tx,
        { topic: "vehicle.reinstated", key: id, payload: { vehicleId: id, cityId: v.cityId, reason, byUserId: p.userId } },
        audit({ actorId: p.userId, action: "vehicle:reinstate", resource: { type: "vehicle", id }, outcome: "EXECUTED", reason }),
      );
      return vehicleView(row);
    });
  }

  // ── ownership transfer (rule V9, maker–checker, Role.md §11) ───────────────
  // REQUESTED (the current owner asked) → PENDING (an onboarding officer proposes it: the maker) →
  // EXECUTED (a second officer approves: the checker). Staff may also start at PENDING. Either open
  // state may be rejected by an officer or withdrawn by whoever opened it; 7 days → EXPIRED.

  const ownerIdOf = (v: Pick<VehicleRow, "ownerUserId" | "ownerOrgId">) => (v.ownerUserId ?? v.ownerOrgId)!;

  async function transferView(t: TransferRow & { vehicle?: VehicleRow }) {
    const people = [t.fromOwnerType === "INDIVIDUAL" ? t.fromOwnerId : null, t.toOwnerType === "INDIVIDUAL" ? t.toOwnerId : null].filter((x): x is string => !!x);
    const names = people.length ? await db.driverProfile.findMany({ where: { userId: { in: people } }, select: { userId: true, fullName: true } }) : [];
    const name = (type: string, id: string) => (type === "INDIVIDUAL" ? names.find((n) => n.userId === id)?.fullName ?? null : null);
    const expired = OPEN_TRANSFER.includes(t.status) && t.expiresAt <= now();
    return {
      id: t.id, vehicleId: t.vehicleId, cityId: t.cityId, status: expired ? "EXPIRED" : t.status,
      from: { type: t.fromOwnerType, id: t.fromOwnerId, name: name(t.fromOwnerType, t.fromOwnerId) },
      to: { type: t.toOwnerType, id: t.toOwnerId, name: name(t.toOwnerType, t.toOwnerId) },
      reason: t.reason, requestedBy: t.requestedBy, makerId: t.makerId, checkerId: t.checkerId, decisionNote: t.decisionNote,
      expiresAt: t.expiresAt.toISOString(), decidedAt: t.decidedAt?.toISOString() ?? null, createdAt: t.createdAt.toISOString(),
      ...(t.vehicle ? { vehicle: { plateNumber: t.vehicle.plateNumber, make: t.vehicle.make, model: t.vehicle.model, color: t.vehicle.color, status: t.vehicle.status } } : {}),
    };
  }

  /** The current owner asking for their own car: the owner-driver, or the fleet (vehicle:retire @ ORG: who may dispose of it). */
  function isOwnerAsking(p: Principal, v: VehicleRow) {
    if (v.ownerType === "INDIVIDUAL") return v.ownerUserId === p.userId && can(p, "vehicle:retire", self(p));
    return can(p, "vehicle:retire", { orgId: v.ownerOrgId });
  }

  /** The new owner must be able to own a car: a verified fleet company, or someone who applied to drive. Returns their city. */
  async function checkNewOwner(type: OwnerType, ownerId: string): Promise<string> {
    if (type === "ORGANIZATION") {
      const org = await auth.organization(ownerId);
      if (!org || org.kind !== "FLEET") throw badRequest("the new owner isn't a fleet company", "not_a_fleet");
      if (org.status !== "VERIFIED") throw conflict("the receiving company must be verified", "org_not_verified");
      return org.cityId;
    }
    const d = await db.driverProfile.findUnique({ where: { userId: ownerId } });
    if (!d) throw badRequest("the new owner must have applied as a driver (owner-drivers drive their own car)", "not_a_driver");
    return d.cityId;
  }

  async function loadTransfer(tx: Tx | Db, id: string) {
    const t = await tx.vehicleTransfer.findUnique({ where: { id } });
    if (!t) throw notFound("transfer");
    return t;
  }

  /** Moves an open transfer on, only from the state read (races: the loser gets 409). */
  async function moveTransfer(tx: Tx, t: TransferRow, data: Prisma.VehicleTransferUpdateManyMutationInput) {
    const { count } = await tx.vehicleTransfer.updateMany({ where: { id: t.id, status: t.status }, data });
    if (count === 0) throw conflict("the transfer changed meanwhile; reload", "state_changed");
  }

  async function refuseIfExpired(t: TransferRow) {
    if (OPEN_TRANSFER.includes(t.status) && t.expiresAt <= now()) {
      await db.vehicleTransfer.updateMany({ where: { id: t.id, status: t.status }, data: { status: "EXPIRED", decidedAt: now() } });
      throw conflict("this transfer expired (7 days without a decision); start a new one", "expired");
    }
    if (!OPEN_TRANSFER.includes(t.status)) throw conflict(`this transfer is ${t.status.toLowerCase()}`, "not_open");
  }

  async function requestTransfer(p: Principal, vehicleId: string, input: { toOwnerType: OwnerType; toOwnerId: string; reason: string }) {
    const v = await loadVehicle(vehicleId);
    const byOwner = isOwnerAsking(p, v);
    if (!byOwner) authorize(p, "vehicle:transfer", { cityId: v.cityId });
    if (v.status === "RETIRED") throw conflict("this vehicle is retired", "invalid_state");
    if (input.toOwnerType === v.ownerType && input.toOwnerId === ownerIdOf(v)) throw badRequest("that's the current owner", "same_owner");
    await checkNewOwner(input.toOwnerType, input.toOwnerId);
    try {
      const t = await db.$transaction(async (tx) => {
        const row = await tx.vehicleTransfer.create({
          data: {
            vehicleId, cityId: v.cityId, fromOwnerType: v.ownerType, fromOwnerId: ownerIdOf(v), toOwnerType: input.toOwnerType, toOwnerId: input.toOwnerId,
            status: byOwner ? "REQUESTED" : "PENDING", reason: input.reason, requestedBy: byOwner ? p.userId : null, makerId: byOwner ? null : p.userId,
            expiresAt: new Date(now().getTime() + TRANSFER_TTL_MS),
          },
        });
        await writeOutbox(tx, audit({ actorId: p.userId, action: "vehicle:transfer:request", resource: { type: "vehicle", id: vehicleId }, outcome: "PENDING_APPROVAL", reason: input.reason }));
        return row;
      });
      return transferView(t);
    } catch (err) {
      if (isUnique(err)) throw conflict("this vehicle already has a transfer waiting; decide or withdraw it first", "transfer_pending");
      throw err;
    }
  }

  /** An officer takes up an owner's request: they become the maker; a second officer approves. */
  async function endorseTransfer(p: Principal, id: string, note?: string) {
    const t = await loadTransfer(db, id);
    authorize(p, "vehicle:transfer", { cityId: t.cityId });
    await refuseIfExpired(t);
    if (t.status !== "REQUESTED") throw conflict("only an owner's request is endorsed; this one is already proposed", "not_requested");
    const row = await db.$transaction(async (tx) => {
      await moveTransfer(tx, t, { status: "PENDING", makerId: p.userId, ...(note ? { decisionNote: note } : {}) });
      await writeOutbox(tx, audit({ actorId: p.userId, action: "vehicle:transfer:propose", resource: { type: "vehicle_transfer", id }, outcome: "PENDING_APPROVAL", reason: note }));
      return loadTransfer(tx, id);
    });
    return transferView(row);
  }

  /** The checker approves: sessions and authorisations close, documents are checked again under the new owner (V9). */
  async function approveTransfer(p: Principal, id: string, note?: string) {
    const t = await loadTransfer(db, id);
    authorize(p, "vehicle:transfer", { cityId: t.cityId });
    await refuseIfExpired(t);
    if (t.status !== "PENDING") throw conflict("an officer must propose the owner's request first", "not_proposed");
    if (t.makerId === p.userId) throw forbidden("maker and checker must be different people", "maker_is_checker");
    const newCity = await checkNewOwner(t.toOwnerType as OwnerType, t.toOwnerId);
    const row = await db.$transaction(async (tx) => {
      const v = await tx.vehicle.findUniqueOrThrow({ where: { id: t.vehicleId } });
      if (v.status === "RETIRED") throw conflict("the vehicle was retired meanwhile", "invalid_state");
      if (v.ownerType !== t.fromOwnerType || ownerIdOf(v) !== t.fromOwnerId) throw conflict("the vehicle's owner changed since this was asked", "owner_changed");
      await moveTransfer(tx, t, { status: "EXECUTED", checkerId: p.userId, decidedAt: now(), ...(note ? { decisionNote: note } : {}) });
      const s = await openSessionOfVehicle(tx, v.id);
      if (s) await endSessionTx(tx, s, "VEHICLE_UNAVAILABLE");
      await tx.vehicleAuthorization.updateMany({ where: { vehicleId: v.id, status: "ACTIVE" }, data: { status: "REVOKED", revokedAt: now() } });
      // the registration names the old owner: a new one is needed. Everything else is checked again.
      const current = [...currentDocuments(await docsOf(tx, "VEHICLE", v.id)).values()];
      const registration = current.filter((d) => d.kind === "REGISTRATION").map((d) => d.id);
      const recheck = current.filter((d) => d.kind !== "REGISTRATION" && d.status === "APPROVED").map((d) => d.id);
      if (registration.length) await tx.document.updateMany({ where: { id: { in: registration } }, data: { status: "SUPERSEDED" } });
      if (recheck.length) await tx.document.updateMany({ where: { id: { in: recheck } }, data: { status: "PENDING", reviewedBy: null, reviewedAt: null } });
      await tx.document.updateMany({ where: { subjectType: "VEHICLE", subjectId: v.id }, data: { cityId: newCity } });
      const individual = t.toOwnerType === "INDIVIDUAL";
      await tx.vehicle.update({
        where: { id: v.id },
        data: {
          ownerType: t.toOwnerType, ownerUserId: individual ? t.toOwnerId : null, ownerOrgId: individual ? null : t.toOwnerId, cityId: newCity,
          status: "DRAFT", statusReason: "TRANSFERRED", reviewNote: null, submittedAt: null, verifiedAt: null, version: { increment: 1 },
        },
      });
      await writeOutbox(tx,
        {
          topic: "vehicle.transferred", key: v.id,
          payload: {
            vehicleId: v.id, transferId: t.id, cityId: newCity, fromOwnerType: t.fromOwnerType as OwnerType, fromOwnerId: t.fromOwnerId,
            toOwnerType: t.toOwnerType as OwnerType, toOwnerId: t.toOwnerId, requestedBy: t.requestedBy, makerId: t.makerId!, byUserId: p.userId,
          },
        },
        audit({ actorId: p.userId, action: "vehicle:transfer", resource: { type: "vehicle", id: v.id }, outcome: "EXECUTED", reason: note ?? t.reason }),
      );
      return loadTransfer(tx, id);
    });
    return transferView(row);
  }

  async function rejectTransfer(p: Principal, id: string, reason: string) {
    const t = await loadTransfer(db, id);
    authorize(p, "vehicle:transfer", { cityId: t.cityId });
    await refuseIfExpired(t);
    // the maker withdraws instead
    if (t.makerId === p.userId) throw forbidden("maker and checker must be different people; withdraw it instead", "maker_is_checker");
    const row = await db.$transaction(async (tx) => {
      await moveTransfer(tx, t, { status: "REJECTED", checkerId: p.userId, decidedAt: now(), decisionNote: reason });
      await writeOutbox(tx, audit({ actorId: p.userId, action: "vehicle:transfer:reject", resource: { type: "vehicle_transfer", id }, outcome: "EXECUTED", reason }));
      return loadTransfer(tx, id);
    });
    return transferView(row);
  }

  /** Whoever opened it (the owner who asked, or the officer who proposed it) withdraws it. */
  async function cancelTransfer(p: Principal, id: string) {
    const t = await loadTransfer(db, id);
    if (t.requestedBy !== p.userId && t.makerId !== p.userId) throw forbidden("only whoever asked can withdraw a transfer");
    await refuseIfExpired(t);
    const row = await db.$transaction(async (tx) => {
      await moveTransfer(tx, t, { status: "CANCELLED", decidedAt: now() });
      await writeOutbox(tx, audit({ actorId: p.userId, action: "vehicle:transfer:cancel", resource: { type: "vehicle_transfer", id }, outcome: "EXECUTED" }));
      return loadTransfer(tx, id);
    });
    return transferView(row);
  }

  /** Staff: a city's transfers. Fleet: transfers out of and into the company. Or one vehicle's history. */
  async function listTransfers(p: Principal, q: { cityId?: string; ownerOrgId?: string; vehicleId?: string; status?: string; limit: number }) {
    let where: Prisma.VehicleTransferWhereInput;
    if (q.vehicleId) {
      const v = await loadVehicle(q.vehicleId);
      if (!vehicleAccess(p, v, "vehicle:read", "vehicle:read") && !can(p, "vehicle:transfer", { cityId: v.cityId })) authorize(p, "vehicle:read", { cityId: v.cityId });
      where = { vehicleId: v.id };
    } else if (q.ownerOrgId) {
      authorize(p, "vehicle:read", { orgId: q.ownerOrgId });
      where = { OR: [{ fromOwnerId: q.ownerOrgId, fromOwnerType: "ORGANIZATION" }, { toOwnerId: q.ownerOrgId, toOwnerType: "ORGANIZATION" }] };
    } else if (q.cityId) {
      if (!can(p, "vehicle:transfer", { cityId: q.cityId })) authorize(p, "vehicle:read", { cityId: q.cityId });
      where = { cityId: q.cityId };
    } else {
      // an owner-driver: their own car's transfers, either way
      where = { OR: [{ fromOwnerId: p.userId, fromOwnerType: "INDIVIDUAL" }, { toOwnerId: p.userId, toOwnerType: "INDIVIDUAL" }] };
    }
    const open = q.status === "REQUESTED" || q.status === "PENDING";
    const status: Prisma.VehicleTransferWhereInput = !q.status ? {}
      : open ? { status: q.status, expiresAt: { gt: now() } }
      : q.status === "EXPIRED" ? { OR: [{ status: "EXPIRED" }, { status: { in: OPEN_TRANSFER }, expiresAt: { lte: now() } }] }
      : { status: q.status };
    const rows = await db.vehicleTransfer.findMany({ where: { AND: [where, status] }, include: { vehicle: true }, orderBy: { createdAt: "desc" }, take: q.limit });
    return Promise.all(rows.map(transferView));
  }

  /** Hourly: record transfers nobody decided within 7 days. */
  async function expireTransfers() {
    const { count } = await db.vehicleTransfer.updateMany({ where: { status: { in: OPEN_TRANSFER }, expiresAt: { lte: now() } }, data: { status: "EXPIRED", decidedAt: now() } });
    return count;
  }

  // ── a fleet's expiring documents, for staff (document:read in the company's city) ──

  async function fleetExpiringDocuments(p: Principal, orgId: string, days: number) {
    const org = await auth.organization(orgId);
    if (!org || org.kind !== "FLEET") throw notFound("organization");
    authorize(p, "document:read", { cityId: org.cityId });
    const cities = citiesWith(p, "document:read");
    const vehicles = await db.vehicle.findMany({ where: { ownerType: "ORGANIZATION", ownerOrgId: orgId, status: { not: "RETIRED" } } });
    const until = new Date(dayOf(now()).getTime() + days * 86_400_000);
    const docs = await db.document.findMany({
      where: {
        OR: [{ subjectType: "ORGANIZATION", subjectId: orgId }, { subjectType: "VEHICLE", subjectId: { in: vehicles.map((v) => v.id) } }],
        ...(cities === "*" ? {} : { cityId: { in: cities } }),
        // EXPIRED and not replaced (an upload supersedes the old one), or approved and lapsing soon
        AND: [{ OR: [{ status: "EXPIRED" }, { status: "APPROVED", expiresAt: { lte: until } }] }],
      },
      orderBy: { expiresAt: "asc" },
      take: 500,
    });
    const today = dayOf(now()).getTime();
    return {
      orgId, days, until: isoDay(until),
      documents: docs.map((d) => {
        const v = d.subjectType === "VEHICLE" ? vehicles.find((x) => x.id === d.subjectId) : undefined;
        return {
          ...documentView(d, now(), warningDays()),
          daysLeft: d.expiresAt ? Math.round((d.expiresAt.getTime() - today) / 86_400_000) : null,
          vehicle: v ? { id: v.id, plateNumber: v.plateNumber, status: v.status } : null,
        };
      }),
    };
  }

  // ── document expiry (workflow 02, part C; rule V10) ─────────────────────────

  async function expireDocuments() {
    const today = dayOf(now());
    const due = await db.document.findMany({ where: { status: "APPROVED", expiresAt: { lt: today } }, take: 500 });
    for (const d of due) {
      await db.$transaction(async (tx) => {
        await tx.document.update({ where: { id: d.id }, data: { status: "EXPIRED" } });
        const events: FleetEvent[] = [];
        if (d.subjectType === "VEHICLE") {
          const v = await tx.vehicle.findUnique({ where: { id: d.subjectId } });
          if (v?.status === "VERIFIED") {
            await tx.vehicle.update({ where: { id: v.id }, data: { status: "SUSPENDED", statusReason: "DOCUMENT_EXPIRED", version: { increment: 1 } } });
            const s = await openSessionOfVehicle(tx, v.id);
            if (s) await endSessionTx(tx, s, "VEHICLE_UNAVAILABLE");
            events.push({ topic: "vehicle.suspended", key: v.id, payload: { vehicleId: v.id, cityId: v.cityId, reason: `${d.kind} expired`, byUserId: null } });
          }
        } else if (d.subjectType === "DRIVER" && d.kind === "LICENSE") {
          const p = await tx.driverProfile.findUnique({ where: { userId: d.subjectId } });
          if (p?.status === "ACTIVE") {
            await tx.driverProfile.update({ where: { userId: p.userId }, data: { status: "SUSPENDED", statusReason: "DOCUMENT_EXPIRED", reviewNote: "Driving licence expired" } });
            const s = await openSessionOfDriver(tx, p.userId);
            if (s) await endSessionTx(tx, s, "SUSPENDED");
            events.push({ topic: "driver.suspended", key: p.userId, payload: { driverId: p.userId, cityId: p.cityId, reason: "LICENSE expired", byUserId: null } });
          }
        }
        await writeOutbox(tx, ...events);
      });
    }
    if (due.length) logger.info({ count: due.length }, "documents expired");
    return due.length;
  }

  /** Reminders 30, 7 and 1 days before expiry (notification-service sends push + SMS). Run once a day. */
  async function remindExpiring() {
    const today = dayOf(now()).getTime();
    const days = reminderDays().map((n) => new Date(today + n * 86_400_000));
    const due = await db.document.findMany({ where: { status: "APPROVED", expiresAt: { in: days } } });
    if (due.length) {
      await db.$transaction((tx) => writeOutbox(tx, ...due.map((d): FleetEvent => ({
        topic: "document.expiring", key: d.subjectId,
        payload: { documentId: d.id, subjectType: d.subjectType, subjectId: d.subjectId, kind: d.kind, expiresAt: isoDay(d.expiresAt)! },
      }))));
    }
    return due.length;
  }

  /** Admin overview: counts by status (report:read; a city, or everywhere). */
  async function stats(p: Principal, cityId?: string) {
    authorize(p, "report:read", cityId ? { cityId } : {});
    const where = cityId ? { cityId } : {};
    const [drivers, vehicles, pendingDocuments, online] = await Promise.all([
      db.driverProfile.groupBy({ by: ["status"], where, _count: true }),
      db.vehicle.groupBy({ by: ["status"], where, _count: true }),
      db.document.count({ where: { ...where, status: "PENDING" } }),
      db.drivingSession.count({ where: { endedAt: null, ...(cityId ? { vehicle: { cityId } } : {}) } }),
    ]);
    return {
      drivers: Object.fromEntries(drivers.map((g) => [g.status, g._count])),
      vehicles: Object.fromEntries(vehicles.map((g) => [g.status, g._count])),
      pendingDocuments, online,
    };
  }

  return {
    stats,
    apply, me, submitDriver,
    registerVehicle, getVehicle, listVehicles, submitVehicle, retireVehicle, approveVehicle, rejectVehicle,
    authorizeDriver, revokeDriver, fleetOverview,
    uploadTicket, confirmUpload, documentUrl, subjectDocuments, reviewDocument,
    queue, listDrivers, getDriver, approveDriver, requestChanges, suspendDriver, reinstateDriver,
    drivableVehicles, startSession, currentSession, endSession,
    expireDocuments, remindExpiring,
    suspendVehicle, reinstateVehicle,
    requestTransfer, endorseTransfer, approveTransfer, rejectTransfer, cancelTransfer, listTransfers, expireTransfers,
    fleetExpiringDocuments,
  };
}

export type FleetService = ReturnType<typeof createFleetService>;
