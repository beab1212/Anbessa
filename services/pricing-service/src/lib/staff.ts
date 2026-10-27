// Staff checks shared by zones, fare changes and promos: the city filter for lists and the
// "hidden = not found" rule for single resources (a city you don't cover answers 404, never 403).

import { can, citiesWith, type Permission, type Principal } from "@ride-app/shared-authz";
import { AppError, forbidden, notFound } from "./errors.js";

export const isStaff = (p: Principal) => p.audience === "ride-admin";

/** Cities where the caller holds any of `permissions`; "*" = every city. */
export function citiesWithAny(p: Principal, permissions: Permission[]): string[] | "*" {
  if (!isStaff(p)) return [];
  const out = new Set<string>();
  for (const perm of permissions) {
    const c = citiesWith(p, perm);
    if (c === "*") return "*";
    c.forEach((x) => out.add(x));
  }
  return [...out];
}

/**
 * The city condition for a staff list. A `cityId` outside the caller's cities is refused (403),
 * like no city at all.
 */
export function cityScope(p: Principal, permissions: Permission[], cityId: string | undefined): "*" | string[] {
  const cities = citiesWithAny(p, permissions);
  if (cities !== "*" && cities.length === 0) throw forbidden(`missing permission ${permissions.join(" or ")}`);
  if (cityId) {
    if (cities !== "*" && !cities.includes(cityId)) throw forbidden(`missing permission ${permissions.join(" or ")} in ${cityId}`);
    return [cityId];
  }
  return cities;
}

/** May the caller see a resource of `cityId` with any of `permissions`? If not, it doesn't exist for them. */
export function visibleOr404(p: Principal, permissions: Permission[], cityId: string | null, what: string): void {
  if (!isStaff(p)) throw notFound(what);
  const ok = permissions.some((perm) => (cityId === null ? can(p, perm) : can(p, perm, { cityId })));
  if (!ok) throw notFound(what);
}

export const invalidTransition = (from: string, to: string) => new AppError(409, `can't go from ${from.toLowerCase()} to ${to.toLowerCase()}`, "invalid_transition");
export const raced = () => new AppError(409, "someone else changed this first; reload and try again", "invalid_state");
