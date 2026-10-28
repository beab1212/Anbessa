import { z } from "zod";
import { nodeEnvSchema } from "@ride-app/shared-config";

const csv = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean));

const hexKey = (bytes: number) =>
  z.string().regex(new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`), `must be ${bytes} bytes as hex (openssl rand -hex ${bytes})`);

export const envSchema = z
  .object({
    NODE_ENV: nodeEnvSchema, // required: no silent development default
    PORT: z.coerce.number().default(3006),
    LOG_LEVEL: z.string().optional(),
    DATABASE_URL: z.string().url(),
    // Required: holds the encrypted OTP codes and the SMS-fallback schedule
    REDIS_URL: z.string().url(),
    KAFKA_BROKERS: csv.transform((v) => (v.length ? v : undefined)),

    // Access tokens (device registration) are verified against auth-service's JWKS
    AUTH_ISSUER: z.string().url().default("http://localhost:3001"),
    // Live settings (admin dashboard): OTP channels and fallback delay; the env values are the defaults
    PLATFORM_INTERNAL_URL: z.string().url().default("http://localhost:3011"),
    // the live permission matrix (GET /internal/authz/snapshot)
    AUTH_INTERNAL_URL: z.string().url().default("http://localhost:3001"),
    AUTH_JWKS_URL: z.string().url().default("http://localhost:3001/api/auth/jwks"),
    // Shared with auth-service for /internal/* calls until mTLS (Auth.md §17, I7)
    INTERNAL_SERVICE_TOKEN: z.string().min(32),

    // HMAC key for phone numbers in otp_delivery (rows never hold the number itself)
    PHONE_HASH_KEY: hexKey(32),
    // AES-256-GCM key for the OTP code copy in Redis (needed for the SMS fallback)
    OTP_ENCRYPTION_KEY: hexKey(32),

    // OTP delivery (Auth.md §9.7)
    OTP_CHANNELS: csv.pipe(z.array(z.enum(["telegram", "sms"])).min(1)).default(["telegram", "sms"]),
    OTP_FALLBACK_SECONDS: z.coerce.number().int().min(5).max(120).default(20),
    TELEGRAM_GATEWAY_TOKEN: z.string().min(16).optional(),
    TELEGRAM_GATEWAY_URL: z.string().url().default("https://gatewayapi.telegram.org"),
    TELEGRAM_SENDER_USERNAME: z.string().optional(),
    // Public URL of POST /api/webhooks/telegram-gateway (through Kong)
    TELEGRAM_CALLBACK_URL: z.string().url().optional(),
    TELEGRAM_BALANCE_ALERT_USD: z.coerce.number().default(20),

    // SMS: "console" logs messages (development only)
    SMS_PROVIDER: z.enum(["console", "twilio"]).default("console"),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_FROM: z.string().optional(),

    // Push: "console" logs pushes (development only), "fcm" = Firebase Cloud Messaging HTTP v1
    PUSH_PROVIDER: z.enum(["console", "fcm"]).default("console"),
    FCM_PROJECT_ID: z.string().optional(),
    FCM_CLIENT_EMAIL: z.string().email().optional(),
    // service-account private key (PEM); "\n" escapes are accepted
    FCM_PRIVATE_KEY: z.string().optional(),

    // Campaigns (workflow 15): recipients per second across all campaigns, and the quiet hours
    // ("21-8" = nothing sent from 21:00 to 08:00 Addis Ababa time; "0-0" = none)
    CAMPAIGN_SEND_PER_SECOND: z.coerce.number().int().min(1).max(1000).default(20),
    // A campaign reaching more people than this needs a second staff member's approval
    // (maker-checker) before it is sent; 0 = every campaign needs one.
    CAMPAIGN_APPROVAL_THRESHOLD: z.coerce.number().int().min(0).default(1000),
    CAMPAIGN_QUIET_HOURS: z
      .string()
      .regex(/^\d{1,2}-\d{1,2}$/, "from-to in whole hours, e.g. 21-8")
      .default("21-8")
      .transform((v) => {
        const [from, to] = v.split("-").map(Number) as [number, number];
        return { from: from % 24, to: to % 24 };
      }),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    const telegram = env.OTP_CHANNELS.includes("telegram");
    if (env.NODE_ENV === "production") {
      if (env.SMS_PROVIDER === "console") fail("SMS_PROVIDER", "console SMS is not allowed in production (it logs login codes)");
      if (env.PUSH_PROVIDER === "console") fail("PUSH_PROVIDER", "console push is not allowed in production");
      if (!env.KAFKA_BROKERS) fail("KAFKA_BROKERS", "required in production");
      if (telegram && !env.TELEGRAM_GATEWAY_TOKEN) fail("TELEGRAM_GATEWAY_TOKEN", "required when telegram is in OTP_CHANNELS");
      if (telegram && !env.TELEGRAM_CALLBACK_URL?.startsWith("https://")) fail("TELEGRAM_CALLBACK_URL", "must be an https URL in production");
    }
    if (env.SMS_PROVIDER === "twilio" && !(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM)) {
      fail("TWILIO_ACCOUNT_SID", "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM are required for SMS_PROVIDER=twilio");
    }
    if (env.PUSH_PROVIDER === "fcm" && !(env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY)) {
      fail("FCM_PROJECT_ID", "FCM_PROJECT_ID, FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY are required for PUSH_PROVIDER=fcm");
    }
  })
  .transform((env) => ({
    ...env,
    // without a token (local development) Telegram is skipped and codes go by SMS
    OTP_CHANNELS: env.TELEGRAM_GATEWAY_TOKEN ? env.OTP_CHANNELS : env.OTP_CHANNELS.filter((c) => c !== "telegram"),
    FCM_PRIVATE_KEY: env.FCM_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  }));

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` (blank, as in .env.example) means "not set"
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  return envSchema.parse(set);
}
