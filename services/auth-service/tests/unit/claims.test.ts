import { describe, expect, it, vi } from "vitest";
import { createClaimsBuilder, selectRolesForSurface } from "../../src/auth/claims.js";
import type { Db } from "../../src/db.js";

const mixed = [
  { role: "RIDER" as const, scope: "SELF" as const },
  { role: "SUPER_ADMIN" as const, scope: "GLOBAL" as const },
  { role: "DISPATCHER" as const, scope: "CITY" as const, cityId: "addis-ababa" },
];
const ready = { id: "u1", twoFactorEnabled: true, mustChangePassword: false };

describe("selectRolesForSurface", () => {
  it("app tokens carry only customer/partner roles", () => {
    expect(selectRolesForSurface(mixed, "app", ready)).toEqual([{ role: "RIDER", scope: "SELF" }]);
  });

  it("admin tokens carry only staff roles", () => {
    expect(selectRolesForSurface(mixed, "admin", ready).map((a) => a.role)).toEqual(["SUPER_ADMIN", "DISPATCHER"]);
  });

  it("admin tokens carry no roles without two-factor", () => {
    expect(selectRolesForSurface(mixed, "admin", { ...ready, twoFactorEnabled: false })).toEqual([]);
  });

  it("admin tokens carry no roles until the initial password is changed", () => {
    expect(selectRolesForSurface(mixed, "admin", { ...ready, mustChangePassword: true })).toEqual([]);
  });
});

describe("createClaimsBuilder", () => {
  const db = { member: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as Db;

  it("refuses an app session on the admin surface and vice versa", async () => {
    await expect(createClaimsBuilder(db, "admin")({ user: ready, session: { surface: "app" } })).rejects.toThrow(/surface/);
    await expect(createClaimsBuilder(db, "app")({ user: ready, session: { surface: "admin" } })).rejects.toThrow(/surface/);
  });

  it("refuses banned users", async () => {
    await expect(createClaimsBuilder(db, "app")({ user: { ...ready, banned: true }, session: { surface: "app" } })).rejects.toThrow(/suspended/);
  });

  it("builds minimal claims without PII", async () => {
    const claims = await createClaimsBuilder(db, "app")({ user: { ...ready, role: "rider", permissionVersion: 4 }, session: { surface: "app" } });
    expect(claims).toEqual({ roles: [{ r: "RIDER" }], pv: 4, amr: ["otp"] });
  });

  it("tells the dashboard what setup is missing", async () => {
    const claims = await createClaimsBuilder(db, "admin")({
      user: { id: "u1", role: "super_admin", twoFactorEnabled: false, mustChangePassword: true },
      session: { surface: "admin" },
    });
    expect(claims).toMatchObject({ roles: [], amr: ["pwd"], setup: { twoFactor: true, changePassword: true } });
  });

  it("marks global staff roles", async () => {
    const claims = await createClaimsBuilder(db, "admin")({ user: { ...ready, role: "super_admin" }, session: { surface: "admin" } });
    expect(claims).toMatchObject({ roles: [{ r: "SUPER_ADMIN", g: true }], amr: ["pwd", "otp"] });
  });
});
