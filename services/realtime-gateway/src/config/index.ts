import { z } from "zod";

export const config = z.object({
  PORT: z.coerce.number().default(3000),
  REDIS_URL: z.string().url(),
  KAFKA_BROKERS: z.string(),
  JWT_PUBLIC_KEY_PATH: z.string(),
}).parse(process.env);
