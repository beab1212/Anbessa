import { describe, expect, it } from "vitest";
import { quoteDiscount } from "../../src/quotes.js";
import { payableDiscount } from "../../src/trips/service.js";

describe("promo discount from the quote (workflow 15)", () => {
  it("is absent or zero without a promo", () => {
    expect(quoteDiscount({ fareMinor: 10_000 })).toBe(0);
    expect(quoteDiscount({ fareMinor: 10_000, discountMinor: 0 })).toBe(0);
  });

  it("is kept within 0 … fare", () => {
    expect(quoteDiscount({ fareMinor: 10_000, discountMinor: 2_500 })).toBe(2_500);
    expect(quoteDiscount({ fareMinor: 10_000, discountMinor: 12_000 })).toBe(10_000);
    expect(quoteDiscount({ fareMinor: 10_000, discountMinor: -5 })).toBe(0);
  });
});

describe("payable discount on a trip", () => {
  const trip = (promo: bigint, estimate: bigint, final: bigint | null = null) => ({ promoDiscountMinor: promo, fareEstimateMinor: estimate, fareFinalMinor: final });

  it("applies to the final fare once completed, else the estimate", () => {
    expect(payableDiscount(trip(2_000n, 10_000n))).toBe(2_000n);
    expect(payableDiscount(trip(2_000n, 10_000n, 10_900n))).toBe(2_000n);
  });

  it("never exceeds the fare, so the rider never pays below 0", () => {
    expect(payableDiscount(trip(12_000n, 10_000n))).toBe(10_000n);
    expect(payableDiscount(trip(12_000n, 10_000n, 11_000n))).toBe(11_000n);
    expect(payableDiscount(trip(0n, 10_000n, 11_000n))).toBe(0n);
  });
});
