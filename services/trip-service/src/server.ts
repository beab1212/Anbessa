import { buildApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { createContainer } from "./container.js";
import { purgeIdempotencyKeys } from "./lib/idempotency.js";
import { createOutboxRelay } from "./outbox/relay.js";
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

  c.matcher.start();
  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  let closing = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      logger.info(`${signal} received, shutting down`);
      clearInterval(daily);
      c.matcher.stop();
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
