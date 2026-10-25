import { describe, expect, it } from "vitest";
import { joinRoles, splitRoles, toAssignments, type MembershipRow } from "../../src/auth/roles-codec.js";

const org = (kind: string, status = "VERIFIED", id = "org-1", cityId = "addis-ababa") => ({ id, kind, cityId, status });
const member = (role: string, organization: MembershipRow["organization"], validUntil: Date | null = null): MembershipRow => ({
  role, organization, validUntil,
});

describe("splitRoles / joinRoles", () => {
  it("round-trips, trims, dedupes and sorts", () => {
    expect(splitRoles(" rider , driver,,")).toEqual(["rider", "driver"]);
    expect(joinRoles(["rider", "driver", "rider"])).toBe("driver,rider");
    expect(splitRoles(null)).toEqual([]);
  });
});

describe("toAssignments", () => {
  it("maps user-level roles: customers to SELF, staff to GLOBAL", () => {
    expect(toAssignments("rider,driver,super_admin", [])).toEqual([
      { role: "RIDER", scope: "SELF" },
      { role: "DRIVER", scope: "SELF" },
      { role: "SUPER_ADMIN", scope: "GLOBAL" },
    ]);
  });

  it("ignores unknown roles and member-only roles stored on the user", () => {
    expect(toAssignments("rider,root,call_center_agent,fleet_owner", [])).toEqual([{ role: "RIDER", scope: "SELF" }]);
  });

  it("maps staff city membership to CITY scope", () => {
    const rows = [member("call_center_agent,dispatcher", org("STAFF_CITY"))];
    expect(toAssignments("", rows)).toEqual([
      { role: "CALL_CENTER_AGENT", scope: "CITY", cityId: "addis-ababa" },
      { role: "DISPATCHER", scope: "CITY", cityId: "addis-ababa" },
    ]);
  });

  it("maps fleet/corporate membership to ORG scope", () => {
    const rows = [member("fleet_driver", org("FLEET")), member("employee", org("CORPORATE", "VERIFIED", "org-2"))];
    expect(toAssignments("", rows)).toEqual([
      { role: "FLEET_DRIVER", scope: "ORG", orgId: "org-1" },
      { role: "CORPORATE_EMPLOYEE", scope: "ORG", orgId: "org-2" },
    ]);
  });

  it("refuses roles in the wrong kind of organisation (no privilege smuggling)", () => {
    const rows = [
      member("super_admin", org("FLEET")),
      member("call_center_agent", org("FLEET")),
      member("fleet_owner", org("STAFF_CITY")),
      member("employee", org("FLEET")),
    ];
    expect(toAssignments("", rows)).toEqual([]);
  });

  it("drops expired memberships and suspended organisations", () => {
    const past = new Date(Date.now() - 1000);
    const rows = [member("dispatcher", org("STAFF_CITY"), past), member("fleet_driver", org("FLEET", "SUSPENDED"))];
    expect(toAssignments("", rows)).toEqual([]);
  });

  it("keeps only the owner/admin of a partner organisation that isn't verified yet", () => {
    const rows = [member("fleet_owner", org("FLEET", "PENDING")), member("fleet_driver", org("FLEET", "PENDING"))];
    expect(toAssignments("", rows)).toEqual([{ role: "FLEET_OWNER", scope: "ORG", orgId: "org-1" }]);
  });
});
