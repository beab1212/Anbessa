import { describe, expect, it } from "vitest";
import { addisTime, reassignedRiderPush, receiptPush, scheduleCancelledPush, scheduledPush, scheduleFailedPush, sosResolvedPush } from "../../src/notify/templates.js";

describe("scheduled ride, reassignment and SOS templates", () => {
  it("shows times in Addis Ababa, 24-hour", () => {
    expect(addisTime("2026-11-03T11:30:00.000Z")).toBe("Tue 3 Nov, 14:30");
    expect(addisTime("2026-11-03T21:05:00.000Z")).toBe("Wed 4 Nov, 00:05");
    expect(addisTime("not a date")).toBe("your booked time");
  });

  it("says who booked and who cancelled", () => {
    expect(scheduledPush("s", "2026-11-03T11:30:00.000Z", { updated: false, for: "self" }).body).toBe("Your ride is booked for Tue 3 Nov, 14:30. We'll find your driver shortly before.");
    expect(scheduledPush("s", "2026-11-03T11:30:00.000Z", { updated: false, for: "rider" }).body).toMatch(/^A ride has been booked for you/);
    expect(scheduledPush("s", "2026-11-03T11:30:00.000Z", { updated: true, for: "rider" }).title).toBe("Scheduled ride updated");
    expect(scheduledPush("s", "2026-11-03T11:30:00.000Z", { updated: false, for: "booker" }).body).toBe("The ride you booked is set for Tue 3 Nov, 14:30. We'll find a driver shortly before.");
    expect(scheduleCancelledPush("s", "2026-11-03T11:30:00.000Z", "STAFF").body).toContain("cancelled by Anbessa support");
    expect(scheduleFailedPush("s", "2026-11-03T11:30:00.000Z", "RIDER_HAS_ACTIVE_TRIP").body).toContain("still on another trip");
    expect(scheduleFailedPush("s", "2026-11-03T11:30:00.000Z", "DISPATCH_FAILED").body).not.toContain("another trip");
  });

  it("reassignment and SOS outcomes", () => {
    expect(reassignedRiderPush("t", true).title).toBe("Your driver changed");
    expect(reassignedRiderPush("t", false).title).toBe("Finding you a new driver");
    expect(sosResolvedPush("a", "t", "ESCALATED").body).toContain("investigations");
    expect(sosResolvedPush("a", "t", "FALSE_ALARM").body).toContain("991");
  });

  it("every push fits a notification line (≤ 160 characters)", () => {
    const all = [
      scheduledPush("s", "2026-11-03T11:30:00.000Z", { updated: false, for: "rider" }),
      scheduleCancelledPush("s", "2026-11-03T11:30:00.000Z", "STAFF"),
      scheduleFailedPush("s", "2026-11-03T11:30:00.000Z", "RIDER_HAS_ACTIVE_TRIP"),
      sosResolvedPush("a", "t", "ESCALATED"),
    ];
    for (const m of all) expect(m.body.length).toBeLessThanOrEqual(160);
  });

  it("the receipt shows what the rider paid after a promo, never below zero", () => {
    expect(receiptPush(40000, "CASH", "TRIP", "t").body).toBe("400 ETB paid by cash. Thanks for riding with Anbessa.");
    expect(receiptPush(40000, "CARD", "TRIP", "t", 5000).body).toBe("350 ETB paid by card (50 ETB off with a promo code). Thanks for riding with Anbessa.");
    expect(receiptPush(40000, "CARD", "TRIP", "t", 90000).body).toBe("0 ETB paid by card (400 ETB off with a promo code). Thanks for riding with Anbessa.");
  });
});
