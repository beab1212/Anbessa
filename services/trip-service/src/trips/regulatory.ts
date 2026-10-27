// The regulatory report (Role.md §3 C: REGULATOR, report:read_regulatory, aggregates only):
// per Addis Ababa calendar month and city — trips requested / completed / cancelled, distinct
// drivers and vehicles that completed a trip, kilometres driven, and safety incidents opened.
// No ids, names or positions leave this module.
//
// Safety incidents are support-service's: trip-service keeps a copy of incident.opened in
// `regulatory_incident` (src/events/consumer.ts), because support-service has no internal count API.

import { authorize, AuthorizationError, citiesWith, type Principal } from "@ride-app/shared-authz";
import type { IncidentOpenedEvent } from "@ride-app/shared-types";
import { Prisma } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import { badRequest } from "../lib/errors.js";

const ADDIS_OFFSET_MS = 3 * 3600_000;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const MAX_MONTHS = 12;

export interface RegulatoryRow {
  month: string;
  cityId: string;
  tripsRequested: number;
  tripsCompleted: number;
  tripsCancelled: number;
  /** cancelled because no driver accepted */
  tripsNoDriver: number;
  activeDrivers: number;
  activeVehicles: number;
  distanceKm: number;
  safetyIncidents: number;
  /** HIGH or CRITICAL */
  seriousIncidents: number;
}

const addisMonthOf = (t: Date) => new Date(t.getTime() + ADDIS_OFFSET_MS).toISOString().slice(0, 7);
const monthStart = (m: string) => {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1, 1) - ADDIS_OFFSET_MS);
};
const nextMonth = (m: string) => {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
};

/** YYYY-MM months, inclusive, default: last month. */
export function monthRange(q: { from?: string; to?: string }, now: Date): string[] {
  for (const v of [q.from, q.to]) if (v !== undefined && !MONTH_RE.test(v)) throw badRequest("from and to must be YYYY-MM", "invalid_range");
  const lastMonth = addisMonthOf(new Date(monthStart(addisMonthOf(now)).getTime() - 1));
  const to = q.to ?? q.from ?? lastMonth;
  const from = q.from ?? to;
  if (from > to) throw badRequest("from must not be after to", "invalid_range");
  const months: string[] = [];
  for (let m = from; m <= to; m = nextMonth(m)) {
    months.push(m);
    if (months.length > MAX_MONTHS) throw badRequest(`at most ${MAX_MONTHS} months`, "invalid_range");
  }
  return months;
}

export function createRegulatoryReport(deps: { db: Db; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    /** support-service incident.opened → regulatory_incident (idempotent). */
    async recordIncident(e: Pick<IncidentOpenedEvent, "incidentId" | "cityId" | "tripId" | "at"> & { category: string; severity: string }) {
      await db.regulatoryIncident.createMany({
        data: [{ incidentId: e.incidentId, cityId: e.cityId, category: e.category, severity: e.severity, tripId: e.tripId ?? null, openedAt: new Date(e.at) }],
        skipDuplicates: true,
      });
    },

    async report(p: Principal, cityId: string | undefined, q: { from?: string; to?: string }) {
      if (cityId) authorize(p, "report:read_regulatory", { cityId });
      else {
        const cities = citiesWith(p, "report:read_regulatory");
        if (cities !== "*") {
          if (cities.length === 0) throw new AuthorizationError("report:read_regulatory");
          throw badRequest("cityId is required", "city_required");
        }
      }
      const months = monthRange(q, now());
      const from = monthStart(months[0]!);
      const to = monthStart(nextMonth(months.at(-1)!));
      const city = cityId ? Prisma.sql`AND city_id = ${cityId}` : Prisma.empty;
      const month = (col: string) => Prisma.sql`to_char(${Prisma.raw(col)} AT TIME ZONE 'Africa/Addis_Ababa', 'YYYY-MM')`;

      const [requested, completed, incidents] = await Promise.all([
        db.$queryRaw<{ month: string; city_id: string; requested: bigint; cancelled: bigint; no_driver: bigint }[]>`
          SELECT ${month("created_at")} AS month, city_id, count(*) AS requested,
            count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
            count(*) FILTER (WHERE status = 'cancelled' AND cancel_reason = 'NO_DRIVER_FOUND') AS no_driver
          FROM trip WHERE created_at >= ${from} AND created_at < ${to} ${city} GROUP BY 1, 2`,
        db.$queryRaw<{ month: string; city_id: string; completed: bigint; drivers: bigint; vehicles: bigint; meters: bigint }[]>`
          SELECT ${month("completed_at")} AS month, city_id, count(*) AS completed,
            count(DISTINCT driver_user_id) AS drivers, count(DISTINCT vehicle_id) AS vehicles,
            coalesce(sum(coalesce(distance_m, est_distance_m)), 0)::bigint AS meters
          FROM trip WHERE status = 'completed' AND completed_at >= ${from} AND completed_at < ${to} ${city} GROUP BY 1, 2`,
        db.$queryRaw<{ month: string; city_id: string; n: bigint; serious: bigint }[]>`
          SELECT ${month("opened_at")} AS month, city_id, count(*) AS n,
            count(*) FILTER (WHERE severity IN ('HIGH','CRITICAL')) AS serious
          FROM regulatory_incident WHERE opened_at >= ${from} AND opened_at < ${to} ${city} GROUP BY 1, 2`,
      ]);

      const rows = new Map<string, RegulatoryRow>();
      const at = (m: string, c: string) => {
        const k = `${m}|${c}`;
        let r = rows.get(k);
        if (!r) {
          r = { month: m, cityId: c, tripsRequested: 0, tripsCompleted: 0, tripsCancelled: 0, tripsNoDriver: 0, activeDrivers: 0, activeVehicles: 0, distanceKm: 0, safetyIncidents: 0, seriousIncidents: 0 };
          rows.set(k, r);
        }
        return r;
      };
      // a requested city always has a row per month, even an empty one
      if (cityId) for (const m of months) at(m, cityId);
      for (const r of requested) Object.assign(at(r.month, r.city_id), { tripsRequested: Number(r.requested), tripsCancelled: Number(r.cancelled), tripsNoDriver: Number(r.no_driver) });
      for (const r of completed) {
        Object.assign(at(r.month, r.city_id), {
          tripsCompleted: Number(r.completed), activeDrivers: Number(r.drivers), activeVehicles: Number(r.vehicles), distanceKm: Math.round(Number(r.meters) / 100) / 10,
        });
      }
      for (const r of incidents) Object.assign(at(r.month, r.city_id), { safetyIncidents: Number(r.n), seriousIncidents: Number(r.serious) });
      const list = [...rows.values()].sort((a, b) => a.month.localeCompare(b.month) || a.cityId.localeCompare(b.cityId));
      return { cityId: cityId ?? null, from: months[0]!, to: months.at(-1)!, rows: list };
    },
  };
}

export type RegulatoryReport = ReturnType<typeof createRegulatoryReport>;

const COLUMNS: [keyof RegulatoryRow, string][] = [
  ["month", "month"], ["cityId", "city"], ["tripsRequested", "trips_requested"], ["tripsCompleted", "trips_completed"],
  ["tripsCancelled", "trips_cancelled"], ["tripsNoDriver", "trips_no_driver_found"], ["activeDrivers", "active_drivers"],
  ["activeVehicles", "active_vehicles"], ["distanceKm", "distance_km"], ["safetyIncidents", "safety_incidents"], ["seriousIncidents", "serious_safety_incidents"],
];

export function regulatoryCsv(rows: RegulatoryRow[]): string {
  const lines = [COLUMNS.map(([, h]) => h).join(",")];
  for (const r of rows) lines.push(COLUMNS.map(([k]) => String(r[k])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
