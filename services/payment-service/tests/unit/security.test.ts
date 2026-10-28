import { describe, expect, it } from "vitest";
import type { TripCancelledEvent, TripCompletedEvent } from "@ride-app/shared-types";
import { loadConfig, tripEventCheck } from "../../src/config/index.js";
import { cancelledMismatches, completedMismatches, type TripFacts } from "../../src/lib/trips.js";
import { coolingOffUntil } from "../../src/money/payouts.js";

const id = () => crypto.randomUUID();
const [trip, rider, driver, org] = [id(), id(), id(), id()];
const completed: TripCompletedEvent = {
  eventId: "e1", version: 1, at: "2026-10-29T08:00:00Z", tripId: trip, riderId: rider, driverId: driver, cityId: "addis-ababa", vehicleType: "economy", vehicleId: "v1",
  beneficiary: { type: "INDIVIDUAL", id: driver }, paymentMethod: "CARD", billingType: "PERSONAL", fareMinor: 20_000, waitingFeeMinor: 600, currency: "ETB",
  distanceMeters: 4000, durationSeconds: 600, completedAt: "2026-10-29T08:00:00Z", quoteId: "q_1", promoDiscountMinor: 2000,
};
const record: TripFacts = {
  id: trip, status: "completed", cityId: "addis-ababa", riderUserId: rider, paymentMethod: "CARD", billing: { type: "PERSONAL", orgId: null },
  driver: { userId: driver }, beneficiary: { type: "INDIVIDUAL", id: driver },
  fare: { finalMinor: 20_000, waitingFeeMinor: 600, promoDiscountMinor: 2000, currency: "ETB" }, cancellation: null,
};

describe("trip event vs trip-service's record", () => {
  it("agrees field by field", () => {
    expect(completedMismatches(completed, record)).toEqual([]);
  });

  it("names every money field that disagrees", () => {
    const forged = { ...completed, fareMinor: 90_000, promoDiscountMinor: 20_000, paymentMethod: "CORPORATE" as const, billingOrgId: org, beneficiary: { type: "INDIVIDUAL" as const, id: rider } };
    expect(completedMismatches(forged, record).map((m) => m.field)).toEqual(["beneficiary", "paymentMethod", "billingOrgId", "fareMinor", "promoDiscountMinor"]);
    expect(completedMismatches(completed, { ...record, status: "in_progress" })).toEqual([{ field: "status", event: "completed", trip: "in_progress" }]);
    expect(completedMismatches(completed, { ...record, driver: { userId: id() } }).map((m) => m.field)).toEqual(["driverId"]);
    expect(completedMismatches({ ...completed, currency: "USD" }, record).map((m) => m.field)).toEqual(["currency"]);
  });

  it("an older event without a discount means 0; an unknown trip is a mismatch", () => {
    const { promoDiscountMinor: _d, ...old } = completed;
    expect(completedMismatches(old as TripCompletedEvent, { ...record, fare: { ...record.fare, promoDiscountMinor: 0 } })).toEqual([]);
    expect(completedMismatches(completed, null)).toEqual([{ field: "trip", event: trip, trip: null }]);
  });

  it("cancellations: fee, compensation, who and how", () => {
    const e: TripCancelledEvent = {
      eventId: "e2", version: 1, at: "2026-10-29T08:00:00Z", tripId: trip, riderId: rider, driverId: driver, cityId: "addis-ababa", by: "RIDER", reason: "CHANGED_PLANS",
      paymentMethod: "CARD", feeMinor: 5000, driverCompensationMinor: 4000, beneficiary: { type: "INDIVIDUAL", id: driver }, currency: "ETB",
    };
    const cancelled: TripFacts = { ...record, status: "cancelled", fare: { ...record.fare, finalMinor: null }, cancellation: { feeMinor: 5000, driverCompensationMinor: 4000 } };
    expect(cancelledMismatches(e, cancelled)).toEqual([]);
    expect(cancelledMismatches({ ...e, feeMinor: 50_000 }, cancelled)).toEqual([{ field: "feeMinor", event: 50_000, trip: 5000 }]);
    expect(cancelledMismatches(e, { ...cancelled, status: "completed" }).map((m) => m.field)).toEqual(["status"]);
  });
});

describe("payout method cooling-off", () => {
  const at = new Date("2026-10-29T08:00:00Z");
  const H = 3_600_000;
  it("holds a method changed less than the period ago", () => {
    expect(coolingOffUntil(new Date(at.getTime() - 71 * H), 72 * H, at)).toEqual(new Date(at.getTime() + H));
    expect(coolingOffUntil(new Date(at.getTime() - 72 * H), 72 * H, at)).toBeNull();
    expect(coolingOffUntil(null, 72 * H, at)).toBeNull();
    expect(coolingOffUntil(at, 0, at)).toBeNull();
  });
});

describe("configuration", () => {
  const base = {
    DATABASE_URL: "postgresql://x@localhost/db", INTERNAL_SERVICE_TOKEN: "t".repeat(64),
    TELEBIRR_WEBHOOK_SECRET: "a".repeat(48), CBEBIRR_WEBHOOK_SECRET: "b".repeat(48), CHAPA_WEBHOOK_SECRET: "c".repeat(48),
  };
  it("checks trip events by default, except in tests; never off in production", () => {
    expect(tripEventCheck(loadConfig({ ...base, NODE_ENV: "development" }))).toBe(true);
    expect(tripEventCheck(loadConfig({ ...base, NODE_ENV: "test" }))).toBe(false);
    expect(tripEventCheck(loadConfig({ ...base, NODE_ENV: "development", TRIP_EVENT_CHECK: "off" }))).toBe(false);
    const prod = () => loadConfig({ ...base, NODE_ENV: "production", TRIP_EVENT_CHECK: "off", KAFKA_BROKERS: "k:9092", REDIS_URL: "redis://r:6379" });
    expect(prod).toThrow(/TRIP_EVENT_CHECK/);
  });
  it("cools a new payout method off for 72 hours by default", () => {
    expect(loadConfig({ ...base, NODE_ENV: "test" }).PAYOUT_METHOD_COOLOFF_HOURS).toBe(72);
  });
});
