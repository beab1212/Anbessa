// Write-offs (Payment.md §16, workflow 09 E): the debt of a balance whose payment due stayed
// overdue (90 days by default, Payment.md Q8) is written off as bad debt. A finance officer asks
// for the whole debt; a finance manager approves, never the same person. Approval re-checks that
// the debt is unchanged and still overdue long enough. The dues become WRITTEN_OFF.
//
// Ledger: BAD_DEBT_EXPENSE −X, BENEFICIARY_BALANCE +X     (key write-off:<id>)

import { authorize, can, type Principal } from "@ride-app/shared-authz";
import { Prisma, type WriteOff } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { accounts, post } from "../ledger/ledger.js";
import { audit, writeOutbox } from "../outbox/outbox.js";
import { afterPosting, beneficiariesOf, beneficiaryOf, findBeneficiary, type BeneficiarySummary } from "./balances.js";
import { DECISION_TTL_MS, writeOffProblem } from "./controls.js";
import { cityFilter, reachOf, reachesAnything } from "./reach.js";

const DAY_MS = 86_400_000;

export function writeOffView(w: WriteOff, b?: BeneficiarySummary) {
  return {
    id: w.id, accountId: w.beneficiaryAccountId, cityId: w.cityId, amountMinor: Number(w.amountMinor), reason: w.reason, status: w.status,
    requestedBy: w.requestedBy, decidedBy: w.decidedBy, decisionReason: w.decisionReason, journalEntryId: w.journalEntryId,
    createdAt: w.createdAt, decidedAt: w.decidedAt, expiresAt: w.expiresAt,
    ...(b ? { beneficiary: b.beneficiary, referenceCode: b.referenceCode, balanceMinor: b.balanceMinor, state: b.state } : {}),
  };
}

const VIEWERS = ["writeoff:request", "writeoff:approve", "balance:read"] as const;
const DECIDERS = ["writeoff:request", "writeoff:approve"] as const;

export function createWriteOffs(deps: { db: Db; afterDays: number; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  async function withOwners(rows: WriteOff[]) {
    const owners = await beneficiariesOf(db, rows.map((r) => r.beneficiaryAccountId));
    return rows.map((r) => writeOffView(r, owners.get(r.beneficiaryAccountId)));
  }

  return {
    afterDays: deps.afterDays,

    /** Balances that may be written off now, oldest overdue first, without an open request. */
    async candidates(p: Principal, q: { cityId?: string | undefined }) {
      const where = cityFilter(reachOf(p, VIEWERS), q.cityId, "balance:read");
      const rows = await db.beneficiary.findMany({
        where: {
          ...where, overdueSince: { lte: new Date(now().getTime() - deps.afterDays * DAY_MS) }, account: { balanceMinor: { lt: 0 } },
        },
        include: { account: { select: { balanceMinor: true } } },
        orderBy: { overdueSince: "asc" },
        take: 200,
      });
      const open = new Set((await db.writeOff.findMany({
        where: { status: "PENDING_APPROVAL", beneficiaryAccountId: { in: rows.map((r) => r.accountId) } }, select: { beneficiaryAccountId: true },
      })).map((w) => w.beneficiaryAccountId));
      return rows.filter((r) => !open.has(r.accountId)).map((r) => ({
        accountId: r.accountId, beneficiary: beneficiaryOf(r), cityId: r.cityId, referenceCode: r.referenceCode, state: r.state,
        balanceMinor: Number(r.account.balanceMinor), overdueSince: r.overdueSince,
        overdueDays: r.overdueSince ? Math.floor((now().getTime() - r.overdueSince.getTime()) / DAY_MS) : null,
      }));
    },

    async request(p: Principal, input: { accountId?: string | undefined; referenceCode?: string | undefined; reason: string }) {
      const found = await findBeneficiary(db, input);
      const b = found ? await db.beneficiary.findUnique({ where: { accountId: found.accountId }, include: { account: true } }) : null;
      if (!b) throw notFound("balance");
      authorize(p, "writeoff:request", { cityId: b.cityId });
      const balance = Number(b.account.balanceMinor);
      const problem = writeOffProblem({ balanceMinor: balance, overdueSince: b.overdueSince, now: now(), afterDays: deps.afterDays });
      if (problem) throw badRequest(problem, "not_eligible");
      try {
        return await db.$transaction(async (tx) => {
          const w = await tx.writeOff.create({
            data: {
              beneficiaryAccountId: b.accountId, cityId: b.cityId, amountMinor: BigInt(-balance), reason: input.reason, requestedBy: p.userId,
              expiresAt: new Date(now().getTime() + DECISION_TTL_MS),
            },
          });
          await writeOutbox(tx, audit({ actorId: p.userId, action: "writeoff:request", resource: { type: "write_off", id: w.id }, outcome: "EXECUTED", reason: input.reason }));
          return writeOffView(w);
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw conflict("a write-off of this balance is already waiting for approval", "already_requested");
        throw err;
      }
    },

    async decide(p: Principal, id: string, decision: "approve" | "reject" | "cancel", reason?: string) {
      const w = await db.writeOff.findUnique({ where: { id } });
      if (!w) throw notFound("write-off");
      if (decision === "cancel") {
        if (w.requestedBy !== p.userId) throw forbidden("only the person who asked can withdraw it");
      } else {
        authorize(p, "writeoff:approve", { cityId: w.cityId });
        if (w.requestedBy === p.userId) throw forbidden("someone else must approve what you asked for", "maker_checker");
        if (decision === "reject" && !reason) throw badRequest("say why", "reason_required");
      }
      if (w.status !== "PENDING_APPROVAL") throw conflict(`the write-off is ${w.status.toLowerCase().replace("_", " ")}`, "invalid_state");
      if (w.expiresAt < now()) {
        await db.writeOff.updateMany({ where: { id, status: "PENDING_APPROVAL" }, data: { status: "EXPIRED" } });
        throw conflict("the request expired; ask again", "expired");
      }

      await db.$transaction(async (tx) => {
        const { count } = await tx.writeOff.updateMany({ where: { id, status: "PENDING_APPROVAL", decidedBy: null }, data: { decidedBy: p.userId } });
        if (count === 0) throw conflict("the write-off was already decided", "invalid_state");
        if (decision !== "approve") {
          await tx.writeOff.update({ where: { id }, data: { status: decision === "reject" ? "REJECTED" : "CANCELLED", decidedAt: now(), decisionReason: reason ?? null } });
        } else {
          // lock the balance, then check again: a payment since the request changes what is owed
          await tx.$queryRaw`SELECT id FROM ledger_account WHERE id = ${w.beneficiaryAccountId}::uuid FOR UPDATE`;
          const b = await tx.beneficiary.findUniqueOrThrow({ where: { accountId: w.beneficiaryAccountId }, include: { account: true } });
          const balance = Number(b.account.balanceMinor);
          const problem = writeOffProblem({ balanceMinor: balance, overdueSince: b.overdueSince, now: now(), afterDays: deps.afterDays });
          if (problem) throw conflict(problem, "not_eligible");
          if (-balance !== Number(w.amountMinor)) throw conflict(`the balance is now ${balance / 100} ETB, not ${-Number(w.amountMinor) / 100} ETB; reject this and ask again`, "balance_changed");
          const amount = Number(w.amountMinor);
          const posted = await post(tx, {
            kind: "WRITE_OFF", referenceType: "write_off", referenceId: w.id, idempotencyKey: `write-off:${w.id}`, createdBy: p.userId, memo: "uncollectable debt written off",
            lines: [{ account: accounts.badDebt(), amountMinor: -amount }, { account: { id: b.accountId }, amountMinor: amount }],
          });
          if (!posted.created) throw conflict("the write-off was already posted", "invalid_state");
          // forgiven, not paid: the notices close as WRITTEN_OFF before the state is recomputed
          await tx.paymentDue.updateMany({ where: { beneficiaryAccountId: b.accountId, status: { in: ["OPEN", "OVERDUE", "MIN_PAID"] } }, data: { status: "WRITTEN_OFF" } });
          const after = await afterPosting(tx, b.accountId, { creditMinor: 0, now: now() });
          await tx.writeOff.update({ where: { id }, data: { status: "EXECUTED", journalEntryId: posted.entryId, decidedAt: now(), decisionReason: reason ?? null } });
          await writeOutbox(tx, {
            topic: "balance.written_off", key: b.ownerId,
            payload: { writeOffId: w.id, accountId: b.accountId, beneficiary: beneficiaryOf(b), amountMinor: amount, balanceMinor: after.balanceMinor, currency: "ETB" },
          });
        }
        await writeOutbox(tx, audit({
          actorId: p.userId, action: decision === "approve" ? "writeoff:approve" : `writeoff:${decision}`,
          resource: { type: "write_off", id }, outcome: "EXECUTED", ...(reason ? { reason } : {}),
        }));
      });
      return this.get(p, id);
    },

    async get(p: Principal, id: string) {
      const w = await db.writeOff.findUnique({ where: { id } });
      if (!w || (!VIEWERS.some((perm) => can(p, perm, { cityId: w.cityId })) && w.requestedBy !== p.userId)) throw notFound("write-off");
      return (await withOwners([w]))[0]!;
    },

    async list(p: Principal, q: { status?: string | undefined; accountId?: string | undefined; cityId?: string | undefined }) {
      const where = cityFilter(reachOf(p, VIEWERS), q.cityId, "balance:read");
      const rows = await db.writeOff.findMany({
        where: { ...where, ...(q.status ? { status: q.status } : {}), ...(q.accountId ? { beneficiaryAccountId: q.accountId } : {}) },
        orderBy: { createdAt: "desc" }, take: 100,
      });
      return withOwners(rows);
    },

    async pending(p: Principal) {
      const r = reachOf(p, DECIDERS);
      if (!reachesAnything(r)) return [];
      const rows = await db.writeOff.findMany({ where: { status: "PENDING_APPROVAL", ...(r.everywhere ? {} : { cityId: { in: r.cities } }) }, orderBy: { createdAt: "asc" }, take: 200 });
      return withOwners(rows);
    },

    async expire() {
      const { count } = await db.writeOff.updateMany({ where: { status: "PENDING_APPROVAL", expiresAt: { lt: now() } }, data: { status: "EXPIRED" } });
      return count;
    },
  };
}

export type WriteOffs = ReturnType<typeof createWriteOffs>;
