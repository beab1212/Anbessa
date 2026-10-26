import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean))
  .transform((v) => (v.length ? v : undefined));

const list = (s: string) => s.split(",").map((v) => v.trim()).filter(Boolean);

/** "name=url,name=url" → [{ name, url }] */
const toTargets = (s: string) =>
  s.split(",").map((pair) => pair.trim()).filter(Boolean).map((pair) => {
    const [name, url] = pair.split("=");
    return { name: name!.trim(), url: (url ?? "").trim() };
  });

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(3011),
    LOG_LEVEL: z.string().optional(),
    DATABASE_URL: z.string().url(),
    // pub/sub `settings:changed` (services reload at once), the system page's Redis check
    REDIS_URL: z.string().url().optional(),
    // audit.recorded out (outbox); consumer-group lag for the system page
    KAFKA_BROKERS: csv,

    INTERNAL_SERVICE_TOKEN: z.string().min(32),
    AUTH_ISSUER: z.string().url().default("http://localhost:3001"),
    AUTH_JWKS_URL: z.string().url().default("http://localhost:3001/api/auth/jwks"),
    AUTH_INTERNAL_URL: z.string().url().default("http://localhost:3001"),

    // System page: every service's base URL (in-cluster). Its /health/ready is checked; outbox
    // owners also answer /internal/ops/outbox.
    SERVICE_URLS: z.string().default(
      "auth-service=http://localhost:3001,trip-service=http://localhost:3002,location-service=http://localhost:3003," +
        "pricing-service=http://localhost:3004,payment-service=http://localhost:3005,notification-service=http://localhost:3006," +
        "mapping-service=http://localhost:3007,fleet-service=http://localhost:3008,audit-service=http://localhost:3010," +
        "realtime-gateway=http://localhost:3000",
    ).transform(toTargets),
    // Kafka consumer groups whose lag the system page shows
    CONSUMER_GROUPS: z.string().default("location-service,notification-service,fleet-service,audit-service").transform(list),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production") {
      if (!env.REDIS_URL) ctx.addIssue({ code: "custom", path: ["REDIS_URL"], message: "required in production (settings changes must reach services at once)" });
      if (!env.KAFKA_BROKERS) ctx.addIssue({ code: "custom", path: ["KAFKA_BROKERS"], message: "required in production (audit events)" });
    }
  });

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` (blank, as in .env.example) means "not set"
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  return envSchema.parse(set);
}
