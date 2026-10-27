import { describe, expect, it } from "vitest";
import {
  ADJUSTMENT_LIMITS, addisMonth, adjustmentDelta, adjustmentProblem, applyOverride, incentiveAwards, incentiveProblem, invoiceNumber, isPeriod,
  overrideProblem, periodOf, previousPeriod, writeOffProblem,
} from "../../src/money/controls.js";
import { balanceState, DEFAULT_POLICY } from "../../src/money/rules.js";

const DAY = 86_400_000;
const now = new Date("2026-10-27T09:00:00Z");
const none = { mode: null, warningMinor: null, cashLimitMinor: null, hardLimitMinor: null, prepaidMinimumMinor: null };

describe("adjustment limits", () => {
  it("caps one adjustment, city staff, and credits per balance over 30 days", () => {
    expect(adjustmentProblem({ direction: "CREDIT", amountMinor: 50_000, creditedLast30Minor: 0 })).toBeNull();
    expect(adjustmentProblem({ direction: "DEBIT", amountMinor: ADJUSTMENT_LIMITS.maxMinor + 1, creditedLast30Minor: 0 })).toMatch(/at most 50000 ETB/);
    expect(adjustmentProblem({ direction: "CREDIT", amountMinor: 100_001, creditedLast30Minor: 0, cityStaffOnly: true })).toMatch(/city staff/);
    expect(adjustmentProblem({ direction: "CREDIT", amountMinor: 100_001, creditedLast30Minor: 0 })).toBeNull();
    expect(adjustmentProblem({ direction: "CREDIT", amountMinor: 200_000, creditedLast30Minor: 900_000 })).toMatch(/per 30 days/);
    // debits don't count against the credit cap
    expect(adjustmentProblem({ direction: "DEBIT", amountMinor: 200_000, creditedLast30Minor: 900_000 })).toBeNull();
    expect(adjustmentProblem({ direction: "CREDIT", amountMinor: 0, creditedLast30Minor: 0 })).toMatch(/positive/);
    expect(adjustmentDelta("CREDIT", 500)).toBe(500);
    expect(adjustmentDelta("DEBIT", 500)).toBe(-500);
  });
});

describe("write-off eligibility", () => {
  it("only a negative balance overdue long enough", () => {
    expect(writeOffProblem({ balanceMinor: 0, overdueSince: new Date(now.getTime() - 100 * DAY), now, afterDays: 90 })).toMatch(/below zero/);
    expect(writeOffProblem({ balanceMinor: -5000, overdueSince: null, now, afterDays: 90 })).toMatch(/no overdue/);
    expect(writeOffProblem({ balanceMinor: -5000, overdueSince: new Date(now.getTime() - 30 * DAY), now, afterDays: 90 })).toMatch(/overdue 30 days/);
    expect(writeOffProblem({ balanceMinor: -5000, overdueSince: new Date(now.getTime() - 90 * DAY), now, afterDays: 90 })).toBeNull();
  });
});

describe("policy overrides", () => {
  const window = { validFrom: now, validUntil: new Date(now.getTime() + 30 * DAY) };

  it("replaces only the fields it sets, and the state follows", () => {
    const p = applyOverride(DEFAULT_POLICY, { ...none, cashLimitMinor: -150_000, hardLimitMinor: -200_000 });
    expect(p).toMatchObject({ warningMinor: -30_000, cashLimitMinor: -150_000, hardLimitMinor: -200_000, mode: "POSTPAID" });
    expect(balanceState(-60_000, DEFAULT_POLICY, false)).toBe("CASH_BLOCKED");
    expect(balanceState(-60_000, p, false)).toBe("WARNING");
    expect(applyOverride(DEFAULT_POLICY, null)).toBe(DEFAULT_POLICY);
    const prepaid = applyOverride(DEFAULT_POLICY, { ...none, mode: "PREPAID", prepaidMinimumMinor: 20_000 });
    expect(balanceState(10_000, prepaid, false)).toBe("BLOCKED");
  });

  it("checks the merged limits, the floor and the window", () => {
    expect(overrideProblem(DEFAULT_POLICY, { ...none, ...window }, now)).toMatch(/at least one/);
    expect(overrideProblem(DEFAULT_POLICY, { ...none, cashLimitMinor: -150_000, ...window }, now)).toMatch(/in order/); // below the city's hard limit
    expect(overrideProblem(DEFAULT_POLICY, { ...none, cashLimitMinor: -150_000, hardLimitMinor: -200_000, ...window }, now)).toBeNull();
    expect(overrideProblem(DEFAULT_POLICY, { ...none, cashLimitMinor: -150_000, hardLimitMinor: -2_000_000, ...window }, now)).toMatch(/can't go below/);
    expect(overrideProblem(DEFAULT_POLICY, { ...none, mode: "PREPAID", validFrom: now, validUntil: new Date(now.getTime() + 91 * DAY) }, now)).toMatch(/at most 90 days/);
    expect(overrideProblem(DEFAULT_POLICY, { ...none, mode: "PREPAID", validFrom: new Date(now.getTime() - 10 * DAY), validUntil: new Date(now.getTime() - DAY) }, now)).toMatch(/already over/);
  });
});

describe("incentives", () => {
  const terms = { targetTrips: 3, rewardMinor: 30_000, budgetMinor: 60_000, startsAt: now, endsAt: new Date(now.getTime() + 7 * DAY) };

  it("checks the terms", () => {
    expect(incentiveProblem(terms, now)).toBeNull();
    expect(incentiveProblem({ ...terms, budgetMinor: 10_000 }, now)).toMatch(/at least one reward/);
    expect(incentiveProblem({ ...terms, endsAt: new Date(now.getTime() + 40 * DAY) }, now)).toMatch(/at most 31 days/);
    expect(incentiveProblem(terms, new Date(now.getTime() + 8 * DAY))).toMatch(/already over/);
    expect(incentiveProblem({ ...terms, targetTrips: 0 }, now)).toMatch(/target/);
    expect(incentiveProblem({ ...terms, rewardMinor: 2_000_000, budgetMinor: 2_000_000 }, now)).toMatch(/reward is at most/);
  });

  it("pays who reached the target first, within the budget", () => {
    const at = (h: number) => new Date(now.getTime() + h * 3600_000);
    const { awarded, overBudget } = incentiveAwards([
      { driverId: "a", beneficiaryAccountId: "x", trips: 5, reachedAt: at(30) },
      { driverId: "b", beneficiaryAccountId: "y", trips: 3, reachedAt: at(10) },
      { driverId: "c", beneficiaryAccountId: "z", trips: 2, reachedAt: null },
      { driverId: "d", beneficiaryAccountId: "w", trips: 4, reachedAt: at(20) },
    ], terms);
    expect(awarded.map((x) => x.driverId)).toEqual(["b", "d"]);
    expect(overBudget.map((x) => x.driverId)).toEqual(["a"]);
  });
});

describe("invoice calendar", () => {
  it("Addis months, numbers and periods", () => {
    const { start, end } = addisMonth("2026-10");
    expect(start.toISOString()).toBe("2026-09-30T21:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-31T21:00:00.000Z");
    expect(addisMonth("2026-12").end.toISOString()).toBe("2026-12-31T21:00:00.000Z");
    expect(periodOf(new Date("2026-10-31T21:30:00Z"))).toBe("2026-11");
    expect(periodOf(new Date("2026-10-31T20:59:59Z"))).toBe("2026-10");
    expect(previousPeriod("2026-01")).toBe("2025-12");
    expect(invoiceNumber("2026-10", 7)).toBe("INV-202610-00007");
    expect(isPeriod("2026-13")).toBe(false);
    expect(isPeriod("2026-09")).toBe(true);
  });
});
