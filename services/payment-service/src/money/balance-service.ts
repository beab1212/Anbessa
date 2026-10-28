// Reading balances: an owner's own (driver app, fleet portal), finance's list and overview, the
// statement (every posting with what caused it), and the internal state lookup fleet-service uses
// when a driver goes online.

import { authorize, citiesWith, type Principal } from "@ride-app/shared-authz";
import type { BalanceState, Beneficiary } from "@ride-app/shared-types";
import { Prisma } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import type { Gateways } from "../gateways/index.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { integrity } from "../ledger/ledger.js";
import { audit, writeOutbox } from "../outbox/outbox.js";
import { assertBalanceOwner, assertBalanceReadable } from "./access.js";
import { balanceView, beneficiaryOf, ensureBeneficiary, maskDestination, policyAt } from "./balances.js";
import { cashAllowed, suggestedTopUp } from "./rules.js";

export function createBalanceService(deps: { db: Db; gateways: Gateways; now?: () => Date; /** payouts wait this long after a payout method change */ payoutCoolOffMs?: number }) {
  const { db, gateways } = deps;
  const now = deps.now ?? (() => new Date());

  /** A beneficiary who has no trips yet shows a zero balance (nothing is created by reading). */
  async function emptyView(b: Beneficiary, cityId: string) {
    const policy = await db.$transaction((tx) => policyAt(tx, cityId, now()));
    return {
      accountId: null, beneficiary: b, cityId, balanceMinor: 0, currency: "ETB", state: "OK" as BalanceState, cashAllowed: true,
      stateChangedAt: null, overdueSince: null, referenceCode: null, payoutMethod: null, suggestedTopUpMinor: suggestedTopUp(0, policy),
      policy: { mode: policy.mode, warningMinor: policy.warningMinor, cashLimitMinor: policy.cashLimitMinor, hardLimitMinor: policy.hardLimitMinor, prepaidMinimumMinor: policy.prepaidMinimumMinor, minPayoutMinor: policy.minPayoutMinor, dueDays: policy.dueDays, builtIn: policy.validFrom === null, override: null },
      dues: [],
    };
  }

  async function forOwner(p: Principal, b: Beneficiary, cityId: string, create: boolean) {
    assertBalanceReadable(p, { type: b.type, ownerId: b.id, cityId });
    let row = await db.beneficiary.findUnique({ where: { type_ownerId: { type: b.type, ownerId: b.id } } });
    if (!row && create) {
      assertBalanceOwner(p, { type: b.type, ownerId: b.id, cityId });
      row = await db.$transaction((tx) => ensureBeneficiary(tx, b, cityId));
    }
    if (!row) return emptyView(b, cityId);
    return db.$transaction((tx) => balanceView(tx, row.accountId, now()));
  }

  async function readable(p: Principal, accountId: string) {
    const b = await db.beneficiary.findUnique({ where: { accountId } });
    if (!b) throw notFound("balance");
    assertBalanceReadable(p, b);
    return b;
  }

  return {
    /** The driver's own balance (owner-driver). `create` opens the account so they can top up before a first trip. */
    mine: (p: Principal, cityId: string, create = false) => forOwner(p, { type: "INDIVIDUAL", id: p.userId }, cityId, create),

    /** A fleet company's balance (fleet owner @ ORG, finance). */
    org: (p: Principal, orgId: string, cityId: string, create = false) => forOwner(p, { type: "ORGANIZATION", id: orgId }, cityId, create),

    async get(p: Principal, accountId: string) {
      await readable(p, accountId);
      return db.$transaction((tx) => balanceView(tx, accountId, now()));
    },

    /** Postings on the balance, newest first, with what caused each. */
    async statement(p: Principal, accountId: string, q: { before?: Date; limit: number }) {
      await readable(p, accountId);
      const rows = await db.posting.findMany({
        where: { accountId, ...(q.before ? { createdAt: { lt: q.before } } : {}) },
        include: { journalEntry: true }, orderBy: { createdAt: "desc" }, take: q.limit,
      });
      return {
        entries: rows.map((r) => ({
          id: r.id, at: r.createdAt, amountMinor: Number(r.amountMinor), kind: r.journalEntry.kind, memo: r.journalEntry.memo,
          reference: { type: r.journalEntry.referenceType, id: r.journalEntry.referenceId }, entryId: r.journalEntryId,
        })),
        next: rows.length === q.limit ? rows.at(-1)!.createdAt.toISOString() : null,
      };
    },

    /**
     * Where payouts go (the owner sets it; finance sees it masked). A change takes effect after a
     * cooling-off period (payout runs hold the balance until then) and the owner is told through
     * `payout_method.changed`, so a hijacked account can't quietly redirect the next payout.
     */
    async setPayoutMethod(p: Principal, accountId: string, input: { provider: string; destination: string }) {
      const b = await readable(p, accountId);
      assertBalanceOwner(p, b);
      if (!gateways.has(input.provider)) throw badRequest("that payout provider isn't available", "unknown_provider");
      const destination = input.destination.replace(/[\s-]/g, "");
      if (!/^\+?\d{6,20}$/.test(destination)) throw badRequest("a phone number or account number, digits only", "invalid_destination");
      await db.$transaction(async (tx) => {
        // the row lock orders concurrent changes, so each one is told with the right "previous"
        await tx.$queryRaw`SELECT account_id FROM beneficiary WHERE account_id = ${accountId}::uuid FOR UPDATE`;
        const before = await tx.beneficiary.findUniqueOrThrow({ where: { accountId } });
        if (before.payoutProvider === input.provider && before.payoutDestination === destination) return; // nothing changed
        const at = now();
        // the first payout method replaces nothing a thief could redirect: no cooling-off for it
        const first = !before.payoutProvider && !before.payoutDestination;
        const u = await tx.beneficiary.update({ where: { accountId }, data: { payoutProvider: input.provider, payoutDestination: destination, payoutMethodChangedAt: first ? null : at } });
        await writeOutbox(tx,
          {
            topic: "payout_method.changed", key: u.ownerId,
            payload: {
              accountId, beneficiary: beneficiaryOf(u), provider: input.provider, destinationMasked: maskDestination(destination)!,
              previousProvider: before.payoutProvider, previousDestinationMasked: maskDestination(before.payoutDestination),
              changedBy: p.userId, changedAt: at.toISOString(), payoutsResumeAt: new Date(at.getTime() + (first ? 0 : deps.payoutCoolOffMs ?? 0)).toISOString(),
            },
          },
          audit({ actorId: p.userId, action: "payout_method:set", resource: { type: "beneficiary", id: accountId }, outcome: "EXECUTED", reason: input.provider }),
        );
      });
      return db.$transaction((tx) => balanceView(tx, accountId, now()));
    },

    /** Finance: balances by state, city and kind; the most negative first. */
    async list(p: Principal, q: { state?: string; cityId?: string; type?: string; q?: string; limit: number; offset: number }) {
      const cities = citiesWith(p, "balance:read");
      if (cities !== "*" && cities.length === 0) throw forbidden("missing permission balance:read");
      if (q.cityId && cities !== "*" && !cities.includes(q.cityId)) throw forbidden("missing permission balance:read for that city");
      const where: Prisma.BeneficiaryWhereInput = {
        ...(q.state ? { state: q.state } : {}), ...(q.type ? { type: q.type } : {}),
        ...(q.cityId ? { cityId: q.cityId } : cities === "*" ? {} : { cityId: { in: cities } }),
        ...(q.q ? { OR: [{ referenceCode: { contains: q.q.toUpperCase() } }, ...(/^[0-9a-f-]{36}$/i.test(q.q) ? [{ ownerId: q.q }, { accountId: q.q }] : [])] } : {}),
      };
      const [rows, total] = await Promise.all([
        db.beneficiary.findMany({ where, include: { account: true }, orderBy: { account: { balanceMinor: "asc" } }, take: q.limit, skip: q.offset }),
        db.beneficiary.count({ where }),
      ]);
      return {
        total,
        balances: rows.map((b) => ({
          accountId: b.accountId, beneficiary: { type: b.type, id: b.ownerId }, cityId: b.cityId, balanceMinor: Number(b.account.balanceMinor),
          state: b.state, cashAllowed: cashAllowed(b.state as BalanceState), referenceCode: b.referenceCode, overdueSince: b.overdueSince,
          payoutReady: !!(b.payoutProvider && b.payoutDestination),
        })),
      };
    },

    /** Finance overview: what the platform holds, is owed and owes. */
    async overview(p: Principal) {
      if (citiesWith(p, "balance:read") !== "*" && citiesWith(p, "report:read_finance") !== "*") authorize(p, "report:read_finance");
      const since = new Date(now().getTime() - 7 * 86_400_000);
      const [kinds, states, payments, topUps, refunds, batches, commission7d, settledCount] = await Promise.all([
        db.$queryRaw<{ kind: string; positive: bigint; negative: bigint; n: bigint }[]>`
          SELECT kind, coalesce(sum(balance_minor) FILTER (WHERE balance_minor > 0), 0)::bigint AS positive,
                 coalesce(sum(balance_minor) FILTER (WHERE balance_minor < 0), 0)::bigint AS negative, count(*) AS n
          FROM ledger_account GROUP BY kind`,
        db.beneficiary.groupBy({ by: ["state"], _count: true }),
        db.payment.groupBy({ by: ["status"], _count: true, _sum: { amountMinor: true } }),
        db.topUp.groupBy({ by: ["status"], _count: true }),
        db.refund.groupBy({ by: ["status"], _count: true }),
        db.payoutBatch.findMany({ where: { status: { in: ["PENDING_APPROVAL", "SENDING"] } }, select: { id: true, status: true, totalMinor: true, cycleEnd: true } }),
        db.tripSettlement.aggregate({ where: { settledAt: { gte: since } }, _sum: { commissionMinor: true, vatMinor: true, fareMinor: true } }),
        db.tripSettlement.groupBy({ by: ["paymentMethod"], where: { settledAt: { gte: since }, purpose: "TRIP_FARE" }, _count: true }),
      ]);
      const clearing = await db.ledgerAccount.findMany({ where: { kind: "PROVIDER_CLEARING" }, select: { ownerId: true, balanceMinor: true } });
      return {
        accounts: Object.fromEntries(kinds.map((k) => [k.kind, { positiveMinor: Number(k.positive), negativeMinor: Number(k.negative), count: Number(k.n) }])),
        providers: clearing.map((c) => ({ provider: c.ownerId, balanceMinor: Number(c.balanceMinor) })),
        states: Object.fromEntries(states.map((s) => [s.state, s._count])),
        payments: Object.fromEntries(payments.map((x) => [x.status, { count: x._count, amountMinor: Number(x._sum.amountMinor ?? 0n) }])),
        topUps: Object.fromEntries(topUps.map((x) => [x.status, x._count])),
        refunds: Object.fromEntries(refunds.map((x) => [x.status, x._count])),
        openBatches: batches.map((b) => ({ id: b.id, status: b.status, totalMinor: Number(b.totalMinor), cycleEnd: b.cycleEnd.toISOString().slice(0, 10) })),
        last7Days: {
          fareMinor: Number(commission7d._sum.fareMinor ?? 0n), commissionMinor: Number(commission7d._sum.commissionMinor ?? 0n),
          vatMinor: Number(commission7d._sum.vatMinor ?? 0n), tripsByMethod: Object.fromEntries(settledCount.map((s) => [s.paymentMethod, s._count])),
        },
      };
    },

    async integrity(p: Principal) {
      if (citiesWith(p, "report:read_finance") !== "*" && citiesWith(p, "system:read") !== "*") authorize(p, "report:read_finance");
      return integrity(db);
    },

    /** fleet-service at session start (Payment.md §14): the authoritative state. */
    async stateOf(type: "INDIVIDUAL" | "ORGANIZATION", ownerId: string) {
      const b = await db.beneficiary.findUnique({ where: { type_ownerId: { type, ownerId } }, include: { account: true } });
      if (!b) return { state: "OK" as BalanceState, cashAllowed: true, balanceMinor: 0, known: false };
      return { state: b.state as BalanceState, cashAllowed: cashAllowed(b.state as BalanceState), balanceMinor: Number(b.account.balanceMinor), known: true };
    },
  };
}

export type BalanceService = ReturnType<typeof createBalanceService>;
