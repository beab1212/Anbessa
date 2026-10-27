import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean))
  .transform((v) => (v.length ? v : undefined));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(3009),
    LOG_LEVEL: z.string().optional(),
    DATABASE_URL: z.string().url(),
    // deny list and permission versions (Auth.md §9.5); Socket.io emitter to the phone app
    REDIS_URL: z.string().url().optional(),
    // ticket.*, sos.*, incident.*, audit.recorded out (outbox); refund.* in
    KAFKA_BROKERS: csv,

    INTERNAL_SERVICE_TOKEN: z.string().min(32),
    AUTH_ISSUER: z.string().url().default("http://localhost:3001"),
    AUTH_JWKS_URL: z.string().url().default("http://localhost:3001/api/auth/jwks"),
    AUTH_INTERNAL_URL: z.string().url().default("http://localhost:3001"),
    // trip facts (parties, city, status, drop-off time): GET /internal/trips/:id
    TRIP_INTERNAL_URL: z.string().url().default("http://localhost:3002"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production") {
      if (!env.REDIS_URL) ctx.addIssue({ code: "custom", path: ["REDIS_URL"], message: "required in production (suspended users must be refused at once)" });
      if (!env.KAFKA_BROKERS) ctx.addIssue({ code: "custom", path: ["KAFKA_BROKERS"], message: "required in production (sos.triggered and audit events)" });
    }
  });

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` (blank, as in .env.example) means "not set"
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  return envSchema.parse(set);
}
