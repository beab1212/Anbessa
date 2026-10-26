// Identity domain operations that Better Auth doesn't do by itself (Auth.md §2):
// guests, staff accounts, maker–checker staff role grants, suspension, organisation
// verification, the driver role, and the admin directory (users, sessions, MFA resets).
// Every operation: authorize with shared-authz → one transaction (state + permissionVersion +
// outbox + audit) → post-commit signals.

import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { authorize, can, hasRole, ROLES, roleInfo, type Principal, type RoleAssignment } from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import type { SecuritySignals } from "../lib/signals.js";
import { audit, writeOutbox } from "../outbox/outbox.js";
import { emailToPhone, ETHIOPIAN_MOBILE, passwordHasher, phoneToEmail } from "../auth/password.js";
import { joinRoles, splitRoles, toAssignments } from "../auth/roles-codec.js";
import { createApprovals, type ApprovalExecutor } from "./approvals.js";

export interface SessionRevoker {
  revokeAllSessions(userId: string): Promise<void>;
}

export interface IdentityDeps {
  db: Db;
  signals: SecuritySignals;
  sessions: SessionRevoker;
  now?: () => Date;
  /** more approval actions (authz:change from the authz service) */
  executors?: Record<string, ApprovalExecutor>;
}

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

const MEMBERSHIP_SELECT = { role: true, validUntil: true, organization: { select: { id: true, kind: true, cityId: true, status: true, name: true } } } as const;

async function assignmentsOf(tx: Tx | Db, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!user) throw notFound("user");
  const memberships = await tx.member.findMany({ where: { userId }, select: MEMBERSHIP_SELECT });
  return toAssignments(user.role, memberships);
}

const isStaffUser = (roles: RoleAssignment[]) => roles.some((a) => roleInfo(a.role)?.audience === "ride-admin");
const superAdminsLeft = (tx: Tx | Db) => tx.user.count({ where: { role: { contains: ROLES.SUPER_ADMIN.stored }, banned: { not: true } } });

/** "+251911223344" → "+251 91 ••• ••44" */
export const maskPhone = (p: string | null | undefined) => (p && p.length > 7 ? `${p.slice(0, 6)} ••• ••${p.slice(-2)}` : p ? "•••" : null);

/** A grantable staff role (built-in or custom, not archived) and whether it lives in a city. */
function staffRole(code: string) {
  const info = roleInfo(code);
  if (!info || info.archived || info.audience !== "ride-admin") throw badRequest("not a grantable staff role");
  return { info, cityScoped: info.storage.type === "member" };
}

export function createIdentityService(deps: IdentityDeps) {
  const { db, signals } = deps;
  const now = deps.now ?? (() => new Date());

  // ── approval executors (Role.md §11) ────────────────────────────────────────

  const grantRole: ApprovalExecutor = {
    requestPermission: "role:request",
    approvePermission: "role:approve",
    async execute(tx, req, checker) {
      const { userId, role, cityId } = req.payload as { userId: string; role: string; cityId: string | null };
      const { info, cityScoped } = staffRole(role);
      const target = await tx.user.findUnique({ where: { id: userId } });
      if (!target || target.banned) throw conflict("target user missing or suspended");
      if (!cityScoped) {
        await tx.user.update({ where: { id: userId }, data: { role: joinRoles([...splitRoles(target.role), info.stored]) } });
      } else {
        const org = await staffOrgForCity(tx, cityId!);
        const member = await tx.member.findUnique({ where: { organizationId_userId: { organizationId: org.id, userId } } });
        if (member) await tx.member.update({ where: { id: member.id }, data: { role: joinRoles([...splitRoles(member.role), info.stored]) } });
        else await tx.member.create({ data: { id: uuidv7(), organizationId: org.id, userId, role: info.stored, createdAt: now() } });
      }
      const pv = await bumpPv(tx, userId);
      await writeOutbox(tx, { topic: "role.granted", key: userId, payload: { userId, role, ...(cityId ? { cityId } : {}), byUserId: checker.userId } });
      return { result: { userId, role, cityId, permissionVersion: pv }, after: () => signals.permissionVersion(userId, pv) };
    },
  };

  /** New temporary password, authenticator removed, every session ended. Returns the password once. */
  async function doResetMfa(tx: Tx, userId: string, actorId: string, reason: string) {
    const temporaryPassword = randomBytes(18).toString("base64url");
    const hash = await passwordHasher.hash(temporaryPassword);
    await tx.twoFactor.deleteMany({ where: { userId } });
    await tx.user.update({ where: { id: userId }, data: { twoFactorEnabled: false, mustChangePassword: true } });
    await tx.account.updateMany({ where: { userId, providerId: "credential" }, data: { password: hash } });
    const pv = await bumpPv(tx, userId);
    await writeOutbox(tx, audit({ actorId, action: "staff:reset_mfa", resource: { type: "user", id: userId }, outcome: "EXECUTED", reason }));
    return { temporaryPassword, pv };
  }

  const resetMfaExecutor: ApprovalExecutor = {
    requestPermission: "staff:manage",
    approvePermission: "staff:manage",
    async execute(tx, req, checker) {
      const { userId } = req.payload as { userId: string };
      const r = await doResetMfa(tx, userId, checker.userId, req.reason);
      return {
        result: { userId, temporaryPassword: r.temporaryPassword },
        after: async () => {
          await deps.sessions.revokeAllSessions(userId);
          await signals.permissionVersion(userId, r.pv);
        },
      };
    },
  };

  const approvals = createApprovals({ db, now, executors: { "role:grant": grantRole, "staff:reset_mfa": resetMfaExecutor, ...deps.executors } });

  return {
    approvals,

    async me(principal: Principal) {
      return { userId: principal.userId, audience: principal.audience, roles: principal.roles, permissionVersion: principal.permissionVersion };
    },

    async listCities() {
      return db.city.findMany({ select: { id: true, name: true, timezone: true }, orderBy: { name: "asc" } });
    },

    /** platform-service owns cities; it calls this so identity has the city and its staff organisation. */
    async upsertCity(input: { id: string; name: string; timezone: string }) {
      return db.$transaction(async (tx) => {
        const city = await tx.city.upsert({ where: { id: input.id }, update: { name: input.name, timezone: input.timezone }, create: input });
        const staffOrg = await tx.organization.findFirst({ where: { kind: "STAFF_CITY", cityId: input.id } });
        if (!staffOrg) {
          await tx.organization.create({
            data: { id: uuidv7(), name: `Anbessa Staff — ${input.name}`, slug: `staff-${input.id}`, createdAt: now(), kind: "STAFF_CITY", cityId: input.id, status: "VERIFIED" },
          });
        }
        return city;
      });
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
            id: uuidv7(), name: input.phoneNumber, email: phoneToEmail(input.phoneNumber), phoneNumber: input.phoneNumber,
            phoneNumberVerified: false, role: ROLES.RIDER.stored, accountStatus: "GUEST",
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
        const u = await tx.user.create({ data: { id: uuidv7(), name: input.name, email, emailVerified: true, role: "", mustChangePassword: true } });
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
      const { cityScoped } = staffRole(input.role);
      const role = input.role;
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

      const payload = { userId: input.userId, role, cityId: input.cityId ?? null };
      const pending = await db.approvalRequest.findFirst({ where: { action: "role:grant", status: "PENDING", payload: { equals: payload } } });
      if (pending) throw conflict("an identical request is already pending");
      return db.$transaction((tx) => approvals.create(tx, principal, "role:grant", payload, input.reason));
    },

    listStaffRoleRequests: (principal: Principal, status?: string) => approvals.list(principal, { status, action: "role:grant" }),
    approveStaffRole: (principal: Principal, id: string, decisionReason?: string) => approvals.approve(principal, id, decisionReason),
    rejectStaffRole: (principal: Principal, id: string, decisionReason: string) => approvals.reject(principal, id, decisionReason),

    /** Removing access is immediate (no approval), but never removes the last super admins. */
    async revokeStaffRole(principal: Principal, input: { userId: string; role: string; cityId?: string; reason: string }) {
      authorize(principal, "staff:manage");
      const info = roleInfo(input.role);
      if (!info || info.audience !== "ride-admin") throw badRequest("not a staff role");
      const role = input.role;
      const result = await db.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: input.userId } });
        if (!user) throw notFound("user");
        if (info.storage.type === "user") {
          if (role === "SUPER_ADMIN" && (await superAdminsLeft(tx)) <= 2) throw conflict("at least two super admins must remain (maker–checker needs two people)");
          await tx.user.update({ where: { id: user.id }, data: { role: joinRoles(splitRoles(user.role).filter((r) => r !== info.stored)) } });
        } else {
          if (!input.cityId) throw badRequest("cityId is required for city-scoped roles");
          const org = await staffOrgForCity(tx, input.cityId);
          const member = await tx.member.findUnique({ where: { organizationId_userId: { organizationId: org.id, userId: user.id } } });
          if (!member) throw notFound("membership");
          const remaining = splitRoles(member.role).filter((r) => r !== info.stored);
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
      if (hasRole({ ...principal, roles: targetRoles }, "SUPER_ADMIN") && (await superAdminsLeft(db)) <= 2) throw conflict("at least two super admins must remain");
      const pv = await db.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { banned: true, banReason: input.reason, banExpires: input.until ?? null } }); // `banned` is the suspension (account_status stays ACTIVE/GUEST)
        const v = await bumpPv(tx, userId);
        await writeOutbox(tx,
          { topic: "user.suspended", key: userId, payload: { userId, until: input.until?.toISOString() ?? null, byUserId: principal.userId } },
          audit({ actorId: principal.userId, action: "user:suspend", resource: { type: "user", id: userId }, outcome: "EXECUTED", reason: input.reason }),
        );
        return v;
      });
      await deps.sessions.revokeAllSessions(userId);
      await signals.deny(userId, input.until);
      await signals.permissionVersion(userId, pv);
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

    // ── admin directory ─────────────────────────────────────────────────────────

    /** Users and staff, searchable (user:read_masked everywhere). Phones are masked without user:read_pii. */
    async listUsers(principal: Principal, q: { q?: string; kind?: "staff" | "rider" | "driver" | "partner" | "guest"; status?: "active" | "suspended"; cursor?: string; limit: number }) {
      authorize(principal, "user:read_masked");
      const pii = can(principal, "user:read_pii");
      const text = q.q?.trim();
      const digits = text?.replace(/\D/g, "");
      const where: Prisma.UserWhereInput = {
        ...(text ? {
          OR: [
            { name: { contains: text, mode: "insensitive" } },
            { email: { contains: text, mode: "insensitive" } },
            ...(digits && digits.length >= 4 ? [{ phoneNumber: { contains: digits.slice(-9) } }] : []),
            ...(/^[0-9a-f-]{36}$/i.test(text) ? [{ id: text }] : []),
          ],
        } : {}),
        ...(q.kind === "staff" ? { accounts: { some: { providerId: "credential" } } } : {}),
        ...(q.kind === "rider" ? { role: { contains: ROLES.RIDER.stored }, accountStatus: { not: "GUEST" } } : {}),
        ...(q.kind === "driver" ? { role: { contains: ROLES.DRIVER.stored } } : {}),
        ...(q.kind === "partner" ? { members: { some: { organization: { kind: { in: ["FLEET", "CORPORATE"] } } } } } : {}),
        ...(q.kind === "guest" ? { accountStatus: "GUEST" } : {}),
        ...(q.status === "suspended" ? { banned: true } : q.status === "active" ? { banned: { not: true } } : {}),
      };
      const rows = await db.user.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        select: {
          id: true, name: true, email: true, phoneNumber: true, role: true, banned: true, accountStatus: true, createdAt: true,
          twoFactorEnabled: true, accounts: { select: { providerId: true } },
          members: { select: MEMBERSHIP_SELECT },
          sessions: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true, surface: true } },
        },
      });
      return {
        users: rows.map((u) => {
          const staff = u.accounts.some((a) => a.providerId === "credential");
          const phone = u.phoneNumber ?? emailToPhone(u.email) ?? null;
          return {
            id: u.id, name: u.name, staff,
            email: staff ? u.email : null,
            phone: pii ? phone : maskPhone(phone),
            roles: toAssignments(u.role, u.members).map((a) => ({ ...a, label: roleInfo(a.role)?.label ?? a.role })),
            status: u.banned ? "SUSPENDED" : u.accountStatus,
            twoFactorEnabled: !!u.twoFactorEnabled,
            createdAt: u.createdAt.toISOString(),
            lastSignInAt: u.sessions[0]?.createdAt.toISOString() ?? null,
          };
        }),
        next: rows.length === q.limit ? rows.at(-1)!.id : null,
      };
    },

    /** One user: assignments, memberships, sessions. */
    async getUser(principal: Principal, userId: string) {
      authorize(principal, "user:read_masked");
      const pii = can(principal, "user:read_pii");
      const u = await db.user.findUnique({
        where: { id: userId },
        include: {
          accounts: { select: { providerId: true } },
          members: { select: { ...MEMBERSHIP_SELECT, createdAt: true } },
          sessions: { orderBy: { createdAt: "desc" }, take: 50, select: { id: true, surface: true, ipAddress: true, userAgent: true, createdAt: true, updatedAt: true, expiresAt: true } },
        },
      });
      if (!u) throw notFound("user");
      const staff = u.accounts.some((a) => a.providerId === "credential");
      const phone = u.phoneNumber ?? emailToPhone(u.email) ?? null;
      const t = now();
      return {
        id: u.id, name: u.name, staff,
        email: staff ? u.email : null,
        phone: pii ? phone : maskPhone(phone),
        status: u.banned ? "SUSPENDED" : u.accountStatus,
        banReason: u.banReason, banExpires: u.banExpires?.toISOString() ?? null,
        twoFactorEnabled: !!u.twoFactorEnabled, mustChangePassword: u.mustChangePassword, permissionVersion: u.permissionVersion,
        createdAt: u.createdAt.toISOString(),
        roles: toAssignments(u.role, u.members).map((a) => ({ ...a, label: roleInfo(a.role)?.label ?? a.role })),
        memberships: u.members.map((m) => ({
          organizationId: m.organization.id, organizationName: m.organization.name, kind: m.organization.kind, cityId: m.organization.cityId,
          status: m.organization.status, roles: splitRoles(m.role), since: m.createdAt.toISOString(),
        })),
        sessions: u.sessions.map((s) => ({
          id: s.id, surface: s.surface, ipAddress: s.ipAddress, userAgent: s.userAgent, createdAt: s.createdAt.toISOString(),
          lastActiveAt: s.updatedAt.toISOString(), expiresAt: s.expiresAt.toISOString(), active: s.expiresAt > t,
        })),
      };
    },

    /** Sign someone out everywhere: sessions deleted, and their current tokens refused (newer permission version). */
    async revokeSessions(principal: Principal, userId: string, reason: string) {
      authorize(principal, "session:revoke");
      if (reason.trim().length < 10) throw badRequest("a reason is required (10+ characters)");
      const pv = await db.$transaction(async (tx) => {
        if (!(await tx.user.findUnique({ where: { id: userId }, select: { id: true } }))) throw notFound("user");
        const v = await bumpPv(tx, userId);
        await writeOutbox(tx, audit({ actorId: principal.userId, action: "session:revoke", resource: { type: "user", id: userId }, outcome: "EXECUTED", reason }));
        return v;
      });
      await deps.sessions.revokeAllSessions(userId);
      await signals.permissionVersion(userId, pv);
      return { userId, revoked: true };
    },

    /**
     * A staff member lost their authenticator: new temporary password, authenticator removed (they
     * enrol again). For a super admin this needs a second super admin (approval).
     */
    async resetMfa(principal: Principal, userId: string, reason: string) {
      authorize(principal, "staff:manage");
      if (userId === principal.userId) throw forbidden("ask another super admin to reset your own sign-in");
      if (reason.trim().length < 10) throw badRequest("a reason is required (10+ characters)");
      const target = await db.user.findUnique({ where: { id: userId }, include: { accounts: { select: { providerId: true } } } });
      if (!target) throw notFound("user");
      if (!target.accounts.some((a) => a.providerId === "credential")) throw badRequest("only staff accounts have a password and authenticator");
      if (splitRoles(target.role).includes(ROLES.SUPER_ADMIN.stored)) {
        const req = await db.$transaction((tx) => approvals.create(tx, principal, "staff:reset_mfa", { userId }, reason));
        return { userId, pendingApproval: req.id };
      }
      const r = await db.$transaction((tx) => doResetMfa(tx, userId, principal.userId, reason));
      await deps.sessions.revokeAllSessions(userId);
      await signals.permissionVersion(userId, r.pv);
      return { userId, temporaryPassword: r.temporaryPassword };
    },

    /** Aggregates for the admin overview (report:read, no personal data). */
    async stats(principal: Principal) {
      authorize(principal, "report:read");
      const t = now();
      const day = new Date(t.getTime() - 86_400_000);
      const week = new Date(t.getTime() - 7 * 86_400_000);
      const [users, staff, riders, drivers, guests, suspended, signups24h, signups7d, appSessions, adminSessions, staffNoMfa, partners] = await Promise.all([
        db.user.count(),
        db.user.count({ where: { accounts: { some: { providerId: "credential" } } } }),
        db.user.count({ where: { role: { contains: ROLES.RIDER.stored }, accountStatus: { not: "GUEST" } } }),
        db.user.count({ where: { role: { contains: ROLES.DRIVER.stored } } }),
        db.user.count({ where: { accountStatus: "GUEST" } }),
        db.user.count({ where: { banned: true } }),
        db.user.count({ where: { createdAt: { gte: day } } }),
        db.user.count({ where: { createdAt: { gte: week } } }),
        db.session.count({ where: { surface: "app", expiresAt: { gt: t } } }),
        db.session.count({ where: { surface: "admin", expiresAt: { gt: t } } }),
        db.user.count({ where: { accounts: { some: { providerId: "credential" } }, twoFactorEnabled: { not: true } } }),
        db.organization.groupBy({ by: ["kind", "status"], where: { kind: { in: ["FLEET", "CORPORATE"] } }, _count: true }),
      ]);
      return {
        users, staff, riders, drivers, guests, suspended, signups24h, signups7d,
        activeSessions: { app: appSessions, admin: adminSessions }, staffWithoutMfa: staffNoMfa,
        organizations: partners.map((g) => ({ kind: g.kind, status: g.status, count: g._count })),
      };
    },

    /** Onboarding queue: partner organisations of a city, by status (org:read @ CITY). */
    async listOrganizations(principal: Principal, q: { cityId: string; status?: string }) {
      authorize(principal, "org:read", { cityId: q.cityId });
      const orgs = await db.organization.findMany({
        where: { cityId: q.cityId, kind: { in: ["FLEET", "CORPORATE"] }, ...(q.status ? { status: q.status } : {}) },
        orderBy: { createdAt: "asc" },
        take: 200,
        select: { id: true, name: true, kind: true, cityId: true, legalName: true, tin: true, status: true, createdAt: true, _count: { select: { members: true } } },
      });
      return orgs.map(({ _count, ...o }) => ({ ...o, members: _count.members }));
    },

    async verifyOrganization(principal: Principal, orgId: string) {
      const org = await db.organization.findUnique({ where: { id: orgId } });
      if (!org || (org.kind !== "FLEET" && org.kind !== "CORPORATE")) throw notFound("organization");
      authorize(principal, "org:verify", { cityId: org.cityId });
      if (org.status !== "PENDING") throw conflict(`organization is ${org.status}`);
      const members = await db.member.findMany({ where: { organizationId: orgId }, select: { userId: true } });
      const pvs = await db.$transaction(async (tx) => {
        await tx.organization.update({ where: { id: orgId }, data: { status: "VERIFIED" } });
        const out: [string, number][] = [];
        for (const m of members) out.push([m.userId, await bumpPv(tx, m.userId)]); // their partner roles become effective
        await writeOutbox(tx,
          { topic: "org.verified", key: orgId, payload: { orgId, kind: org.kind, cityId: org.cityId, byUserId: principal.userId } },
          audit({ actorId: principal.userId, action: "org:verify", resource: { type: "organization", id: orgId }, outcome: "EXECUTED" }),
        );
        return out;
      });
      for (const [userId, pv] of pvs) await signals.permissionVersion(userId, pv);
      return { orgId, status: "VERIFIED" };
    },

    async suspendOrganization(principal: Principal, orgId: string, reason: string) {
      const org = await db.organization.findUnique({ where: { id: orgId } });
      if (!org || (org.kind !== "FLEET" && org.kind !== "CORPORATE")) throw notFound("organization");
      authorize(principal, "org:suspend", { cityId: org.cityId });
      const members = await db.member.findMany({ where: { organizationId: orgId }, select: { userId: true } });
      const pvs = await db.$transaction(async (tx) => {
        await tx.organization.update({ where: { id: orgId }, data: { status: "SUSPENDED" } });
        const out: [string, number][] = [];
        for (const m of members) out.push([m.userId, await bumpPv(tx, m.userId)]);
        await writeOutbox(tx,
          { topic: "org.suspended", key: orgId, payload: { orgId, kind: org.kind, byUserId: principal.userId } },
          audit({ actorId: principal.userId, action: "org:suspend", resource: { type: "organization", id: orgId }, outcome: "EXECUTED", reason }),
        );
        return out;
      });
      for (const [userId, pv] of pvs) await signals.permissionVersion(userId, pv);
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

    /** For other services (fleet-service): an organisation's kind, status, city and legal name. */
    /** For other services: the name shown to the other side of a trip (no phone number). */
    async publicNameForService(id: string) {
      const u = await db.user.findUnique({ where: { id }, select: { id: true, name: true } });
      if (!u) throw notFound("user");
      return u;
    },

    async organizationForService(id: string) {
      const org = await db.organization.findUnique({ where: { id }, select: { id: true, name: true, kind: true, cityId: true, legalName: true, status: true } });
      if (!org) throw notFound("organization");
      return org;
    },

    /** For other services: a user's roles in one organisation (404 when not a member). */
    async membershipForService(organizationId: string, userId: string) {
      const m = await db.member.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        select: { role: true, validUntil: true, user: { select: { name: true, phoneNumber: true, banned: true } } },
      });
      if (!m || (m.validUntil && m.validUntil < now())) throw notFound("membership");
      return { organizationId, userId, roles: splitRoles(m.role), name: m.user.name, phoneNumber: m.user.phoneNumber, banned: !!m.user.banned };
    },
  };
}

export type IdentityService = ReturnType<typeof createIdentityService>;
