import Fastify, { type FastifyServerOptions } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { registerRoutes, type RouteDeps } from "./http/routes.js";
import { registerErrorHandler } from "./middlewares/error-handler.js";

export interface AppDeps extends RouteDeps {
  logger?: FastifyServerOptions["loggerInstance"];
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    ...(deps.logger ? { loggerInstance: deps.logger } : { logger: false }),
    trustProxy: true,
    bodyLimit: 32 * 1024, // uploads (local storage) set their own 10 MB limit
    maxParamLength: 1024, // signed file links in /api/fleet/files/:ticket
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
