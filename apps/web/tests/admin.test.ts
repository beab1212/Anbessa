import { describe, expect, it } from "vitest";
import type { Principal } from "@ride-app/shared-authz";
import { decodeClaims, principalOf } from "../src/lib/api";
import { inAnyCity, reportScope, statsPath, suspendUntil } from "../src/lib/account";

const token = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const staff = (roles: object[]): Principal => principalOf("staff", decodeClaims(token({ sub: "u", exp: 0, pv: 0, amr: [], roles })));
const CITIES = ["addis-ababa", "hawassa"];

describe("overview: whose numbers", () => {
  it("global report readers see every city; city-scoped ones only theirs", () => {
    expect(reportScope(staff([{ r: "SUPER_ADMIN", g: true }]), CITIES)).toEqual({ global: true, cities: CITIES });
    expect(reportScope(staff([{ r: "DISPATCHER", city: "hawassa" }]), CITIES)).toEqual({ global: false, cities: ["hawassa"] });
    expect(reportScope(staff([{ r: "ANALYST", city: "addis-ababa" }, { r: "MARKETING", city: "hawassa" }]), CITIES)).toEqual({ global: false, cities: CITIES });
    expect(reportScope(staff([{ r: "REGULATOR", g: true }]), CITIES)).toEqual({ global: false, cities: [] });
    expect(reportScope(null, CITIES)).toEqual({ global: false, cities: [] });
  });

  it("asks each service for one city, or for all of them", () => {
    expect(statsPath("/api/trips/stats", null)).toBe("/api/trips/stats");
    expect(statsPath("/api/fleet/stats", "addis-ababa")).toBe("/api/fleet/stats?cityId=addis-ababa");
  });
});

describe("users: links and suspension length", () => {
  it("a permission held in any city or globally counts", () => {
    expect(inAnyCity(staff([{ r: "ONBOARDING_OFFICER", city: "hawassa" }]), "driver:read", CITIES)).toBe(true);
    expect(inAnyCity(staff([{ r: "FINANCE_OFFICER", g: true }]), "balance:read", CITIES)).toBe(true);
    expect(inAnyCity(staff([{ r: "MARKETING", city: "addis-ababa" }]), "driver:read", CITIES)).toBe(false);
    expect(inAnyCity(null, "driver:read", CITIES)).toBe(false);
  });

  it("open-ended, a fixed length, or the start of a chosen day in Addis Ababa", () => {
    const now = Date.parse("2026-10-27T09:00:00Z");
    expect(suspendUntil("", "", now)).toBeUndefined();
    expect(suspendUntil("1d", "", now)).toBe("2026-10-28T09:00:00.000Z");
    expect(suspendUntil("30d", "", now)).toBe("2026-11-26T09:00:00.000Z");
    expect(suspendUntil("date", "2026-11-01", now)).toBe("2026-10-31T21:00:00.000Z");
    expect(suspendUntil("date", "2026-10-27", now)).toBe("invalid"); // already started
    expect(suspendUntil("date", "", now)).toBe("invalid");
  });
});
