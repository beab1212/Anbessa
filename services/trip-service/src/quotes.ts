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
  /** ISO 8601 */
  expiresAt: string;
}

export interface QuoteProvider {
  get(quoteId: string): Promise<Quote | null>;
}

export function pricingQuotes(base: string, token: string): QuoteProvider {
  return {
    async get(quoteId) {
      try {
        const res = await fetch(new URL(`/internal/quotes/${encodeURIComponent(quoteId)}`, base), {
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
  return {
    async create(input: { requestedBy: string; pickup: LatLng; dropoff: LatLng; vehicleTypes: string[]; pickupAddress?: string; dropoffAddress?: string }): Promise<Quote[]> {
      const cityId = cityAt(input.pickup);
      if (!cityId) throw badRequest("pickup is outside the served cities", "outside_service_area");
      const route = await mapping.route([input.pickup, input.dropoff]);
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
          distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds, approximate: route.approximate, expiresAt,
        };
        await redis.set(key(q.id), JSON.stringify(q), "EX", ttl);
        quotes.push(q);
      }
      return quotes;
    },
    provider: {
      async get(quoteId: string) {
        const raw = await redis.get(key(quoteId));
        return raw ? (JSON.parse(raw) as Quote) : null;
      },
    } satisfies QuoteProvider,
  };
}
