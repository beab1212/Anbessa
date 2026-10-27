import { describe, expect, it } from "vitest";
import type { Principal } from "@ride-app/shared-authz";
import { decodeClaims, principalOf } from "../src/lib/api";
import {
  anyInAnyCity, birrPlain, canListTopUps, canReadPayouts, citiesWithAny, csvCell, csvName, decided, everywhere, inAnyCity, isUuid, joinPages,
  lineTotals, nextBefore, PAYMENT_CSV, PAYMENT_READERS, queryString, RULE_DECIDERS, RULE_VIEWERS, toCsv, type Payment,
} from "../src/lib/money";

describe("CSV export", () => {
  it("quotes only what needs quoting", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(12)).toBe("12");
    expect(csvCell(false)).toBe("false");
  });

  it("defuses text a spreadsheet would run as a formula, but keeps negative numbers", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("+251911")).toBe("'+251911");
    expect(csvCell("@me")).toBe("'@me");
    expect(csvCell("-12.50")).toBe("-12.50");
    expect(csvCell("-x")).toBe("'-x");
  });

  it("writes a header line and CRLF rows", () => {
    const csv = toCsv([{ a: 1, b: "x,y" }, { a: 2, b: null }], [["a", (r) => r.a], ["b", (r) => r.b]]);
    expect(csv).toBe('a,b\r\n1,"x,y"\r\n2,\r\n');
  });

  it("amounts are birr with two decimals; payments export every shown column", () => {
    expect(birrPlain(12350)).toBe("123.50");
    expect(birrPlain(-500)).toBe("-5.00");
    expect(birrPlain(null)).toBe("");
    const pay = {
      id: "p1", tripId: "t1", cityId: "addis-ababa", purpose: "TRIP_FARE", method: "MOBILE_MONEY", provider: "telebirr", amountMinor: 20300,
      refundedMinor: 0, status: "SUCCEEDED", attempts: 1, createdAt: "2026-10-27T08:00:00.000Z", completedAt: null,
    } as unknown as Payment;
    const [head, row] = toCsv([pay], PAYMENT_CSV).split("\r\n");
    expect(head).toBe("created_at,payment_id,trip_id,city,purpose,method,provider,amount_etb,refunded_etb,status,attempts,completed_at");
    expect(row).toBe("2026-10-27T08:00:00.000Z,p1,t1,addis-ababa,TRIP_FARE,MOBILE_MONEY,telebirr,203.00,0.00,SUCCEEDED,1,");
  });

  it("names the file with the Addis Ababa date", () => {
    expect(csvName("payments", new Date("2026-10-27T22:30:00Z"))).toBe("payments-2026-10-28.csv");
  });
});

describe("paging and filters", () => {
  it("builds query strings from the set values only", () => {
    expect(queryString({ status: "", provider: "telebirr", tripId: undefined, limit: 50, open: false, x: null })).toBe("provider=telebirr&limit=50");
    expect(queryString({ q: "ANB 7K" })).toBe("q=ANB+7K");
  });

  it("follows the before cursor until it runs out", () => {
    expect(nextBefore({ next: "2026-10-27T08:00:00.000Z" })).toBe("2026-10-27T08:00:00.000Z");
    expect(nextBefore({ next: null })).toBeUndefined();
  });

  it("joins pages without duplicates", () => {
    expect(joinPages([[{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "c" }]]).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(joinPages([])).toEqual([]);
  });

  it("history leaves out what still waits", () => {
    const rows = [{ status: "PENDING_APPROVAL" }, { status: "SUCCEEDED" }, { status: "REJECTED" }, { status: "PENDING" }];
    expect(decided(rows).map((r) => r.status)).toEqual(["SUCCEEDED", "REJECTED"]);
    expect(decided(rows, ["PENDING_APPROVAL"]).map((r) => r.status)).toEqual(["SUCCEEDED", "REJECTED", "PENDING"]);
  });

  it("recognises a full trip id", () => {
    expect(isUuid("01a17557-ef39-7ee9-b4c2-6b045e0dd06b")).toBe(true);
    expect(isUuid(" 01A17557-EF39-7EE9-B4C2-6B045E0DD06B ")).toBe(true);
    expect(isUuid("0DD06B")).toBe(false);
  });

  it("sums payout lines by status", () => {
    expect(lineTotals([{ status: "SUCCEEDED", amountMinor: 100 }, { status: "FAILED", amountMinor: 50 }, { status: "SUCCEEDED", amountMinor: 25 }])).toEqual({
      SUCCEEDED: { count: 2, amountMinor: 125 }, FAILED: { count: 1, amountMinor: 50 },
    });
  });
});

describe("which money lists a person can ask for (UI only; payment-service checks again)", () => {
  const token = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
  const staff = (roles: object[]): Principal => principalOf("staff", decodeClaims(token({ sub: "u", exp: 0, pv: 0, amr: [], roles })));

  it("a city support agent has balances in their city only, not the platform-wide view", () => {
    const agent = staff([{ r: "SUPPORT_AGENT", city: "addis-ababa" }]);
    expect(inAnyCity(agent, "balance:read")).toBe(true);
    expect(everywhere(agent, "balance:read")).toBe(false);
    expect(citiesWithAny(agent, ["balance:read"], ["addis-ababa", "hawassa"])).toEqual(["addis-ababa"]);
    expect(anyInAnyCity(agent, PAYMENT_READERS)).toBe(true);
    expect(canReadPayouts(agent)).toBe(false);
    expect(canListTopUps(agent)).toBe(false);
  });

  it("finance roles read payouts and top-ups everywhere", () => {
    for (const r of ["FINANCE_OFFICER", "FINANCE_MANAGER"]) {
      const p = staff([{ r }]);
      expect(canReadPayouts(p)).toBe(true);
      expect(canListTopUps(p)).toBe(true);
    }
  });

  it("only rule proposers and approvers get pending rule changes; readers see a city's history", () => {
    const ops = staff([{ r: "OPERATIONS_MANAGER", city: "hawassa" }]);
    expect(anyInAnyCity(ops, RULE_DECIDERS)).toBe(true);
    expect(citiesWithAny(ops, RULE_VIEWERS, ["addis-ababa", "hawassa"])).toEqual(["hawassa"]);
    expect(anyInAnyCity(staff([{ r: "DISPATCHER", city: "hawassa" }]), RULE_DECIDERS)).toBe(false);
    expect(inAnyCity(null, "balance:read")).toBe(false);
  });
});
