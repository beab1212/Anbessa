import { createAuthzSync, fetchAuthzSnapshotFrom } from "@ride-app/shared-authz";
import { Redis } from "ioredis";
import { createTokenVerifier } from "@ride-app/shared-authz";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { createHandlers } from "./events/handlers.js";
import { createKafka } from "./events/kafka.js";
import { mappingClient } from "./lib/mapping.js";
import { createLocations } from "./locations.js";
import { createSweeper } from "./sweeper.js";
import { serviceLogger } from "./utils/logger.js";

async function main() {
  const config = loadConfig();
  const logger = serviceLogger(config.NODE_ENV, config.LOG_LEVEL);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });
  const locations = createLocations({ redis, mapping: mappingClient(config.MAPPING_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN), logger });

  const kafka = config.KAFKA_BROKERS
    ? createKafka({ brokers: config.KAFKA_BROKERS, handlers: createHandlers(redis), logger, createTopics: config.NODE_ENV !== "production" })
    : undefined;
  if (kafka) await kafka.start();
  else logger.warn("KAFKA_BROKERS not set: driver/trip events are not consumed (use the dev routes to put drivers online)");

  const sweeper = createSweeper({
    redis, logger, intervalMs: config.SWEEP_INTERVAL_MS,
    onLost: kafka ? (driverId, cityId, lastSeenAt) => kafka.connectionLost({ driverId, cityId, lastSeenAt: lastSeenAt.toISOString() }) : undefined,
  });
  sweeper.start();

  const app = await buildApp({
    locations, redis, logger,
    internalToken: config.INTERNAL_SERVICE_TOKEN,
    verifyAccessToken: createTokenVerifier({ issuer: config.AUTH_ISSUER, jwksUrl: config.AUTH_JWKS_URL }),
    devRoutes: config.NODE_ENV === "development",
  });
  // the permission matrix follows auth-service live (Role.md §8)
  const authzSync = createAuthzSync({
    fetchSnapshot: fetchAuthzSnapshotFrom(config.AUTH_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN),
    ...(redis ? { redis: redis } : {}),
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
      sweeper.stop();
      await app.close();
      await kafka?.stop();
      redis.disconnect();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
