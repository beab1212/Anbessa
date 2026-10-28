// Composition root: builds every dependency from config. Used by the server and the tests.

import { Redis } from "ioredis";
import { createTokenVerifier, type VerifyAccessToken } from "@ride-app/shared-authz";
import type { Logger } from "@ride-app/shared-utils";
import type { Config } from "./config/index.js";
import { createDb, type Db } from "./db.js";
import { locationClient, mappingClient, orgMembersClient, partiesClient, type LocationClient, type MappingClient, type OrgMembersClient, type PartiesClient } from "./lib/clients.js";
import { socketEmitter, type Realtime } from "./lib/realtime.js";
import { createMatcher } from "./matching/matcher.js";
import { builtinQuotes, pricingQuotes, type QuoteProvider } from "./quotes.js";
import { createParties } from "./trips/parties.js";
import { createPlaces } from "./trips/places.js";
import { createShares } from "./trips/share.js";
import { createTripService } from "./trips/service.js";
import { createCorporatePolicies } from "./trips/corporate.js";
import { createRegulatoryReport } from "./trips/regulatory.js";
import { createScheduler, DEFAULT_SCHEDULE } from "./trips/scheduled.js";
import { createTraceReader, createTraceRecorder } from "./trips/trace.js";
import { createSettingsClient, fetchSettingsSnapshotFrom, type SettingsReader } from "@ride-app/shared-settings";

export interface ContainerOptions {
  db?: Db;
  redis?: Redis;
  location?: LocationClient;
  mapping?: MappingClient;
  parties?: PartiesClient;
  /** company memberships (auth-service) */
  orgs?: OrgMembersClient;
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
  const places = createPlaces(db);
  const parties = createParties({
    redis, logger,
    client: opts.parties ?? partiesClient(config.AUTH_INTERNAL_URL, config.FLEET_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN),
    ratingOf: (userId) => trips.ratingOfUser(userId),
  });
  const now = opts.now ?? (() => new Date());
  const shares = createShares({ db, parties, location, baseUrl: config.SHARE_BASE_URL, now });

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
    // scheduled rides keep searching (escalated to dispatch); other trips are cancelled
    onTimeout: (tripId) => trips.matchTimedOut(tripId),
    config: () => ({
      timeoutSeconds: settings.get<number>("match.timeoutSeconds"),
      offerSeconds: settings.get<number>("match.offerSeconds"),
      radiiMeters: settings.get<number[]>("match.radiiMeters"),
    }),
    now: () => now().getTime(),
  });
  const policies = createCorporatePolicies({ db, now });
  const trace = createTraceReader({ db });
  const traceRecorder = createTraceRecorder({ db, logger, now });
  const regulatory = createRegulatoryReport({ db, now });
  const trips = createTripService({
    db, redis, quotes, location, realtime, logger, matching: matcher.control, now,
    settings, policies, trace,
    orgs: opts.orgs ?? orgMembersClient(config.AUTH_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN),
  });
  const scheduler = createScheduler({
    db, quotes, trips, policies, settings, realtime, logger, now,
    config: () => ({ ...DEFAULT_SCHEDULE, leadMinutes: config.SCHEDULE_LEAD_MINUTES, nightLeadMinutes: config.SCHEDULE_NIGHT_LEAD_MINUTES }),
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
    config, db, redis, trips, parties, places, shares, matcher, devQuotes, verifyAccessToken, settings, settingsClient,
    policies, trace, traceRecorder, regulatory, scheduler,
    internalToken: config.INTERNAL_SERVICE_TOKEN,
    async close() {
      matcher.stop();
      scheduler.stop();
      await db.$disconnect();
      if (!opts.redis) redis.disconnect();
    },
  };
}

export type Container = ReturnType<typeof createContainer>;
