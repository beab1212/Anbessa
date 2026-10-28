// The real app on a test database, with fakes for Telegram, SMS and push,
// an in-memory OTP store, and a clock the tests can move.

import { createHash, createHmac } from "node:crypto";
import pino from "pino";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { FastifyInstance } from "fastify";
import { createTokenVerifier } from "@ride-app/shared-authz";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { createContainer, type Container } from "../../src/container.js";
import type { PushMessage, PushSender } from "../../src/channels/push.js";
import { memoryOtpStore } from "../../src/otp/otp-store.js";
import { TelegramGatewayError, type RequestStatus, type TelegramGateway } from "../../src/otp/telegram-gateway.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

export const INTERNAL_TOKEN = "i".repeat(64);
export const TELEGRAM_TOKEN = "telegram-test-token-0123456789";
const ISSUER = "http://localhost:3001";

export function fakeTelegram() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const state = { unreachable: new Set<string>(), sendFails: false, n: 0 };
  const gw: TelegramGateway = {
    async checkSendAbility(phone_number) {
      calls.push({ method: "checkSendAbility", params: { phone_number } });
      if (state.unreachable.has(phone_number)) throw new TelegramGatewayError("checkSendAbility", "PHONE_NUMBER_NOT_AVAILABLE");
      return { request_id: `req-${++state.n}`, request_cost: 0.01, remaining_balance: 50 };
    },
    async sendVerificationMessage(params) {
      calls.push({ method: "sendVerificationMessage", params });
      if (state.sendFails) throw new TelegramGatewayError("sendVerificationMessage", "INTERNAL");
      return { request_id: params.request_id ?? `req-${++state.n}`, request_cost: 0.01, remaining_balance: 49.99 } as RequestStatus;
    },
    async checkVerificationStatus(request_id, code) {
      calls.push({ method: "checkVerificationStatus", params: { request_id, code } });
      return { request_id, verification_status: { status: "code_valid", updated_at: 0 } };
    },
    async revokeVerificationMessage(request_id) {
      calls.push({ method: "revokeVerificationMessage", params: { request_id } });
      return true;
    },
  };
  return { gw, calls, state };
}

export async function createHarness() {
  const clock = { now: Date.now() };
  const now = () => new Date(clock.now);
  const telegram = fakeTelegram();
  const smsSent: { to: string; body: string }[] = [];
  const pushes: { token: string; message: PushMessage }[] = [];
  const pushState = { fail: false, unregistered: new Set<string>() };
  const push: PushSender = {
    async send(token, message) {
      if (pushState.fail) throw new Error("fcm 503");
      if (pushState.unregistered.has(token)) return "unregistered";
      pushes.push({ token, message });
      return "sent";
    },
  };

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: "redis://unused.invalid:6379",
    INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
    PHONE_HASH_KEY: "a".repeat(64),
    OTP_ENCRYPTION_KEY: "b".repeat(64),
    TELEGRAM_GATEWAY_TOKEN: TELEGRAM_TOKEN,
    TELEGRAM_CALLBACK_URL: "https://api.anbessa.test/api/webhooks/telegram-gateway",
    OTP_FALLBACK_SECONDS: "20",
  });
  const store = memoryOtpStore(() => clock.now);
  // phone numbers auth-service would give for SMS campaigns
  const phones = new Map<string, string>();
  const c: Container = createContainer(config, pino({ level: "silent" }), {
    store, telegram: telegram.gw, push, now,
    sms: { send: async (to, body) => (smsSent.push({ to, body }), {}) },
    contacts: { phoneOf: async (userId) => phones.get(userId) ?? null },
  });

  // tokens signed by a local key pair stand in for auth-service's JWTs
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "ES256" };
  const verifyAccessToken = createTokenVerifier({ issuer: ISSUER, keySet: createLocalJWKSet({ keys: [jwk] }) });
  const appToken = (sub: string) =>
    new SignJWT({ roles: [{ r: "RIDER" }], pv: 0, amr: ["otp"] })
      .setProtectedHeader({ alg: "ES256", kid: "test" }).setSubject(sub).setIssuer(ISSUER).setAudience("ride-app")
      .setIssuedAt().setExpirationTime("15m").sign(privateKey);
  const staffToken = (sub: string, roles: object[]) =>
    new SignJWT({ roles, pv: 0, amr: ["pwd", "otp"] })
      .setProtectedHeader({ alg: "ES256", kid: "test" }).setSubject(sub).setIssuer(ISSUER).setAudience("ride-admin")
      .setIssuedAt().setExpirationTime("15m").sign(privateKey);

  const app: FastifyInstance = await buildApp({ ...c, verifyAccessToken });
  await app.ready();

  const internal = (url: string, payload: object, token = INTERNAL_TOKEN) =>
    app.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${token}` } });

  const report = (body: object, opts: { tsOffset?: number; badSig?: boolean } = {}) => {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000) + (opts.tsOffset ?? 0));
    const sig = createHmac("sha256", createHash("sha256").update(TELEGRAM_TOKEN).digest()).update(`${ts}\n${raw}`).digest("hex");
    return app.inject({
      method: "POST", url: "/api/webhooks/telegram-gateway", payload: raw,
      headers: { "content-type": "application/json", "x-request-timestamp": ts, "x-request-signature": opts.badSig ? sig.replace(/^./, "0") : sig },
    });
  };

  return {
    app, c, clock, store, telegram, smsSent, pushes, pushState, internal, report, appToken, staffToken, phones, verifyAccessToken, now,
    close: async () => { await app.close(); await c.close(); },
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

let n = 0;
export const phone = () => `+2519${String(Date.now() % 1e4).padStart(4, "0")}${String(n++ % 1e4).padStart(4, "0")}`;
