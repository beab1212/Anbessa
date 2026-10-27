// Pure rules for the money controls (Payment.md §13–§16, workflows 09, 11, 13, 15): the limits a
// request and its approval are checked against, how an override changes a city's policy, who
// earns an incentive within its budget, and the invoice calendar. No I/O, so every limit and
// number can be checked in a unit test.

import type { PolicyLike } from "./rules.js";

const DAY_MS = 86_400_000;
const ADDIS_OFFSET_MS = 3 * 3600_000;

/** Maker–checker requests wait this long for a decision (Role.md §11), then expire. */
export const DECISION_TTL_MS = 7 * DAY_MS;

// ── adjustments ────────────────────────────────────────────────────────────

export type AdjustmentDirection = "CREDIT" | "DEBIT";
export const ADJUSTMENT_CATEGORIES = ["GOODWILL", "FEE_REVERSAL", "CORRECTION", "LOST_ITEM_RETURN", "OTHER"] as const;
export type AdjustmentCategory = (typeof ADJUSTMENT_CATEGORIES)[number];

export const ADJUSTMENT_LIMITS = {
  /** what city staff (support agents) may ask for at once: 1,000 ETB */
  cityStaffMaxMinor: 100_000,
  /** the most any one adjustment may move: 50,000 ETB */
  maxMinor: 5_000_000,
  /** credits to one balance over 30 days, this one included: 10,000 ETB (goodwill abuse guard) */
  creditPer30DaysMinor: 1_000_000,
};

/**
 * What's wrong with an adjustment, or null. `creditedLast30Minor` is the balance's executed credit
 * adjustments in the last 30 days (excluding this one). Checked on request and again on approval.
 */
export function adjustmentProblem(a: { direction: AdjustmentDirection; amountMinor: number; creditedLast30Minor: number; cityStaffOnly?: boolean }): string | null {
  if (!Number.isSafeInteger(a.amountMinor) || a.amountMinor <= 0) return "the amount must be positive";
  if (a.amountMinor > ADJUSTMENT_LIMITS.maxMinor) return `an adjustment can move at most ${ADJUSTMENT_LIMITS.maxMinor / 100} ETB`;
  if (a.cityStaffOnly && a.amountMinor > ADJUSTMENT_LIMITS.cityStaffMaxMinor) {
    return `city staff can ask for at most ${ADJUSTMENT_LIMITS.cityStaffMaxMinor / 100} ETB; ask finance for more`;
  }
  if (a.direction === "CREDIT" && a.creditedLast30Minor + a.amountMinor > ADJUSTMENT_LIMITS.creditPer30DaysMinor) {
    return `credits to one balance are capped at ${ADJUSTMENT_LIMITS.creditPer30DaysMinor / 100} ETB per 30 days (${a.creditedLast30Minor / 100} ETB already)`;
  }
  return null;
}

/** The signed change to the balance. */
export const adjustmentDelta = (direction: AdjustmentDirection, amountMinor: number) => (direction === "CREDIT" ? amountMinor : -amountMinor);

// ── write-offs ─────────────────────────────────────────────────────────────

/** Payment.md Q8: unpaid debt is written off 90 days after the balance was blocked (configurable). */
export const DEFAULT_WRITE_OFF_AFTER_DAYS = 90;

/** Only a negative balance whose payment due has been overdue long enough can be written off. */
export function writeOffProblem(b: { balanceMinor: number; overdueSince: Date | null; now: Date; afterDays: number }): string | null {
  if (b.balanceMinor >= 0) return "only a balance below zero can be written off";
  if (!b.overdueSince) return "the balance has no overdue payment due; only debt past its due date can be written off";
  const days = (b.now.getTime() - b.overdueSince.getTime()) / DAY_MS;
  if (days < b.afterDays) return `the debt has been overdue ${Math.floor(days)} days; it can be written off after ${b.afterDays}`;
  return null;
}

// ── policy overrides ───────────────────────────────────────────────────────

export interface OverrideFields {
  mode: "POSTPAID" | "PREPAID" | null;
  warningMinor: number | null;
  cashLimitMinor: number | null;
  hardLimitMinor: number | null;
  prepaidMinimumMinor: number | null;
}

export const OVERRIDE_LIMITS = {
  /** no override lets a balance go below −10,000 ETB before every trip stops */
  hardLimitFloorMinor: -1_000_000,
  /** the longest window, in days */
  maxDays: 90,
};

/** The city's policy with the override's set fields in place of the city's. */
export function applyOverride<T extends PolicyLike>(city: T, o: OverrideFields | null): T {
  if (!o) return city;
  return {
    ...city,
    ...(o.mode !== null ? { mode: o.mode } : {}),
    ...(o.warningMinor !== null ? { warningMinor: o.warningMinor } : {}),
    ...(o.cashLimitMinor !== null ? { cashLimitMinor: o.cashLimitMinor } : {}),
    ...(o.hardLimitMinor !== null ? { hardLimitMinor: o.hardLimitMinor } : {}),
    ...(o.prepaidMinimumMinor !== null ? { prepaidMinimumMinor: o.prepaidMinimumMinor } : {}),
  };
}

/** What's wrong with an override against the city policy in force, or null (request and approval). */
export function overrideProblem(city: PolicyLike, o: OverrideFields & { validFrom: Date; validUntil: Date }, now: Date): string | null {
  if (o.mode === null && o.warningMinor === null && o.cashLimitMinor === null && o.hardLimitMinor === null && o.prepaidMinimumMinor === null) {
    return "change at least one limit or the mode";
  }
  if (o.validUntil.getTime() <= o.validFrom.getTime()) return "the window must end after it starts";
  if (o.validUntil.getTime() <= now.getTime()) return "the window is already over";
  if (o.validUntil.getTime() - Math.max(o.validFrom.getTime(), now.getTime()) > OVERRIDE_LIMITS.maxDays * DAY_MS) {
    return `an override lasts at most ${OVERRIDE_LIMITS.maxDays} days`;
  }
  const merged = applyOverride(city, o);
  if (!(merged.hardLimitMinor <= merged.cashLimitMinor && merged.cashLimitMinor <= merged.warningMinor && merged.warningMinor <= 0)) {
    return "with the city's other limits, these must stay in order: hard limit ≤ cash limit ≤ warning ≤ 0";
  }
  if (merged.hardLimitMinor < OVERRIDE_LIMITS.hardLimitFloorMinor) return `the hard limit can't go below ${OVERRIDE_LIMITS.hardLimitFloorMinor / 100} ETB`;
  if (merged.prepaidMinimumMinor < 0) return "the prepaid minimum can't be negative";
  return null;
}

// ── incentives ─────────────────────────────────────────────────────────────

export const INCENTIVE_LIMITS = {
  /** the most one driver can earn from one program: 10,000 ETB */
  maxRewardMinor: 1_000_000,
  /** the most one program can spend: 1,000,000 ETB */
  maxBudgetMinor: 100_000_000,
  maxTarget: 1000,
  /** the longest window, in days */
  maxDays: 31,
};

export interface IncentiveTerms {
  targetTrips: number;
  rewardMinor: number;
  budgetMinor: number;
  startsAt: Date;
  endsAt: Date;
}

/** What's wrong with a program, or null. Checked when proposed and again when approved. */
export function incentiveProblem(t: IncentiveTerms, now: Date): string | null {
  if (!Number.isInteger(t.targetTrips) || t.targetTrips < 1 || t.targetTrips > INCENTIVE_LIMITS.maxTarget) return `the target is 1–${INCENTIVE_LIMITS.maxTarget} trips`;
  if (t.rewardMinor <= 0 || t.rewardMinor > INCENTIVE_LIMITS.maxRewardMinor) return `the reward is at most ${INCENTIVE_LIMITS.maxRewardMinor / 100} ETB`;
  if (t.budgetMinor < t.rewardMinor) return "the budget must cover at least one reward";
  if (t.budgetMinor > INCENTIVE_LIMITS.maxBudgetMinor) return `the budget is at most ${INCENTIVE_LIMITS.maxBudgetMinor / 100} ETB`;
  if (t.endsAt.getTime() <= t.startsAt.getTime()) return "the window must end after it starts";
  if (t.endsAt.getTime() - t.startsAt.getTime() > INCENTIVE_LIMITS.maxDays * DAY_MS) return `a program runs at most ${INCENTIVE_LIMITS.maxDays} days`;
  if (t.endsAt.getTime() <= now.getTime()) return "the program's window is already over";
  return null;
}

export interface DriverCount {
  driverId: string;
  beneficiaryAccountId: string;
  trips: number;
  /** when the driver's target-th trip settled (null: target not reached) */
  reachedAt: Date | null;
}

/**
 * Who is paid at period close: drivers who reached the target, first come first served until the
 * budget runs out. Each gets the same reward; the rest are reported as over budget.
 */
export function incentiveAwards(counts: DriverCount[], terms: Pick<IncentiveTerms, "targetTrips" | "rewardMinor" | "budgetMinor">) {
  const qualified = counts
    .filter((c) => c.trips >= terms.targetTrips && c.reachedAt)
    .sort((a, b) => a.reachedAt!.getTime() - b.reachedAt!.getTime() || a.driverId.localeCompare(b.driverId) || a.beneficiaryAccountId.localeCompare(b.beneficiaryAccountId));
  const room = Math.floor(terms.budgetMinor / terms.rewardMinor);
  return { awarded: qualified.slice(0, room), overBudget: qualified.slice(room) };
}

// ── invoices ───────────────────────────────────────────────────────────────

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** An Addis Ababa calendar month (UTC+3, no daylight saving) as [start, end). */
export function addisMonth(period: string): { start: Date; end: Date } {
  const m = PERIOD.exec(period);
  if (!m) throw new Error(`not a month: ${period}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return { start: new Date(Date.UTC(y, mo - 1, 1) - ADDIS_OFFSET_MS), end: new Date(Date.UTC(y, mo, 1) - ADDIS_OFFSET_MS) };
}

export const isPeriod = (s: string) => PERIOD.test(s);

/** The Addis Ababa month a moment falls in, as YYYY-MM. */
export const periodOf = (at: Date) => new Date(at.getTime() + ADDIS_OFFSET_MS).toISOString().slice(0, 7);

/** The month before `period`. */
export function previousPeriod(period: string): string {
  const { start } = addisMonth(period);
  return periodOf(new Date(start.getTime() - 1));
}

/** INV-YYYYMM-NNNNN: sequential, without gaps, within a month. */
export const invoiceNumber = (period: string, seq: number) => `INV-${period.replace("-", "")}-${String(seq).padStart(5, "0")}`;

/** Corporate payment terms (workflow 11 §6): net 30. */
export const INVOICE_TERMS_DAYS = 30;
