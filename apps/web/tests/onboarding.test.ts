import { describe, expect, it } from "vitest";
import type { Principal } from "@ride-app/shared-authz";
import { companyCities, companyPowers, orgActions } from "../src/pages/staff/Onboarding";

const staff = (roles: { role: string; cityId?: string }[]): Principal => ({
  userId: "u1",
  audience: "ride-admin",
  roles: roles.map((r) => ({ role: r.role, scope: r.cityId ? "CITY" : "GLOBAL", ...(r.cityId ? { cityId: r.cityId } : {}) })) as Principal["roles"],
  permissionVersion: 1,
  amr: ["pwd", "otp"],
});

describe("companies: who sees and does what", () => {
  const cities = ["addis-ababa", "hawassa"];

  it("opens for org:read or org:suspend, city by city", () => {
    expect(companyCities(staff([{ role: "ONBOARDING_OFFICER", cityId: "hawassa" }]), cities)).toEqual(["hawassa"]);
    expect(companyCities(staff([{ role: "SAFETY_OFFICER", cityId: "addis-ababa" }]), cities)).toEqual(["addis-ababa"]);
    expect(companyCities(staff([{ role: "FINANCE_OFFICER" }]), cities)).toEqual(cities);
    expect(companyCities(staff([{ role: "DISPATCHER", cityId: "addis-ababa" }]), cities)).toEqual([]);
    expect(companyCities(null, cities)).toEqual([]);
  });

  it("verify for onboarding, suspend for safety; nothing in other cities", () => {
    const onboarding = companyPowers(staff([{ role: "ONBOARDING_OFFICER", cityId: "addis-ababa" }]), "addis-ababa");
    expect(onboarding).toMatchObject({ verify: true, suspend: false, readDocuments: true, reviewDocuments: true, readVehicles: true });
    const safety = companyPowers(staff([{ role: "SAFETY_OFFICER", cityId: "addis-ababa" }]), "addis-ababa");
    expect(safety).toMatchObject({ verify: false, suspend: true, readDocuments: false });
    expect(companyPowers(staff([{ role: "SAFETY_OFFICER", cityId: "addis-ababa" }]), "hawassa").suspend).toBe(false);
  });

  it("offers verify only while waiting, suspend until suspended, and never a lift", () => {
    const both = { verify: true, suspend: true };
    expect(orgActions("PENDING", both)).toEqual({ verify: true, suspend: true });
    expect(orgActions("VERIFIED", both)).toEqual({ verify: false, suspend: true });
    expect(orgActions("SUSPENDED", both)).toEqual({ verify: false, suspend: false });
    expect(orgActions("PENDING", { verify: false, suspend: false })).toEqual({ verify: false, suspend: false });
  });
});
