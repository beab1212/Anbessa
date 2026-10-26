// Composition root: builds every dependency from config. Used by the server and the tests.

import { Redis } from "ioredis";
import { createTokenVerifier, type VerifyAccessToken } from "@ride-app/shared-authz";
import type { Config } from "./config/index.js";
import { createDb, type Db } from "./db.js";
import { createAuditStore } from "./store.js";

export function createContainer(config: Config, opts: { db?: Db; verifyAccessToken?: VerifyAccessToken } = {}) {
  const db = opts.db ?? createDb(config.DATABASE_URL);
  const redis = config.REDIS_URL ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 }) : undefined;
  const store = createAuditStore(db);
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
    config, db, redis, store, verifyAccessToken,
    async close() {
      await db.$disconnect();
      redis?.disconnect();
    },
  };
}

export type Container = ReturnType<typeof createContainer>;
