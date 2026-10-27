import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3004),
  LOG_LEVEL: z.string().optional(),
  // quotes live here until they expire (quote.ttlSeconds); also the deny list and permission
  // versions written by auth-service (Auth.md §9.5)
  REDIS_URL: z.string().url(),

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
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` (blank, as in .env.example) means "not set"
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  return envSchema.parse(set);
}
