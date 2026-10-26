import Fastify, { type FastifyServerOptions } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { Config } from "./config/index.js";
import type { Db } from "./db.js";
import type { AdminAuth, AppAuth } from "./auth/instances.js";
import { mountBetterAuth } from "./http/better-auth.routes.js";
import { registerDevRoutes } from "./http/dev.routes.js";
import { registerIdentityRoutes } from "./http/identity.routes.js";
import type { RequirePrincipal } from "./http/principal.js";
import type { IdentityService } from "./identity/service.js";
import type { OtpInbox } from "./dev/accounts.js";
import { registerErrorHandler } from "./middlewares/error-handler.js";

export interface AppDeps {
  config: Config;
  db: Db;
  appAuth: AppAuth;
  adminAuth: AdminAuth;
  identity: IdentityService;
  requirePrincipal: RequirePrincipal;
  /** Set only when DEV_LOGIN=on (refused in production). */
  devInbox?: OtpInbox;
  logger?: FastifyServerOptions["loggerInstance"];
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    ...(deps.logger ? { loggerInstance: deps.logger } : { logger: false }),
    trustProxy: true, // behind Kong / the load balancer
    bodyLimit: 64 * 1024,
  });

  // error handling first, so every route below uses it
  registerErrorHandler(app);

  await app.register(helmet);
  await app.register(cors, {
    origin: [...deps.config.APP_TRUSTED_ORIGINS, ...deps.config.ADMIN_TRUSTED_ORIGINS],
    credentials: true,
  });
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

  mountBetterAuth(app, deps.appAuth, { prefix: "/api/auth", surface: "app", db: deps.db });
  mountBetterAuth(app, deps.adminAuth, { prefix: "/api/admin-auth", surface: "admin", db: deps.db });
  registerIdentityRoutes(app, {
    identity: deps.identity,
    requirePrincipal: deps.requirePrincipal,
    internalToken: deps.config.INTERNAL_SERVICE_TOKEN,
  });
  if (deps.config.DEV_LOGIN === "on" && deps.devInbox) registerDevRoutes(app, { db: deps.db, inbox: deps.devInbox });

  return app;
}
