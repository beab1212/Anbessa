import { defineConfig } from "vitest/config";

// Integration tests run against a real Postgres (a throwaway `fleet_service_test` database,
// recreated on every run; start infra first: `make infra-up`). Files go to a temporary
// directory through the local storage driver; auth-service is a fake the tests control.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
