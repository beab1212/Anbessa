import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean))
  .transform((v) => (v.length ? v : undefined));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(3003),
    LOG_LEVEL: z.string().optional(),
    // Live positions and driver state (written by realtime-gateway, Database.md §10)
    REDIS_URL: z.string().url(),
    // driver.online/offline and trip.* in, driver.connection_lost out
    KAFKA_BROKERS: csv,
    // OSRM table through mapping-service, for "ETA to pickup"
    MAPPING_INTERNAL_URL: z.string().url().default("http://localhost:3007"),
    INTERNAL_SERVICE_TOKEN: z.string().min(32),
    AUTH_ISSUER: z.string().url().default("http://localhost:3001"),
    // the live permission matrix (GET /internal/authz/snapshot)
    AUTH_INTERNAL_URL: z.string().url().default("http://localhost:3001"),
    AUTH_JWKS_URL: z.string().url().default("http://localhost:3001/api/auth/jwks"),
    SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && !env.KAFKA_BROKERS) {
      ctx.addIssue({ code: "custom", path: ["KAFKA_BROKERS"], message: "required in production (driver and trip events)" });
    }
  });

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` (blank, as in .env.example) means "not set"
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  return envSchema.parse(set);
}
