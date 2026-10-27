import { createAuthzSync, fetchAuthzSnapshotFrom } from "@ride-app/shared-authz";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { createContainer } from "./container.js";
import { purgeIdempotencyKeys } from "./lib/idempotency.js";
import { createOutboxRelay } from "./outbox/relay.js";
import { createConsumer, createHandlers } from "./events/consumer.js";
import { serviceLogger } from "./utils/logger.js";

async function main() {
  const config = loadConfig();
  const logger = serviceLogger(config.NODE_ENV, config.LOG_LEVEL);
  const c = createContainer(config, logger);
  const app = await buildApp({ ...c, logger });

  if (config.PRICING === "builtin") logger.warn("PRICING=builtin: quotes come from the development stand-in (POST /api/trips/estimates)");

  // monthly trip_event partitions, created ahead (Database.md §15)
  const ensurePartitions = () => c.db.$executeRaw`SELECT ensure_trip_event_partitions(2)`.catch((err) => logger.error({ err }, "partition maintenance failed"));
  await ensurePartitions();
  const daily = setInterval(() => {
    void ensurePartitions();
    void purgeIdempotencyKeys(c.db).catch((err) => logger.error({ err }, "idempotency purge failed"));
  }, 24 * 3600 * 1000);

  const relay = config.KAFKA_BROKERS ? createOutboxRelay(c.db, config.KAFKA_BROKERS, logger) : undefined;
  if (relay) relay.start();
  else logger.warn("KAFKA_BROKERS not set: trip events stay in the outbox table until a relay runs");

  // driver.location → GPS traces, incident.opened → the regulatory report
  const consumer = config.KAFKA_BROKERS
    ? createConsumer({ brokers: config.KAFKA_BROKERS, handlers: createHandlers({ trace: c.traceRecorder, regulatory: c.regulatory }), logger })
    : undefined;
  if (consumer) {
    // a broker that isn't up yet must not stop the HTTP API
    void consumer.start().catch((err) => logger.error({ err }, "event consumer failed to start: GPS traces and incident counts are not recorded"));
  } else logger.warn("KAFKA_BROKERS not set: GPS traces and incident counts are not recorded");

  await c.settingsClient?.start();
  c.matcher.start();
  // scheduled rides: due bookings become trips (every replica; claims use SKIP LOCKED)
  c.scheduler.start(config.SCHEDULE_TICK_SECONDS * 1000);
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
      clearInterval(daily);
      c.matcher.stop();
      c.scheduler.stop();
      await consumer?.stop().catch(() => undefined);
      await app.close();
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
