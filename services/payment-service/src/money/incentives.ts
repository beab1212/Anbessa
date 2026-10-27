// Driver incentives (workflow 15 E, Role.md §11 "budget cap"): "complete N trips in city X between
// two dates, earn Y". Operations proposes (in its city); a finance manager approves, never the same
// person; the limits are checked on both. When the window closes, a job counts each driver's
// settled trips (trip_settlement, TRIP_FARE) and credits those who reached the target, first come
// first served within the budget. Each driver is credited once per program and balance (unique
// award + journal key), so a rerun pays nothing twice.
//
// The money goes where the trips' money went: the driver's own balance, or their fleet's for
// trips in fleet cars (the fleet settles with its drivers privately, Payment.md §11).
// Ledger: PROMO_EXPENSE:<city> −X, BENEFICIARY_BALANCE +X   (key incentive:<programId>:<driverId>:<accountId>)

import { authorize, can, type Principal } from "@ride-app/shared-authz";
import type { Logger } from "@ride-app/shared-utils";
import { Prisma, type IncentiveAward, type IncentiveProgram } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { accounts, post } from "../ledger/ledger.js";
import { audit, writeOutbox } from "../outbox/outbox.js";
import { afterPosting, beneficiaryOf } from "./balances.js";
import { DECISION_TTL_MS, incentiveAwards, incentiveProblem, type DriverCount } from "./controls.js";
import { cityFilter, reachOf, reachesAnything } from "./reach.js";

type Tx = Prisma.TransactionClient;

export interface IncentiveInput {
  cityId: string;
  name: string;
  vehicleType: string | null;
  targetTrips: number;
  rewardMinor: number;
  budgetMinor: number;
  startsAt: Date;
  endsAt: Date;
  reason: string;
}

export function programView(x: IncentiveProgram) {
  return {
    id: x.id, cityId: x.cityId, name: x.name, vehicleType: x.vehicleType, targetTrips: x.targetTrips, rewardMinor: Number(x.rewardMinor),
    budgetMinor: Number(x.budgetMinor), startsAt: x.startsAt, endsAt: x.endsAt, reason: x.reason, status: x.status, proposedBy: x.proposedBy,
    decidedBy: x.decidedBy, decisionReason: x.decisionReason, createdAt: x.createdAt, decidedAt: x.decidedAt, expiresAt: x.expiresAt,
    closedAt: x.closedAt, qualifiedCount: x.qualifiedCount, awardsCount: x.awardsCount, spentMinor: Number(x.spentMinor),
  };
}

const awardView = (a: IncentiveAward) => ({
  id: a.id, programId: a.programId, driverId: a.driverId, accountId: a.beneficiaryAccountId, trips: a.trips, amountMinor: Number(a.amountMinor),
  journalEntryId: a.journalEntryId, createdAt: a.createdAt,
});

const VIEWERS = ["incentive:propose", "incentive:approve", "report:read_finance"] as const;
const DECIDERS = ["incentive:propose", "incentive:approve"] as const;

/** Each driver's settled trips in the program's window, per balance their money went to. */
async function driverCounts(tx: Pick<Tx, "$queryRaw">, x: Pick<IncentiveProgram, "cityId" | "vehicleType" | "startsAt" | "endsAt" | "targetTrips">, onlyDriver?: string) {
  const rows = await tx.$queryRaw<{ driver_id: string; account_id: string; trips: bigint; reached_at: Date | null }[]>`
    SELECT driver_id::text AS driver_id, beneficiary_account_id::text AS account_id, count(*) AS trips,
      (array_agg(settled_at ORDER BY settled_at))[${x.targetTrips}::int] AS reached_at
    FROM trip_settlement
    WHERE purpose = 'TRIP_FARE' AND city_id = ${x.cityId} AND settled_at >= ${x.startsAt} AND settled_at < ${x.endsAt}
      AND driver_id IS NOT NULL AND beneficiary_account_id IS NOT NULL
      ${x.vehicleType ? Prisma.sql`AND vehicle_type = ${x.vehicleType}` : Prisma.empty}
      ${onlyDriver ? Prisma.sql`AND driver_id = ${onlyDriver}::uuid` : Prisma.empty}
    GROUP BY driver_id, beneficiary_account_id
    ORDER BY count(*) DESC
    LIMIT 5000`;
  return rows.map((r): DriverCount => ({ driverId: r.driver_id, beneficiaryAccountId: r.account_id, trips: Number(r.trips), reachedAt: r.reached_at }));
}

export function createIncentives(deps: { db: Db; logger?: Logger; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  /** Pay one program whose window closed (once: the program row is locked, awards are unique). */
  async function close(programId: string) {
    return db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM incentive_program WHERE id = ${programId}::uuid AND status = 'APPROVED' FOR UPDATE SKIP LOCKED`;
      if (locked.length === 0) return null;
      const x = await tx.incentiveProgram.findUniqueOrThrow({ where: { id: programId } });
      if (x.endsAt > now()) return null;
      const counts = await driverCounts(tx, x);
      const { awarded, overBudget } = incentiveAwards(counts, { targetTrips: x.targetTrips, rewardMinor: Number(x.rewardMinor), budgetMinor: Number(x.budgetMinor) });
      const reward = Number(x.rewardMinor);
      let spent = 0;
      let paid = 0;
      for (const c of awarded) {
        const b = await tx.beneficiary.findUnique({ where: { accountId: c.beneficiaryAccountId } });
        if (!b) continue;
        const posted = await post(tx, {
          kind: "INCENTIVE", referenceType: "incentive_program", referenceId: x.id, idempotencyKey: `incentive:${x.id}:${c.driverId}:${c.beneficiaryAccountId}`,
          memo: `incentive: ${x.name}`,
          lines: [{ account: accounts.promo(x.cityId), amountMinor: -reward }, { account: { id: b.accountId }, amountMinor: reward }],
        });
        if (!posted.created) continue;
        const award = await tx.incentiveAward.create({
          data: { programId: x.id, driverId: c.driverId, beneficiaryAccountId: b.accountId, trips: c.trips, amountMinor: BigInt(reward), journalEntryId: posted.entryId },
        });
        const after = await afterPosting(tx, b.accountId, { creditMinor: reward, now: now() });
        await writeOutbox(tx, {
          topic: "incentive.awarded", key: b.ownerId,
          payload: {
            awardId: award.id, programId: x.id, programName: x.name, cityId: x.cityId, driverId: c.driverId, accountId: b.accountId,
            beneficiary: beneficiaryOf(b), trips: c.trips, amountMinor: reward, balanceMinor: after.balanceMinor, currency: "ETB",
          },
        });
        spent += reward;
        paid++;
      }
      const closed = await tx.incentiveProgram.update({
        where: { id: x.id },
        data: { status: "CLOSED", closedAt: now(), qualifiedCount: awarded.length + overBudget.length, awardsCount: { increment: paid }, spentMinor: { increment: BigInt(spent) } },
      });
      await writeOutbox(tx, audit({
        actorId: null, action: "incentive:close", resource: { type: "incentive_program", id: x.id }, outcome: "EXECUTED",
        reason: `${paid} paid, ${overBudget.length} over budget`,
      }));
      return programView(closed);
    });
  }

  return {
    close,

    async propose(p: Principal, input: IncentiveInput) {
      authorize(p, "incentive:propose", { cityId: input.cityId });
      const problem = incentiveProblem(input, now());
      if (problem) throw badRequest(problem, "invalid_incentive");
      return db.$transaction(async (tx) => {
        const x = await tx.incentiveProgram.create({
          data: {
            cityId: input.cityId, name: input.name, vehicleType: input.vehicleType, targetTrips: input.targetTrips, rewardMinor: BigInt(input.rewardMinor),
            budgetMinor: BigInt(input.budgetMinor), startsAt: input.startsAt, endsAt: input.endsAt, reason: input.reason, proposedBy: p.userId,
            expiresAt: new Date(now().getTime() + DECISION_TTL_MS),
          },
        });
        await writeOutbox(tx, audit({ actorId: p.userId, action: "incentive:propose", resource: { type: "incentive_program", id: x.id }, outcome: "EXECUTED", reason: input.reason }));
        return programView(x);
      });
    },

    async decide(p: Principal, id: string, decision: "approve" | "reject" | "cancel", reason?: string) {
      const x = await db.incentiveProgram.findUnique({ where: { id } });
      if (!x) throw notFound("incentive");
      if (decision === "cancel") {
        if (x.proposedBy !== p.userId) throw forbidden("only the person who proposed it can withdraw it");
      } else {
        authorize(p, "incentive:approve", { cityId: x.cityId });
        if (x.proposedBy === p.userId) throw forbidden("someone else must approve your own proposal", "maker_checker");
        if (decision === "reject" && !reason) throw badRequest("say why", "reason_required");
      }
      if (x.status !== "PENDING_APPROVAL") throw conflict(`the incentive is ${x.status.toLowerCase().replace("_", " ")}`, "invalid_state");
      if (x.expiresAt < now()) {
        await db.incentiveProgram.updateMany({ where: { id, status: "PENDING_APPROVAL" }, data: { status: "EXPIRED" } });
        throw conflict("the proposal expired; propose it again", "expired");
      }
      if (decision === "approve") {
        const problem = incentiveProblem({ targetTrips: x.targetTrips, rewardMinor: Number(x.rewardMinor), budgetMinor: Number(x.budgetMinor), startsAt: x.startsAt, endsAt: x.endsAt }, now());
        if (problem) throw conflict(problem, "invalid_incentive");
      }
      await db.$transaction(async (tx) => {
        const status = decision === "approve" ? "APPROVED" : decision === "reject" ? "REJECTED" : "CANCELLED";
        const { count } = await tx.incentiveProgram.updateMany({
          where: { id, status: "PENDING_APPROVAL" }, data: { status, decidedBy: p.userId, decidedAt: now(), decisionReason: reason ?? null },
        });
        if (count === 0) throw conflict("the incentive was already decided", "invalid_state");
        await writeOutbox(tx, audit({
          actorId: p.userId, action: decision === "approve" ? "incentive:approve" : `incentive:${decision}`,
          resource: { type: "incentive_program", id }, outcome: "EXECUTED", ...(reason ? { reason } : {}),
        }));
      });
      return programView(await db.incentiveProgram.findUniqueOrThrow({ where: { id } }));
    },

    /** One program with each driver's progress (top 100) and what was paid. */
    async get(p: Principal, id: string) {
      const x = await db.incentiveProgram.findUnique({ where: { id } });
      if (!x || (!VIEWERS.some((perm) => can(p, perm, { cityId: x.cityId })) && x.proposedBy !== p.userId)) throw notFound("incentive");
      const [counts, awards] = await Promise.all([
        x.status === "APPROVED" || x.status === "CLOSED" ? driverCounts(db, x) : Promise.resolve([]),
        db.incentiveAward.findMany({ where: { programId: id }, orderBy: { createdAt: "asc" } }),
      ]);
      return {
        ...programView(x),
        progress: counts.slice(0, 100).map((c) => ({ ...c, reached: c.trips >= x.targetTrips })),
        awards: awards.map(awardView),
      };
    },

    async list(p: Principal, q: { status?: string | undefined; cityId?: string | undefined }) {
      const where = cityFilter(reachOf(p, VIEWERS), q.cityId, "incentive:propose");
      const rows = await db.incentiveProgram.findMany({ where: { ...where, ...(q.status ? { status: q.status } : {}) }, orderBy: { createdAt: "desc" }, take: 100 });
      return rows.map(programView);
    },

    async pending(p: Principal) {
      const r = reachOf(p, DECIDERS);
      if (!reachesAnything(r)) return [];
      const rows = await db.incentiveProgram.findMany({ where: { status: "PENDING_APPROVAL", ...(r.everywhere ? {} : { cityId: { in: r.cities } }) }, orderBy: { createdAt: "asc" }, take: 200 });
      return rows.map(programView);
    },

    /** A driver's view (earnings:read @ SELF): running and recently closed programs in their city, with their own progress. */
    async mine(p: Principal, cityId: string) {
      authorize(p, "earnings:read", { ownerUserIds: [p.userId] });
      const at = now();
      const rows = await db.incentiveProgram.findMany({
        where: { cityId, status: { in: ["APPROVED", "CLOSED"] }, endsAt: { gt: new Date(at.getTime() - 30 * 86_400_000) }, startsAt: { lte: new Date(at.getTime() + 7 * 86_400_000) } },
        orderBy: { endsAt: "asc" }, take: 20,
      });
      const out = [];
      for (const x of rows) {
        const mine = await driverCounts(db, x, p.userId);
        const awards = await db.incentiveAward.findMany({ where: { programId: x.id, driverId: p.userId } });
        out.push({
          id: x.id, name: x.name, cityId: x.cityId, vehicleType: x.vehicleType, targetTrips: x.targetTrips, rewardMinor: Number(x.rewardMinor),
          startsAt: x.startsAt, endsAt: x.endsAt, status: x.status, trips: mine.reduce((n, c) => n + c.trips, 0),
          awardedMinor: awards.reduce((n, a) => n + Number(a.amountMinor), 0),
        });
      }
      return out;
    },

    async expire() {
      const { count } = await db.incentiveProgram.updateMany({ where: { status: "PENDING_APPROVAL", expiresAt: { lt: now() } }, data: { status: "EXPIRED" } });
      return count;
    },

    /** The job: pay every approved program whose window has closed. */
    async closeDue() {
      const due = await db.incentiveProgram.findMany({ where: { status: "APPROVED", endsAt: { lte: now() } }, select: { id: true }, orderBy: { endsAt: "asc" }, take: 20 });
      let closed = 0;
      for (const d of due) {
        try {
          if (await close(d.id)) closed++;
        } catch (err) {
          deps.logger?.error({ err, programId: d.id }, "incentive could not be closed; retried on the next run");
        }
      }
      return closed;
    },
  };
}

export type Incentives = ReturnType<typeof createIncentives>;
