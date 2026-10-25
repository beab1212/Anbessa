import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { bearerToken, type VerifyAccessToken } from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import { unauthorized } from "../lib/errors.js";
import type { OtpService } from "../otp/otp-service.js";
import type { RequestStatus } from "../otp/telegram-gateway.js";

const MAX_DEVICES_PER_USER = 10;

export interface RouteDeps {
  db: Db;
  otp: OtpService;
  internalToken: string;
  verifyAccessToken: VerifyAccessToken;
  /** undefined when Telegram isn't configured: the webhook then doesn't exist */
  verifyTelegramReport?: (rawBody: string, timestamp?: string, signature?: string) => boolean;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  // ── internal: auth-service only (never routed by Kong) ──────────────────────
  // Interim shared-secret auth until mTLS (Auth.md §17, I7).
  const expected = Buffer.from(deps.internalToken);
  const requireService = (req: FastifyRequest) => {
    const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /i, ""));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized("invalid service credentials");
  };

  const otpBody = z.object({
    phoneNumber: z.string(),
    code: z.string(),
    ttlSeconds: z.number().int(),
    purpose: z.enum(["sign_in", "phone_change", "claim_guest"]),
  });

  // auth-service already rate-limits OTP requests per number and per IP
  app.post("/internal/otp-deliveries", { config: { rateLimit: false } }, async (req, reply) => {
    requireService(req);
    const { deliveryId, channel } = await deps.otp.deliver(otpBody.parse(req.body));
    return reply.status(202).send({ deliveryId, channel });
  });

  app.post("/internal/otp-deliveries/verified", { config: { rateLimit: false } }, async (req) => {
    requireService(req);
    const { phoneNumber } = z.object({ phoneNumber: z.string() }).parse(req.body);
    return deps.otp.verified(phoneNumber);
  });

  // ── Telegram Gateway delivery reports (public, via Kong) ────────────────────
  // The signature is the authentication, so the raw body is needed: parse JSON ourselves.
  const verifyReport = deps.verifyTelegramReport;
  if (verifyReport) {
    await app.register(async (scope) => {
      scope.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 16 * 1024 }, (_req, body, done) => done(null, body));
      scope.post("/api/webhooks/telegram-gateway", async (req, reply) => {
        const raw = typeof req.body === "string" ? req.body : "";
        const ts = req.headers["x-request-timestamp"];
        const sig = req.headers["x-request-signature"];
        if (!verifyReport(raw, typeof ts === "string" ? ts : undefined, typeof sig === "string" ? sig : undefined)) {
          return reply.status(401).send({ error: "invalid_signature", message: "invalid signature" });
        }
        let report: RequestStatus;
        try {
          report = JSON.parse(raw);
        } catch {
          return reply.status(400).send({ error: "bad_request", message: "invalid JSON" });
        }
        // answer fast: Telegram retries up to 10 times on non-200
        await deps.otp.onReport(report);
        return reply.status(200).send({ ok: true });
      });
    });
  }

  // ── device tokens (phone app / web, signed-in users) ────────────────────────
  const currentUser = async (req: FastifyRequest) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) throw unauthorized();
    return (await deps.verifyAccessToken(token, "ride-app")).userId;
  };

  app.post("/api/notifications/devices", async (req, reply) => {
    const userId = await currentUser(req);
    const body = z.object({ token: z.string().min(20).max(4096), platform: z.enum(["android", "ios", "web"]) }).parse(req.body);
    // A device token belongs to the device: whoever signed in on it last receives its pushes.
    await deps.db.deviceToken.upsert({
      where: { token: body.token },
      create: { token: body.token, platform: body.platform, userId },
      update: { userId, platform: body.platform, lastSeenAt: new Date() },
    });
    const extra = await deps.db.deviceToken.findMany({
      where: { userId }, orderBy: { lastSeenAt: "desc" }, skip: MAX_DEVICES_PER_USER, select: { id: true },
    });
    if (extra.length) await deps.db.deviceToken.deleteMany({ where: { id: { in: extra.map((d) => d.id) } } });
    return reply.status(204).send();
  });

  // Called on sign-out, so a shared phone stops receiving the previous user's pushes.
  app.post("/api/notifications/devices/remove", async (req, reply) => {
    const userId = await currentUser(req);
    const { token } = z.object({ token: z.string().min(1).max(4096) }).parse(req.body);
    await deps.db.deviceToken.deleteMany({ where: { token, userId } });
    return reply.status(204).send();
  });
}
