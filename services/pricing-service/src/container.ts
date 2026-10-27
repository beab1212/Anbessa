// Composition root: builds every dependency from config. Used by the server and the tests.

import { Redis } from "ioredis";
import { createTokenVerifier, type VerifyAccessToken } from "@ride-app/shared-authz";
import { createSettingsClient, fetchSettingsSnapshotFrom, type SettingsReader } from "@ride-app/shared-settings";
import type { Logger } from "@ride-app/shared-utils";
import type { Config } from "./config/index.js";
import { locationClient, type LocationClient } from "./lib/location.js";
import { mappingClient, type MappingClient } from "./lib/mapping.js";
import { createQuotes, redisQuoteStore, type QuoteStore } from "./quotes.js";

export interface ContainerOptions {
  redis?: Redis;
  store?: QuoteStore;
  mapping?: MappingClient;
  location?: LocationClient;
  settings?: SettingsReader;
  verifyAccessToken?: VerifyAccessToken;
  now?: () => Date;
}

export function createContainer(config: Config, logger: Logger, opts: ContainerOptions = {}) {
  const redis = opts.redis ?? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: !!opts.store });
  const mapping = opts.mapping ?? mappingClient(config.MAPPING_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN);
  const location = opts.location ?? locationClient(config.LOCATION_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN);

  // live fares; the registry defaults apply until platform-service answers
  const settingsClient = opts.settings ? undefined : createSettingsClient({
    fetchSnapshot: fetchSettingsSnapshotFrom(config.PLATFORM_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN),
    redis, logger,
  });
  const settings: SettingsReader = opts.settings ?? settingsClient!;
  const quotes = createQuotes({ store: opts.store ?? redisQuoteStore(redis), mapping, location, settings, logger, ...(opts.now ? { now: opts.now } : {}) });

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
    config, redis, quotes, settings, settingsClient, verifyAccessToken,
    internalToken: config.INTERNAL_SERVICE_TOKEN,
    async close() {
      if (!opts.redis) redis.disconnect();
    },
  };
}

export type Container = ReturnType<typeof createContainer>;
