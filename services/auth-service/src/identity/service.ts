// Identity domain operations that Better Auth doesn't do by itself (Auth.md §2):
// guests, staff accounts, maker–checker staff role grants, suspension, organisation
// verification and the driver role. Every operation: authorize with shared-authz →
// one transaction (state + permissionVersion + outbox + audit) → post-commit signals.

import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import {
  authorize, can, GRANTABLE_STAFF_ROLES, hasRole, isRoleCode, ROLES,
  type Principal, type RoleCode,
} from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import type { SecuritySignals } from "../lib/signals.js";
import { audit, writeOutbox } from "../outbox/outbox.js";
import { ETHIOPIAN_MOBILE, passwordHasher, phoneToEmail } from "../auth/password.js";
import { joinRoles, splitRoles, toAssignments } from "../auth/roles-codec.js";

export interface SessionRevoker {
  revokeAllSessions(userId: string): Promise<void>;
}

export interface IdentityDeps {
  db: Db;
  signals: SecuritySignals;
  sessions: SessionRevoker;
  now?: () => Date;
}

const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
type Tx = Prisma.TransactionClient;

async function bumpPv(tx: Tx, userId: string): Promise<number> {
  const u = await tx.user.update({ where: { id: userId }, data: { permissionVersion: { increment: 1 } }, select: { permissionVersion: true } });
  return u.permissionVersion;
}

async function staffOrgForCity(tx: Tx | Db, cityId: string) {
  const org = await tx.organization.findFirst({ where: { kind: "STAFF_CITY", cityId } });
  if (!org) throw badRequest(`no staff organization for city ${cityId}`);
  return org;
}

async function assignmentsOf(tx: Tx | Db, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!user) throw notFound("user");
  const memberships = await tx.member.findMany({
    where: { userId },
    select: { role: true, validUntil: true, organization: { select: { id: true, kind: true, cityId: true, status: true } } },
  });
  return toAssignments(user.role, memberships);
}

const isStaffUser = (roles: { role: RoleCode }[]) => roles.some((a) => ROLES[a.role].audience === "ride-admin");

export function createIdentityService(deps: IdentityDeps) {
  const { db, signals } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async me(principal: Principal) {
      return { userId: principal.userId, audience: principal.audience, roles: principal.roles, permissionVersion: principal.permissionVersion };
    },

    async listCities() {
      return db.city.findMany({ select: { id: true, name: true, timezone: true }, orderBy: { name: "asc" } });
    },

    /** Call center: a rider known only by phone number (workflow 10). */
    async createGuest(principal: Principal, input: { phoneNumber: string; cityId: string }) {
      authorize(principal, "user:create_guest", { cityId: input.cityId });
      if (!ETHIOPIAN_MOBILE.test(input.phoneNumber)) throw badRequest("phoneNumber must be an Ethiopian mobile number in E.164");
      const existing = await db.user.findUnique({ where: { phoneNumber: input.phoneNumber }, select: { id: true, accountStatus: true } });
      if (existing) return { userId: existing.id, created: false, accountStatus: existing.accountStatus };
      const id = await db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            id: uuidv7(),
            name: input.phoneNumber,
            email: phoneToEmail(input.phoneNumber),
            phoneNumber: input.phoneNumber,
            phoneNumberVerified: false,
            role: ROLES.RIDER.stored,
            accountStatus: "GUEST",
          },
        });
        await writeOutbox(tx,
          { topic: "user.created", key: user.id, payload: { userId: user.id, guest: true } },
          audit({ actorId: principal.userId, action: "user:create_guest", resource: { type: "user", id: user.id }, outcome: "EXECUTED" }),
        );
        return user.id;
      });
      return { userId: id, created: true, accountStatus: "GUEST" };
    },

    /** Super admin creates a staff login. The temporary password is returned once and must be changed. */
    async createStaffAccount(principal: Principal, input: { email: string; name: string }) {
      authorize(principal, "staff:manage");
      const email = input.email.trim().toLowerCase();
      if (await db.user.findUnique({ where: { email } })) throw conflict("a user with this email already exists");
      const temporaryPassword = randomBytes(18).toString("base64url");
      const hash = await passwordHasher.hash(temporaryPassword);
      const user = await db.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: { id: uuidv7(), name: input.name, email, emailVerified: true, role: "", mustChangePassword: true },
        });
        await tx.account.create({ data: { id: uuidv7(), accountId: u.id, providerId: "credential", userId: u.id, password: hash } });
        await writeOutbox(tx,
          { topic: "user.created", key: u.id, payload: { userId: u.id, guest: false } },
          audit({ actorId: principal.userId, action: "staff:create_account", resource: { type: "user", id: u.id }, outcome: "EXECUTED" }),
        );
        return u;
      });
      return { userId: user.id, email, temporaryPassword };
    },

    async requestStaffRole(principal: Principal, input: { userId: string; role: string; cityId?: string; reason: string }) {
      authorize(principal, "role:request");
      if (!isRoleCode(input.role) || !GRANTABLE_STAFF_ROLES.includes(input.role)) throw badRequest("not a grantable staff role");
      const role = input.role;
      const cityScoped = ROLES[role].storage.type === "member";
      if (cityScoped && !input.cityId) throw badRequest(`${role} is city-scoped: cityId is required`);
      if (!cityScoped && input.cityId) throw badRequest(`${role} is global: cityId must not be set`);
      if (cityScoped) await staffOrgForCity(db, input.cityId!);
      if (input.reason.trim().length < 10) throw badRequest("reason must explain the grant (10+ characters)");

      const target = await db.user.findUnique({ where: { id: input.userId }, include: { accounts: { select: { providerId: true } } } });
      if (!target) throw notFound("user");
      if (target.banned) throw conflict("user is suspended");
      if (!target.accounts.some((a) => a.providerId === "credential")) throw badRequest("staff roles require a staff (email + password) account");
      const current = await assignmentsOf(db, input.userId);
      if (current.some((a) => a.role === role && (a.scope === "GLOBAL" || a.cityId === input.cityId))) throw conflict("user already has this role");

      const pending = await db.approvalRequest.findFirst({
        where: { action: "role:grant", status: "PENDING", payload: { equals: { userId: input.userId, role, cityId: input.cityId ?? null } } },
      });
      if (pending) throw conflict("an identical request is already pending");

      return db.$transaction(async (tx) => {
        const req = await tx.approvalRequest.create({
          data: {
            action: "role:grant",
            payload: { userId: input.userId, role, cityId: input.cityId ?? null },
            reason: input.reason.trim(),
            makerId: principal.userId,
            expiresAt: new Date(now().getTime() + APPROVAL_TTL_MS),
          },
        });
        await writeOutbox(tx, audit({ actorId: principal.userId, action: "role:request", resource: { type: "approval_request", id: req.id }, outcome: "PENDING_APPROVAL", reason: input.reason }));
        return req;
      });
    },

    async listStaffRoleRequests(principal: Principal, status?: string) {
      if (!can(principal, "role:request") && !can(principal, "role:approve")) throw forbidden("not allowed to view role requests");
      return db.approvalRequest.findMany({ where: { action: "role:grant", ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" }, take: 100 });
    },

    /** Checker approves → the grant executes in the same transaction. */
    async approveStaffRole(principal: Principal, id: string, decisionReason?: string) {
      authorize(principal, "role:approve");
      const result = await db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM approval_request WHERE id = ${id}::uuid FOR UPDATE`;
        if (rows.length === 0) throw notFound("approval request");
        const req = await tx.approvalRequest.findUniqueOrThrow({ where: { id } });
        if (req.status !== "PENDING") throw conflict(`request is ${req.status}`);
        if (req.expiresAt <= now()) {
          await tx.approvalRequest.update({ where: { id }, data: { status: "EXPIRED" } });
          throw conflict("request expired");
        }
        if (req.makerId === principal.userId) throw forbidden("maker and checker must be different people", "maker_is_checker");

        const { userId, role, cityId } = req.payload as { userId: string; role: RoleCode; cityId: string | null };
        const target = await tx.user.findUnique({ where: { id: userId } });
        if (!target || target.banned) throw conflict("target user missing or suspended");

        if (ROLES[role].storage.type === "user") {
          await tx.user.update({ where: { id: userId }, data: { role: joinRoles([...splitRoles(target.role), ROLES[role].stored]) } });
        } else {
          const org = await staffOrgForCity(tx, cityId!);
          const member = await tx.member.findUnique({ where: { organizationId_userId: { organizationId: org.id, userId } } });
          if (member) {
            await tx.member.update({ where: { id: member.id }, data: { role: joinRoles([...splitRoles(member.role), ROLES[role].stored]) } });
          } else {
            await tx.member.create({ data: { id: uuidv7(), organizationId: org.id, userId, role: ROLES[role].stored, createdAt: now() } });
          }
        }
        const pv = await bumpPv(tx, userId);
        await tx.approvalRequest.update({ where: { id }, data: { status: "EXECUTED", checkerId: principal.userId, decidedAt: now(), decisionReason } });
        await writeOutbox(tx,
          { topic: "role.granted", key: userId, payload: { userId, role, ...(cityId ? { cityId } : {}), byUserId: principal.userId } },
          audit({ actorId: principal.userId, action: "role:approve", resource: { type: "approval_request", id }, outcome: "EXECUTED", reason: decisionReason }),
        );
        return { userId, role, cityId, permissionVersion: pv };
      });
      await signals.permissionVersion(result.userId, result.permissionVersion);
      return result;
    },

    async rejectStaffRole(principal: Principal, id: string, decisionReason: string) {
      authorize(principal, "role:approve");
      return db.$transaction(async (tx) => {
        const req = await tx.approvalRequest.findUnique({ where: { id } });
        if (!req) throw notFound("approval request");
        if (req.status !== "PENDING") throw conflict(`request is ${req.status}`);
        if (req.makerId === principal.userId) throw forbidden("maker and checker must be different people", "maker_is_checker");
        await tx.approvalRequest.update({ where: { id }, data: { status: "REJECTED", checkerId: principal.userId, decidedAt: now(), decisionReason } });
        await writeOutbox(tx, audit({ actorId: principal.userId, action: "role:reject", resource: { type: "approval_request", id }, outcome: "EXECUTED", reason: decisionReason }));
        return { id, status: "REJECTED" };
      });
    },

    /** Removing access is immediate (no approval), but never removes the last super admins. */
    async revokeStaffRole(principal: Principal, input: { userId: string; role: string; cityId?: string; reason: string }) {
      authorize(principal, "staff:manage");
      if (!isRoleCode(input.role) || !GRANTABLE_STAFF_ROLES.includes(input.role)) throw badRequest("not a staff role");
      const role = input.role;
      const result = await db.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: input.userId } });
        if (!user) throw notFound("user");
        if (ROLES[role].storage.type === "user") {
          if (role === "SUPER_ADMIN") {
            const admins = await tx.user.count({ where: { role: { contains: ROLES.SUPER_ADMIN.stored }, banned: { not: true } } });
            if (admins <= 2) throw conflict("at least two super admins must remain (maker–checker needs two people)");
          }
          await tx.user.update({ where: { id: user.id }, data: { role: joinRoles(splitRoles(user.role).filter((r) => r !== ROLES[role].stored)) } });
        } else {
          if (!input.cityId) throw badRequest("cityId is required for city-scoped roles");
          const org = await staffOrgForCity(tx, input.cityId);
          const member = await tx.member.findUnique({ where: { organizationId_userId: { organizationId: org.id, userId: user.id } } });
          if (!member) throw notFound("membership");
          const remaining = splitRoles(member.role).filter((r) => r !== ROLES[role].stored);
          if (remaining.length === 0) await tx.member.delete({ where: { id: member.id } });
          else await tx.member.update({ where: { id: member.id }, data: { role: joinRoles(remaining) } });
        }
        const pv = await bumpPv(tx, user.id);
        await writeOutbox(tx,
          { topic: "role.revoked", key: user.id, payload: { userId: user.id, role, ...(input.cityId ? { cityId: input.cityId } : {}), byUserId: principal.userId } },
          audit({ actorId: principal.userId, action: "role:revoke", resource: { type: "user", id: user.id }, outcome: "EXECUTED", reason: input.reason }),
        );
        return { userId: user.id, permissionVersion: pv };
      });
      await signals.permissionVersion(result.userId, result.permissionVersion);
      return result;
    },

    /** Safety: ban + revoke every session + denylist (workflow 16). */
    async suspendUser(principal: Principal, userId: string, input: { reason: string; cityId: string; until?: Date }) {
      if (userId === principal.userId) throw forbidden("you can't suspend yourself");
      if (input.reason.trim().length < 10) throw badRequest("a reason is required (10+ characters)");
      const targetRoles = await assignmentsOf(db, userId);
      // staff accounts are suspended by super admins; everyone else by safety officers in the city
      if (isStaffUser(targetRoles)) authorize(principal, "staff:manage");
      else authorize(principal, "user:suspend", { cityId: input.cityId });
      if (hasRole({ ...principal, roles: targetRoles }, "SUPER_ADMIN")) {
        const admins = await db.user.count({ where: { role: { contains: ROLES.SUPER_ADMIN.stored }, banned: { not: true } } });
        if (admins <= 2) throw conflict("at least two super admins must remain");
      }
      await db.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { banned: true, banReason: input.reason, banExpires: input.until ?? null } });
        await bumpPv(tx, userId);
        await writeOutbox(tx,
          { topic: "user.suspended", key: userId, payload: { userId, until: input.until?.toISOString() ?? null, byUserId: principal.userId } },
          audit({ actorId: principal.userId, action: "user:suspend", resource: { type: "user", id: userId }, outcome: "EXECUTED", reason: input.reason }),
        );
      });
      await deps.sessions.revokeAllSessions(userId);
      await signals.deny(userId, input.until);
      return { userId, suspended: true };
    },

    async reinstateUser(principal: Principal, userId: string, input: { reason: string; cityId: string }) {
      const targetRoles = await assignmentsOf(db, userId);
      if (isStaffUser(targetRoles)) authorize(principal, "staff:manage");
      else authorize(principal, "user:reinstate", { cityId: input.cityId });
      const pv = await db.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) throw notFound("user");
        if (!user.banned) throw conflict("user is not suspended");
        await tx.user.update({ where: { id: userId }, data: { banned: false, banReason: null, banExpires: null } });
        const v = await bumpPv(tx, userId);
        await writeOutbox(tx,
          { topic: "user.reinstated", key: userId, payload: { userId, byUserId: principal.userId } },
          audit({ actorId: principal.userId, action: "user:reinstate", resource: { type: "user", id: userId }, outcome: "EXECUTED", reason: input.reason }),
        );
        return v;
      });
      await signals.allow(userId);
      await signals.permissionVersion(userId, pv);
      return { userId, suspended: false };
    },

    async verifyOrganization(principal: Principal, orgId: string) {
      const org = await db.organization.findUnique({ where: { id: orgId } });
      if (!org || (org.kind !== "FLEET" && org.kind !== "CORPORATE")) throw notFound("organization");
      authorize(principal, "org:verify", { cityId: org.cityId });
      if (org.status !== "PENDING") throw conflict(`organization is ${org.status}`);
      const members = await db.member.findMany({ where: { organizationId: orgId }, select: { userId: true } });
      await db.$transaction(async (tx) => {
        await tx.organization.update({ where: { id: orgId }, data: { status: "VERIFIED" } });
        for (const m of members) await bumpPv(tx, m.userId); // their partner roles become effective
        await writeOutbox(tx,
          { topic: "org.verified", key: orgId, payload: { orgId, kind: org.kind, cityId: org.cityId, byUserId: principal.userId } },
          audit({ actorId: principal.userId, action: "org:verify", resource: { type: "organization", id: orgId }, outcome: "EXECUTED" }),
        );
      });
      return { orgId, status: "VERIFIED" };
    },

    async suspendOrganization(principal: Principal, orgId: string, reason: string) {
      const org = await db.organization.findUnique({ where: { id: orgId } });
      if (!org || (org.kind !== "FLEET" && org.kind !== "CORPORATE")) throw notFound("organization");
      authorize(principal, "org:suspend", { cityId: org.cityId });
      const members = await db.member.findMany({ where: { organizationId: orgId }, select: { userId: true } });
      await db.$transaction(async (tx) => {
        await tx.organization.update({ where: { id: orgId }, data: { status: "SUSPENDED" } });
        for (const m of members) await bumpPv(tx, m.userId);
        await writeOutbox(tx,
          { topic: "org.suspended", key: orgId, payload: { orgId, kind: org.kind, byUserId: principal.userId } },
          audit({ actorId: principal.userId, action: "org:suspend", resource: { type: "organization", id: orgId }, outcome: "EXECUTED", reason }),
        );
      });
      return { orgId, status: "SUSPENDED" };
    },

    /** Called by fleet-service when a driver is activated / suspended (workflow 02). */
    async setDriverRole(userId: string, active: boolean, byService: string) {
      const pv = await db.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) throw notFound("user");
        const roles = new Set(splitRoles(user.role));
        const had = roles.has(ROLES.DRIVER.stored);
        if (had === active) return undefined;
        if (active) roles.add(ROLES.DRIVER.stored);
        else roles.delete(ROLES.DRIVER.stored);
        await tx.user.update({ where: { id: userId }, data: { role: joinRoles(roles) } });
        const v = await bumpPv(tx, userId);
        await writeOutbox(tx,
          { topic: active ? "role.granted" : "role.revoked", key: userId, payload: { userId, role: "DRIVER", byUserId: null } },
          audit({ actorId: null, action: active ? "driver:activate" : "driver:suspend", resource: { type: "user", id: userId }, outcome: "EXECUTED", reason: `by ${byService}` }),
        );
        return v;
      });
      if (pv !== undefined) await signals.permissionVersion(userId, pv);
      return { userId, driver: active };
    },
  };
}

export type IdentityService = ReturnType<typeof createIdentityService>;
