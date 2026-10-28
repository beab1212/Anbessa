import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean))
  .transform((v) => (v.length ? v : undefined));

const hexKey = (name: string) => z.string().regex(/^[0-9a-f]{64}$/i, `${name} must be 32 random bytes as hex (run \`make secrets\`)`);

export const envSchema = z
  .object({
    // no default: an unset NODE_ENV must not quietly turn on development behaviour
    NODE_ENV: z.enum(["development", "test", "production"]),
    PORT: z.coerce.number().default(3008),
    LOG_LEVEL: z.string().optional(),
    DATABASE_URL: z.string().url(),
    // deny list and permission versions written by auth-service (Auth.md §9.5)
    REDIS_URL: z.string().url().optional(),
    // driver.online / driver.offline / vehicle.* out (outbox), driver.connection_lost in
    KAFKA_BROKERS: csv,

    INTERNAL_SERVICE_TOKEN: z.string().min(32),
    AUTH_ISSUER: z.string().url().default("http://localhost:3001"),
    AUTH_JWKS_URL: z.string().url().default("http://localhost:3001/api/auth/jwks"),
    AUTH_INTERNAL_URL: z.string().url().default("http://localhost:3001"),

    // Licence numbers: AES-256-GCM (PII_ENCRYPTION_KEY) + HMAC blind index (PII_BLIND_INDEX_KEY), Database.md §17
    PII_ENCRYPTION_KEY: hexKey("PII_ENCRYPTION_KEY"),
    PII_BLIND_INDEX_KEY: hexKey("PII_BLIND_INDEX_KEY"),
    // Signs upload tickets and local-storage URLs
    UPLOAD_SIGNING_KEY: hexKey("UPLOAD_SIGNING_KEY"),

    // Document files: "s3" (any S3 API: AWS, MinIO) or "local" (a directory, development only)
    STORAGE: z.enum(["s3", "local"]).default("local"),
    STORAGE_DIR: z.string().default(".dev-data/uploads"),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().default("eu-central-1"),
    // MinIO or another S3-compatible endpoint; unset for AWS
    S3_ENDPOINT: z.string().url().optional(),
    S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),

    // Balance state when a driver goes online (GET /internal/balances/state)
    PAYMENT_INTERNAL_URL: z.string().url().default("http://localhost:3005"),

    // Live settings (admin dashboard): GET /internal/settings/snapshot
    PLATFORM_INTERNAL_URL: z.string().url().default("http://localhost:3011"),

    // Documents due within this many days count as "expiring soon" (default until changed in the admin dashboard)
    EXPIRY_WARNING_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (env.NODE_ENV === "production") {
      if (env.STORAGE === "local") fail("STORAGE", "local file storage is not allowed in production; use s3");
      if (!env.KAFKA_BROKERS) fail("KAFKA_BROKERS", "required in production (driver.online/offline reach location-service through Kafka)");
      if (!env.REDIS_URL) fail("REDIS_URL", "required in production (suspended users and role changes must take effect at once)");
    }
    if (env.STORAGE === "s3" && !env.S3_BUCKET) fail("S3_BUCKET", "required when STORAGE=s3");
    const keys = [env.PII_ENCRYPTION_KEY, env.PII_BLIND_INDEX_KEY, env.UPLOAD_SIGNING_KEY].map((k) => k.toLowerCase());
    if (new Set(keys).size !== keys.length) fail("PII_BLIND_INDEX_KEY", "the three keys must all be different");
  });

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` (blank, as in .env.example) means "not set"
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  return envSchema.parse(set);
}
