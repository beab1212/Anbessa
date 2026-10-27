// Shared bits of the support modules: dependencies, paging, the staff check and city filters.

import { citiesWith, type Permission, type Principal } from "@ride-app/shared-authz";
import type { Logger } from "@ride-app/shared-utils";
import type { Db } from "../db.js";
import { AppError, forbidden } from "../lib/errors.js";
import type { Realtime } from "../lib/realtime.js";
import type { TripLookup } from "../lib/trips.js";

export interface SupportDeps {
  db: Db;
  trips: TripLookup;
  realtime: Realtime;
  logger: Logger;
  now: () => Date;
}

export const isStaff = (p: Principal) => p.audience === "ride-admin";

export const invalidTransition = (from: string, to: string) => new AppError(409, `can't go from ${from} to ${to}`, "invalid_transition");
export const raced = () => new AppError(409, "someone else changed this first; reload and try again", "invalid_state");

/**
 * The city filter for a staff list: the cities where the caller holds `permission`. A cityId
 * outside them is refused (403), like an empty set. App tokens never list staff queues.
 */
export function cityFilter(p: Principal, permission: Permission, cityId: string | undefined): { cityId?: string | { in: string[] } } {
  if (!isStaff(p)) throw forbidden(`missing permission ${permission}`);
  const cities = citiesWith(p, permission);
  if (cities !== "*" && cities.length === 0) throw forbidden(`missing permission ${permission}`);
  if (cityId) {
    if (cities !== "*" && !cities.includes(cityId)) throw forbidden(`missing permission ${permission} in ${cityId}`);
    return { cityId };
  }
  return cities === "*" ? {} : { cityId: { in: cities } };
}

/** Keyset paging on (time desc, id desc): the cursor is "iso|id" of the last row seen. */
export function pageAfter(cursor: string | undefined, field: string): Record<string, unknown> {
  if (!cursor) return {};
  const [at, id] = cursor.split("|");
  const when = at ? new Date(at) : undefined;
  if (!when || Number.isNaN(when.getTime()) || !id) throw new AppError(400, "bad cursor", "bad_request");
  return { OR: [{ [field]: { lt: when } }, { [field]: when, id: { lt: id } }] };
}

export function nextCursor<T extends { id: string }>(rows: T[], limit: number, at: (r: T) => Date): string | null {
  const last = rows.at(-1);
  return rows.length === limit && last ? `${at(last).toISOString()}|${last.id}` : null;
}

export const unique = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((v): v is string => !!v))];
