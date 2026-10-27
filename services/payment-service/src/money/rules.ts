// Pure money rules (Payment.md §6–§8): commission, VAT, the balance state and payment dues.
// No I/O, so every number the ledger posts can be checked in a unit test.

import type { BalanceState } from "@ride-app/shared-types";

export type CommissionModel = "PERCENT" | "FIXED_PER_TRIP" | "ZERO";

export interface CommissionRuleLike {
  id: string | null;
  model: CommissionModel;
  rateBp: number | null;
  fixedMinor: number | null;
  minMinor: number | null;
  maxMinor: number | null;
}

export interface PolicyLike {
  mode: "POSTPAID" | "PREPAID";
  warningMinor: number;
  cashLimitMinor: number;
  hardLimitMinor: number;
  prepaidMinimumMinor: number;
  dueDays: number;
  minPaymentBp: number;
  minPayoutMinor: number;
  taxBasis: "COMMISSION" | "FULL_FARE";
  vatRateBp: number;
}

/** Payment.md §19 defaults (Q1, Q2, Q4) until finance approves a rule or policy for the city. */
export const DEFAULT_RULE: CommissionRuleLike = { id: null, model: "PERCENT", rateBp: 1500, fixedMinor: null, minMinor: 1000, maxMinor: null };
export const DEFAULT_POLICY: PolicyLike = {
  mode: "POSTPAID", warningMinor: -30_000, cashLimitMinor: -50_000, hardLimitMinor: -100_000, prepaidMinimumMinor: 10_000,
  dueDays: 3, minPaymentBp: 5000, minPayoutMinor: 10_000, taxBasis: "COMMISSION", vatRateBp: 1500,
};

const bp = (amount: number, basisPoints: number) => Math.round((amount * basisPoints) / 10_000);

/** The platform's commission on a fare (Payment.md §7). Never more than the fare. */
export function commissionOn(fareMinor: number, rule: CommissionRuleLike): number {
  let c: number;
  switch (rule.model) {
    case "ZERO":
      return 0;
    case "FIXED_PER_TRIP":
      c = rule.fixedMinor ?? 0;
      break;
    case "PERCENT":
      c = bp(fareMinor, rule.rateBp ?? 0);
      if (rule.minMinor !== null) c = Math.max(c, rule.minMinor);
      if (rule.maxMinor !== null) c = Math.min(c, rule.maxMinor);
      break;
  }
  return Math.min(Math.max(c, 0), fareMinor);
}

/** VAT owed on a trip (Payment.md §6.6): on the commission, or on the whole fare. */
export function vatOn(fareMinor: number, commissionMinor: number, policy: Pick<PolicyLike, "taxBasis" | "vatRateBp">): number {
  return bp(policy.taxBasis === "FULL_FARE" ? fareMinor : commissionMinor, policy.vatRateBp);
}

export interface TripMoney {
  /** the full fare: commission and VAT are computed on it, promo or not */
  fareMinor: number;
  commissionMinor: number;
  vatMinor: number;
  /** what the beneficiary's balance moves by */
  earningsMinor: number;
  /** the rider's promo discount, a platform cost (PROMO_EXPENSE); 0 = none */
  promoDiscountMinor: number;
  /** what the rider pays: fare − discount */
  riderPaysMinor: number;
}

/**
 * The beneficiary's side of a trip. Digital and corporate fares reach the platform, so the
 * beneficiary is owed fare − commission − VAT; on cash trips the driver holds the fare and owes
 * commission + VAT.
 *
 * A promo discount (workflow 15, Payment.md §6.4) doesn't change what the driver earns: the
 * commission is on the full fare and the platform pays the discount. On a cash trip the driver
 * collected only fare − discount, so the platform owes them the discount on top.
 */
export function tripMoney(fareMinor: number, cash: boolean, rule: CommissionRuleLike, policy: PolicyLike, discountMinor = 0): TripMoney {
  const promoDiscountMinor = Math.min(Math.max(Math.trunc(discountMinor), 0), fareMinor);
  const commissionMinor = commissionOn(fareMinor, rule);
  const vatMinor = vatOn(fareMinor, commissionMinor, policy);
  const earningsMinor = cash ? promoDiscountMinor - (commissionMinor + vatMinor) : fareMinor - commissionMinor - vatMinor;
  return { fareMinor, commissionMinor, vatMinor, earningsMinor, promoDiscountMinor, riderPaysMinor: fareMinor - promoDiscountMinor };
}

/** The balance state (Payment.md §8): overdue blocks everything; then the limits. */
export function balanceState(balanceMinor: number, policy: PolicyLike, overdue: boolean): BalanceState {
  if (overdue) return "BLOCKED";
  if (policy.mode === "PREPAID") return balanceMinor < policy.prepaidMinimumMinor ? "BLOCKED" : "OK";
  if (balanceMinor < policy.hardLimitMinor) return "BLOCKED";
  if (balanceMinor < policy.cashLimitMinor) return "CASH_BLOCKED";
  if (balanceMinor < policy.warningMinor) return "WARNING";
  return "OK";
}

export const cashAllowed = (state: BalanceState) => state === "OK" || state === "WARNING";

/** The notice for a negative balance at settlement (Payment.md §10). */
export function paymentDue(balanceMinor: number, policy: PolicyLike, now: Date) {
  const amountMinor = -balanceMinor;
  const minimumMinor = Math.min(amountMinor, Math.max(1, Math.ceil((amountMinor * policy.minPaymentBp) / 10_000)));
  return { amountMinor, minimumMinor, dueAt: new Date(now.getTime() + policy.dueDays * 86_400_000) };
}

/** A due's status once `paidMinor` has come in. */
export function dueStatus(due: { amountMinor: number; minimumMinor: number; paidMinor: number; overdue: boolean }): "OPEN" | "MIN_PAID" | "PAID" | "OVERDUE" {
  if (due.paidMinor >= due.amountMinor) return "PAID";
  if (due.paidMinor >= due.minimumMinor) return "MIN_PAID";
  return due.overdue ? "OVERDUE" : "OPEN";
}

/** What the amount to top up to reach OK would be (the app's suggestion). */
export function suggestedTopUp(balanceMinor: number, policy: PolicyLike): number {
  const target = policy.mode === "PREPAID" ? policy.prepaidMinimumMinor : policy.warningMinor;
  return Math.max(0, Math.ceil((target - balanceMinor) / 100) * 100);
}

/** The calendar day in Addis Ababa (UTC+3, no daylight saving), as YYYY-MM-DD. */
export function addisDate(at: Date): string {
  return new Date(at.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
}
