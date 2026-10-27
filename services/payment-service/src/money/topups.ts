// Top-ups (Payment.md §9, workflow 09 B–C). Drivers and fleet owners pay in by mobile money (the
// provider's callback credits the balance); cash at an office and bank transfers are recorded by a
// finance officer and credited once a finance manager approves (maker–checker).

import { authorize, citiesWith, type Principal } from "@ride-app/shared-authz";
import type { Logger } from "@ride-app/shared-utils";
import { Prisma, type TopUp } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import { makeReference, parseReference, type Gateways, type ProviderNotice } from "../gateways/index.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import type { Realtime } from "../lib/realtime.js";
import { accounts, post, type AccountSpec } from "../ledger/ledger.js";
import { audit, writeOutbox } from "../outbox/outbox.js";
import { assertBalanceOwner, assertBalanceReadable } from "./access.js";
import { afterPosting, beneficiaryOf } from "./balances.js";

type Tx = Prisma.TransactionClient;

export const TOP_UP_LIMITS = { minMinor: 1000, maxMinor: 10_000_000 };

export function topUpView(t: TopUp) {
  return {
    id: t.id, accountId: t.beneficiaryAccountId, channel: t.channel, provider: t.provider, amountMinor: Number(t.amountMinor), status: t.status,
    checkoutUrl: t.status === "ACTION_REQUIRED" ? t.checkoutUrl : null, receiptNo: t.receiptNo, note: t.note, failure: t.failure,
    createdBy: t.createdBy, approvedBy: t.approvedBy, createdAt: t.createdAt, completedAt: t.completedAt,
  };
}

export function createTopUps(deps: { db: Db; gateways: Gateways; realtime: Realtime; logger: Logger; notifyUrl: (provider: string) => string; now?: () => Date }) {
  const { db, gateways, logger } = deps;
  const now = deps.now ?? (() => new Date());

  /** Credit the balance (one entry per top-up) and tell the owner. */
  async function credit(tx: Tx, t: TopUp, source: AccountSpec, actor: string | null) {
    const b = await tx.beneficiary.findUniqueOrThrow({ where: { accountId: t.beneficiaryAccountId } });
    const amount = Number(t.amountMinor);
    const posted = await post(tx, {
      kind: "TOP_UP", referenceType: "top_up", referenceId: t.id, idempotencyKey: `top-up:${t.id}`, createdBy: actor,
      memo: `top-up by ${t.channel.toLowerCase().replace("_", " ")}`,
      lines: [{ account: source, amountMinor: -amount }, { account: { id: b.accountId }, amountMinor: amount }],
    });
    const after = await afterPosting(tx, b.accountId, { creditMinor: amount, now: now() });
    await tx.topUp.update({ where: { id: t.id }, data: { status: "SUCCEEDED", journalEntryId: posted.entryId, completedAt: now(), approvedBy: actor ?? t.approvedBy } });
    await writeOutbox(tx, {
      topic: "balance.topped_up", key: b.ownerId,
      payload: {
        accountId: b.accountId, beneficiary: beneficiaryOf(b), amountMinor: amount, balanceMinor: after.balanceMinor, currency: "ETB",
        channel: t.channel, ...(t.provider ? { provider: t.provider } : {}),
      },
    });
    return { ownerId: b.ownerId, type: b.type };
  }

  async function startCharge(t: TopUp) {
    try {
      const started = await gateways.get(t.provider!).charge({
        reference: makeReference("topup", t.id), amountMinor: Number(t.amountMinor), currency: "ETB",
        description: "Anbessa balance top-up", notifyUrl: deps.notifyUrl(t.provider!),
      });
      await db.topUp.updateMany({ where: { id: t.id, status: "PENDING" }, data: { status: "ACTION_REQUIRED", providerRef: started.providerRef, checkoutUrl: started.checkoutUrl } });
      return started.instructions;
    } catch (err) {
      logger.warn({ err: (err as Error).message, topUpId: t.id }, "top-up charge could not start");
      await db.topUp.updateMany({ where: { id: t.id, status: "PENDING" }, data: { status: "FAILED", failure: "the payment provider is unreachable; try again" } });
      return null;
    }
  }

  return {
    /** An owner tops up by mobile money (or card). */
    async create(p: Principal, accountId: string, input: { amountMinor: number; provider: string }) {
      const b = await db.beneficiary.findUnique({ where: { accountId } });
      if (!b) throw notFound("balance");
      assertBalanceOwner(p, b);
      if (!gateways.has(input.provider) || !gateways.get(input.provider).methods.includes("MOBILE_MONEY")) {
        throw badRequest("top up with an enabled mobile money provider", "unknown_provider");
      }
      if (input.amountMinor < TOP_UP_LIMITS.minMinor || input.amountMinor > TOP_UP_LIMITS.maxMinor) {
        throw badRequest(`top up between ${TOP_UP_LIMITS.minMinor / 100} and ${TOP_UP_LIMITS.maxMinor / 100} ETB`, "amount_out_of_range");
      }
      const t = await db.topUp.create({
        data: { beneficiaryAccountId: accountId, channel: "MOBILE_MONEY", provider: input.provider, amountMinor: BigInt(input.amountMinor), createdBy: p.userId },
      });
      const instructions = await startCharge(t);
      return { ...topUpView(await db.topUp.findUniqueOrThrow({ where: { id: t.id } })), instructions };
    },

    async applyNotice(notice: ProviderNotice): Promise<string> {
      const ref = parseReference(notice.reference);
      if (!ref || ref.kind !== "topup") return "unknown_reference";
      const t = await db.topUp.findUnique({ where: { id: ref.id } });
      if (!t) return "unknown_top_up";
      if (notice.amountMinor !== Number(t.amountMinor)) return "amount_mismatch";
      if (notice.status === "PENDING") return "pending";
      const result = await db.$transaction(async (tx) => {
        const current = await tx.topUp.findUniqueOrThrow({ where: { id: t.id } });
        if (current.status === "SUCCEEDED") return "duplicate";
        if (notice.status === "FAILED") {
          if (current.status === "FAILED") return "duplicate";
          await tx.topUp.update({ where: { id: t.id }, data: { status: "FAILED", failure: notice.failure ?? "declined", completedAt: now() } });
          return "failed";
        }
        // money arrived: credit it even if the top-up had been marked failed (a late approval)
        await tx.topUp.update({ where: { id: t.id }, data: { providerTxnId: notice.providerTxnId, providerRef: notice.providerRef ?? current.providerRef } });
        return credit(tx, current, accounts.clearing(current.provider!), null);
      });
      if (typeof result === "string") return result;
      const view = topUpView(await db.topUp.findUniqueOrThrow({ where: { id: t.id } }));
      if (result.type === "INDIVIDUAL") deps.realtime.toUser(result.ownerId, "balance:topped_up", { topUp: view });
      return "credited";
    },

    async get(p: Principal, id: string) {
      const t = await db.topUp.findUnique({ where: { id } });
      if (!t) throw notFound("top-up");
      const b = await db.beneficiary.findUniqueOrThrow({ where: { accountId: t.beneficiaryAccountId } });
      assertBalanceReadable(p, b);
      return topUpView(t);
    },

    async forAccount(p: Principal, accountId: string) {
      const b = await db.beneficiary.findUnique({ where: { accountId } });
      if (!b) throw notFound("balance");
      assertBalanceReadable(p, b);
      return (await db.topUp.findMany({ where: { beneficiaryAccountId: accountId }, orderBy: { createdAt: "desc" }, take: 20 })).map(topUpView);
    },

    // ── finance: cash at an office, bank transfers (maker–checker) ──────────────
    async record(p: Principal, input: { accountId?: string; referenceCode?: string; channel: "OFFICE_CASH" | "BANK_TRANSFER"; amountMinor: number; receiptNo: string; note?: string }) {
      authorize(p, "topup:record_cash");
      const b = input.accountId
        ? await db.beneficiary.findUnique({ where: { accountId: input.accountId } })
        : await db.beneficiary.findUnique({ where: { referenceCode: (input.referenceCode ?? "").trim().toUpperCase() } });
      if (!b) throw notFound("balance");
      if (input.amountMinor < 100 || input.amountMinor > TOP_UP_LIMITS.maxMinor) throw badRequest("amount out of range", "amount_out_of_range");
      return db.$transaction(async (tx) => {
        const dup = await tx.topUp.findFirst({ where: { channel: input.channel, receiptNo: input.receiptNo, status: { not: "REJECTED" } } });
        if (dup) throw conflict("this receipt or bank transaction is already recorded", "duplicate_receipt");
        const t = await tx.topUp.create({
          data: {
            beneficiaryAccountId: b.accountId, channel: input.channel, provider: input.channel === "BANK_TRANSFER" ? "bank" : null,
            amountMinor: BigInt(input.amountMinor), status: "PENDING_APPROVAL", createdBy: p.userId, receiptNo: input.receiptNo, note: input.note ?? null,
          },
        });
        await writeOutbox(tx, audit({ actorId: p.userId, action: "topup:record_cash", resource: { type: "top_up", id: t.id }, outcome: "EXECUTED", reason: `${input.channel} ${input.receiptNo}` }));
        return topUpView(t);
      });
    },

    async decide(p: Principal, id: string, decision: "approve" | "reject", reason?: string) {
      authorize(p, "topup:approve_cash");
      const t = await db.topUp.findUnique({ where: { id } });
      if (!t || t.status !== "PENDING_APPROVAL") throw t ? conflict("already decided", "invalid_state") : notFound("top-up");
      if (t.createdBy === p.userId) throw forbidden("someone else must approve what you recorded", "maker_checker");
      await db.$transaction(async (tx) => {
        const { count } = await tx.topUp.updateMany({ where: { id, status: "PENDING_APPROVAL" }, data: { approvedBy: p.userId } });
        if (count === 0) throw conflict("already decided", "invalid_state");
        if (decision === "reject") {
          await tx.topUp.update({ where: { id }, data: { status: "REJECTED", failure: reason ?? "rejected", completedAt: now() } });
        } else {
          const b = await tx.beneficiary.findUniqueOrThrow({ where: { accountId: t.beneficiaryAccountId } });
          const source = t.channel === "OFFICE_CASH" ? accounts.cashReceipts(b.cityId) : accounts.clearing("bank");
          await credit(tx, t, source, p.userId);
        }
        await writeOutbox(tx, audit({ actorId: p.userId, action: decision === "approve" ? "topup:approve_cash" : "topup:reject_cash", resource: { type: "top_up", id }, outcome: "EXECUTED", ...(reason ? { reason } : {}) }));
      });
      return topUpView(await db.topUp.findUniqueOrThrow({ where: { id } }));
    },

    async list(p: Principal, q: { status?: string; channel?: string; cityId?: string }) {
      // the cities whose top-ups this person may see: finance's cash roles and balance readers
      const reach = new Set<string>();
      let everywhere = false;
      for (const perm of ["topup:record_cash", "topup:approve_cash", "balance:read"] as const) {
        const c = citiesWith(p, perm);
        if (c === "*") everywhere = true;
        else c.forEach((x) => reach.add(x));
      }
      if (!everywhere && reach.size === 0) authorize(p, "balance:read"); // throws the usual 403
      if (q.cityId && !everywhere && !reach.has(q.cityId)) throw forbidden("missing permission balance:read");
      const cities = q.cityId ? [q.cityId] : everywhere ? null : [...reach];
      // a top-up has no city of its own: it's the city of the balance it credits
      const accountIds = cities ? (await db.beneficiary.findMany({ where: { cityId: { in: cities } }, select: { accountId: true } })).map((b) => b.accountId) : null;
      const rows = await db.topUp.findMany({
        where: { ...(q.status ? { status: q.status } : {}), ...(q.channel ? { channel: q.channel } : {}), ...(accountIds ? { beneficiaryAccountId: { in: accountIds } } : {}) },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return rows.map(topUpView);
    },

    async reconcile(olderThanSeconds: number) {
      const open = await db.topUp.findMany({ where: { status: "ACTION_REQUIRED", updatedAt: { lt: new Date(now().getTime() - olderThanSeconds * 1000) } }, take: 50 });
      let fixed = 0;
      for (const t of open) {
        const notice = await gateways.get(t.provider!).query("charge", makeReference("topup", t.id)).catch(() => null);
        if (notice && notice.status !== "PENDING") {
          await this.applyNotice(notice);
          fixed++;
        }
      }
      return fixed;
    },
  };
}

export type TopUps = ReturnType<typeof createTopUps>;
