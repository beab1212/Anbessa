import { createAuthzSync, fetchAuthzSnapshotFrom } from "@ride-app/shared-authz";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { createContainer } from "./container.js";
import { createOutboxRelay } from "./outbox/relay.js";
import { serviceLogger } from "./utils/logger.js";

async function main() {
  const config = loadConfig();
  const logger = serviceLogger(config.NODE_ENV, config.LOG_LEVEL);
  const c = createContainer(config, logger);
  const app = await buildApp({ ...c, logger });

  // built-in cities and vehicle types on first start; auth-service learns every city (retried
  // every 30 s until auth-service answers, so start order doesn't matter)
  let seedTimer: NodeJS.Timeout | undefined;
  const seed = () =>
    c.catalog.seed().then(
      () => logger.info("cities synced with auth-service"),
      (err) => {
        logger.warn({ err: (err as Error).message }, "city sync with auth-service failed; retrying in 30 s");
        seedTimer = setTimeout(() => void seed(), 30_000);
      },
    );
  await seed();
  if (!config.REDIS_URL) logger.warn("REDIS_URL not set: services pick up settings changes on their next poll (≤ 30 s)");

  const relay = config.KAFKA_BROKERS ? createOutboxRelay(c.db, config.KAFKA_BROKERS, logger) : undefined;
  if (relay) relay.start();
  else logger.warn("KAFKA_BROKERS not set: audit events stay in the outbox table");

  const hourly = setInterval(() => void c.settings.expire().catch((err) => logger.error({ err }, "settings approval expiry failed")), 3_600_000);

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
      clearTimeout(seedTimer);
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
