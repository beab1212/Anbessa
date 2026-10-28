import { describe, expect, it } from "vitest";
import { checkPing, haversineMeters, isValidLatLng, keys, recordPing } from "../src/index.js";

const now = 1_792_900_000_000;
const bole = { lat: 8.9806, lng: 38.7578 };
const piassa = { lat: 9.0333, lng: 38.75 };

describe("haversineMeters", () => {
  it("measures Bole → Piassa at about 5.9 km", () => {
    expect(haversineMeters(bole, piassa)).toBeGreaterThan(5800);
    expect(haversineMeters(bole, piassa)).toBeLessThan(6000);
    expect(haversineMeters(bole, bole)).toBe(0);
  });
});

describe("checkPing (workflow 04, step 9)", () => {
  const prev = { ...bole, at: now - 4000 };

  it("accepts a normal ping", () => {
    expect(checkPing({ ...bole, lat: bole.lat + 0.0002, at: now, accuracy: 8 }, prev, now)).toBeUndefined();
    expect(checkPing({ ...bole, at: now }, undefined, now)).toBeUndefined();
  });

  it("drops invalid coordinates", () => {
    expect(checkPing({ lat: Number.NaN, lng: 38, at: now }, undefined, now)).toBe("invalid");
    expect(checkPing({ lat: 89, lng: 38, at: now }, undefined, now)).toBe("invalid"); // beyond Redis GEO range
    expect(checkPing({ lat: 9, lng: 181, at: now }, undefined, now)).toBe("invalid");
  });

  it("drops inaccurate, future and out-of-order pings", () => {
    expect(checkPing({ ...bole, at: now, accuracy: 150 }, prev, now)).toBe("inaccurate");
    expect(checkPing({ ...bole, at: now + 60_000 }, prev, now)).toBe("future");
    expect(checkPing({ ...bole, at: prev.at }, prev, now)).toBe("out_of_order");
  });

  it("drops a jump faster than 200 km/h (GPS spoofing, glitches)", () => {
    // 5.9 km in 4 s ≈ 5,300 km/h
    expect(checkPing({ ...piassa, at: now }, prev, now)).toBe("too_fast");
    // 5.9 km in 5 min ≈ 70 km/h is fine
    expect(checkPing({ ...piassa, at: now }, { ...bole, at: now - 300_000 }, now)).toBeUndefined();
  });

  it("judges speed by the server's clock when the phone claims far more time passed", () => {
    // phone clock set an hour back for the previous ping, then right: 5.9 km "in an hour", really in 4 s
    const backdated = { ...bole, at: now - 3_600_000, receivedAt: now - 4000 };
    expect(checkPing({ ...piassa, at: now }, backdated, now)).toBe("too_fast");
    // the same jump with the server seeing 5 minutes pass is a plausible drive
    expect(checkPing({ ...piassa, at: now }, { ...bole, at: now - 300_000, receivedAt: now - 300_000 }, now)).toBeUndefined();
    // pings queued during a short signal loss (device interval > server interval, within the lead) still pass
    expect(checkPing({ ...bole, lat: bole.lat + 0.002, at: now }, { ...bole, at: now - 30_000, receivedAt: now - 200 }, now)).toBeUndefined();
  });

  it("isValidLatLng narrows types", () => {
    expect(isValidLatLng({ lat: "9", lng: 38 })).toBe(false);
  });
});

describe("keys", () => {
  it("hash-tags city keys and refuses unsafe ids", () => {
    expect(keys.geo("addis-ababa", "economy", "available")).toBe("geo:{addis-ababa}:economy:available");
    expect(keys.seen("addis-ababa")).toBe("seen:{addis-ababa}");
    expect(() => keys.geo("addis ababa", "economy", "available")).toThrow();
    expect(() => keys.geo("addis-ababa", "eco}nomy", "busy")).toThrow();
  });
});

describe("recordPing", () => {
  // just enough of ioredis for recordPing: one driver hash, pipelined writes recorded
  function fakeRedis(hash: Record<string, string>) {
    const writes: Record<string, string>[] = [];
    const pipe: Record<string, unknown> = {};
    for (const m of ["geoadd", "zrem", "zadd", "expire"]) pipe[m] = () => pipe;
    pipe.hset = (_key: string, fields: Record<string, string>) => (writes.push(fields), pipe);
    pipe.exec = async () => [];
    return { redis: { hgetall: async () => hash, pipeline: () => pipe } as never, writes };
  }

  it("stores the server receive time next to the phone's time", async () => {
    const { redis, writes } = fakeRedis({ status: "available", cityId: "addis-ababa", vehicleType: "economy" });
    const r = await recordPing(redis, "d1", { ...bole, at: now - 90_000 }, now);
    expect(r).toMatchObject({ accepted: true, state: { at: now - 90_000, receivedAt: now } });
    expect(writes[0]).toMatchObject({ at: String(now - 90_000), rt: String(now) });
  });

  it("refuses a teleport hidden behind a phone clock set back", async () => {
    const { redis } = fakeRedis({
      status: "available", cityId: "addis-ababa", vehicleType: "economy",
      lat: String(bole.lat), lng: String(bole.lng), at: String(now - 3_600_000), rt: String(now - 5000),
    });
    expect(await recordPing(redis, "d1", { ...piassa, at: now }, now)).toEqual({ accepted: false, reason: "too_fast" });
  });
});
