// Saved places (Home, Work, others): the rider's own, nothing more. At most 20 per person.

import type { Principal } from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";

export const PLACE_LABELS = ["HOME", "WORK", "OTHER"] as const;
export type PlaceLabel = (typeof PLACE_LABELS)[number];
export const MAX_PLACES = 20;

export interface PlaceInput {
  name: string;
  address?: string;
  lat: number;
  lng: number;
}

export function createPlaces(db: Db) {
  const view = (p: { id: string; label: string; name: string; address: string | null; lat: number; lng: number; updatedAt: Date }) => ({
    id: p.id, label: p.label, name: p.name, address: p.address, lat: p.lat, lng: p.lng, updatedAt: p.updatedAt,
  });

  return {
    async list(p: Principal) {
      const rows = await db.savedPlace.findMany({ where: { userId: p.userId }, orderBy: [{ label: "asc" }, { createdAt: "asc" }] });
      // HOME, WORK, then the others as they were added
      const order = (l: string) => (l === "HOME" ? 0 : l === "WORK" ? 1 : 2);
      return rows.sort((a, b) => order(a.label) - order(b.label) || a.createdAt.getTime() - b.createdAt.getTime()).map(view);
    },

    /** Home or Work: set it, or replace what was there. */
    async setFixed(p: Principal, label: "HOME" | "WORK", input: PlaceInput) {
      const existing = await db.savedPlace.findFirst({ where: { userId: p.userId, label } });
      const data = { name: input.name, address: input.address ?? null, lat: input.lat, lng: input.lng };
      const row = existing
        ? await db.savedPlace.update({ where: { id: existing.id }, data })
        : await db.savedPlace.create({ data: { userId: p.userId, label, ...data } });
      return view(row);
    },

    async add(p: Principal, input: PlaceInput) {
      const count = await db.savedPlace.count({ where: { userId: p.userId } });
      if (count >= MAX_PLACES) throw new AppError(409, `at most ${MAX_PLACES} saved places`, "too_many_places");
      return view(await db.savedPlace.create({ data: { userId: p.userId, label: "OTHER", name: input.name, address: input.address ?? null, lat: input.lat, lng: input.lng } }));
    },

    async remove(p: Principal, id: string) {
      const row = await db.savedPlace.findUnique({ where: { id } });
      if (!row || row.userId !== p.userId) throw notFound("place");
      await db.savedPlace.delete({ where: { id } });
    },
  };
}

export type PlacesService = ReturnType<typeof createPlaces>;
