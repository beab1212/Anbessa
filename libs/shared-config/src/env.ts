import { existsSync } from "node:fs";
import { z, type ZodSchema } from "zod";

// Reusable helper so every service validates its env the same way and fails
// fast on boot instead of throwing a confusing error on the first request.
export function loadEnv<T extends ZodSchema>(schema: T): z.infer<T> {
  return schema.parse(process.env);
}

// A path that must point at an existing file (key material, certs). Checked at
// boot so a missing file names the env var and the fix, instead of an ENOENT
// stack trace from deep inside a module.
export function existingFile(hint: string) {
  return z.string().refine((path) => existsSync(path), { message: `file not found. ${hint}` });
}
