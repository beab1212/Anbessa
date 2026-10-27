import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AuthorizationError, TokenCheckUnavailable, TokenError } from "@ride-app/shared-authz";
import { AppError } from "@ride-app/shared-utils";

// Registered before any route, so every route uses it. Internal details never
// reach the client; they're logged with the request id.
export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    if (err instanceof AuthorizationError) return reply.status(403).send({ error: "forbidden", message: err.message });
    if (err instanceof TokenError) return reply.status(401).send({ error: err.code, message: err.message });
    if (err instanceof TokenCheckUnavailable) {
      req.log.warn({ err: err.cause }, "token check unavailable (Redis)");
      return reply.status(503).header("retry-after", "5").send({ error: err.code, message: err.message });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: "validation_error",
        message: "invalid request",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: (err as FastifyError).code ?? "bad_request", message: err.message });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: "internal_error", message: "Something went wrong" });
  });

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: "not_found", message: "Not found" }));
}
