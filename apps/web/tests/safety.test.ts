import { describe, expect, it } from "vitest";
import { actionProblems, addisLocalNow, addisLocalToIso, isUserId } from "../src/pages/staff/Safety";

describe("safety: suspend form", () => {
  it("recognises a pasted user id", () => {
    expect(isUserId("01a17557-ef39-7ee9-b4c2-6b045e0dd06b")).toBe(true);
    expect(isUserId("  01A17557-EF39-7EE9-B4C2-6B045E0DD06B ")).toBe(true);
    expect(isUserId("01a17557ef397ee9b4c26b045e0dd06b")).toBe(false);
    expect(isUserId("Abebe")).toBe(false);
  });

  it("reads the until field as Addis Ababa time (UTC+3)", () => {
    expect(addisLocalToIso("2026-10-27T18:30")).toBe("2026-10-27T15:30:00.000Z");
    expect(addisLocalToIso("2026-10-28T01:00")).toBe("2026-10-27T22:00:00.000Z");
    expect(addisLocalToIso("")).toBeNull();
    expect(addisLocalToIso("tomorrow")).toBeNull();
    expect(addisLocalNow(Date.parse("2026-10-27T15:30:00Z"))).toBe("2026-10-27T18:30");
  });

  it("asks for a 10–500 character reason and a future end", () => {
    const now = Date.parse("2026-10-27T12:00:00Z");
    expect(actionProblems({ reason: "short", now })).toEqual(["Reason: 5 more characters"]);
    expect(actionProblems({ reason: "x".repeat(501), now })).toEqual(["Reason: 500 characters at most"]);
    const ok = "Ticket 4411: assaulted a driver";
    expect(actionProblems({ reason: ok, now })).toEqual([]);
    expect(actionProblems({ reason: ok, until: "", now })).toEqual([]);
    expect(actionProblems({ reason: ok, until: "2026-10-27T15:00", now })).toEqual(["Until: must be in the future"]); // = 12:00Z
    expect(actionProblems({ reason: ok, until: "2026-10-27T15:01", now })).toEqual([]);
    expect(actionProblems({ reason: ok, until: "soon", now })).toEqual(["Until: not a date and time"]);
  });
});
