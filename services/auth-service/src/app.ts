import Fastify from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { authRoutes } from "./routes/auth.routes.js";
import { registerErrorHandler } from "./middlewares/error-handler.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(helmet);
  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });

  app.get("/health", async () => ({ status: "ok" }));
  await app.register(authRoutes);

  registerErrorHandler(app);
  return app;
}
