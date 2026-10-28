import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { Redis } from "ioredis";
import { z } from "zod";
import { bearerToken, type VerifyAccessToken } from "@ride-app/shared-authz";
import { goOffline, goOnline } from "@ride-app/shared-location";
import { notFound, unauthorized } from "../lib/errors.js";
import type { Locations } from "../locations.js";
import { schemas } from "../events/handlers.js";

const at = { lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) };
const where = { cityId: z.string().min(1).max(40), vehicleType: z.string().min(1).max(30) };

export async function registerRoutes(
  app: FastifyInstance,
  deps: { locations: Locations; redis: Redis; internalToken: string; verifyAccessToken: VerifyAccessToken; devRoutes: boolean },
) {
  const { locations } = deps;

  // ── internal: trip-service (matching), pricing (quotes) ─────────────────────
  await app.register(async (internal) => {
    const expected = Buffer.from(deps.internalToken);
    internal.addHook("onRequest", async (req) => {
      const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /i, ""));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized("invalid service credentials");
    });

    internal.get("/internal/drivers/nearby", { config: { rateLimit: false } }, async (req) => {
      const q = z.object({
        ...at, ...where,
        radiusMeters: z.coerce.number().int().min(100).max(20_000).default(2000),
        limit: z.coerce.number().int().min(1).max(50).default(20),
        cashOnly: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
      }).parse(req.query);
      return { drivers: await locations.nearby(q) };
    });

    internal.get("/internal/eta-to-pickup", { config: { rateLimit: false } }, async (req) => {
      const q = z.object({ ...at, ...where, cashOnly: z.enum(["true", "false"]).default("false").transform((v) => v === "true") }).parse(req.query);
      return locations.etaToPickup(q);
    });

    internal.get("/internal/drivers/:driverId", { config: { rateLimit: false } }, async (req) => {
      const { driverId } = z.object({ driverId: z.string().uuid() }).parse(req.params);
      const state = await locations.driver(driverId);
      if (!state) throw notFound("driver");
      return state;
    });

    // Development only: stand-in for fleet-service's driver.online / driver.offline,
    // so drivers can go online before fleet-service exists. Never registered in production.
    if (deps.devRoutes) {
      internal.post("/internal/dev/drivers/:driverId/online", async (req, reply) => {
        const { driverId } = z.object({ driverId: z.string().uuid() }).parse(req.params);
        const body = schemas["driver.online"].omit({ driverId: true }).parse(req.body);
        await goOnline(deps.redis, { driverId, ...body });
        return reply.status(204).send();
      });
      internal.post("/internal/dev/drivers/:driverId/offline", async (req, reply) => {
        const { driverId } = z.object({ driverId: z.string().uuid() }).parse(req.params);
        await goOffline(deps.redis, driverId);
        return reply.status(204).send();
      });
    }
  });

  // ── public (via Kong) ────────────────────────────────────────────────────────
  const principal = async (authorization: string | undefined, audience: "ride-app" | "ride-admin") => {
    const token = bearerToken(authorization);
    if (!token) throw unauthorized();
    return deps.verifyAccessToken(token, audience);
  };

  // ops map for dispatchers and safety (location:read_live @ CITY)
  app.get("/api/locations/cities/:cityId/drivers", async (req) => {
    const { cityId } = z.object({ cityId: z.string().min(1).max(40) }).parse(req.params);
    return { drivers: await locations.cityDrivers(await principal(req.headers.authorization, "ride-admin"), cityId) };
  });

  // rider screen fallback when the socket is reconnecting (the trip's rider/driver, or the vehicle's fleet owner)
  app.get("/api/locations/trips/:tripId/driver", async (req) => {
    const { tripId } = z.object({ tripId: z.string().uuid() }).parse(req.params);
    return locations.tripDriver(await principal(req.headers.authorization, "ride-app"), tripId);
  });

  // rider home: anonymous cars around you (polled every ~10 s; 30/min per person)
  await app.register(async (pub) => {
    pub.addHook("onRequest", async (req) => {
      (req as FastifyRequest & { userId?: string }).userId = (await principal(req.headers.authorization, "ride-app")).userId;
    });
    await pub.register(rateLimit, { max: 30, timeWindow: "1 minute", hook: "preHandler", keyGenerator: (req: FastifyRequest) => (req as FastifyRequest & { userId?: string }).userId ?? req.ip });
    pub.get("/api/locations/nearby", async (req) => {
      const q = z.object({ ...at, vehicleType: z.string().min(1).max(30).optional() }).parse(req.query);
      return locations.nearbyPublic(q, (req as FastifyRequest & { userId?: string }).userId);
    });
  });
}
