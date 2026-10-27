import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authorize, bearerToken, TokenError, type Principal, type VerifyAccessToken } from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { withIdempotency } from "../lib/idempotency.js";
import { notFound, unauthorized } from "../lib/errors.js";
import type { builtinQuotes } from "../quotes.js";
import type { PartiesService } from "../trips/parties.js";
import type { PlacesService } from "../trips/places.js";
import type { SharesService } from "../trips/share.js";
import { createTripReports, tripReportCsv } from "../trips/reports.js";
import { tripView, type TripService } from "../trips/service.js";
import type { CorporatePolicies } from "../trips/corporate.js";
import { regulatoryCsv, type RegulatoryReport } from "../trips/regulatory.js";
import type { Scheduler } from "../trips/scheduled.js";
import { traceCsv, type TraceReader } from "../trips/trace.js";

const id = z.object({ id: z.string().uuid() });
const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const paymentMethod = z.enum(["CASH", "MOBILE_MONEY", "CARD", "CORPORATE"]);
const purposeField = z.string().trim().max(200).optional();
const CANCEL_REASONS = ["CHANGED_PLANS", "DRIVER_TOO_FAR", "DRIVER_ASKED_TO_CANCEL", "WRONG_PICKUP", "NO_SHOW", "SAFETY", "OTHER", "STAFF_DECISION"] as const;

export interface RouteDeps {
  db: Db;
  trips: TripService;
  parties: PartiesService;
  places: PlacesService;
  shares: SharesService;
  verifyAccessToken: VerifyAccessToken;
  internalToken: string;
  /** the development quote stand-in (PRICING=builtin) */
  devQuotes?: ReturnType<typeof builtinQuotes>;
  policies: CorporatePolicies;
  trace: TraceReader;
  regulatory: RegulatoryReport;
  scheduler: Scheduler;
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

  // ── my rating (static path before /api/trips/:id) ───────────────────────────
  app.get("/api/trips/me/rating", async (req) => trips.ratingOfUser((await principal(req)).userId));

  // ── saved places (static paths before /api/trips/:id) ───────────────────────
  const placeBody = z.object({ name: z.string().trim().min(1).max(120), address: z.string().trim().max(240).optional(), lat: point.shape.lat, lng: point.shape.lng });
  app.get("/api/trips/places", async (req) => ({ places: await deps.places.list(await principal(req)) }));
  app.put("/api/trips/places/:label", async (req) => {
    const p = await principal(req);
    const { label } = z.object({ label: z.enum(["home", "work"]) }).parse(req.params);
    return deps.places.setFixed(p, label.toUpperCase() as "HOME" | "WORK", placeBody.parse(req.body));
  });
  app.post("/api/trips/places", async (req, reply) => {
    const p = await principal(req);
    return reply.status(201).send(await deps.places.add(p, placeBody.parse(req.body)));
  });
  app.delete("/api/trips/places/:id", async (req, reply) => {
    const p = await principal(req);
    await deps.places.remove(p, id.parse(req.params).id);
    return reply.status(204).send();
  });

  // ── share my trip: the public view (no token; the share token is the secret) ─
  app.get("/api/trips/shared/:token", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) }).parse(req.params);
    reply.header("cache-control", "no-store");
    reply.header("referrer-policy", "no-referrer");
    return deps.shares.view(token);
  });

  // ── workflow 05: request ────────────────────────────────────────────────────
  app.post("/api/trips", async (req, reply) => {
    const p = await principal(req);
    const body = z.object({
      quoteId: z.string().min(1).max(100),
      paymentMethod,
      riderUserId: z.string().uuid().optional(),
      billingOrgId: z.string().uuid().optional(),
      purpose: purposeField,
    }).parse(req.body);
    return idempotent(req, reply, p, async () => ({ statusCode: 201, body: tripView(await trips.request(p, body), p) }));
  });

  // ── workflow 12: scheduled rides (static paths before /api/trips/:id) ─────────
  const sid = z.object({ sid: z.string().uuid() });
  app.post("/api/trips/scheduled", async (req, reply) => {
    const p = await principal(req);
    const body = z.object({
      quoteId: z.string().min(1).max(100),
      paymentMethod,
      scheduledFor: z.coerce.date(),
      riderUserId: z.string().uuid().optional(),
      billingOrgId: z.string().uuid().optional(),
      purpose: purposeField,
    }).parse(req.body);
    return idempotent(req, reply, p, async () => ({ statusCode: 201, body: await deps.scheduler.book(p, body) }));
  });
  app.get("/api/trips/scheduled", async (req) => {
    const p = await principal(req);
    const q = z.object({
      orgId: z.string().uuid().optional(), cityId: cityQ,
      status: z.enum(["upcoming", "all", "SCHEDULED", "DISPATCHING", "DISPATCHED", "CANCELLED", "FAILED"]).optional(),
      from: z.coerce.date().optional(), to: z.coerce.date().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(req.query);
    return { scheduled: await deps.scheduler.list(p, q) };
  });
  app.get("/api/trips/scheduled/:sid", async (req) => deps.scheduler.get(await principal(req), sid.parse(req.params).sid));
  app.patch("/api/trips/scheduled/:sid", async (req) => {
    const p = await principal(req);
    const body = z.object({
      scheduledFor: z.coerce.date().optional(),
      quoteId: z.string().min(1).max(100).optional(),
      purpose: z.string().trim().max(200).nullable().optional(),
    }).refine((b) => b.scheduledFor || b.quoteId || b.purpose !== undefined, "nothing to change").parse(req.body);
    return deps.scheduler.update(p, sid.parse(req.params).sid, body);
  });
  app.post("/api/trips/scheduled/:sid/cancel", async (req) => deps.scheduler.cancel(await principal(req), sid.parse(req.params).sid));

  // ── workflow 11: company ride policies ───────────────────────────────────────
  const orgParam = z.object({ orgId: z.string().uuid() });
  app.get("/api/trips/corporate/:orgId/policy", async (req) => deps.policies.get(await principal(req), orgParam.parse(req.params).orgId));
  app.put("/api/trips/corporate/:orgId/policy", async (req) => {
    const p = await principal(req);
    const minute = z.number().int().min(0).max(1440).nullable();
    const money = z.number().int().positive().max(1e12).nullable();
    const body = z.object({
      allowedVehicleTypes: z.array(z.string().regex(/^[a-z0-9_]{1,30}$/)).max(20).default([]),
      allowedDays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
      startMinute: minute.default(null),
      endMinute: minute.default(null),
      maxFareMinor: money.default(null),
      monthlyBudgetMinor: money.default(null),
      requirePurpose: z.boolean().default(false),
    }).parse(req.body);
    return deps.policies.put(p, orgParam.parse(req.params).orgId, body);
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

  // ── staff search, company/fleet lists, daily report (static paths before /:id) ──
  const reports = createTripReports({ db });
  const day = z.string().max(10).optional();
  const listQuery = {
    status: z.enum(["requested", "matched", "en_route", "in_progress", "completed", "cancelled"]).optional(),
    from: day, to: day,
    before: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  };
  const cityQ = z.string().min(1).max(40).optional();

  app.get("/api/trips/search", async (req) => {
    const p = await principal(req);
    const { cityId, ...f } = z.object({
      ...listQuery, cityId: cityQ,
      channel: z.enum(["APP", "PHONE", "CORPORATE_PORTAL"]).optional(), paymentMethod: paymentMethod.optional(),
      riderUserId: z.string().uuid().optional(), driverUserId: z.string().uuid().optional(),
      vehicleId: z.string().min(1).max(100).optional(), billingOrgId: z.string().uuid().optional(),
      q: z.string().trim().min(1).max(36).optional(),
    }).parse(req.query);
    const r = await reports.search(p, cityId, f);
    return { trips: r.trips.map((t) => tripView(t, p)), next: r.next };
  });

  app.get("/api/trips/org/:orgId", async (req) => {
    const p = await principal(req);
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    const { role, ...f } = z.object({ ...listQuery, role: z.enum(["billing", "fleet"]) }).parse(req.query);
    const r = await reports.forOrg(p, orgId, role, f);
    // partners get the plain view (no PIN, even for trips they booked; no review flags)
    return { trips: r.trips.map((t) => (p.audience === "ride-admin" ? tripView(t, p) : tripView(t))), next: r.next };
  });

  const reportQuery = z.object({ cityId: cityQ, from: day, to: day });
  app.get("/api/trips/reports/daily", async (req) => {
    const p = await principal(req);
    const { cityId, ...range } = reportQuery.parse(req.query);
    return reports.daily(p, cityId, range);
  });
  app.get("/api/trips/reports/daily.csv", async (req, reply) => {
    const p = await principal(req);
    const { cityId, ...range } = reportQuery.parse(req.query);
    const r = await reports.daily(p, cityId, range);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="trips-${cityId ?? "all"}-${r.from}-${r.to}.csv"`)
      .header("cache-control", "no-store")
      .send(tripReportCsv(r));
  });

  // regulator: monthly aggregates per city (report:read_regulatory)
  const regulatoryQuery = z.object({ cityId: cityQ, from: z.string().max(7).optional(), to: z.string().max(7).optional() });
  app.get("/api/trips/reports/regulatory", async (req) => {
    const p = await principal(req);
    const { cityId, ...range } = regulatoryQuery.parse(req.query);
    return deps.regulatory.report(p, cityId, range);
  });
  app.get("/api/trips/reports/regulatory.csv", async (req, reply) => {
    const p = await principal(req);
    const { cityId, ...range } = regulatoryQuery.parse(req.query);
    const r = await deps.regulatory.report(p, cityId, range);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="regulatory-${cityId ?? "all"}-${r.from}-${r.to}.csv"`)
      .header("cache-control", "no-store")
      .send(regulatoryCsv(r.rows));
  });

  app.get("/api/trips/:id", async (req) => {
    const p = await principal(req);
    return tripView(await trips.readable(p, id.parse(req.params).id), p);
  });

  app.get("/api/trips/:id/events", async (req) => {
    const p = await principal(req);
    return trips.events(p, id.parse(req.params).id);
  });

  // names and the car, for whoever may read the trip (the rider sees the driver and car, the driver the rider)
  app.get("/api/trips/:id/parties", async (req) => {
    const p = await principal(req);
    return deps.parties.forTrip(await trips.readable(p, id.parse(req.params).id), p);
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

  // dispatcher: take a matched trip from its driver (to another driver, or back to matching)
  app.post("/api/trips/:id/reassign", async (req, reply) => {
    const p = await principal(req);
    const body = z.object({ driverId: z.string().uuid().optional(), reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    return idempotent(req, reply, p, async () => ({ statusCode: 200, body: tripView(await trips.reassign(p, id.parse(req.params).id, body), p) }));
  });

  // GPS trace (trip:read_gps_trace: dispatch and safety; every read audited)
  const traceQuery = z.object({ reason: z.string().trim().max(500).optional() });
  app.get("/api/trips/:id/trace", async (req, reply) => {
    const p = await principal(req);
    const { raw: _raw, ...trace } = await deps.trace.read(p, id.parse(req.params).id, traceQuery.parse(req.query).reason);
    reply.header("cache-control", "no-store");
    return trace;
  });
  app.get("/api/trips/:id/trace.csv", async (req, reply) => {
    const p = await principal(req);
    const tripId = id.parse(req.params).id;
    const t = await deps.trace.read(p, tripId, traceQuery.parse(req.query).reason);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="trip-${tripId}-trace.csv"`)
      .header("cache-control", "no-store")
      .send(traceCsv(t.raw));
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
    const body = z.object({ stars: z.number().int().min(1).max(5), comment: z.string().max(500).optional(), tags: z.array(z.string().max(40)).max(5).optional() }).parse(req.body);
    return reply.status(201).send(await trips.rate(p, id.parse(req.params).id, body));
  });

  app.post("/api/trips/:id/share", async (req, reply) => {
    const p = await principal(req);
    return reply.status(201).send(await deps.shares.create(p, id.parse(req.params).id));
  });

  app.delete("/api/trips/:id/share", async (req, reply) => {
    const p = await principal(req);
    await deps.shares.revoke(p, id.parse(req.params).id);
    return reply.status(204).send();
  });

  app.get("/api/trips/:id/rating", async (req) => {
    const p = await principal(req);
    return trips.ratingOf(p, id.parse(req.params).id);
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
      // support-service also needs the booker (who may report on the trip) and the fleet that
      // earns it (lost items reach the fleet owner); internal callers only
      return {
        ...tripView(t),
        bookedByUserId: t.bookedByUserId,
        beneficiary: t.beneficiaryId && t.vehicleOwnerType ? { type: t.vehicleOwnerType, id: t.beneficiaryId } : null,
      };
    });
  });
}
