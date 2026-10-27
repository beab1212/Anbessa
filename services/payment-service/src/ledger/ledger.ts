// The double-entry ledger (Database.md §7.4). Every money movement is one journal entry whose
// postings sum to zero (a deferred trigger checks it at COMMIT); each entry has an idempotency
// key, so a replayed event or webhook can't post twice. Account rows are locked (FOR UPDATE, in
// id order so two entries can't deadlock) and their cached balance moves in the same transaction.

import { Prisma } from "../generated/prisma/client.js";

type Tx = Prisma.TransactionClient;

export type AccountKind =
  | "BENEFICIARY_BALANCE" | "COMMISSION_REVENUE" | "PROVIDER_CLEARING" | "CORPORATE_RECEIVABLE" | "RIDER_RECEIVABLE"
  | "PROMO_EXPENSE" | "VAT_PAYABLE" | "CASH_RECEIPTS" | "BAD_DEBT_EXPENSE" | "GOODWILL_EXPENSE";

export interface AccountSpec {
  code: string;
  kind: AccountKind;
  ownerType: "USER" | "ORGANIZATION" | "PLATFORM" | "PROVIDER";
  ownerId: string | null;
  cityId: string | null;
}

/** The accounts of Payment.md §5, by owner. */
export const accounts = {
  beneficiary: (type: "INDIVIDUAL" | "ORGANIZATION", ownerId: string, cityId: string): AccountSpec => ({
    code: `BENEFICIARY_BALANCE:${type}:${ownerId}`, kind: "BENEFICIARY_BALANCE",
    ownerType: type === "INDIVIDUAL" ? "USER" : "ORGANIZATION", ownerId, cityId,
  }),
  commission: (cityId: string): AccountSpec => ({ code: `COMMISSION_REVENUE:${cityId}`, kind: "COMMISSION_REVENUE", ownerType: "PLATFORM", ownerId: null, cityId }),
  vat: (): AccountSpec => ({ code: "VAT_PAYABLE", kind: "VAT_PAYABLE", ownerType: "PLATFORM", ownerId: null, cityId: null }),
  clearing: (provider: string): AccountSpec => ({ code: `PROVIDER_CLEARING:${provider}`, kind: "PROVIDER_CLEARING", ownerType: "PROVIDER", ownerId: provider, cityId: null }),
  corporate: (orgId: string): AccountSpec => ({ code: `CORPORATE_RECEIVABLE:${orgId}`, kind: "CORPORATE_RECEIVABLE", ownerType: "ORGANIZATION", ownerId: orgId, cityId: null }),
  rider: (riderId: string): AccountSpec => ({ code: `RIDER_RECEIVABLE:${riderId}`, kind: "RIDER_RECEIVABLE", ownerType: "USER", ownerId: riderId, cityId: null }),
  cashReceipts: (cityId: string): AccountSpec => ({ code: `CASH_RECEIPTS:${cityId}`, kind: "CASH_RECEIPTS", ownerType: "PLATFORM", ownerId: null, cityId }),
  goodwill: (): AccountSpec => ({ code: "GOODWILL_EXPENSE", kind: "GOODWILL_EXPENSE", ownerType: "PLATFORM", ownerId: null, cityId: null }),
  /** the platform's promotion cost, per city: rider promo discounts (settlement.ts) and driver incentives (workflow 15 D/E) */
  promo: (cityId: string): AccountSpec => ({ code: `PROMO_EXPENSE:${cityId}`, kind: "PROMO_EXPENSE", ownerType: "PLATFORM", ownerId: null, cityId }),
  /** approved write-offs of uncollectable debt (Payment.md §16) */
  badDebt: (): AccountSpec => ({ code: "BAD_DEBT_EXPENSE", kind: "BAD_DEBT_EXPENSE", ownerType: "PLATFORM", ownerId: null, cityId: null }),
};

/** The account's id, creating it on first use (safe under concurrency). */
export async function accountId(tx: Tx, spec: AccountSpec): Promise<string> {
  await tx.$executeRaw`
    INSERT INTO ledger_account (code, kind, owner_type, owner_id, city_id)
    VALUES (${spec.code}, ${spec.kind}, ${spec.ownerType}, ${spec.ownerId}, ${spec.cityId})
    ON CONFLICT (code) DO NOTHING`;
  const row = await tx.ledgerAccount.findUniqueOrThrow({ where: { code: spec.code }, select: { id: true } });
  return row.id;
}

export interface Line {
  account: AccountSpec | { id: string };
  amountMinor: number;
}

export interface EntryInput {
  kind: string;
  referenceType: string;
  referenceId: string;
  idempotencyKey: string;
  memo?: string;
  createdBy?: string | null;
  lines: Line[];
}

export interface Posted {
  entryId: string;
  /** false: an entry with this idempotency key already existed, nothing was posted */
  created: boolean;
  /** account id → its balance after this entry */
  balances: Map<string, number>;
}

export class UnbalancedEntry extends Error {}

/** Post one journal entry in the caller's transaction. */
export async function post(tx: Tx, input: EntryInput): Promise<Posted> {
  const existing = await tx.journalEntry.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true } });
  if (existing) return { entryId: existing.id, created: false, balances: new Map() };

  const lines = input.lines.filter((l) => l.amountMinor !== 0);
  if (lines.reduce((s, l) => s + l.amountMinor, 0) !== 0) throw new UnbalancedEntry(`${input.idempotencyKey} does not balance`);
  if (lines.some((l) => !Number.isSafeInteger(l.amountMinor))) throw new UnbalancedEntry(`${input.idempotencyKey} has a non-integer amount`);

  // resolve and lock the accounts in id order
  const ids = await Promise.all(lines.map((l) => ("id" in l.account ? l.account.id : accountId(tx, l.account))));
  const unique = [...new Set(ids)].sort();
  await tx.$queryRaw`SELECT id FROM ledger_account WHERE id = ANY(${unique}::uuid[]) ORDER BY id FOR UPDATE`;

  const entry = await tx.journalEntry.create({
    data: {
      kind: input.kind, referenceType: input.referenceType, referenceId: input.referenceId, idempotencyKey: input.idempotencyKey,
      memo: input.memo ?? null, createdBy: input.createdBy ?? null,
    },
  });
  await tx.posting.createMany({ data: lines.map((l, i) => ({ journalEntryId: entry.id, accountId: ids[i]!, amountMinor: BigInt(l.amountMinor) })) });

  const delta = new Map<string, number>();
  ids.forEach((id, i) => delta.set(id, (delta.get(id) ?? 0) + lines[i]!.amountMinor));
  const balances = new Map<string, number>();
  for (const [id, d] of delta) {
    const a = await tx.ledgerAccount.update({ where: { id }, data: { balanceMinor: { increment: BigInt(d) }, version: { increment: 1 } }, select: { balanceMinor: true } });
    balances.set(id, Number(a.balanceMinor));
  }
  return { entryId: entry.id, created: true, balances };
}

/** Nightly check (Payment.md §17): every cached balance equals Σ postings, and all accounts sum to 0. */
export async function integrity(db: { $queryRaw: Tx["$queryRaw"] }) {
  const mismatched = await db.$queryRaw<{ code: string; cached: bigint; actual: bigint }[]>`
    SELECT a.code, a.balance_minor AS cached, coalesce(sum(p.amount_minor), 0)::bigint AS actual
    FROM ledger_account a LEFT JOIN posting p ON p.account_id = a.id
    GROUP BY a.id HAVING a.balance_minor <> coalesce(sum(p.amount_minor), 0)
    LIMIT 50`;
  const [total] = await db.$queryRaw<{ total: bigint | null; accounts: bigint; entries: bigint }[]>`
    SELECT (SELECT sum(balance_minor) FROM ledger_account)::bigint AS total,
           (SELECT count(*) FROM ledger_account) AS accounts,
           (SELECT count(*) FROM journal_entry) AS entries`;
  return {
    ok: mismatched.length === 0 && Number(total?.total ?? 0) === 0,
    totalMinor: Number(total?.total ?? 0),
    accounts: Number(total?.accounts ?? 0),
    entries: Number(total?.entries ?? 0),
    mismatched: mismatched.map((m) => ({ code: m.code, cachedMinor: Number(m.cached), actualMinor: Number(m.actual) })),
  };
}
