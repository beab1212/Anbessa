import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { IdentityService } from "../identity/service.js";
import type { AuthzService } from "../authz/service.js";
import type { Db } from "../db.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import type { RequirePrincipal } from "./principal.js";

const uuid = z.string().uuid();
const reason = z.string().trim().min(10).max(500);
const cityId = z.string().trim().min(1).max(64);
const APPROVAL_STATUSES = ["PENDING", "EXECUTED", "REJECTED", "EXPIRED", "CANCELLED", "FAILED"] as const;

export function registerIdentityRoutes(
  app: FastifyInstance,
  deps: { identity: IdentityService; authz: AuthzService; db: Db; requirePrincipal: RequirePrincipal; internalToken?: string },
) {
  const { identity, authz, requirePrincipal } = deps;
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
    const q = z.object({ status: z.enum(APPROVAL_STATUSES).optional() }).parse(req.query);
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

  // ── approvals inbox (every action) ─────────────────────────────────────────
  app.get("/api/identity/approvals", async (req) => {
    const q = z.object({ status: z.enum(APPROVAL_STATUSES).optional(), action: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
    return { approvals: await identity.approvals.list(await staff(req), q) };
  });
  app.post("/api/identity/approvals/:id/approve", async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    // an approved MFA reset answers with the temporary password: never cached
    return reply.header("cache-control", "no-store").send(await identity.approvals.approve(await staff(req), id, body.reason));
  });
  app.post("/api/identity/approvals/:id/reject", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return identity.approvals.reject(await staff(req), id, z.object({ reason }).parse(req.body).reason);
  });
  app.post("/api/identity/approvals/:id/cancel", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return identity.approvals.cancel(await staff(req), id);
  });

  // ── the permission matrix (Role.md §8) ────────────────────────────────────
  // Any signed-in user may read it: the web app decides what to show with it (services check again).
  app.get("/api/identity/authz", async (req) => {
    // either surface's token (the partner portal reads it too)
    await requirePrincipal(req, "ride-admin").catch(() => requirePrincipal(req, "ride-app"));
    return authz.snapshot();
  });
  const change = z.object({
    roleCode: z.string().max(60).optional(),
    create: z.object({ label: z.string().trim().min(3).max(60), description: z.string().trim().max(300).optional(), storage: z.enum(["city", "global"]) }).optional(),
    set: z.array(z.object({ permission: z.string().max(60), scope: z.enum(["S", "O", "C", "G"]).nullable() })).max(150).default([]),
    label: z.string().trim().min(3).max(60).optional(),
    description: z.string().trim().max(300).optional(),
    archive: z.boolean().optional(),
  });
  app.post("/api/identity/authz/changes", async (req, reply) => {
    const body = change.extend({ reason }).parse(req.body);
    return reply.status(201).send(await authz.propose(identity.approvals, await staff(req), body));
  });
  app.post("/api/identity/authz/preview", async (req) => {
    const body = change.extend({ roleCode: z.string().max(60) }).parse(req.body);
    return authz.preview(await staff(req), body);
  });

  // ── directory: users, staff, sessions ──────────────────────────────────────
  app.get("/api/identity/users", async (req) => {
    const q = z.object({
      q: z.string().trim().max(80).optional(),
      kind: z.enum(["staff", "rider", "driver", "partner", "guest"]).optional(),
      status: z.enum(["active", "suspended"]).optional(),
      cursor: uuid.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query);
    return identity.listUsers(await staff(req), q);
  });
  app.get("/api/identity/users/:id", async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return reply.header("cache-control", "no-store").send(await identity.getUser(await staff(req), id));
  });
  app.post("/api/identity/users/:id/sessions/revoke", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return identity.revokeSessions(await staff(req), id, z.object({ reason }).parse(req.body).reason);
  });
  app.post("/api/identity/users/:id/reset-mfa", async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return reply.header("cache-control", "no-store").send(await identity.resetMfa(await staff(req), id, z.object({ reason }).parse(req.body).reason));
  });
  app.get("/api/identity/stats", async (req) => {
    const q = z.object({ cityId: cityId.optional() }).parse(req.query);
    return identity.stats(await staff(req), q.cityId);
  });

  // ── safety ──────────────────────────────────────────────────────────────────
  app.post("/api/identity/users/:id/suspend", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    // cityId is still accepted from older clients but ignored: the scope comes from the user's own data
    const body = z.object({ reason, cityId: cityId.optional(), until: z.coerce.date().optional() }).parse(req.body);
    return identity.suspendUser(await staff(req), id, { reason: body.reason, until: body.until });
  });

  app.post("/api/identity/users/:id/reinstate", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ reason, cityId: cityId.optional() }).parse(req.body);
    return identity.reinstateUser(await staff(req), id, { reason: body.reason });
  });

  // ── partner organisations ───────────────────────────────────────────────────
  app.get("/api/identity/organizations", async (req) => {
    const q = z.object({ cityId: cityId.optional(), status: z.enum(["PENDING", "VERIFIED", "SUSPENDED"]).optional() }).parse(req.query);
    return identity.listOrganizations(await staff(req), q);
  });

  app.get("/api/identity/organizations/:id", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return identity.getOrganization(await staff(req), id);
  });

  app.post("/api/identity/organizations/:id/verify", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return identity.verifyOrganization(await staff(req), id);
  });

  app.post("/api/identity/organizations/:id/suspend", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ reason }).parse(req.body);
    return identity.suspendOrganization(await staff(req), id, body.reason);
  });

  app.post("/api/identity/organizations/:id/reinstate", async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ reason }).parse(req.body);
    return identity.reinstateOrganization(await staff(req), id, body.reason);
  });

  app.get("/api/identity/organizations/:id/members", async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return reply.header("cache-control", "no-store").send(await identity.organizationMembers(await staff(req), id));
  });

  // ── internal (service-to-service) ───────────────────────────────────────────
  // Interim shared-secret auth until mTLS workload identity (Auth.md §15). Never routed by Kong.
  const internal = (req: FastifyRequest) => {
    if (!deps.internalToken) throw forbidden("internal API disabled");
    const header = req.headers.authorization ?? "";
    const given = Buffer.from(header.replace(/^Bearer /i, ""));
    const expected = Buffer.from(deps.internalToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized("invalid service credentials");
    // what the caller says it is: the shared token doesn't tell services apart, so this is only a label
    const claimed = String(req.headers["x-service-name"] ?? "");
    return /^[a-z0-9-]{1,40}$/.test(claimed) ? claimed : "unknown-service";
  };

  app.post("/internal/drivers/:userId/role", async (req) => {
    const service = internal(req);
    const { userId } = z.object({ userId: uuid }).parse(req.params);
    const body = z.object({ active: z.boolean() }).parse(req.body);
    return identity.setDriverRole(userId, body.active, service);
  });

  // every service loads the permission matrix from here (libs/shared-authz sync.ts)
  app.get("/internal/authz/snapshot", async (req) => {
    internal(req);
    return authz.snapshot();
  });

  // platform-service owns cities; identity keeps a copy and the city's staff organisation
  app.put("/internal/cities/:id", async (req) => {
    internal(req);
    const { id } = z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/) }).parse(req.params);
    const body = z.object({ name: z.string().trim().min(2).max(80), timezone: z.string().trim().min(3).max(60) }).parse(req.body);
    return identity.upsertCity({ id, ...body });
  });

  // system page (platform-service): events waiting to be published
  app.get("/internal/ops/outbox", async (req) => {
    internal(req);
    const [row] = await deps.db.$queryRaw<{ pending: bigint; oldest: Date | null }[]>`
      SELECT count(*) AS pending, min(created_at) AS oldest FROM outbox WHERE published_at IS NULL`;
    return { pending: Number(row?.pending ?? 0), oldestAt: row?.oldest?.toISOString() ?? null };
  });

  // trip-service (GET /api/trips/:id/parties): the name the other side of a trip sees
  app.get("/internal/users/:id", async (req) => {
    internal(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return identity.publicNameForService(id);
  });

  // notification-service (SMS campaigns): the unmasked phone number; never cached by proxies
  app.get("/internal/users/:id/contact", async (req, reply) => {
    internal(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return reply.header("cache-control", "no-store").send(await identity.contactForService(id));
  });

  app.get("/internal/organizations/:id", async (req) => {
    internal(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return identity.organizationForService(id);
  });

  app.get("/internal/organizations/:id/members/:userId", async (req) => {
    internal(req);
    const { id, userId } = z.object({ id: uuid, userId: uuid }).parse(req.params);
    return identity.membershipForService(id, userId);
  });
}
