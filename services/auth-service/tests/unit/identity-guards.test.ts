import { describe, expect, it, vi } from "vitest";
import type { Principal } from "@ride-app/shared-authz";
import type { Db } from "../../src/db.js";
import { checkOrganizationName, createOrganizationHooks } from "../../src/auth/hooks.js";
import { noopSignals } from "../../src/lib/signals.js";
import { createIdentityService } from "../../src/identity/service.js";

const TARGET = "0190aaaa-0000-7000-8000-000000000001";
const staff = (roles: Principal["roles"], userId = "staff-1"): Principal => ({ userId, audience: "ride-admin", roles, permissionVersion: 0, amr: ["pwd", "otp"] });
const safety = (cityId: string) => staff([{ role: "SAFETY_OFFICER", scope: "CITY", cityId }]);
const superAdmin = (userId = "super-1") => staff([{ role: "SUPER_ADMIN", scope: "GLOBAL" }], userId);

/** Just enough of Prisma for the identity operations under test. */
function fakeDb(opts: { orgCities?: string[]; userRole?: string; banned?: boolean; credential?: boolean } = {}) {
  const tx = {
    user: {
      findUnique: vi.fn(async () => ({ id: TARGET, role: opts.userRole ?? "rider", banned: opts.banned ?? false, accounts: opts.credential ? [{ providerId: "credential" }] : [] })),
      update: vi.fn(async () => ({ permissionVersion: 2 })),
      count: vi.fn(async () => 3),
    },
    member: {
      findMany: vi.fn(async (args: { where: { organization?: unknown } }) =>
        args.where.organization ? (opts.orgCities ?? []).map((cityId) => ({ organization: { cityId } })) : []),
    },
    approvalRequest: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: { data: object }) => ({ id: "req-1", ...args.data })),
    },
    outbox: { createMany: vi.fn(async () => ({ count: 1 })), create: vi.fn(async () => ({})) },
    twoFactor: { deleteMany: vi.fn() },
    account: { updateMany: vi.fn() },
  };
  const db = { ...tx, $transaction: vi.fn(async (f: (t: typeof tx) => unknown) => f(tx)) };
  return { db: db as unknown as Db, tx };
}

const service = (db: Db) => createIdentityService({ db, signals: noopSignals(), sessions: { revokeAllSessions: vi.fn(async () => undefined) } });

describe("suspend / reinstate are scoped by the target's city, not the caller's choice", () => {
  it("a safety officer of the user's organisation city may suspend and reinstate", async () => {
    const { db } = fakeDb({ orgCities: ["addis-ababa"] });
    await expect(service(db).suspendUser(safety("addis-ababa"), TARGET, { reason: "reported for harassment" })).resolves.toMatchObject({ suspended: true });
    const banned = fakeDb({ orgCities: ["addis-ababa"], banned: true });
    await expect(service(banned.db).reinstateUser(safety("addis-ababa"), TARGET, { reason: "investigation closed" })).resolves.toMatchObject({ suspended: false });
  });

  it("an officer of another city is refused, whatever city the request names", async () => {
    const { db, tx } = fakeDb({ orgCities: ["addis-ababa"] });
    const input = { reason: "reported for harassment", cityId: "hawassa" } as { reason: string };
    await expect(service(db).suspendUser(safety("hawassa"), TARGET, input)).rejects.toMatchObject({ statusCode: 403 });
    expect(tx.user.update).not.toHaveBeenCalled();
    const banned = fakeDb({ orgCities: ["addis-ababa"], banned: true });
    await expect(service(banned.db).reinstateUser(safety("hawassa"), TARGET, input)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("a user with no city needs a global grant", async () => {
    const { db } = fakeDb({ orgCities: [] });
    await expect(service(db).suspendUser(safety("addis-ababa"), TARGET, { reason: "reported for harassment" })).rejects.toMatchObject({ statusCode: 403 });
    const globalSafety = staff([{ role: "SAFETY_OFFICER", scope: "GLOBAL" }]);
    await expect(service(db).suspendUser(globalSafety, TARGET, { reason: "reported for harassment" })).resolves.toMatchObject({ suspended: true });
  });
});

describe("staff MFA resets always need a second super admin", () => {
  it("files an approval request for any staff account and never returns a password to the maker", async () => {
    const { db, tx } = fakeDb({ userRole: "", credential: true });
    const res = await service(db).resetMfa(superAdmin(), TARGET, "phone with the authenticator was stolen");
    expect(res).toEqual({ userId: TARGET, pendingApproval: "req-1" });
    expect(res).not.toHaveProperty("temporaryPassword");
    expect(tx.twoFactor.deleteMany).not.toHaveBeenCalled();
    expect(tx.account.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a second request while one is waiting", async () => {
    const { db, tx } = fakeDb({ userRole: "", credential: true });
    tx.approvalRequest.findFirst.mockResolvedValueOnce({ id: "req-0" } as never);
    await expect(service(db).resetMfa(superAdmin(), TARGET, "phone with the authenticator was stolen")).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("organisation names", () => {
  it.each(["Selam Fleet", "Abay Bank S.C.", "ሰላም ትራንስፖርት", "Tom & Sons (Addis)", "Route 66 Taxis"])("accepts %j", (name) => {
    expect(checkOrganizationName(name)).toEqual({ name });
  });

  it.each([
    "Visit anbessa-pay.com", "www Anbessa", "https://x", "Call 0911223344 now", "Call +251 91 122 3344",
    "<b>Bank</b>", "A", "x".repeat(61), "12345", "Pay@here",
  ])("refuses %j", (name) => {
    expect(checkOrganizationName(name)).toHaveProperty("error");
  });

  it("tidies whitespace", () => {
    expect(checkOrganizationName("  Selam   Fleet ")).toEqual({ name: "Selam Fleet" });
  });

  const hooks = (status: string) => createOrganizationHooks({
    organization: { findUnique: vi.fn(async () => ({ id: "org-1", kind: "CORPORATE", name: "Abay Bank", status })) },
  } as unknown as Db);
  const member = { organizationId: "org-1" };

  it("a verified organisation's name can't be changed by its members", async () => {
    await expect(hooks("VERIFIED").beforeUpdateOrganization({ organization: { name: "Anbessa Support: call 0911223344" }, member })).rejects.toThrow(/can't be changed/);
    await expect(hooks("VERIFIED").beforeUpdateOrganization({ organization: { name: "Abay Bank Refunds" }, member })).rejects.toThrow(/can't be changed/);
    // sending the same name back with another change is fine
    await expect(hooks("VERIFIED").beforeUpdateOrganization({ organization: { name: "Abay Bank", logo: "x" }, member })).resolves.toBeUndefined();
  });

  it("a pending organisation may still fix its name, within the same rules", async () => {
    await expect(hooks("PENDING").beforeUpdateOrganization({ organization: { name: "Abay  Bank SC" }, member })).resolves.toEqual({ data: { name: "Abay Bank SC" } });
    await expect(hooks("PENDING").beforeUpdateOrganization({ organization: { name: "abay.com" }, member })).rejects.toThrow(/web address/);
  });
});
