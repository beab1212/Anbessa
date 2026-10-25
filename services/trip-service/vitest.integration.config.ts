import { defineConfig } from "vitest/config";

// Integration tests run against a real Postgres (a throwaway `trip_service_test` database,
// recreated on every run; start infra first: `make infra-up`) and a throwaway Redis
// container on port 6394 started by the global setup (needs Docker).
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
