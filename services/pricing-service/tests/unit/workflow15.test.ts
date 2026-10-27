import { describe, expect, it } from "vitest";
import { zoneEffect, type CachedZone } from "../../src/catalog.js";
import { price } from "../../src/fares.js";
import { discountFor } from "../../src/promos/discount.js";
import { impactOf } from "../../src/rules/service.js";
import { checkRing, containsPoint, normalizeRing } from "../../src/zones/geometry.js";

// a ~1 km square around Bole airport, and a bow-tie that crosses itself
const SQUARE: [number, number][] = [[38.79, 8.97], [38.80, 8.97], [38.80, 8.98], [38.79, 8.98]];
const BOWTIE: [number, number][] = [[38.79, 8.97], [38.80, 8.98], [38.80, 8.97], [38.79, 8.98]];
const INSIDE = { lat: 8.975, lng: 38.795 };
const OUTSIDE = { lat: 9.03, lng: 38.75 };

describe("zone geometry", () => {
  it("closes the ring and accepts a simple polygon inside the city", () => {
    const ring = normalizeRing(SQUARE);
    expect(ring).toHaveLength(5);
    expect(ring.at(-1)).toEqual(ring[0]);
    expect(checkRing(ring, "addis-ababa")).toBeNull();
  });

  it("refuses self-intersecting, degenerate, too small and out-of-city outlines", () => {
    expect(checkRing(normalizeRing(BOWTIE), "addis-ababa")).toBe("self_intersecting");
    expect(checkRing(normalizeRing([[38.79, 8.97], [38.80, 8.97], [38.81, 8.97]]), "addis-ababa")).toBe("zero_area");
    expect(checkRing(normalizeRing([[38.79, 8.97], [38.80, 8.97]]), "addis-ababa")).toBe("too_few_points");
    expect(checkRing(normalizeRing(SQUARE), "hawassa")).toBe("outside_city");
    expect(checkRing(normalizeRing(SQUARE), "atlantis")).toBe("unknown_city");
  });

  it("point in polygon, boundary counts as inside", () => {
    const ring = normalizeRing(SQUARE);
    expect(containsPoint(ring, INSIDE)).toBe(true);
    expect(containsPoint(ring, OUTSIDE)).toBe(false);
    expect(containsPoint(ring, { lat: 8.97, lng: 38.795 })).toBe(true);
  });
});

describe("zone effects on a trip", () => {
  const zone = (kind: CachedZone["kind"], extra: Partial<CachedZone> = {}): CachedZone => ({
    id: `${kind}-1`, cityId: "addis-ababa", name: kind, kind, ring: normalizeRing(SQUARE), feeMinor: 0, surgeMultiplier: 1, ...extra,
  });

  it("no zones: nothing changes", () => {
    expect(zoneEffect([], INSIDE, OUTSIDE)).toEqual({ refused: null, surgeMultiplier: 1, zoneFeeMinor: 0, zoneIds: [] });
  });

  it("service areas refuse pickups outside them; no-pickup zones refuse pickups inside", () => {
    expect(zoneEffect([zone("SERVICE_AREA")], OUTSIDE, INSIDE).refused?.code).toBe("outside_service_area");
    expect(zoneEffect([zone("SERVICE_AREA")], INSIDE, OUTSIDE).refused).toBeNull();
    expect(zoneEffect([zone("NO_PICKUP")], INSIDE, OUTSIDE).refused?.code).toBe("pickup_not_allowed");
    expect(zoneEffect([zone("NO_PICKUP")], OUTSIDE, INSIDE).refused).toBeNull();
  });

  it("an airport fee applies at either end, surge only at the pickup", () => {
    expect(zoneEffect([zone("AIRPORT", { feeMinor: 5000 })], OUTSIDE, INSIDE)).toMatchObject({ zoneFeeMinor: 5000, zoneIds: ["AIRPORT-1"] });
    expect(zoneEffect([zone("SURGE", { surgeMultiplier: 1.5 })], OUTSIDE, INSIDE).surgeMultiplier).toBe(1);
    expect(zoneEffect([zone("SURGE", { surgeMultiplier: 1.5 })], INSIDE, OUTSIDE).surgeMultiplier).toBe(1.5);
  });
});

describe("price with zones", () => {
  const card = { baseMinor: 5000, perKmMinor: 1500, perMinMinor: 200, minFareMinor: 8000, waitingPerMinMinor: 300 };
  it("surge multiplies the metered fare before rounding; the airport fee comes after the minimum", () => {
    // 240 birr × 1.5 = 360, + 50 fee
    expect(price(card, { distanceMeters: 10_000, durationSeconds: 1200 }, { surgeMultiplier: 1.5, zoneFeeMinor: 5000 })).toMatchObject({
      fareMinor: 41_000, breakdown: { surgeMultiplier: 1.5, zoneFeeMinor: 5000, minimumApplied: false },
    });
    // a short trip: minimum 80 birr, then the fee
    expect(price(card, { distanceMeters: 500, durationSeconds: 60 }, { zoneFeeMinor: 5000 }).fareMinor).toBe(13_000);
  });
});

describe("promo discounts", () => {
  it("percent: rounded down to whole birr and capped; amount: never more than the fare", () => {
    expect(discountFor({ type: "PERCENT_OFF", percentOff: 15, amountOffMinor: null, maxDiscountMinor: null }, 24_300)).toBe(3600);
    expect(discountFor({ type: "PERCENT_OFF", percentOff: 50, amountOffMinor: null, maxDiscountMinor: 5000 }, 24_000)).toBe(5000);
    expect(discountFor({ type: "AMOUNT_OFF", percentOff: null, amountOffMinor: 10_000, maxDiscountMinor: null }, 8000)).toBe(8000);
  });
});

describe("fare change impact", () => {
  it("prices the sample trips with both cards", () => {
    const cur = { baseMinor: 5000, perKmMinor: 1500, perMinMinor: 200, minFareMinor: 8000, waitingPerMinMinor: 300 };
    const imp = impactOf(cur, { ...cur, perKmMinor: 1600 });
    expect(imp.samples).toHaveLength(4);
    expect(imp.samples.every((s) => s.afterMinor >= s.beforeMinor)).toBe(true);
    expect(imp.averageChangePct).toBeGreaterThan(0);
  });
});
