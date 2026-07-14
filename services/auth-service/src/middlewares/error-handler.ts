import type { FastifyInstance, FastifyError } from "fastify";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | AppError, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: "internal_error", message: "Something went wrong" });
  });
}
