import { z } from "zod";

export const config = z.object({
  // no default: an unset NODE_ENV must not quietly turn on development behaviour
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().default(3000),
  REDIS_URL: z.string().url(),
  // driver.location stream; optional locally (pings still update Redis)
  KAFKA_BROKERS: z.string().optional(),
  // Access tokens are verified locally against auth-service's public keys (Auth.md §10)
  AUTH_ISSUER: z.string().url().default("http://localhost:3001"),
  AUTH_JWKS_URL: z.string().url().default("http://localhost:3001/api/auth/jwks"),
  // the live permission matrix (GET /internal/authz/snapshot); without the token the built-in matrix applies
  AUTH_INTERNAL_URL: z.string().url().default("http://localhost:3001"),
  INTERNAL_SERVICE_TOKEN: z.string().min(32).optional(),
}).parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== "")));
