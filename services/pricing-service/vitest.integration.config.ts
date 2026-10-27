import { defineConfig } from "vitest/config";

// Integration tests run against a real Postgres (a throwaway `pricing_service_test` database,
// recreated on every run; start infra first: `make infra-up`) and this suite's own Redis container
// on port 6398 (Docker). mapping- and location-service are fakes; Kafka is not needed (events are
// read from the outbox, trip events are handed to the consumer's handler).
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
