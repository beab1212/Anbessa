import { buildApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { createContainer } from "./container.js";
import { createEventConsumer } from "./notify/consumer.js";
import { serviceLogger } from "./utils/logger.js";

async function main() {
  const config = loadConfig();
  const logger = serviceLogger(config.NODE_ENV, config.LOG_LEVEL);
  const c = createContainer(config, logger);
  const app = await buildApp({ ...c, logger });

  if (!config.TELEGRAM_GATEWAY_TOKEN) logger.warn("TELEGRAM_GATEWAY_TOKEN not set: login codes go by SMS only");
  if (config.SMS_PROVIDER === "console") logger.warn("SMS_PROVIDER=console: SMS (including login codes) is logged (development only)");

  // SMS fallback schedule (Redis) and 30-day retention of delivery rows
  const fallbackTimer = setInterval(() => void c.otp.pollFallbacks().catch((err) => logger.error({ err }, "fallback poll failed")), 1000);
  const purgeTimer = setInterval(() => void c.otp.purgeOld().catch((err) => logger.error({ err }, "purge failed")), 60 * 60 * 1000);

  const consumer = config.KAFKA_BROKERS
    ? createEventConsumer({ brokers: config.KAFKA_BROKERS, handlers: c.handlers, logger, createTopics: config.NODE_ENV !== "production" })
    : undefined;
  if (consumer) await consumer.start();
  else logger.warn("KAFKA_BROKERS not set: event notifications are disabled");

  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  // Graceful shutdown so in-flight requests finish and connections close cleanly.
  let closing = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      logger.info(`${signal} received, shutting down`);
      clearInterval(fallbackTimer);
      clearInterval(purgeTimer);
      await app.close();
      await consumer?.stop();
      await c.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
