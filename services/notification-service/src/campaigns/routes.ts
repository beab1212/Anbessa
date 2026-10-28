// Campaign HTTP API under /api/notifications (Kong route notification-device-routes):
//   staff (ride-admin token, campaign:send in the campaign's city): /api/notifications/campaigns/*
//   app users (ride-app token): their marketing opt-outs, /api/notifications/me/marketing

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { bearerToken, type Principal, type VerifyAccessToken } from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import { unauthorized } from "../lib/errors.js";
import { withIdempotency } from "./idempotency.js";
import type { CampaignService } from "./service.js";

const id = z.object({ id: z.string().uuid() });
const city = z.string().regex(/^[a-z0-9-]{1,40}$/);
const audience = z.enum(["RIDER", "DRIVER"]);
const channel = z.enum(["PUSH", "SMS"]);
const lastActiveDays = z.coerce.number().int().min(1).max(365);
const body = z.object({
  cityId: city, audience, channel, lastActiveDays: lastActiveDays.nullish(),
  title: z.string().trim().max(80).nullish(), body: z.string().trim().min(1).max(500),
});

export async function registerCampaignRoutes(app: FastifyInstance, deps: { db: Db; campaigns: CampaignService; verifyAccessToken: VerifyAccessToken }) {
  const { campaigns } = deps;

  async function staff(req: FastifyRequest): Promise<Principal> {
    const token = bearerToken(req.headers.authorization);
    if (!token) throw unauthorized();
    return deps.verifyAccessToken(token, "ride-admin");
  }
  async function appUser(req: FastifyRequest): Promise<Principal> {
    const token = bearerToken(req.headers.authorization);
    if (!token) throw unauthorized();
    return deps.verifyAccessToken(token, "ride-app");
  }
  const noStore = (reply: FastifyReply) => reply.header("cache-control", "no-store");

  app.get("/api/notifications/campaigns", async (req, reply) => {
    const q = z.object({
      cityId: city.optional(), status: z.enum(["DRAFT", "AWAITING_APPROVAL", "SCHEDULED", "SENDING", "SENT", "CANCELLED"]).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query);
    return noStore(reply).send(await campaigns.list(await staff(req), q));
  });

  // how many people a segment reaches now (opt-outs excluded)
  app.get("/api/notifications/campaigns/audience", async (req, reply) => {
    const q = z.object({ cityId: city, audience, channel, lastActiveDays: lastActiveDays.optional() }).parse(req.query);
    return noStore(reply).send(await campaigns.audience(await staff(req), q));
  });

  app.post("/api/notifications/campaigns", async (req, reply) => {
    const p = await staff(req);
    const input = body.parse(req.body);
    const v = req.headers["idempotency-key"];
    const r = await withIdempotency(deps.db, p.userId, typeof v === "string" ? v : undefined, { url: req.url, body: req.body }, async () => ({
      statusCode: 201, body: { campaign: await campaigns.create(p, input) },
    }));
    return reply.status(r.statusCode).send(r.body);
  });

  app.get("/api/notifications/campaigns/:id", async (req, reply) => noStore(reply).send({ campaign: await campaigns.get(await staff(req), id.parse(req.params).id) }));

  app.put("/api/notifications/campaigns/:id", async (req) => ({ campaign: await campaigns.update(await staff(req), id.parse(req.params).id, body.parse(req.body)) }));

  // without `at`: send now (quiet hours permitting)
  app.post("/api/notifications/campaigns/:id/schedule", async (req) => {
    const { at } = z.object({ at: z.string().datetime({ offset: true }).optional() }).parse(req.body ?? {});
    return { campaign: await campaigns.schedule(await staff(req), id.parse(req.params).id, at) };
  });

  // maker-checker: a campaign over CAMPAIGN_APPROVAL_THRESHOLD recipients waits for a second staff member
  app.post("/api/notifications/campaigns/:id/approve", async (req) => ({ campaign: await campaigns.approve(await staff(req), id.parse(req.params).id) }));

  app.post("/api/notifications/campaigns/:id/cancel", async (req) => ({ campaign: await campaigns.cancel(await staff(req), id.parse(req.params).id) }));

  // ── the app user's marketing preferences ────────────────────────────────────
  app.get("/api/notifications/me/marketing", async (req, reply) => noStore(reply).send(await campaigns.optOuts((await appUser(req)).userId)));
  app.put("/api/notifications/me/marketing", async (req) => {
    const prefs = z.object({ push: z.boolean().optional(), sms: z.boolean().optional() }).parse(req.body);
    return campaigns.setOptOuts((await appUser(req)).userId, prefs);
  });
}
