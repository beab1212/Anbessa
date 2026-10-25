import type { FastifyRequest, FastifyReply } from "fastify";
import { authService } from "../services/auth.service.js";

export const authController = {
  async register(req: FastifyRequest, reply: FastifyReply) {
    const user = await authService.register(req.body as Parameters<typeof authService.register>[0]);
    return reply.status(201).send({ id: user.id, email: user.email, role: user.role });
  },

  async login(req: FastifyRequest, reply: FastifyReply) {
    const { email, password } = req.body as { email: string; password: string };
    const result = await authService.login(email, password);
    return reply.send({ accessToken: result.accessToken, user: { id: result.user.id, role: result.user.role } });
  },
};
