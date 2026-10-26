import { createAuthzSync, fetchAuthzSnapshotFrom } from "@ride-app/shared-authz";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { createContainer } from "./container.js";
import { createConsumer } from "./events/consumer.js";
import { startExpiryJob } from "./jobs/expiry.js";
import { purgeIdempotencyKeys } from "./lib/idempotency.js";
import { createOutboxRelay } from "./outbox/relay.js";
import { serviceLogger } from "./utils/logger.js";

async function main() {
  const config = loadConfig();
  const logger = serviceLogger(config.NODE_ENV, config.LOG_LEVEL);
  const c = createContainer(config, logger);
  const app = await buildApp({ ...c, logger });

  if (config.STORAGE === "local") logger.warn(`STORAGE=local: documents are kept in ${config.STORAGE_DIR} (development only)`);
  if (!config.REDIS_URL) logger.warn("REDIS_URL not set: suspensions and role changes take effect when tokens expire (development only)");

  const relay = config.KAFKA_BROKERS ? createOutboxRelay(c.db, config.KAFKA_BROKERS, logger) : undefined;
  const consumer = config.KAFKA_BROKERS ? createConsumer({ brokers: config.KAFKA_BROKERS, fleet: c.fleet, logger }) : undefined;
  if (relay) relay.start();
  else logger.warn("KAFKA_BROKERS not set: driver.online/offline stay in the outbox table, so location-service won't see drivers go online");
  await consumer?.start().catch((err) => logger.error({ err }, "Kafka consumer failed to start; sessions won't end on connection loss"));

  await c.settingsClient?.start();
  const stopExpiry = startExpiryJob(c.fleet, logger);
  const daily = setInterval(() => void purgeIdempotencyKeys(c.db).catch((err) => logger.error({ err }, "idempotency purge failed")), 24 * 3600 * 1000);

  // the permission matrix follows auth-service live (Role.md §8)
  const authzSync = createAuthzSync({
    fetchSnapshot: fetchAuthzSnapshotFrom(config.AUTH_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN),
    ...(c.redis ? { redis: c.redis } : {}),
    logger,
  });
  await authzSync.start();

  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  let closing = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      logger.info(`${signal} received, shutting down`);
      await authzSync.stop();
      await c.settingsClient?.stop();
      stopExpiry();
      clearInterval(daily);
      await app.close();
      await consumer?.stop().catch(() => undefined);
      await relay?.stop();
      await c.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
