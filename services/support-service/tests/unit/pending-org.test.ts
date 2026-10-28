// A fleet owner in a partner organisation that isn't verified yet sees no lost-item reports of
// that fleet's cars: pending assignments are skipped, not just left to can().
import { describe, expect, it } from "vitest";
import { parseRoleClaims, type Principal } from "@ride-app/shared-authz";
import { fleetOrgs } from "../../src/support/lost-items.js";

const principal = (claims: object[]): Principal => ({
  userId: "00000000-0000-0000-0000-000000000001", audience: "ride-app", roles: parseRoleClaims(claims, "ride-app"), permissionVersion: 0, amr: ["otp"],
});

describe("fleetOrgs", () => {
  it("includes a verified fleet", () => {
    expect(fleetOrgs(principal([{ r: "FLEET_OWNER", org: "11111111-1111-1111-1111-111111111111" }]))).toEqual(["11111111-1111-1111-1111-111111111111"]);
  });
  it("skips an organisation that isn't verified yet", () => {
    expect(fleetOrgs(principal([{ r: "FLEET_OWNER", pendingOrg: "22222222-2222-2222-2222-222222222222" }]))).toEqual([]);
    expect(fleetOrgs({ ...principal([]), roles: [{ role: "FLEET_OWNER", scope: "ORG", orgId: "33333333-3333-3333-3333-333333333333", pending: true }] })).toEqual([]);
  });
});
