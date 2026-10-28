// pricing-service HTTP API under /api/pricing (Kong route), plus the internal quote lookup that
// trip-service uses when a trip is requested and the internal quote it asks for when it re-prices a
// scheduled ride at dispatch. Staff administration (zones, fare changes, promos)
// is in admin-routes.ts.

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { bearerToken, TokenError, type Principal, type VerifyAccessToken } from "@ride-app/shared-authz";
import { cityAt } from "@ride-app/shared-location";
import type { SettingsReader } from "@ride-app/shared-settings";
import { badRequest, notFound, unauthorized } from "../lib/errors.js";
import type { Db } from "../db.js";
import type { PromoService } from "../promos/service.js";
import type { Quotes } from "../quotes.js";
import type { RuleService } from "../rules/service.js";
import type { ZoneService } from "../zones/service.js";
import { promoCode, registerAdminRoutes } from "./admin-routes.js";

const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const BUILT_IN_TYPES = ["economy", "comfort", "minivan"];

export interface RouteDeps {
  db: Db;
  quotes: Quotes;
  promos: PromoService;
  rules: RuleService;
  zones: ZoneService;
  settings: SettingsReader;
  verifyAccessToken: VerifyAccessToken;
  internalToken: string;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { quotes, settings } = deps;

  /** Riders and partners (ride-app) and the call center (ride-admin) all ask for estimates. */
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

  /** Vehicle types offered in a city: the admin catalog (Cities and vehicles), or the built-in three. */
  function offered(cityId: string) {
    const catalog = settings.snapshot().vehicleTypes;
    if (catalog.length === 0) return BUILT_IN_TYPES;
    return catalog.filter((v) => v.enabled && (v.cities.length === 0 || v.cities.includes(cityId))).map((v) => v.code);
  }

  app.post("/api/pricing/estimates", async (req) => {
    const p = await principal(req);
    const body = z.object({
      pickup: point, dropoff: point,
      vehicleTypes: z.array(z.string().regex(/^[a-z0-9_]{1,30}$/)).min(1).max(5).optional(),
      pickupAddress: z.string().max(200).optional(), dropoffAddress: z.string().max(200).optional(),
      promoCode: promoCode.optional(),
    }).parse(req.body);
    const cityId = cityAt(body.pickup);
    const available = cityId ? offered(cityId) : BUILT_IN_TYPES;
    const wanted = body.vehicleTypes ?? available;
    const refused = wanted.filter((t) => !available.includes(t));
    if (cityId && refused.length) throw badRequest(`not offered in this city: ${refused.join(", ")}`, "vehicle_type_unavailable");
    return quotes.estimateWithRoute({ ...body, vehicleTypes: wanted, requestedBy: p.userId });
  });

  // the fare card (public: shown in the apps before signing in)
  app.get("/api/pricing/fares", async (req, reply) => {
    const { cityId } = z.object({ cityId: z.string().regex(/^[a-z0-9-]{1,40}$/) }).parse(req.query);
    return reply.header("cache-control", "public, max-age=60").send({ cityId, fares: await quotes.fareCards(cityId, offered(cityId)) });
  });

  // ── internal: trip-service reads a quote (booking) and asks for one (scheduled dispatch) ──
  await app.register(async (internal) => {
    const expected = Buffer.from(deps.internalToken);
    internal.addHook("onRequest", async (req) => {
      const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /i, ""));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized("invalid service credentials");
    });
    internal.get("/internal/quotes/:id", { config: { rateLimit: false } }, async (req) => {
      const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
      // ?tripId=&userId=: reading the quote to book that trip makes its promo discount BOOKED for
      // it (or drops it when it can't be given); without them the quote comes without a discount
      const q0 = z.object({ tripId: z.string().uuid().optional(), userId: z.string().uuid().optional() }).parse(req.query);
      const q = await quotes.forBooking(id, q0.tripId && q0.userId ? { tripId: q0.tripId, userId: q0.userId } : undefined);
      if (!q) throw notFound("quote");
      return q;
    });

    // trip-service booked the quote's discount for a trip it then didn't create: hold it again
    internal.post("/internal/quotes/:id/unbook", { config: { rateLimit: false } }, async (req) => {
      const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
      const { tripId } = z.object({ tripId: z.string().uuid() }).parse(req.body);
      return { unbooked: await quotes.unbook(id, tripId) };
    });

    // a quote made by a service for a user: trip-service re-prices a scheduled ride shortly before
    // dispatch (workflow 12). Same pricing as an estimate (rule in force, zones, ETA) but never a
    // promo; the quote is stored like any other so it can be read back by id.
    internal.post("/internal/quotes", { config: { rateLimit: false } }, async (req) => {
      const body = z.object({
        requestedBy: z.string().uuid(),
        cityId: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
        vehicleType: z.string().regex(/^[a-z0-9_]{1,30}$/).optional(),
        vehicleTypes: z.array(z.string().regex(/^[a-z0-9_]{1,30}$/)).min(1).max(5).optional(),
        pickup: point, dropoff: point,
        pickupAddress: z.string().max(200).optional(), dropoffAddress: z.string().max(200).optional(),
      }).parse(req.body);
      const wanted = [...new Set(body.vehicleTypes ?? (body.vehicleType ? [body.vehicleType] : []))];
      if (wanted.length === 0) throw badRequest("vehicleType or vehicleTypes is required");
      const cityId = cityAt(body.pickup);
      if (!cityId) throw badRequest("pickup is outside the served cities", "outside_service_area");
      if (body.cityId && body.cityId !== cityId) throw badRequest(`the pickup is in ${cityId}, not ${body.cityId}`, "city_mismatch");
      const refused = wanted.filter((t) => !offered(cityId).includes(t));
      if (refused.length) throw badRequest(`not offered in this city: ${refused.join(", ")}`, "vehicle_type_unavailable");
      return quotes.estimateWithRoute({
        requestedBy: body.requestedBy, pickup: body.pickup, dropoff: body.dropoff, vehicleTypes: wanted,
        ...(body.pickupAddress ? { pickupAddress: body.pickupAddress } : {}), ...(body.dropoffAddress ? { dropoffAddress: body.dropoffAddress } : {}),
      });
    });
  });

  await registerAdminRoutes(app, { ...deps, principal, offered });
}
