import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import pino from "pino";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTokenVerifier } from "@ride-app/shared-authz";
import { endTrip, getDriverState, goOffline, goOnline, keys, recordPing, startTrip } from "@ride-app/shared-location";
import { buildApp } from "../../src/app.js";
import { createHandlers } from "../../src/events/handlers.js";
import type { Mapping } from "../../src/lib/mapping.js";
import { createLocations } from "../../src/locations.js";
import { createSweeper } from "../../src/sweeper.js";
import { TEST_REDIS_URL } from "./global-setup.js";

const CITY = "addis-ababa";
const BOLE = { lat: 8.9806, lng: 38.7578 };
const near = (meters: number) => ({ lat: BOLE.lat + meters / 111_320, lng: BOLE.lng });
const INTERNAL = "s".repeat(64);
const ISSUER = "http://localhost:3001";
const uuid = () => crypto.randomUUID();

let redis: Redis;
let clock = Date.now();
const mapping = { fail: false, calls: 0 };
const fakeMapping: Mapping = {
  async table(sources) {
    mapping.calls++;
    if (mapping.fail) throw new Error("mapping-service 503");
    return { durations: sources.map((_, i) => [120 + i * 60]), approximate: false };
  },
};

let sign: (sub: string, aud: "ride-app" | "ride-admin", roles: object[]) => Promise<string>;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  redis = new Redis(TEST_REDIS_URL);
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k", alg: "ES256" };
  sign = (sub, aud, roles) =>
    new SignJWT({ roles, pv: 0, amr: ["otp"] }).setProtectedHeader({ alg: "ES256", kid: "k" })
      .setSubject(sub).setIssuer(ISSUER).setAudience(aud).setIssuedAt().setExpirationTime("15m").sign(privateKey);
  app = await buildApp({
    locations: createLocations({ redis, mapping: fakeMapping, logger: pino({ level: "silent" }), now: () => clock }),
    redis,
    internalToken: INTERNAL,
    verifyAccessToken: createTokenVerifier({ issuer: ISSUER, keySet: createLocalJWKSet({ keys: [jwk] }) }),
    devRoutes: true,
  });
});
afterAll(async () => {
  await app?.close();
  redis?.disconnect();
});
beforeEach(async () => {
  await redis.flushdb(); // the dedicated test Redis only (see global-setup)
  clock = Date.now();
  mapping.fail = false;
  mapping.calls = 0;
});

async function onlineDriver(at = BOLE, opts: { vehicleType?: string; cashAllowed?: boolean; fleetOrgId?: string; beneficiaryId?: string } = {}) {
  const driverId = uuid();
  await goOnline(redis, {
    driverId, cityId: CITY, vehicleType: opts.vehicleType ?? "economy", vehicleId: "v-1", cashAllowed: opts.cashAllowed ?? true,
    fleetOrgId: opts.fleetOrgId, beneficiaryId: opts.beneficiaryId ?? opts.fleetOrgId ?? driverId,
  });
  const r = await recordPing(redis, driverId, { ...at, at: clock, accuracy: 10 }, clock);
  expect(r.accepted).toBe(true);
  return driverId;
}

const nearby = (q: Record<string, string | number> = {}) =>
  app.inject({
    method: "GET", url: "/internal/drivers/nearby",
    query: { cityId: CITY, vehicleType: "economy", lat: String(BOLE.lat), lng: String(BOLE.lng), ...Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])) },
    headers: { authorization: `Bearer ${INTERNAL}` },
  });

describe("pings and the geo index", () => {
  it("only online drivers are indexed; nearest first", async () => {
    const far = await onlineDriver(near(1500));
    const close = await onlineDriver(near(300));
    const res = await nearby();
    expect(res.statusCode).toBe(200);
    const ids = res.json<{ drivers: { driverId: string; distanceMeters: number }[] }>().drivers;
    expect(ids.map((d) => d.driverId)).toEqual([close, far]);
    expect(ids[0]!.distanceMeters).toBeGreaterThan(250);
    expect(ids[0]!.distanceMeters).toBeLessThan(350);
  });

  it("ignores pings from drivers who aren't online, and implausible pings", async () => {
    expect(await recordPing(redis, uuid(), { ...BOLE, at: clock }, clock)).toEqual({ accepted: false, reason: "not_online" });
    const d = await onlineDriver();
    expect(await recordPing(redis, d, { lat: 9.0333, lng: 38.75, at: clock + 4000 }, clock + 4000)).toEqual({ accepted: false, reason: "too_fast" });
    expect(await recordPing(redis, d, { ...near(20), at: clock + 4000, accuracy: 500 }, clock + 4000)).toEqual({ accepted: false, reason: "inaccurate" });
    await goOffline(redis, d);
    expect(await recordPing(redis, d, { ...near(30), at: clock + 8000 }, clock + 8000)).toEqual({ accepted: false, reason: "not_online" });
    expect((await nearby()).json()).toEqual({ drivers: [] });
  });

  it("filters by vehicle type and cash eligibility, and skips drivers holding an offer", async () => {
    const cashOk = await onlineDriver(near(100));
    const digitalOnly = await onlineDriver(near(200), { cashAllowed: false });
    await onlineDriver(near(150), { vehicleType: "comfort" });
    const offered = await onlineDriver(near(50));
    await redis.set(keys.offer(offered), "trip-x", "EX", 15);
    const all = (await nearby()).json<{ drivers: { driverId: string }[] }>().drivers.map((d) => d.driverId);
    expect(all).toEqual([cashOk, digitalOnly]);
    const cash = (await nearby({ cashOnly: "true" })).json<{ drivers: { driverId: string }[] }>().drivers.map((d) => d.driverId);
    expect(cash).toEqual([cashOk]);
  });

  it("follows the beneficiary's balance: a fleet's cash limit pauses cash for all its cars, blocked stops everything", async () => {
    const fleet = uuid();
    const a = await onlineDriver(near(100), { fleetOrgId: fleet });
    const b = await onlineDriver(near(120), { fleetOrgId: fleet });
    const own = await onlineDriver(near(140));
    const handlers = createHandlers(redis);
    const change = (id: string, type: "INDIVIDUAL" | "ORGANIZATION", state: string, cashAllowed: boolean) =>
      handlers["balance.state_changed"]({ eventId: uuid(), beneficiary: { type, id }, state, cashAllowed, previousState: "OK", balanceMinor: -1 });
    const ids = async (q: Record<string, string> = {}) => (await nearby(q)).json<{ drivers: { driverId: string }[] }>().drivers.map((d) => d.driverId);

    await change(fleet, "ORGANIZATION", "CASH_BLOCKED", false);
    expect(await ids({ cashOnly: "true" })).toEqual([own]);
    expect(await ids()).toEqual([a, b, own]);

    await change(own, "INDIVIDUAL", "BLOCKED", false);
    expect(await ids()).toEqual([a, b]);

    // a car of the fleet going online later starts with the published state
    const c = await onlineDriver(near(160), { fleetOrgId: fleet });
    expect((await getDriverState(redis, c))).toMatchObject({ balanceState: "CASH_BLOCKED", cashAllowed: false });
    await change(fleet, "ORGANIZATION", "OK", true);
    expect(await ids({ cashOnly: "true" })).toEqual([a, b, c]);
  });

  it("switching vehicle type leaves the old set", async () => {
    const d = await onlineDriver();
    await goOnline(redis, { driverId: d, cityId: CITY, vehicleType: "comfort", vehicleId: "v-2", cashAllowed: true });
    expect((await nearby()).json()).toEqual({ drivers: [] });
  });
});

describe("staleness sweeper", () => {
  it("drops drivers after 20 s without a ping; the next ping brings them back", async () => {
    const d = await onlineDriver();
    const sweeper = createSweeper({ redis, logger: pino({ level: "silent" }), intervalMs: 5000, now: () => clock });
    clock += 21_000;
    expect(await sweeper.sweepOnce()).toEqual({ stale: 1, lost: 0 });
    expect((await nearby()).json()).toEqual({ drivers: [] });
    expect((await getDriverState(redis, d))?.stale).toBe(true);

    await recordPing(redis, d, { ...near(10), at: clock }, clock);
    expect((await nearby()).json<{ drivers: unknown[] }>().drivers).toHaveLength(1);
  });

  it("reports a driver lost after 10 min without a ping (no trip), once", async () => {
    const d = await onlineDriver();
    const lost: string[] = [];
    const sweeper = createSweeper({ redis, logger: pino({ level: "silent" }), intervalMs: 5000, now: () => clock, onLost: async (id) => void lost.push(id) });
    clock += 11 * 60_000;
    await sweeper.sweepOnce();
    await redis.del(keys.sweepLock(CITY));
    await sweeper.sweepOnce();
    expect(lost).toEqual([d]);
  });

  it("a driver on a trip is never reported lost", async () => {
    const d = await onlineDriver();
    await startTrip(redis, { tripId: uuid(), driverId: d, riderId: uuid() });
    const lost: string[] = [];
    const sweeper = createSweeper({ redis, logger: pino({ level: "silent" }), intervalMs: 5000, now: () => clock, onLost: async (id) => void lost.push(id) });
    clock += 11 * 60_000;
    await sweeper.sweepOnce();
    expect(lost).toEqual([]);
  });

  it("only one replica sweeps a city at a time", async () => {
    await onlineDriver();
    const a = createSweeper({ redis, logger: pino({ level: "silent" }), intervalMs: 5000, now: () => clock });
    const b = createSweeper({ redis, logger: pino({ level: "silent" }), intervalMs: 5000, now: () => clock });
    clock += 21_000;
    const [ra, rb] = await Promise.all([a.sweepOnce(), b.sweepOnce()]);
    expect(ra.stale + rb.stale).toBe(1);
  });
});

describe("trips", () => {
  it("a matched driver leaves matching, and their pings feed the trip's last position", async () => {
    const d = await onlineDriver();
    const tripId = uuid();
    const riderId = uuid();
    await createHandlers(redis)["trip.matched"]({ eventId: uuid(), tripId, riderId, driverId: d, cityId: CITY, vehicleType: "economy" });
    expect((await nearby()).json()).toEqual({ drivers: [] });

    clock += 4000;
    await recordPing(redis, d, { ...near(40), at: clock }, clock);
    const rider = await sign(riderId, "ride-app", [{ r: "RIDER" }]);
    const res = await app.inject({ method: "GET", url: `/api/locations/trips/${tripId}/driver`, headers: { authorization: `Bearer ${rider}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tripId, driverId: d, lat: near(40).lat });

    await endTrip(redis, { tripId, driverId: d });
    expect((await nearby()).json<{ drivers: unknown[] }>().drivers).toHaveLength(1);
  });

  it("strangers get 404 for someone else's trip; the vehicle's fleet owner may look", async () => {
    const fleetOrgId = uuid();
    const d = await onlineDriver(BOLE, { fleetOrgId });
    const tripId = uuid();
    await startTrip(redis, { tripId, driverId: d, riderId: uuid() });
    clock += 4000;
    await recordPing(redis, d, { ...near(40), at: clock }, clock);

    const stranger = await sign(uuid(), "ride-app", [{ r: "RIDER" }]);
    expect((await app.inject({ method: "GET", url: `/api/locations/trips/${tripId}/driver`, headers: { authorization: `Bearer ${stranger}` } })).statusCode).toBe(404);
    const otherFleet = await sign(uuid(), "ride-app", [{ r: "FLEET_OWNER", org: uuid() }]);
    expect((await app.inject({ method: "GET", url: `/api/locations/trips/${tripId}/driver`, headers: { authorization: `Bearer ${otherFleet}` } })).statusCode).toBe(404);
    const owner = await sign(uuid(), "ride-app", [{ r: "FLEET_OWNER", org: fleetOrgId }]);
    expect((await app.inject({ method: "GET", url: `/api/locations/trips/${tripId}/driver`, headers: { authorization: `Bearer ${owner}` } })).statusCode).toBe(200);
  });

  it("a company booking: the booker and the company's trip readers may follow the car, other companies may not", async () => {
    const d = await onlineDriver(BOLE);
    const tripId = uuid();
    const company = uuid();
    const booker = uuid();
    await createHandlers(redis)["trip.matched"]({ eventId: uuid(), tripId, riderId: uuid(), driverId: d, cityId: CITY, vehicleType: "economy", bookedById: booker, billingOrgId: company });
    clock += 4000;
    await recordPing(redis, d, { ...near(40), at: clock }, clock);
    const get = async (token: string) => (await app.inject({ method: "GET", url: `/api/locations/trips/${tripId}/driver`, headers: { authorization: `Bearer ${token}` } })).statusCode;

    expect(await get(await sign(booker, "ride-app", [{ r: "RIDER" }]))).toBe(200);
    expect(await get(await sign(uuid(), "ride-app", [{ r: "CORPORATE_ADMIN", org: company }]))).toBe(200);
    expect(await get(await sign(uuid(), "ride-app", [{ r: "CORPORATE_COORDINATOR", org: company }]))).toBe(200);
    expect(await get(await sign(uuid(), "ride-app", [{ r: "CORPORATE_ADMIN", org: uuid() }]))).toBe(404);
    expect(await get(await sign(uuid(), "ride-app", [{ r: "CORPORATE_EMPLOYEE", org: company }]))).toBe(404); // no trip:read
  });

  it("trip.reassigned to another driver: the trip follows the new car, the old driver is freed and can't watch", async () => {
    const h = createHandlers(redis);
    const a = await onlineDriver(BOLE);
    const b = await onlineDriver(near(300));
    const tripId = uuid();
    const riderId = uuid();
    await h["trip.matched"]({ eventId: uuid(), tripId, riderId, driverId: a, cityId: CITY, vehicleType: "economy" });
    clock += 4000;
    await recordPing(redis, a, { ...near(40), at: clock }, clock);
    const driverOf = async () => (await app.inject({ method: "GET", url: `/api/locations/trips/${tripId}/driver`, headers: { authorization: `Bearer ${await sign(riderId, "ride-app", [{ r: "RIDER" }])}` } }));
    expect((await driverOf()).json()).toMatchObject({ driverId: a });

    // trip-service writes trip.matched (new driver) then trip.reassigned, keyed by trip id
    await h["trip.matched"]({ eventId: uuid(), tripId, riderId, driverId: b, cityId: CITY, vehicleType: "economy" });
    const reassigned = { eventId: uuid(), tripId, riderId, cityId: CITY, fromDriverId: a, toDriverId: b, byUserId: uuid() };
    await h["trip.reassigned"](reassigned);
    await h["trip.reassigned"](reassigned); // replay: same state

    // the rider sees the new car at once (seeded from its last ping), then its pings
    expect((await driverOf()).json()).toMatchObject({ driverId: b, lat: near(300).lat });
    clock += 4000;
    await recordPing(redis, b, { ...near(250), at: clock }, clock);
    // a late ping of the old driver no longer feeds the trip
    await recordPing(redis, a, { ...near(60), at: clock }, clock);
    expect((await driverOf()).json()).toMatchObject({ driverId: b, lat: near(250).lat });

    expect(await getDriverState(redis, a)).toMatchObject({ status: "available", tripId: undefined });
    expect(await getDriverState(redis, b)).toMatchObject({ status: "on_trip", tripId });
    expect(await redis.sismember(keys.tripMembers(tripId), a)).toBe(0);
    expect(await redis.sismember(keys.tripMembers(tripId), b)).toBe(1);
    expect((await nearby()).json<{ drivers: { driverId: string }[] }>().drivers.map((x) => x.driverId)).toEqual([a]);
    const oldDriver = await sign(a, "ride-app", [{ r: "DRIVER" }]);
    expect((await app.inject({ method: "GET", url: `/api/locations/trips/${tripId}/driver`, headers: { authorization: `Bearer ${oldDriver}` } })).statusCode).toBe(404);
  });

  it("trip.reassigned back to matching frees the old driver; a new driver busy on another trip isn't taken over", async () => {
    const h = createHandlers(redis);
    const a = await onlineDriver(BOLE);
    const tripId = uuid();
    const riderId = uuid();
    await h["trip.matched"]({ eventId: uuid(), tripId, riderId, driverId: a, cityId: CITY, vehicleType: "economy" });
    clock += 4000;
    await recordPing(redis, a, { ...near(40), at: clock }, clock);
    await h["trip.reassigned"]({ eventId: uuid(), tripId, riderId, cityId: CITY, fromDriverId: a, byUserId: uuid() });
    expect(await getDriverState(redis, a)).toMatchObject({ status: "available" });
    expect(await redis.exists(keys.tripLast(tripId))).toBe(0);
    expect(await redis.smembers(keys.tripMembers(tripId))).toEqual([riderId]);

    // an out-of-date event naming a driver who is now on another trip
    const c = await onlineDriver(near(100));
    const other = uuid();
    await startTrip(redis, { tripId: other, driverId: c, riderId: uuid() });
    await h["trip.reassigned"]({ eventId: uuid(), tripId, riderId, cityId: CITY, fromDriverId: a, toDriverId: c, byUserId: uuid() });
    expect(await getDriverState(redis, c)).toMatchObject({ status: "on_trip", tripId: other });
    await expect(h["trip.reassigned"]({ tripId, riderId, fromDriverId: "nope" })).rejects.toThrow();
  });

  it("invalid events are rejected by the contract", async () => {
    await expect(createHandlers(redis)["driver.online"]({ driverId: "nope", cityId: CITY })).rejects.toThrow();
    await expect(createHandlers(redis)["driver.online"]({ driverId: uuid(), vehicleId: "v", vehicleType: "eco}", cityId: CITY, cashAllowed: true })).rejects.toThrow();
  });
});

describe("ETA to pickup", () => {
  it("uses OSRM driving time from the closest drivers", async () => {
    await onlineDriver(near(300));
    await onlineDriver(near(900));
    const res = await app.inject({
      method: "GET", url: "/internal/eta-to-pickup",
      query: { cityId: CITY, vehicleType: "economy", lat: String(BOLE.lat), lng: String(BOLE.lng) },
      headers: { authorization: `Bearer ${INTERNAL}` },
    });
    expect(res.json()).toEqual({ etaSeconds: 120, driversNearby: 2, approximate: false });
  });

  it("estimates when mapping-service is down, and says so", async () => {
    await onlineDriver(near(1000));
    mapping.fail = true;
    const res = await app.inject({
      method: "GET", url: "/internal/eta-to-pickup",
      query: { cityId: CITY, vehicleType: "economy", lat: String(BOLE.lat), lng: String(BOLE.lng) },
      headers: { authorization: `Bearer ${INTERNAL}` },
    });
    const body = res.json<{ etaSeconds: number; approximate: boolean }>();
    expect(body.approximate).toBe(true);
    expect(body.etaSeconds).toBeGreaterThan(200); // 1 km × 1.35 at 22 km/h ≈ 221 s
    expect(body.etaSeconds).toBeLessThan(240);
  });

  it("no drivers → no ETA, and no mapping call", async () => {
    const res = await app.inject({
      method: "GET", url: "/internal/eta-to-pickup",
      query: { cityId: CITY, vehicleType: "economy", lat: String(BOLE.lat), lng: String(BOLE.lng) },
      headers: { authorization: `Bearer ${INTERNAL}` },
    });
    expect(res.json()).toEqual({ etaSeconds: null, driversNearby: 0, approximate: false });
    expect(mapping.calls).toBe(0);
  });
});

describe("cars around the rider", () => {
  const asRider = async (q: Record<string, string>) =>
    app.inject({ method: "GET", url: "/api/locations/nearby", query: q, headers: { authorization: `Bearer ${await sign(uuid(), "ride-app", [{ r: "RIDER" }])}` } });

  it("shows anonymous cars on a coarse grid, nearest first, with the nearest one's ETA", async () => {
    const a = await onlineDriver(near(300));
    await onlineDriver(near(900), { vehicleType: "minivan" });
    await onlineDriver(near(5000)); // outside 2 km
    const res = await asRider({ lat: String(BOLE.lat), lng: String(BOLE.lng) });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ cars: { lat: number; lng: number; heading?: number; driverId?: string }[]; etaSeconds: number; driversNearby: number }>();
    expect(body.driversNearby).toBe(2);
    expect(body.cars).toHaveLength(2);
    expect(body.cars[0]).not.toHaveProperty("driverId");
    expect(JSON.stringify(body)).not.toContain(a);
    // ~30 m grid: never the exact position
    expect(Math.round(body.cars[0]!.lat / 0.0003) * 0.0003).toBeCloseTo(body.cars[0]!.lat, 4);
    expect(body.etaSeconds).toBe(120);
    // one type only
    const vans = await asRider({ lat: String(BOLE.lat), lng: String(BOLE.lng), vehicleType: "minivan" });
    expect(vans.json<{ cars: unknown[] }>().cars).toHaveLength(1);
  });

  it("outside the served cities there are no cars; it needs an app token", async () => {
    const res = await asRider({ lat: "51.5", lng: "-0.12" });
    expect(res.json()).toEqual({ cars: [], etaSeconds: null, driversNearby: 0, approximate: false });
    expect((await app.inject({ method: "GET", url: "/api/locations/nearby", query: { lat: "9", lng: "38.7" } })).statusCode).toBe(401);
  });
});

describe("access control", () => {
  it("internal routes need the service token", async () => {
    const res = await app.inject({ method: "GET", url: "/internal/drivers/nearby", query: { cityId: CITY, vehicleType: "economy", lat: "9", lng: "38.7" } });
    expect(res.statusCode).toBe(401);
  });

  it("the ops map needs location:read_live in that city on a staff token", async () => {
    await onlineDriver();
    const url = `/api/locations/cities/${CITY}/drivers`;
    const dispatcher = await sign(uuid(), "ride-admin", [{ r: "DISPATCHER", city: CITY }]);
    const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${dispatcher}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ drivers: unknown[] }>().drivers).toHaveLength(1);

    const elsewhere = await sign(uuid(), "ride-admin", [{ r: "DISPATCHER", city: "hawassa" }]);
    expect((await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${elsewhere}` } })).statusCode).toBe(403);
    const analyst = await sign(uuid(), "ride-admin", [{ r: "ANALYST", city: CITY }]);
    expect((await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${analyst}` } })).statusCode).toBe(403);
    const appToken = await sign(uuid(), "ride-app", [{ r: "RIDER" }]);
    expect((await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${appToken}` } })).statusCode).toBe(401);
  });

  it("dev routes stand in for fleet-service", async () => {
    const d = uuid();
    const res = await app.inject({
      method: "POST", url: `/internal/dev/drivers/${d}/online`, headers: { authorization: `Bearer ${INTERNAL}` },
      payload: { vehicleId: "v-9", vehicleType: "economy", cityId: CITY, cashAllowed: true },
    });
    expect(res.statusCode).toBe(204);
    expect((await getDriverState(redis, d))?.status).toBe("available");
  });
});
