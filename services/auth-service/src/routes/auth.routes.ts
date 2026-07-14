import type { FastifyInstance } from "fastify";
import { authController } from "../controllers/auth.controller.js";

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", authController.register);
  app.post("/auth/login", authController.login);
  // /auth/refresh and /auth/logout follow the same controller -> service -> repository shape
}
