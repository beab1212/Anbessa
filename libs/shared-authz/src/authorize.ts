// authorize(): the one call every protected action makes (Role.md §9).
// Grants need a permission in the matrix AND a scope that covers the resource.

import { MATRIX, type ScopeLetter } from "./matrix.js";
import type { Permission } from "./permissions.js";
import type { Principal, RoleAssignment } from "./principal.js";

/** Scope attributes of the resource being acted on. Omit what doesn't apply. */
export interface ResourceScope {
  /** Users who "own" the resource (rider and driver of a trip, the user themself…). */
  ownerUserIds?: readonly string[];
  orgId?: string | null;
  cityId?: string | null;
}

export class AuthorizationError extends Error {
  readonly statusCode = 403;
  readonly code = "forbidden";
  constructor(readonly permission: Permission) {
    super(`missing permission ${permission} for this resource`);
  }
}

function covers(letter: ScopeLetter, a: RoleAssignment, principal: Principal, r: ResourceScope): boolean {
  switch (letter) {
    case "G":
      return true;
    case "S":
      return r.ownerUserIds?.includes(principal.userId) ?? false;
    case "O":
      return a.scope === "ORG" && !!r.orgId && a.orgId === r.orgId;
    case "C":
      // A GLOBAL assignment of a city-scoped role (e.g. a global analyst) covers every city.
      if (a.scope === "GLOBAL") return true;
      return a.scope === "CITY" && !!r.cityId && a.cityId === r.cityId;
  }
}

/** The assignments that grant `permission` on `resource` (empty = denied). */
export function grantingAssignments(principal: Principal, permission: Permission, resource: ResourceScope = {}): RoleAssignment[] {
  return principal.roles.filter((a) => {
    const letter = MATRIX[a.role]?.[permission];
    return letter !== undefined && covers(letter, a, principal, resource);
  });
}

export function can(principal: Principal, permission: Permission, resource: ResourceScope = {}): boolean {
  return grantingAssignments(principal, permission, resource).length > 0;
}

export function authorize(principal: Principal, permission: Permission, resource: ResourceScope = {}): void {
  if (!can(principal, permission, resource)) throw new AuthorizationError(permission);
}

/** Cities in which the principal holds `permission` (for filtering lists). "*" means all cities. */
export function citiesWith(principal: Principal, permission: Permission): string[] | "*" {
  const cities = new Set<string>();
  for (const a of principal.roles) {
    const letter = MATRIX[a.role]?.[permission];
    if (letter === "G" || (letter === "C" && a.scope === "GLOBAL")) return "*";
    if (letter === "C" && a.scope === "CITY" && a.cityId) cities.add(a.cityId);
  }
  return [...cities];
}
