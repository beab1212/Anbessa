// The anti-fraud and access rules of the trip lifecycle, against in-memory fakes of the database,
// Redis, location-service and auth-service (the integration suite covers the real ones).

import { beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import { parseRoleClaims, type Principal } from "@ride-app/shared-authz";
import { staticSettings } from "@ride-app/shared-settings";
import type { Trip } from "../../src/generated/prisma/client.js";
import type { DriverLive } from "../../src/lib/clients.js";
import { createTripService, PIN_MAX_ATTEMPTS, tripView } from "../../src/trips/service.js";

const CITY = "addis-ababa";
const BOLE = { lat: 8.9806, lng: 38.7578 };
const PIASSA = { lat: 9.0333, lng: 38.75 };
const near = (p: { lat: number; lng: number }, m: number) => ({ lat: p.lat + m / 111_320, lng: p.lng });
const RIDER = "00000000-0000-4000-8000-00000000000a";
const DRIVER = "00000000-0000-4000-8000-00000000000d";
const ORG = "00000000-0000-4000-8000-0000000000c0";
const T0 = Date.parse("2026-10-29T08:00:00Z");

const who = (userId: string, claims: object[], audience: Principal["audience"] = "ride-app"): Principal =>
  ({ userId, audience, roles: parseRoleClaims(claims, audience), permissionVersion: 0, amr: ["otp"] }) as Principal;
const rider = who(RIDER, [{ r: "RIDER" }]);
const driver = who(DRIVER, [{ r: "DRIVER" }, { r: "RIDER" }]);

function baseTrip(over: Partial<Trip> = {}): Trip {
  return {
    id: "00000000-0000-4000-8000-0000000000f1", cityId: CITY, riderUserId: RIDER, bookedByUserId: RIDER, channel: "APP",
    billingType: "PERSONAL", billingOrgId: null, paymentMethod: "CASH", status: "en_route", vehicleType: "economy", quoteId: null,
    pickupLat: BOLE.lat, pickupLng: BOLE.lng, dropoffLat: PIASSA.lat, dropoffLng: PIASSA.lng, pickupAddress: null, dropoffAddress: null,
    driverUserId: DRIVER, vehicleId: "veh-1", vehicleOwnerType: "INDIVIDUAL", beneficiaryId: DRIVER, matchedAt: new Date(T0 - 600_000),
    fareEstimateMinor: 15000n, waitingPerMinMinor: 300n, fareFinalMinor: null, waitingFeeMinor: null, promoDiscountMinor: 0n, promoCode: null, currency: "ETB",
    estDistanceM: 5900, estDurationS: 900, distanceM: null, durationS: null, routePolyline: null,
    pin: "4821", arrivedAt: new Date(T0 - 60_000), startedAt: null, completedAt: null,
    cancelledAt: null, cancelledBy: null, cancelledByUserId: null, cancelReason: null, cancelFeeMinor: null, driverCompensationMinor: null,
    purpose: null, flags: [], version: 0, createdAt: new Date(T0 - 900_000), updatedAt: new Date(T0 - 900_000),
    ...over,
  } as Trip;
}

function setup(trip: Trip, opts: { pinRequired?: boolean; members?: string[] } = {}) {
  let row = { ...trip };
  const outbox: { topic: string; payload: Record<string, unknown> }[] = [];
  const history: Record<string, unknown>[] = [];
  const apply = (data: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(data)) {
      (row as Record<string, unknown>)[k] = v && typeof v === "object" && "increment" in v ? (row as never as Record<string, number>)[k]! + (v as { increment: number }).increment : v;
    }
  };
  const tx = {
    trip: {
      updateMany: async ({ where, data }: { where: { id: string; status: { in: string[] }; version: number }; data: Record<string, unknown> }) => {
        if (where.id !== row.id || !where.status.in.includes(row.status) || where.version !== row.version) return { count: 0 };
        apply(data);
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ ...row }),
    },
    tripEvent: { create: async ({ data }: { data: Record<string, unknown> }) => void history.push(data) },
    outbox: { create: async ({ data }: { data: { topic: string; payload: Record<string, unknown> } }) => void outbox.push(data) },
    driverActiveTrip: { deleteMany: async () => ({ count: 1 }), create: async () => ({}) },
    tripOffer: { updateMany: async () => ({ count: 0 }), findMany: async () => [] },
  };
  const db = { ...tx, trip: { ...tx.trip, findUnique: async () => ({ ...row }) }, tripOffer: tx.tripOffer, $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };

  const store = new Map<string, string>();
  const redis = {
    get: async (k: string) => store.get(k) ?? null,
    incr: async (k: string) => {
      const n = Number(store.get(k) ?? 0) + 1;
      store.set(k, String(n));
      return n;
    },
    expire: async () => 1,
    del: async (...ks: string[]) => ks.reduce((n, k) => n + (store.delete(k) ? 1 : 0), 0),
    sadd: async () => 1,
    hgetall: async () => ({}),
    multi() {
      const m = { srem: () => m, del: () => m, hset: () => m, zrem: () => m, geoadd: () => m, exec: async () => [] };
      return m;
    },
  };

  const clock = { now: T0 };
  const live: { pos: { lat: number; lng: number } | null; at?: number; receivedAt?: number } = { pos: near(BOLE, 30) };
  const location = {
    nearby: async () => [],
    driver: async (): Promise<DriverLive | null> => live.pos
      ? { driverId: DRIVER, status: "on_trip", cityId: CITY, vehicleType: "economy", vehicleId: "veh-1", cashAllowed: true, stale: false,
          ...live.pos, at: live.at ?? clock.now, receivedAt: live.receivedAt ?? clock.now }
      : null,
  };
  const pushes: { userId: string; event: string; payload: unknown }[] = [];
  const leaves: { userId: string; tripId: string }[] = [];
  const members = new Set(opts.members ?? []);
  const trips = createTripService({
    db: db as never, redis: redis as never, location, logger: pino({ level: "silent" }),
    quotes: {} as never, policies: {} as never,
    realtime: { toUser: (userId, event, payload) => void pushes.push({ userId, event, payload }), leaveTrip: (userId, tripId) => void leaves.push({ userId, tripId }) },
    matching: { start: async () => undefined, stop: async () => undefined, poke: async () => undefined },
    settings: staticSettings({ "trip.pinRequired": opts.pinRequired ?? true }),
    orgs: { isMember: async (orgId, userId) => members.has(`${orgId}:${userId}`) },
    now: () => new Date(clock.now),
  });
  return { trips, row: () => row, outbox, history, store, clock, live, pushes, leaves };
}

describe("trip PIN attempts", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => void (s = setup(baseTrip())));

  it("locks the PIN check after five wrong PINs, even for the right one", async () => {
    for (let i = 1; i < PIN_MAX_ATTEMPTS; i++) {
      await expect(s.trips.start(driver, s.row().id, "0000")).rejects.toMatchObject({ statusCode: 400, code: "wrong_pin" });
    }
    await expect(s.trips.start(driver, s.row().id, "0000")).rejects.toMatchObject({ statusCode: 423, code: "pin_locked" });
    expect(s.pushes.filter((p) => p.event === "trip:pin_locked").map((p) => p.userId)).toEqual([RIDER]);
    await expect(s.trips.start(driver, s.row().id, "4821")).rejects.toMatchObject({ statusCode: 423, code: "pin_locked" });
    await expect(s.trips.start(driver, s.row().id)).rejects.toMatchObject({ code: "pin_locked" });
    expect(s.row().status).toBe("en_route");
  });

  it("the right PIN starts the ride and clears the count", async () => {
    await expect(s.trips.start(driver, s.row().id, "1111")).rejects.toMatchObject({ code: "wrong_pin" });
    expect((await s.trips.start(driver, s.row().id, "4821")).status).toBe("in_progress");
    expect(s.store.size).toBe(0);
  });

  it("a missing PIN doesn't use up a try", async () => {
    await expect(s.trips.start(driver, s.row().id)).rejects.toMatchObject({ code: "wrong_pin" });
    expect(s.store.size).toBe(0);
  });

  it("the rider (or support) unlocks it with a new PIN; the driver can't", async () => {
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) await s.trips.start(driver, s.row().id, "0000").catch(() => undefined);
    await expect(s.trips.resetPin(driver, s.row().id)).rejects.toMatchObject({ statusCode: 403 });
    const u = await s.trips.resetPin(rider, s.row().id);
    expect(u.pin).toMatch(/^\d{4}$/);
    expect(s.history.at(-1)).toMatchObject({ data: { pinReset: true, by: "rider" } });
    expect((await s.trips.start(driver, s.row().id, u.pin)).status).toBe("in_progress");

    const t2 = setup(baseTrip());
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) await t2.trips.start(driver, t2.row().id, "0000").catch(() => undefined);
    const support = who("00000000-0000-4000-8000-0000000000e1", [{ r: "SUPPORT_AGENT", city: CITY }], "ride-admin");
    expect((await t2.trips.resetPin(support, t2.row().id)).status).toBe("en_route");
    expect(t2.history.at(-1)).toMatchObject({ data: { pinReset: true, by: "staff" } });
  });
});

describe("arrival freshness (server receive time)", () => {
  it("a position the server got over a minute ago is unknown, whatever the phone's clock says", async () => {
    const s = setup(baseTrip({ arrivedAt: null }));
    s.live.at = s.clock.now; // the phone claims "now"
    s.live.receivedAt = s.clock.now - 90_000; // the server last heard from it 90 s ago
    await expect(s.trips.arrive(driver, s.row().id)).rejects.toMatchObject({ code: "position_unknown" });
    s.live.receivedAt = s.clock.now - 5000;
    s.live.at = s.clock.now - 3_600_000; // a phone clock an hour behind doesn't matter
    expect((await s.trips.arrive(driver, s.row().id)).arrivedAt).not.toBeNull();
  });
});

describe("completing a ride", () => {
  const started = () => baseTrip({ status: "in_progress", startedAt: new Date(T0 - 20_000) });

  it("refuses a ride that ended right after the start with the car still at the pickup", async () => {
    const s = setup(started());
    await expect(s.trips.complete(driver, s.row().id)).rejects.toMatchObject({ statusCode: 409, code: "trip_not_driven" });
    expect(s.row().status).toBe("in_progress");
  });

  it("a short ride that did move is completed but flagged for review", async () => {
    const s = setup(started());
    s.live.pos = near(BOLE, 900);
    const u = await s.trips.complete(driver, s.row().id);
    expect(u.status).toBe("completed");
    expect(u.flags).toEqual(["FAR_FROM_DROPOFF", "SHORT_TRIP"]);
  });

  it("a short ride ending at the drop-off (pickup and drop-off close together) only gets SHORT_TRIP", async () => {
    const s = setup(baseTrip({ status: "in_progress", startedAt: new Date(T0 - 20_000), dropoffLat: near(BOLE, 150).lat, dropoffLng: BOLE.lng }));
    s.live.pos = near(BOLE, 140);
    expect((await s.trips.complete(driver, s.row().id)).flags).toEqual(["SHORT_TRIP"]);
  });

  it("a normal ride at the drop-off has no flags", async () => {
    const s = setup(baseTrip({ status: "in_progress", startedAt: new Date(T0 - 900_000) }));
    s.live.pos = near(PIASSA, 20);
    expect((await s.trips.complete(driver, s.row().id)).flags).toEqual([]);
  });
});

describe("rider cancel: \"the driver asked me to cancel\"", () => {
  it("is charged like any rider cancel and flagged for support", async () => {
    const s = setup(baseTrip({ arrivedAt: null, matchedAt: new Date(T0 - 600_000) }));
    const u = await s.trips.cancel(rider, s.row().id, "DRIVER_ASKED_TO_CANCEL");
    expect(u.cancelFeeMinor).toBe(3000n);
    expect(u.flags).toEqual(["RIDER_SAYS_DRIVER_ASKED"]);
    expect(s.outbox.find((e) => e.topic === "trip.cancelled")?.payload).toMatchObject({ feeMinor: 3000 });
    // the driver of the cancelled trip leaves its live-position room
    expect(s.leaves).toEqual([{ userId: DRIVER, tripId: s.row().id }]);
  });

  it("within the free window it stays free (still flagged)", async () => {
    const s = setup(baseTrip({ arrivedAt: null, matchedAt: new Date(T0 - 30_000) }));
    const u = await s.trips.cancel(rider, s.row().id, "DRIVER_ASKED_TO_CANCEL");
    expect(u.cancelFeeMinor).toBe(0n);
    expect(u.flags).toEqual(["RIDER_SAYS_DRIVER_ASKED"]);
  });
});

describe("reassign", () => {
  it("makes the old driver leave the trip's live-position room", async () => {
    const s = setup(baseTrip({ status: "matched", arrivedAt: null }));
    const dispatcher = who("00000000-0000-4000-8000-0000000000e2", [{ r: "DISPATCHER", city: CITY }], "ride-admin");
    await s.trips.reassign(dispatcher, s.row().id, {});
    expect(s.leaves).toEqual([{ userId: DRIVER, tripId: s.row().id }]);
  });
});

describe("booking for someone else on a company account", () => {
  const coordinator = who("00000000-0000-4000-8000-0000000000b1", [{ r: "CORPORATE_COORDINATOR", org: ORG }]);
  const input = (riderUserId: string) => ({ paymentMethod: "CORPORATE" as const, billingOrgId: ORG, riderUserId });

  it("needs the rider to be a member of the company", async () => {
    const s = setup(baseTrip(), { members: [`${ORG}:${RIDER}`] });
    await expect(s.trips.authorizeBooking(coordinator, input(RIDER), CITY)).resolves.toMatchObject({ riderId: RIDER, channel: "CORPORATE_PORTAL" });
    await expect(s.trips.authorizeBooking(coordinator, input("00000000-0000-4000-8000-0000000000ff"), CITY))
      .rejects.toMatchObject({ statusCode: 403, code: "rider_not_in_org" });
  });
});

describe("tripView", () => {
  it("the driver doesn't get the rider's account id; the rider and staff do", () => {
    const t = baseTrip();
    expect(tripView(t, driver).riderUserId).toBeNull();
    expect(tripView(t, rider).riderUserId).toBe(RIDER);
    expect(tripView(t, { userId: "x", audience: "ride-admin" }).riderUserId).toBe(RIDER);
  });
});
