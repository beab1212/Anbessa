import { existsSync } from "node:fs";
import { z, type ZodSchema } from "zod";

export const NODE_ENVS = ["development", "test", "production"] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

/**
 * NODE_ENV with no default. A missing NODE_ENV used to mean "development" (dev logins, console
 * SMS, plaintext Kafka allowed), so a production pod that lost its env silently ran in dev mode.
 * Now it fails at boot: images set NODE_ENV=production, .env.example sets development, and
 * vitest sets test.
 */
export const nodeEnvSchema = z.enum(NODE_ENVS, {
  error: (issue) => (issue.input === undefined
    ? "NODE_ENV is required (development, test or production); it no longer defaults to development"
    : "NODE_ENV must be development, test or production"),
});

// Reusable helper so every service validates its env the same way and fails
// fast on boot instead of throwing a confusing error on the first request.
// NODE_ENV is always required, whatever the schema says.
export function loadEnv<T extends ZodSchema>(schema: T, env: NodeJS.ProcessEnv = process.env): z.infer<T> {
  nodeEnvSchema.parse(env.NODE_ENV);
  return schema.parse(env);
}

// A path that must point at an existing file (key material, certs). Checked at
// boot so a missing file names the env var and the fix, instead of an ENOENT
// stack trace from deep inside a module.
export function existingFile(hint: string) {
  return z.string().refine((path) => existsSync(path), { message: `file not found. ${hint}` });
}
