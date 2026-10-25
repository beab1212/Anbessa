// Composition root: builds every dependency from config. Used by the server and the tests.

import { Redis } from "ioredis";
import { createTokenVerifier } from "@ride-app/shared-authz";
import type { Logger } from "@ride-app/shared-utils";
import type { Config } from "./config/index.js";
import { createDb, type Db } from "./db.js";
import { consolePush, fcmPush, type PushSender } from "./channels/push.js";
import { consoleSms, twilioSms, type SmsSender } from "./channels/sms.js";
import { phoneHasher, sealer } from "./lib/crypto.js";
import { createHandlers } from "./notify/handlers.js";
import { createNotifier } from "./notify/notifier.js";
import { createOtpService } from "./otp/otp-service.js";
import { redisOtpStore, type OtpStore } from "./otp/otp-store.js";
import { reportVerifier, telegramGateway, type TelegramGateway } from "./otp/telegram-gateway.js";

export interface ContainerOptions {
  db?: Db;
  /** Test hooks: replace external systems. */
  store?: OtpStore;
  telegram?: TelegramGateway;
  sms?: SmsSender;
  push?: PushSender;
  now?: () => Date;
}

export function createContainer(config: Config, logger: Logger, opts: ContainerOptions = {}) {
  const db = opts.db ?? createDb(config.DATABASE_URL);
  const redis = opts.store ? undefined : new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });
  const store = opts.store ?? redisOtpStore(redis!, sealer(config.OTP_ENCRYPTION_KEY));

  const telegram =
    opts.telegram ??
    (config.TELEGRAM_GATEWAY_TOKEN ? telegramGateway({ token: config.TELEGRAM_GATEWAY_TOKEN, baseUrl: config.TELEGRAM_GATEWAY_URL }) : undefined);
  const sms =
    opts.sms ??
    (config.SMS_PROVIDER === "twilio"
      ? twilioSms({ accountSid: config.TWILIO_ACCOUNT_SID!, authToken: config.TWILIO_AUTH_TOKEN!, from: config.TWILIO_FROM! })
      : consoleSms(logger));
  const push =
    opts.push ??
    (config.PUSH_PROVIDER === "fcm"
      ? fcmPush({ projectId: config.FCM_PROJECT_ID!, clientEmail: config.FCM_CLIENT_EMAIL!, privateKey: config.FCM_PRIVATE_KEY! })
      : consolePush(logger));

  const otp = createOtpService({
    db, store, sms, telegram, logger,
    hashPhone: phoneHasher(config.PHONE_HASH_KEY),
    config: {
      channels: config.OTP_CHANNELS,
      fallbackSeconds: config.OTP_FALLBACK_SECONDS,
      callbackUrl: config.TELEGRAM_CALLBACK_URL,
      senderUsername: config.TELEGRAM_SENDER_USERNAME,
      balanceAlertUsd: config.TELEGRAM_BALANCE_ALERT_USD,
    },
    ...(opts.now ? { now: opts.now } : {}),
  });

  const notifier = createNotifier({ db, sms, push, logger });
  const handlers = createHandlers(notifier);

  return {
    config, db, redis, store, otp, notifier, handlers,
    internalToken: config.INTERNAL_SERVICE_TOKEN,
    verifyAccessToken: createTokenVerifier({ issuer: config.AUTH_ISSUER, jwksUrl: config.AUTH_JWKS_URL }),
    verifyTelegramReport: config.TELEGRAM_GATEWAY_TOKEN ? reportVerifier(config.TELEGRAM_GATEWAY_TOKEN) : undefined,
    async close() {
      await db.$disconnect();
      redis?.disconnect();
    },
  };
}

export type Container = ReturnType<typeof createContainer>;
