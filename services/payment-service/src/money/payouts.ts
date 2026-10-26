// Weekly settlement and payouts (Payment.md §10, workflow 09 D–E).
//
//   run (Monday 00:00 Addis, or a finance officer's "run now"): positive balances ≥ min_payout →
//   a payout line each; negative balances → a payment due (amount, minimum, deadline). One batch
//   per day, so a rerun changes nothing. A finance manager approves the batch (maker ≠ checker);
//   each line debits the balance and goes to the provider; a failed payout is reversed.
//   Dues past their deadline without the minimum paid block the beneficiary (OVERDUE → BLOCKED).

import { authorize, can, type Principal } from "@ride-app/shared-authz";
import type { Logger } from "@ride-app/shared-utils";
import { Prisma, type PayoutBatch, type PayoutLine } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import { makeReference, parseReference, type Gateways, type ProviderNotice } from "../gateways/index.js";
import { conflict, forbidden, notFound } from "../lib/errors.js";
import { accounts, post } from "../ledger/ledger.js";
import { audit, writeOutbox } from "../outbox/outbox.js";
import { afterPosting, beneficiaryOf, maskDestination, policyAt } from "./balances.js";
import { addisDate, paymentDue } from "./rules.js";

type Tx = Prisma.TransactionClient;

export function batchView(b: PayoutBatch & { lines?: (PayoutLine & { referenceCode?: string; ownerType?: string; ownerId?: string })[] }) {
  return {
    id: b.id, cycleEnd: b.cycleEnd.toISOString().slice(0, 10), status: b.status, preparedBy: b.preparedBy, approvedBy: b.approvedBy,
    rejectReason: b.rejectReason, totalMinor: Number(b.totalMinor), lineCount: b.lineCount, duesCreated: b.duesCreated,
    createdAt: b.createdAt, decidedAt: b.decidedAt,
    ...(b.lines
      ? {
          lines: b.lines.map((l) => ({
            id: l.id, accountId: l.beneficiaryAccountId, amountMinor: Number(l.amountMinor), provider: l.provider,
            destination: maskDestination(l.destination), status: l.status, failure: l.failure, updatedAt: l.updatedAt,
            ...(l.ownerType ? { beneficiary: { type: l.ownerType, id: l.ownerId }, referenceCode: l.referenceCode } : {}),
          })),
        }
      : {}),
  };
}

export function createPayouts(deps: { db: Db; gateways: Gateways; logger: Logger; notifyUrl: (provider: string) => string; now?: () => Date }) {
  const { db, gateways, logger } = deps;
  const now = deps.now ?? (() => new Date());

  async function finishBatchIfDone(tx: Tx, batchId: string) {
    const open = await tx.payoutLine.count({ where: { batchId, status: { in: ["PENDING", "SENT"] } } });
    if (open === 0) await tx.payoutBatch.updateMany({ where: { id: batchId, status: "SENDING" }, data: { status: "COMPLETED" } });
  }

  /** Debit the balance and hand the line to the provider. */
  async function send(lineId: string) {
    const prepared = await db.$transaction(async (tx) => {
      const line = await tx.payoutLine.findUniqueOrThrow({ where: { id: lineId } });
      if (line.status !== "PENDING") return null;
      const b = await tx.beneficiary.findUniqueOrThrow({ where: { accountId: line.beneficiaryAccountId }, include: { account: true } });
      // never pay out more than the balance holds now (trips since the run may have changed it)
      const amount = Math.min(Number(line.amountMinor), Number(b.account.balanceMinor));
      if (amount <= 0 || !line.provider || !line.destination) {
        await tx.payoutLine.update({ where: { id: line.id }, data: { status: "SKIPPED", failure: amount <= 0 ? "nothing left to pay out" : "no payout method" } });
        return null;
      }
      const posted = await post(tx, {
        kind: "PAYOUT", referenceType: "payout_line", referenceId: line.id, idempotencyKey: `payout:${line.id}`,
        memo: `payout to ${line.provider}`,
        lines: [{ account: { id: b.accountId }, amountMinor: -amount }, { account: accounts.clearing(line.provider), amountMinor: amount }],
      });
      await afterPosting(tx, b.accountId, { creditMinor: 0, now: now() });
      return tx.payoutLine.update({ where: { id: line.id }, data: { amountMinor: BigInt(amount), journalEntryId: posted.entryId } });
    });
    if (!prepared) return;
    try {
      const res = await gateways.get(prepared.provider!).payout({
        reference: makeReference("payout", prepared.id), amountMinor: Number(prepared.amountMinor), currency: "ETB",
        destination: prepared.destination!, description: "Anbessa earnings", notifyUrl: deps.notifyUrl(prepared.provider!),
      });
      await db.payoutLine.updateMany({ where: { id: prepared.id, status: "PENDING" }, data: { status: "SENT", providerRef: res.providerRef } });
      if (res.status === "FAILED") await failLine(prepared.id, res.failure ?? "refused by the provider");
    } catch (err) {
      logger.warn({ err: (err as Error).message, lineId: prepared.id }, "payout could not be sent; reversed");
      await failLine(prepared.id, "the payment provider is unreachable");
    }
  }

  /** A payout that didn't arrive goes back on the balance (a reversal entry, never an edit). */
  async function failLine(lineId: string, failure: string) {
    await db.$transaction(async (tx) => {
      const line = await tx.payoutLine.findUniqueOrThrow({ where: { id: lineId } });
      if (line.status === "FAILED" || line.status === "SUCCEEDED") return;
      const amount = Number(line.amountMinor);
      const b = await tx.beneficiary.findUniqueOrThrow({ where: { accountId: line.beneficiaryAccountId } });
      let reversalEntryId: string | null = null;
      if (line.journalEntryId) {
        const posted = await post(tx, {
          kind: "PAYOUT_REVERSAL", referenceType: "payout_line", referenceId: line.id, idempotencyKey: `payout-reversal:${line.id}`,
          memo: `payout failed: ${failure}`,
          lines: [{ account: accounts.clearing(line.provider!), amountMinor: -amount }, { account: { id: b.accountId }, amountMinor: amount }],
        });
        reversalEntryId = posted.entryId;
      }
      await tx.payoutLine.update({ where: { id: line.id }, data: { status: "FAILED", failure, reversalEntryId } });
      const after = await afterPosting(tx, b.accountId, { creditMinor: 0, now: now() });
      await writeOutbox(tx, {
        topic: "payout.failed", key: b.ownerId,
        payload: { accountId: b.accountId, beneficiary: beneficiaryOf(b), amountMinor: amount, balanceMinor: after.balanceMinor, currency: "ETB", provider: line.provider!, failure },
      });
      await finishBatchIfDone(tx, line.batchId);
    });
  }

  return {
    /** Settle the cycle (idempotent per day). `by` is null for the scheduled run. */
    async run(by: Principal | null) {
      if (by) authorize(by, "payout:prepare");
      const at = now();
      const cycleEnd = new Date(`${addisDate(at)}T00:00:00Z`);
      const existing = await db.payoutBatch.findUnique({ where: { cycleEnd } });
      if (existing) return { batch: batchView(existing), created: false };

      const beneficiaries = await db.beneficiary.findMany({ include: { account: true } });
      const batch = await db.$transaction(async (tx) => {
        const b = await tx.payoutBatch.create({ data: { cycleEnd, preparedBy: by?.userId ?? null } });
        let total = 0;
        let lines = 0;
        let dues = 0;
        for (const ben of beneficiaries) {
          const balance = Number(ben.account.balanceMinor);
          const policy = await policyAt(tx, ben.cityId, at);
          if (balance >= policy.minPayoutMinor && balance > 0) {
            // holds: refunds waiting for approval that would be charged to this balance
            const held = await tx.refund.aggregate({
              _sum: { amountMinor: true },
              where: { status: { in: ["PENDING_APPROVAL", "PROCESSING"] }, driverAtFault: true, payment: { tripId: { in: (await tx.tripSettlement.findMany({ where: { beneficiaryAccountId: ben.accountId }, select: { tripId: true }, take: 500, orderBy: { settledAt: "desc" } })).map((s) => s.tripId) } } },
            });
            const amount = balance - Number(held._sum.amountMinor ?? 0n);
            if (amount <= 0) continue;
            const ready = !!(ben.payoutProvider && ben.payoutDestination && gateways.has(ben.payoutProvider));
            await tx.payoutLine.create({
              data: {
                batchId: b.id, beneficiaryAccountId: ben.accountId, amountMinor: BigInt(amount), provider: ben.payoutProvider, destination: ben.payoutDestination,
                status: ready ? "PENDING" : "SKIPPED", ...(ready ? {} : { failure: "no payout method: the balance rolls over" }),
              },
            });
            if (ready) {
              total += amount;
              lines++;
            }
          } else if (balance < 0) {
            const due = paymentDue(balance, policy, at);
            const created = await tx.$executeRaw`
              INSERT INTO payment_due (beneficiary_account_id, cycle_end, amount_minor, minimum_minor, due_at)
              VALUES (${ben.accountId}::uuid, ${cycleEnd}::date, ${due.amountMinor}, ${due.minimumMinor}, ${due.dueAt})
              ON CONFLICT (beneficiary_account_id, cycle_end) DO NOTHING`;
            if (created === 1) {
              dues++;
              await writeOutbox(tx, {
                topic: "balance.payment_due", key: ben.ownerId,
                payload: {
                  accountId: ben.accountId, beneficiary: beneficiaryOf(ben), amountMinor: due.amountMinor, balanceMinor: balance, currency: "ETB",
                  minimumMinor: due.minimumMinor, dueAt: due.dueAt.toISOString(),
                },
              });
            }
          }
        }
        const updated = await tx.payoutBatch.update({
          where: { id: b.id },
          data: { totalMinor: BigInt(total), lineCount: lines, duesCreated: dues, ...(lines === 0 ? { status: "COMPLETED", decidedAt: at } : {}) },
        });
        await writeOutbox(tx, audit({ actorId: by?.userId ?? null, action: "payout:prepare", resource: { type: "payout_batch", id: b.id }, outcome: "EXECUTED", reason: `${lines} payouts, ${dues} payment dues` }));
        return updated;
      });
      return { batch: batchView(batch), created: true };
    },

    async decide(p: Principal, batchId: string, decision: "approve" | "reject", reason?: string) {
      authorize(p, "payout:approve");
      const b = await db.payoutBatch.findUnique({ where: { id: batchId } });
      if (!b) throw notFound("payout batch");
      if (b.preparedBy === p.userId) throw forbidden("someone else must approve the batch you prepared", "maker_checker");
      const next = decision === "approve" ? "SENDING" : "REJECTED";
      const { count } = await db.payoutBatch.updateMany({
        where: { id: batchId, status: "PENDING_APPROVAL" },
        data: { status: next, approvedBy: p.userId, decidedAt: now(), ...(decision === "reject" ? { rejectReason: reason ?? "rejected" } : {}) },
      });
      if (count === 0) throw conflict("the batch was already decided", "invalid_state");
      await db.$transaction(async (tx) => {
        if (decision === "reject") await tx.payoutLine.updateMany({ where: { batchId, status: "PENDING" }, data: { status: "SKIPPED", failure: "batch rejected: the balance rolls over" } });
        await writeOutbox(tx, audit({ actorId: p.userId, action: decision === "approve" ? "payout:approve" : "payout:reject", resource: { type: "payout_batch", id: batchId }, outcome: "EXECUTED", ...(reason ? { reason } : {}) }));
      });
      if (decision === "approve") {
        const lines = await db.payoutLine.findMany({ where: { batchId, status: "PENDING" }, select: { id: true } });
        for (const l of lines) await send(l.id);
        await db.$transaction((tx) => finishBatchIfDone(tx, batchId));
      }
      return this.get(p, batchId);
    },

    async applyNotice(notice: ProviderNotice): Promise<string> {
      const ref = parseReference(notice.reference);
      if (!ref || ref.kind !== "payout") return "unknown_reference";
      const line = await db.payoutLine.findUnique({ where: { id: ref.id } });
      if (!line) return "unknown_payout";
      if (notice.status === "PENDING") return "pending";
      if (notice.status === "FAILED") {
        await failLine(line.id, notice.failure ?? "refused by the provider");
        return "payout_failed";
      }
      return db.$transaction(async (tx) => {
        const current = await tx.payoutLine.findUniqueOrThrow({ where: { id: line.id } });
        if (current.status === "SUCCEEDED") return "duplicate";
        if (current.status !== "SENT" && current.status !== "PENDING") return `ignored_${current.status.toLowerCase()}`;
        await tx.payoutLine.update({ where: { id: line.id }, data: { status: "SUCCEEDED", providerTxnId: notice.providerTxnId } });
        const b = await tx.beneficiary.findUniqueOrThrow({ where: { accountId: line.beneficiaryAccountId }, include: { account: true } });
        await writeOutbox(tx, {
          topic: "payout.sent", key: b.ownerId,
          payload: { accountId: b.accountId, beneficiary: beneficiaryOf(b), amountMinor: Number(current.amountMinor), balanceMinor: Number(b.account.balanceMinor), currency: "ETB", provider: current.provider! },
        });
        await finishBatchIfDone(tx, line.batchId);
        return "paid_out";
      });
    },

    /** Dues past their deadline without the minimum → OVERDUE, the beneficiary BLOCKED. */
    async overdueSweep() {
      const late = await db.paymentDue.findMany({ where: { status: "OPEN", dueAt: { lt: now() } }, take: 200 });
      for (const d of late) {
        await db.$transaction(async (tx) => {
          const { count } = await tx.paymentDue.updateMany({ where: { id: d.id, status: "OPEN" }, data: { status: "OVERDUE" } });
          if (count === 0) return;
          await tx.beneficiary.updateMany({ where: { accountId: d.beneficiaryAccountId, overdueSince: null }, data: { overdueSince: now() } });
          await afterPosting(tx, d.beneficiaryAccountId, { creditMinor: 0, now: now() });
        });
      }
      return late.length;
    },

    async reconcile(olderThanSeconds: number) {
      const open = await db.payoutLine.findMany({ where: { status: "SENT", updatedAt: { lt: new Date(now().getTime() - olderThanSeconds * 1000) } }, take: 50 });
      let fixed = 0;
      for (const l of open) {
        const notice = await gateways.get(l.provider!).query("payout", makeReference("payout", l.id)).catch(() => null);
        if (notice && notice.status !== "PENDING") {
          await this.applyNotice(notice);
          fixed++;
        }
      }
      return fixed;
    },

    async list(p: Principal) {
      if (!(["payout:approve", "report:read_finance"] as const).some((perm) => can(p, perm))) authorize(p, "payout:prepare");
      return (await db.payoutBatch.findMany({ orderBy: { cycleEnd: "desc" }, take: 30 })).map((b) => batchView(b));
    },

    async get(p: Principal, id: string) {
      if (!(["payout:approve", "report:read_finance"] as const).some((perm) => can(p, perm))) authorize(p, "payout:prepare");
      const b = await db.payoutBatch.findUnique({ where: { id }, include: { lines: { orderBy: { amountMinor: "desc" } } } });
      if (!b) throw notFound("payout batch");
      const owners = await db.beneficiary.findMany({ where: { accountId: { in: b.lines.map((l) => l.beneficiaryAccountId) } } });
      const byAccount = new Map(owners.map((o) => [o.accountId, o]));
      return batchView({
        ...b,
        lines: b.lines.map((l) => ({ ...l, ownerType: byAccount.get(l.beneficiaryAccountId)?.type, ownerId: byAccount.get(l.beneficiaryAccountId)?.ownerId, referenceCode: byAccount.get(l.beneficiaryAccountId)?.referenceCode })),
      });
    },
  };
}

export type Payouts = ReturnType<typeof createPayouts>;
