import Fastify, { type FastifyServerOptions } from "fastify";
import helmet from "@fastify/helmet";
import type { VerifyAccessToken } from "@ride-app/shared-authz";
import { registerRoutes } from "./http/routes.js";
import type { Maps } from "./maps.js";
import { registerErrorHandler } from "./middlewares/error-handler.js";
import { trustProxyFromEnv } from "@ride-app/shared-utils";

export interface AppDeps {
  maps: Maps;
  internalToken: string;
  verifyAccessToken: VerifyAccessToken;
  /** readiness: the engines this instance depends on */
  engineStatus: () => { osrm: "ok" | "degraded"; nominatim: "ok" | "degraded" };
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

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/health/live", async () => ({ status: "ok" }));
  // stays ready while an engine is down: routes fall back to estimates, so callers still get answers
  app.get("/health/ready", async () => ({ status: "ok", engines: deps.engineStatus() }));

  await registerRoutes(app, deps);
  return app;
}
