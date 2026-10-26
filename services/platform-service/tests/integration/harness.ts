// The real app on a test database. auth-service (city sync) is a fake; published settings
// changes are captured instead of going to Redis.

import pino from "pino";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTokenVerifier } from "@ride-app/shared-authz";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { createContainer } from "../../src/container.js";
import { AppError } from "../../src/lib/errors.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

const ISSUER = "http://localhost:3001";
export const uuid = () => crypto.randomUUID();
export const TOKEN = "t".repeat(64);

export async function createHarness() {
  const clock = { now: Date.now() };
  const published: string[] = [];
  const syncedCities: { id: string; name: string }[] = [];
  const identityState = { down: false };
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, INTERNAL_SERVICE_TOKEN: TOKEN, SERVICE_URLS: "auth-service=http://127.0.0.1:9" });

  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" };
  const token = (sub: string, roles: object[]) =>
    new SignJWT({ roles, pv: 0, amr: ["pwd", "otp"] }).setProtectedHeader({ alg: "ES256", kid: "k" })
      .setSubject(sub).setIssuer(ISSUER).setAudience("ride-admin").setIssuedAt().setExpirationTime("15m").sign(privateKey);

  const c = createContainer(config, pino({ level: "silent" }), {
    now: () => new Date(clock.now),
    publisher: { publish: async (_channel, message) => void published.push(message) },
    identity: {
      async upsertCity(city) {
        if (identityState.down) throw new AppError(503, "auth-service is unavailable; try again", "dependency_unavailable");
        syncedCities.push(city);
      },
    },
    verifyAccessToken: createTokenVerifier({ issuer: ISSUER, keySet: createLocalJWKSet({ keys: [jwk as never] }) }),
  });
  await c.catalog.seed();
  const app = await buildApp(c);

  type Who = { id: string; token: string };
  const staff = async (roles: object[], id = uuid()): Promise<Who> => ({ id, token: await token(id, roles) });
  const req = (method: "GET" | "POST" | "PUT", url: string, who: Who | null, payload?: object) =>
    app.inject({ method, url, payload, headers: who ? { authorization: `Bearer ${who.token}` } : {} });

  return {
    app, c, clock, published, syncedCities, identityState, staff, req,
    superAdmin: () => staff([{ r: "SUPER_ADMIN", g: true }]),
    outbox: (topic: string) => c.db.outbox.findMany({ where: { topic }, orderBy: { createdAt: "asc" } }).then((rows) => rows.map((r) => r.payload as Record<string, unknown>)),
    close: async () => {
      await app.close();
      await c.close();
    },
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
