// support-service HTTP API under /api/support (Kong routes it), plus /internal/ops/outbox.
// Both audiences are accepted: ride-app (phone app, partner portal) and ride-admin (staff web);
// what a caller may do is decided per resource with the live permission matrix.

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { bearerToken, TokenError, type Principal, type VerifyAccessToken } from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import { unauthorized } from "../lib/errors.js";
import { withIdempotency } from "../lib/idempotency.js";
import type { IncidentService } from "../support/incidents.js";
import type { LostItemService } from "../support/lost-items.js";
import type { SosService } from "../support/sos.js";
import type { TicketService } from "../support/tickets.js";

export interface RouteDeps {
  db: Db;
  tickets: TicketService;
  lostItems: LostItemService;
  sos: SosService;
  incidents: IncidentService;
  verifyAccessToken: VerifyAccessToken;
  internalToken: string;
}

const id = z.object({ id: z.string().uuid() });
const city = z.string().regex(/^[a-z0-9-]{1,40}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const page = { cursor: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) };
const position = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().min(0).max(100_000).optional() });

const category = z.enum(["SAFETY", "PAYMENT", "TRIP", "LOST_ITEM", "ACCOUNT", "FEEDBACK"]);
const priority = z.enum(["P1", "P2", "P3", "P4"]);
const ticketStatus = z.enum(["OPEN", "IN_PROGRESS", "WAITING_REQUESTER", "RESOLVED", "CLOSED"]);
const resolution = z.enum(["NO_ACTION", "EXPLAINED", "REFUND", "ADJUSTMENT", "DRIVER_WARNING", "ESCALATE_SAFETY"]);
const lostStatus = z.enum(["REPORTED", "FOUND", "NOT_FOUND", "RETURNED", "CLOSED"]);
const incidentCategory = z.enum(["HARASSMENT", "ASSAULT", "ACCIDENT", "DANGEROUS_DRIVING", "THEFT", "OTHER"]);
const severity = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { tickets, lostItems, sos, incidents, db } = deps;

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

  const idemKey = (req: FastifyRequest) => {
    const v = req.headers["idempotency-key"];
    return typeof v === "string" ? v : undefined;
  };

  async function idempotent(req: FastifyRequest, reply: FastifyReply, p: Principal, work: () => Promise<{ statusCode: number; body: unknown }>) {
    const r = await withIdempotency(db, p.userId, idemKey(req), { url: req.url, body: req.body }, work);
    return reply.status(r.statusCode).send(r.body);
  }

  const noStore = (reply: FastifyReply) => reply.header("cache-control", "no-store");

  // ── tickets ─────────────────────────────────────────────────────────────────
  app.get("/api/support/me/tickets", async (req) => tickets.mine(await principal(req), z.object(page).parse(req.query)));

  app.get("/api/support/tickets", async (req, reply) => {
    const q = z.object({
      cityId: city.optional(),
      status: z.string().max(100).optional().transform((s) => (s ? s.split(",").map((v) => ticketStatus.parse(v.trim())) : undefined)),
      category: category.optional(), priority: priority.optional(),
      assignee: z.union([z.literal("me"), z.literal("none"), z.string().uuid()]).optional(),
      overdue: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
      q: z.string().trim().max(100).optional(), tripId: z.string().uuid().optional(), requesterUserId: z.string().uuid().optional(), ...page,
    }).parse(req.query);
    return noStore(reply).send(await tickets.list(await principal(req), {
      limit: q.limit,
      ...Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== "")),
    }));
  });

  app.post("/api/support/tickets", async (req, reply) => {
    const p = await principal(req);
    const body = z.object({
      category, subject: text(200), description: text(5000), tripId: z.string().uuid().optional(), cityId: city.optional(),
      requesterUserId: z.string().uuid().optional(), source: z.enum(["PHONE", "STAFF"]).optional(), priority: priority.optional(),
      orgId: z.string().uuid().optional(), as: z.enum(["RIDER", "DRIVER"]).optional(),
    }).parse(req.body);
    return idempotent(req, reply, p, async () => ({ statusCode: 201, body: { ticket: await tickets.create(p, body) } }));
  });

  app.get("/api/support/tickets/:id", async (req, reply) => noStore(reply).send(await tickets.detail(await principal(req), id.parse(req.params).id)));

  app.patch("/api/support/tickets/:id", async (req) => {
    const body = z.object({ priority: priority.optional(), category: category.optional() }).parse(req.body);
    return { ticket: await tickets.patch(await principal(req), id.parse(req.params).id, body) };
  });

  app.post("/api/support/tickets/:id/claim", async (req) => ({ ticket: await tickets.claim(await principal(req), id.parse(req.params).id) }));

  app.post("/api/support/tickets/:id/assign", async (req) => {
    const { assigneeUserId } = z.object({ assigneeUserId: z.string().uuid().nullable() }).parse(req.body);
    return { ticket: await tickets.assign(await principal(req), id.parse(req.params).id, assigneeUserId) };
  });

  app.post("/api/support/tickets/:id/status", async (req) => {
    const body = z.object({ status: z.enum(["OPEN", "IN_PROGRESS", "WAITING_REQUESTER", "CLOSED"]), note: text(2000).optional() }).parse(req.body);
    return { ticket: await tickets.setStatus(await principal(req), id.parse(req.params).id, body.status, body.note) };
  });

  app.post("/api/support/tickets/:id/resolve", async (req) => {
    const body = z.object({ resolution, note: text(5000) }).parse(req.body);
    return { ticket: await tickets.resolve(await principal(req), id.parse(req.params).id, body) };
  });

  app.post("/api/support/tickets/:id/reopen", async (req) => {
    const { reason } = z.object({ reason: text(2000) }).parse(req.body);
    return { ticket: await tickets.reopen(await principal(req), id.parse(req.params).id, reason) };
  });

  app.post("/api/support/tickets/:id/messages", async (req, reply) => {
    const body = z.object({ body: text(5000), internal: z.boolean().optional() }).parse(req.body);
    return reply.status(201).send({ message: await tickets.message(await principal(req), id.parse(req.params).id, body) });
  });

  app.post("/api/support/tickets/:id/refunds", async (req, reply) => {
    const body = z.object({ refundId: z.string().uuid(), amountMinor: z.number().int().positive().max(1e12).optional(), note: text(1000).optional() }).parse(req.body);
    return reply.status(201).send({ refund: await tickets.linkRefund(await principal(req), id.parse(req.params).id, body) });
  });

  // ── lost items ──────────────────────────────────────────────────────────────
  app.get("/api/support/me/lost-items", async (req) => lostItems.mine(await principal(req), z.object(page).parse(req.query)));

  app.get("/api/support/lost-items", async (req, reply) => {
    const q = z.object({ cityId: city.optional(), status: lostStatus.optional(), tripId: z.string().uuid().optional(), ...page }).parse(req.query);
    return noStore(reply).send(await lostItems.list(await principal(req), q));
  });

  app.post("/api/support/lost-items", async (req, reply) => {
    const p = await principal(req);
    const body = z.object({ tripId: z.string().uuid(), description: text(2000) }).parse(req.body);
    return idempotent(req, reply, p, async () => ({ statusCode: 201, body: { lostItem: await lostItems.report(p, body) } }));
  });

  app.get("/api/support/lost-items/:id", async (req, reply) => noStore(reply).send(await lostItems.get(await principal(req), id.parse(req.params).id)));

  app.post("/api/support/lost-items/:id/respond", async (req) => {
    const body = z.object({ found: z.boolean(), note: text(2000).optional() }).parse(req.body);
    return { lostItem: await lostItems.respond(await principal(req), id.parse(req.params).id, body) };
  });

  app.post("/api/support/lost-items/:id/status", async (req) => {
    const body = z.object({ status: z.enum(["FOUND", "NOT_FOUND", "RETURNED", "CLOSED"]), note: text(2000).optional() }).parse(req.body);
    return { lostItem: await lostItems.setStatus(await principal(req), id.parse(req.params).id, body) };
  });

  app.post("/api/support/lost-items/:id/messages", async (req, reply) => {
    const { body } = z.object({ body: text(2000) }).parse(req.body);
    return reply.status(201).send({ message: await lostItems.message(await principal(req), id.parse(req.params).id, body) });
  });

  // ── SOS ─────────────────────────────────────────────────────────────────────
  // no per-route rate limit below the global one: an SOS must never be refused for being frequent
  app.post("/api/support/sos", async (req, reply) => {
    const p = await principal(req);
    const body = z.object({ tripId: z.string().uuid(), location: position, cityId: city.optional() }).parse(req.body);
    return idempotent(req, reply, p, async () => {
      const r = await sos.trigger(p, body);
      return { statusCode: r.statusCode, body: { alert: r.alert, duplicate: r.duplicate } };
    });
  });

  app.get("/api/support/sos", async (req, reply) => {
    const q = z.object({ cityId: city.optional(), status: z.enum(["active", "resolved", "all"]).default("active") }).parse(req.query);
    return noStore(reply).send(await sos.list(await principal(req), q));
  });

  app.get("/api/support/sos/:id", async (req, reply) => noStore(reply).send(await sos.get(await principal(req), id.parse(req.params).id)));

  app.post("/api/support/sos/:id/location", async (req) => ({ alert: await sos.location(await principal(req), id.parse(req.params).id, position.parse(req.body)) }));

  app.post("/api/support/sos/:id/acknowledge", async (req) => {
    const { note } = z.object({ note: text(2000).optional() }).parse(req.body ?? {});
    return { alert: await sos.acknowledge(await principal(req), id.parse(req.params).id, note) };
  });

  app.post("/api/support/sos/:id/notes", async (req, reply) => {
    const { body } = z.object({ body: text(2000) }).parse(req.body);
    return reply.status(201).send({ note: await sos.note(await principal(req), id.parse(req.params).id, body) });
  });

  app.post("/api/support/sos/:id/resolve", async (req) => {
    const body = z.object({ outcome: z.enum(["FALSE_ALARM", "ASSISTED", "ESCALATED"]), note: text(2000), emergencyReference: text(100).optional() }).parse(req.body);
    return { alert: await sos.resolve(await principal(req), id.parse(req.params).id, body) };
  });

  // ── incidents ───────────────────────────────────────────────────────────────
  app.get("/api/support/incidents", async (req, reply) => {
    const q = z.object({ cityId: city.optional(), status: z.enum(["OPEN", "INVESTIGATING", "RESOLVED"]).optional(), severity: severity.optional(), category: incidentCategory.optional(), ...page }).parse(req.query);
    return noStore(reply).send(await incidents.list(await principal(req), q));
  });

  app.post("/api/support/incidents", async (req, reply) => {
    const body = z.object({
      category: incidentCategory, severity, summary: text(2000), cityId: city.optional(), tripId: z.string().uuid().optional(),
      subjectUserIds: z.array(z.string().uuid()).max(10).optional(), sosAlertId: z.string().uuid().optional(), ticketId: z.string().uuid().optional(),
    }).parse(req.body);
    return reply.status(201).send({ incident: await incidents.open(await principal(req), body) });
  });

  app.get("/api/support/incidents/:id", async (req, reply) => noStore(reply).send(await incidents.get(await principal(req), id.parse(req.params).id)));

  app.patch("/api/support/incidents/:id", async (req) => {
    const body = z.object({
      severity: severity.optional(), category: incidentCategory.optional(), summary: text(2000).optional(),
      status: z.enum(["OPEN", "INVESTIGATING"]).optional(), ownerUserId: z.string().uuid().nullable().optional(),
    }).parse(req.body);
    return { incident: await incidents.patch(await principal(req), id.parse(req.params).id, body) };
  });

  app.post("/api/support/incidents/:id/notes", async (req, reply) => {
    const { body } = z.object({ body: text(5000) }).parse(req.body);
    return reply.status(201).send({ note: await incidents.note(await principal(req), id.parse(req.params).id, body) });
  });

  app.post("/api/support/incidents/:id/actions", async (req, reply) => {
    const body = z.object({
      userId: z.string().uuid(), kind: z.enum(["WARNING", "SUSPENDED", "BANNED", "REINSTATED", "PAIR_BLOCK"]),
      until: z.coerce.date().optional(), reference: text(200).optional(), note: text(2000).optional(),
    }).parse(req.body);
    return reply.status(201).send({ action: await incidents.action(await principal(req), id.parse(req.params).id, body) });
  });

  app.post("/api/support/incidents/:id/resolve", async (req) => {
    const body = z.object({ outcome: z.enum(["CLEARED", "WARNING", "SUSPENDED_TEMPORARY", "REMOVED_PERMANENTLY"]), note: text(5000) }).parse(req.body);
    return { incident: await incidents.resolve(await principal(req), id.parse(req.params).id, body) };
  });

  // ── internal: platform-service's system page ────────────────────────────────
  await app.register(async (internal) => {
    const expected = Buffer.from(deps.internalToken);
    internal.addHook("onRequest", async (req) => {
      const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /i, ""));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized("invalid service credentials");
    });
    internal.get("/internal/ops/outbox", async () => {
      const [row] = await db.$queryRaw<{ pending: bigint; oldest: Date | null }[]>`
        SELECT count(*) AS pending, min(created_at) AS oldest FROM outbox WHERE published_at IS NULL`;
      return { pending: Number(row?.pending ?? 0), oldestAt: row?.oldest?.toISOString() ?? null };
    });
  });
}
