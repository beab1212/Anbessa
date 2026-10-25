import { z } from "zod";

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(3007),
    LOG_LEVEL: z.string().optional(),
    // Optional cache (routes, geocoding). Without it every request hits the engines.
    REDIS_URL: z.string().url().optional(),

    // Self-hosted engines (infra/mapping-stack). Only this service may call them.
    OSRM_URL: z.string().url().default("http://localhost:5000"),
    NOMINATIM_URL: z.string().url().default("http://localhost:8080"),
    ENGINE_TIMEOUT_MS: z.coerce.number().int().min(200).max(10_000).default(2_000),

    // Shared secret for /internal/* (pricing, trip, location) until mTLS (Auth.md §17, I7)
    INTERNAL_SERVICE_TOKEN: z.string().min(32),
    // App and staff tokens for the public /api/maps/* routes
    AUTH_ISSUER: z.string().url().default("http://localhost:3001"),
    AUTH_JWKS_URL: z.string().url().default("http://localhost:3001/api/auth/jwks"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && !env.REDIS_URL) {
      ctx.addIssue({ code: "custom", path: ["REDIS_URL"], message: "required in production (protects the engines from repeated queries)" });
    }
  });

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` (blank, as in .env.example) means "not set"
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  return envSchema.parse(set);
}
