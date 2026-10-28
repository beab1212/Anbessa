// Workflow 15 administration under /api/pricing: zones (zone:manage), fare changes with
// maker–checker (pricing:propose / pricing:approve), promotions (promo:manage, finance activation
// with incentive:approve), and the rider's promo check. Staff routes need a ride-admin token;
// every decision is made per city with the live permission matrix.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Principal } from "@ride-app/shared-authz";
import { cityAt } from "@ride-app/shared-location";
import { forbidden } from "../lib/errors.js";
import { withIdempotency } from "../lib/idempotency.js";
import { isStaff } from "../lib/staff.js";
import { REJECTION_MESSAGES } from "../promos/discount.js";
import { publicPromo } from "../promos/service.js";
import type { RouteDeps } from "./routes.js";

const id = z.object({ id: z.string().uuid() });
const city = z.string().regex(/^[a-z0-9-]{1,40}$/);
const vehicleType = z.string().regex(/^[a-z0-9_]{1,30}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const minor = z.number().int().min(0).max(1_000_000);
const limit = z.coerce.number().int().min(1).max(200).default(50);
const iso = z.string().datetime({ offset: true });
export const promoCode = z.string().trim().regex(/^[A-Za-z0-9_-]{3,32}$/, "3–32 letters, digits, _ or -");

const card = { baseMinor: minor, perKmMinor: minor, perMinMinor: minor, minFareMinor: minor, waitingPerMinMinor: minor };
const ring = z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])).min(3).max(501);
const zoneBody = z.object({
  name: text(80), kind: z.enum(["SERVICE_AREA", "NO_PICKUP", "AIRPORT", "SURGE"]), polygon: ring,
  feeMinor: minor.optional(), surgeMultiplier: z.number().min(1).max(3).optional(),
});
const promoBody = z.object({
  code: promoCode, name: text(80), description: z.string().trim().max(500).nullish(),
  type: z.enum(["PERCENT_OFF", "AMOUNT_OFF"]),
  percentOff: z.number().int().min(1).max(100).nullish(), amountOffMinor: z.number().int().min(100).max(1_000_000).nullish(),
  maxDiscountMinor: z.number().int().min(100).max(1_000_000).nullish(),
  cityIds: z.array(city).max(20).default([]), vehicleTypes: z.array(vehicleType).max(10).default([]),
  startsAt: iso, endsAt: iso,
  perUserLimit: z.number().int().min(1).max(100).default(1), maxRedemptions: z.number().int().min(1).max(10_000_000).nullish(),
  budgetMinor: z.number().int().min(100).max(10_000_000_000), fundedBy: z.enum(["PLATFORM", "PARTNER"]).default("PLATFORM"),
});

export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: RouteDeps & { principal: (req: FastifyRequest) => Promise<Principal>; offered: (cityId: string) => string[] },
) {
  const { zones, rules, promos, db } = deps;

  /** Staff only: a rider token on an admin route is refused like a missing permission. */
  async function staff(req: FastifyRequest) {
    const p = await deps.principal(req);
    if (!isStaff(p)) throw forbidden("staff only");
    return p;
  }

  async function idempotent(req: FastifyRequest, reply: FastifyReply, p: Principal, work: () => Promise<{ statusCode: number; body: unknown }>) {
    const v = req.headers["idempotency-key"];
    const r = await withIdempotency(db, p.userId, typeof v === "string" ? v : undefined, { url: req.url, body: req.body }, work);
    return reply.status(r.statusCode).send(r.body);
  }
  const noStore = (reply: FastifyReply) => reply.header("cache-control", "no-store");

  // ── zones ───────────────────────────────────────────────────────────────────
  app.get("/api/pricing/zones", async (req, reply) => {
    const q = z.object({ cityId: city.optional(), includeArchived: z.enum(["true", "false"]).default("false") }).parse(req.query);
    return noStore(reply).send(await zones.list(await staff(req), { cityId: q.cityId, includeArchived: q.includeArchived === "true" }));
  });
  app.post("/api/pricing/zones/check", async (req) => {
    const body = z.object({ cityId: city, polygon: ring }).parse(req.body);
    return zones.check(await staff(req), body.cityId, body.polygon);
  });
  app.post("/api/pricing/zones", async (req, reply) => {
    const p = await staff(req);
    const body = zoneBody.extend({ cityId: city }).parse(req.body);
    return idempotent(req, reply, p, async () => ({ statusCode: 201, body: { zone: await zones.create(p, body.cityId, body) } }));
  });
  app.get("/api/pricing/zones/:id", async (req, reply) => noStore(reply).send({ zone: await zones.get(await staff(req), id.parse(req.params).id) }));
  app.put("/api/pricing/zones/:id", async (req) => {
    const body = zoneBody.extend({ version: z.number().int().min(1) }).parse(req.body);
    return { zone: await zones.update(await staff(req), id.parse(req.params).id, body.version, body) };
  });
  app.delete("/api/pricing/zones/:id", async (req) => ({ zone: await zones.archive(await staff(req), id.parse(req.params).id) }));

  // ── fare rules and changes ──────────────────────────────────────────────────
  app.get("/api/pricing/fare-rules", async (req, reply) => {
    const { cityId } = z.object({ cityId: city }).parse(req.query);
    return noStore(reply).send(await rules.overview(await staff(req), cityId, deps.offered(cityId)));
  });
  app.get("/api/pricing/fare-changes", async (req, reply) => {
    const q = z.object({
      cityId: city.optional(), status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED", "EXPIRED"]).optional(),
      vehicleType: vehicleType.optional(), limit, before: iso.optional(),
    }).parse(req.query);
    return noStore(reply).send(await rules.list(await staff(req), q));
  });
  app.post("/api/pricing/fare-changes/preview", async (req) => {
    const body = z.object({ cityId: city, vehicleType, ...card }).parse(req.body);
    return rules.preview(await staff(req), body.cityId, body.vehicleType, body);
  });
  app.post("/api/pricing/fare-changes", async (req, reply) => {
    const p = await staff(req);
    const body = z.object({ cityId: city, vehicleType, ...card, validFrom: iso.nullish(), emergency: z.boolean().default(false), reason: text(500) }).parse(req.body);
    return idempotent(req, reply, p, async () => ({ statusCode: 201, body: { change: await rules.propose(p, body) } }));
  });
  app.get("/api/pricing/fare-changes/:id", async (req, reply) => noStore(reply).send({ change: await rules.get(await staff(req), id.parse(req.params).id) }));
  app.post("/api/pricing/fare-changes/:id/approve", async (req) => {
    const { reason } = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    return { change: await rules.approve(await staff(req), id.parse(req.params).id, reason) };
  });
  app.post("/api/pricing/fare-changes/:id/reject", async (req) => {
    const { reason } = z.object({ reason: text(500) }).parse(req.body);
    return { change: await rules.reject(await staff(req), id.parse(req.params).id, reason) };
  });
  app.post("/api/pricing/fare-changes/:id/cancel", async (req) => ({ change: await rules.cancel(await staff(req), id.parse(req.params).id) }));

  // ── promos (staff) ──────────────────────────────────────────────────────────
  app.get("/api/pricing/promos", async (req, reply) => {
    const q = z.object({ cityId: city.optional(), status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "EXHAUSTED", "EXPIRED", "ARCHIVED"]).optional(), limit }).parse(req.query);
    return noStore(reply).send(await promos.list(await staff(req), q));
  });
  app.post("/api/pricing/promos", async (req, reply) => {
    const p = await staff(req);
    const body = promoBody.parse(req.body);
    return idempotent(req, reply, p, async () => ({ statusCode: 201, body: { promo: await promos.create(p, body) } }));
  });
  app.get("/api/pricing/promos/:id", async (req, reply) => noStore(reply).send({ promo: await promos.get(await staff(req), id.parse(req.params).id) }));
  app.put("/api/pricing/promos/:id", async (req) => ({ promo: await promos.update(await staff(req), id.parse(req.params).id, promoBody.parse(req.body)) }));
  app.post("/api/pricing/promos/:id/activate", async (req) => ({ promo: await promos.activate(await staff(req), id.parse(req.params).id) }));
  app.post("/api/pricing/promos/:id/pause", async (req) => ({ promo: await promos.pause(await staff(req), id.parse(req.params).id) }));
  app.post("/api/pricing/promos/:id/resume", async (req) => ({ promo: await promos.resume(await staff(req), id.parse(req.params).id) }));
  app.post("/api/pricing/promos/:id/archive", async (req) => ({ promo: await promos.archive(await staff(req), id.parse(req.params).id) }));
  // promo anomalies (finance, every city): discounts the promo books can't explain
  app.get("/api/pricing/promos/anomalies", async (req, reply) => {
    const q = z.object({ limit }).parse(req.query);
    return noStore(reply).send(await promos.anomalies(await staff(req), q));
  });
  app.get("/api/pricing/promos/:id/redemptions", async (req, reply) => {
    const q = z.object({ limit, before: iso.optional() }).parse(req.query);
    return noStore(reply).send(await promos.redemptions(await staff(req), id.parse(req.params).id, q));
  });

  // ── promos (riders): check a code before estimating ─────────────────────────
  app.post("/api/pricing/promos/check", async (req, reply) => {
    const p = await deps.principal(req);
    const body = z.object({
      code: promoCode, cityId: city.optional(),
      pickup: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
    }).parse(req.body);
    const cityId = body.cityId ?? (body.pickup ? cityAt(body.pickup) : undefined);
    const r = await promos.offer(body.code, p.userId, cityId);
    noStore(reply);
    if ("rejected" in r) return { valid: false, reason: r.rejected, message: REJECTION_MESSAGES[r.rejected], ...(r.promo && r.rejected !== "unknown_code" ? { promo: publicPromo(r.promo) } : {}) };
    return { valid: true, promo: publicPromo(r.promo) };
  });
}
