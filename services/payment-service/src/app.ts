import Fastify, { type FastifyServerOptions } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { registerRoutes, type RouteDeps } from "./http/routes.js";
import { registerErrorHandler } from "./middlewares/error-handler.js";
import { trustProxyFromEnv } from "@ride-app/shared-utils";

export interface AppDeps extends RouteDeps {
  logger?: FastifyServerOptions["loggerInstance"];
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    ...(deps.logger ? { loggerInstance: deps.logger } : { logger: false }),
    trustProxy: trustProxyFromEnv(), // TRUST_PROXY: hop count (default 1 = Kong) or proxy CIDRs; never `true`
    bodyLimit: 32 * 1024,
  });

  // error handling first, so every route below uses it
  registerErrorHandler(app);
  await app.register(helmet);
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_req, reply) => {
    try {
      await deps.db.$queryRaw`SELECT 1`;
      return { status: "ok", gateways: deps.gateways.list().map((g) => ({ provider: g.provider, mode: g.mode })) };
    } catch {
      return reply.status(503).send({ status: "unavailable" });
    }
  });

  await registerRoutes(app, deps);
  return app;
}
