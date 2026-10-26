// Editing the permission matrix (Role.md §8): a super admin proposes a change to one role, another
// approves, and it executes in that transaction (rows + authz_version). After commit this process
// swaps its registry and publishes `authz:changed`, so every service reloads within seconds.

import { AUTHZ_CHANNEL, authorize, setAuthzSnapshot, type Principal } from "@ride-app/shared-authz";
import type { Logger } from "@ride-app/shared-utils";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { AppError, badRequest } from "../lib/errors.js";
import { audit, writeOutbox } from "../outbox/outbox.js";
import type { ApprovalExecutor, Approvals } from "../identity/approvals.js";
import { splitRoles } from "../auth/roles-codec.js";
import { customRoleCode, guardrailProblems, type AuthzChange } from "./guardrails.js";
import { loadAuthzSnapshot } from "./store.js";

type Tx = Prisma.TransactionClient;

export interface Publisher {
  publish(channel: string, message: string): Promise<unknown>;
}

/** People holding a role: in user.role (global) or a membership (city / org). */
async function holders(tx: Tx | Db, stored: string) {
  const [users, members] = await Promise.all([
    tx.user.findMany({ where: { role: { contains: stored } }, select: { role: true } }),
    tx.member.findMany({ where: { role: { contains: stored } }, select: { role: true } }),
  ]);
  return [...users, ...members].filter((r) => splitRoles(r.role).includes(stored)).length;
}

export function createAuthzService(deps: { db: Db; logger: Logger; publisher?: Publisher }) {
  const { db, logger } = deps;

  async function check(tx: Tx | Db, change: AuthzChange) {
    const before = await loadAuthzSnapshot(tx);
    const stored = before.roles.find((r) => r.code === change.roleCode)?.stored;
    const problems = guardrailProblems(before, change, { assignedCount: change.archive && stored ? await holders(tx, stored) : 0 });
    if (problems.length) throw new AppError(400, problems.join("; "), "guardrail");
    return before;
  }

  const executor: ApprovalExecutor = {
    requestPermission: "authz:propose",
    approvePermission: "authz:approve",
    async execute(tx, req, checker) {
      const change = req.payload as unknown as AuthzChange;
      await check(tx, change); // the matrix may have moved since it was proposed
      if (change.create) {
        await tx.roleDefinition.create({
          data: {
            code: change.roleCode, label: change.create.label.trim(), description: change.create.description ?? null, audience: "ride-admin",
            storageType: change.create.storage === "city" ? "member" : "user", orgKinds: change.create.storage === "city" ? ["STAFF_CITY"] : [],
            stored: change.roleCode.toLowerCase(),
          },
        });
      }
      if (change.label !== undefined || change.description !== undefined || change.archive) {
        await tx.roleDefinition.update({
          where: { code: change.roleCode },
          data: { ...(change.label ? { label: change.label.trim() } : {}), ...(change.description !== undefined ? { description: change.description } : {}), ...(change.archive ? { archived: true } : {}) },
        });
      }
      for (const { permission, scope } of change.set) {
        if (scope === null) await tx.rolePermission.deleteMany({ where: { roleCode: change.roleCode, permission } });
        else await tx.rolePermission.upsert({
          where: { roleCode_permission: { roleCode: change.roleCode, permission } },
          update: { scope },
          create: { roleCode: change.roleCode, permission, scope },
        });
      }
      const v = await tx.authzVersion.update({ where: { id: 1 }, data: { version: { increment: 1 } } });
      await writeOutbox(tx, audit({
        actorId: checker.userId, action: "authz:change", resource: { type: "role", id: change.roleCode }, outcome: "EXECUTED",
        reason: `v${v.version}: ${describe(change)}`,
      }));
      return { result: { roleCode: change.roleCode, version: v.version }, after: () => reload(String(v.version)) };
    },
  };

  /** Swap this process's registry and tell the other services. */
  async function reload(version: string) {
    setAuthzSnapshot(await loadAuthzSnapshot(db));
    try {
      await deps.publisher?.publish(AUTHZ_CHANNEL, version);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "couldn't publish authz:changed; services pick it up on their next poll");
    }
  }

  return {
    executor,
    snapshot: () => loadAuthzSnapshot(db),

    async propose(approvals: Approvals, p: Principal, input: Omit<AuthzChange, "roleCode"> & { roleCode?: string; reason: string }) {
      authorize(p, "authz:propose");
      if (input.reason.trim().length < 10) throw badRequest("explain the change (10+ characters)");
      const roleCode = input.create ? customRoleCode(input.create.label) : input.roleCode;
      if (!roleCode) throw badRequest("roleCode is required");
      const change: AuthzChange = { roleCode, set: input.set, ...(input.create ? { create: input.create } : {}), ...(input.archive ? { archive: true } : {}), ...(input.label !== undefined ? { label: input.label } : {}), ...(input.description !== undefined ? { description: input.description } : {}) };
      return db.$transaction(async (tx) => {
        await check(tx, change);
        const pending = await tx.approvalRequest.findFirst({ where: { action: "authz:change", status: "PENDING", payload: { path: ["roleCode"], equals: roleCode } } });
        if (pending) throw new AppError(409, `a change to ${roleCode} is already waiting for approval`, "change_pending");
        return approvals.create(tx, p, "authz:change", change as unknown as Prisma.InputJsonValue, input.reason);
      });
    },

    /** Dry run for the editor: the problems this change would hit. */
    async preview(p: Principal, change: AuthzChange) {
      authorize(p, "authz:read");
      const before = await loadAuthzSnapshot(db);
      return { problems: guardrailProblems(before, change) };
    },
  };
}

export function describe(c: AuthzChange): string {
  const parts: string[] = [];
  if (c.create) parts.push(`create ${c.create.label} (${c.create.storage})`);
  if (c.archive) parts.push("archive");
  if (c.label) parts.push(`rename to ${c.label}`);
  for (const { permission, scope } of c.set) parts.push(scope ? `+${permission}@${scope}` : `-${permission}`);
  return `${c.roleCode}: ${parts.join(", ")}`;
}

export type AuthzService = ReturnType<typeof createAuthzService>;
