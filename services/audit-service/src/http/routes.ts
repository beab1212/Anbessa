// audit-service HTTP API under /api/audit: read only (there is no update or delete route).

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { bearerToken, type Principal, type VerifyAccessToken } from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import { unauthorized } from "../lib/errors.js";
import type { AuditStore } from "../store.js";

export interface RouteDeps {
  db: Db;
  store: AuditStore;
  verifyAccessToken: VerifyAccessToken;
}

const filters = z.object({
  actorId: z.string().uuid().optional(),
  action: z.string().max(80).optional(),
  resourceType: z.string().max(60).optional(),
  resourceId: z.string().max(200).optional(),
  outcome: z.enum(["ALLOWED", "DENIED", "PENDING_APPROVAL", "EXECUTED"]).optional(),
  service: z.string().max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  async function staff(req: FastifyRequest): Promise<Principal> {
    const token = bearerToken(req.headers.authorization);
    if (!token) throw unauthorized();
    return deps.verifyAccessToken(token, "ride-admin");
  }

  app.get("/api/audit/entries", async (req, reply) => {
    const q = filters.extend({ cursor: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return reply.header("cache-control", "no-store").send(await deps.store.search(await staff(req), q));
  });

  app.get("/api/audit/entries.csv", async (req, reply) => {
    const csv = await deps.store.exportCsv(await staff(req), filters.parse(req.query));
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`)
      .header("cache-control", "no-store")
      .send(csv);
  });
}
