// Booking with a quote (security fix): the trip id is chosen before the quote is read so pricing
// books the promo discount for exactly that trip; a trip that isn't created gives it back; a quote
// with a live trip is refused, also when the database's unique index catches a race.

import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { parseRoleClaims, type Principal } from "@ride-app/shared-authz";
import { staticSettings } from "@ride-app/shared-settings";
import { Prisma } from "../../src/generated/prisma/client.js";
import { pricingQuotes, type Quote, type QuoteBooking, type QuoteProvider } from "../../src/quotes.js";
import { createTripService, uniqueViolation } from "../../src/trips/service.js";

const RIDER = "00000000-0000-4000-8000-00000000000a";
const rider = { userId: RIDER, audience: "ride-app", roles: parseRoleClaims([{ r: "RIDER" }], "ride-app"), permissionVersion: 0, amr: ["otp"] } as unknown as Principal;
const T0 = Date.parse("2026-10-29T08:00:00Z");

const quote = (over: Partial<Quote> = {}): Quote => ({
  id: "q_1", requestedBy: RIDER, cityId: "addis-ababa", vehicleType: "economy", pickup: { lat: 8.98, lng: 38.75 }, dropoff: { lat: 9.03, lng: 38.75 },
  fareMinor: 17_400, waitingPerMinMinor: 300, currency: "ETB", distanceMeters: 6000, durationSeconds: 900, approximate: false,
  discountMinor: 2000, payableMinor: 15_400, promo: { promoId: "p", code: "RIDE20", discountMinor: 2000, fundedBy: "PLATFORM" },
  expiresAt: new Date(T0 + 300_000).toISOString(), ...over,
});

const p2002 = (target: string) => new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on the ${target}`, { code: "P2002", clientVersion: "7", meta: { target } });

function setup(opts: { quote?: Quote; used?: boolean; scheduled?: boolean; createError?: unknown } = {}) {
  const reads: { quoteId: string; booking?: QuoteBooking }[] = [];
  const unbooked: [string, string][] = [];
  const created: Record<string, unknown>[] = [];
  const quotes: QuoteProvider = {
    get: async (quoteId, booking) => (reads.push({ quoteId, ...(booking ? { booking } : {}) }), opts.quote ?? quote()),
    unbook: async (quoteId, tripId) => void unbooked.push([quoteId, tripId]),
  };
  const tx = {
    trip: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.createError) throw opts.createError;
        const t = { status: "requested", flags: [], version: 0, fareFinalMinor: null, waitingFeeMinor: null, driverUserId: null, ...data };
        created.push(t);
        return t;
      },
    },
    tripEvent: { create: async () => ({}) },
    outbox: { create: async () => ({}) },
  };
  const db = {
    trip: { findFirst: async () => (opts.used ? { id: "other" } : null) },
    scheduledTrip: { findFirst: async () => (opts.scheduled ? { id: "s" } : null) },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  };
  const trips = createTripService({
    db: db as never, redis: {} as never, location: {} as never, logger: pino({ level: "silent" }), quotes, policies: {} as never,
    realtime: { toUser: () => undefined, leaveTrip: () => undefined } as never,
    matching: { start: async () => undefined, stop: async () => undefined, poke: async () => undefined },
    settings: staticSettings({}), orgs: { isMember: async () => false }, now: () => new Date(T0),
  } as never);
  return { trips, reads, unbooked, created };
}

describe("booking with a quote", () => {
  it("names the trip id (and the booker) when reading the quote, and the trip gets that id", async () => {
    const s = setup();
    const t = await s.trips.request(rider, { quoteId: "q_1", paymentMethod: "CASH" });
    expect(s.reads).toHaveLength(1);
    const booking = s.reads[0]!.booking!;
    expect(booking.userId).toBe(RIDER);
    expect(booking.tripId).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.id).toBe(booking.tripId);
    expect(s.created[0]).toMatchObject({ id: booking.tripId, quoteId: "q_1", promoDiscountMinor: 2000n, promoCode: "RIDE20" });
    expect(s.unbooked).toEqual([]);
  });

  it("a quote with a live trip or an upcoming scheduled ride is refused before it is read", async () => {
    for (const o of [{ used: true }, { scheduled: true }]) {
      const s = setup(o);
      await expect(s.trips.request(rider, { quoteId: "q_1", paymentMethod: "CASH" })).rejects.toMatchObject({ statusCode: 400, code: "quote_used" });
      expect(s.reads).toEqual([]);
    }
  });

  it("a race caught by the unique index is quote_used, and the discount booked for the lost trip is given back", async () => {
    const s = setup({ createError: p2002("ux_trip_quote_live") });
    await expect(s.trips.request(rider, { quoteId: "q_1", paymentMethod: "CASH" })).rejects.toMatchObject({ statusCode: 400, code: "quote_used" });
    expect(s.unbooked).toEqual([["q_1", s.reads[0]!.booking!.tripId]]);
  });

  it("another active trip of the rider is still active_trip_exists; the discount is given back", async () => {
    const s = setup({ createError: p2002("ux_trip_rider_active") });
    await expect(s.trips.request(rider, { quoteId: "q_1", paymentMethod: "CASH" })).rejects.toMatchObject({ statusCode: 409, code: "active_trip_exists" });
    expect(s.unbooked).toHaveLength(1);
  });

  it("an expired quote or a refused booking gives the discount back; no discount, nothing to give back", async () => {
    const expired = setup({ quote: quote({ expiresAt: new Date(T0 - 1).toISOString() }) });
    await expect(expired.trips.request(rider, { quoteId: "q_1", paymentMethod: "CASH" })).rejects.toMatchObject({ code: "quote_expired" });
    expect(expired.unbooked).toHaveLength(1);
    const refused = setup({ quote: quote({ discountMinor: 0, promo: undefined }) });
    await expect(refused.trips.request(rider, { quoteId: "q_1", paymentMethod: "CORPORATE" })).rejects.toMatchObject({ statusCode: 400 });
    expect(refused.unbooked).toEqual([]);
  });

  it("someone else's quote is unknown", async () => {
    const s = setup({ quote: quote({ requestedBy: "00000000-0000-4000-8000-0000000000bb" }) });
    await expect(s.trips.request(rider, { quoteId: "q_1", paymentMethod: "CASH" })).rejects.toMatchObject({ code: "invalid_quote" });
  });
});

describe("unique violations on booking", () => {
  it("tell the quote index from the one-active-trip index", () => {
    expect(uniqueViolation(p2002("ux_trip_quote_live")).code).toBe("quote_used");
    expect(uniqueViolation(p2002("(quote_id)")).code).toBe("quote_used");
    expect(uniqueViolation(p2002("(rider_user_id)")).code).toBe("active_trip_exists");
  });
});

describe("pricing quote client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes the trip and the booker on the read, and unbooks by trip", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: URL, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(JSON.stringify(quote()), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = pricingQuotes("http://pricing.test", "t".repeat(64));
    await client.get("q_1", { tripId: "trip-1", userId: RIDER });
    await client.get("q_1");
    await client.unbook!("q_1", "trip-1");
    expect(calls[0]!.url).toBe(`http://pricing.test/internal/quotes/q_1?tripId=trip-1&userId=${RIDER}`);
    expect(calls[1]!.url).toBe("http://pricing.test/internal/quotes/q_1");
    expect(calls[2]).toMatchObject({ url: "http://pricing.test/internal/quotes/q_1/unbook", init: { method: "POST", body: JSON.stringify({ tripId: "trip-1" }) } });
  });
});
