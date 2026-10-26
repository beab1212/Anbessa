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

  const relay = config.KAFKA_BROKERS?.length ? createOutboxRelay(c.db, config.KAFKA_BROKERS, logger) : undefined;
  if (relay) await relay.start();
  else logger.warn("KAFKA_BROKERS not set: identity events stay in the outbox table until a relay runs");
  if (config.OTP_DELIVERY === "console") logger.warn("OTP_DELIVERY=console: OTP codes are logged (development only)");
  if (config.DEV_LOGIN === "on") logger.warn("DEV_LOGIN=on: /api/dev/* hands out sign-in codes for the seed:dev accounts (development only)");

  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  // Graceful shutdown so in-flight requests finish and DB/Kafka connections close cleanly.
  let closing = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      logger.info(`${signal} received, shutting down`);
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
