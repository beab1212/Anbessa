import { z } from "zod";

export const config = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  REDIS_URL: z.string().url(),
  // driver.location stream; optional locally (pings still update Redis)
  KAFKA_BROKERS: z.string().optional(),
  // Access tokens are verified locally against auth-service's public keys (Auth.md §10)
  AUTH_ISSUER: z.string().url().default("http://localhost:3001"),
  AUTH_JWKS_URL: z.string().url().default("http://localhost:3001/api/auth/jwks"),
}).parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== "")));
