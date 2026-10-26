import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authorize, bearerToken, TokenError, type Principal, type VerifyAccessToken } from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { withIdempotency } from "../lib/idempotency.js";
import { notFound, unauthorized } from "../lib/errors.js";
import type { builtinQuotes } from "../quotes.js";
import { tripView, type TripService } from "../trips/service.js";

const id = z.object({ id: z.string().uuid() });
const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const paymentMethod = z.enum(["CASH", "MOBILE_MONEY", "CARD", "CORPORATE"]);
const CANCEL_REASONS = ["CHANGED_PLANS", "DRIVER_TOO_FAR", "DRIVER_ASKED_TO_CANCEL", "WRONG_PICKUP", "NO_SHOW", "SAFETY", "OTHER", "STAFF_DECISION"] as const;

export interface RouteDeps {
  db: Db;
  trips: TripService;
  verifyAccessToken: VerifyAccessToken;
  internalToken: string;
  /** the development quote stand-in (PRICING=builtin) */
  devQuotes?: ReturnType<typeof builtinQuotes>;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { trips, db } = deps;

  /** Phone app (ride-app) and web staff (ride-admin) tokens are both accepted; permissions decide. */
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

  /** Run a POST through the idempotency store, then answer with the stored status and body. */
  async function idempotent(req: FastifyRequest, reply: FastifyReply, p: Principal, work: () => Promise<{ statusCode: number; body: unknown }>) {
    const r = await withIdempotency(db, p.userId, idemKey(req), { url: req.url, body: req.body }, work);
    return reply.status(r.statusCode).send(r.body);
  }

  // ── workflow 05: request ────────────────────────────────────────────────────
  app.post("/api/trips", async (req, reply) => {
    const p = await principal(req);
    const body = z.object({
      quoteId: z.string().min(1).max(100),
      paymentMethod,
      riderUserId: z.string().uuid().optional(),
      billingOrgId: z.string().uuid().optional(),
    }).parse(req.body);
    return idempotent(req, reply, p, async () => ({ statusCode: 201, body: tripView(await trips.request(p, body), p) }));
  });

  app.get("/api/trips/active", async (req) => {
    const p = await principal(req);
    const t = await trips.active(p);
    return { trip: t ? tripView(t, p) : null };
  });

  app.get("/api/trips", async (req) => {
    const p = await principal(req);
    const q = z.object({
      as: z.enum(["rider", "driver"]).default("rider"),
      before: z.coerce.date().optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }).parse(req.query);
    const rows = await trips.mine(p, q.as, q.before, q.limit);
    return { trips: rows.map((t) => tripView(t, p)), next: rows.length === q.limit ? rows.at(-1)!.createdAt.toISOString() : null };
  });

  // admin overview: today's numbers (aggregates only, report:read), before /:id
  app.get("/api/trips/stats", async (req) => {
    const p = await principal(req);
    const { cityId } = z.object({ cityId: z.string().min(1).max(40).optional() }).parse(req.query);
    authorize(p, "report:read", cityId ? { cityId } : {});
    // "today" in Addis Ababa (UTC+3, no daylight saving)
    const addisNow = new Date(Date.now() + 3 * 3600_000);
    const since = new Date(Date.UTC(addisNow.getUTCFullYear(), addisNow.getUTCMonth(), addisNow.getUTCDate()) - 3 * 3600_000);
    const where = { createdAt: { gte: since }, ...(cityId ? { cityId } : {}) };
    const [byStatus, byChannel, active, matched] = await Promise.all([
      db.trip.groupBy({ by: ["status"], where, _count: true }),
      db.trip.groupBy({ by: ["channel"], where, _count: true }),
      db.trip.count({ where: { status: { in: ["requested", "matched", "en_route", "in_progress"] }, ...(cityId ? { cityId } : {}) } }),
      db.$queryRaw<{ avg: number | null }[]>`
        SELECT avg(extract(epoch FROM matched_at - created_at))::float AS avg FROM trip
        WHERE created_at >= ${since} AND matched_at IS NOT NULL ${cityId ? Prisma.sql`AND city_id = ${cityId}` : Prisma.empty}`,
    ]);
    const count = (s: string) => byStatus.find((x) => x.status === s)?._count ?? 0;
    const total = byStatus.reduce((n, x) => n + x._count, 0);
    const ended = count("completed") + count("cancelled");
    return {
      since: since.toISOString(), requested: total, completed: count("completed"), cancelled: count("cancelled"), active,
      completionRate: ended ? count("completed") / ended : null,
      avgSecondsToMatch: matched[0]?.avg ?? null,
      byChannel: Object.fromEntries(byChannel.map((x) => [x.channel, x._count])),
    };
  });

  // dispatcher live board (before /:id so "board" isn't taken for an id)
  app.get("/api/trips/board", async (req) => {
    const p = await principal(req);
    const { cityId } = z.object({ cityId: z.string().min(1).max(40) }).parse(req.query);
    return { trips: (await trips.board(p, cityId)).map((t) => tripView(t, p)) };
  });

  app.get("/api/trips/:id", async (req) => {
    const p = await principal(req);
    return tripView(await trips.readable(p, id.parse(req.params).id), p);
  });

  // ── offers ──────────────────────────────────────────────────────────────────
  app.post("/api/trips/:id/accept", async (req, reply) => {
    const p = await principal(req);
    const { offerId } = z.object({ offerId: z.string().uuid() }).parse(req.body);
    return idempotent(req, reply, p, async () => ({ statusCode: 200, body: tripView(await trips.accept(p, id.parse(req.params).id, offerId), p) }));
  });

  app.post("/api/trips/:id/decline", async (req) => {
    const p = await principal(req);
    const { offerId } = z.object({ offerId: z.string().uuid() }).parse(req.body);
    return trips.decline(p, id.parse(req.params).id, offerId);
  });

  app.post("/api/trips/:id/assign", async (req, reply) => {
    const p = await principal(req);
    const { driverId } = z.object({ driverId: z.string().uuid() }).parse(req.body);
    return idempotent(req, reply, p, async () => ({ statusCode: 200, body: tripView(await trips.assign(p, id.parse(req.params).id, driverId), p) }));
  });

  // ── workflow 06: progress (the assigned driver) ─────────────────────────────
  app.post("/api/trips/:id/en-route", async (req) => {
    const p = await principal(req);
    return tripView(await trips.enRoute(p, id.parse(req.params).id), p);
  });

  app.post("/api/trips/:id/arrive", async (req) => {
    const p = await principal(req);
    return tripView(await trips.arrive(p, id.parse(req.params).id), p);
  });

  app.post("/api/trips/:id/start", async (req) => {
    const p = await principal(req);
    const { pin } = z.object({ pin: z.string().regex(/^\d{4}$/).optional() }).parse(req.body ?? {});
    return tripView(await trips.start(p, id.parse(req.params).id, pin), p);
  });

  app.post("/api/trips/:id/complete", async (req, reply) => {
    const p = await principal(req);
    return idempotent(req, reply, p, async () => ({ statusCode: 200, body: tripView(await trips.complete(p, id.parse(req.params).id), p) }));
  });

  // ── workflow 07 / 08 ────────────────────────────────────────────────────────
  app.post("/api/trips/:id/cancel", async (req, reply) => {
    const p = await principal(req);
    const { reason } = z.object({ reason: z.enum(CANCEL_REASONS) }).parse(req.body);
    return idempotent(req, reply, p, async () => ({ statusCode: 200, body: tripView(await trips.cancel(p, id.parse(req.params).id, reason), p) }));
  });

  app.post("/api/trips/:id/rating", async (req, reply) => {
    const p = await principal(req);
    const body = z.object({ stars: z.number().int().min(1).max(5), comment: z.string().max(500).optional() }).parse(req.body);
    return reply.status(201).send(await trips.rate(p, id.parse(req.params).id, body));
  });

  // ── development stand-in for pricing-service's estimates (PRICING=builtin only) ──
  const devQuotes = deps.devQuotes;
  if (devQuotes) {
    app.post("/api/trips/estimates", async (req) => {
      const p = await principal(req);
      const body = z.object({
        pickup: point, dropoff: point,
        vehicleTypes: z.array(z.string().min(1).max(30)).min(1).max(5).default(["economy"]),
        pickupAddress: z.string().max(200).optional(), dropoffAddress: z.string().max(200).optional(),
      }).parse(req.body);
      return { quotes: await devQuotes.create({ requestedBy: p.userId, ...body }) };
    });
  }

  // ── internal (support, payment): trip facts by id ───────────────────────────
  await app.register(async (internal) => {
    const expected = Buffer.from(deps.internalToken);
    internal.addHook("onRequest", async (req) => {
      const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /i, ""));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized("invalid service credentials");
    });
    // system page (platform-service): events waiting to be published
    internal.get("/internal/ops/outbox", async () => {
      const [row] = await db.$queryRaw<{ pending: bigint; oldest: Date | null }[]>`
        SELECT count(*) AS pending, min(created_at) AS oldest FROM outbox WHERE published_at IS NULL`;
      return { pending: Number(row?.pending ?? 0), oldestAt: row?.oldest?.toISOString() ?? null };
    });
    internal.get("/internal/trips/:id", { config: { rateLimit: false } }, async (req) => {
      const t = await db.trip.findUnique({ where: { id: id.parse(req.params).id } });
      if (!t) throw notFound("trip");
      return tripView(t);
    });
  });
}
