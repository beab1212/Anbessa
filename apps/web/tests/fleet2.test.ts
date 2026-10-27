import { describe, expect, it } from "vitest";
import type { Principal } from "@ride-app/shared-authz";
import {
  canListMembers, canReinstateOrg, daysLeftWord, fleetMayAskTransfer, transferActions, transferBody, vehicleSuspendActions, type VehicleTransfer,
} from "../src/lib/fleet2";

const who = (userId: string, roles: { role: string; cityId?: string; orgId?: string }[], audience: Principal["audience"] = "ride-admin"): Principal => ({
  userId, audience, permissionVersion: 1, amr: ["pwd", "otp"],
  roles: roles.map((r) => ({ role: r.role, scope: r.orgId ? "ORG" : r.cityId ? "CITY" : audience === "ride-app" ? "SELF" : "GLOBAL", ...(r.cityId ? { cityId: r.cityId } : {}), ...(r.orgId ? { orgId: r.orgId } : {}) })) as Principal["roles"],
});
const officer = (id: string, cityId = "addis-ababa") => who(id, [{ role: "ONBOARDING_OFFICER", cityId }]);
const transfer = (over: Partial<VehicleTransfer>): VehicleTransfer => ({
  id: "t", vehicleId: "v", cityId: "addis-ababa", status: "PENDING", reason: "sold", requestedBy: null, makerId: "a", checkerId: null, decisionNote: null,
  from: { type: "INDIVIDUAL", id: "d", name: "Abebe" }, to: { type: "ORGANIZATION", id: "o", name: null },
  expiresAt: "2026-11-03T00:00:00Z", decidedAt: null, createdAt: "2026-10-27T00:00:00Z", ...over,
});

describe("ownership transfers: who does what", () => {
  it("a second officer approves; the maker waits or withdraws; other cities and roles do nothing", () => {
    expect(transferActions(officer("a"), transfer({}))).toMatchObject({ approve: false, reject: false, cancel: true, waitingForOther: true });
    expect(transferActions(officer("b"), transfer({}))).toMatchObject({ approve: true, reject: true, cancel: false, endorse: false });
    expect(transferActions(officer("b", "hawassa"), transfer({}))).toMatchObject({ approve: false, reject: false });
    expect(transferActions(who("s", [{ role: "SAFETY_OFFICER", cityId: "addis-ababa" }]), transfer({}))).toMatchObject({ approve: false, reject: false });
  });
  it("an owner's request is proposed first; closed transfers offer nothing", () => {
    expect(transferActions(officer("b"), transfer({ status: "REQUESTED", makerId: null, requestedBy: "d" }))).toMatchObject({ endorse: true, approve: false, reject: true });
    expect(transferActions(who("d", [{ role: "DRIVER" }], "ride-app"), transfer({ status: "REQUESTED", makerId: null, requestedBy: "d" }))).toMatchObject({ cancel: true, endorse: false });
    expect(transferActions(officer("b"), transfer({ status: "EXECUTED" }))).toEqual({ endorse: false, approve: false, reject: false, cancel: false, waitingForOther: false });
  });
  it("the fleet portal asks with a driver or a company id and a 10-character reason", () => {
    expect(transferBody({ target: "driver", driverId: "u1", orgId: "", reason: "short" })).toBeNull();
    expect(transferBody({ target: "driver", driverId: "u1", orgId: "", reason: "sold to our driver" })).toEqual({ toOwnerType: "INDIVIDUAL", toOwnerId: "u1", reason: "sold to our driver" });
    expect(transferBody({ target: "company", driverId: "", orgId: "not-an-id", reason: "moving to sister company" })).toBeNull();
    const id = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    expect(transferBody({ target: "company", driverId: "", orgId: ` ${id.toUpperCase()} `, reason: "moving to sister company" })).toMatchObject({ toOwnerType: "ORGANIZATION", toOwnerId: id });
    const fleetOwner = who("f", [{ role: "FLEET_OWNER", orgId: "o1" }], "ride-app");
    expect(fleetMayAskTransfer(fleetOwner, "o1", { status: "VERIFIED" })).toBe(true);
    expect(fleetMayAskTransfer(fleetOwner, "o2", { status: "VERIFIED" })).toBe(false);
    expect(fleetMayAskTransfer(fleetOwner, "o1", { status: "RETIRED" })).toBe(false);
  });
});

describe("vehicle suspension, company reinstatement and members", () => {
  it("onboarding and safety suspend verified cars and reinstate suspended ones, in their city", () => {
    const car = { status: "VERIFIED" as const, cityId: "addis-ababa" };
    expect(vehicleSuspendActions(officer("a"), car)).toEqual({ suspend: true, reinstate: false });
    expect(vehicleSuspendActions(who("s", [{ role: "SAFETY_OFFICER", cityId: "addis-ababa" }]), { ...car, status: "SUSPENDED" })).toEqual({ suspend: false, reinstate: true });
    expect(vehicleSuspendActions(officer("a", "hawassa"), car)).toEqual({ suspend: false, reinstate: false });
    expect(vehicleSuspendActions(who("d", [{ role: "DISPATCHER", cityId: "addis-ababa" }]), car)).toEqual({ suspend: false, reinstate: false });
  });
  it("whoever may suspend a company lifts it; members open for org:read or org:suspend", () => {
    const org = { status: "SUSPENDED", cityId: "addis-ababa" };
    expect(canReinstateOrg(who("s", [{ role: "SAFETY_OFFICER", cityId: "addis-ababa" }]), org)).toBe(true);
    expect(canReinstateOrg(who("f", [{ role: "FINANCE_OFFICER" }]), org)).toBe(true);
    expect(canReinstateOrg(officer("a"), org)).toBe(false);
    expect(canReinstateOrg(who("s", [{ role: "SAFETY_OFFICER", cityId: "addis-ababa" }]), { ...org, status: "VERIFIED" })).toBe(false);
    expect(canListMembers(officer("a"), "addis-ababa")).toBe(true);
    expect(canListMembers(who("s", [{ role: "SAFETY_OFFICER", cityId: "addis-ababa" }]), "addis-ababa")).toBe(true);
    expect(canListMembers(who("d", [{ role: "DISPATCHER", cityId: "addis-ababa" }]), "addis-ababa")).toBe(false);
  });
  it("words for days left", () => {
    expect(daysLeftWord(-1)).toBe("expired 1 day ago");
    expect(daysLeftWord(-3)).toBe("expired 3 days ago");
    expect(daysLeftWord(0)).toBe("expires today");
    expect(daysLeftWord(1)).toBe("in 1 day");
    expect(daysLeftWord(null)).toBe("no date");
  });
});
