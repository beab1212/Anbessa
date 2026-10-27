import { createAuthzSync, fetchAuthzSnapshotFrom } from "@ride-app/shared-authz";
import { buildApp } from "./app.js";
import { CATALOG_CHANNEL } from "./catalog.js";
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
  const app = await buildApp({
    ...c, logger,
    // quotes need Redis; rules, zones and promos need Postgres
    ready: async () => (await c.redis.ping()) === "PONG" && (await c.db.$queryRaw`SELECT 1`.then(() => true)),
  });

  await c.settingsClient?.start();
  await c.catalog.refresh(true).catch((err) => logger.error({ err }, "pricing catalog not loaded yet; quotes answer 503 until Postgres is reachable"));

  // other replicas changed a rule or a zone
  const sub = c.redis.duplicate();
  await sub.subscribe(CATALOG_CHANNEL).catch((err) => logger.warn({ err }, "catalog changes not subscribed; reloads every 60 s"));
  sub.on("message", (channel) => {
    if (channel === CATALOG_CHANNEL) c.catalog.invalidate();
  });

  const relay = config.KAFKA_BROKERS ? createOutboxRelay(c.db, config.KAFKA_BROKERS, logger) : undefined;
  if (relay) relay.start();
  else logger.warn("KAFKA_BROKERS not set: pricing.*, promo.* and audit events stay in the outbox table");
  const consumer = config.KAFKA_BROKERS ? createConsumer({ brokers: config.KAFKA_BROKERS, promos: c.promos, logger, createTopics: config.NODE_ENV !== "production" }) : undefined;
  if (consumer) await consumer.start().catch((err) => logger.error({ err }, "Kafka consumer failed to start; promo redemptions wait in Kafka"));

  // every 30 s: undecided fare changes expire, scheduled rules activate, promos and reservations expire
  const sweep = async () => {
    try {
      const r = await c.rules.sweep();
      const p = await c.promos.sweep();
      if (r.expired || r.activated || p.promosExpired || p.reservationsExpired) logger.info({ ...r, ...p }, "sweep");
    } catch (err) {
      logger.error({ err }, "sweep failed");
    }
  };
  await sweep();
  const sweeper = setInterval(() => void sweep(), 30_000);
  const purger = setInterval(() => void purgeIdempotencyKeys(c.db, c.now()).catch((err) => logger.error({ err }, "idempotency purge failed")), 3_600_000);

  // the permission matrix follows auth-service live (Role.md §8)
  const authzSync = createAuthzSync({
    fetchSnapshot: fetchAuthzSnapshotFrom(config.AUTH_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN),
    redis: c.redis,
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
      clearInterval(sweeper);
      clearInterval(purger);
      await app.close();
      await consumer?.stop().catch(() => undefined);
      await relay?.stop();
      sub.disconnect();
      await c.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
