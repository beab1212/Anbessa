import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { IdentityService } from "../identity/service.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import type { RequirePrincipal } from "./principal.js";

const uuid = z.string().uuid();
const reason = z.string().trim().min(10).max(500);
const cityId = z.string().trim().min(1).max(64);

export function registerIdentityRoutes(
  app: FastifyInstance,
  deps: { identity: IdentityService; requirePrincipal: RequirePrincipal; internalToken?: string },
) {
  const { identity, requirePrincipal } = deps;
  const staff = (req: FastifyRequest) => requirePrincipal(req, "ride-admin");

  // Works for both surfaces: tells a client which roles its token carries.
  app.get("/api/identity/me", async (req) => {
    const audience = req.headers["x-auth-surface"] === "admin" ? "ride-admin" : "ride-app";
    return identity.me(await requirePrincipal(req, audience));
  });

  app.get("/api/identity/cities", async (req) => {
    await requirePrincipal(req, req.headers["x-auth-surface"] === "admin" ? "ride-admin" : "ride-app");
    return identity.listCities();
  });

  // ── call center ─────────────────────────────────────────────────────────────
  app.post("/api/identity/guests", async (req, reply) => {
    const body = z.object({ phoneNumber: z.string(), cityId }).parse(req.body);
    const result = await identity.createGuest(await staff(req), body);
    return reply.status(result.created ? 201 : 200).send(result);
  });

  // ── staff accounts and roles (maker–checker) ────────────────────────────────
  app.post("/api/identity/staff-accounts", async (req, reply) => {
    const body = z.object({ email: z.string().email(), name: z.string().trim().min(2).max(120) }).parse(req.body);
    return reply.status(201).header("cache-control", "no-store").send(await identity.createStaffAccount(await staff(req), body));
  });

  app.post("/api/identity/staff-role-requests", async (req, reply) => {
    const body = z.object({ userId: uuid, role: z.string(), cityId: cityId.optional(), reason }).parse(req.body);
    return reply.status(201).send(await identity.requestStaffRole(await staff(req), body));
  });

  app.get("/api/identity/staff-role-requests", async (req) => {
    const q = z.object({ status: z.enum(["PENDING", "EXECUTED", "REJECTED", "EXPIRED"]).optional() }).parse(req.query);
    return identity.listStaffRoleRequests(await staff(req), q.status);
  });

  app.post("/api/identity/staff-role-requests/:id/approve", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    return identity.approveStaffRole(await staff(req), id, body.reason);
  });

  app.post("/api/identity/staff-role-requests/:id/reject", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ reason }).parse(req.body);
    return identity.rejectStaffRole(await staff(req), id, body.reason);
  });

  app.post("/api/identity/staff-roles/revoke", async (req) => {
    const body = z.object({ userId: uuid, role: z.string(), cityId: cityId.optional(), reason }).parse(req.body);
    return identity.revokeStaffRole(await staff(req), body);
  });

  // ── safety ──────────────────────────────────────────────────────────────────
  app.post("/api/identity/users/:id/suspend", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ reason, cityId, until: z.coerce.date().optional() }).parse(req.body);
    return identity.suspendUser(await staff(req), id, body);
  });

  app.post("/api/identity/users/:id/reinstate", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ reason, cityId }).parse(req.body);
    return identity.reinstateUser(await staff(req), id, body);
  });

  // ── partner organisations ───────────────────────────────────────────────────
  app.post("/api/identity/organizations/:id/verify", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return identity.verifyOrganization(await staff(req), id);
  });

  app.post("/api/identity/organizations/:id/suspend", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ reason }).parse(req.body);
    return identity.suspendOrganization(await staff(req), id, body.reason);
  });

  // ── internal (service-to-service) ───────────────────────────────────────────
  // Interim shared-secret auth until mTLS workload identity (Auth.md §15). Never routed by Kong.
  const internal = (req: FastifyRequest) => {
    if (!deps.internalToken) throw forbidden("internal API disabled");
    const header = req.headers.authorization ?? "";
    const given = Buffer.from(header.replace(/^Bearer /i, ""));
    const expected = Buffer.from(deps.internalToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized("invalid service credentials");
    return String(req.headers["x-service-name"] ?? "unknown-service");
  };

  app.post("/internal/drivers/:userId/role", async (req) => {
    const service = internal(req);
    const { userId } = z.object({ userId: uuid }).parse(req.params);
    const body = z.object({ active: z.boolean() }).parse(req.body);
    return identity.setDriverRole(userId, body.active, service);
  });
}
