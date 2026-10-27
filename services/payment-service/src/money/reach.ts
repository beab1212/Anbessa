// Which cities' requests a person may list: the union of the cities where they hold any of the
// given permissions ("everywhere" for G grants and GLOBAL assignments). Shared by the controls.

import { citiesWith, type Permission, type Principal } from "@ride-app/shared-authz";
import { forbidden } from "../lib/errors.js";

export interface Reach {
  everywhere: boolean;
  cities: string[];
}

export function reachOf(p: Principal, perms: readonly Permission[]): Reach {
  const cities = new Set<string>();
  for (const perm of perms) {
    const c = citiesWith(p, perm);
    if (c === "*") return { everywhere: true, cities: [] };
    c.forEach((x) => cities.add(x));
  }
  return { everywhere: false, cities: [...cities] };
}

export const reachesAnything = (r: Reach) => r.everywhere || r.cities.length > 0;

/** A Prisma `cityId` filter for a list: the asked city (if reachable), or every reachable city. */
export function cityFilter(r: Reach, asked: string | undefined, perm: Permission): { cityId?: string | { in: string[] } } {
  if (!reachesAnything(r)) throw forbidden(`missing permission ${perm}`);
  if (asked) {
    if (!r.everywhere && !r.cities.includes(asked)) throw forbidden(`missing permission ${perm} in ${asked}`);
    return { cityId: asked };
  }
  return r.everywhere ? {} : { cityId: { in: r.cities } };
}
