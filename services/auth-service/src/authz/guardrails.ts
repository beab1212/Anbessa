// What no approved change may do to the permission matrix (Role.md §8). Checked when a change is
// proposed and again when it executes (the matrix may have moved in between).

import { isPermission, type AuthzSnapshot, type Permission, type RoleInfo } from "@ride-app/shared-authz";

export interface AuthzChange {
  roleCode: string;
  /** a new custom role */
  create?: { label: string; description?: string; storage: "city" | "global" };
  /** permission → scope letter, or null to remove it */
  set: { permission: string; scope: "S" | "O" | "C" | "G" | null }[];
  label?: string;
  description?: string;
  archive?: boolean;
}

/** What the super admin role must always keep, so the platform stays governable. */
export const LOCKED_SUPER_ADMIN: Permission[] = ["staff:manage", "role:request", "role:approve", "authz:read", "authz:propose", "authz:approve"];

/** Partner org administration is mirrored into Better Auth's organization plugin at start; it can't change live. */
export const LOCKED_FOR_PARTNER_ROLES: Permission[] = ["org:manage_members"];

/** Pairs a single role must never hold both halves of (maker–checker, Role.md §11). */
const MAKER_FOR: Record<string, string> = {
  "refund:approve": "refund:request", "payout:approve": "payout:prepare", "pricing:approve": "pricing:propose",
  "incentive:approve": "incentive:propose", "topup:approve_cash": "topup:record_cash", "adjustment:approve": "adjustment:request",
  "writeoff:approve": "writeoff:request", "commission_rule:approve": "commission_rule:propose",
  "balance_policy:approve": "balance_policy:propose", "policy_override:approve": "policy_override:request",
  "settings:approve": "settings:propose",
};
// role:approve / authz:approve stay with super admins on purpose: two super admins, never the same person (checked by id)
const SAME_PERSON_CHECKED = new Set(["role:approve", "authz:approve", "settings:approve"]);

export const customRoleCode = (label: string) =>
  `CUSTOM_${label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40)}`;

/** The snapshot as it would be after the change (no checks). */
export function applyChange(before: AuthzSnapshot, c: AuthzChange): AuthzSnapshot {
  const roles = before.roles.map((r) => ({ ...r }));
  const matrix: AuthzSnapshot["matrix"] = Object.fromEntries(Object.entries(before.matrix).map(([k, v]) => [k, { ...v }]));
  if (c.create) {
    roles.push({
      code: c.roleCode, label: c.create.label.trim(), ...(c.create.description ? { description: c.create.description } : {}), audience: "ride-admin",
      storage: c.create.storage === "city" ? { type: "member", orgKinds: ["STAFF_CITY"] } : { type: "user" },
      stored: c.roleCode.toLowerCase(), builtIn: false,
    });
    matrix[c.roleCode] = {};
  }
  const role = roles.find((r) => r.code === c.roleCode);
  if (role) {
    if (c.label) role.label = c.label.trim();
    if (c.description !== undefined) role.description = c.description;
    if (c.archive) role.archived = true;
  }
  const grants = (matrix[c.roleCode] ??= {}) as Record<string, string>;
  for (const { permission, scope } of c.set) {
    if (scope === null) delete grants[permission];
    else grants[permission] = scope;
  }
  return { ...before, roles, matrix };
}

/** Problems with the change, in words an admin can act on (empty = allowed). */
export function guardrailProblems(before: AuthzSnapshot, c: AuthzChange, opts: { assignedCount?: number } = {}): string[] {
  const problems: string[] = [];
  const existing = before.roles.find((r) => r.code === c.roleCode);
  if (c.create) {
    if (existing) problems.push(`a role ${c.roleCode} already exists`);
    if (!/^CUSTOM_[A-Z0-9_]{2,40}$/.test(c.roleCode)) problems.push("custom role codes are CUSTOM_ followed by letters and digits");
    if (before.roles.some((r) => r.label.toLowerCase() === c.create!.label.trim().toLowerCase())) problems.push("another role already has this name");
  } else if (!existing) {
    problems.push(`no role ${c.roleCode}`);
  } else if (existing.archived) {
    problems.push(`${c.roleCode} is archived`);
  }
  if (c.archive) {
    if (existing?.builtIn) problems.push("built-in roles can't be archived; remove their permissions instead");
    if ((opts.assignedCount ?? 0) > 0) problems.push(`${opts.assignedCount} people still hold this role; revoke it first`);
  }

  const after = applyChange(before, c);
  const role: RoleInfo | undefined = after.roles.find((r) => r.code === c.roleCode);
  if (!role) return problems;
  const grants = after.matrix[c.roleCode] ?? {};
  for (const { permission, scope } of c.set) {
    if (!isPermission(permission)) {
      problems.push(`unknown permission ${permission}`);
      continue;
    }
    if (scope === null) continue;
    if (role.audience === "ride-admin" && scope !== "C" && scope !== "G") problems.push(`${permission}: staff roles act in a city (C) or everywhere (G)`);
    if (role.audience === "ride-app" && scope !== "S" && scope !== "O") problems.push(`${permission}: rider and partner roles act on their own data (S) or organisation (O)`);
    if (role.storage.type === "member" && role.audience === "ride-admin" && scope === "G") problems.push(`${permission}: ${role.label} is a city role, so it can't act everywhere (G)`);
  }
  for (const [approve, request] of Object.entries(MAKER_FOR)) {
    if (SAME_PERSON_CHECKED.has(approve)) continue;
    if ((grants as Record<string, string>)[approve] && (grants as Record<string, string>)[request]) problems.push(`one role can't hold both ${request} and ${approve} (maker–checker)`);
  }
  if (c.roleCode === "SUPER_ADMIN") {
    for (const p of LOCKED_SUPER_ADMIN) if (!(grants as Record<string, string>)[p]) problems.push(`super admins must keep ${p}`);
  }
  if (role.audience === "ride-app" && existing) {
    for (const p of LOCKED_FOR_PARTNER_ROLES) {
      if ((before.matrix[c.roleCode] as Record<string, string> | undefined)?.[p] !== (grants as Record<string, string>)[p]) problems.push(`${p} on partner roles changes with a release (it's mirrored into the organisation plugin)`);
    }
  }
  if (c.set.length === 0 && !c.create && !c.archive && c.label === undefined && c.description === undefined) problems.push("nothing to change");
  return problems;
}
