import { defineConfig } from "vitest/config";

// Integration tests run against a real Redis: a throwaway container on port 6392,
// started by the global setup (needs Docker). Nothing else is required.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
