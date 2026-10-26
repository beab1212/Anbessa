import { describe, expect, it } from "vitest";
import { builtInSnapshot } from "@ride-app/shared-authz";
import { applyChange, customRoleCode, guardrailProblems } from "../../src/authz/guardrails.js";

const before = builtInSnapshot();

describe("permission matrix guardrails", () => {
  it("allows ordinary edits to staff roles", () => {
    expect(guardrailProblems(before, { roleCode: "DISPATCHER", set: [{ permission: "trip:cancel", scope: null }] })).toEqual([]);
    expect(guardrailProblems(before, { roleCode: "SUPPORT_AGENT", set: [{ permission: "trip:read_gps_trace", scope: "C" }] })).toEqual([]);
  });

  it("refuses unknown permissions and wrong scopes for the audience", () => {
    expect(guardrailProblems(before, { roleCode: "DISPATCHER", set: [{ permission: "god:mode", scope: "G" }] })).toContain("unknown permission god:mode");
    expect(guardrailProblems(before, { roleCode: "DISPATCHER", set: [{ permission: "trip:read", scope: "S" }] }).join()).toMatch(/staff roles act in a city/);
    expect(guardrailProblems(before, { roleCode: "DISPATCHER", set: [{ permission: "trip:read", scope: "G" }] }).join()).toMatch(/city role/);
    expect(guardrailProblems(before, { roleCode: "RIDER", set: [{ permission: "trip:read", scope: "G" }] }).join()).toMatch(/own data/);
  });

  it("keeps maker and checker apart, and super admins in control", () => {
    expect(guardrailProblems(before, { roleCode: "FINANCE_OFFICER", set: [{ permission: "refund:approve", scope: "G" }] }).join()).toMatch(/maker–checker/);
    expect(guardrailProblems(before, { roleCode: "SUPER_ADMIN", set: [{ permission: "authz:approve", scope: null }] })).toContain("super admins must keep authz:approve");
    expect(guardrailProblems(before, { roleCode: "FLEET_OWNER", set: [{ permission: "org:manage_members", scope: null }] }).join()).toMatch(/release/);
  });

  it("custom roles: staff only, unique, archivable only when nobody holds them", () => {
    const code = customRoleCode("Quality review");
    expect(code).toBe("CUSTOM_QUALITY_REVIEW");
    const create = { roleCode: code, create: { label: "Quality review", storage: "city" as const }, set: [{ permission: "trip:read", scope: "C" as const }] };
    expect(guardrailProblems(before, create)).toEqual([]);
    const after = applyChange(before, create);
    expect(after.roles.find((r) => r.code === code)).toMatchObject({ audience: "ride-admin", stored: "custom_quality_review", storage: { type: "member" } });
    expect(guardrailProblems(after, create).join()).toMatch(/already exists/);
    expect(guardrailProblems(after, { roleCode: code, set: [], archive: true }, { assignedCount: 2 }).join()).toMatch(/2 people still hold/);
    expect(guardrailProblems(after, { roleCode: code, set: [], archive: true }, { assignedCount: 0 })).toEqual([]);
    expect(guardrailProblems(before, { roleCode: "DISPATCHER", set: [], archive: true }).join()).toMatch(/built-in/);
  });
});
