// Promo reservations bound to one trip, booking within the budget, the approval threshold across
// promos, and anomalies (security fixes). The promo service and the quotes on a real Postgres; the
// quote store is a Map and nothing here needs Redis, so this file also runs with
// TEST_REDIS_URL pointing anywhere (`TEST_REDIS_URL=redis://127.0.0.1:1 pnpm test:integration tests/integration/promo-binding.test.ts`).

import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "@ride-app/shared-authz";
import { staticSettings } from "@ride-app/shared-settings";
import { createDb } from "../../src/db.js";
import { createPromoService, type PromoInput } from "../../src/promos/service.js";
import { createQuotes, type Quote, type QuoteStore } from "../../src/quotes.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

const uuid = () => crypto.randomUUID();
const HOUR = 3_600_000;
const BOLE = { lat: 8.9806, lng: 38.7578 };
const PIASSA = { lat: 9.0349, lng: 38.7469 };
const db = createDb(TEST_DATABASE_URL);
const clock = { now: Date.now() };
const now = () => new Date(clock.now);
const promos = createPromoService({ db, logger: pino({ level: "silent" }), now, approvalThresholdMinor: 1_000_000 });
const map = new Map<string, Quote>();
const store: QuoteStore = { put: async (q) => void map.set(q.id, q), get: async (id) => map.get(id) ?? null };
const quotes = createQuotes({
  store, settings: staticSettings({}), now, promos,
  mapping: { route: async () => ({ distanceMeters: 6000, durationSeconds: 900, approximate: false }) },
});

const staff = (roles: Principal["roles"], userId = uuid()): Principal => ({ userId, audience: "ride-admin", roles } as Principal);
const marketing = (userId = uuid()) => staff([{ role: "MARKETING", scope: "CITY", cityId: "addis-ababa" } as Principal["roles"][number]], userId);
const finance = () => staff([{ role: "FINANCE_MANAGER", scope: "GLOBAL" } as Principal["roles"][number]]);

const input = (over: Partial<PromoInput> = {}): PromoInput => ({
  code: `SEC${Math.floor(Math.random() * 1e8)}`, name: "Twenty off", type: "AMOUNT_OFF", amountOffMinor: 2000,
  cityIds: ["addis-ababa"], vehicleTypes: [], startsAt: new Date(clock.now - HOUR).toISOString(), endsAt: new Date(clock.now + 30 * 24 * HOUR).toISOString(),
  perUserLimit: 5, budgetMinor: 100_000, fundedBy: "PLATFORM", ...over,
});
async function live(over: Partial<PromoInput> = {}) {
  const mk = marketing();
  const p = await promos.create(mk, input(over));
  await promos.activate(mk, p.id);
  return p;
}
const quoteFor = async (riderId: string, code: string) => (await quotes.estimate({ requestedBy: riderId, pickup: BOLE, dropoff: PIASSA, vehicleTypes: ["economy"], promoCode: code }))[0]!;
const reservation = (quoteId: string) => db.promoReservation.findUniqueOrThrow({ where: { quoteId } });
const completed = (tripId: string, riderId: string, quoteId: string, promoDiscountMinor: number) =>
  ({ tripId, riderId, cityId: "addis-ababa", vehicleType: "economy", fareMinor: 17_400, currency: "ETB", completedAt: now().toISOString(), quoteId, promoDiscountMinor });

beforeAll(async () => {
  await db.$queryRaw`SELECT 1`;
});
afterAll(async () => {
  await db.$disconnect();
});

describe("a reservation belongs to one trip", () => {
  it("rebooking a quote after its trip was cancelled gets no discount; a discount the books can't explain is an anomaly", async () => {
    const p = await live();
    const rider = uuid();
    const q = await quoteFor(rider, p.code);
    expect(q.discountMinor).toBe(2000);

    // trip A books it, is cancelled: the reservation is released for good
    const tripA = uuid();
    expect((await quotes.forBooking(q.id, { tripId: tripA, userId: rider }))?.discountMinor).toBe(2000);
    expect(await promos.release({ tripId: tripA, riderId: rider, cityId: "addis-ababa", quoteId: q.id })).toBe(true);
    expect((await reservation(q.id)).status).toBe("RELEASED");

    // trip B with the same quote: served without the discount
    const tripB = uuid();
    const served = await quotes.forBooking(q.id, { tripId: tripB, userId: rider });
    expect(served).toMatchObject({ discountMinor: 0, payableMinor: q.fareMinor });
    expect(served?.promo).toBeUndefined();

    // trip B cancelled: trip A's reservation isn't touched again; trip B completing with a discount
    // anyway (a forged or stale event) is recorded, never redeemed silently
    expect(await promos.release({ tripId: tripB, riderId: rider, cityId: "addis-ababa", quoteId: q.id })).toBe(false);
    expect(await promos.redeem(completed(tripB, rider, q.id, 2000))).toBeNull();
    expect(await promos.redeem(completed(tripB, rider, q.id, 2000))).toBeNull(); // replay: one anomaly
    const anomalies = await db.promoAnomaly.findMany({ where: { tripId: tripB } });
    expect(anomalies).toEqual([expect.objectContaining({ kind: "DISCOUNT_WITHOUT_RESERVATION", discountMinor: 2000, quoteId: q.id })]);
    expect((await promos.anomalies(finance(), { limit: 10 })).anomalies.some((a) => a.tripId === tripB)).toBe(true);
    await expect(promos.anomalies(marketing(), { limit: 10 })).rejects.toMatchObject({ statusCode: 403 });
    expect((await db.promo.findUniqueOrThrow({ where: { id: p.id } })).spentMinor).toBe(0);
  });

  it("only the trip it was booked for redeems it; the redeemed discount is never above the reservation without an anomaly", async () => {
    const p = await live();
    const rider = uuid();
    const q = await quoteFor(rider, p.code);
    const trip = uuid();
    await quotes.forBooking(q.id, { tripId: trip, userId: rider });
    // another trip of the same rider naming the quote doesn't redeem it
    expect(await promos.redeem(completed(uuid(), rider, q.id, 2000))).toBeNull();
    expect((await reservation(q.id)).status).toBe("BOOKED");
    // its own trip does; a discount above the reservation is counted and flagged
    expect(await promos.redeem(completed(trip, rider, q.id, 2500))).toMatchObject({ discountMinor: 2500 });
    expect((await db.promoAnomaly.findMany({ where: { tripId: trip } })).map((a) => a.kind)).toEqual(["DISCOUNT_ABOVE_RESERVATION"]);
    expect(await db.promo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ spentMinor: 2500, redemptionCount: 1 });
  });

  it("someone else's quote, a read without a trip, and an unbooked trip", async () => {
    const p = await live();
    const rider = uuid();
    const q = await quoteFor(rider, p.code);
    expect((await quotes.forBooking(q.id))?.discountMinor).toBe(0);
    expect((await quotes.forBooking(q.id, { tripId: uuid(), userId: uuid() }))?.discountMinor).toBe(0);
    expect((await reservation(q.id)).status).toBe("HELD");

    // the trip couldn't be created: unbooked, the retry (a new trip id) books it
    const t1 = uuid();
    await quotes.forBooking(q.id, { tripId: t1, userId: rider });
    expect(await quotes.unbook(q.id, uuid())).toBe(false);
    expect(await quotes.unbook(q.id, t1)).toBe(true);
    expect(await reservation(q.id)).toMatchObject({ status: "HELD", tripId: null });
    const t2 = uuid();
    expect((await quotes.forBooking(q.id, { tripId: t2, userId: rider }))?.discountMinor).toBe(2000);
    expect((await reservation(q.id)).tripId).toBe(t2);
  });
});

describe("booking stays within the promo's limits", () => {
  it("the budget counts what is already booked: a second booking that would pass it is served without the discount", async () => {
    const p = await live({ budgetMinor: 3000 });
    const [r1, r2] = [uuid(), uuid()];
    // both quotes were offered while nothing was booked
    const q1 = await quoteFor(r1, p.code);
    const q2 = await quoteFor(r2, p.code);
    expect([q1.discountMinor, q2.discountMinor]).toEqual([2000, 2000]);
    expect((await quotes.forBooking(q1.id, { tripId: uuid(), userId: r1 }))?.discountMinor).toBe(2000);
    expect((await quotes.forBooking(q2.id, { tripId: uuid(), userId: r2 }))?.discountMinor).toBe(0);
    expect((await reservation(q2.id)).status).toBe("RELEASED");
  });

  it("parallel bookings never book past the budget", async () => {
    const p = await live({ budgetMinor: 5000 });
    const riders = Array.from({ length: 6 }, uuid);
    const qs = await Promise.all(riders.map((r) => quoteFor(r, p.code)));
    const served = await Promise.all(qs.map((q, i) => quotes.forBooking(q.id, { tripId: uuid(), userId: riders[i]! })));
    expect(served.filter((q) => q!.discountMinor > 0)).toHaveLength(2);
  });

  it("maxRedemptions counts bookings", async () => {
    const p = await live({ maxRedemptions: 1 });
    const [r1, r2] = [uuid(), uuid()];
    const q1 = await quoteFor(r1, p.code);
    const q2 = await quoteFor(r2, p.code);
    expect((await quotes.forBooking(q1.id, { tripId: uuid(), userId: r1 }))?.discountMinor).toBe(2000);
    expect((await quotes.forBooking(q2.id, { tripId: uuid(), userId: r2 }))?.discountMinor).toBe(0);
  });

  it("spending is capped at the budget (an anomaly records the difference)", async () => {
    const p = await live({ budgetMinor: 2000 });
    const rider = uuid();
    const q = await quoteFor(rider, p.code);
    const trip = uuid();
    await quotes.forBooking(q.id, { tripId: trip, userId: rider });
    await promos.redeem(completed(trip, rider, q.id, 2600));
    expect(await db.promo.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ spentMinor: 2000, status: "EXHAUSTED" });
    expect((await db.promoAnomaly.findMany({ where: { tripId: trip } })).map((a) => a.kind).sort()).toEqual(["DISCOUNT_ABOVE_RESERVATION", "OVER_BUDGET"]);
  });
});

describe("the approval threshold covers everything live", () => {
  it("splitting a large budget into small promos still needs finance", async () => {
    // start from nothing live in the city (the tests above left small promos running)
    await db.promo.updateMany({ where: { status: { in: ["ACTIVE", "PAUSED"] } }, data: { status: "ARCHIVED" } });
    const creator = uuid();
    const mk = marketing(creator);
    const first = await promos.create(mk, input({ budgetMinor: 600_000, cityIds: ["addis-ababa"] }));
    await promos.activate(mk, first.id);
    const second = await promos.create(mk, input({ budgetMinor: 600_000 }));
    await expect(promos.activate(mk, second.id)).rejects.toMatchObject({ code: "approval_required" });
    // another marketer in the same city is judged on the city's total too
    const other = marketing();
    const third = await promos.create(other, input({ budgetMinor: 600_000 }));
    await expect(promos.activate(other, third.id)).rejects.toMatchObject({ code: "approval_required" });
    // finance approves it
    expect((await promos.activate(finance(), second.id)).status).toBe("ACTIVE");
    // once the live ones end, small promos activate on their own again
    for (const id of [first.id, second.id]) {
      await promos.pause(mk, id);
      await promos.archive(mk, id);
    }
    expect((await promos.activate(other, third.id)).status).toBe("ACTIVE");
  });
});
