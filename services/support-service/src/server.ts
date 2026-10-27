import { createAuthzSync, fetchAuthzSnapshotFrom } from "@ride-app/shared-authz";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { createContainer } from "./container.js";
import { createConsumer } from "./events/consumer.js";
import { purgeIdempotencyKeys } from "./lib/idempotency.js";
import { createOutboxRelay } from "./outbox/relay.js";
import { serviceLogger } from "./utils/logger.js";

async function main() {
  const config = loadConfig();
  const logger = serviceLogger(config.NODE_ENV, config.LOG_LEVEL);
  const c = createContainer(config, logger);
  const app = await buildApp({ ...c, logger });

  const relay = config.KAFKA_BROKERS ? createOutboxRelay(c.db, config.KAFKA_BROKERS, logger) : undefined;
  if (relay) relay.start();
  else logger.warn("KAFKA_BROKERS not set: sos.*, ticket.*, incident.* and audit events stay in the outbox table");

  const consumer = config.KAFKA_BROKERS ? createConsumer({ brokers: config.KAFKA_BROKERS, tickets: c.tickets, logger, createTopics: config.NODE_ENV !== "production" }) : undefined;
  if (consumer) await consumer.start().catch((err) => logger.error({ err }, "Kafka consumer failed to start; refund outcomes wait in Kafka"));
  if (!config.REDIS_URL) logger.warn("REDIS_URL not set: suspended users aren't refused until their token expires, and no pushes reach the app");

  // timers: tickets waiting 72 h → resolved, resolved 7 days → closed, lost items not found in 48 h → closed
  const sweep = async () => {
    try {
      const t = await c.tickets.sweep();
      const l = await c.lostItems.sweep();
      const purged = await purgeIdempotencyKeys(c.db, c.now());
      if (t.resolved || t.closed || l.closed || purged) logger.info({ ...t, lostItemsClosed: l.closed, idempotencyKeysPurged: purged }, "sweep");
    } catch (err) {
      logger.error({ err }, "sweep failed");
    }
  };
  await sweep();
  const hourly = setInterval(() => void sweep(), 3_600_000);

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
      clearInterval(hourly);
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
