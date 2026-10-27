import { describe, expect, it } from "vitest";
import {
  CATEGORIES, canMoveIncident, canMoveLostItem, canMoveSos, canMoveTicket, canReopen, isOverdue, lostItemReportable,
  lostItemSourcesFor, sosAckOverdue, sosAvailable, ticketSla, ticketSourcesFor,
} from "../../src/support/policy.js";

const t0 = new Date("2026-10-27T08:00:00Z");
const plus = (ms: number) => new Date(t0.getTime() + ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("SLA", () => {
  it("follows workflow 13 §2 per category", () => {
    const due = (c: (typeof CATEGORIES)[number]) => ticketSla(c, t0);
    expect(due("SAFETY")).toEqual({ priority: "P1", firstResponseDueAt: plus(5 * MIN) });
    expect(due("PAYMENT")).toEqual({ priority: "P2", firstResponseDueAt: plus(4 * HOUR) });
    expect(due("TRIP")).toEqual({ priority: "P3", firstResponseDueAt: plus(8 * HOUR) });
    expect(due("LOST_ITEM")).toEqual({ priority: "P2", firstResponseDueAt: plus(2 * HOUR) });
    expect(due("ACCOUNT")).toEqual({ priority: "P3", firstResponseDueAt: plus(24 * HOUR) });
    expect(due("FEEDBACK")).toEqual({ priority: "P4", firstResponseDueAt: plus(72 * HOUR) });
  });

  it("lets staff pick a priority, except SAFETY which is always P1", () => {
    expect(ticketSla("TRIP", t0, "P1").priority).toBe("P1");
    expect(ticketSla("SAFETY", t0, "P4").priority).toBe("P1");
  });

  it("is overdue only while unanswered and open", () => {
    const base = { status: "OPEN" as const, firstRespondedAt: null, firstResponseDueAt: plus(5 * MIN) };
    expect(isOverdue(base, plus(4 * MIN))).toBe(false);
    expect(isOverdue(base, plus(6 * MIN))).toBe(true);
    expect(isOverdue({ ...base, firstRespondedAt: plus(MIN) }, plus(6 * MIN))).toBe(false);
    expect(isOverdue({ ...base, status: "RESOLVED" }, plus(6 * MIN))).toBe(false);
    expect(isOverdue({ ...base, status: "WAITING_REQUESTER" }, plus(6 * MIN))).toBe(true);
  });
});

describe("ticket transitions", () => {
  it("allows the workflow moves and refuses the rest", () => {
    expect(canMoveTicket("OPEN", "IN_PROGRESS")).toBe(true);
    expect(canMoveTicket("IN_PROGRESS", "WAITING_REQUESTER")).toBe(true);
    expect(canMoveTicket("WAITING_REQUESTER", "IN_PROGRESS")).toBe(true);
    expect(canMoveTicket("IN_PROGRESS", "RESOLVED")).toBe(true);
    expect(canMoveTicket("RESOLVED", "CLOSED")).toBe(true);
    expect(canMoveTicket("CLOSED", "OPEN")).toBe(false);
    expect(canMoveTicket("WAITING_REQUESTER", "OPEN")).toBe(false);
    expect(canMoveTicket("OPEN", "OPEN")).toBe(false);
  });

  it("lists the sources for a target", () => {
    expect(ticketSourcesFor("RESOLVED").sort()).toEqual(["IN_PROGRESS", "OPEN", "WAITING_REQUESTER"]);
    expect(ticketSourcesFor("CLOSED")).not.toContain("CLOSED");
  });

  it("reopens within 7 days of the resolution only", () => {
    expect(canReopen({ status: "RESOLVED", resolvedAt: t0 }, plus(6 * 24 * HOUR))).toBe(true);
    expect(canReopen({ status: "RESOLVED", resolvedAt: t0 }, plus(8 * 24 * HOUR))).toBe(false);
    expect(canReopen({ status: "CLOSED", resolvedAt: t0 }, plus(HOUR))).toBe(false);
    expect(canReopen({ status: "IN_PROGRESS", resolvedAt: null }, plus(HOUR))).toBe(false);
  });
});

describe("lost items", () => {
  it("found / not found / returned / closed", () => {
    expect(canMoveLostItem("REPORTED", "FOUND")).toBe(true);
    expect(canMoveLostItem("REPORTED", "NOT_FOUND")).toBe(true);
    expect(canMoveLostItem("NOT_FOUND", "FOUND")).toBe(true);
    expect(canMoveLostItem("FOUND", "RETURNED")).toBe(true);
    expect(canMoveLostItem("REPORTED", "RETURNED")).toBe(false);
    expect(canMoveLostItem("CLOSED", "FOUND")).toBe(false);
    expect(lostItemSourcesFor("RETURNED")).toEqual(["FOUND"]);
  });

  it("can be reported up to 7 days after a completed trip", () => {
    expect(lostItemReportable({ status: "completed", completedAt: t0 }, plus(6 * 24 * HOUR))).toBe(true);
    expect(lostItemReportable({ status: "completed", completedAt: t0 }, plus(8 * 24 * HOUR))).toBe(false);
    expect(lostItemReportable({ status: "in_progress", completedAt: null }, t0)).toBe(false);
  });
});

describe("SOS", () => {
  it("is available on active trips and 30 min after drop-off", () => {
    for (const status of ["matched", "en_route", "in_progress"]) expect(sosAvailable({ status, completedAt: null }, t0)).toBe(true);
    expect(sosAvailable({ status: "requested", completedAt: null }, t0)).toBe(false);
    expect(sosAvailable({ status: "cancelled", completedAt: null }, t0)).toBe(false);
    expect(sosAvailable({ status: "completed", completedAt: t0 }, plus(29 * MIN))).toBe(true);
    expect(sosAvailable({ status: "completed", completedAt: t0 }, plus(31 * MIN))).toBe(false);
  });

  it("flags an unacknowledged alert after 60 s", () => {
    expect(sosAckOverdue({ status: "OPEN", triggeredAt: t0 }, plus(59_000))).toBe(false);
    expect(sosAckOverdue({ status: "OPEN", triggeredAt: t0 }, plus(61_000))).toBe(true);
    expect(sosAckOverdue({ status: "ACKNOWLEDGED", triggeredAt: t0 }, plus(HOUR))).toBe(false);
  });

  it("OPEN → ACKNOWLEDGED → RESOLVED", () => {
    expect(canMoveSos("OPEN", "ACKNOWLEDGED")).toBe(true);
    expect(canMoveSos("OPEN", "RESOLVED")).toBe(true);
    expect(canMoveSos("ACKNOWLEDGED", "OPEN")).toBe(false);
    expect(canMoveSos("RESOLVED", "ACKNOWLEDGED")).toBe(false);
  });
});

describe("incidents", () => {
  it("can't leave RESOLVED", () => {
    expect(canMoveIncident("OPEN", "INVESTIGATING")).toBe(true);
    expect(canMoveIncident("INVESTIGATING", "RESOLVED")).toBe(true);
    expect(canMoveIncident("RESOLVED", "OPEN")).toBe(false);
  });
});
