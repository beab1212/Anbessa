import { describe, expect, it } from "vitest";
import {
  addisDate, balanceState, commissionOn, DEFAULT_POLICY, DEFAULT_RULE, dueStatus, paymentDue, suggestedTopUp, tripMoney, vatOn,
} from "../../src/money/rules.js";

describe("commission (Payment.md §7)", () => {
  it("is a clamped percentage by default: 15%, at least 10 ETB", () => {
    expect(commissionOn(40_000, DEFAULT_RULE)).toBe(6000);
    expect(commissionOn(5000, DEFAULT_RULE)).toBe(1000); // minimum
    expect(commissionOn(500, DEFAULT_RULE)).toBe(500); // never more than the fare
    expect(commissionOn(1_000_000, { ...DEFAULT_RULE, maxMinor: 15_000 })).toBe(15_000);
  });

  it("supports fixed per trip and zero", () => {
    expect(commissionOn(40_000, { id: null, model: "FIXED_PER_TRIP", rateBp: null, fixedMinor: 1000, minMinor: null, maxMinor: null })).toBe(1000);
    expect(commissionOn(40_000, { id: null, model: "ZERO", rateBp: null, fixedMinor: null, minMinor: null, maxMinor: null })).toBe(0);
  });
});

describe("settlement amounts (Payment.md §6)", () => {
  const noVat = { ...DEFAULT_POLICY, vatRateBp: 0 };

  it("card: the beneficiary is owed fare − commission; cash: owes the commission", () => {
    expect(tripMoney(40_000, false, DEFAULT_RULE, noVat)).toEqual({ fareMinor: 40_000, commissionMinor: 6000, vatMinor: 0, earningsMinor: 34_000 });
    expect(tripMoney(40_000, true, DEFAULT_RULE, noVat)).toEqual({ fareMinor: 40_000, commissionMinor: 6000, vatMinor: 0, earningsMinor: -6000 });
  });

  it("VAT on the commission by default (15% of 60 = 9 ETB), or on the whole fare", () => {
    expect(vatOn(40_000, 6000, DEFAULT_POLICY)).toBe(900);
    expect(tripMoney(40_000, true, DEFAULT_RULE, DEFAULT_POLICY).earningsMinor).toBe(-6900);
    expect(vatOn(40_000, 6000, { taxBasis: "FULL_FARE", vatRateBp: 1500 })).toBe(6000);
  });
});

describe("balance state (Payment.md §8)", () => {
  const p = DEFAULT_POLICY; // warning −300, cash −500, hard −1,000 ETB

  it("moves through the limits", () => {
    expect(balanceState(0, p, false)).toBe("OK");
    expect(balanceState(-30_000, p, false)).toBe("OK");
    expect(balanceState(-30_001, p, false)).toBe("WARNING");
    expect(balanceState(-52_000, p, false)).toBe("CASH_BLOCKED");
    expect(balanceState(-100_001, p, false)).toBe("BLOCKED");
  });

  it("an overdue payment blocks whatever the balance", () => {
    expect(balanceState(-100, p, true)).toBe("BLOCKED");
  });

  it("prepaid needs the minimum", () => {
    expect(balanceState(9_999, { ...p, mode: "PREPAID" }, false)).toBe("BLOCKED");
    expect(balanceState(10_000, { ...p, mode: "PREPAID" }, false)).toBe("OK");
  });

  it("suggests the top-up that brings the balance back to OK", () => {
    expect(suggestedTopUp(-52_000, p)).toBe(22_000);
    expect(suggestedTopUp(1000, p)).toBe(0);
  });
});

describe("payment dues (Payment.md §10)", () => {
  it("asks for the whole debt, at least half, within due_days", () => {
    const now = new Date("2026-11-02T00:00:00Z");
    expect(paymentDue(-40_000, DEFAULT_POLICY, now)).toEqual({ amountMinor: 40_000, minimumMinor: 20_000, dueAt: new Date("2026-11-05T00:00:00Z") });
  });

  it("is minimum-paid, paid or overdue", () => {
    expect(dueStatus({ amountMinor: 40_000, minimumMinor: 20_000, paidMinor: 0, overdue: false })).toBe("OPEN");
    expect(dueStatus({ amountMinor: 40_000, minimumMinor: 20_000, paidMinor: 0, overdue: true })).toBe("OVERDUE");
    expect(dueStatus({ amountMinor: 40_000, minimumMinor: 20_000, paidMinor: 20_000, overdue: true })).toBe("MIN_PAID");
    expect(dueStatus({ amountMinor: 40_000, minimumMinor: 20_000, paidMinor: 40_000, overdue: false })).toBe("PAID");
  });

  it("dates are Addis Ababa days", () => {
    expect(addisDate(new Date("2026-11-01T21:30:00Z"))).toBe("2026-11-02"); // 00:30 Monday in Addis
  });
});
