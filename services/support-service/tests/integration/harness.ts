// The real app on a test database and its own Redis (deny list). trip-service is a fake whose trips
// the tests set; pushes to the phone app are captured.

import pino from "pino";
import { Redis } from "ioredis";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTokenVerifier } from "@ride-app/shared-authz";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { createContainer } from "../../src/container.js";
import { TripServiceUnavailable, type TripFacts } from "../../src/lib/trips.js";
import { TEST_DATABASE_URL, TEST_REDIS_URL } from "./global-setup.js";

const ISSUER = "http://localhost:3001";
export const uuid = () => crypto.randomUUID();
export const TOKEN = "t".repeat(64);

export type Who = { id: string; token: string };

export async function createHarness() {
  const clock = { now: Date.now() };
  const trips = new Map<string, TripFacts>();
  const tripState = { down: false };
  const pushes: { userId: string; event: string; payload: unknown }[] = [];
  const redis = new Redis(TEST_REDIS_URL);
  await redis.flushdb();
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, INTERNAL_SERVICE_TOKEN: TOKEN });

  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" };
  const sign = (sub: string, roles: object[], aud: "ride-app" | "ride-admin") =>
    new SignJWT({ roles, pv: 0, amr: aud === "ride-admin" ? ["pwd", "otp"] : ["otp"] }).setProtectedHeader({ alg: "ES256", kid: "k" })
      .setSubject(sub).setIssuer(ISSUER).setAudience(aud).setIssuedAt().setExpirationTime("15m").sign(privateKey);

  const c = createContainer(config, pino({ level: "silent" }), {
    now: () => new Date(clock.now),
    realtime: { toUser: (userId, event, payload) => void pushes.push({ userId, event, payload }) },
    trips: {
      async get(id) {
        if (tripState.down) throw new TripServiceUnavailable();
        return trips.get(id) ?? null;
      },
    },
    verifyAccessToken: createTokenVerifier({
      issuer: ISSUER, keySet: createLocalJWKSet({ keys: [jwk as never] }),
      isDenied: async (userId) => (await redis.exists(`deny:${userId}`)) === 1,
    }),
  });
  const app = await buildApp(c);

  const appUser = async (roles: object[] = [{ r: "RIDER" }], id = uuid()): Promise<Who> => ({ id, token: await sign(id, roles, "ride-app") });
  const staff = async (roles: object[], id = uuid()): Promise<Who> => ({ id, token: await sign(id, roles, "ride-admin") });

  type Method = "GET" | "POST" | "PATCH";
  const req = (method: Method, url: string, who: Who | null, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url, payload, headers: { ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...headers } });

  /** A trip in trip-service (the fake). */
  const trip = (t: Partial<TripFacts> & { riderUserId: string }): TripFacts => {
    const full: TripFacts = {
      id: uuid(), status: "in_progress", cityId: "addis-ababa", bookedByUserId: t.riderUserId, driverUserId: null,
      billingOrgId: null, fleetOrgId: null, completedAt: null, ...t,
    };
    trips.set(full.id, full);
    return full;
  };

  return {
    app, c, clock, trips, tripState, pushes, redis, appUser, staff, req, trip,
    outbox: (topic: string) => c.db.outbox.findMany({ where: { topic }, orderBy: { createdAt: "asc" } }).then((rows) => rows.map((r) => r.payload as Record<string, unknown>)),
    close: async () => {
      await app.close();
      await c.close();
      redis.disconnect();
    },
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
