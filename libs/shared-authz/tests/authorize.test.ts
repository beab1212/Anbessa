import { describe, expect, it } from "vitest";
import {
  authorize, AuthorizationError, can, citiesWith, MATRIX, parseRoleClaims, PERMISSIONS,
  ROLE_CODES, ROLES, rolesForOrgKind, toRoleClaim, type Principal,
} from "../src/index.js";

const principal = (roles: Principal["roles"], userId = "u1", audience: Principal["audience"] = "ride-app"): Principal => ({
  userId, audience, roles, permissionVersion: 0, amr: [],
});

describe("matrix integrity", () => {
  it("only references known permissions", () => {
    for (const code of ROLE_CODES) {
      for (const p of Object.keys(MATRIX[code])) expect(PERMISSIONS).toContain(p);
    }
  });

  it("staff (admin-audience) roles never get SELF-scoped grants, customer roles never get CITY/GLOBAL", () => {
    for (const code of ROLE_CODES) {
      const letters = Object.values(MATRIX[code]);
      if (ROLES[code].audience === "ride-admin") expect(letters).not.toContain("S");
      else for (const l of letters) expect(["S", "O"]).toContain(l);
    }
  });

  it("no role can both request and approve the same kind of money action", () => {
    for (const code of ROLE_CODES) {
      const grants = MATRIX[code];
      expect(grants["refund:request"] && grants["refund:approve"]).toBeFalsy();
      expect(grants["payout:prepare"] && grants["payout:approve"]).toBeFalsy();
      expect(grants["topup:record_cash"] && grants["topup:approve_cash"]).toBeFalsy();
      expect(grants["writeoff:request"] && grants["writeoff:approve"]).toBeFalsy();
    }
  });

  it("super admin manages roles but has no money, safety or dispatch powers", () => {
    const sa = MATRIX.SUPER_ADMIN;
    for (const p of ["refund:approve", "payout:approve", "user:suspend", "trip:assign", "user:read_pii"] as const) {
      expect(sa[p]).toBeUndefined();
    }
  });
});

describe("scope checks", () => {
  it("SELF: a rider can read their own trip only", () => {
    const rider = principal([{ role: "RIDER", scope: "SELF" }]);
    expect(can(rider, "trip:read", { ownerUserIds: ["u1", "driver-9"] })).toBe(true);
    expect(can(rider, "trip:read", { ownerUserIds: ["someone-else"] })).toBe(false);
    expect(can(rider, "trip:read", {})).toBe(false);
  });

  it("ORG: a fleet owner manages their own fleet, not another one", () => {
    const owner = principal([{ role: "FLEET_OWNER", scope: "ORG", orgId: "org-a" }]);
    expect(can(owner, "vehicle:authorize_driver", { orgId: "org-a" })).toBe(true);
    expect(can(owner, "vehicle:authorize_driver", { orgId: "org-b" })).toBe(false);
    expect(can(owner, "vehicle:authorize_driver", {})).toBe(false);
  });

  it("CITY: a dispatcher assigns trips only in their city", () => {
    const d = principal([{ role: "DISPATCHER", scope: "CITY", cityId: "addis-ababa" }], "s1", "ride-admin");
    expect(can(d, "trip:assign", { cityId: "addis-ababa" })).toBe(true);
    expect(can(d, "trip:assign", { cityId: "adama" })).toBe(false);
    expect(can(d, "refund:approve", { cityId: "addis-ababa" })).toBe(false);
  });

  it("GLOBAL: finance manager approves refunds anywhere; a global analyst reads reports in every city", () => {
    const fm = principal([{ role: "FINANCE_MANAGER", scope: "GLOBAL" }], "s2", "ride-admin");
    expect(can(fm, "refund:approve", { cityId: "adama" })).toBe(true);
    const analyst = principal([{ role: "ANALYST", scope: "GLOBAL" }], "s3", "ride-admin");
    expect(can(analyst, "report:read", { cityId: "adama" })).toBe(true);
    expect(citiesWith(analyst, "report:read")).toBe("*");
  });

  it("authorize throws a 403 AuthorizationError", () => {
    const rider = principal([{ role: "RIDER", scope: "SELF" }]);
    expect(() => authorize(rider, "trip:assign", { cityId: "addis-ababa" })).toThrow(AuthorizationError);
  });

  it("citiesWith lists only the cities a staff member covers", () => {
    const p = principal([
      { role: "SUPPORT_AGENT", scope: "CITY", cityId: "addis-ababa" },
      { role: "SUPPORT_AGENT", scope: "CITY", cityId: "adama" },
    ], "s4", "ride-admin");
    expect(citiesWith(p, "ticket:read")).toEqual(["addis-ababa", "adama"]);
    expect(citiesWith(p, "trip:assign")).toEqual([]);
  });
});

describe("claims", () => {
  it("round-trips assignments through the compact claim form", () => {
    const roles: Principal["roles"] = [
      { role: "DISPATCHER", scope: "CITY", cityId: "addis-ababa" },
      { role: "FINANCE_OFFICER", scope: "GLOBAL" },
    ];
    expect(parseRoleClaims(roles.map(toRoleClaim), "ride-admin")).toEqual(roles);
  });

  it("drops unknown roles, malformed items and roles from the other audience", () => {
    const parsed = parseRoleClaims(
      [{ r: "RIDER" }, { r: "GOD_MODE" }, null, 42, { r: "SUPER_ADMIN", g: true }],
      "ride-app",
    );
    expect(parsed).toEqual([{ role: "RIDER", scope: "SELF" }]);
  });

  it("org kinds only accept their own member roles", () => {
    expect(rolesForOrgKind("FLEET")).toEqual(["FLEET_OWNER", "FLEET_DRIVER"]);
    expect(rolesForOrgKind("CORPORATE")).not.toContain("DISPATCHER");
    expect(rolesForOrgKind("STAFF_CITY")).toContain("DISPATCHER");
    expect(rolesForOrgKind("STAFF_CITY")).not.toContain("SUPER_ADMIN");
  });
});
