import Fastify, { type FastifyServerOptions } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { registerRoutes, type RouteDeps } from "./http/routes.js";
import { registerErrorHandler } from "./middlewares/error-handler.js";

export interface AppDeps extends RouteDeps {
  logger?: FastifyServerOptions["loggerInstance"];
  /** readiness: quotes can't be stored without Redis */
  ready: () => Promise<boolean>;
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    ...(deps.logger ? { loggerInstance: deps.logger } : { logger: false }),
    trustProxy: true,
    bodyLimit: 16 * 1024,
  });

  // error handling first, so every route below uses it
  registerErrorHandler(app);
  await app.register(helmet);
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_req, reply) => {
    if (await deps.ready().catch(() => false)) return { status: "ok" };
    return reply.status(503).send({ status: "unavailable" });
  });

  await registerRoutes(app, deps);
  return app;
}
