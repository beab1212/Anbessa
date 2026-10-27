// Zones (workflow 15 part B): polygons per city that pricing applies to every new quote.
//   SERVICE_AREA  when a city has any, pickups outside all of them are refused
//   NO_PICKUP     pickups inside are refused (the app moves the pin)
//   AIRPORT       a fixed fee when the pickup or the drop-off is inside
//   SURGE         a multiplier (1–3) on pickups inside
// zone:manage in the zone's city. Every change bumps `version` (optimistic concurrency) and
// writes pricing.zone_changed + audit.recorded. Archived zones are kept for the record.

import { can, type Principal } from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import type { Prisma, Zone } from "../generated/prisma/client.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { cityScope, raced, visibleOr404 } from "../lib/staff.js";
import { audit, writeOutbox } from "../outbox/outbox.js";
import { checkRing, GEOMETRY_MESSAGES, normalizeRing, type Ring } from "./geometry.js";

export type ZoneKind = Zone["kind"];

export interface ZoneInput {
  name: string;
  kind: ZoneKind;
  polygon: [number, number][];
  feeMinor?: number;
  surgeMultiplier?: number;
}

export const zoneView = (z: Zone) => ({
  id: z.id, cityId: z.cityId, name: z.name, kind: z.kind, polygon: z.polygon as Ring,
  feeMinor: z.feeMinor, surgeMultiplier: z.surgeMultiplier, version: z.version,
  createdBy: z.createdBy, updatedBy: z.updatedBy, createdAt: z.createdAt.toISOString(), updatedAt: z.updatedAt.toISOString(),
  archivedAt: z.archivedAt?.toISOString() ?? null,
});
export type ZoneView = ReturnType<typeof zoneView>;

export function createZoneService(deps: { db: Db; onChange: () => void }) {
  const { db } = deps;

  function shape(cityId: string, input: ZoneInput) {
    const ring = normalizeRing(input.polygon);
    const problem = checkRing(ring, cityId);
    if (problem) throw badRequest(GEOMETRY_MESSAGES[problem], "invalid_geometry");
    if (input.kind === "AIRPORT" && !(input.feeMinor && input.feeMinor > 0)) throw badRequest("an airport zone needs a fee", "fee_required");
    if (input.kind === "SURGE" && !(input.surgeMultiplier && input.surgeMultiplier > 1)) throw badRequest("a surge zone needs a multiplier above 1", "multiplier_required");
    return {
      name: input.name.trim(), kind: input.kind, polygon: ring as Prisma.InputJsonValue,
      feeMinor: input.kind === "AIRPORT" ? (input.feeMinor ?? 0) : 0,
      surgeMultiplier: input.kind === "SURGE" ? Math.round((input.surgeMultiplier ?? 1) * 100) / 100 : 1,
    };
  }

  async function load(p: Principal, id: string) {
    const z = await db.zone.findUnique({ where: { id } });
    if (!z) throw notFound("zone");
    visibleOr404(p, ["zone:manage"], z.cityId, "zone");
    return z;
  }

  const authorizeCity = (p: Principal, cityId: string) => {
    if (!can(p, "zone:manage", { cityId })) throw forbidden(`missing permission zone:manage in ${cityId}`);
  };

  return {
    async list(p: Principal, q: { cityId?: string; includeArchived: boolean }) {
      const cities = cityScope(p, ["zone:manage"], q.cityId);
      const rows = await db.zone.findMany({
        where: { ...(cities === "*" ? {} : { cityId: { in: cities } }), ...(q.includeArchived ? {} : { archivedAt: null }) },
        orderBy: [{ cityId: "asc" }, { kind: "asc" }, { name: "asc" }],
      });
      return { zones: rows.map(zoneView) };
    },

    async get(p: Principal, id: string) {
      return zoneView(await load(p, id));
    },

    async create(p: Principal, cityId: string, input: ZoneInput) {
      authorizeCity(p, cityId);
      const data = shape(cityId, input);
      const z = await db.$transaction(async (tx) => {
        const z = await tx.zone.create({ data: { ...data, cityId, createdBy: p.userId, updatedBy: p.userId } });
        await writeOutbox(tx,
          { topic: "pricing.zone_changed", key: cityId, payload: { zoneId: z.id, cityId, kind: z.kind, change: "CREATED", zoneVersion: z.version, byUserId: p.userId } },
          audit({ actorId: p.userId, action: "zone:manage", resource: { type: "zone", id: z.id }, outcome: "EXECUTED", reason: `created ${z.kind} "${z.name}" in ${cityId}` }),
        );
        return z;
      });
      deps.onChange();
      return zoneView(z);
    },

    /** `version` is the one the editor loaded: a newer edit by someone else answers 409. */
    async update(p: Principal, id: string, version: number, input: ZoneInput) {
      const cur = await load(p, id);
      authorizeCity(p, cur.cityId);
      if (cur.archivedAt) throw conflict("this zone is archived", "archived");
      const data = shape(cur.cityId, input);
      const z = await db.$transaction(async (tx) => {
        const n = await tx.zone.updateMany({ where: { id, version, archivedAt: null }, data: { ...data, version: { increment: 1 }, updatedBy: p.userId } });
        if (n.count !== 1) throw raced();
        const z = await tx.zone.findUniqueOrThrow({ where: { id } });
        await writeOutbox(tx,
          { topic: "pricing.zone_changed", key: z.cityId, payload: { zoneId: id, cityId: z.cityId, kind: z.kind, change: "UPDATED", zoneVersion: z.version, byUserId: p.userId } },
          audit({ actorId: p.userId, action: "zone:manage", resource: { type: "zone", id }, outcome: "EXECUTED", reason: `edited ${z.kind} "${z.name}" (v${z.version})` }),
        );
        return z;
      });
      deps.onChange();
      return zoneView(z);
    },

    async archive(p: Principal, id: string) {
      const cur = await load(p, id);
      authorizeCity(p, cur.cityId);
      if (cur.archivedAt) return zoneView(cur);
      const z = await db.$transaction(async (tx) => {
        const n = await tx.zone.updateMany({ where: { id, archivedAt: null }, data: { archivedAt: new Date(), version: { increment: 1 }, updatedBy: p.userId } });
        if (n.count !== 1) throw raced();
        const z = await tx.zone.findUniqueOrThrow({ where: { id } });
        await writeOutbox(tx,
          { topic: "pricing.zone_changed", key: z.cityId, payload: { zoneId: id, cityId: z.cityId, kind: z.kind, change: "ARCHIVED", zoneVersion: z.version, byUserId: p.userId } },
          audit({ actorId: p.userId, action: "zone:manage", resource: { type: "zone", id }, outcome: "EXECUTED", reason: `archived ${z.kind} "${z.name}"` }),
        );
        return z;
      });
      deps.onChange();
      return zoneView(z);
    },

    /** Validate a polygon without saving (the editor's "check" before save). */
    check(p: Principal, cityId: string, polygon: [number, number][]) {
      authorizeCity(p, cityId);
      const ring = normalizeRing(polygon);
      const problem = checkRing(ring, cityId);
      return problem ? { valid: false as const, problem, message: GEOMETRY_MESSAGES[problem] } : { valid: true as const, points: ring.length - 1 };
    },
  };
}

export type ZoneService = ReturnType<typeof createZoneService>;
