import { describe, expect, it } from "vitest";
import type { Principal } from "@ride-app/shared-authz";
import { birr, phone, phoneToPlaceholderEmail, placeholderEmailToPhone, shortId, since, toE164 } from "../src/lib/format";
import { decodeClaims, principalOf } from "../src/lib/api";
import { staffSections } from "../src/App";

describe("format", () => {
  it("reads Ethiopian mobiles the way people type them", () => {
    for (const typed of ["0911223344", "911223344", "+251911223344", "251 911 22 33 44", "09 11 22 33 44"]) expect(toE164(typed)).toBe("+251911223344");
    expect(toE164("0711223344")).toBe("+251711223344");
    expect(toE164("0811223344")).toBeNull();
    expect(toE164("+15551234567")).toBeNull();
    expect(phone("+251911223344")).toBe("+251 91 122 3344");
  });

  it("maps phone-only accounts to their placeholder email and back", () => {
    expect(phoneToPlaceholderEmail("+251911223344")).toBe("251911223344@phone.anbessa.invalid");
    expect(placeholderEmailToPhone("251911223344@phone.anbessa.invalid")).toBe("+251911223344");
    expect(placeholderEmailToPhone("someone@example.com")).toBeNull();
  });

  it("money is santim; times are short", () => {
    expect(birr(20300)).toBe("203 ETB");
    expect(birr(12350)).toBe("123.50 ETB");
    expect(birr(null)).toBe("—");
    expect(shortId("01a17557-ef39-7ee9-b4c2-6b045e0dd06b")).toBe("0DD06B");
    const now = Date.parse("2026-10-26T10:00:00Z");
    expect(since("2026-10-26T09:59:40Z", now)).toBe("just now");
    expect(since("2026-10-26T09:52:00Z", now)).toBe("8 min");
    expect(since("2026-10-26T08:55:00Z", now)).toBe("1 h 05");
  });
});

describe("claims → navigation (UI only; services check again)", () => {
  const token = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
  const staff = (roles: object[]): Principal => principalOf("staff", decodeClaims(token({ sub: "u", exp: 0, pv: 0, amr: [], roles })));
  const pages = (p: Principal) => staffSections(p).flatMap((s) => s.items.map((i) => i.label));

  it("a dispatcher sees the board, drivers and trips, nothing about accounts", () => {
    expect(pages(staff([{ r: "DISPATCHER", city: "addis-ababa" }]))).toEqual(["Live board", "Drivers", "Find a trip"]);
  });

  it("a super admin manages people, not trips", () => {
    expect(pages(staff([{ r: "SUPER_ADMIN", g: true }]))).toEqual(["Staff and roles"]);
  });

  it("the call center books by phone; onboarding sees companies; safety suspends", () => {
    expect(pages(staff([{ r: "CALL_CENTER_AGENT", city: "addis-ababa" }]))).toContain("Book by phone");
    expect(pages(staff([{ r: "ONBOARDING_OFFICER", city: "addis-ababa" }]))).toContain("Companies");
    expect(pages(staff([{ r: "SAFETY_OFFICER", city: "addis-ababa" }]))).toContain("Suspend");
  });

  it("app-audience roles in a staff token give nothing (they're dropped)", () => {
    expect(pages(staff([{ r: "RIDER" }, { r: "FLEET_OWNER", org: "o" }]))).toEqual([]);
  });
});
