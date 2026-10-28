// Composition root: builds every dependency from config. Used by the server,
// the bootstrap CLI and the integration tests.

import { Redis } from "ioredis";
import type { Logger } from "@ride-app/shared-utils";
import type { Config } from "./config/index.js";
import { createDb, type Db } from "./db.js";
import { createAdminAuth, createAppAuth } from "./auth/instances.js";
import { consoleOtpSender, notificationOtpSender, type OtpRequest, type OtpSender } from "./auth/otp-delivery.js";
import { betterAuthKeySet, createPrincipalResolver } from "./http/principal.js";
import { createOtpInbox } from "./dev/accounts.js";
import { createIdentityService } from "./identity/service.js";
import { createAuthzService } from "./authz/service.js";
import { loadAuthzSnapshot } from "./authz/store.js";
import { createAuthzSync } from "@ride-app/shared-authz";
import { redisSecondaryStorage } from "./lib/secondary-storage.js";
import { createOtpLimiter, memoryCounterStore, redisCounterStore } from "./auth/otp-limits.js";
import { noopSignals, redisSignals, type SecuritySignals } from "./lib/signals.js";

export interface ContainerOptions {
  /** Test hook: receives OTP requests when OTP_DELIVERY=console. */
  otpSink?: (req: OtpRequest) => void;
  db?: Db;
  /** Test hook: replaces the Redis-backed deny/pv signals. */
  signals?: SecuritySignals;
}

export function createContainer(config: Config, logger: Logger, opts: ContainerOptions = {}) {
  const db = opts.db ?? createDb(config.DATABASE_URL);
  const redis = config.REDIS_URL ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false }) : undefined;
  const signals = opts.signals ?? (redis ? redisSignals(redis, logger) : noopSignals());
  // DEV_LOGIN=on (never in production, see config): console OTPs are kept for the dev sign-in
  const devInbox = config.DEV_LOGIN === "on" ? createOtpInbox() : undefined;
  const otp: OtpSender =
    config.OTP_DELIVERY === "notification"
      ? notificationOtpSender(config.NOTIFICATION_INTERNAL_URL!, config.INTERNAL_SERVICE_TOKEN!, logger)
      : consoleOtpSender(logger, (req) => {
          opts.otpSink?.(req);
          devInbox?.put(req.phoneNumber, req.code);
        });

  const authDeps = { config, db, otp, ...(redis ? { secondaryStorage: redisSecondaryStorage(redis) } : {}) };
  const appAuth = createAppAuth(authDeps);
  // per-phone OTP limits, shared through Redis; switched off with the rest of rate limiting (tests)
  const otpLimits = config.AUTH_RATE_LIMIT === "on" ? createOtpLimiter(redis ? redisCounterStore(redis) : memoryCounterStore()) : undefined;
  const adminAuth = createAdminAuth(authDeps);

  const authz = createAuthzService({ db, logger, ...(redis ? { publisher: redis } : {}) });
  // this process authorizes too: keep its registry equal to the database (other replicas publish changes)
  const authzSync = createAuthzSync({ fetchSnapshot: () => loadAuthzSnapshot(db), ...(redis ? { redis } : {}), logger });

  const identity = createIdentityService({
    db,
    signals,
    executors: { "authz:change": authz.executor },
    sessions: {
      // removes sessions on both surfaces (same session table / secondary storage)
      async revokeAllSessions(userId) {
        const ctx = await appAuth.$context;
        await ctx.internalAdapter.deleteUserSessions(userId);
      },
    },
  });

  // Both surfaces share the jwks table, so one key set verifies both audiences.
  const keySet = betterAuthKeySet(async () => (await appAuth.api.getJwks()) as never);
  const requirePrincipal = createPrincipalResolver({ issuer: config.AUTH_ISSUER ?? config.AUTH_BASE_URL, keySet, signals });

  return {
    config, db, redis, signals, appAuth, adminAuth, identity, authz, authzSync, requirePrincipal, devInbox, otpLimits,
    async close() {
      await authzSync.stop();
      await db.$disconnect();
      redis?.disconnect();
    },
  };
}

export type Container = ReturnType<typeof createContainer>;
