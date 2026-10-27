// The real app on a test database and its own Redis (quotes, deny list). mapping- and
// location-service are fakes; fares come from static settings; the clock is the tests'.

import pino from "pino";
import { Redis } from "ioredis";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTokenVerifier } from "@ride-app/shared-authz";
import { staticSettings } from "@ride-app/shared-settings";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { createContainer } from "../../src/container.js";
import { createConsumer } from "../../src/events/consumer.js";
import { TEST_DATABASE_URL, TEST_REDIS_URL } from "./global-setup.js";

const ISSUER = "http://localhost:3001";
export const uuid = () => crypto.randomUUID();
export const TOKEN = "t".repeat(64);
export const BOLE = { lat: 8.9806, lng: 38.7578 };
export const PIASSA = { lat: 9.0349, lng: 38.7469 };
export const HAWASSA = { lat: 7.05, lng: 38.47 };

export type Who = { id: string; token: string };

export async function createHarness() {
  const clock = { now: Date.now() };
  const redis = new Redis(TEST_REDIS_URL);
  await redis.flushdb();
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, REDIS_URL: TEST_REDIS_URL, INTERNAL_SERVICE_TOKEN: TOKEN, PROMO_APPROVAL_THRESHOLD_MINOR: "1000000" });

  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" };
  const sign = (sub: string, roles: object[], aud: "ride-app" | "ride-admin") =>
    new SignJWT({ roles, pv: 0, amr: aud === "ride-admin" ? ["pwd", "otp"] : ["otp"] }).setProtectedHeader({ alg: "ES256", kid: "k" })
      .setSubject(sub).setIssuer(ISSUER).setAudience(aud).setIssuedAt().setExpirationTime("15m").sign(privateKey);

  // 6 km, 15 min for every route: economy (registry defaults) 50 + 90 + 30 = 170 birr
  const settings = staticSettings({});
  const c = createContainer(config, pino({ level: "silent" }), {
    redis, settings,
    now: () => new Date(clock.now),
    mapping: { route: async (_p, geometry = false) => ({ distanceMeters: 6000, durationSeconds: 900, approximate: false, ...(geometry ? { geometry: "_p~iF~ps|U_ulLnnqC" } : {}) }) },
    location: { etaToPickup: async () => ({ etaSeconds: 300, driversNearby: 2, approximate: false }) },
    verifyAccessToken: createTokenVerifier({
      issuer: ISSUER, keySet: createLocalJWKSet({ keys: [jwk as never] }),
      isDenied: async (userId) => (await redis.exists(`deny:${userId}`)) === 1,
    }),
  });
  const app = await buildApp({ ...c, ready: async () => true });
  const consumer = createConsumer({ brokers: ["127.0.0.1:1"], promos: c.promos, logger: pino({ level: "silent" }), createTopics: false });

  const rider = async (id = uuid()): Promise<Who> => ({ id, token: await sign(id, [{ r: "RIDER" }], "ride-app") });
  const staff = async (roles: object[], id = uuid()): Promise<Who> => ({ id, token: await sign(id, roles, "ride-admin") });

  type Method = "GET" | "POST" | "PUT" | "DELETE";
  const req = (method: Method, url: string, who: Who | null, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url, payload, headers: { ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...headers } });
  const internal = (url: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${TOKEN}` } });

  return {
    app, c, clock, redis, rider, staff, req, internal, consumer,
    outbox: (topic: string) => c.db.outbox.findMany({ where: { topic }, orderBy: { createdAt: "asc" } }).then((rows) => rows.map((r) => r.payload as Record<string, unknown>)),
    close: async () => {
      await app.close();
      await c.close();
      redis.disconnect();
    },
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
