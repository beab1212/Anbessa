// Cities, vehicle types and announcements, plus the public client configuration the apps and the
// web read at start. City and vehicle-type changes are part of the settings snapshot (they bump
// settings_version); cities are also mirrored into auth-service with their staff organisation.

import { authorize, type Principal } from "@ride-app/shared-authz";
import { CITIES } from "@ride-app/shared-location";
import { resolveSetting } from "@ride-app/shared-settings";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { audit, writeOutbox } from "../outbox/outbox.js";
import { bumpVersion, loadSnapshot } from "../settings/service.js";

type Tx = Prisma.TransactionClient;

export interface IdentitySync {
  /** auth-service PUT /internal/cities/:id */
  upsertCity(city: { id: string; name: string; timezone: string }): Promise<void>;
}

export interface CityInput {
  name: string;
  timezone: string;
  enabled: boolean;
  bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number };
}

export interface VehicleTypeInput {
  name: string;
  seatsMin: number;
  seatsMax: number;
  enabled: boolean;
  cities: string[];
}

export interface AnnouncementInput {
  title: string;
  body: string;
  severity: "info" | "warning";
  audiences: ("rider" | "driver" | "partner" | "staff")[];
  cities: string[];
  startsAt: Date;
  endsAt?: Date | null;
}

const BUILT_IN_CITY_NAMES: Record<string, string> = { "addis-ababa": "Addis Ababa", hawassa: "Hawassa" };
const BUILT_IN_TYPES = [
  { code: "economy", name: "Economy", seatsMin: 3, seatsMax: 4, sortOrder: 1 },
  { code: "comfort", name: "Comfort", seatsMin: 3, seatsMax: 4, sortOrder: 2 },
  { code: "minivan", name: "Minivan", seatsMin: 5, seatsMax: 8, sortOrder: 3 },
];

export function createCatalogService(deps: { db: Db; identity: IdentitySync; publish: (version: number) => Promise<void>; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  async function changed(tx: Tx, actorId: string, action: string, resource: { type: string; id: string }, reason?: string) {
    const version = await bumpVersion(tx);
    await writeOutbox(tx, audit({ actorId, action, resource, outcome: "EXECUTED", reason }));
    return version;
  }

  function checkBbox(b: CityInput["bbox"]) {
    if (!(b.minLat < b.maxLat && b.minLng < b.maxLng)) throw badRequest("the map area must have its south-west corner below and left of its north-east corner");
    if (b.maxLat - b.minLat > 3 || b.maxLng - b.minLng > 3) throw badRequest("a city's map area can't span more than 3° (about 330 km)");
  }

  return {
    /** First start: today's built-in cities and vehicle types. Then make sure auth-service knows every city. */
    async seed() {
      if ((await db.city.count()) === 0) {
        await db.$transaction(async (tx) => {
          for (const [id, b] of Object.entries(CITIES)) {
            await tx.city.create({ data: { id, name: BUILT_IN_CITY_NAMES[id] ?? id, minLat: b.minLat, minLng: b.minLng, maxLat: b.maxLat, maxLng: b.maxLng } });
          }
          for (const t of BUILT_IN_TYPES) await tx.vehicleType.create({ data: { ...t, cities: [] } });
          await bumpVersion(tx);
        });
      }
      for (const c of await db.city.findMany()) await deps.identity.upsertCity({ id: c.id, name: c.name, timezone: c.timezone });
    },

    async listCities(p: Principal) {
      authorize(p, "settings:read");
      return db.city.findMany({ orderBy: { name: "asc" } });
    },

    async saveCity(p: Principal, id: string, input: CityInput, opts: { create: boolean }) {
      authorize(p, "city:manage");
      if (!/^[a-z0-9-]{2,40}$/.test(id)) throw badRequest("city id: lower-case letters, digits and dashes, e.g. bahir-dar");
      checkBbox(input.bbox);
      const exists = await db.city.findUnique({ where: { id } });
      if (opts.create && exists) throw conflict(`city ${id} already exists`);
      if (!opts.create && !exists) throw notFound("city");
      // identity first: if auth-service can't take it, nothing changes here
      await deps.identity.upsertCity({ id, name: input.name, timezone: input.timezone });
      const data = { name: input.name.trim(), timezone: input.timezone, enabled: input.enabled, minLat: input.bbox.minLat, minLng: input.bbox.minLng, maxLat: input.bbox.maxLat, maxLng: input.bbox.maxLng };
      const version = await db.$transaction(async (tx) => {
        await tx.city.upsert({ where: { id }, update: data, create: { id, ...data } });
        const what = opts.create ? "created" : exists!.enabled !== input.enabled ? (input.enabled ? "enabled" : "disabled") : "updated";
        return changed(tx, p.userId, "city:manage", { type: "city", id }, `${input.name} ${what}`);
      });
      await deps.publish(version);
      return db.city.findUniqueOrThrow({ where: { id } });
    },

    async listVehicleTypes(p: Principal) {
      authorize(p, "settings:read");
      return db.vehicleType.findMany({ orderBy: [{ sortOrder: "asc" }, { code: "asc" }] });
    },

    async saveVehicleType(p: Principal, code: string, input: VehicleTypeInput) {
      authorize(p, "city:manage");
      if (!/^[a-z0-9_]{2,30}$/.test(code)) throw badRequest("code: lower-case letters, digits and _, e.g. electric");
      if (input.seatsMin < 1 || input.seatsMax < input.seatsMin || input.seatsMax > 20) throw badRequest("seats: 1–20, minimum ≤ maximum");
      const known = new Set((await db.city.findMany({ select: { id: true } })).map((c) => c.id));
      const unknown = input.cities.filter((c) => !known.has(c));
      if (unknown.length) throw badRequest(`unknown cities: ${unknown.join(", ")}`);
      const version = await db.$transaction(async (tx) => {
        const count = await tx.vehicleType.count();
        await tx.vehicleType.upsert({
          where: { code },
          update: { name: input.name.trim(), seatsMin: input.seatsMin, seatsMax: input.seatsMax, enabled: input.enabled, cities: input.cities },
          create: { code, name: input.name.trim(), seatsMin: input.seatsMin, seatsMax: input.seatsMax, enabled: input.enabled, cities: input.cities, sortOrder: count + 1 },
        });
        return changed(tx, p.userId, "vehicle_type:manage", { type: "vehicle_type", id: code }, `${input.name}: ${input.enabled ? "on" : "off"}, ${input.seatsMin}–${input.seatsMax} seats${input.cities.length ? ` in ${input.cities.join(", ")}` : ""}`);
      });
      await deps.publish(version);
      return db.vehicleType.findUniqueOrThrow({ where: { code } });
    },

    async listAnnouncements(p: Principal) {
      authorize(p, "announcement:manage");
      return db.announcement.findMany({ orderBy: [{ archived: "asc" }, { startsAt: "desc" }], take: 200 });
    },

    async saveAnnouncement(p: Principal, id: string | null, input: AnnouncementInput) {
      authorize(p, "announcement:manage");
      if (input.audiences.length === 0) throw badRequest("choose who sees it");
      if (input.endsAt && input.endsAt <= input.startsAt) throw badRequest("it must end after it starts");
      return db.$transaction(async (tx) => {
        const data = { title: input.title.trim(), body: input.body.trim(), severity: input.severity, audiences: input.audiences, cities: input.cities, startsAt: input.startsAt, endsAt: input.endsAt ?? null };
        const a = id
          ? await tx.announcement.update({ where: { id }, data }).catch(() => { throw notFound("announcement"); })
          : await tx.announcement.create({ data: { ...data, createdBy: p.userId } });
        await writeOutbox(tx, audit({ actorId: p.userId, action: id ? "announcement:update" : "announcement:create", resource: { type: "announcement", id: a.id }, outcome: "EXECUTED", reason: a.title }));
        return a;
      });
    },

    async archiveAnnouncement(p: Principal, id: string) {
      authorize(p, "announcement:manage");
      return db.$transaction(async (tx) => {
        const a = await tx.announcement.update({ where: { id }, data: { archived: true } }).catch(() => { throw notFound("announcement"); });
        await writeOutbox(tx, audit({ actorId: p.userId, action: "announcement:archive", resource: { type: "announcement", id }, outcome: "EXECUTED", reason: a.title }));
        return a;
      });
    },

    /** Public: what the apps and the web need before anyone signs in. */
    async clientConfig(q: { audience?: string; cityId?: string }) {
      const [snap, announcements] = await Promise.all([
        loadSnapshot(db),
        db.announcement.findMany({
          where: {
            archived: false, startsAt: { lte: now() }, OR: [{ endsAt: null }, { endsAt: { gt: now() } }],
            ...(q.audience ? { audiences: { has: q.audience } } : {}),
          },
          orderBy: { startsAt: "desc" },
          take: 20,
        }),
      ]);
      const get = (key: string) => resolveSetting(snap, key, undefined);
      return {
        version: snap.version,
        cities: snap.cityList.filter((c) => c.enabled).map(({ id, name, timezone, bbox }) => ({ id, name, timezone, bbox })),
        vehicleTypes: snap.vehicleTypes.filter((t) => t.enabled).map(({ code, name, seatsMin, seatsMax, cities }) => ({ code, name, seatsMin, seatsMax, cities })),
        features: { phoneBooking: get("features.phoneBooking"), corporateBooking: get("features.corporateBooking"), tripPin: get("trip.pinRequired") },
        maintenance: { newTripsPaused: get("maintenance.newTrips"), message: get("maintenance.message") },
        minAppVersions: {
          rider: { android: get("apps.minVersion.rider.android"), ios: get("apps.minVersion.rider.ios") },
          driver: { android: get("apps.minVersion.driver.android"), ios: get("apps.minVersion.driver.ios") },
        },
        announcements: announcements
          .filter((a) => !q.cityId || a.cities.length === 0 || a.cities.includes(q.cityId))
          .map(({ id, title, body, severity, audiences, cities, startsAt, endsAt }) => ({ id, title, body, severity, audiences, cities, startsAt, endsAt })),
      };
    },
  };
}

export type CatalogService = ReturnType<typeof createCatalogService>;
