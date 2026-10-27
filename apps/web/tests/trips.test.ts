import { describe, expect, it } from "vitest";
import type { LiveDriver } from "../src/lib/hooks";
import {
  cancelReasonLabel, carLine, filterDrivers, initial, isCancellable, loadRecentTrips, looksLikeTripId, phoneMethods, providersFor,
  pushRecent, RECENT_MAX, routeSummary, STAFF_CANCEL_REASONS, vehicleOptions, vehicleTypesOf,
} from "../src/lib/trips";

const ID = "01a17557-ef39-7ee9-b4c2-6b045e0dd06b";

describe("cancelling", () => {
  it("offers only reasons trip-service accepts from staff", () => {
    const accepted = ["CHANGED_PLANS", "DRIVER_TOO_FAR", "DRIVER_ASKED_TO_CANCEL", "WRONG_PICKUP", "NO_SHOW", "SAFETY", "OTHER", "STAFF_DECISION"];
    const codes = STAFF_CANCEL_REASONS.map(([c]) => c as string);
    expect(codes.every((c) => accepted.includes(c))).toBe(true);
    expect(codes).not.toContain("NO_SHOW"); // drivers only
    expect(codes[0]).toBe("STAFF_DECISION");
  });

  it("labels reasons, including ones staff can't pick", () => {
    expect(cancelReasonLabel("SAFETY")).toBe("Safety concern");
    expect(cancelReasonLabel("NO_DRIVER_FOUND")).toBe("No driver found");
    expect(cancelReasonLabel("SOMETHING_NEW")).toBe("something new");
    expect(cancelReasonLabel(null)).toBe("—");
  });

  it("knows which statuses can still be cancelled", () => {
    expect(["requested", "matched", "en_route"].every(isCancellable)).toBe(true);
    expect(isCancellable("in_progress")).toBe(false);
    expect(isCancellable("completed")).toBe(false);
  });
});

describe("parties", () => {
  it("describes the car from whatever parts exist", () => {
    expect(carLine({ plateNumber: "AA 3-12345", vehicleType: "economy", make: "Toyota", model: "Vitz", color: "white" })).toBe("White Toyota Vitz");
    expect(carLine({ plateNumber: "X", vehicleType: "economy", make: null, model: " ", color: null })).toBe("economy");
    expect(carLine(null)).toBe("");
    expect(initial("abebe")).toBe("A");
    expect(initial(null)).toBe("?");
  });
});

describe("recent trips", () => {
  it("keeps the newest first without duplicates, capped", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    const many = Array.from({ length: 20 }, (_, i) => String(i));
    expect(pushRecent(many, "new")).toHaveLength(RECENT_MAX);
    expect(pushRecent([], "x", 3)).toEqual(["x"]);
  });

  it("only takes full trip ids", () => {
    expect(looksLikeTripId(ID)).toBe(true);
    expect(looksLikeTripId(` ${ID} `)).toBe(true);
    expect(looksLikeTripId("0DD06B")).toBe(false);
  });

  it("survives missing storage", () => {
    expect(loadRecentTrips()).toEqual([]);
  });
});

describe("routes and offers", () => {
  it("summarises distance and time", () => {
    expect(routeSummary(3240, 725)).toBe("3.2 km · 12 min");
    expect(routeSummary(800, 20)).toBe("0.8 km · 1 min");
    expect(routeSummary(null, null)).toBe("");
  });

  it("lists the city's enabled car types, falling back to the built-in three", () => {
    expect(vehicleOptions(null, "addis-ababa").map((v) => v.code)).toEqual(["economy", "comfort", "minivan"]);
    const cfg = {
      vehicleTypes: [
        { code: "economy", name: "Economy", seatsMin: 4, seatsMax: 4, cities: [] },
        { code: "bajaj", name: "Bajaj", seatsMin: 2, seatsMax: 3, cities: ["hawassa"] },
      ],
    };
    expect(vehicleOptions(cfg, "addis-ababa")).toEqual([{ code: "economy", name: "Economy", seats: "4 seats" }]);
    expect(vehicleOptions(cfg, "hawassa").map((v) => v.seats)).toEqual(["4 seats", "2–3 seats"]);
  });

  it("offers phone callers cash and mobile money when the city has them", () => {
    expect(phoneMethods(["CASH", "MOBILE_MONEY", "CARD"])).toEqual(["CASH", "MOBILE_MONEY"]);
    expect(phoneMethods(["CARD", "MOBILE_MONEY"])).toEqual(["MOBILE_MONEY"]);
    expect(phoneMethods(["CARD"])).toEqual([]);
    expect(phoneMethods(undefined)).toEqual(["CASH", "MOBILE_MONEY"]);
    const providers = [
      { provider: "telebirr", label: "telebirr", methods: ["MOBILE_MONEY"], mode: "live" },
      { provider: "chapa", label: "Chapa", methods: ["CARD", "MOBILE_MONEY"], mode: "test" },
    ];
    expect(providersFor("MOBILE_MONEY", providers)).toBe("telebirr, Chapa");
    expect(providersFor("CASH", providers)).toBe("");
  });
});

describe("live map filters", () => {
  const d = (id: string, over: Partial<LiveDriver>): LiveDriver => ({ driverId: id, status: "available", vehicleType: "economy", vehicleId: "v", lat: 9, lng: 38, stale: false, ...over });
  const list = [d("1", {}), d("2", { status: "on_trip", tripId: ID }), d("3", { stale: true, vehicleType: "minivan" }), d("4", { vehicleType: "minivan" })];

  it("filters by state and car type", () => {
    expect(filterDrivers(list, { state: "all", vehicleType: "all" })).toHaveLength(4);
    expect(filterDrivers(list, { state: "free", vehicleType: "all" }).map((x) => x.driverId)).toEqual(["1", "4"]);
    expect(filterDrivers(list, { state: "silent", vehicleType: "all" }).map((x) => x.driverId)).toEqual(["3"]);
    expect(filterDrivers(list, { state: "free", vehicleType: "minivan" }).map((x) => x.driverId)).toEqual(["4"]);
    expect(vehicleTypesOf(list)).toEqual(["economy", "minivan"]);
  });
});
