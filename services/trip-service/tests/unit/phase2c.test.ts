import { describe, expect, it } from "vitest";
import { addisClock, addisMonth, withinHours } from "../../src/trips/corporate.js";
import { monthRange, regulatoryCsv } from "../../src/trips/regulatory.js";
import { DEFAULT_SCHEDULE, leadMinutes } from "../../src/trips/scheduled.js";
import { encodePolyline6, tracedDistance } from "../../src/trips/trace.js";

describe("encodePolyline6", () => {
  it("matches Google's example (precision 5 = the points ÷ 10 at precision 6)", () => {
    const pts = [{ lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }].map((p) => ({ lat: p.lat / 10, lng: p.lng / 10 }));
    expect(encodePolyline6(pts)).toBe("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(encodePolyline6([])).toBe("");
  });
});

describe("tracedDistance", () => {
  it("adds up the legs and skips GPS jumps", () => {
    const at = (s: number) => new Date(s * 1000);
    const pts = [
      { lat: 9, lng: 38.7, at: at(0) },
      { lat: 9 + 1000 / 111_320, lng: 38.7, at: at(100) },
      // 50 km in 10 s: a jump
      { lat: 9.5, lng: 38.7, at: at(110) },
    ];
    expect(tracedDistance(pts)).toBeGreaterThan(995);
    expect(tracedDistance(pts)).toBeLessThan(1005);
  });
});

describe("company policy clock", () => {
  it("uses Addis Ababa time (UTC+3)", () => {
    // Sat 31 Oct 2026 22:30 UTC = Sun 1 Nov 01:30 in Addis
    expect(addisClock(new Date("2026-10-31T22:30:00Z"))).toEqual({ day: 0, minute: 90, month: "2026-11" });
    expect(addisMonth(new Date("2026-10-31T22:30:00Z"))).toEqual({ from: new Date("2026-10-31T21:00:00Z"), to: new Date("2026-11-30T21:00:00Z") });
  });
  it("allowed hours may wrap past midnight", () => {
    expect(withinHours(600, 360, 1320)).toBe(true);
    expect(withinHours(1320, 360, 1320)).toBe(false);
    expect(withinHours(1380, 1320, 360)).toBe(true);
    expect(withinHours(120, 1320, 360)).toBe(true);
    expect(withinHours(600, 1320, 360)).toBe(false);
  });
});

describe("scheduled rides lead time", () => {
  it("is longer at night (22:00–06:00 Addis)", () => {
    expect(leadMinutes(new Date("2026-11-04T09:00:00Z"), DEFAULT_SCHEDULE)).toBe(15); // 12:00
    expect(leadMinutes(new Date("2026-11-04T19:00:00Z"), DEFAULT_SCHEDULE)).toBe(30); // 22:00
    expect(leadMinutes(new Date("2026-11-04T02:59:00Z"), DEFAULT_SCHEDULE)).toBe(30); // 05:59
    expect(leadMinutes(new Date("2026-11-04T03:00:00Z"), DEFAULT_SCHEDULE)).toBe(15); // 06:00
  });
});

describe("regulatory months", () => {
  const now = new Date("2026-11-04T07:00:00Z");
  it("defaults to last month and lists inclusive ranges", () => {
    expect(monthRange({}, now)).toEqual(["2026-10"]);
    expect(monthRange({ from: "2026-11", to: "2027-02" }, now)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });
  it("refuses bad or long ranges", () => {
    expect(() => monthRange({ from: "2026-13" }, now)).toThrow();
    expect(() => monthRange({ from: "2026-05", to: "2026-04" }, now)).toThrow();
    expect(() => monthRange({ from: "2025-01", to: "2026-01" }, now)).toThrow();
  });
  it("writes one CSV row per month and city", () => {
    const csv = regulatoryCsv([{ month: "2026-10", cityId: "hawassa", tripsRequested: 3, tripsCompleted: 2, tripsCancelled: 1, tripsNoDriver: 0, activeDrivers: 2, activeVehicles: 2, distanceKm: 12.3, safetyIncidents: 0, seriousIncidents: 0 }]);
    expect(csv.split("\r\n")[1]).toBe("2026-10,hawassa,3,2,1,0,2,2,12.3,0,0");
  });
});
