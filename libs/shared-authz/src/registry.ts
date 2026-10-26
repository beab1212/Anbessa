// The live role → permission registry (Role.md §8). The matrix in matrix.ts is the built-in
// default; auth-service keeps the current one in its database, edited with maker–checker approval,
// and every service swaps it in with setAuthzSnapshot() (see sync.ts). authorize() always reads
// the current snapshot.

import { MATRIX, type ScopeLetter } from "./matrix.js";
import { isPermission, type Permission } from "./permissions.js";
import { ROLE_CODES, ROLES, type Audience, type OrgKind } from "./roles.js";

export type Grants = Partial<Record<Permission, ScopeLetter>>;

export type RoleStorage = { type: "user" } | { type: "member"; orgKinds: readonly OrgKind[] };

export interface RoleInfo {
  code: string;
  label: string;
  description?: string;
  audience: Audience;
  storage: RoleStorage;
  /** lower-case name kept in Better Auth (user.role / member.role) */
  stored: string;
  builtIn: boolean;
  archived?: boolean;
}

export interface AuthzSnapshot {
  version: number;
  roles: RoleInfo[];
  matrix: Record<string, Grants>;
}

export const ROLE_LABELS: Record<string, string> = {
  RIDER: "Rider", DRIVER: "Driver", FLEET_OWNER: "Fleet owner", FLEET_DRIVER: "Fleet driver",
  CORPORATE_ADMIN: "Company account admin", CORPORATE_COORDINATOR: "Company travel desk", CORPORATE_EMPLOYEE: "Company employee",
  CALL_CENTER_AGENT: "Call center agent", DISPATCHER: "Dispatcher", SUPPORT_AGENT: "Support agent", ONBOARDING_OFFICER: "Onboarding officer",
  SAFETY_OFFICER: "Safety officer", OPERATIONS_MANAGER: "Operations manager", MARKETING: "Marketing", ANALYST: "Analyst",
  FINANCE_OFFICER: "Finance officer", FINANCE_MANAGER: "Finance manager", SUPER_ADMIN: "Super admin", AUDITOR: "Auditor", REGULATOR: "Regulator",
};

const SCOPES: readonly string[] = ["S", "O", "C", "G"];

/** Today's roles and matrix from code: the default, and what auth-service seeds its database with. */
export function builtInSnapshot(): AuthzSnapshot {
  return {
    version: 0,
    roles: ROLE_CODES.map((code) => ({
      code, label: ROLE_LABELS[code] ?? code, audience: ROLES[code].audience, storage: ROLES[code].storage, stored: ROLES[code].stored, builtIn: true,
    })),
    matrix: Object.fromEntries(ROLE_CODES.map((code) => [code, { ...MATRIX[code] }])),
  };
}

let current: AuthzSnapshot = builtInSnapshot();
let byCode = new Map(current.roles.map((r) => [r.code, r]));
let byStored = new Map(current.roles.map((r) => [r.stored, r]));

/** Swap in a new registry. Unknown permissions and bad scope letters are dropped, never trusted. */
export function setAuthzSnapshot(snapshot: AuthzSnapshot): void {
  const matrix: Record<string, Grants> = {};
  for (const role of snapshot.roles) {
    const grants: Grants = {};
    for (const [permission, letter] of Object.entries(snapshot.matrix[role.code] ?? {})) {
      if (isPermission(permission) && typeof letter === "string" && SCOPES.includes(letter)) grants[permission] = letter as ScopeLetter;
    }
    matrix[role.code] = grants;
  }
  current = { version: snapshot.version, roles: snapshot.roles, matrix };
  byCode = new Map(snapshot.roles.map((r) => [r.code, r]));
  byStored = new Map(snapshot.roles.map((r) => [r.stored, r]));
}

export const getAuthzSnapshot = (): AuthzSnapshot => current;

/** Back to the built-in matrix (tests). */
export const resetAuthzSnapshot = (): void => setAuthzSnapshot(builtInSnapshot());

export const roleInfo = (code: string): RoleInfo | undefined => byCode.get(code);

/** A role that exists and isn't archived (built-in or custom). */
export const isKnownRole = (code: string): boolean => {
  const r = byCode.get(code);
  return !!r && !r.archived;
};

/** The permissions a role holds now (empty for unknown roles). */
export const grantsOf = (code: string): Grants => current.matrix[code] ?? {};

/** The role kept under this stored name (built-in or custom), if any. */
export const roleByStored = (stored: string): RoleInfo | undefined => byStored.get(stored.trim());

/** Staff roles that can be granted through maker–checker (built-in and custom, not archived). */
export const grantableStaffRoles = (): RoleInfo[] => current.roles.filter((r) => r.audience === "ride-admin" && !r.archived);
