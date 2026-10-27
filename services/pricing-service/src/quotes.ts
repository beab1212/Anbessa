// Quotes (workflow 05 part B). A quote fixes the fare a rider is shown: trip-service reads it by
// id when the trip is requested (GET /internal/quotes/:id) and snapshots it, so the rider pays the
// quoted price even if fares change in between. Quotes expire after `quote.ttlSeconds`.
// Workflow 15: the card is the approved fare rule in force (else the live settings), zones refuse
// or adjust the price, and a promo code discounts it (the quote records rule, zones and promo).

import { randomUUID } from "node:crypto";
import { cityAt, type LatLng } from "@ride-app/shared-location";
import type { SettingsReader } from "@ride-app/shared-settings";
import { AppError, badRequest } from "./lib/errors.js";
import type { LocationClient } from "./lib/location.js";
import type { MappingClient } from "./lib/mapping.js";
import { emptyCatalog, zoneEffect, type PricingCatalog } from "./catalog.js";
import { fareCard, price, type FareBreakdown, type FareCard } from "./fares.js";
import { REJECTION_MESSAGES, type PromoRejection } from "./promos/discount.js";
import type { PromoService } from "./promos/service.js";

/** The contract trip-service reads (services/trip-service/src/quotes.ts `Quote`). */
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
  /** distances came from a straight-line estimate (routing was down) */
  approximate: boolean;
  /** the road line pickup → drop-off (encoded polyline, precision 6); trip-service keeps it on the trip */
  routePolyline6?: string;
  /** how soon the nearest car of this type could reach the pickup; null when unknown or none nearby */
  etaToPickupSeconds: number | null;
  driversNearby: number;
  breakdown: FareBreakdown;
  /** the approved fare rule used; null = the live `fares.*` settings */
  fareRuleId: string | null;
  /** zones that changed this fare (airport fee, surge) */
  zoneIds: string[];
  /** promo discount on this quote (0 = none); the driver's earning is computed on fareMinor */
  discountMinor: number;
  /** what the rider pays: fareMinor − discountMinor (waiting time comes on top) */
  payableMinor: number;
  promo?: { promoId: string; code: string; discountMinor: number; fundedBy: string };
  /** ISO 8601 */
  expiresAt: string;
}

/** The outcome of a promo code on an estimate (the estimate never fails because of a code). */
export type PromoOutcome =
  | { code: string; applied: true; discountedQuotes: number }
  | { code: string; applied: false; reason: PromoRejection; message: string };

/** The route shared by every quote of one estimate, returned once. */
export interface QuoteRoute {
  polyline6: string;
  distanceMeters: number;
  durationSeconds: number;
  approximate: boolean;
}

/** Where quotes are kept until they expire (Redis in the service, a Map in tests). */
export interface QuoteStore {
  put(quote: Quote, ttlSeconds: number): Promise<void>;
  get(id: string): Promise<Quote | null>;
}

export function redisQuoteStore(redis: { set(k: string, v: string, mode: "EX", s: number): Promise<unknown>; get(k: string): Promise<string | null> }): QuoteStore {
  const key = (id: string) => `quote:${id}`;
  return {
    async put(q, ttl) {
      await redis.set(key(q.id), JSON.stringify(q), "EX", ttl);
    },
    async get(id) {
      const raw = await redis.get(key(id));
      return raw ? (JSON.parse(raw) as Quote) : null;
    },
  };
}

export interface EstimateInput {
  requestedBy: string;
  pickup: LatLng;
  dropoff: LatLng;
  vehicleTypes: string[];
  pickupAddress?: string;
  dropoffAddress?: string;
  promoCode?: string;
}

export function createQuotes(deps: {
  store: QuoteStore; mapping: MappingClient; location?: LocationClient; settings: SettingsReader;
  logger?: { warn(o: object, msg: string): void }; now?: () => Date;
  catalog?: PricingCatalog; promos?: PromoService;
}) {
  const now = deps.now ?? (() => new Date());
  const catalog = deps.catalog ?? emptyCatalog;

  /** The approved rule in force, else the live settings; null = no fares for this type. */
  function cardAt(vehicleType: string, cityId: string, at: Date): { card: FareCard; ruleId: string | null } | null {
    const rule = catalog.ruleAt(cityId, vehicleType, at);
    if (rule) return { card: rule, ruleId: rule.id };
    const card = fareCard(deps.settings, vehicleType, cityId);
    return card ? { card, ruleId: null } : null;
  }

  /** ETA per vehicle type, asked in parallel; a failure makes the ETA unknown, never the quote. */
  async function etas(pickup: LatLng, cityId: string, types: string[]) {
    const out = new Map<string, { etaSeconds: number | null; driversNearby: number }>();
    if (!deps.location) return out;
    await Promise.all(types.map(async (vehicleType) => {
      try {
        const a = await deps.location!.etaToPickup({ ...pickup, cityId, vehicleType });
        out.set(vehicleType, { etaSeconds: a.etaSeconds, driversNearby: a.driversNearby });
      } catch (err) {
        deps.logger?.warn({ err: (err as Error).message, vehicleType }, "location-service unavailable, no ETA on the quote");
      }
    }));
    return out;
  }

  return {
    /** One quote per vehicle type for the same route. */
    async estimate(input: EstimateInput): Promise<Quote[]> {
      return (await this.estimateWithRoute(input)).quotes;
    },

    /** The quotes plus the road line they share (drawn on the map). */
    async estimateWithRoute(input: EstimateInput): Promise<{ quotes: Quote[]; route: QuoteRoute; promo?: PromoOutcome }> {
      const cityId = cityAt(input.pickup);
      if (!cityId) throw badRequest("pickup is outside the served cities", "outside_service_area");
      await catalog.refresh();
      const at = now();
      const cards = input.vehicleTypes.map((vehicleType) => {
        const c = cardAt(vehicleType, cityId, at);
        if (!c) throw badRequest(`no fares for vehicle type ${vehicleType}`, "unknown_vehicle_type");
        return { vehicleType, ...c };
      });
      const zones = zoneEffect(catalog.zones(cityId), input.pickup, input.dropoff);
      if (zones.refused) throw badRequest(zones.refused.message, zones.refused.code);

      // a code that can't be used is reported, never fatal
      let promo: PromoOutcome | undefined;
      const offer = input.promoCode && deps.promos ? await deps.promos.offer(input.promoCode, input.requestedBy, cityId) : undefined;
      if (input.promoCode && !deps.promos) promo = { code: input.promoCode, applied: false, reason: "unknown_code", message: REJECTION_MESSAGES.unknown_code };
      if (offer && "rejected" in offer) promo = { code: offer.promo?.code ?? input.promoCode!.toUpperCase(), applied: false, reason: offer.rejected, message: REJECTION_MESSAGES[offer.rejected] };

      const [route, eta] = await Promise.all([
        deps.mapping.route([input.pickup, input.dropoff], true).catch(() => {
          throw new AppError(503, "routing is temporarily unavailable", "dependency_unavailable");
        }),
        etas(input.pickup, cityId, cards.map((c) => c.vehicleType)),
      ]);
      const polyline6 = route.geometry ?? "";

      const ttl = deps.settings.get<number>("quote.ttlSeconds");
      const expiry = new Date(now().getTime() + ttl * 1000);
      const expiresAt = expiry.toISOString();
      const quotes: Quote[] = [];
      for (const { vehicleType, card, ruleId } of cards) {
        const { fareMinor, breakdown } = price(card, route, zones);
        quotes.push({
          id: `q_${randomUUID()}`, requestedBy: input.requestedBy, cityId, vehicleType,
          pickup: input.pickup, dropoff: input.dropoff, pickupAddress: input.pickupAddress, dropoffAddress: input.dropoffAddress,
          fareMinor, waitingPerMinMinor: card.waitingPerMinMinor, currency: "ETB",
          distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds, approximate: route.approximate,
          ...(polyline6 ? { routePolyline6: polyline6 } : {}),
          etaToPickupSeconds: eta.get(vehicleType)?.etaSeconds ?? null, driversNearby: eta.get(vehicleType)?.driversNearby ?? 0,
          breakdown, fareRuleId: ruleId, zoneIds: zones.zoneIds, discountMinor: 0, payableMinor: fareMinor, expiresAt,
        });
      }

      if (offer && !("rejected" in offer) && deps.promos) {
        const x = offer.promo;
        const held: Parameters<PromoService["hold"]>[0] = [];
        for (const q of quotes) {
          const d = deps.promos.discount(x, offer.availableMinor, q.vehicleType, q.fareMinor);
          if (d <= 0) continue;
          q.discountMinor = d;
          q.payableMinor = q.fareMinor - d;
          q.promo = { promoId: x.id, code: x.code, discountMinor: d, fundedBy: x.fundedBy };
          held.push({ promoId: x.id, quoteId: q.id, userId: input.requestedBy, cityId, vehicleType: q.vehicleType, fareMinor: q.fareMinor, discountMinor: d, expiresAt: expiry });
        }
        await deps.promos.hold(held);
        promo = held.length
          ? { code: x.code, applied: true, discountedQuotes: held.length }
          : { code: x.code, applied: false, reason: "vehicle_type_not_eligible", message: REJECTION_MESSAGES.vehicle_type_not_eligible };
      }

      for (const q of quotes) await deps.store.put(q, ttl);
      return { quotes, route: { polyline6, distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds, approximate: route.approximate }, ...(promo ? { promo } : {}) };
    },

    get: (id: string) => deps.store.get(id),

    /**
     * trip-service reads the quote to book a trip: its promo discount becomes BOOKED. When the
     * discount can't be given any more, the quote is served without it (the rider pays fareMinor).
     */
    async forBooking(id: string): Promise<Quote | null> {
      const q = await deps.store.get(id);
      if (!q || !q.promo || !deps.promos) return q;
      if (await deps.promos.book(q.id)) return q;
      const { promo: _dropped, ...rest } = q;
      return { ...rest, discountMinor: 0, payableMinor: q.fareMinor };
    },

    /** The fare card of every vehicle type offered in a city (for the apps' fare info screen). */
    async fareCards(cityId: string, vehicleTypes: string[]) {
      await catalog.refresh();
      const at = now();
      return vehicleTypes.flatMap((vehicleType) => {
        const c = cardAt(vehicleType, cityId, at);
        return c ? [{ vehicleType, ...pick(c.card), currency: "ETB" }] : [];
      });
    },
  };
}

export type Quotes = ReturnType<typeof createQuotes>;

const pick = (c: FareCard): FareCard => ({ baseMinor: c.baseMinor, perKmMinor: c.perKmMinor, perMinMinor: c.perMinMinor, minFareMinor: c.minFareMinor, waitingPerMinMinor: c.waitingPerMinMinor });
