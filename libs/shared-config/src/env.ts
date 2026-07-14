import { z, type ZodSchema } from "zod";

// Reusable helper so every service validates its env the same way and fails
// fast on boot instead of throwing a confusing error on the first request.
export function loadEnv<T extends ZodSchema>(schema: T): z.infer<T> {
  return schema.parse(process.env);
}
