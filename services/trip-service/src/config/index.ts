import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean))
  .transform((v) => (v.length ? v : undefined));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(3002),
    LOG_LEVEL: z.string().optional(),
    DATABASE_URL: z.string().url(),
    // Matching state, offer locks, live driver state (shared with location-service), socket emitter
    REDIS_URL: z.string().url(),
    KAFKA_BROKERS: csv,

    INTERNAL_SERVICE_TOKEN: z.string().min(32),
    AUTH_ISSUER: z.string().url().default("http://localhost:3001"),
    // the live permission matrix (GET /internal/authz/snapshot)
    AUTH_INTERNAL_URL: z.string().url().default("http://localhost:3001"),
    AUTH_JWKS_URL: z.string().url().default("http://localhost:3001/api/auth/jwks"),
    LOCATION_INTERNAL_URL: z.string().url().default("http://localhost:3003"),
    MAPPING_INTERNAL_URL: z.string().url().default("http://localhost:3007"),

    // Quotes: "service" = pricing-service (GET /internal/quotes/:id; riders get estimates from
    // POST /api/pricing/estimates); "builtin" = the old in-process stand-in, kept for tests and for
    // running trip-service alone (POST /api/trips/estimates; refused in production)
    PRICING: z.enum(["service", "builtin"]).default("service"),
    PRICING_INTERNAL_URL: z.string().url().default("http://localhost:3004"),

    // Live settings (admin dashboard): GET /internal/settings/snapshot. The values below are only the
    // defaults until a super admin changes them there.
    PLATFORM_INTERNAL_URL: z.string().url().default("http://localhost:3011"),

    // Matching (workflow 05 §6)
    MATCH_TIMEOUT_SECONDS: z.coerce.number().int().min(10).default(120),
    OFFER_SECONDS: z.coerce.number().int().min(5).max(60).default(15),
    MATCH_RADII_METERS: z.string().default("2000,4000,6000").transform((s) => s.split(",").map(Number)),
    // Anti-fraud: the driver must enter the rider's 4-digit PIN to start (workflow 06 step 8)
    TRIP_PIN_REQUIRED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (env.NODE_ENV === "production") {
      if (env.PRICING === "builtin") fail("PRICING", "the built-in quote stand-in is not allowed in production");
      if (!env.KAFKA_BROKERS) fail("KAFKA_BROKERS", "required in production (trip events)");
    }
    if (env.MATCH_RADII_METERS.some((r) => !Number.isFinite(r) || r < 100 || r > 20_000)) fail("MATCH_RADII_METERS", "radii must be 100–20000 m");
  });

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` (blank, as in .env.example) means "not set"
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  return envSchema.parse(set);
}
