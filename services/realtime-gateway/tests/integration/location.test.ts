// The socket handlers against a real Redis, with stand-ins for Socket.io's io/socket objects.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import type { Server, Socket } from "socket.io";
import type { Principal } from "@ride-app/shared-authz";
import { getDriverState, goOnline, startTrip } from "@ride-app/shared-location";
import type { DriverLocationEvent } from "@ride-app/shared-types";
import { registerLocationHandlers } from "../../src/sockets/location.handler.js";
import type { LocationPublisher } from "../../src/kafka.js";
import { TEST_REDIS_URL } from "./global-setup.js";

const BOLE = { lat: 8.9806, lng: 38.7578 };
let redis: Redis;

beforeAll(() => {
  redis = new Redis(TEST_REDIS_URL);
});
afterAll(() => redis?.disconnect());
beforeEach(() => redis.flushdb()); // the dedicated test Redis only

function connect(principal: Principal) {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const emitted: { room: string; event: string; data: unknown }[] = [];
  const joined: string[] = [];
  const published: DriverLocationEvent[] = [];
  const socket = {
    data: { principal, userId: principal.userId },
    on: (event: string, fn: (...args: unknown[]) => Promise<void>) => handlers.set(event, fn),
    join: async (room: string) => void joined.push(room),
    leave: async () => undefined,
  } as unknown as Socket;
  const io = { to: (room: string) => ({ emit: (event: string, data: unknown) => emitted.push({ room, event, data }) }) } as unknown as Server;
  const publisher: LocationPublisher = { publish: (e) => void published.push(e), stats: () => ({ published: 0, dropped: 0 }), stop: async () => undefined };
  registerLocationHandlers(io, socket, { redis, publisher });
  const call = (event: string, ...args: unknown[]) =>
    new Promise<Record<string, unknown>>((resolve) => void handlers.get(event)!(...args, resolve));
  return { call, emitted, joined, published };
}

const driver = (userId = crypto.randomUUID()): Principal => ({ userId, audience: "ride-app", roles: [{ role: "DRIVER", scope: "SELF" }], permissionVersion: 0, amr: ["otp"] });
const rider = (userId = crypto.randomUUID()): Principal => ({ userId, audience: "ride-app", roles: [{ role: "RIDER", scope: "SELF" }], permissionVersion: 0, amr: ["otp"] });

describe("location:update", () => {
  it("only drivers may stream; the driver id is the token's subject", async () => {
    const r = connect(rider());
    expect(await r.call("location:update", { ...BOLE })).toEqual({ accepted: false, reason: "forbidden" });

    const p = driver();
    await goOnline(redis, { driverId: p.userId, cityId: "addis-ababa", vehicleType: "economy", vehicleId: "v", cashAllowed: true });
    const d = connect(p);
    expect(await d.call("location:update", { ...BOLE, driverId: "someone-else", accuracy: 5 })).toEqual({ accepted: true });
    expect((await getDriverState(redis, p.userId))?.lat).toBe(BOLE.lat);
    expect(d.published).toEqual([expect.objectContaining({ driverId: p.userId, cityId: "addis-ababa", lat: BOLE.lat })]);
  });

  it("a driver who isn't online is told so, and nothing is published", async () => {
    const d = connect(driver());
    expect(await d.call("location:update", { ...BOLE })).toEqual({ accepted: false, reason: "not_online" });
    expect(d.published).toEqual([]);
  });

  it("drops pings sent faster than once a second", async () => {
    const p = driver();
    await goOnline(redis, { driverId: p.userId, cityId: "addis-ababa", vehicleType: "economy", vehicleId: "v", cashAllowed: true });
    const d = connect(p);
    await d.call("location:update", { ...BOLE });
    expect(await d.call("location:update", { ...BOLE })).toEqual({ accepted: false, reason: "too_frequent" });
  });

  it("fans out to the assigned trip only, ignoring any trip id in the message", async () => {
    const p = driver();
    const tripId = crypto.randomUUID();
    await goOnline(redis, { driverId: p.userId, cityId: "addis-ababa", vehicleType: "economy", vehicleId: "v", cashAllowed: true });
    await startTrip(redis, { tripId, driverId: p.userId, riderId: crypto.randomUUID() });
    const d = connect(p);
    await d.call("location:update", { ...BOLE, speed: 8.5, heading: 90, tripId: "victim-trip" });
    expect(d.emitted).toEqual([{ room: `trip:${tripId}`, event: "driver:location", data: expect.objectContaining({ tripId, driverId: p.userId, speed: 8.5, heading: 90 }) }]);
    expect(d.published[0]?.tripId).toBe(tripId);
  });
});

describe("trip:subscribe", () => {
  it("only the trip's rider and driver may watch it", async () => {
    const r = rider();
    const tripId = crypto.randomUUID();
    await startTrip(redis, { tripId, driverId: crypto.randomUUID(), riderId: r.userId });

    const stranger = connect(rider());
    expect(await stranger.call("trip:subscribe", tripId)).toEqual({ ok: false, reason: "not_found" });
    expect(stranger.joined).toEqual([]);

    const own = connect(r);
    expect(await own.call("trip:subscribe", tripId)).toEqual({ ok: true });
    expect(own.joined).toEqual([`trip:${tripId}`]);
    expect(await own.call("trip:subscribe", "../../etc")).toEqual({ ok: false, reason: "invalid" });
  });
});
