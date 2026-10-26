// Quotes (workflow 05 part B). A quote fixes the fare a rider is shown: trip-service reads it by
// id when the trip is requested (GET /internal/quotes/:id) and snapshots it, so the rider pays the
// quoted price even if fares change in between. Quotes expire after `quote.ttlSeconds`.

import { randomUUID } from "node:crypto";
import { cityAt, type LatLng } from "@ride-app/shared-location";
import type { SettingsReader } from "@ride-app/shared-settings";
import { AppError, badRequest } from "./lib/errors.js";
import type { MappingClient } from "./lib/mapping.js";
import { fareCard, price, type FareBreakdown } from "./fares.js";

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
  breakdown: FareBreakdown;
  /** ISO 8601 */
  expiresAt: string;
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
}

export function createQuotes(deps: { store: QuoteStore; mapping: MappingClient; settings: SettingsReader; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());

  return {
    /** One quote per vehicle type for the same route. */
    async estimate(input: EstimateInput): Promise<Quote[]> {
      const cityId = cityAt(input.pickup);
      if (!cityId) throw badRequest("pickup is outside the served cities", "outside_service_area");
      const cards = input.vehicleTypes.map((vehicleType) => {
        const card = fareCard(deps.settings, vehicleType, cityId);
        if (!card) throw badRequest(`no fares for vehicle type ${vehicleType}`, "unknown_vehicle_type");
        return { vehicleType, card };
      });

      let route;
      try {
        route = await deps.mapping.route([input.pickup, input.dropoff]);
      } catch {
        throw new AppError(503, "routing is temporarily unavailable", "dependency_unavailable");
      }

      const ttl = deps.settings.get<number>("quote.ttlSeconds");
      const expiresAt = new Date(now().getTime() + ttl * 1000).toISOString();
      const quotes: Quote[] = [];
      for (const { vehicleType, card } of cards) {
        const { fareMinor, breakdown } = price(card, route);
        const q: Quote = {
          id: `q_${randomUUID()}`, requestedBy: input.requestedBy, cityId, vehicleType,
          pickup: input.pickup, dropoff: input.dropoff, pickupAddress: input.pickupAddress, dropoffAddress: input.dropoffAddress,
          fareMinor, waitingPerMinMinor: card.waitingPerMinMinor, currency: "ETB",
          distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds, approximate: route.approximate,
          breakdown, expiresAt,
        };
        await deps.store.put(q, ttl);
        quotes.push(q);
      }
      return quotes;
    },

    get: (id: string) => deps.store.get(id),

    /** The fare card of every vehicle type offered in a city (for the apps' fare info screen). */
    fareCards(cityId: string, vehicleTypes: string[]) {
      return vehicleTypes.flatMap((vehicleType) => {
        const card = fareCard(deps.settings, vehicleType, cityId);
        return card ? [{ vehicleType, ...card, currency: "ETB" }] : [];
      });
    },
  };
}

export type Quotes = ReturnType<typeof createQuotes>;
