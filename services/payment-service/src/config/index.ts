import { z } from "zod";
import { PROVIDERS } from "../gateways/types.js";

const csv = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean))
  .transform((v) => (v.length ? v : undefined));

const secret = (name: string) => z.string().min(32, `${name} must be at least 32 characters (run \`make secrets\`)`);

export const envSchema = z
  .object({
    // no default: an unset NODE_ENV must not quietly turn on development behaviour
    NODE_ENV: z.enum(["development", "test", "production"]),
    PORT: z.coerce.number().default(3005),
    LOG_LEVEL: z.string().optional(),
    DATABASE_URL: z.string().url(),
    // deny list and permission versions (auth-service), realtime pushes to riders, simulator state
    REDIS_URL: z.string().url().optional(),
    // trip.completed / trip.cancelled in; balance.*, payment.*, payout.*, refund.* out (outbox)
    KAFKA_BROKERS: csv,

    INTERNAL_SERVICE_TOKEN: z.string().min(32),
    AUTH_ISSUER: z.string().url().default("http://localhost:3001"),
    AUTH_JWKS_URL: z.string().url().default("http://localhost:3001/api/auth/jwks"),
    AUTH_INTERNAL_URL: z.string().url().default("http://localhost:3001"),
    PLATFORM_INTERNAL_URL: z.string().url().default("http://localhost:3011"),
    // trip-service's own record of a trip (GET /internal/trips/:id): trip.completed / trip.cancelled
    // are checked against it before any money is posted
    TRIP_INTERNAL_URL: z.string().url().default("http://localhost:3002"),
    // "on" (default; required in production) | "off" (default under NODE_ENV=test, for suites
    // without a trip-service): cross-check every trip event's money fields with trip-service
    TRIP_EVENT_CHECK: z.enum(["on", "off"]).optional(),

    // Where providers reach us (webhooks) and payers' browsers reach the hosted checkout. Behind
    // Kong this is the public API URL; /api/payments/webhooks/{provider} must be reachable.
    PUBLIC_URL: z.string().url().default("http://localhost:3005"),

    // Providers in use, and how they're reached: "simulated" until the real integrations exist
    // (refused in production)
    PAYMENT_PROVIDERS: z.string().default(PROVIDERS.join(",")).transform((s, ctx) => {
      const list = s.split(",").map((v) => v.trim()).filter(Boolean);
      const bad = list.filter((p) => !(PROVIDERS as readonly string[]).includes(p));
      if (bad.length) ctx.addIssue({ code: "custom", message: `unknown providers: ${bad.join(", ")} (known: ${PROVIDERS.join(", ")})` });
      return list as (typeof PROVIDERS)[number][];
    }),
    GATEWAY_MODE: z.enum(["simulated"]).default("simulated"),
    // Each provider signs its callbacks; these verify them (the simulator signs with the same values)
    TELEBIRR_WEBHOOK_SECRET: secret("TELEBIRR_WEBHOOK_SECRET"),
    CBEBIRR_WEBHOOK_SECRET: secret("CBEBIRR_WEBHOOK_SECRET"),
    CHAPA_WEBHOOK_SECRET: secret("CHAPA_WEBHOOK_SECRET"),

    // Simulator: charges approve themselves after this many seconds (0 = wait for the checkout page)
    SIM_AUTO_APPROVE_SECONDS: z.coerce.number().min(0).max(600).default(0),
    SIM_PAYOUT_SECONDS: z.coerce.number().min(0).max(600).default(3),
    // share of callbacks dropped on purpose, to exercise reconciliation (0–1)
    SIM_DROP_WEBHOOKS: z.coerce.number().min(0).max(1).default(0),

    // A declined charge is tried again after each of these delays, then becomes a rider receivable
    PAYMENT_RETRY_SECONDS: z.string().default("60,600,3600").transform((s) => s.split(",").map(Number)),
    // Open charges, payouts and refunds older than this are checked with the provider
    RECONCILE_AFTER_SECONDS: z.coerce.number().int().min(10).default(300),
    // "weekly" settles every Monday 00:00 Addis Ababa time; "off" leaves it to finance's "run now"
    SETTLEMENT_SCHEDULE: z.enum(["weekly", "off"]).default("weekly"),
    // A negative balance can be written off once its payment due has been overdue this many days (Payment.md Q8)
    WRITE_OFF_AFTER_DAYS: z.coerce.number().int().min(0).max(3650).default(90),
    // A balance whose payout method changed less than this many hours ago is held by the payout
    // run (paid by a later run); the owner is told about every change (payout_method.changed)
    PAYOUT_METHOD_COOLOFF_HOURS: z.coerce.number().min(0).max(720).default(72),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (env.NODE_ENV === "production") {
      if (env.GATEWAY_MODE === "simulated") fail("GATEWAY_MODE", "simulated payment providers are not allowed in production");
      if (!env.KAFKA_BROKERS) fail("KAFKA_BROKERS", "required in production (trip settlement and balance states travel through Kafka)");
      if (!env.REDIS_URL) fail("REDIS_URL", "required in production (suspended users and role changes must take effect at once)");
      if (env.TRIP_EVENT_CHECK === "off") fail("TRIP_EVENT_CHECK", "required in production (trip events are checked against trip-service before money is posted)");
    }
    if (env.PAYMENT_RETRY_SECONDS.some((n) => !Number.isFinite(n) || n < 1)) fail("PAYMENT_RETRY_SECONDS", "seconds, comma separated, each ≥ 1");
    const secrets = [env.TELEBIRR_WEBHOOK_SECRET, env.CBEBIRR_WEBHOOK_SECRET, env.CHAPA_WEBHOOK_SECRET];
    if (new Set(secrets).size !== secrets.length) fail("CHAPA_WEBHOOK_SECRET", "each provider needs its own webhook secret");
  });

export type Config = z.infer<typeof envSchema>;

/** Is every trip event checked against trip-service? On unless turned off (never in production); off by default in tests. */
export const tripEventCheck = (c: Pick<Config, "NODE_ENV" | "TRIP_EVENT_CHECK">) => (c.TRIP_EVENT_CHECK ?? (c.NODE_ENV === "test" ? "off" : "on")) === "on";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` (blank, as in .env.example) means "not set"
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  return envSchema.parse(set);
}
