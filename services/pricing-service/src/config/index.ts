import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean))
  .transform((v) => (v.length ? v : undefined));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(3004),
    LOG_LEVEL: z.string().optional(),
    // zones, fare rules and their change requests, promotions (workflow 15)
    DATABASE_URL: z.string().url(),
    // quotes live here until they expire (quote.ttlSeconds); also the deny list and permission
    // versions written by auth-service (Auth.md §9.5), and the pricing:catalog_changed channel
    REDIS_URL: z.string().url(),
    // pricing.*, promo.*, audit.recorded out (outbox); trip.completed / trip.cancelled in (promo redemptions)
    KAFKA_BROKERS: csv,

    INTERNAL_SERVICE_TOKEN: z.string().min(32),
    AUTH_ISSUER: z.string().url().default("http://localhost:3001"),
    AUTH_JWKS_URL: z.string().url().default("http://localhost:3001/api/auth/jwks"),
    // the live permission matrix (GET /internal/authz/snapshot)
    AUTH_INTERNAL_URL: z.string().url().default("http://localhost:3001"),
    // routes (distance and time) for each quote
    MAPPING_INTERNAL_URL: z.string().url().default("http://localhost:3007"),
    // ETA to the pickup per vehicle type on each quote (GET /internal/eta-to-pickup)
    LOCATION_INTERNAL_URL: z.string().url().default("http://localhost:3003"),
    // live fares (admin dashboard → Settings → Fares): GET /internal/settings/snapshot
    PLATFORM_INTERNAL_URL: z.string().url().default("http://localhost:3011"),

    // a promo whose budget is above this (santim) is activated only by someone holding
    // incentive:approve who didn't create it (workflow 15 step 12). Default 10 000 birr.
    PROMO_APPROVAL_THRESHOLD_MINOR: z.coerce.number().int().min(0).default(1_000_000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && !env.KAFKA_BROKERS) {
      ctx.addIssue({ code: "custom", path: ["KAFKA_BROKERS"], message: "required in production (promo redemptions and audit events)" });
    }
  });

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` (blank, as in .env.example) means "not set"
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  return envSchema.parse(set);
}
