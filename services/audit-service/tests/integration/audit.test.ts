import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTokenVerifier } from "@ride-app/shared-authz";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { createContainer } from "../../src/container.js";
import { createConsumer } from "../../src/events/consumer.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

const ISSUER = "http://localhost:3001";
let c: ReturnType<typeof createContainer>;
let app: Awaited<ReturnType<typeof buildApp>>;
let handle: (value: string | undefined) => Promise<void>;
let token: (roles: object[]) => Promise<string>;

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, INTERNAL_SERVICE_TOKEN: "t".repeat(64) });
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" };
  token = (roles) => new SignJWT({ roles, pv: 0, amr: ["pwd", "otp"] }).setProtectedHeader({ alg: "ES256", kid: "k" })
    .setSubject(crypto.randomUUID()).setIssuer(ISSUER).setAudience("ride-admin").setIssuedAt().setExpirationTime("15m").sign(privateKey);
  c = createContainer(config, { verifyAccessToken: createTokenVerifier({ issuer: ISSUER, keySet: createLocalJWKSet({ keys: [jwk as never] }) }) });
  app = await buildApp(c);
  handle = createConsumer({ brokers: ["unused:9092"], store: c.store, logger: pino({ level: "silent" }), createTopics: false }).handle;
});
afterAll(async () => {
  await app?.close();
  await c?.close();
});

const event = (over: Record<string, unknown> = {}) => ({
  eventId: crypto.randomUUID(), version: 1, at: new Date().toISOString(), actorId: crypto.randomUUID(), action: "role:approve",
  resource: { type: "approval_request", id: crypto.randomUUID() }, outcome: "EXECUTED", reason: "night shift cover", service: "auth-service", ...over,
});

describe("audit log", () => {
  it("stores each event once (replays are ignored) and skips invalid messages", async () => {
    const e = event();
    await handle(JSON.stringify(e));
    await handle(JSON.stringify(e));
    await handle("{not json");
    await handle(JSON.stringify({ ...event(), outcome: "MAYBE" }));
    expect(await c.db.auditEntry.count({ where: { eventId: e.eventId } })).toBe(1);
  });

  it("is write-once at the database", async () => {
    const e = event();
    await handle(JSON.stringify(e));
    await expect(c.db.auditEntry.updateMany({ where: { eventId: e.eventId }, data: { reason: "rewritten" } })).rejects.toThrow(/write-once/);
    await expect(c.db.auditEntry.deleteMany({ where: { eventId: e.eventId } })).rejects.toThrow(/write-once/);
  });

  it("searches by actor, action and resource with a cursor; exports CSV and records the export", async () => {
    const actorId = crypto.randomUUID();
    for (let i = 0; i < 5; i++) await handle(JSON.stringify(event({ actorId, action: i % 2 ? "settings:change" : "authz:change", at: new Date(Date.now() - i * 1000).toISOString() })));
    const admin = await token([{ r: "SUPER_ADMIN", g: true }]);
    const get = (url: string, t = admin) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${t}` } });

    const page1 = (await get(`/api/audit/entries?actorId=${actorId}&limit=3`)).json<{ entries: { action: string }[]; next: string }>();
    expect(page1.entries).toHaveLength(3);
    const page2 = (await get(`/api/audit/entries?actorId=${actorId}&limit=3&cursor=${encodeURIComponent(page1.next)}`)).json<{ entries: unknown[]; next: string | null }>();
    expect(page2.entries).toHaveLength(2);
    expect(page2.next).toBeNull();
    expect((await get(`/api/audit/entries?actorId=${actorId}&action=settings`)).json<{ entries: unknown[] }>().entries).toHaveLength(2);

    const csv = await get(`/api/audit/entries.csv?actorId=${actorId}`);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.trim().split("\n")).toHaveLength(6);
    expect(await c.db.auditEntry.count({ where: { action: "audit_log:export" } })).toBe(1);

    const dispatcher = await token([{ r: "DISPATCHER", city: "addis-ababa" }]);
    expect((await get("/api/audit/entries", dispatcher)).statusCode).toBe(403);
  });
});
