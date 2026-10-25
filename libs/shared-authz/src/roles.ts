// Role catalog from docs/design/Role.md §4. Role codes are what services see in
// tokens; `storage` is how auth-service keeps them in Better Auth (Auth.md §7).

export type Audience = "ride-app" | "ride-admin";

export type ScopeType = "SELF" | "ORG" | "CITY" | "GLOBAL";

export type OrgKind = "FLEET" | "CORPORATE" | "STAFF_CITY" | "STAFF_HQ";

interface RoleDefinition {
  audience: Audience;
  /** Where the assignment lives: a global role on the user, or a member role inside an organisation kind. */
  storage: { type: "user" } | { type: "member"; orgKinds: readonly OrgKind[] };
  /** Lower-case name stored by Better Auth (user.role / member.role). */
  stored: string;
}

export const ROLES = {
  // A · customers and partners
  RIDER: { audience: "ride-app", storage: { type: "user" }, stored: "rider" },
  DRIVER: { audience: "ride-app", storage: { type: "user" }, stored: "driver" },
  FLEET_OWNER: { audience: "ride-app", storage: { type: "member", orgKinds: ["FLEET"] }, stored: "fleet_owner" },
  FLEET_DRIVER: { audience: "ride-app", storage: { type: "member", orgKinds: ["FLEET"] }, stored: "fleet_driver" },
  CORPORATE_ADMIN: { audience: "ride-app", storage: { type: "member", orgKinds: ["CORPORATE"] }, stored: "corporate_admin" },
  CORPORATE_COORDINATOR: { audience: "ride-app", storage: { type: "member", orgKinds: ["CORPORATE"] }, stored: "corporate_coordinator" },
  CORPORATE_EMPLOYEE: { audience: "ride-app", storage: { type: "member", orgKinds: ["CORPORATE"] }, stored: "employee" },
  // B · staff, scoped to a city through STAFF_CITY organisations
  CALL_CENTER_AGENT: { audience: "ride-admin", storage: { type: "member", orgKinds: ["STAFF_CITY"] }, stored: "call_center_agent" },
  DISPATCHER: { audience: "ride-admin", storage: { type: "member", orgKinds: ["STAFF_CITY"] }, stored: "dispatcher" },
  SUPPORT_AGENT: { audience: "ride-admin", storage: { type: "member", orgKinds: ["STAFF_CITY"] }, stored: "support_agent" },
  ONBOARDING_OFFICER: { audience: "ride-admin", storage: { type: "member", orgKinds: ["STAFF_CITY"] }, stored: "onboarding_officer" },
  SAFETY_OFFICER: { audience: "ride-admin", storage: { type: "member", orgKinds: ["STAFF_CITY"] }, stored: "safety_officer" },
  OPERATIONS_MANAGER: { audience: "ride-admin", storage: { type: "member", orgKinds: ["STAFF_CITY"] }, stored: "operations_manager" },
  MARKETING: { audience: "ride-admin", storage: { type: "member", orgKinds: ["STAFF_CITY"] }, stored: "marketing" },
  ANALYST: { audience: "ride-admin", storage: { type: "member", orgKinds: ["STAFF_CITY"] }, stored: "analyst" },
  // B · staff, global
  FINANCE_OFFICER: { audience: "ride-admin", storage: { type: "user" }, stored: "finance_officer" },
  FINANCE_MANAGER: { audience: "ride-admin", storage: { type: "user" }, stored: "finance_manager" },
  SUPER_ADMIN: { audience: "ride-admin", storage: { type: "user" }, stored: "super_admin" },
  // C · external
  AUDITOR: { audience: "ride-admin", storage: { type: "user" }, stored: "auditor" },
  REGULATOR: { audience: "ride-admin", storage: { type: "user" }, stored: "regulator" },
} as const satisfies Record<string, RoleDefinition>;

export type RoleCode = keyof typeof ROLES;

export const ROLE_CODES = Object.keys(ROLES) as RoleCode[];

const byStored = new Map<string, RoleCode>(ROLE_CODES.map((code) => [ROLES[code].stored, code]));

export function roleFromStored(stored: string): RoleCode | undefined {
  return byStored.get(stored.trim());
}

export function isRoleCode(value: string): value is RoleCode {
  return Object.hasOwn(ROLES, value);
}

/** Roles kept on Better Auth's user.role (global / self roles). */
export const USER_ROLE_CODES = ROLE_CODES.filter((code) => ROLES[code].storage.type === "user");

/** Staff roles a super admin may grant (always through maker–checker approval). */
export const GRANTABLE_STAFF_ROLES = ROLE_CODES.filter(
  (code) => ROLES[code].audience === "ride-admin",
);

/** Member roles allowed inside each organisation kind. */
export function rolesForOrgKind(kind: OrgKind): RoleCode[] {
  return ROLE_CODES.filter((code) => {
    const storage = ROLES[code].storage;
    return storage.type === "member" && (storage.orgKinds as readonly OrgKind[]).includes(kind);
  });
}
