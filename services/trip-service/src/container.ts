// Composition root: builds every dependency from config. Used by the server and the tests.

import { Redis } from "ioredis";
import { createTokenVerifier, type VerifyAccessToken } from "@ride-app/shared-authz";
import type { Logger } from "@ride-app/shared-utils";
import type { Config } from "./config/index.js";
import { createDb, type Db } from "./db.js";
import { locationClient, mappingClient, type LocationClient, type MappingClient } from "./lib/clients.js";
import { socketEmitter, type Realtime } from "./lib/realtime.js";
import { createMatcher } from "./matching/matcher.js";
import { builtinQuotes, pricingQuotes, type QuoteProvider } from "./quotes.js";
import { createTripService } from "./trips/service.js";
import { createSettingsClient, fetchSettingsSnapshotFrom, type SettingsReader } from "@ride-app/shared-settings";

export interface ContainerOptions {
  db?: Db;
  redis?: Redis;
  location?: LocationClient;
  mapping?: MappingClient;
  quotes?: QuoteProvider;
  realtime?: Realtime;
  verifyAccessToken?: VerifyAccessToken;
  /** fixed settings (tests) instead of platform-service */
  settings?: SettingsReader;
  now?: () => Date;
}

export function createContainer(config: Config, logger: Logger, opts: ContainerOptions = {}) {
  const db = opts.db ?? createDb(config.DATABASE_URL);
  const redis = opts.redis ?? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });
  const location = opts.location ?? locationClient(config.LOCATION_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN);
  const mapping = opts.mapping ?? mappingClient(config.MAPPING_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN);
  const realtime = opts.realtime ?? socketEmitter(redis);
  const now = opts.now ?? (() => new Date());

  // live settings; this service's env values are the defaults until an admin changes them
  const settingsClient = opts.settings ? undefined : createSettingsClient({
    fetchSnapshot: fetchSettingsSnapshotFrom(config.PLATFORM_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN),
    redis, logger,
    defaults: {
      "match.timeoutSeconds": config.MATCH_TIMEOUT_SECONDS, "match.offerSeconds": config.OFFER_SECONDS,
      "match.radiiMeters": config.MATCH_RADII_METERS, "trip.pinRequired": config.TRIP_PIN_REQUIRED,
    },
  });
  const settings: SettingsReader = opts.settings ?? settingsClient!;

  const devQuotes = config.PRICING === "builtin" ? builtinQuotes(redis, mapping, settings, now) : undefined;
  const quotes = opts.quotes ?? devQuotes?.provider ?? pricingQuotes(config.PRICING_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN);

  // the matcher cancels through the trip service, and the trip service starts/stops the matcher
  // (the timeout callback only runs later, after `trips` exists)
  const matcher = createMatcher({
    db, redis, location, mapping, realtime, logger,
    onTimeout: async (tripId) => void (await trips.systemCancel(tripId, "NO_DRIVER_FOUND")),
    config: () => ({
      timeoutSeconds: settings.get<number>("match.timeoutSeconds"),
      offerSeconds: settings.get<number>("match.offerSeconds"),
      radiiMeters: settings.get<number[]>("match.radiiMeters"),
    }),
    now: () => now().getTime(),
  });
  const trips = createTripService({
    db, redis, quotes, location, realtime, logger, matching: matcher.control, now,
    settings,
  });

  // tokens of suspended users, and tokens older than a role change, are refused (Auth.md §9.5)
  const verifyAccessToken =
    opts.verifyAccessToken ??
    createTokenVerifier({
      issuer: config.AUTH_ISSUER,
      jwksUrl: config.AUTH_JWKS_URL,
      isDenied: async (userId) => (await redis.exists(`deny:${userId}`)) === 1,
      currentPermissionVersion: async (userId) => {
        const v = await redis.get(`pv:${userId}`);
        return v === null ? undefined : Number(v);
      },
    });

  return {
    config, db, redis, trips, matcher, devQuotes, verifyAccessToken, settings, settingsClient,
    internalToken: config.INTERNAL_SERVICE_TOKEN,
    async close() {
      matcher.stop();
      await db.$disconnect();
      if (!opts.redis) redis.disconnect();
    },
  };
}

export type Container = ReturnType<typeof createContainer>;
