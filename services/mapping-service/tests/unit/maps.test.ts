// mapping-service against a local HTTP server that answers like OSRM v1 and Nominatim (jsonv2),
// so the real HTTP clients, timeouts, breaker, cache and fallbacks are all exercised.

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTokenVerifier } from "@ride-app/shared-authz";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { createContainer } from "../../src/container.js";
import type { Cache } from "../../src/lib/cache.js";

const INTERNAL = "m".repeat(64);
const ISSUER = "http://localhost:3001";
const BOLE = { lat: 8.9806, lng: 38.7578 };
const PIASSA = { lat: 9.0333, lng: 38.75 };

const engine = { down: false, slowMs: 0, noRoute: false, hits: [] as string[] };
let server: Server;
let base = "";

function fakeEngines(): Promise<void> {
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    engine.hits.push(url.pathname + url.search);
    const send = (status: number, body: unknown) =>
      setTimeout(() => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body))), engine.slowMs);
    if (engine.down) return send(503, { message: "down" });
    if (url.pathname.startsWith("/route/v1/driving/")) {
      if (engine.noRoute) return send(400, { code: "NoRoute", message: "Impossible route" });
      const withSteps = url.searchParams.get("steps") === "true";
      return send(200, {
        code: "Ok",
        routes: [{
          distance: 7412.6, duration: 943.2,
          geometry: url.searchParams.get("overview") === "full" ? "_p~iF~ps|U_ulLnnqC" : undefined,
          ...(withSteps ? { legs: [{ steps: [
            { distance: 120.4, duration: 20.1, name: "Africa Avenue", maneuver: { type: "depart", location: [38.7578, 8.9806], bearing_after: 12 } },
            { distance: 7292.2, duration: 923.1, name: "Churchill Avenue", maneuver: { type: "turn", modifier: "left", location: [38.76, 8.99], bearing_after: 270 } },
            { distance: 0, duration: 0, name: "", maneuver: { type: "arrive", location: [38.75, 9.0333], bearing_after: 0 } },
          ] }] } : {}),
        }],
      });
    }
    if (url.pathname.startsWith("/table/v1/driving/")) {
      const s = url.searchParams.get("sources")!.split(";").length;
      const d = url.searchParams.get("destinations")!.split(";").length;
      return send(200, { code: "Ok", durations: Array.from({ length: s }, (_, i) => Array.from({ length: d }, (_, j) => 100.4 * (i + 1) + j)), distances: Array.from({ length: s }, () => Array(d).fill(1000.6)) });
    }
    if (url.pathname.startsWith("/nearest/v1/driving/")) {
      return send(200, { code: "Ok", waypoints: [{ location: [38.75801, 8.98071], distance: 12.3, name: "Africa Avenue" }] });
    }
    if (url.pathname === "/search") {
      return send(200, [{ lat: "8.9779", lon: "38.7993", name: "Bole International Airport", display_name: "Bole International Airport, Bole, Addis Ababa, Ethiopia", category: "aeroway", type: "aerodrome" }]);
    }
    if (url.pathname === "/reverse") return send(200, { lat: "8.9806", lon: "38.7578", name: "", display_name: "Africa Avenue, Bole, Addis Ababa, Ethiopia" });
    send(404, {});
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => ((base = `http://127.0.0.1:${(server.address() as { port: number }).port}`), r())));
}

function memoryCache(): Cache & { size: () => number } {
  const m = new Map<string, unknown>();
  return { get: async (k) => m.get(k) as never, set: async (k, v) => void m.set(k, v), size: () => m.size };
}

let app: Awaited<ReturnType<typeof buildApp>>;
let token: (sub: string, aud?: "ride-app" | "ride-admin") => Promise<string>;
let cache: ReturnType<typeof memoryCache>;
let publicJwk: object;

beforeAll(async () => {
  await fakeEngines();
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  publicJwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" };
  token = (sub, aud = "ride-app") =>
    new SignJWT({ roles: [], pv: 0, amr: ["otp"] }).setProtectedHeader({ alg: "ES256", kid: "k" })
      .setSubject(sub).setIssuer(ISSUER).setAudience(aud).setIssuedAt().setExpirationTime("15m").sign(privateKey);
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(async () => {
  engine.down = false;
  engine.slowMs = 0;
  engine.noRoute = false;
  engine.hits.length = 0;
  cache = memoryCache();
  const config = loadConfig({ NODE_ENV: "test", OSRM_URL: base, NOMINATIM_URL: base, INTERNAL_SERVICE_TOKEN: INTERNAL, ENGINE_TIMEOUT_MS: "300" });
  const c = createContainer(config, pino({ level: "silent" }), {
    cache, verifyAccessToken: createTokenVerifier({ issuer: ISSUER, keySet: createLocalJWKSet({ keys: [publicJwk as never] }) }),
  });
  app = await buildApp(c);
});

const internal = (url: string, payload: object) => app.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${INTERNAL}` } });

describe("internal routing", () => {
  it("routes with OSRM (lng,lat order, rounded numbers) and caches the answer", async () => {
    const r = await internal("/internal/route", { points: [BOLE, PIASSA] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ distanceMeters: 7413, durationSeconds: 943, approximate: false });
    expect(engine.hits[0]).toContain("/route/v1/driving/38.757800,8.980600;38.750000,9.033300");
    await internal("/internal/route", { points: [{ lat: BOLE.lat + 0.00001, lng: BOLE.lng }, PIASSA] }); // ~1 m away: same cache entry
    expect(engine.hits.length).toBe(1);
  });

  it("returns the geometry when asked", async () => {
    const r = await internal("/internal/route", { points: [BOLE, PIASSA], geometry: true });
    expect(r.json()).toMatchObject({ geometry: "_p~iF~ps|U_ulLnnqC" });
  });

  it("returns turn-by-turn steps when asked, cached apart from the plain answer", async () => {
    const r = await internal("/internal/route", { points: [BOLE, PIASSA], geometry: true, steps: true });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ steps: { maneuver: { type: string; modifier?: string; location: { lat: number; lng: number } }; name: string; distanceMeters: number }[] }>();
    expect(body.steps).toHaveLength(3);
    expect(body.steps[1]).toEqual({ maneuver: { type: "turn", modifier: "left", location: { lat: 8.99, lng: 38.76 }, bearingAfter: 270 }, name: "Churchill Avenue", distanceMeters: 7292, durationSeconds: 923 });
    expect(engine.hits[0]).toContain("steps=true");
    await internal("/internal/route", { points: [BOLE, PIASSA], geometry: true });
    expect(engine.hits.length).toBe(2); // a different cache entry
  });

  it("OSRM down with geometry asked → the straight line as a polyline, no steps", async () => {
    engine.down = true;
    const r = await internal("/internal/route", { points: [BOLE, PIASSA], geometry: true, steps: true });
    const body = r.json<{ approximate: boolean; geometry: string; steps: unknown[] }>();
    expect(body.approximate).toBe(true);
    expect(body.geometry.length).toBeGreaterThan(8);
    expect(body.steps).toEqual([]);
  });

  it("no road between the points → 404, not an estimate", async () => {
    engine.noRoute = true;
    expect((await internal("/internal/route", { points: [BOLE, PIASSA] })).statusCode).toBe(404);
  });

  it("OSRM down → straight-line estimate flagged approximate, not cached; the breaker opens", async () => {
    engine.down = true;
    const r = await internal("/internal/route", { points: [BOLE, PIASSA] });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ distanceMeters: number; durationSeconds: number; approximate: boolean }>();
    expect(body.approximate).toBe(true);
    expect(body.distanceMeters).toBeGreaterThan(7800); // 5.9 km × 1.35
    expect(body.distanceMeters).toBeLessThan(8100);
    expect(cache.size()).toBe(0);

    await internal("/internal/route", { points: [BOLE, PIASSA] });
    await internal("/internal/route", { points: [BOLE, PIASSA] });
    const hitsWhenOpen = engine.hits.length;
    await internal("/internal/route", { points: [BOLE, PIASSA] });
    expect(engine.hits.length).toBe(hitsWhenOpen); // fails fast, doesn't call OSRM
    expect((await app.inject({ method: "GET", url: "/health/ready" })).json()).toMatchObject({ engines: { osrm: "degraded" } });
  });

  it("a slow OSRM is cut off by the timeout and answered with an estimate", async () => {
    engine.slowMs = 600;
    const started = Date.now();
    const r = await internal("/internal/route", { points: [BOLE, PIASSA] });
    expect(r.json()).toMatchObject({ approximate: true });
    expect(Date.now() - started).toBeLessThan(550);
  });

  it("table: sources × destinations from OSRM's indexes", async () => {
    const r = await internal("/internal/table", { sources: [BOLE, PIASSA], destinations: [BOLE] });
    expect(r.json()).toEqual({ durations: [[100], [201]], distances: [[1001], [1001]], approximate: false });
    expect(engine.hits[0]).toContain("sources=0%3B1");
    expect(engine.hits[0]).toContain("destinations=2");
  });

  it("refuses points outside the service area and oversized tables", async () => {
    const r = await internal("/internal/route", { points: [BOLE, { lat: 51.5, lng: -0.12 }] });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: "outside_service_area" });
    const many = Array.from({ length: 30 }, () => BOLE);
    expect((await internal("/internal/table", { sources: many, destinations: many })).statusCode).toBe(400);
    expect(engine.hits).toEqual([]);
  });

  it("needs the service token", async () => {
    const r = await app.inject({ method: "POST", url: "/internal/route", payload: { points: [BOLE, PIASSA] } });
    expect(r.statusCode).toBe(401);
  });
});

describe("public maps API", () => {
  const get = async (url: string, sub = crypto.randomUUID(), aud: "ride-app" | "ride-admin" = "ride-app") =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${await token(sub, aud)}` } });

  it("searches inside the city's viewbox", async () => {
    const r = await get("/api/maps/search?q=airport&cityId=addis-ababa");
    expect(r.json()).toEqual({ results: [expect.objectContaining({ name: "Bole International Airport", lat: 8.9779, lng: 38.7993 })] });
    const hit = new URL(engine.hits[0]!, "http://x");
    expect(hit.searchParams.get("viewbox")).toBe("38.63,9.1,38.92,8.83");
    expect(hit.searchParams.get("bounded")).toBe("1");
    expect(hit.searchParams.get("countrycodes")).toBe("et");
  });

  it("reverse-geocodes and snaps the pickup pin, for app and staff tokens", async () => {
    expect((await get(`/api/maps/reverse?lat=${BOLE.lat}&lng=${BOLE.lng}`)).json()).toMatchObject({ label: "Africa Avenue, Bole, Addis Ababa, Ethiopia", name: "Africa Avenue" });
    expect((await get(`/api/maps/snap?lat=${BOLE.lat}&lng=${BOLE.lng}`, undefined, "ride-admin")).json()).toEqual({ lat: 8.98071, lng: 38.75801, name: "Africa Avenue", distanceMeters: 12, approximate: false });
  });

  it("gives the apps the road line between two points, with the turns on request", async () => {
    const r = await get(`/api/maps/route?from=${BOLE.lat},${BOLE.lng}&to=${PIASSA.lat},${PIASSA.lng}&steps=1`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ polyline6: "_p~iF~ps|U_ulLnnqC", distanceMeters: 7413, durationSeconds: 943, approximate: false });
    expect(r.json<{ steps: unknown[] }>().steps).toHaveLength(3);
    const plain = await get(`/api/maps/route?from=${BOLE.lat},${BOLE.lng}&to=${PIASSA.lat},${PIASSA.lng}`);
    expect(plain.json<{ steps: unknown[] }>().steps).toEqual([]);
    expect((await get(`/api/maps/route?from=51.5,-0.12&to=${PIASSA.lat},${PIASSA.lng}`)).statusCode).toBe(400);
    expect((await get(`/api/maps/route?from=abc&to=${PIASSA.lat},${PIASSA.lng}`)).statusCode).toBe(400);
  });

  it("needs a token, validates input, and returns 503 when geocoding is down", async () => {
    expect((await app.inject({ method: "GET", url: "/api/maps/search?q=bole" })).statusCode).toBe(401);
    expect((await get("/api/maps/search?q=b")).statusCode).toBe(400);
    expect((await get("/api/maps/search?q=bole&cityId=atlantis")).statusCode).toBe(400);
    engine.down = true;
    const r = await get("/api/maps/search?q=bole");
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: "engine_unavailable", message: "address search is temporarily unavailable" });
  });

  it("rate-limits per user, not per IP", async () => {
    const heavy = crypto.randomUUID();
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await get(`/api/maps/snap?lat=${BOLE.lat}&lng=${BOLE.lng}`, heavy)).statusCode;
    expect(last).toBe(429);
    expect((await get(`/api/maps/snap?lat=${BOLE.lat}&lng=${BOLE.lng}`)).statusCode).toBe(200); // another user, same IP
  });
});
