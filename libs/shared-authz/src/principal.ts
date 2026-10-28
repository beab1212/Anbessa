import { roleInfo } from "./registry.js";
import type { Audience, ScopeType } from "./roles.js";

/** One role held within one scope, as carried in the token's `roles` claim (Role.md §10). */
export interface RoleAssignment {
  /** a built-in RoleCode or a custom role's code (see registry.ts) */
  role: string;
  scope: ScopeType;
  orgId?: string;
  cityId?: string;
  /**
   * ORG scope only: the partner organisation isn't verified yet. Such an assignment grants only
   * PENDING_ORG_PERMISSIONS (finish onboarding), never trips, money, vehicles' drivers or live data.
   */
  pending?: true;
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

/**
 * Compact claim form: { r: "DISPATCHER", city: "addis-ababa" } / { r: "FLEET_OWNER", org: "…" } / { r: "RIDER" }.
 * A role in an organisation that isn't verified yet: { r: "CORPORATE_ADMIN", pendingOrg: "…" }. It has its
 * own key, not `org` plus a flag, so a reader that doesn't know it (an older service, the phone app)
 * fails closed: it sees no organisation at all instead of a verified one.
 */
export interface RoleClaim {
  r: string;
  org?: string;
  pendingOrg?: string;
  city?: string;
  g?: true;
}

export function toRoleClaim(a: RoleAssignment): RoleClaim {
  if (a.scope === "ORG") return a.pending ? { r: a.role, pendingOrg: a.orgId } : { r: a.role, org: a.orgId };
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
    const { r, org, pendingOrg, city, g } = item as RoleClaim;
    if (typeof r !== "string") continue;
    const info = roleInfo(r);
    if (!info || info.archived || info.audience !== audience) continue;
    // pendingOrg first: a claim carrying both is read as the weaker one
    if (typeof pendingOrg === "string" && pendingOrg) out.push({ role: r, scope: "ORG", orgId: pendingOrg, pending: true });
    else if (typeof org === "string" && org) out.push({ role: r, scope: "ORG", orgId: org });
    else if (typeof city === "string" && city) out.push({ role: r, scope: "CITY", cityId: city });
    else if (g === true) out.push({ role: r, scope: "GLOBAL" });
    else out.push({ role: r, scope: "SELF" });
  }
  return out;
}

export function hasRole(principal: Principal, role: string): boolean {
  return principal.roles.some((a) => a.role === role);
}
