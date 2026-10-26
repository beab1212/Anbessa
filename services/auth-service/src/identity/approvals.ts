// Maker–checker for every sensitive identity action (Role.md §11): one person asks, a different
// person approves, and the action runs in the approving transaction. Requests expire after 7 days
// (an hourly sweep records it), and the maker may withdraw a pending request.

import { authorize, can, type Permission, type Principal } from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { conflict, forbidden, notFound } from "../lib/errors.js";
import { audit, writeOutbox } from "../outbox/outbox.js";

export const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Tx = Prisma.TransactionClient;
export type ApprovalRow = Prisma.ApprovalRequestGetPayload<object>;

export interface ApprovalExecutor {
  /** who may ask */
  requestPermission: Permission;
  /** who may approve (and must not be the maker) */
  approvePermission: Permission;
  /** Runs inside the approving transaction. `after` runs once it commits (signals, cache reloads). */
  execute(tx: Tx, req: ApprovalRow, checker: Principal): Promise<{ result: unknown; after?: () => Promise<void> }>;
}

export function createApprovals(deps: { db: Db; now: () => Date; executors: Record<string, ApprovalExecutor> }) {
  const { db, now, executors } = deps;
  const executor = (action: string) => {
    const e = executors[action];
    if (!e) throw conflict(`unknown approval action ${action}`);
    return e;
  };

  /** Called by the owning operation after its own checks. */
  async function create(tx: Tx, maker: Principal, action: string, payload: Prisma.InputJsonValue, reason: string) {
    authorize(maker, executor(action).requestPermission);
    const req = await tx.approvalRequest.create({
      data: { action, payload, reason: reason.trim(), makerId: maker.userId, expiresAt: new Date(now().getTime() + APPROVAL_TTL_MS) },
    });
    await writeOutbox(tx, audit({ actorId: maker.userId, action: `${action}:request`, resource: { type: "approval_request", id: req.id }, outcome: "PENDING_APPROVAL", reason }));
    return req;
  }

  /** Actions this person may see: ones they may request or approve. */
  const visibleActions = (p: Principal) =>
    Object.entries(executors).filter(([, e]) => can(p, e.requestPermission) || can(p, e.approvePermission)).map(([a]) => a);

  async function list(p: Principal, q: { status?: string; action?: string; limit?: number }) {
    const actions = visibleActions(p).filter((a) => !q.action || a === q.action);
    if (actions.length === 0) throw forbidden("not allowed to view approvals");
    return db.approvalRequest.findMany({
      where: { action: { in: actions }, ...(q.status ? { status: q.status } : {}) },
      orderBy: { createdAt: "desc" },
      take: q.limit ?? 100,
    });
  }

  async function lockPending(tx: Tx, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM approval_request WHERE id = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) throw notFound("approval request");
    const req = await tx.approvalRequest.findUniqueOrThrow({ where: { id } });
    if (req.status !== "PENDING") throw conflict(`request is ${req.status.toLowerCase()}`, "not_pending");
    return req;
  }

  async function approve(p: Principal, id: string, decisionReason?: string) {
    const { result, after } = await db.$transaction(async (tx) => {
      const req = await lockPending(tx, id);
      const e = executor(req.action);
      authorize(p, e.approvePermission);
      if (req.expiresAt <= now()) throw conflict("request expired", "expired");
      if (req.makerId === p.userId) throw forbidden("maker and checker must be different people", "maker_is_checker");
      const out = await e.execute(tx, req, p);
      await tx.approvalRequest.update({ where: { id }, data: { status: "EXECUTED", checkerId: p.userId, decidedAt: now(), decisionReason } });
      await writeOutbox(tx, audit({ actorId: p.userId, action: `${req.action}:approve`, resource: { type: "approval_request", id }, outcome: "EXECUTED", reason: decisionReason }));
      return out;
    }, { timeout: 20_000 });
    await after?.();
    return result;
  }

  async function reject(p: Principal, id: string, decisionReason: string) {
    return db.$transaction(async (tx) => {
      const req = await lockPending(tx, id);
      authorize(p, executor(req.action).approvePermission);
      if (req.makerId === p.userId) throw forbidden("maker and checker must be different people", "maker_is_checker");
      if (req.expiresAt <= now()) throw conflict("request expired", "expired");
      await tx.approvalRequest.update({ where: { id }, data: { status: "REJECTED", checkerId: p.userId, decidedAt: now(), decisionReason } });
      await writeOutbox(tx, audit({ actorId: p.userId, action: `${req.action}:reject`, resource: { type: "approval_request", id }, outcome: "EXECUTED", reason: decisionReason }));
      return { id, status: "REJECTED" };
    });
  }

  /** The maker withdraws their own pending request. */
  async function cancel(p: Principal, id: string) {
    return db.$transaction(async (tx) => {
      const req = await lockPending(tx, id);
      if (req.makerId !== p.userId) throw forbidden("only the person who asked can withdraw a request");
      await tx.approvalRequest.update({ where: { id }, data: { status: "CANCELLED", decidedAt: now() } });
      await writeOutbox(tx, audit({ actorId: p.userId, action: `${req.action}:cancel`, resource: { type: "approval_request", id }, outcome: "EXECUTED" }));
      return { id, status: "CANCELLED" };
    });
  }

  /** Hourly: record requests nobody decided within 7 days. */
  async function expire() {
    const { count } = await db.approvalRequest.updateMany({ where: { status: "PENDING", expiresAt: { lte: now() } }, data: { status: "EXPIRED" } });
    return count;
  }

  return { create, list, approve, reject, cancel, expire, visibleActions };
}

export type Approvals = ReturnType<typeof createApprovals>;
