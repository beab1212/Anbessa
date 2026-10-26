import { createAuthzSync, fetchAuthzSnapshotFrom } from "@ride-app/shared-authz";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { createContainer } from "./container.js";
import { createConsumer } from "./events/consumer.js";
import { serviceLogger } from "./utils/logger.js";

async function main() {
  const config = loadConfig();
  const logger = serviceLogger(config.NODE_ENV, config.LOG_LEVEL);
  const c = createContainer(config);
  const app = await buildApp({ ...c, logger });

  // monthly partitions, created ahead (Database.md: audit_entry partitioned by month)
  const ensurePartitions = () => c.db.$executeRaw`SELECT ensure_audit_partitions(2)`.catch((err) => logger.error({ err }, "partition maintenance failed"));
  await ensurePartitions();
  const daily = setInterval(() => void ensurePartitions(), 24 * 3600 * 1000);

  const consumer = config.KAFKA_BROKERS ? createConsumer({ brokers: config.KAFKA_BROKERS, store: c.store, logger, createTopics: config.NODE_ENV !== "production" }) : undefined;
  if (consumer) await consumer.start().catch((err) => logger.error({ err }, "Kafka consumer failed to start; audit events wait in Kafka"));
  else logger.warn("KAFKA_BROKERS not set: no audit events arrive");

  // the permission matrix follows auth-service live (Role.md §8)
  const authzSync = createAuthzSync({ fetchSnapshot: fetchAuthzSnapshotFrom(config.AUTH_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN), ...(c.redis ? { redis: c.redis } : {}), logger });
  await authzSync.start();

  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  let closing = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      logger.info(`${signal} received, shutting down`);
      await authzSync.stop();
      clearInterval(daily);
      await app.close();
      await consumer?.stop().catch(() => undefined);
      await c.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
