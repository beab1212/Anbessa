import { z } from "zod";
import { nodeEnvSchema } from "@ride-app/shared-config";

const csv = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean))
  .transform((v) => (v.length ? v : undefined));

export const envSchema = z
  .object({
    NODE_ENV: nodeEnvSchema, // required: no silent development default
    PORT: z.coerce.number().default(3010),
    LOG_LEVEL: z.string().optional(),
    DATABASE_URL: z.string().url(),
    // audit.recorded in (every service's outbox)
    KAFKA_BROKERS: csv,
    // deny list and permission versions (Auth.md §9.5)
    REDIS_URL: z.string().url().optional(),
    INTERNAL_SERVICE_TOKEN: z.string().min(32),
    AUTH_ISSUER: z.string().url().default("http://localhost:3001"),
    AUTH_JWKS_URL: z.string().url().default("http://localhost:3001/api/auth/jwks"),
    AUTH_INTERNAL_URL: z.string().url().default("http://localhost:3001"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && !env.KAFKA_BROKERS) ctx.addIssue({ code: "custom", path: ["KAFKA_BROKERS"], message: "required in production (audit events arrive through Kafka)" });
  });

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  return envSchema.parse(set);
}
