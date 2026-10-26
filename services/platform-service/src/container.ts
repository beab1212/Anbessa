// Composition root: builds every dependency from config. Used by the server and the tests.

import { Redis } from "ioredis";
import { createTokenVerifier, type VerifyAccessToken } from "@ride-app/shared-authz";
import type { Logger } from "@ride-app/shared-utils";
import type { Config } from "./config/index.js";
import { createDb, type Db } from "./db.js";
import { createCatalogService, type IdentitySync } from "./catalog/service.js";
import { identitySync } from "./lib/identity.js";
import { createSettingsService, type Publisher } from "./settings/service.js";
import { createSystemHealth } from "./system/health.js";

export interface ContainerOptions {
  db?: Db;
  identity?: IdentitySync;
  publisher?: Publisher;
  verifyAccessToken?: VerifyAccessToken;
  now?: () => Date;
}

export function createContainer(config: Config, logger: Logger, opts: ContainerOptions = {}) {
  const db = opts.db ?? createDb(config.DATABASE_URL);
  const redis = config.REDIS_URL ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 }) : undefined;
  const publisher = opts.publisher ?? redis;
  const settings = createSettingsService({ db, logger, ...(publisher ? { publisher } : {}), ...(opts.now ? { now: opts.now } : {}) });
  const catalog = createCatalogService({
    db, publish: settings.publish, ...(opts.now ? { now: opts.now } : {}),
    identity: opts.identity ?? identitySync(config.AUTH_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN),
  });
  const system = createSystemHealth({
    db, ...(redis ? { redis } : {}), targets: config.SERVICE_URLS, token: config.INTERNAL_SERVICE_TOKEN,
    ...(config.KAFKA_BROKERS ? { kafkaBrokers: config.KAFKA_BROKERS } : {}), consumerGroups: config.CONSUMER_GROUPS,
  });

  // tokens of suspended users, and tokens older than a role change, are refused (Auth.md §9.5)
  const verifyAccessToken =
    opts.verifyAccessToken ??
    createTokenVerifier({
      issuer: config.AUTH_ISSUER,
      jwksUrl: config.AUTH_JWKS_URL,
      ...(redis
        ? {
            isDenied: async (userId: string) => (await redis.exists(`deny:${userId}`)) === 1,
            currentPermissionVersion: async (userId: string) => {
              const v = await redis.get(`pv:${userId}`);
              return v === null ? undefined : Number(v);
            },
          }
        : {}),
    });

  return {
    config, db, redis, settings, catalog, system, verifyAccessToken,
    internalToken: config.INTERNAL_SERVICE_TOKEN,
    async close() {
      await system.stop();
      await db.$disconnect();
      redis?.disconnect();
    },
  };
}

export type Container = ReturnType<typeof createContainer>;
