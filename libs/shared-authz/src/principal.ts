import { isRoleCode, ROLES, type Audience, type RoleCode, type ScopeType } from "./roles.js";

/** One role held within one scope, as carried in the token's `roles` claim (Role.md §10). */
export interface RoleAssignment {
  role: RoleCode;
  scope: ScopeType;
  orgId?: string;
  cityId?: string;
}

export interface Principal {
  userId: string;
  audience: Audience;
  roles: RoleAssignment[];
  permissionVersion: number;
  /** Authentication methods, e.g. ["otp"] or ["pwd", "totp"]. */
  amr: string[];
  /** Set when a staff member acts on behalf of a rider (RFC 8693 `act`). */
  actor?: string;
}

/** Compact claim form: { r: "DISPATCHER", city: "addis-ababa" } / { r: "FLEET_OWNER", org: "…" } / { r: "RIDER" }. */
export interface RoleClaim {
  r: string;
  org?: string;
  city?: string;
  g?: true;
}

export function toRoleClaim(a: RoleAssignment): RoleClaim {
  if (a.scope === "ORG") return { r: a.role, org: a.orgId };
  if (a.scope === "CITY") return { r: a.role, city: a.cityId };
  if (a.scope === "GLOBAL") return { r: a.role, g: true };
  return { r: a.role };
}

/**
 * Parse role claims defensively: unknown roles, roles that don't belong to the
 * token's audience and malformed scopes are dropped, never trusted.
 */
export function parseRoleClaims(raw: unknown, audience: Audience): RoleAssignment[] {
  if (!Array.isArray(raw)) return [];
  const out: RoleAssignment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { r, org, city, g } = item as RoleClaim;
    if (typeof r !== "string" || !isRoleCode(r)) continue;
    if (ROLES[r].audience !== audience) continue;
    if (typeof org === "string" && org) out.push({ role: r, scope: "ORG", orgId: org });
    else if (typeof city === "string" && city) out.push({ role: r, scope: "CITY", cityId: city });
    else if (g === true) out.push({ role: r, scope: "GLOBAL" });
    else out.push({ role: r, scope: "SELF" });
  }
  return out;
}

export function hasRole(principal: Principal, role: RoleCode): boolean {
  return principal.roles.some((a) => a.role === role);
}
