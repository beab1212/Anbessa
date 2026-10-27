// Beneficiary balances (Payment.md §5, §8): the account per driver or fleet company, the policy
// and commission rule in force for a city, and what happens after every posting on a balance:
// credits pay open dues, the state is recomputed, and a change is published (outbox) so matching
// reacts within seconds.

import { randomBytes } from "node:crypto";
import type { Beneficiary, BalanceState } from "@ride-app/shared-types";
import { Prisma, type Beneficiary as BeneficiaryRow, type BalancePolicy, type CommissionRule, type PolicyOverride } from "../generated/prisma/client.js";
import { accountId, accounts } from "../ledger/ledger.js";
import { writeOutbox } from "../outbox/outbox.js";
import { applyOverride, type OverrideFields } from "./controls.js";
import {
  balanceState, cashAllowed, DEFAULT_POLICY, DEFAULT_RULE, dueStatus, suggestedTopUp,
  type CommissionModel, type CommissionRuleLike, type PolicyLike,
} from "./rules.js";

type Tx = Prisma.TransactionClient;

export const policyFromRow = (p: BalancePolicy): PolicyLike => ({
  mode: p.mode as PolicyLike["mode"], warningMinor: Number(p.warningMinor), cashLimitMinor: Number(p.cashLimitMinor),
  hardLimitMinor: Number(p.hardLimitMinor), prepaidMinimumMinor: Number(p.prepaidMinimumMinor), dueDays: p.dueDays,
  minPaymentBp: p.minPaymentBp, minPayoutMinor: Number(p.minPayoutMinor), taxBasis: p.taxBasis as PolicyLike["taxBasis"], vatRateBp: p.vatRateBp,
});

export const ruleFromRow = (r: CommissionRule): CommissionRuleLike => ({
  id: r.id, model: r.model as CommissionModel, rateBp: r.rateBp,
  fixedMinor: r.fixedMinor === null ? null : Number(r.fixedMinor), minMinor: r.minMinor === null ? null : Number(r.minMinor),
  maxMinor: r.maxMinor === null ? null : Number(r.maxMinor),
});

/** The city's policy at a time: the latest approved version, else the built-in default. */
export async function policyAt(tx: Tx, cityId: string, at: Date): Promise<PolicyLike & { validFrom: Date | null }> {
  const row = await tx.balancePolicy.findFirst({ where: { cityId, validFrom: { lte: at } }, orderBy: { validFrom: "desc" } });
  return row ? { ...policyFromRow(row), validFrom: row.validFrom } : { ...DEFAULT_POLICY, validFrom: null };
}

export const overrideFields = (o: PolicyOverride): OverrideFields => ({
  mode: (o.mode as OverrideFields["mode"]) ?? null,
  warningMinor: o.warningMinor === null ? null : Number(o.warningMinor),
  cashLimitMinor: o.cashLimitMinor === null ? null : Number(o.cashLimitMinor),
  hardLimitMinor: o.hardLimitMinor === null ? null : Number(o.hardLimitMinor),
  prepaidMinimumMinor: o.prepaidMinimumMinor === null ? null : Number(o.prepaidMinimumMinor),
});

/**
 * The limits a balance is held to at a time: its city's policy, with the balance's approved
 * override in force at that time (Payment.md §13 beneficiary_policy_override) on top.
 */
export async function effectivePolicyAt(tx: Tx, b: { accountId: string; cityId: string }, at: Date) {
  const city = await policyAt(tx, b.cityId, at);
  const o = await tx.policyOverride.findFirst({
    where: { beneficiaryAccountId: b.accountId, status: "APPROVED", validFrom: { lte: at }, validUntil: { gt: at } },
    orderBy: { validFrom: "desc" },
  });
  return { ...applyOverride(city, o ? overrideFields(o) : null), override: o ? { id: o.id, validFrom: o.validFrom, validUntil: o.validUntil } : null };
}

/** The most specific commission rule valid at a time (Payment.md §7): beneficiary contract → city + vehicle type → city → default. */
export async function ruleAt(tx: Tx, q: { cityId: string; vehicleType: string | null; beneficiaryOwnerId: string | null; at: Date }): Promise<CommissionRuleLike> {
  const rows = await tx.commissionRule.findMany({
    where: {
      cityId: q.cityId, validFrom: { lte: q.at }, OR: [{ validTo: null }, { validTo: { gt: q.at } }],
      AND: [
        { OR: [{ beneficiaryId: null }, ...(q.beneficiaryOwnerId ? [{ beneficiaryId: q.beneficiaryOwnerId }] : [])] },
        { OR: [{ vehicleType: null }, ...(q.vehicleType ? [{ vehicleType: q.vehicleType }] : [])] },
      ],
    },
  });
  const rank = (r: CommissionRule) => (r.beneficiaryId ? 2 : 0) + (r.vehicleType ? 1 : 0);
  const best = rows.sort((a, b) => rank(b) - rank(a))[0];
  return best ? ruleFromRow(best) : DEFAULT_RULE;
}

function referenceCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `ANB-${Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join("")}`;
}

/** The beneficiary's balance account, created with its reference code on first use. */
export async function ensureBeneficiary(tx: Tx, b: Beneficiary, cityId: string): Promise<BeneficiaryRow> {
  const found = await tx.beneficiary.findUnique({ where: { type_ownerId: { type: b.type, ownerId: b.id } } });
  if (found) return found;
  const id = await accountId(tx, accounts.beneficiary(b.type, b.id, cityId));
  for (let i = 0; i < 5; i++) {
    const code = referenceCode();
    const inserted = await tx.$executeRaw`
      INSERT INTO beneficiary (account_id, type, owner_id, city_id, reference_code)
      VALUES (${id}::uuid, ${b.type}, ${b.id}::uuid, ${cityId}, ${code})
      ON CONFLICT DO NOTHING`;
    const row = await tx.beneficiary.findUnique({ where: { accountId: id } });
    if (row) return row;
    if (inserted === 0) continue; // the reference code collided: try another
  }
  throw new Error("could not create the beneficiary");
}

export const beneficiaryOf = (row: Pick<BeneficiaryRow, "type" | "ownerId">): Beneficiary => ({ type: row.type as Beneficiary["type"], id: row.ownerId });

/**
 * After a posting on a beneficiary balance (same transaction): `creditMinor` (> 0 for money in)
 * pays open dues oldest first; then the state is recomputed and a change published.
 */
export async function afterPosting(tx: Tx, beneficiaryAccountId: string, opts: { creditMinor: number; now: Date }) {
  const b = await tx.beneficiary.findUniqueOrThrow({ where: { accountId: beneficiaryAccountId }, include: { account: true } });
  const balance = Number(b.account.balanceMinor);

  let credit = Math.max(0, opts.creditMinor);
  if (credit > 0) {
    const dues = await tx.paymentDue.findMany({ where: { beneficiaryAccountId, status: { in: ["OPEN", "OVERDUE", "MIN_PAID"] } }, orderBy: { cycleEnd: "asc" } });
    for (const d of dues) {
      if (credit <= 0) break;
      const remaining = Number(d.amountMinor - d.paidMinor);
      const pay = Math.min(credit, remaining);
      credit -= pay;
      const paid = Number(d.paidMinor) + pay;
      const status = dueStatus({ amountMinor: Number(d.amountMinor), minimumMinor: Number(d.minimumMinor), paidMinor: paid, overdue: d.status === "OVERDUE" });
      await tx.paymentDue.update({ where: { id: d.id }, data: { paidMinor: BigInt(paid), status } });
    }
  }
  // a balance back at zero or above settles every notice
  if (balance >= 0) await tx.paymentDue.updateMany({ where: { beneficiaryAccountId, status: { in: ["OPEN", "OVERDUE", "MIN_PAID"] } }, data: { status: "PAID" } });

  const overdue = (await tx.paymentDue.count({ where: { beneficiaryAccountId, status: "OVERDUE" } })) > 0;
  const policy = await effectivePolicyAt(tx, b, opts.now);
  const state = balanceState(balance, policy, overdue);
  const data: Prisma.BeneficiaryUpdateInput = {};
  if (!overdue && b.overdueSince) data.overdueSince = null;
  if (state !== b.state) Object.assign(data, { state, stateChangedAt: opts.now });
  if (Object.keys(data).length) await tx.beneficiary.update({ where: { accountId: beneficiaryAccountId }, data });
  if (state !== b.state) {
    await writeOutbox(tx, {
      topic: "balance.state_changed", key: b.ownerId,
      payload: {
        accountId: beneficiaryAccountId, beneficiary: beneficiaryOf(b), cityId: b.cityId, state, previousState: b.state as BalanceState,
        cashAllowed: cashAllowed(state), balanceMinor: balance,
      },
    });
  }
  return { state, previousState: b.state as BalanceState, balanceMinor: balance };
}

/** Show the last digits of a payout destination only. */
export const maskDestination = (d: string | null) => (d ? `•••${d.replace(/\s/g, "").slice(-4)}` : null);

/** What an owner or finance sees about one balance. */
export async function balanceView(tx: Tx, accountIdValue: string, now: Date) {
  const b = await tx.beneficiary.findUniqueOrThrow({ where: { accountId: accountIdValue }, include: { account: true } });
  const policy = await effectivePolicyAt(tx, b, now);
  const dues = await tx.paymentDue.findMany({ where: { beneficiaryAccountId: b.accountId }, orderBy: { cycleEnd: "desc" }, take: 5 });
  const balance = Number(b.account.balanceMinor);
  return {
    accountId: b.accountId,
    beneficiary: beneficiaryOf(b),
    cityId: b.cityId,
    balanceMinor: balance,
    currency: b.account.currency,
    state: b.state as BalanceState,
    cashAllowed: cashAllowed(b.state as BalanceState),
    stateChangedAt: b.stateChangedAt,
    overdueSince: b.overdueSince,
    referenceCode: b.referenceCode,
    payoutMethod: b.payoutProvider ? { provider: b.payoutProvider, destination: maskDestination(b.payoutDestination) } : null,
    suggestedTopUpMinor: suggestedTopUp(balance, policy),
    policy: {
      mode: policy.mode, warningMinor: policy.warningMinor, cashLimitMinor: policy.cashLimitMinor, hardLimitMinor: policy.hardLimitMinor,
      prepaidMinimumMinor: policy.prepaidMinimumMinor, minPayoutMinor: policy.minPayoutMinor, dueDays: policy.dueDays,
      builtIn: policy.validFrom === null,
      /** an approved per-balance exception in force now */
      override: policy.override,
    },
    dues: dues.map((d) => ({
      id: d.id, cycleEnd: d.cycleEnd.toISOString().slice(0, 10), amountMinor: Number(d.amountMinor), minimumMinor: Number(d.minimumMinor),
      paidMinor: Number(d.paidMinor), dueAt: d.dueAt, status: d.status,
    })),
  };
}

export type BalanceView = Awaited<ReturnType<typeof balanceView>>;

/** Who owns each balance and what it holds now, for lists of requests about balances. */
export async function beneficiariesOf(db: { beneficiary: Tx["beneficiary"] }, accountIds: string[]) {
  const rows = await db.beneficiary.findMany({ where: { accountId: { in: [...new Set(accountIds)] } }, include: { account: { select: { balanceMinor: true } } } });
  return new Map(rows.map((b) => [b.accountId, {
    beneficiary: beneficiaryOf(b), referenceCode: b.referenceCode, state: b.state as BalanceState, balanceMinor: Number(b.account.balanceMinor),
  }]));
}
export type BeneficiarySummary = NonNullable<ReturnType<Awaited<ReturnType<typeof beneficiariesOf>>["get"]>>;

/** The balance a request names: by account id, or by the reference code the owner quotes (ANB-…). */
export function findBeneficiary(db: { beneficiary: Tx["beneficiary"] }, ref: { accountId?: string | undefined; referenceCode?: string | undefined }) {
  if (ref.accountId) return db.beneficiary.findUnique({ where: { accountId: ref.accountId } });
  if (ref.referenceCode) return db.beneficiary.findUnique({ where: { referenceCode: ref.referenceCode.trim().toUpperCase() } });
  return Promise.resolve(null);
}
