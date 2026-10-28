// Fastify request logs go through the shared logger's serializers: no query
// strings (share tokens, coordinates) and no token path segments.
import { Writable } from "node:stream";
import Fastify from "fastify";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { loggerOptions, trustProxyFromEnv } from "@ride-app/shared-utils";

describe("request logging", () => {
  it("logs the masked url, never the query string or auth header", async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
    const app = Fastify({ loggerInstance: pino(loggerOptions("support-service", "production"), stream) });
    app.get("/api/trips/shared/:token", async () => ({ ok: true }));
    await app.inject({ method: "GET", url: "/api/trips/shared/very-secret?lat=9.03&lng=38.74", headers: { authorization: "Bearer abc" } });
    await app.close();
    const all = lines.join("\n");
    expect(all).toContain("/api/trips/shared/[redacted]?[redacted]");
    expect(all).not.toContain("very-secret");
    expect(all).not.toContain("38.74");
    expect(all).not.toContain("Bearer abc");
  });

  it("believes only Kong's hop of X-Forwarded-For by default", async () => {
    const app = Fastify({ trustProxy: trustProxyFromEnv(undefined) });
    app.get("/ip", async (req) => ({ ip: req.ip }));
    // the client forged 1.1.1.1; Kong appended the real peer 2.2.2.2
    const r = await app.inject({ method: "GET", url: "/ip", remoteAddress: "10.0.0.9", headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" } });
    await app.close();
    expect(r.json()).toEqual({ ip: "2.2.2.2" });
  });
});
