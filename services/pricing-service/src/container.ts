// Composition root: builds every dependency from config. Used by the server and the tests.

import { Redis } from "ioredis";
import { createTokenVerifier, type VerifyAccessToken } from "@ride-app/shared-authz";
import { createSettingsClient, fetchSettingsSnapshotFrom, type SettingsReader } from "@ride-app/shared-settings";
import type { Logger } from "@ride-app/shared-utils";
import { CATALOG_CHANNEL, dbCatalog, emptyCatalog, type PricingCatalog } from "./catalog.js";
import type { Config } from "./config/index.js";
import { createDb, type Db } from "./db.js";
import { locationClient, type LocationClient } from "./lib/location.js";
import { mappingClient, type MappingClient } from "./lib/mapping.js";
import { createPromoService } from "./promos/service.js";
import { createQuotes, redisQuoteStore, type QuoteStore } from "./quotes.js";
import { createRuleService } from "./rules/service.js";
import { createZoneService } from "./zones/service.js";

export interface ContainerOptions {
  redis?: Redis;
  db?: Db;
  store?: QuoteStore;
  mapping?: MappingClient;
  location?: LocationClient;
  settings?: SettingsReader;
  /** unit tests without Postgres: `emptyCatalog` prices from the settings only */
  catalog?: PricingCatalog;
  verifyAccessToken?: VerifyAccessToken;
  now?: () => Date;
}

export function createContainer(config: Config, logger: Logger, opts: ContainerOptions = {}) {
  const redis = opts.redis ?? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: !!opts.store });
  const db = opts.db ?? createDb(config.DATABASE_URL);
  const now = opts.now ?? (() => new Date());
  const mapping = opts.mapping ?? mappingClient(config.MAPPING_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN);
  const location = opts.location ?? locationClient(config.LOCATION_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN);

  // live fares; the registry defaults apply until platform-service answers
  const settingsClient = opts.settings ? undefined : createSettingsClient({
    fetchSnapshot: fetchSettingsSnapshotFrom(config.PLATFORM_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN),
    redis, logger,
  });
  const settings: SettingsReader = opts.settings ?? settingsClient!;

  // approved fare rules and zones, cached; other replicas hear about changes on Redis
  const catalog = opts.catalog ?? dbCatalog(db, now, logger);
  const catalogChanged = () => {
    catalog.invalidate();
    if (catalog !== emptyCatalog) redis.publish(CATALOG_CHANNEL, String(Date.now())).catch((err: Error) => logger.warn({ err: err.message }, "catalog change not broadcast; other replicas reload within 60 s"));
  };

  const promos = createPromoService({ db, logger, now, approvalThresholdMinor: config.PROMO_APPROVAL_THRESHOLD_MINOR });
  const rules = createRuleService({ db, settings, now, onChange: catalogChanged });
  const zones = createZoneService({ db, onChange: catalogChanged });
  const quotes = createQuotes({ store: opts.store ?? redisQuoteStore(redis), mapping, location, settings, logger, now, catalog, promos });

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
    config, redis, db, now, quotes, settings, settingsClient, catalog, promos, rules, zones, verifyAccessToken,
    internalToken: config.INTERNAL_SERVICE_TOKEN,
    async close() {
      await db.$disconnect();
      if (!opts.redis) redis.disconnect();
    },
  };
}

export type Container = ReturnType<typeof createContainer>;
