import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadEnv, nodeEnvSchema } from "../src/env.js";

describe("NODE_ENV", () => {
  it("is required, with no development default", () => {
    expect(() => nodeEnvSchema.parse(undefined)).toThrow(/NODE_ENV is required/);
    expect(() => nodeEnvSchema.parse("staging")).toThrow(/must be development, test or production/);
    expect(nodeEnvSchema.parse("production")).toBe("production");
  });

  it("loadEnv refuses an env without NODE_ENV even if the schema has a default", () => {
    const schema = z.object({ NODE_ENV: z.enum(["development", "production"]).default("development"), PORT: z.coerce.number().default(3000) });
    expect(() => loadEnv(schema, { PORT: "1" })).toThrow(/NODE_ENV is required/);
    expect(loadEnv(schema, { NODE_ENV: "production", PORT: "1" })).toEqual({ NODE_ENV: "production", PORT: 1 });
  });
});
