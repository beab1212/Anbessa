// Fare quotes (workflow 05, part B). pricing-service owns them; trip-service only reads a quote
// when the rider requests the trip and snapshots it, so the rider pays the quoted price.
//
//   "service"  GET {PRICING_INTERNAL_URL}/internal/quotes/:id   (the contract pricing-service implements)
//   "builtin"  development stand-in until pricing-service exists: mapping-service route × a fare
//              table below, quotes kept in Redis for 10 minutes. Refused in production by config.

import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { settingDef, type SettingsReader } from "@ride-app/shared-settings";
import { cityAt, type LatLng } from "@ride-app/shared-location";
import { badRequest } from "./lib/errors.js";
import { NotFoundUpstream, type MappingClient } from "./lib/clients.js";

export interface Quote {
  id: string;
  /** the user the quote was made for: only they may book with it */
  requestedBy: string;
  cityId: string;
  vehicleType: string;
  pickup: LatLng;
  dropoff: LatLng;
  pickupAddress?: string;
  dropoffAddress?: string;
  fareMinor: number;
  waitingPerMinMinor: number;
  currency: string;
  distanceMeters: number;
  durationSeconds: number;
  /** distances came from a straight-line estimate (OSRM was down) */
  approximate: boolean;
  /** the road line pickup → drop-off (encoded polyline, precision 6), kept on the trip for the apps' maps */
  routePolyline6?: string;
  /**
   * Promo discount on this quote (pricing-service, workflow 15); absent or 0 = none. Booked by
   * pricing-service for the trip id trip-service names when it reads the quote, so a discount
   * present here belongs to that one trip. Read without a trip id, a quote never carries one.
   */
  discountMinor?: number;
  /** what the rider pays: fareMinor − discountMinor */
  payableMinor?: number;
  promo?: { promoId: string; code: string; discountMinor: number; fundedBy: string };
  /** ISO 8601 */
  expiresAt: string;
}

/** The quote's promo discount, kept within 0 … fareMinor. */
export function quoteDiscount(q: Pick<Quote, "fareMinor" | "discountMinor">): number {
  const d = Math.trunc(q.discountMinor ?? 0);
  return Math.min(Math.max(d, 0), Math.max(q.fareMinor, 0));
}

export interface RepriceInput {
  requestedBy: string;
  cityId: string;
  vehicleType: string;
  pickup: LatLng;
  dropoff: LatLng;
  pickupAddress?: string;
  dropoffAddress?: string;
}

/** Reading a quote to book a trip: the trip id it will get and who books it. */
export interface QuoteBooking {
  tripId: string;
  userId: string;
}

export interface QuoteProvider {
  /**
   * The quote. With `booking`, its promo discount is booked for that trip (or dropped when it
   * can't be given); without, it comes without a discount (scheduled bookings, checks).
   */
  get(quoteId: string, booking?: QuoteBooking): Promise<Quote | null>;
  /** The trip couldn't be created after all: give the discount booked for it back (best effort). */
  unbook?(quoteId: string, tripId: string): Promise<void>;
  /**
   * A fresh quote for a scheduled ride shortly before dispatch (workflow 12). null when the
   * provider can't make one; the scheduler then keeps the booked quote.
   */
  reprice?(input: RepriceInput): Promise<Quote | null>;
}

export function pricingQuotes(base: string, token: string): QuoteProvider {
  return {
    async get(quoteId, booking) {
      try {
        const url = new URL(`/internal/quotes/${encodeURIComponent(quoteId)}`, base);
        if (booking) {
          url.searchParams.set("tripId", booking.tripId);
          url.searchParams.set("userId", booking.userId);
        }
        const res = await fetch(url, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(2500),
        });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`pricing-service http ${res.status}`);
        return (await res.json()) as Quote;
      } catch (err) {
        if (err instanceof NotFoundUpstream) return null;
        throw err;
      }
    },
    // POST /internal/quotes/:id/unbook (pricing-service): the booked discount is held again for the
    // rider's retry. A failure leaves it booked until it expires (24 h); the caller only logs it.
    async unbook(quoteId, tripId) {
      const res = await fetch(new URL(`/internal/quotes/${encodeURIComponent(quoteId)}/unbook`, base), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ tripId }),
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok && res.status !== 404) throw new Error(`pricing-service http ${res.status}`);
    },
    // POST /internal/quotes (pricing-service): a quote made for a user by a service, same pricing
    // as an estimate (rule in force, zones) but never a promo. 404/405 = an older pricing-service
    // without the route; a 400 (vehicle type withdrawn, pickup now in a no-pickup zone …) throws,
    // and either way the scheduler keeps the booked quote.
    async reprice(input) {
      const res = await fetch(new URL("/internal/quotes", base), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...input, vehicleTypes: [input.vehicleType] }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 404 || res.status === 405) return null;
      if (!res.ok) throw new Error(`pricing-service http ${res.status}`);
      const body = (await res.json()) as { quotes?: Quote[] } | Quote;
      return ("quotes" in body ? body.quotes?.[0] : (body as Quote)) ?? null;
    },
  };
}

// ── development stand-in ──────────────────────────────────────────────────────

/** The stand-in's fare for a vehicle type in a city (santim), from the live `fares.*` settings. pricing-service replaces it. */
export function devFare(settings: SettingsReader, vehicleType: string, cityId: string) {
  const key = (part: string) => `fares.${vehicleType}.${part}`;
  if (!settingDef(key("baseMinor"))) return null;
  return {
    baseMinor: settings.get<number>(key("baseMinor"), cityId),
    perKmMinor: settings.get<number>(key("perKmMinor"), cityId),
    perMinMinor: settings.get<number>(key("perMinMinor"), cityId),
    minFareMinor: settings.get<number>(key("minFareMinor"), cityId),
    waitingPerMinMinor: settings.get<number>(key("waitingPerMinMinor"), cityId),
  };
}

export function builtinQuotes(redis: Redis, mapping: MappingClient, settings: SettingsReader, now: () => Date = () => new Date()) {
  const key = (id: string) => `devquote:${id}`;
  async function create(input: { requestedBy: string; pickup: LatLng; dropoff: LatLng; vehicleTypes: string[]; pickupAddress?: string; dropoffAddress?: string }): Promise<Quote[]> {
    const cityId = cityAt(input.pickup);
    if (!cityId) throw badRequest("pickup is outside the served cities", "outside_service_area");
    const route = await mapping.route([input.pickup, input.dropoff], true);
    const km = route.distanceMeters / 1000;
    const min = route.durationSeconds / 60;
    const ttl = settings.get<number>("quote.ttlSeconds");
    const expiresAt = new Date(now().getTime() + ttl * 1000).toISOString();
    const quotes: Quote[] = [];
    for (const vehicleType of input.vehicleTypes) {
      const f = devFare(settings, vehicleType, cityId);
      if (!f) throw badRequest(`no fare for vehicle type ${vehicleType}`);
      // rounded to whole birr, like a meter would show
      const raw = f.baseMinor + km * f.perKmMinor + min * f.perMinMinor;
      const fareMinor = Math.max(f.minFareMinor, Math.round(raw / 100) * 100);
      const q: Quote = {
        id: `q_${randomUUID()}`, requestedBy: input.requestedBy, cityId, vehicleType,
        pickup: input.pickup, dropoff: input.dropoff, pickupAddress: input.pickupAddress, dropoffAddress: input.dropoffAddress,
        fareMinor, waitingPerMinMinor: f.waitingPerMinMinor, currency: "ETB",
        distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds, approximate: route.approximate,
        ...(route.geometry ? { routePolyline6: route.geometry } : {}), expiresAt,
      };
      await redis.set(key(q.id), JSON.stringify(q), "EX", ttl);
      quotes.push(q);
    }
    return quotes;
  }
  return {
    create,
    provider: {
      async get(quoteId: string) {
        const raw = await redis.get(key(quoteId));
        return raw ? (JSON.parse(raw) as Quote) : null;
      },
      async reprice(input: RepriceInput) {
        const [q] = await create({ ...input, vehicleTypes: [input.vehicleType] });
        return q ?? null;
      },
    } satisfies QuoteProvider,
  };
}
