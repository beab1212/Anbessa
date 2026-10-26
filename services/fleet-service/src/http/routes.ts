// fleet-service HTTP API, all under /api/fleet (one Kong route). Phone app (ride-app) and web
// (ride-app partners, ride-admin staff) tokens are accepted; the shared matrix decides.

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { bearerToken, TokenError, type Principal, type VerifyAccessToken } from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import type { Signer } from "../lib/crypto.js";
import { badRequest, notFound, unauthorized } from "../lib/errors.js";
import { withIdempotency } from "../lib/idempotency.js";
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES, type FileTicket, type LocalStore, type ObjectStore } from "../lib/storage.js";
import { DOCUMENT_KINDS, type DocumentKind } from "../fleet/rules.js";
import type { FleetService } from "../fleet/service.js";

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const userParam = z.object({ userId: uuid });
const cityId = z.string().trim().min(1).max(40);
const reason = z.string().trim().min(3).max(500);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const subjectType = z.enum(["DRIVER", "VEHICLE", "ORGANIZATION"]);
const kind = z.enum(Object.values(DOCUMENT_KINDS).flat() as [DocumentKind, ...DocumentKind[]]);
const DRIVER_STATUSES = ["APPLIED", "PENDING_REVIEW", "ACTIVE", "SUSPENDED"] as const;
const VEHICLE_STATUSES = ["DRAFT", "PENDING_REVIEW", "VERIFIED", "REJECTED", "SUSPENDED", "RETIRED"] as const;

export interface RouteDeps {
  db: Db;
  fleet: FleetService;
  store: ObjectStore;
  fileTickets: Signer;
  verifyAccessToken: VerifyAccessToken;
  internalToken: string;
}

const isLocal = (s: ObjectStore): s is LocalStore => (s as Partial<LocalStore>).local === true;

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { fleet, db } = deps;

  async function principal(req: FastifyRequest): Promise<Principal> {
    const token = bearerToken(req.headers.authorization);
    if (!token) throw unauthorized();
    try {
      return await deps.verifyAccessToken(token, "ride-app");
    } catch (err) {
      if (!(err instanceof TokenError) || err.code !== "invalid_token") throw err;
      return deps.verifyAccessToken(token, "ride-admin");
    }
  }

  // ── driver (phone app) ──────────────────────────────────────────────────────
  app.post("/api/fleet/drivers/apply", async (req, reply) => {
    const body = z.object({ fullName: z.string().trim().min(3).max(120), licenseNumber: z.string().trim().min(5).max(30), cityId }).parse(req.body);
    return reply.status(201).send(await fleet.apply(await principal(req), body));
  });
  app.get("/api/fleet/drivers/me", async (req) => fleet.me(await principal(req)));
  app.post("/api/fleet/drivers/me/submit", async (req) => fleet.submitDriver(await principal(req)));
  app.get("/api/fleet/drivers/me/vehicles", async (req) => ({ vehicles: await fleet.drivableVehicles(await principal(req)) }));

  // ── staff: review and driver records ────────────────────────────────────────
  app.get("/api/fleet/review/queue", async (req) => {
    const q = z.object({ cityId }).parse(req.query);
    return fleet.queue(await principal(req), q.cityId);
  });
  app.get("/api/fleet/drivers", async (req) => {
    const q = z.object({ cityId, status: z.enum(DRIVER_STATUSES).optional(), q: z.string().trim().max(60).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
    return { drivers: await fleet.listDrivers(await principal(req), q) };
  });
  app.get("/api/fleet/drivers/:userId", async (req) => {
    const { userId } = userParam.parse(req.params);
    const { orgId } = z.object({ orgId: uuid.optional() }).parse(req.query);
    return fleet.getDriver(await principal(req), userId, orgId);
  });
  app.post("/api/fleet/drivers/:userId/approve", async (req) => fleet.approveDriver(await principal(req), userParam.parse(req.params).userId));
  app.post("/api/fleet/drivers/:userId/request-changes", async (req) => {
    const { userId } = userParam.parse(req.params);
    return fleet.requestChanges(await principal(req), userId, z.object({ reason }).parse(req.body).reason);
  });
  app.post("/api/fleet/drivers/:userId/suspend", async (req) => {
    const { userId } = userParam.parse(req.params);
    return fleet.suspendDriver(await principal(req), userId, z.object({ reason: z.string().trim().min(10).max(500) }).parse(req.body).reason);
  });
  app.post("/api/fleet/drivers/:userId/reinstate", async (req) => {
    const { userId } = userParam.parse(req.params);
    return fleet.reinstateDriver(await principal(req), userId, z.object({ reason: z.string().trim().min(10).max(500) }).parse(req.body).reason);
  });

  // ── vehicles ────────────────────────────────────────────────────────────────
  app.post("/api/fleet/vehicles", async (req, reply) => {
    const body = z.object({
      ownerType: z.enum(["INDIVIDUAL", "ORGANIZATION"]),
      ownerOrgId: uuid.optional(),
      plateNumber: z.string().trim().min(3).max(20),
      vehicleType: z.string().trim().min(1).max(30),
      make: z.string().trim().min(1).max(40),
      model: z.string().trim().min(1).max(40),
      year: z.number().int(),
      color: z.string().trim().min(1).max(30),
      seats: z.number().int(),
    }).parse(req.body);
    return reply.status(201).send(await fleet.registerVehicle(await principal(req), body));
  });
  app.get("/api/fleet/vehicles", async (req) => {
    const q = z.object({ ownerOrgId: uuid.optional(), cityId: cityId.optional(), status: z.enum(VEHICLE_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
    return { vehicles: await fleet.listVehicles(await principal(req), q) };
  });
  app.get("/api/fleet/vehicles/:id", async (req) => fleet.getVehicle(await principal(req), idParam.parse(req.params).id));
  app.post("/api/fleet/vehicles/:id/submit", async (req) => fleet.submitVehicle(await principal(req), idParam.parse(req.params).id));
  app.post("/api/fleet/vehicles/:id/retire", async (req) => fleet.retireVehicle(await principal(req), idParam.parse(req.params).id));
  app.post("/api/fleet/vehicles/:id/approve", async (req) => fleet.approveVehicle(await principal(req), idParam.parse(req.params).id));
  app.post("/api/fleet/vehicles/:id/reject", async (req) => {
    const { id } = idParam.parse(req.params);
    return fleet.rejectVehicle(await principal(req), id, z.object({ reason }).parse(req.body).reason);
  });
  app.post("/api/fleet/vehicles/:id/authorizations", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ driverUserId: uuid, validUntil: z.coerce.date().optional() }).parse(req.body);
    return reply.status(201).send(await fleet.authorizeDriver(await principal(req), id, body));
  });
  app.delete("/api/fleet/vehicles/:id/authorizations/:driverUserId", async (req) => {
    const { id, driverUserId } = z.object({ id: uuid, driverUserId: uuid }).parse(req.params);
    return fleet.revokeDriver(await principal(req), id, driverUserId);
  });

  // ── fleet portal ────────────────────────────────────────────────────────────
  app.get("/api/fleet/organizations/:id/overview", async (req) => {
    const { id } = idParam.parse(req.params);
    const { members } = z.object({ members: z.string().max(4000).default("") }).parse(req.query);
    const ids = members.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.some((m) => !uuid.safeParse(m).success)) throw badRequest("members: comma-separated user ids");
    return fleet.fleetOverview(await principal(req), id, ids);
  });

  // ── documents ───────────────────────────────────────────────────────────────
  app.post("/api/fleet/documents/upload-url", async (req) => {
    const body = z.object({
      subjectType, subjectId: uuid, kind,
      contentType: z.enum(UPLOAD_TYPES),
      sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
      sha256: z.string().regex(/^[0-9a-f]{64}$/i),
    }).parse(req.body);
    return fleet.uploadTicket(await principal(req), body);
  });
  app.post("/api/fleet/documents", async (req, reply) => {
    const body = z.object({ ticket: z.string().min(20).max(4000), expiresAt: day.optional() }).parse(req.body);
    return reply.status(201).send(await fleet.confirmUpload(await principal(req), body));
  });
  app.get("/api/fleet/documents", async (req) => {
    const q = z.object({ subjectType, subjectId: uuid }).parse(req.query);
    return fleet.subjectDocuments(await principal(req), q.subjectType, q.subjectId);
  });
  app.get("/api/fleet/documents/:id/url", async (req, reply) => {
    reply.header("cache-control", "no-store");
    return fleet.documentUrl(await principal(req), idParam.parse(req.params).id);
  });
  app.post("/api/fleet/documents/:id/review", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ decision: z.enum(["APPROVE", "REJECT"]), reason: z.string().trim().max(500).optional(), expiresAt: day.optional() }).parse(req.body);
    return fleet.reviewDocument(await principal(req), id, body);
  });

  // ── driving sessions (workflow 04) ──────────────────────────────────────────
  app.post("/api/fleet/sessions", async (req, reply) => {
    const p = await principal(req);
    const { vehicleId } = z.object({ vehicleId: uuid }).parse(req.body);
    const key = req.headers["idempotency-key"];
    const r = await withIdempotency(db, p.userId, typeof key === "string" ? key : undefined, { url: req.url, body: req.body }, async () => ({
      statusCode: 201, body: await fleet.startSession(p, vehicleId),
    }));
    return reply.status(r.statusCode).send(r.body);
  });
  app.get("/api/fleet/sessions/current", async (req) => ({ session: await fleet.currentSession(await principal(req)) }));
  app.delete("/api/fleet/sessions/current", async (req) => {
    const p = await principal(req);
    return { session: await fleet.endSession(p.userId, "DRIVER") };
  });

  // ── local file storage (development only; config refuses STORAGE=local in production) ──
  const store = deps.store;
  if (isLocal(store)) {
    for (const type of UPLOAD_TYPES) {
      app.addContentTypeParser(type, { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));
    }
    app.put("/api/fleet/files/:ticket", { bodyLimit: MAX_UPLOAD_BYTES }, async (req: FastifyRequest, reply: FastifyReply) => {
      const t = deps.fileTickets.verify<FileTicket>((req.params as { ticket: string }).ticket);
      if (!t || t.op !== "put") throw unauthorized("upload link invalid or expired");
      const body = req.body;
      if (!Buffer.isBuffer(body) || req.headers["content-type"] !== t.contentType || body.length !== t.sizeBytes) {
        throw badRequest("the file doesn't match what was announced (type or size)", "upload_mismatch");
      }
      await store.write(t.key, body);
      return reply.status(200).send({ ok: true });
    });
    app.get("/api/fleet/files/:ticket", async (req: FastifyRequest, reply: FastifyReply) => {
      const t = deps.fileTickets.verify<FileTicket>((req.params as { ticket: string }).ticket);
      if (!t || t.op !== "get") throw unauthorized("link invalid or expired");
      const body = await store.read(t.key).catch(() => null);
      if (!body) throw notFound("file");
      return reply.header("content-type", store.contentTypeOf(t.key)).header("cache-control", "private, no-store").header("content-disposition", "inline").send(body);
    });
  }

  // ── internal ────────────────────────────────────────────────────────────────
  const internal = (req: FastifyRequest) => {
    const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /i, ""));
    const expected = Buffer.from(deps.internalToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized("invalid service credentials");
  };
  // trip-service / payment-service: which vehicle a driver is in right now
  app.get("/internal/drivers/:userId/session", async (req) => {
    internal(req);
    const { userId } = userParam.parse(req.params);
    const s = await db.drivingSession.findFirst({ where: { driverUserId: userId, endedAt: null }, include: { vehicle: true } });
    if (!s) throw notFound("session");
    return { sessionId: s.id, vehicleId: s.vehicleId, vehicleType: s.vehicle.vehicleType, ownerType: s.vehicle.ownerType, beneficiaryId: s.vehicle.ownerOrgId ?? s.vehicle.ownerUserId };
  });
}
