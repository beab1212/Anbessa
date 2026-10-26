// Composition root: builds every dependency from config. Used by the server and the tests.

import { Redis } from "ioredis";
import { createTokenVerifier, type VerifyAccessToken } from "@ride-app/shared-authz";
import { createSettingsClient, fetchSettingsSnapshotFrom, type SettingsReader } from "@ride-app/shared-settings";
import type { Logger } from "@ride-app/shared-utils";
import type { Config } from "./config/index.js";
import { createDb, type Db } from "./db.js";
import { createGateways } from "./gateways/index.js";
import { httpDeliver, simStore, type Deliver, type SimStore } from "./gateways/simulator.js";
import { noRealtime, socketEmitter, type Realtime } from "./lib/realtime.js";
import { createBalanceService } from "./money/balance-service.js";
import { createPayments } from "./money/payments.js";
import { createPayouts } from "./money/payouts.js";
import { createRuleChanges } from "./money/rule-changes.js";
import { createTopUps } from "./money/topups.js";
import { createWebhooks } from "./money/webhooks.js";

export interface ContainerOptions {
  db?: Db;
  verifyAccessToken?: VerifyAccessToken;
  settings?: SettingsReader;
  realtime?: Realtime;
  /** how the simulator delivers callbacks (tests inject them into the app) */
  deliver?: Deliver;
  simStore?: SimStore;
  now?: () => Date;
}

export function createContainer(config: Config, logger: Logger, opts: ContainerOptions = {}) {
  const db = opts.db ?? createDb(config.DATABASE_URL);
  const redis = config.REDIS_URL ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 }) : undefined;
  const now = opts.now ?? (() => new Date());
  const realtime = opts.realtime ?? (redis ? socketEmitter(redis) : noRealtime);

  // live settings: payment methods and the provider order (admin dashboard → Settings → Payments)
  const settingsClient = opts.settings ? undefined : createSettingsClient({
    fetchSnapshot: fetchSettingsSnapshotFrom(config.PLATFORM_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN),
    ...(redis ? { redis } : {}), logger,
  });
  const settings: SettingsReader = opts.settings ?? settingsClient!;

  const base = config.PUBLIC_URL.replace(/\/$/, "");
  const notifyUrl = (provider: string) => `${base}/api/payments/webhooks/${provider}`;
  const gateways = createGateways(
    {
      providers: config.PAYMENT_PROVIDERS,
      secrets: { telebirr: config.TELEBIRR_WEBHOOK_SECRET, cbebirr: config.CBEBIRR_WEBHOOK_SECRET, chapa: config.CHAPA_WEBHOOK_SECRET },
      checkoutBaseUrl: base,
      autoApproveMs: config.SIM_AUTO_APPROVE_SECONDS * 1000,
      payoutDelayMs: config.SIM_PAYOUT_SECONDS * 1000,
      dropRate: config.SIM_DROP_WEBHOOKS,
    },
    { store: opts.simStore ?? simStore(redis), deliver: opts.deliver ?? httpDeliver, logger },
  );

  const payments = createPayments({ db, gateways, settings, realtime, logger, notifyUrl, retryDelaysSeconds: config.PAYMENT_RETRY_SECONDS, now });
  const topUps = createTopUps({ db, gateways, realtime, logger, notifyUrl, now });
  const payouts = createPayouts({ db, gateways, logger, notifyUrl, now });
  const ruleChanges = createRuleChanges({ db, now });
  const balances = createBalanceService({ db, gateways, now });
  const webhooks = createWebhooks({ db, gateways, payments, topUps, payouts, logger, now });

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
    config, db, redis, settings, settingsClient, gateways, payments, topUps, payouts, ruleChanges, balances, webhooks, verifyAccessToken, now,
    internalToken: config.INTERNAL_SERVICE_TOKEN,
    async close() {
      gateways.simulator.stop();
      await db.$disconnect();
      redis?.disconnect();
    },
  };
}

export type Container = ReturnType<typeof createContainer>;
