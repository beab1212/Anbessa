// The real app on a test database and a test Redis. The location client uses the real
// libs/shared-location code against that Redis (so matching runs on the real geo index);
// mapping and the clock are fakes the tests control.

import { Redis } from "ioredis";
import pino from "pino";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTokenVerifier } from "@ride-app/shared-authz";
import { getDriverState, goOnline, haversineMeters, nearbyAvailable, recordPing, startTrip, type LatLng } from "@ride-app/shared-location";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/index.js";
import { createContainer } from "../../src/container.js";
import type { LocationClient, MappingClient } from "../../src/lib/clients.js";
import { TEST_DATABASE_URL, TEST_REDIS_URL } from "./global-setup.js";

const ISSUER = "http://localhost:3001";
export const CITY = "addis-ababa";
export const BOLE = { lat: 8.9806, lng: 38.7578 };
export const PIASSA = { lat: 9.0333, lng: 38.75 };
export const near = (p: LatLng, meters: number) => ({ lat: p.lat + meters / 111_320, lng: p.lng });
export const uuid = () => crypto.randomUUID();

export async function createHarness() {
  const clock = { now: Date.now() };
  const redis = new Redis(TEST_REDIS_URL);
  const pushes: { userId: string; event: string; payload: Record<string, unknown> }[] = [];
  const mappingState = { down: false };

  const mapping: MappingClient = {
    async route() {
      return { distanceMeters: 7400, durationSeconds: 900, approximate: false };
    },
    async table(sources) {
      if (mappingState.down) throw new Error("mapping 503");
      // farther away (in latitude) → longer drive, so ranking is observable
      return { durations: sources.map((s) => [Math.round(Math.abs(s.lat - BOLE.lat) * 1e5)]), approximate: false };
    },
  };
  const location: LocationClient = {
    nearby: (q) => nearbyAvailable(redis, q, clock.now),
    driver: (id) => getDriverState(redis, id) as never,
  };

  const config = loadConfig({
    NODE_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, REDIS_URL: TEST_REDIS_URL,
    INTERNAL_SERVICE_TOKEN: "t".repeat(64), PRICING: "builtin", MATCH_TIMEOUT_SECONDS: "120", OFFER_SECONDS: "15",
  });

  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" };
  const token = (sub: string, roles: object[], aud: "ride-app" | "ride-admin" = "ride-app") =>
    new SignJWT({ roles, pv: 0, amr: ["otp"] }).setProtectedHeader({ alg: "ES256", kid: "k" })
      .setSubject(sub).setIssuer(ISSUER).setAudience(aud).setIssuedAt().setExpirationTime("15m").sign(privateKey);

  const c = createContainer(config, pino({ level: "silent" }), {
    redis, location, mapping, now: () => new Date(clock.now),
    realtime: { toUser: (userId, event, payload) => void pushes.push({ userId, event, payload: payload as Record<string, unknown> }) },
    verifyAccessToken: createTokenVerifier({ issuer: ISSUER, keySet: createLocalJWKSet({ keys: [jwk as never] }) }),
  });
  const app = await buildApp(c);

  // ── actors ────────────────────────────────────────────────────────────────
  const rider = async (id = uuid(), roles: object[] = [{ r: "RIDER" }]) => ({ id, token: await token(id, roles) });
  const staff = async (roles: object[], id = uuid()) => ({ id, token: await token(id, roles, "ride-admin") });
  async function driver(at: LatLng = near(BOLE, 300), opts: { cashAllowed?: boolean; fleetOrgId?: string; vehicleType?: string } = {}) {
    const id = uuid();
    await goOnline(redis, { driverId: id, cityId: CITY, vehicleType: opts.vehicleType ?? "economy", vehicleId: `veh-${id.slice(0, 6)}`, cashAllowed: opts.cashAllowed ?? true, fleetOrgId: opts.fleetOrgId });
    let last = at;
    // the clock moves as if the car drove there at 10 m/s (pings faster than 200 km/h are dropped)
    const ping = async (p: LatLng = at) => {
      clock.now += Math.max(1000, Math.round((haversineMeters(last, p) / 10) * 1000));
      last = p;
      const r = await recordPing(redis, id, { ...p, at: clock.now, accuracy: 5 }, clock.now);
      if (!r.accepted) throw new Error(`ping rejected: ${r.reason}`);
    };
    await ping();
    return { id, token: await token(id, [{ r: "DRIVER" }, { r: "RIDER" }]), ping };
  }

  const req = (method: "GET" | "POST", url: string, who: { token: string }, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${who.token}`, ...headers } });

  async function quote(who: { token: string }, from = BOLE, to = PIASSA, vehicleType = "economy") {
    const r = await req("POST", "/api/trips/estimates", who, { pickup: from, dropoff: to, vehicleTypes: [vehicleType] });
    if (r.statusCode !== 200) throw new Error(`estimate ${r.statusCode} ${r.body}`);
    return r.json<{ quotes: { id: string; fareMinor: number }[] }>().quotes[0]!;
  }

  async function requestTrip(who: { token: string }, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    const q = await quote(who);
    return req("POST", "/api/trips", who, { quoteId: q.id, paymentMethod: "MOBILE_MONEY", ...body }, headers);
  }

  /** Run the matcher until it has made an offer (or gives up). */
  async function offerFor(tripId: string) {
    for (let i = 0; i < 5; i++) {
      await c.matcher.step(tripId).then(async (next) => {
        if (next === null) await c.matcher.control.stop(tripId);
      });
      const offer = await c.db.tripOffer.findFirst({ where: { tripId, status: "OFFERED" } });
      if (offer) return offer;
    }
    return null;
  }

  /**
   * A trip matched with a fresh driver, placed closest to the pickup so they get the offer.
   * By default it then does what location-service does on trip.matched (driver → busy);
   * `simulateLocation: false` leaves the driver "available" in Redis.
   */
  async function matchedTrip(opts: { paymentMethod?: string; driverOpts?: Parameters<typeof driver>[1]; simulateLocation?: boolean } = {}) {
    const r = await rider();
    const d = await driver(near(BOLE, 20), opts.driverOpts);
    const res = await requestTrip(r, opts.paymentMethod ? { paymentMethod: opts.paymentMethod } : {});
    const tripId = res.json<{ id: string }>().id;
    const offer = await offerFor(tripId);
    const acc = await req("POST", `/api/trips/${tripId}/accept`, d, { offerId: offer!.id });
    if (acc.statusCode !== 200) throw new Error(`accept ${acc.statusCode} ${acc.body}`);
    if (opts.simulateLocation !== false) await startTrip(redis, { tripId, driverId: d.id, riderId: r.id });
    return { r, d, tripId };
  }

  return {
    app, c, redis, clock, pushes, mappingState, token, rider, staff, driver, req, quote, requestTrip, offerFor, matchedTrip,
    close: async () => {
      await app.close();
      await c.close();
      redis.disconnect();
    },
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
