import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3001),
    LOG_LEVEL: z.string().default("info"),
    DATABASE_URL: z.string().url(),

    // Better Auth: encrypts JWKS private keys and signs cookies. Unique per environment.
    BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters (run `make secrets`)"),
    // Public base URL of this service (cookies, links), e.g. https://api.anbessa.et or http://localhost:3001
    AUTH_BASE_URL: z.string().url(),
    // `iss` of every JWT; services verify it.
    AUTH_ISSUER: z.string().url().optional(),
    // In-cluster URL used to fetch our own JWKS when verifying tokens on /api/identity.
    AUTH_INTERNAL_URL: z.string().url().optional(),
    APP_TRUSTED_ORIGINS: csv,
    ADMIN_TRUSTED_ORIGINS: csv,

    REDIS_URL: z.string().url().optional(),
    KAFKA_BROKERS: z.string().optional().transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined)),

    // OTP delivery (Auth.md §9.7): "notification" in every real environment; "console" logs codes (dev/test only).
    OTP_DELIVERY: z.enum(["notification", "console"]).default("console"),
    NOTIFICATION_INTERNAL_URL: z.string().url().optional(),
    // Shared secret for service-to-service calls until mTLS workload identity is in place (Auth.md §15).
    INTERNAL_SERVICE_TOKEN: z.string().min(32).optional(),

    // Disable Better Auth rate limiting (tests only).
    AUTH_RATE_LIMIT: z.enum(["on", "off"]).default("on"),

    // Development sign-in (src/dev): /api/dev/* lists the `seed:dev` accounts and hands out their
    // current codes. Refused in production; needs console OTP delivery.
    DEV_LOGIN: z.enum(["on", "off"]).default("off"),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (env.NODE_ENV === "production") {
      if (env.OTP_DELIVERY === "console") fail("OTP_DELIVERY", "console OTP delivery is not allowed in production");
      if (!env.REDIS_URL) fail("REDIS_URL", "required in production (sessions cache, shared rate limits)");
      if (!env.KAFKA_BROKERS) fail("KAFKA_BROKERS", "required in production (outbox relay)");
      if (!env.INTERNAL_SERVICE_TOKEN) fail("INTERNAL_SERVICE_TOKEN", "required in production");
      if (env.AUTH_RATE_LIMIT === "off") fail("AUTH_RATE_LIMIT", "rate limiting can't be disabled in production");
      if (env.DEV_LOGIN === "on") fail("DEV_LOGIN", "development sign-in is not allowed in production");
      if (!env.AUTH_BASE_URL.startsWith("https://")) fail("AUTH_BASE_URL", "must be https in production");
    }
    if (env.DEV_LOGIN === "on" && env.OTP_DELIVERY !== "console") {
      fail("DEV_LOGIN", "development sign-in needs OTP_DELIVERY=console");
    }
    if (env.OTP_DELIVERY === "notification" && !env.NOTIFICATION_INTERNAL_URL) {
      fail("NOTIFICATION_INTERNAL_URL", "required when OTP_DELIVERY=notification");
    }
    if (env.OTP_DELIVERY === "notification" && !env.INTERNAL_SERVICE_TOKEN) {
      fail("INTERNAL_SERVICE_TOKEN", "required when OTP_DELIVERY=notification");
    }
  })
  .transform((env) => ({
    ...env,
    AUTH_ISSUER: env.AUTH_ISSUER ?? env.AUTH_BASE_URL,
    AUTH_INTERNAL_URL: env.AUTH_INTERNAL_URL ?? `http://localhost:${env.PORT}`,
  }));

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` (blank, as in .env.example) means "not set"
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  return envSchema.parse(set);
}
