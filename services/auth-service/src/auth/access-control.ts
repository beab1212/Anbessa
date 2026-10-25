// Better Auth access control, generated from libs/shared-authz (Auth.md §7,
// "one permission matrix, two consumers"). Better Auth's checks only protect its
// own endpoints (organization management); domain permissions use shared-authz.

import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements as orgDefaultStatements } from "better-auth/plugins/organization/access";
import { defaultStatements as adminDefaultStatements } from "better-auth/plugins/admin/access";
import { MATRIX, ROLES, ROLE_CODES, USER_ROLE_CODES, type RoleCode } from "@ride-app/shared-authz";

// ── organization plugin ───────────────────────────────────────────────────────
export const orgAc = createAccessControl(orgDefaultStatements);

const manageOrg = orgAc.newRole({
  organization: ["update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
});
const noOrgPermissions = orgAc.newRole({});

/** Every member role (stored name) with its Better Auth organization permissions. */
export const orgRoles = Object.fromEntries(
  ROLE_CODES.filter((code) => ROLES[code].storage.type === "member").map((code) => [
    ROLES[code].stored,
    // org administration follows the matrix: whoever may manage members in the matrix may in Better Auth
    MATRIX[code]["org:manage_members"] === "O" ? manageOrg : noOrgPermissions,
  ]),
) as Record<string, typeof manageOrg>;

// ── admin plugin ──────────────────────────────────────────────────────────────
// The admin plugin is used for its schema (role, ban fields) and ban enforcement
// only. Its HTTP endpoints are not served (see allowlist.ts), and no role gets any
// admin-plugin permission, so even a direct server call without our checks fails.
export const globalAc = createAccessControl(adminDefaultStatements);
export const globalRoles = Object.fromEntries(
  USER_ROLE_CODES.map((code: RoleCode) => [ROLES[code].stored, globalAc.newRole({})]),
) as Record<string, ReturnType<typeof globalAc.newRole>>;
