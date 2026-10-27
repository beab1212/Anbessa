// Balance adjustments (Payment.md §15, workflow 13 B–C): a manual credit (goodwill, reversing a
// cancellation fee, paying a lost-item return) or debit (a correction) to a driver's or fleet's
// balance. Support agents (in their city) and finance officers ask; a finance manager approves,
// never the person who asked. The limits are checked on the request and again on approval.
//
// Ledger: CREDIT  GOODWILL_EXPENSE −X, BENEFICIARY_BALANCE +X
//         DEBIT   BENEFICIARY_BALANCE −X, GOODWILL_EXPENSE +X     (key adjustment:<id>)

import { authorize, can, type Principal } from "@ride-app/shared-authz";
import type { BalanceAdjustment } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { accounts, post } from "../ledger/ledger.js";
import { audit, writeOutbox } from "../outbox/outbox.js";
import { afterPosting, beneficiariesOf, beneficiaryOf, findBeneficiary, type BeneficiarySummary } from "./balances.js";
import { adjustmentDelta, adjustmentProblem, DECISION_TTL_MS, type AdjustmentCategory, type AdjustmentDirection } from "./controls.js";
import { cityFilter, reachOf, reachesAnything } from "./reach.js";

const DAY_MS = 86_400_000;

export interface AdjustmentInput {
  accountId?: string | undefined;
  referenceCode?: string | undefined;
  direction: AdjustmentDirection;
  amountMinor: number;
  category: AdjustmentCategory;
  reason: string;
  ticketId?: string | undefined;
  tripId?: string | undefined;
}

export function adjustmentView(a: BalanceAdjustment, b?: BeneficiarySummary) {
  return {
    id: a.id, accountId: a.beneficiaryAccountId, cityId: a.cityId, direction: a.direction as AdjustmentDirection, amountMinor: Number(a.amountMinor),
    category: a.category as AdjustmentCategory, reason: a.reason, ticketId: a.ticketId, tripId: a.tripId, status: a.status,
    requestedBy: a.requestedBy, decidedBy: a.decidedBy, decisionReason: a.decisionReason, journalEntryId: a.journalEntryId,
    createdAt: a.createdAt, decidedAt: a.decidedAt, expiresAt: a.expiresAt,
    ...(b ? { beneficiary: b.beneficiary, referenceCode: b.referenceCode, balanceMinor: b.balanceMinor, state: b.state } : {}),
  };
}

const VIEWERS = ["adjustment:request", "adjustment:approve", "balance:read"] as const;
const DECIDERS = ["adjustment:request", "adjustment:approve"] as const;

export function createAdjustments(deps: { db: Db; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  /** Executed credits to the balance over the last 30 days. */
  async function creditedLast30(accountId: string, excludeId?: string) {
    const r = await db.balanceAdjustment.aggregate({
      _sum: { amountMinor: true },
      where: { beneficiaryAccountId: accountId, direction: "CREDIT", status: "EXECUTED", decidedAt: { gt: new Date(now().getTime() - 30 * DAY_MS) }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    return Number(r._sum.amountMinor ?? 0);
  }

  async function withOwners(rows: BalanceAdjustment[]) {
    const owners = await beneficiariesOf(db, rows.map((r) => r.beneficiaryAccountId));
    return rows.map((r) => adjustmentView(r, owners.get(r.beneficiaryAccountId)));
  }

  return {
    async request(p: Principal, input: AdjustmentInput) {
      const b = await findBeneficiary(db, input);
      if (!b) throw notFound("balance");
      authorize(p, "adjustment:request", { cityId: b.cityId });
      const problem = adjustmentProblem({
        direction: input.direction, amountMinor: input.amountMinor, creditedLast30Minor: await creditedLast30(b.accountId),
        cityStaffOnly: !can(p, "adjustment:request"), // a city grant only (support agents)
      });
      if (problem) throw badRequest(problem, "limit_exceeded");
      return db.$transaction(async (tx) => {
        const a = await tx.balanceAdjustment.create({
          data: {
            beneficiaryAccountId: b.accountId, cityId: b.cityId, direction: input.direction, amountMinor: BigInt(input.amountMinor), category: input.category,
            reason: input.reason, ticketId: input.ticketId ?? null, tripId: input.tripId ?? null, requestedBy: p.userId,
            expiresAt: new Date(now().getTime() + DECISION_TTL_MS),
          },
        });
        await writeOutbox(tx, audit({ actorId: p.userId, action: "adjustment:request", resource: { type: "balance_adjustment", id: a.id }, outcome: "EXECUTED", reason: input.reason }));
        return adjustmentView(a);
      });
    },

    async decide(p: Principal, id: string, decision: "approve" | "reject" | "cancel", reason?: string) {
      const a = await db.balanceAdjustment.findUnique({ where: { id } });
      if (!a) throw notFound("adjustment");
      if (decision === "cancel") {
        if (a.requestedBy !== p.userId) throw forbidden("only the person who asked can withdraw it");
      } else {
        authorize(p, "adjustment:approve", { cityId: a.cityId });
        if (a.requestedBy === p.userId) throw forbidden("someone else must approve what you asked for", "maker_checker");
        if (decision === "reject" && !reason) throw badRequest("say why", "reason_required");
      }
      if (a.status !== "PENDING_APPROVAL") throw conflict(`the adjustment is ${a.status.toLowerCase().replace("_", " ")}`, "invalid_state");
      if (a.expiresAt < now()) {
        await db.balanceAdjustment.updateMany({ where: { id, status: "PENDING_APPROVAL" }, data: { status: "EXPIRED" } });
        throw conflict("the request expired; ask again", "expired");
      }
      if (decision === "approve") {
        // the limits again: other credits may have been approved since it was asked
        const problem = adjustmentProblem({ direction: a.direction as AdjustmentDirection, amountMinor: Number(a.amountMinor), creditedLast30Minor: await creditedLast30(a.beneficiaryAccountId, a.id) });
        if (problem) throw conflict(problem, "limit_exceeded");
      }

      await db.$transaction(async (tx) => {
        // claim it: a second decider finds it taken (decided_by set) or decided
        const { count } = await tx.balanceAdjustment.updateMany({ where: { id, status: "PENDING_APPROVAL", decidedBy: null }, data: { decidedBy: p.userId } });
        if (count === 0) throw conflict("the adjustment was already decided", "invalid_state");
        if (decision !== "approve") {
          await tx.balanceAdjustment.update({ where: { id }, data: { status: decision === "reject" ? "REJECTED" : "CANCELLED", decidedAt: now(), decisionReason: reason ?? null } });
        } else {
          const b = await tx.beneficiary.findUniqueOrThrow({ where: { accountId: a.beneficiaryAccountId } });
          const delta = adjustmentDelta(a.direction as AdjustmentDirection, Number(a.amountMinor));
          const posted = await post(tx, {
            kind: "ADJUSTMENT", referenceType: "balance_adjustment", referenceId: a.id, idempotencyKey: `adjustment:${a.id}`, createdBy: p.userId,
            memo: `${a.direction === "CREDIT" ? "credit" : "debit"}: ${a.category.toLowerCase().replace(/_/g, " ")}`,
            lines: [{ account: { id: b.accountId }, amountMinor: delta }, { account: accounts.goodwill(), amountMinor: -delta }],
          });
          if (!posted.created) throw conflict("the adjustment was already posted", "invalid_state");
          const after = await afterPosting(tx, b.accountId, { creditMinor: Math.max(0, delta), now: now() });
          await tx.balanceAdjustment.update({ where: { id }, data: { status: "EXECUTED", journalEntryId: posted.entryId, decidedAt: now(), decisionReason: reason ?? null } });
          await writeOutbox(tx, {
            topic: "balance.adjusted", key: b.ownerId,
            payload: {
              adjustmentId: a.id, accountId: b.accountId, beneficiary: beneficiaryOf(b), direction: a.direction as AdjustmentDirection, amountMinor: Number(a.amountMinor),
              category: a.category as AdjustmentCategory, balanceMinor: after.balanceMinor, currency: "ETB",
              ...(a.tripId ? { tripId: a.tripId } : {}), ...(a.ticketId ? { ticketId: a.ticketId } : {}),
            },
          });
        }
        await writeOutbox(tx, audit({
          actorId: p.userId, action: decision === "approve" ? "adjustment:approve" : `adjustment:${decision}`,
          resource: { type: "balance_adjustment", id }, outcome: "EXECUTED", ...(reason ? { reason } : {}),
        }));
      });
      return this.get(p, id);
    },

    async get(p: Principal, id: string) {
      const a = await db.balanceAdjustment.findUnique({ where: { id } });
      if (!a || (!VIEWERS.some((perm) => can(p, perm, { cityId: a.cityId })) && a.requestedBy !== p.userId)) throw notFound("adjustment");
      return (await withOwners([a]))[0]!;
    },

    async list(p: Principal, q: { status?: string | undefined; accountId?: string | undefined; cityId?: string | undefined }) {
      const where = cityFilter(reachOf(p, VIEWERS), q.cityId, "balance:read");
      const rows = await db.balanceAdjustment.findMany({
        where: { ...where, ...(q.status ? { status: q.status } : {}), ...(q.accountId ? { beneficiaryAccountId: q.accountId } : {}) },
        orderBy: { createdAt: "desc" }, take: 100,
      });
      return withOwners(rows);
    },

    /** Waiting for a decision, in the cities the person asks or approves in. */
    async pending(p: Principal) {
      const r = reachOf(p, DECIDERS);
      if (!reachesAnything(r)) return [];
      const rows = await db.balanceAdjustment.findMany({
        where: { status: "PENDING_APPROVAL", ...(r.everywhere ? {} : { cityId: { in: r.cities } }) }, orderBy: { createdAt: "asc" }, take: 200,
      });
      return withOwners(rows);
    },

    async expire() {
      const { count } = await db.balanceAdjustment.updateMany({ where: { status: "PENDING_APPROVAL", expiresAt: { lt: now() } }, data: { status: "EXPIRED" } });
      return count;
    },
  };
}

export type Adjustments = ReturnType<typeof createAdjustments>;
