import { createAuthzSync, fetchAuthzSnapshotFrom } from "@ride-app/shared-authz";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { createContainer } from "./container.js";
import { serviceLogger } from "./utils/logger.js";

async function main() {
  const config = loadConfig();
  const logger = serviceLogger(config.NODE_ENV, config.LOG_LEVEL);
  const c = createContainer(config, logger);
  const app = await buildApp({ ...c, logger, ready: async () => (await c.redis.ping()) === "PONG" });

  await c.settingsClient?.start();
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
      await app.close();
      await c.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
