import { describe, expect, it } from "vitest";
import {
  addisInputToIso, hhmmToMinutes, isoToAddisInput, lastMonth, minutesToHhmm, monthRangeProblem, policySummary, reassignCandidates,
  regulatoryTotals, scheduleProblem, splitTrace,
} from "./trips2";

describe("Addis datetime-local values", () => {
  it("round-trips through UTC (UTC+3, no daylight saving)", () => {
    expect(addisInputToIso("2026-11-04T10:00")).toBe("2026-11-04T07:00:00.000Z");
    expect(isoToAddisInput("2026-11-04T22:30:00Z")).toBe("2026-11-05T01:30");
    expect(addisInputToIso("tomorrow")).toBeNull();
  });
  it("checks the booking window", () => {
    const now = Date.parse("2026-11-04T07:00:00Z");
    expect(scheduleProblem(null, now)).toMatch(/date/);
    expect(scheduleProblem("2026-11-04T07:20:00Z", now)).toMatch(/30 minutes/);
    expect(scheduleProblem("2026-11-12T07:00:00Z", now)).toMatch(/7 days/);
    expect(scheduleProblem("2026-11-04T09:00:00Z", now)).toBeNull();
  });
});

describe("policy helpers", () => {
  it("converts hours", () => {
    expect(minutesToHhmm(390)).toBe("06:30");
    expect(hhmmToMinutes("06:30")).toBe(390);
    expect(hhmmToMinutes("24:00")).toBe(1440);
    expect(hhmmToMinutes("24:30")).toBeNull();
    expect(hhmmToMinutes("7")).toBeNull();
  });
  it("summarises the rules", () => {
    const money = (m: number) => `${m / 100} ETB`;
    const none = { allowedVehicleTypes: [], allowedDays: [], startMinute: null, endMinute: null, maxFareMinor: null, monthlyBudgetMinor: null, requirePurpose: false };
    expect(policySummary(none, money)).toEqual(["No limits: any car, any time"]);
    expect(policySummary({ ...none, allowedDays: [0, 1, 6], startMinute: 1320, endMinute: 360, maxFareMinor: 50000, requirePurpose: true }, money)).toEqual([
      "Days: Mon, Sat, Sun", "Hours: 22:00–06:00 (past midnight)", "Up to 500 ETB a ride", "A trip purpose is required",
    ]);
  });
});

describe("reassignCandidates", () => {
  it("free drivers of the trip's car type, nearest first, never the current driver", () => {
    const base = { vehicleId: "v", stale: false, status: "available" as const, vehicleType: "economy" };
    const trip = { vehicleType: "economy", pickup: { lat: 9, lng: 38.7 }, driver: { userId: "cur" } };
    const list = reassignCandidates([
      { ...base, driverId: "far", lat: 9.05, lng: 38.7 },
      { ...base, driverId: "near", lat: 9.001, lng: 38.7 },
      { ...base, driverId: "cur", lat: 9, lng: 38.7 },
      { ...base, driverId: "busy", status: "on_trip", lat: 9, lng: 38.7 },
      { ...base, driverId: "van", vehicleType: "minivan", lat: 9, lng: 38.7 },
      { ...base, driverId: "silent", stale: true, lat: 9, lng: 38.7 },
    ], trip);
    expect(list.map((d) => d.driverId)).toEqual(["near", "far"]);
  });
});

describe("trace legs", () => {
  it("splits by phase and joins the legs at the pickup", () => {
    const pts = [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }, { lat: 3, lng: 3 }, { lat: 4, lng: 4 }];
    const meta = (["to_pickup", "to_pickup", "ride", "ride"] as const).map((phase) => ({ at: "", phase, speed: null, accuracy: null }));
    const { toPickup, ride } = splitTrace(pts, meta);
    expect(toPickup).toEqual([pts[0], pts[1], pts[2]]);
    expect(ride).toEqual([pts[2], pts[3]]);
  });
});

describe("regulatory helpers", () => {
  it("last month in Addis time", () => {
    expect(lastMonth(Date.parse("2026-11-04T07:00:00Z"))).toBe("2026-10");
    // 31 Dec 22:00 UTC is already 1 Jan in Addis
    expect(lastMonth(Date.parse("2026-12-31T22:00:00Z"))).toBe("2026-12");
  });
  it("month range checks", () => {
    expect(monthRangeProblem("2026-01", "2026-12")).toBeNull();
    expect(monthRangeProblem("2026-01", "2027-01")).toMatch(/12 months/);
    expect(monthRangeProblem("2026-05", "2026-04")).toMatch(/after/);
  });
  it("totals add up counts but not distinct drivers", () => {
    const row = { month: "2026-10", cityId: "x", tripsRequested: 2, tripsCompleted: 1, tripsCancelled: 1, tripsNoDriver: 0, activeDrivers: 1, activeVehicles: 1, distanceKm: 1.25, safetyIncidents: 1, seriousIncidents: 0 };
    expect(regulatoryTotals([row, row])).toEqual({ tripsRequested: 4, tripsCompleted: 2, tripsCancelled: 2, tripsNoDriver: 0, distanceKm: 2.5, safetyIncidents: 2, seriousIncidents: 0 });
  });
});
