import { describe, expect, it } from "vitest";
import pino from "pino";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTokenVerifier } from "@ride-app/shared-authz";
import { staticSettings } from "@ride-app/shared-settings";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { createContainer } from "../../src/container.js";
import { emptyCatalog } from "../../src/catalog.js";
import { price } from "../../src/fares.js";
import type { Quote, QuoteStore } from "../../src/quotes.js";

const ISSUER = "http://localhost:3001";
const TOKEN = "t".repeat(64);
const BOLE = { lat: 8.9806, lng: 38.7578 };
const PIASSA = { lat: 9.0349, lng: 38.7469 };

describe("price", () => {
  const card = { baseMinor: 5000, perKmMinor: 1500, perMinMinor: 200, minFareMinor: 8000, waitingPerMinMinor: 300 };

  it("is base + distance + time, rounded to whole birr", () => {
    // 10 km, 20 min: 50 + 150 + 40 = 240 birr
    expect(price(card, { distanceMeters: 10_000, durationSeconds: 1200 })).toMatchObject({ fareMinor: 24_000, breakdown: { distanceMinor: 15_000, timeMinor: 4000, minimumApplied: false } });
    // 3.33 km, 7 min: 50 + 49.95 + 14 = 113.95 → 114
    expect(price(card, { distanceMeters: 3330, durationSeconds: 420 }).fareMinor).toBe(11_400);
  });

  it("never goes under the minimum fare", () => {
    expect(price(card, { distanceMeters: 500, durationSeconds: 60 })).toMatchObject({ fareMinor: 8000, breakdown: { minimumApplied: true } });
  });
});

async function setup(opts: { etaDown?: boolean } = {}) {
  const kept = new Map<string, Quote>();
  const store: QuoteStore = { put: async (q) => void kept.set(q.id, q), get: async (id) => kept.get(id) ?? null };
  const settings = staticSettings({}, { "addis-ababa": { "fares.economy.perKmMinor": 2000 } });
  const config = loadConfig({ NODE_ENV: "test", REDIS_URL: "redis://localhost:1", DATABASE_URL: "postgresql://unused.invalid:5432/none", INTERNAL_SERVICE_TOKEN: TOKEN });
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" };
  const c = createContainer(config, pino({ level: "silent" }), {
    store, settings, catalog: emptyCatalog,
    mapping: { route: async (_points, geometry = false) => ({ distanceMeters: 6000, durationSeconds: 900, approximate: false, ...(geometry ? { geometry: "_p~iF~ps|U_ulLnnqC" } : {}) }) },
    location: {
      etaToPickup: async (q) => {
        if (opts.etaDown) throw new Error("location 503");
        return q.vehicleType === "economy" ? { etaSeconds: 240, driversNearby: 3, approximate: false } : { etaSeconds: null, driversNearby: 0, approximate: false };
      },
    },
    verifyAccessToken: createTokenVerifier({ issuer: ISSUER, keySet: createLocalJWKSet({ keys: [jwk as never] }) }),
  });
  const app = await buildApp({ ...c, ready: async () => true });
  const token = (sub: string) => new SignJWT({ roles: [{ r: "RIDER" }], pv: 0, amr: ["otp"] }).setProtectedHeader({ alg: "ES256", kid: "k" })
    .setSubject(sub).setIssuer(ISSUER).setAudience("ride-app").setIssuedAt().setExpirationTime("15m").sign(privateKey);
  return { app, settings, token, close: async () => { await app.close(); await c.close(); } };
}

describe("estimates and the quote trip-service reads", () => {
  it("quotes every offered type with the city's live fares, and serves the quote internally", async () => {
    const s = await setup();
    const rider = crypto.randomUUID();
    const r = await s.app.inject({ method: "POST", url: "/api/pricing/estimates", headers: { authorization: `Bearer ${await s.token(rider)}` }, payload: { pickup: BOLE, dropoff: PIASSA } });
    expect(r.statusCode).toBe(200);
    const quotes = r.json<{ quotes: Quote[] }>().quotes;
    expect(quotes.map((q) => q.vehicleType)).toEqual(["economy", "comfort", "minivan"]);
    // the road line comes once for the map, and on each quote for trip-service to keep
    expect(r.json()).toMatchObject({ route: { polyline6: "_p~iF~ps|U_ulLnnqC", distanceMeters: 6000, durationSeconds: 900, approximate: false } });
    expect(quotes[0]!.routePolyline6).toBe("_p~iF~ps|U_ulLnnqC");
    // the ETA to the pickup per vehicle type, from location-service
    expect(quotes[0]).toMatchObject({ etaToPickupSeconds: 240, driversNearby: 3 });
    expect(quotes[1]).toMatchObject({ etaToPickupSeconds: null, driversNearby: 0 });
    // economy in Addis: per km overridden to 20 birr → 50 + 120 + 30 = 200 birr
    expect(quotes[0]).toMatchObject({ cityId: "addis-ababa", fareMinor: 20_000, requestedBy: rider, currency: "ETB" });

    // a fare change applies to the next quote, not to this one
    s.settings.set("fares.economy.baseMinor", 9000);
    const again = await s.app.inject({ method: "POST", url: "/api/pricing/estimates", headers: { authorization: `Bearer ${await s.token(rider)}` }, payload: { pickup: BOLE, dropoff: PIASSA, vehicleTypes: ["economy"] } });
    expect(again.json<{ quotes: Quote[] }>().quotes[0]!.fareMinor).toBe(24_000);

    const internal = await s.app.inject({ method: "GET", url: `/internal/quotes/${quotes[0]!.id}`, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(internal.json()).toMatchObject({ id: quotes[0]!.id, fareMinor: 20_000 });
    expect((await s.app.inject({ method: "GET", url: `/internal/quotes/${quotes[0]!.id}`, headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
    expect((await s.app.inject({ method: "GET", url: "/internal/quotes/q_missing", headers: { authorization: `Bearer ${TOKEN}` } })).statusCode).toBe(404);
    await s.close();
  });

  it("still quotes when location-service is down: the ETA is just unknown", async () => {
    const s = await setup({ etaDown: true });
    const r = await s.app.inject({ method: "POST", url: "/api/pricing/estimates", headers: { authorization: `Bearer ${await s.token(crypto.randomUUID())}` }, payload: { pickup: BOLE, dropoff: PIASSA, vehicleTypes: ["economy"] } });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ quotes: Quote[] }>().quotes[0]).toMatchObject({ fareMinor: 20_000, etaToPickupSeconds: null, driversNearby: 0 });
    await s.close();
  });

  it("refuses pickups outside the cities, unknown types, and anonymous callers", async () => {
    const s = await setup();
    const auth = { authorization: `Bearer ${await s.token(crypto.randomUUID())}` };
    const outside = await s.app.inject({ method: "POST", url: "/api/pricing/estimates", headers: auth, payload: { pickup: { lat: 0, lng: 0 }, dropoff: PIASSA } });
    expect(outside.json()).toMatchObject({ error: "outside_service_area" });
    const unknown = await s.app.inject({ method: "POST", url: "/api/pricing/estimates", headers: auth, payload: { pickup: BOLE, dropoff: PIASSA, vehicleTypes: ["helicopter"] } });
    expect(unknown.json()).toMatchObject({ error: "vehicle_type_unavailable" });
    expect((await s.app.inject({ method: "POST", url: "/api/pricing/estimates", payload: { pickup: BOLE, dropoff: PIASSA } })).statusCode).toBe(401);
    const fares = await s.app.inject({ method: "GET", url: "/api/pricing/fares?cityId=addis-ababa" });
    expect(fares.json<{ fares: { vehicleType: string; perKmMinor: number }[] }>().fares[0]).toMatchObject({ vehicleType: "economy", perKmMinor: 2000 });
    await s.close();
  });

  it("POST /internal/quotes: trip-service re-prices a scheduled ride for a user (service token only)", async () => {
    const s = await setup();
    const rider = crypto.randomUUID();
    const internal = { authorization: `Bearer ${TOKEN}` };
    const body = { requestedBy: rider, cityId: "addis-ababa", vehicleType: "economy", vehicleTypes: ["economy"], pickup: BOLE, dropoff: PIASSA, pickupAddress: "Bole" };
    const r = await s.app.inject({ method: "POST", url: "/internal/quotes", headers: internal, payload: body });
    expect(r.statusCode, r.body).toBe(200);
    const [q] = r.json<{ quotes: Quote[] }>().quotes;
    expect(q).toMatchObject({ requestedBy: rider, cityId: "addis-ababa", vehicleType: "economy", fareMinor: 20_000, discountMinor: 0, payableMinor: 20_000, pickupAddress: "Bole", routePolyline6: "_p~iF~ps|U_ulLnnqC" });
    // stored like any quote: readable back by id
    expect((await s.app.inject({ method: "GET", url: `/internal/quotes/${q!.id}`, headers: internal })).json()).toMatchObject({ id: q!.id, fareMinor: 20_000 });
    // vehicleType alone is enough
    const single = await s.app.inject({ method: "POST", url: "/internal/quotes", headers: internal, payload: { requestedBy: rider, vehicleType: "comfort", pickup: BOLE, dropoff: PIASSA } });
    expect(single.json<{ quotes: Quote[] }>().quotes.map((x) => x.vehicleType)).toEqual(["comfort"]);

    expect((await s.app.inject({ method: "POST", url: "/internal/quotes", payload: body })).statusCode).toBe(401);
    expect((await s.app.inject({ method: "POST", url: "/internal/quotes", headers: { authorization: `Bearer ${await s.token(rider)}` }, payload: body })).statusCode).toBe(401);
    expect((await s.app.inject({ method: "POST", url: "/internal/quotes", headers: internal, payload: { ...body, cityId: "hawassa" } })).json()).toMatchObject({ error: "city_mismatch" });
    expect((await s.app.inject({ method: "POST", url: "/internal/quotes", headers: internal, payload: { ...body, vehicleTypes: ["helicopter"] } })).json()).toMatchObject({ error: "vehicle_type_unavailable" });
    expect((await s.app.inject({ method: "POST", url: "/internal/quotes", headers: internal, payload: { ...body, pickup: { lat: 0, lng: 0 } } })).json()).toMatchObject({ error: "outside_service_area" });
    const { vehicleType: _v, vehicleTypes: _vs, ...noType } = body;
    expect((await s.app.inject({ method: "POST", url: "/internal/quotes", headers: internal, payload: noType })).statusCode).toBe(400);
    await s.close();
  });
});
