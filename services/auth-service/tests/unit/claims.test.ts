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
  type Row = { id: string; role?: string; permissionVersion?: number; twoFactorEnabled?: boolean; mustChangePassword?: boolean; banned?: boolean };
  /** `row` is the user as stored now; the session only carries the id (its cached copy is ignored). */
  const build = (surface: "app" | "admin", row: Row | null, sessionSurface = surface, sessionCopy: object = {}) => {
    const db = {
      member: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findUnique: vi.fn().mockResolvedValue(row && { role: "", permissionVersion: 0, twoFactorEnabled: false, mustChangePassword: false, banned: false, ...row }) },
    } as unknown as Db;
    return createClaimsBuilder(db, surface)({ user: { id: row?.id ?? "gone", ...sessionCopy }, session: { surface: sessionSurface } });
  };

  it("refuses an app session on the admin surface and vice versa", async () => {
    await expect(build("admin", ready, "app")).rejects.toThrow(/surface/);
    await expect(build("app", ready, "admin")).rejects.toThrow(/surface/);
  });

  it("refuses banned and deleted users", async () => {
    await expect(build("app", { ...ready, banned: true })).rejects.toThrow(/suspended/);
    await expect(build("app", null)).rejects.toThrow(/not found/);
  });

  it("builds minimal claims without PII", async () => {
    expect(await build("app", { ...ready, role: "rider", permissionVersion: 4 })).toEqual({ roles: [{ r: "RIDER" }], pv: 4, amr: ["otp"] });
  });

  it("uses the current user row, not the copy cached with the session", async () => {
    // signed in as a rider (pv 0); the driver role was granted afterwards (pv 1)
    const claims = await build("app", { id: "u1", role: "driver,rider", permissionVersion: 1 }, "app", { role: "rider", permissionVersion: 0 });
    expect(claims).toMatchObject({ roles: [{ r: "DRIVER" }, { r: "RIDER" }], pv: 1 });
    await expect(build("app", { id: "u1", role: "rider", banned: true }, "app", { banned: false })).rejects.toThrow(/suspended/);
  });

  it("tells the dashboard what setup is missing", async () => {
    const claims = await build("admin", { id: "u1", role: "super_admin", twoFactorEnabled: false, mustChangePassword: true });
    expect(claims).toMatchObject({ roles: [], amr: ["pwd"], setup: { twoFactor: true, changePassword: true } });
  });

  it("marks global staff roles", async () => {
    expect(await build("admin", { ...ready, role: "super_admin" })).toMatchObject({ roles: [{ r: "SUPER_ADMIN", g: true }], amr: ["pwd", "otp"] });
  });
});
