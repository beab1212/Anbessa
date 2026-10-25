import { z } from "zod";
import { existingFile } from "@ride-app/shared-config";

const keyHint = "Run `make secrets` from the repo root to create local dev JWT keys.";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().url(),
  JWT_PRIVATE_KEY_PATH: existingFile(keyHint),
  JWT_PUBLIC_KEY_PATH: existingFile(keyHint),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("30d"),
  KAFKA_BROKERS: z.string(),
});

// Fail fast on boot if config is invalid rather than at first request.
export const config = envSchema.parse(process.env);
