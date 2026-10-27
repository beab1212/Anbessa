// The pricing catalog in memory: every approved fare rule (past, current and scheduled) and every
// live zone. Quotes read it synchronously; it reloads from Postgres when older than 60 s, when
// this replica changes something, or when another replica says so (Redis `pricing:catalog_changed`).
// A scheduled rule needs no reload to take effect: the cache already holds it and picks it by time.

import type { LatLng } from "@ride-app/shared-location";
import type { Db } from "./db.js";
import { AppError } from "./lib/errors.js";
import { containsPoint, type Ring } from "./zones/geometry.js";
import type { FareCard } from "./fares.js";

export const CATALOG_CHANNEL = "pricing:catalog_changed";
const MAX_AGE_MS = 60_000;

export interface CachedRule extends FareCard {
  id: string;
  cityId: string;
  vehicleType: string;
  validFrom: Date;
}

export interface CachedZone {
  id: string;
  cityId: string;
  name: string;
  kind: "SERVICE_AREA" | "NO_PICKUP" | "AIRPORT" | "SURGE";
  ring: Ring;
  feeMinor: number;
  surgeMultiplier: number;
}

export interface PricingCatalog {
  /** reload if stale (or forced); concurrent callers share one load */
  refresh(force?: boolean): Promise<void>;
  /** the next refresh reloads */
  invalidate(): void;
  /** the rule in force for a city and type at `at`, or null (then the live settings apply) */
  ruleAt(cityId: string, vehicleType: string, at: Date): CachedRule | null;
  zones(cityId: string): CachedZone[];
}

/** No rules and no zones (unit tests; pricing then behaves exactly like the settings-only service). */
export const emptyCatalog: PricingCatalog = { refresh: async () => undefined, invalidate: () => undefined, ruleAt: () => null, zones: () => [] };

/**
 * When Postgres can't be read, a catalog loaded before keeps serving (stale, logged); one never
 * loaded refuses quotes (503), since pricing without the approved rules would be wrong.
 */
export function dbCatalog(db: Db, now: () => Date = () => new Date(), logger?: { warn(o: object, msg: string): void }): PricingCatalog {
  let rules = new Map<string, CachedRule[]>(); // "city|type" → newest first
  let zones = new Map<string, CachedZone[]>();
  let loadedAt = 0;
  let everLoaded = false;
  let loading: Promise<void> | null = null;

  async function load() {
    const [ruleRows, zoneRows] = await Promise.all([
      db.fareRule.findMany({ orderBy: { validFrom: "desc" } }),
      db.zone.findMany({ where: { archivedAt: null } }),
    ]);
    const r = new Map<string, CachedRule[]>();
    for (const x of ruleRows) {
      const k = `${x.cityId}|${x.vehicleType}`;
      const list = r.get(k) ?? [];
      list.push({
        id: x.id, cityId: x.cityId, vehicleType: x.vehicleType, validFrom: x.validFrom,
        baseMinor: x.baseMinor, perKmMinor: x.perKmMinor, perMinMinor: x.perMinMinor, minFareMinor: x.minFareMinor, waitingPerMinMinor: x.waitingPerMinMinor,
      });
      r.set(k, list);
    }
    const z = new Map<string, CachedZone[]>();
    for (const x of zoneRows) {
      const list = z.get(x.cityId) ?? [];
      list.push({ id: x.id, cityId: x.cityId, name: x.name, kind: x.kind, ring: x.polygon as Ring, feeMinor: x.feeMinor, surgeMultiplier: x.surgeMultiplier });
      z.set(x.cityId, list);
    }
    rules = r;
    zones = z;
    loadedAt = now().getTime();
    everLoaded = true;
  }

  return {
    async refresh(force = false) {
      if (!force && loadedAt && now().getTime() - loadedAt < MAX_AGE_MS) return;
      loading ??= load()
        .catch((err: unknown) => {
          if (!everLoaded) throw new AppError(503, "pricing rules are temporarily unavailable", "dependency_unavailable");
          logger?.warn({ err: (err as Error).message }, "pricing catalog reload failed, serving the last one");
          loadedAt = now().getTime() - MAX_AGE_MS + 10_000; // try again in 10 s
        })
        .finally(() => {
          loading = null;
        });
      await loading;
    },
    invalidate() {
      loadedAt = 0;
    },
    ruleAt(cityId, vehicleType, at) {
      return rules.get(`${cityId}|${vehicleType}`)?.find((r) => r.validFrom.getTime() <= at.getTime()) ?? null;
    },
    zones: (cityId) => zones.get(cityId) ?? [],
  };
}

/** What the zones of a city mean for one trip. */
export interface ZoneEffect {
  /** null when allowed; else why the pickup is refused */
  refused: null | { code: "outside_service_area" | "pickup_not_allowed"; message: string };
  surgeMultiplier: number;
  zoneFeeMinor: number;
  zoneIds: string[];
}

export function zoneEffect(zones: CachedZone[], pickup: LatLng, dropoff: LatLng): ZoneEffect {
  const at = (z: CachedZone, p: LatLng) => containsPoint(z.ring, p);
  const areas = zones.filter((z) => z.kind === "SERVICE_AREA");
  if (areas.length && !areas.some((z) => at(z, pickup))) {
    return { refused: { code: "outside_service_area", message: "pickup is outside the service area" }, surgeMultiplier: 1, zoneFeeMinor: 0, zoneIds: [] };
  }
  const noPickup = zones.find((z) => z.kind === "NO_PICKUP" && at(z, pickup));
  if (noPickup) return { refused: { code: "pickup_not_allowed", message: `pickups aren't allowed here (${noPickup.name}); move the pickup point` }, surgeMultiplier: 1, zoneFeeMinor: 0, zoneIds: [noPickup.id] };

  const ids: string[] = [];
  let fee = 0;
  for (const z of zones) {
    if (z.kind === "AIRPORT" && (at(z, pickup) || at(z, dropoff)) && z.feeMinor > 0) {
      // one airport fee per trip: the highest
      fee = Math.max(fee, z.feeMinor);
      ids.push(z.id);
    }
  }
  let surge = 1;
  for (const z of zones) {
    if (z.kind === "SURGE" && at(z, pickup)) {
      surge = Math.max(surge, z.surgeMultiplier);
      ids.push(z.id);
    }
  }
  return { refused: null, surgeMultiplier: surge, zoneFeeMinor: fee, zoneIds: ids };
}
