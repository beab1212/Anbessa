import { buildApp } from "./app.js";
import { config } from "./config/index.js";
import { logger } from "./utils/logger.js";

async function main() {
  const app = await buildApp();

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  logger.info(`auth-service listening on :${config.PORT}`);

  // Graceful shutdown so in-flight requests finish and DB/Kafka connections close cleanly.
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, async () => {
      logger.info(`${signal} received, shutting down`);
      await app.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
