// Composition root: builds every dependency from config. Used by the server and the tests.

import { Redis } from "ioredis";
import { createTokenVerifier, type VerifyAccessToken } from "@ride-app/shared-authz";
import { createSettingsClient, fetchSettingsSnapshotFrom, type SettingsReader } from "@ride-app/shared-settings";
import type { Logger } from "@ride-app/shared-utils";
import { tripEventCheck, type Config } from "./config/index.js";
import { createDb, type Db } from "./db.js";
import { createGateways } from "./gateways/index.js";
import { httpDeliver, simStore, type Deliver, type SimStore } from "./gateways/simulator.js";
import { noRealtime, socketEmitter, type Realtime } from "./lib/realtime.js";
import { tripLookup, type TripLookup } from "./lib/trips.js";
import { createEarnings } from "./money/earnings.js";
import { createReports } from "./money/reports.js";
import { createBalanceService } from "./money/balance-service.js";
import { createPayments } from "./money/payments.js";
import { createPayouts } from "./money/payouts.js";
import { createRuleChanges } from "./money/rule-changes.js";
import { createTopUps } from "./money/topups.js";
import { createWebhooks } from "./money/webhooks.js";
import { createAdjustments } from "./money/adjustments.js";
import { createIncentives } from "./money/incentives.js";
import { createInvoices } from "./money/invoices.js";
import { createPolicyOverrides } from "./money/policy-overrides.js";
import { createWriteOffs } from "./money/write-offs.js";

export interface ContainerOptions {
  db?: Db;
  verifyAccessToken?: VerifyAccessToken;
  settings?: SettingsReader;
  realtime?: Realtime;
  /** how the simulator delivers callbacks (tests inject them into the app) */
  deliver?: Deliver;
  simStore?: SimStore;
  /** trip-service's record of trips (tests inject a fake); used when TRIP_EVENT_CHECK is on */
  trips?: TripLookup;
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

  // every trip event's money is checked against trip-service before it is posted (off only in tests/dev by config)
  const trips = opts.trips ?? (tripEventCheck(config) ? tripLookup(config.TRIP_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN) : undefined);
  if (!trips) logger.warn("TRIP_EVENT_CHECK is off: trip events are posted without checking them against trip-service");
  const payoutCoolOffMs = config.PAYOUT_METHOD_COOLOFF_HOURS * 3_600_000;
  const payments = createPayments({ db, gateways, settings, realtime, logger, notifyUrl, retryDelaysSeconds: config.PAYMENT_RETRY_SECONDS, now, ...(trips ? { trips } : {}) });
  const topUps = createTopUps({ db, gateways, realtime, logger, notifyUrl, now });
  const payouts = createPayouts({ db, gateways, logger, notifyUrl, now, payoutCoolOffMs });
  const ruleChanges = createRuleChanges({ db, now });
  const balances = createBalanceService({ db, gateways, now, payoutCoolOffMs });
  const earnings = createEarnings({ db, now });
  const reports = createReports({ db, now });
  const webhooks = createWebhooks({ db, gateways, payments, topUps, payouts, logger, now });
  // money controls: adjustments, write-offs, policy overrides, incentives, corporate invoices
  const adjustments = createAdjustments({ db, now });
  const writeOffs = createWriteOffs({ db, afterDays: config.WRITE_OFF_AFTER_DAYS, now });
  const policyOverrides = createPolicyOverrides({ db, now });
  const incentives = createIncentives({ db, logger, now });
  const invoices = createInvoices({ db, now });

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
    config, db, redis, settings, settingsClient, gateways, payments, topUps, payouts, ruleChanges, balances, earnings, reports, webhooks, verifyAccessToken, now,
    adjustments, writeOffs, policyOverrides, incentives, invoices,
    internalToken: config.INTERNAL_SERVICE_TOKEN,
    async close() {
      gateways.simulator.stop();
      await db.$disconnect();
      redis?.disconnect();
    },
  };
}

export type Container = ReturnType<typeof createContainer>;
