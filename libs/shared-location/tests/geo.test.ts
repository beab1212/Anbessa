import { describe, expect, it } from "vitest";
import { checkPing, haversineMeters, isValidLatLng, keys } from "../src/index.js";

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
