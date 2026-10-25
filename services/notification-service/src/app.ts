import Fastify, { type FastifyServerOptions } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Db } from "./db.js";
import { registerRoutes, type RouteDeps } from "./http/routes.js";
import { registerErrorHandler } from "./middlewares/error-handler.js";

export interface AppDeps extends RouteDeps {
  db: Db;
  logger?: FastifyServerOptions["loggerInstance"];
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    ...(deps.logger ? { loggerInstance: deps.logger } : { logger: false }),
    trustProxy: true, // behind Kong / the load balancer
    bodyLimit: 16 * 1024,
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
      return { status: "ok" };
    } catch {
      return reply.status(503).send({ status: "unavailable" });
    }
  });

  await registerRoutes(app, deps);
  return app;
}
