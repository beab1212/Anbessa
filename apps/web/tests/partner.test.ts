import { describe, expect, it } from "vitest";
import type { Trip } from "@ride-app/shared-types";
import {
  bookedTrips, cancelFeeNote, deviceLabel, invitationOpen, isCancellable, isOnRoad, looksLikePhone, quoteUsable,
  rememberBookedTrip, roleList, switchedRole, vehicleChoices, type BookedTrip, type KeyValueStore,
} from "../src/lib/partner";

const memoryStore = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

const times = (over: Partial<Trip["times"]> = {}): Trip["times"] => ({
  requestedAt: "2026-10-27T08:00:00Z", matchedAt: null, arrivedAt: null, startedAt: null, completedAt: null, cancelledAt: null, ...over,
});

describe("members", () => {
  it("switches employees and coordinators, nobody else", () => {
    expect(switchedRole("employee")).toBe("corporate_coordinator");
    expect(switchedRole("corporate_coordinator")).toBe("employee");
    expect(switchedRole("corporate_admin")).toBeNull();
    expect(switchedRole("fleet_driver")).toBeNull();
    expect(switchedRole("fleet_owner")).toBeNull();
    expect(switchedRole("employee,corporate_coordinator")).toBeNull();
    expect(roleList(" fleet_owner, fleet_driver ")).toEqual(["fleet_owner", "fleet_driver"]);
  });

  it("an invitation is open while pending and not expired", () => {
    const now = Date.parse("2026-10-27T10:00:00Z");
    expect(invitationOpen({ status: "pending", expiresAt: "2026-10-28T10:00:00Z" }, now)).toBe(true);
    expect(invitationOpen({ status: "pending", expiresAt: "2026-10-26T10:00:00Z" }, now)).toBe(false);
    expect(invitationOpen({ status: "canceled", expiresAt: "2026-10-28T10:00:00Z" }, now)).toBe(false);
  });
});

describe("company trips", () => {
  it("cancellable and live statuses", () => {
    expect(["requested", "matched", "en_route"].every(isCancellable)).toBe(true);
    expect(isCancellable("in_progress")).toBe(false);
    expect(isCancellable("completed")).toBe(false);
    expect(isOnRoad("requested")).toBe(false);
    expect(isOnRoad("in_progress")).toBe(true);
  });

  it("explains when a cancellation costs the company", () => {
    expect(cancelFeeNote({ status: "requested", times: times() }, "CHANGED_PLANS").free).toBe(true);
    const matched = { status: "matched" as const, times: times({ matchedAt: "2026-10-27T08:01:00Z" }) };
    // "the driver asked us" is charged like any cancel; support reviews it and refunds
    expect(cancelFeeNote(matched, "DRIVER_ASKED_TO_CANCEL")).toMatchObject({ free: false, text: expect.stringMatching(/support reviews/) });
    expect(cancelFeeNote(matched, "CHANGED_PLANS").free).toBe(false);
    const arrived = { status: "en_route" as const, times: times({ matchedAt: "2026-10-27T08:01:00Z", arrivedAt: "2026-10-27T08:06:00Z" }) };
    expect(cancelFeeNote(arrived, "CHANGED_PLANS").text).toMatch(/waiting/);
  });

  it("a quote stops being bookable just before it expires", () => {
    const now = Date.parse("2026-10-27T10:00:00Z");
    expect(quoteUsable(null, now)).toBe(false);
    expect(quoteUsable({ expiresAt: "2026-10-27T10:05:00Z" }, now)).toBe(true);
    expect(quoteUsable({ expiresAt: "2026-10-27T10:00:03Z" }, now)).toBe(false);
    expect(quoteUsable({}, now)).toBe(true);
  });

  it("remembers trips booked in this tab, per company, newest first, without duplicates", () => {
    const store = memoryStore();
    const trip = (id: string, orgId = "org-1"): BookedTrip => ({ id, orgId, rider: "r", from: "a", to: "b", vehicleType: "economy", fareMinor: 100, at: "2026-10-27T10:00:00Z" });
    rememberBookedTrip(trip("t1"), store);
    rememberBookedTrip(trip("t2"), store);
    rememberBookedTrip(trip("t3", "org-2"), store);
    rememberBookedTrip(trip("t1"), store);
    expect(bookedTrips("org-1", store).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(bookedTrips("org-2", store).map((t) => t.id)).toEqual(["t3"]);
    expect(bookedTrips("org-1", null)).toEqual([]);
    store.data.set("anbessa.partner.booked", "not json");
    expect(bookedTrips("org-1", store)).toEqual([]);
  });
});

describe("booking choices", () => {
  it("offers the city's vehicle types, or the built-in three before the config loads", () => {
    expect(vehicleChoices(null, "addis-ababa").map((c) => c.code)).toEqual(["economy", "comfort", "minivan"]);
    const config = {
      vehicleTypes: [
        { code: "economy", name: "Economy", seatsMin: 3, seatsMax: 4, cities: ["addis-ababa", "hawassa"] },
        { code: "minivan", name: "Minivan", seatsMin: 5, seatsMax: 8, cities: ["addis-ababa"] },
        { code: "bajaj", name: "Bajaj", seatsMin: 3, seatsMax: 3, cities: ["hawassa"] },
      ],
    };
    expect(vehicleChoices(config, "hawassa")).toEqual([
      { code: "economy", name: "Economy", seats: "3–4" },
      { code: "bajaj", name: "Bajaj", seats: "3" },
    ]);
  });
});

describe("account", () => {
  it("names devices from their user agent", () => {
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36")).toBe("Chrome on Android");
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36 Edg/130.0")).toBe("Edge on Windows");
    expect(deviceLabel("Dart/3.5 (dart:io)")).toBe("Anbessa app");
    expect(deviceLabel(null)).toBe("Unknown device");
  });

  it("doesn't treat the phone number as a name", () => {
    expect(looksLikePhone("+251911223344")).toBe(true);
    expect(looksLikePhone("Selam Tesfaye")).toBe(false);
  });
});
