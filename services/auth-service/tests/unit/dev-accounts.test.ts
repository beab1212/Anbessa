import { describe, expect, it } from "vitest";
import { ROLES } from "@ride-app/shared-authz";
import { ETHIOPIAN_MOBILE } from "../../src/auth/password.js";
import { createOtpInbox, DEV_ACCOUNTS, DEV_ORGS, totp } from "../../src/dev/accounts.js";

describe("dev sign-in", () => {
  // RFC 6238 appendix B, SHA-1, last 6 of the 8 digits
  it.each([
    [59, "287082"],
    [1_111_111_109, "081804"],
    [1_234_567_890, "005924"],
  ])("TOTP at %i s is %s", (seconds, code) => {
    expect(totp("12345678901234567890", seconds * 1000)).toBe(code);
  });

  it("lists accounts that the seed can create", () => {
    const keys = DEV_ACCOUNTS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const a of DEV_ACCOUNTS) {
      if (a.surface === "staff") {
        expect(a.email).toMatch(/@staff\.anbessa\.test$/);
        for (const r of a.roles) expect(ROLES[r].audience).toBe("ride-admin");
      } else {
        expect(a.phone).toMatch(ETHIOPIAN_MOBILE);
        for (const m of a.memberships) {
          const org = DEV_ORGS.find((o) => o.slug === m.org)!;
          expect(ROLES[m.role].storage).toEqual({ type: "member", orgKinds: [org.kind] });
        }
      }
    }
  });

  it("keeps the last OTP per phone until it expires", () => {
    const inbox = createOtpInbox(1000);
    inbox.put("+251900000101", "111111");
    inbox.put("+251900000101", "222222");
    expect(inbox.latest("+251900000101")).toBe("222222");
    expect(inbox.latest("+251900000999")).toBeUndefined();
  });
});
