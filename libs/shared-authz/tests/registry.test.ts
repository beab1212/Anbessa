import { afterEach, describe, expect, it } from "vitest";
import {
  builtInSnapshot, can, getAuthzSnapshot, grantableStaffRoles, parseRoleClaims, resetAuthzSnapshot, roleByStored,
  setAuthzSnapshot, type AuthzSnapshot, type Principal,
} from "../src/index.js";

afterEach(resetAuthzSnapshot);

const staff = (roles: Principal["roles"]): Principal => ({ userId: "u", audience: "ride-admin", roles, permissionVersion: 0, amr: ["pwd", "otp"] });
const dispatcher = staff([{ role: "DISPATCHER", scope: "CITY", cityId: "addis-ababa" }]);

function withChange(change: (s: AuthzSnapshot) => void): AuthzSnapshot {
  const s = structuredClone(builtInSnapshot());
  s.version = 7;
  change(s);
  return s;
}

describe("live registry", () => {
  it("authorize follows a swapped matrix without a restart", () => {
    expect(can(dispatcher, "trip:cancel", { cityId: "addis-ababa" })).toBe(true);
    setAuthzSnapshot(withChange((s) => delete s.matrix.DISPATCHER!["trip:cancel"]));
    expect(can(dispatcher, "trip:cancel", { cityId: "addis-ababa" })).toBe(false);
    expect(getAuthzSnapshot().version).toBe(7);
  });

  it("custom roles are parsed from tokens and grant what the matrix says; archived ones are dropped", () => {
    expect(parseRoleClaims([{ r: "CUSTOM_QA", city: "addis-ababa" }], "ride-admin")).toEqual([]);
    setAuthzSnapshot(withChange((s) => {
      s.roles.push({ code: "CUSTOM_QA", label: "QA", audience: "ride-admin", storage: { type: "member", orgKinds: ["STAFF_CITY"] }, stored: "custom_qa", builtIn: false });
      s.matrix.CUSTOM_QA = { "trip:read": "C" };
    }));
    const roles = parseRoleClaims([{ r: "CUSTOM_QA", city: "addis-ababa" }], "ride-admin");
    expect(roles).toEqual([{ role: "CUSTOM_QA", scope: "CITY", cityId: "addis-ababa" }]);
    expect(can(staff(roles), "trip:read", { cityId: "addis-ababa" })).toBe(true);
    expect(roleByStored("custom_qa")?.code).toBe("CUSTOM_QA");
    expect(grantableStaffRoles().map((r) => r.code)).toContain("CUSTOM_QA");
    // not in a rider token
    expect(parseRoleClaims([{ r: "CUSTOM_QA" }], "ride-app")).toEqual([]);

    setAuthzSnapshot(withChange((s) => {
      s.roles.push({ code: "CUSTOM_QA", label: "QA", audience: "ride-admin", storage: { type: "member", orgKinds: ["STAFF_CITY"] }, stored: "custom_qa", builtIn: false, archived: true });
    }));
    expect(parseRoleClaims([{ r: "CUSTOM_QA", city: "addis-ababa" }], "ride-admin")).toEqual([]);
  });

  it("unknown permissions and scope letters in a snapshot are dropped", () => {
    setAuthzSnapshot(withChange((s) => {
      (s.matrix.DISPATCHER as Record<string, string>)["god:mode"] = "G";
      (s.matrix.DISPATCHER as Record<string, string>)["trip:read"] = "X";
    }));
    expect(getAuthzSnapshot().matrix.DISPATCHER).not.toHaveProperty("god:mode");
    expect(can(dispatcher, "trip:read", { cityId: "addis-ababa" })).toBe(false);
  });
});
