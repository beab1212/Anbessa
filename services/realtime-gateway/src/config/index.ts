import { z } from "zod";

export const config = z.object({
  PORT: z.coerce.number().default(3000),
  REDIS_URL: z.string().url(),
  KAFKA_BROKERS: z.string(),
  // Access tokens are verified locally against auth-service's public keys (Auth.md §10)
  AUTH_ISSUER: z.string().url().default("http://localhost:3001"),
  AUTH_JWKS_URL: z.string().url().default("http://localhost:3001/api/auth/jwks"),
}).parse(process.env);
