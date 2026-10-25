import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { bearerToken, TokenError, type VerifyAccessToken } from "@ride-app/shared-authz";
import { unauthorized } from "../lib/errors.js";
import type { Maps } from "../maps.js";

const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const queryPoint = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) });
const language = z.enum(["en", "am"]).default("en");

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

export async function registerRoutes(app: FastifyInstance, deps: { maps: Maps; internalToken: string; verifyAccessToken: VerifyAccessToken }) {
  const { maps } = deps;

  // ── internal: pricing, trip, location (never routed by Kong) ────────────────
  await app.register(async (internal) => {
    const expected = Buffer.from(deps.internalToken);
    internal.addHook("onRequest", async (req) => {
      const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /i, ""));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized("invalid service credentials");
    });

    internal.post("/internal/route", { config: { rateLimit: false } }, async (req) => {
      const body = z.object({ points: z.array(point).min(2).max(10), geometry: z.boolean().default(false) }).parse(req.body);
      return maps.route(body.points, body.geometry);
    });

    internal.post("/internal/table", { config: { rateLimit: false } }, async (req) => {
      const body = z.object({ sources: z.array(point).min(1).max(50), destinations: z.array(point).min(1).max(50) }).parse(req.body);
      return maps.table(body.sources, body.destinations);
    });
  });

  // ── public: the apps (via Kong). Any signed-in user, 60 requests/min each ──
  await app.register(async (pub) => {
    pub.addHook("onRequest", async (req) => {
      const token = bearerToken(req.headers.authorization);
      if (!token) throw unauthorized();
      req.userId = await verifyEither(deps.verifyAccessToken, token);
    });
    await pub.register(rateLimit, {
      max: 60,
      timeWindow: "1 minute",
      hook: "preHandler", // after authentication, so the limit is per user, not per IP
      keyGenerator: (req: FastifyRequest) => req.userId ?? req.ip,
    });

    // destination search while typing (the app debounces ~300 ms)
    pub.get("/api/maps/search", async (req) => {
      const q = z.object({ q: z.string(), cityId: z.string().optional(), language, limit: z.coerce.number().int().min(1).max(10).default(8) }).parse(req.query);
      return { results: await maps.search({ text: q.q, cityId: q.cityId, language: q.language, limit: q.limit }) };
    });

    // label for the pickup pin
    pub.get("/api/maps/reverse", async (req) => {
      const q = queryPoint.extend({ language }).parse(req.query);
      return maps.reverse(q, q.language);
    });

    // move the pickup pin onto the nearest road
    pub.get("/api/maps/snap", async (req) => maps.snap(queryPoint.parse(req.query)));
  });
}

/** Maps are for everyone signed in: phone app (ride-app) and web staff (ride-admin) tokens. */
async function verifyEither(verify: VerifyAccessToken, token: string): Promise<string> {
  try {
    return (await verify(token, "ride-app")).userId;
  } catch (err) {
    if (!(err instanceof TokenError) || err.code !== "invalid_token") throw err;
    return (await verify(token, "ride-admin")).userId;
  }
}
