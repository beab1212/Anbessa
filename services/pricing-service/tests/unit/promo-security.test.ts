import { describe, expect, it } from "vitest";
import { staticSettings } from "@ride-app/shared-settings";
import { approvalNeeded, fitsPromo, sumLiveBudgets, type PromoService } from "../../src/promos/service.js";
import { createQuotes, type Quote } from "../../src/quotes.js";

describe("approval threshold across live promos", () => {
  const live = (createdBy: string, cityIds: string[], budgetMinor: number) => ({ createdBy, cityIds, budgetMinor });

  it("adds the creator's and each city's live budgets (a promo in every city counts everywhere)", () => {
    const t = sumLiveBudgets({ createdBy: "a", cityIds: ["addis-ababa"] }, [
      live("a", ["hawassa"], 400), live("b", ["addis-ababa"], 300), live("c", [], 200), live("d", ["hawassa"], 999),
    ]);
    expect(t).toEqual({ creatorMinor: 400, byCity: { "addis-ababa": 500 } });
    expect(sumLiveBudgets({ createdBy: "a", cityIds: [] }, [live("b", ["hawassa"], 100), live("c", ["addis-ababa"], 50)]).byCity).toEqual({ "*": 150 });
  });

  it("is needed when this budget plus either total passes the threshold", () => {
    expect(approvalNeeded(1001, { creatorMinor: 0, byCity: {} }, 1000)).toBe(true);
    expect(approvalNeeded(600, { creatorMinor: 0, byCity: { x: 0 } }, 1000)).toBe(false);
    expect(approvalNeeded(600, { creatorMinor: 500, byCity: { x: 0 } }, 1000)).toBe(true);
    expect(approvalNeeded(600, { creatorMinor: 0, byCity: { x: 100, y: 401 } }, 1000)).toBe(true);
    expect(approvalNeeded(600, { creatorMinor: 400, byCity: { x: 400 } }, 1000)).toBe(false);
  });
});

describe("a booking fits the promo", () => {
  const promo = { budgetMinor: 10_000, spentMinor: 4000, maxRedemptions: null as number | null, redemptionCount: 2 };

  it("counts redeemed and booked discounts against the budget", () => {
    expect(fitsPromo(promo, { minor: 4000, count: 2 }, 2000)).toBe(true);
    expect(fitsPromo(promo, { minor: 4000, count: 2 }, 2001)).toBe(false);
  });

  it("counts redemptions and bookings against maxRedemptions", () => {
    expect(fitsPromo({ ...promo, maxRedemptions: 5 }, { minor: 0, count: 2 }, 100)).toBe(true);
    expect(fitsPromo({ ...promo, maxRedemptions: 4 }, { minor: 0, count: 2 }, 100)).toBe(false);
  });
});

describe("reading a quote to book", () => {
  const quote = (): Quote => ({
    id: "q_1", requestedBy: "u1", cityId: "addis-ababa", vehicleType: "economy", pickup: { lat: 9, lng: 38.7 }, dropoff: { lat: 9.01, lng: 38.71 },
    fareMinor: 10_000, waitingPerMinMinor: 0, currency: "ETB", distanceMeters: 1, durationSeconds: 1, approximate: false,
    etaToPickupSeconds: null, driversNearby: 0, breakdown: {} as Quote["breakdown"], fareRuleId: null, zoneIds: [],
    discountMinor: 2000, payableMinor: 8000, promo: { promoId: "p", code: "X", discountMinor: 2000, fundedBy: "PLATFORM" }, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const setup = (book: (quoteId: string, b: { tripId: string; userId: string }) => Promise<boolean>) => {
    const calls: unknown[] = [];
    const promos = { book: async (id: string, b: { tripId: string; userId: string }) => (calls.push([id, b]), book(id, b)) } as unknown as PromoService;
    const q = quote();
    const quotes = createQuotes({ store: { put: async () => {}, get: async () => q }, settings: staticSettings({}), promos, mapping: { route: async () => ({ distanceMeters: 1, durationSeconds: 1, approximate: false }) } });
    return { quotes, calls };
  };

  it("names the trip and the booker to pricing, and keeps the discount only when it was booked", async () => {
    const ok = setup(async () => true);
    expect(await ok.quotes.forBooking("q_1", { tripId: "t1", userId: "u1" })).toMatchObject({ discountMinor: 2000, promo: { code: "X" } });
    expect(ok.calls).toEqual([["q_1", { tripId: "t1", userId: "u1" }]]);
    const refused = setup(async () => false);
    const served = await refused.quotes.forBooking("q_1", { tripId: "t1", userId: "u1" });
    expect(served).toMatchObject({ discountMinor: 0, payableMinor: 10_000 });
    expect(served?.promo).toBeUndefined();
  });

  it("without a trip the discount is never given and nothing is booked", async () => {
    const s = setup(async () => true);
    expect(await s.quotes.forBooking("q_1")).toMatchObject({ discountMinor: 0, payableMinor: 10_000 });
    expect(s.calls).toEqual([]);
  });
});
