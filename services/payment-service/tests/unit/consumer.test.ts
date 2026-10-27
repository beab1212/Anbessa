import { describe, expect, it } from "vitest";
import { schemas } from "../../src/events/consumer.js";

const id = () => crypto.randomUUID();
const completed = (over: Record<string, unknown> = {}) => ({
  eventId: "e1", version: 1, at: new Date().toISOString(), tripId: id(), riderId: id(), driverId: id(), cityId: "addis-ababa",
  vehicleType: "economy", vehicleId: "v1", beneficiary: { type: "INDIVIDUAL", id: id() }, paymentMethod: "CORPORATE", billingType: "CORPORATE",
  fareMinor: 20_000, waitingFeeMinor: 0, currency: "ETB", distanceMeters: 4000, durationSeconds: 600, completedAt: new Date().toISOString(), ...over,
});

describe("event schemas", () => {
  it("a company-billed trip must name the company (never settled as cash)", () => {
    expect(schemas["trip.completed"].safeParse(completed({ billingOrgId: id() })).success).toBe(true);
    const bad = schemas["trip.completed"].safeParse(completed());
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(["billingOrgId"]);
    expect(schemas["trip.completed"].safeParse(completed({ paymentMethod: "CASH", billingType: "PERSONAL" })).success).toBe(true);
  });

  it("trip.completed carries the promo discount and quote (optional; older events have neither)", () => {
    const cash = { paymentMethod: "CASH", billingType: "PERSONAL" };
    expect(schemas["trip.completed"].parse(completed({ ...cash, quoteId: "q_1", promoDiscountMinor: 2000 }))).toMatchObject({ quoteId: "q_1", promoDiscountMinor: 2000 });
    expect(schemas["trip.completed"].safeParse(completed({ ...cash, promoDiscountMinor: -1 })).success).toBe(false);
    expect(schemas["trip.completed"].safeParse(completed({ ...cash, promoDiscountMinor: 1.5 })).success).toBe(false);
  });

  it("the same for a cancellation fee", () => {
    const base = { eventId: "e2", version: 1, at: new Date().toISOString(), tripId: id(), riderId: id(), cityId: "addis-ababa", by: "RIDER", reason: "CHANGED_PLANS", feeMinor: 3000, driverCompensationMinor: 2000, currency: "ETB" };
    expect(schemas["trip.cancelled"].safeParse({ ...base, paymentMethod: "CORPORATE" }).success).toBe(false);
    expect(schemas["trip.cancelled"].safeParse({ ...base, paymentMethod: "CORPORATE", billingOrgId: id() }).success).toBe(true);
  });
});
