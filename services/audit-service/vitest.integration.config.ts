import { defineConfig } from "vitest/config";

// Integration tests run against a real Postgres (a throwaway `audit_service_test` database,
// recreated on every run; start infra first: `make infra-up`). Kafka is not needed: tests call the consumer handler.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
