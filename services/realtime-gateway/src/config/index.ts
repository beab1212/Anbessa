import { z } from "zod";
import { existingFile } from "@ride-app/shared-config";

const keyHint = "Run `make secrets` from the repo root to create local dev JWT keys.";

export const config = z.object({
  PORT: z.coerce.number().default(3000),
  REDIS_URL: z.string().url(),
  KAFKA_BROKERS: z.string(),
  JWT_PUBLIC_KEY_PATH: existingFile(keyHint),
}).parse(process.env);
