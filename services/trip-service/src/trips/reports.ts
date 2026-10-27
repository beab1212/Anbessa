// Staff trip search, company and fleet trip lists, and the daily trip report.
//
// Lists are keyset-paged on (created_at, id), newest first. The cursor carries created_at in
// microseconds (Postgres precision; a JS Date only has milliseconds, which would skip or repeat
// rows created in the same millisecond). Reports are SQL aggregates per Addis Ababa day of
// the request (created_at), over the indexes added in 20261031090000_trip_search_indexes.

import { authorize, AuthorizationError, citiesWith, type Principal } from "@ride-app/shared-authz";
import { Prisma, type Trip } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { ACTIVE } from "./service.js";

const DAY_MS = 86_400_000;
/** Africa/Addis_Ababa: UTC+3 all year. */
const ADDIS_OFFSET_MS = 3 * 3600_000;
export const MAX_RANGE_DAYS = 92;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD (Addis) of an instant. */
export const addisDay = (t: Date) => new Date(t.getTime() + ADDIS_OFFSET_MS).toISOString().slice(0, 10);
/** Midnight Addis of a YYYY-MM-DD, as an instant. */
const dayStart = (day: string) => new Date(Date.parse(`${day}T00:00:00.000Z`) - ADDIS_OFFSET_MS);

/**
 * An inclusive range of Addis days → [from, to) instants. Missing ends are open (lists) or, with
 * `defaults`, the last 7 days up to today (reports). At most MAX_RANGE_DAYS days when both are set.
 */
export function dayRange(q: { from?: string; to?: string }, now: Date, defaults = false): { from?: Date; to?: Date; fromDay?: string; toDay?: string } {
  for (const v of [q.from, q.to]) {
    if (v !== undefined && (!DAY_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) throw badRequest("from and to must be YYYY-MM-DD", "invalid_range");
  }
  let { from: fromDay, to: toDay } = q;
  if (defaults) {
    toDay ??= addisDay(now);
    fromDay ??= addisDay(new Date(dayStart(toDay).getTime() - 6 * DAY_MS + ADDIS_OFFSET_MS));
  }
  const from = fromDay ? dayStart(fromDay) : undefined;
  const to = toDay ? new Date(dayStart(toDay).getTime() + DAY_MS) : undefined;
  if (from && to) {
    const days = (to.getTime() - from.getTime()) / DAY_MS;
    if (days < 1 || days > MAX_RANGE_DAYS) throw badRequest(`a range of 1–${MAX_RANGE_DAYS} days`, "invalid_range");
  }
  return { from, to, fromDay, toDay };
}

// ── keyset cursor ─────────────────────────────────────────────────────────────

export interface Cursor { us: bigint; id: string }

/** `<microseconds since epoch>_<uuid>` (what `next` returns), or a plain ISO date (like GET /api/trips). */
export function parseCursor(raw: string | undefined): Cursor | Date | undefined {
  if (!raw) return undefined;
  const m = /^(\d{1,17})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(raw);
  if (m) return { us: BigInt(m[1]!), id: m[2]!.toLowerCase() };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw badRequest("before must be a cursor from `next` or an ISO date", "invalid_cursor");
  return d;
}

const tsFromUs = (us: bigint) => Prisma.sql`(timestamptz 'epoch' + ${us.toString()}::bigint * interval '1 microsecond')`;

/** Trip id prefix (hex, dashes optional) → the inclusive uuid range it covers (uses the primary key). */
export function idPrefixRange(q: string): [string, string] {
  const hex = q.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{1,32}$/.test(hex)) throw badRequest("q must be the start of a trip id", "invalid_query");
  const fmt = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return [fmt(hex.padEnd(32, "0")), fmt(hex.padEnd(32, "f"))];
}

export interface TripFilters {
  status?: string;
  channel?: string;
  paymentMethod?: string;
  riderUserId?: string;
  driverUserId?: string;
  vehicleId?: string;
  billingOrgId?: string;
  q?: string;
  from?: string;
  to?: string;
  before?: string;
  limit: number;
}

export function createTripReports(deps: { db: Db; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  /** One page of trips matching `base` + the filters, newest first. */
  async function page(base: Prisma.Sql[], f: TripFilters): Promise<{ trips: Trip[]; next: string | null }> {
    const { from, to } = dayRange(f, now());
    const cursor = parseCursor(f.before);
    const where: Prisma.Sql[] = [...base];
    if (f.status) where.push(Prisma.sql`status = ${f.status}`);
    if (f.channel) where.push(Prisma.sql`channel = ${f.channel}`);
    if (f.paymentMethod) where.push(Prisma.sql`payment_method = ${f.paymentMethod}`);
    if (f.riderUserId) where.push(Prisma.sql`rider_user_id = ${f.riderUserId}::uuid`);
    if (f.driverUserId) where.push(Prisma.sql`driver_user_id = ${f.driverUserId}::uuid`);
    if (f.vehicleId) where.push(Prisma.sql`vehicle_id = ${f.vehicleId}`);
    if (f.billingOrgId) where.push(Prisma.sql`billing_org_id = ${f.billingOrgId}::uuid`);
    if (f.q) {
      const [lo, hi] = idPrefixRange(f.q);
      where.push(Prisma.sql`id BETWEEN ${lo}::uuid AND ${hi}::uuid`);
    }
    if (from) where.push(Prisma.sql`created_at >= ${from}`);
    if (to) where.push(Prisma.sql`created_at < ${to}`);
    if (cursor instanceof Date) where.push(Prisma.sql`created_at < ${cursor}`);
    else if (cursor) where.push(Prisma.sql`(created_at, id) < (${tsFromUs(cursor.us)}, ${cursor.id}::uuid)`);

    const rows = await db.$queryRaw<{ id: string; us: bigint }[]>`
      SELECT id::text AS id, (extract(epoch FROM created_at) * 1000000)::bigint AS us FROM trip
      WHERE ${Prisma.join(where, " AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ${f.limit}`;
    if (rows.length === 0) return { trips: [], next: null };
    const byId = new Map((await db.trip.findMany({ where: { id: { in: rows.map((r) => r.id) } } })).map((t) => [t.id, t]));
    const trips = rows.map((r) => byId.get(r.id)).filter((t): t is Trip => !!t);
    const last = rows.at(-1)!;
    return { trips, next: rows.length === f.limit ? `${last.us}_${last.id}` : null };
  }

  return {
    /** Staff search (trip:read @ CITY; without a city only global holders). */
    async search(p: Principal, cityId: string | undefined, f: TripFilters) {
      if (cityId) authorize(p, "trip:read", { cityId });
      else {
        const cities = citiesWith(p, "trip:read");
        if (cities !== "*") {
          if (cities.length === 0) throw new AuthorizationError("trip:read");
          throw badRequest("cityId is required", "city_required");
        }
      }
      return page(cityId ? [Prisma.sql`city_id = ${cityId}`] : [Prisma.sql`TRUE`], f);
    },

    /**
     * A company's trips: billed to it (`billing`) or driven in its vehicles (`fleet`).
     * trip:read @ ORG of the org (corporate admins and coordinators, fleet owners), or a global holder.
     */
    async forOrg(p: Principal, orgId: string, role: "billing" | "fleet", f: TripFilters) {
      authorize(p, "trip:read", { orgId });
      const base = role === "billing"
        ? [Prisma.sql`billing_org_id = ${orgId}::uuid`]
        : [Prisma.sql`vehicle_owner_type = 'ORGANIZATION'`, Prisma.sql`beneficiary_id = ${orgId}::uuid`];
      return page(base, { ...f, billingOrgId: undefined });
    },

    /** Per-day trip numbers (report:read @ CITY, or everywhere without a city). */
    async daily(p: Principal, cityId: string | undefined, q: { from?: string; to?: string }): Promise<TripDailyReport> {
      authorize(p, "report:read", cityId ? { cityId } : {});
      const { from, to, fromDay, toDay } = dayRange(q, now(), true) as { from: Date; to: Date; fromDay: string; toDay: string };
      const city = cityId ? Prisma.sql`AND city_id = ${cityId}` : Prisma.empty;
      const day = Prisma.sql`to_char(created_at AT TIME ZONE 'Africa/Addis_Ababa', 'YYYY-MM-DD')`;
      const active = Prisma.join(ACTIVE.map((s) => Prisma.sql`${s}`));
      const [main, channels, types, cancels] = await Promise.all([
        db.$queryRaw<{ day: string; requested: bigint; completed: bigint; cancelled: bigint; active: bigint; avg_match: number | null; fare: bigint; fee: bigint }[]>`
          SELECT ${day} AS day, count(*) AS requested,
            count(*) FILTER (WHERE status = 'completed') AS completed,
            count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
            count(*) FILTER (WHERE status IN (${active})) AS active,
            avg(extract(epoch FROM matched_at - created_at)) FILTER (WHERE matched_at IS NOT NULL)::float AS avg_match,
            coalesce(sum(fare_final_minor) FILTER (WHERE status = 'completed'), 0)::bigint AS fare,
            coalesce(sum(cancel_fee_minor) FILTER (WHERE status = 'cancelled'), 0)::bigint AS fee
          FROM trip WHERE created_at >= ${from} AND created_at < ${to} ${city} GROUP BY 1`,
        db.$queryRaw<{ day: string; k: string; requested: bigint; completed: bigint }[]>`
          SELECT ${day} AS day, channel AS k, count(*) AS requested, count(*) FILTER (WHERE status = 'completed') AS completed
          FROM trip WHERE created_at >= ${from} AND created_at < ${to} ${city} GROUP BY 1, 2`,
        db.$queryRaw<{ day: string; k: string; requested: bigint; completed: bigint }[]>`
          SELECT ${day} AS day, vehicle_type AS k, count(*) AS requested, count(*) FILTER (WHERE status = 'completed') AS completed
          FROM trip WHERE created_at >= ${from} AND created_at < ${to} ${city} GROUP BY 1, 2`,
        db.$queryRaw<{ day: string; side: string | null; reason: string | null; n: bigint }[]>`
          SELECT ${day} AS day, cancelled_by AS side, cancel_reason AS reason, count(*) AS n
          FROM trip WHERE created_at >= ${from} AND created_at < ${to} ${city} AND status = 'cancelled' GROUP BY 1, 2, 3`,
      ]);

      const days = new Map<string, TripDay>();
      for (let t = from.getTime(); t < to.getTime(); t += DAY_MS) days.set(addisDay(new Date(t)), emptyDay(addisDay(new Date(t))));
      const at = (d: string) => days.get(d) ?? days.set(d, emptyDay(d)).get(d)!;
      for (const r of main) {
        const d = at(r.day);
        Object.assign(d, {
          requested: Number(r.requested), completed: Number(r.completed), cancelled: Number(r.cancelled), active: Number(r.active),
          avgSecondsToMatch: r.avg_match === null ? null : Math.round(r.avg_match), fareMinor: Number(r.fare), cancelFeeMinor: Number(r.fee),
        });
        d.gmvMinor = d.fareMinor + d.cancelFeeMinor;
        const ended = d.completed + d.cancelled;
        d.completionRate = ended ? d.completed / ended : null;
      }
      for (const r of channels) at(r.day).byChannel[r.k] = { requested: Number(r.requested), completed: Number(r.completed) };
      for (const r of types) at(r.day).byVehicleType[r.k] = { requested: Number(r.requested), completed: Number(r.completed) };
      for (const r of cancels) {
        const d = at(r.day);
        const side = r.side ?? "UNKNOWN";
        const reason = r.reason ?? "UNKNOWN";
        d.cancellations.bySide[side] = (d.cancellations.bySide[side] ?? 0) + Number(r.n);
        d.cancellations.byReason[reason] = (d.cancellations.byReason[reason] ?? 0) + Number(r.n);
      }
      const list = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));

      // totals: the average time to match is weighted by matched trips (one more aggregate)
      const [all] = await db.$queryRaw<{ avg_match: number | null }[]>`
        SELECT avg(extract(epoch FROM matched_at - created_at))::float AS avg_match FROM trip
        WHERE created_at >= ${from} AND created_at < ${to} ${city} AND matched_at IS NOT NULL`;
      const totals = sumDays(list);
      totals.avgSecondsToMatch = all?.avg_match === null || all?.avg_match === undefined ? null : Math.round(all.avg_match);
      return { cityId: cityId ?? null, from: fromDay, to: toDay, days: list, totals };
    },
  };
}

export type TripReports = ReturnType<typeof createTripReports>;

// ── the daily report ─────────────────────────────────────────────────────────

type Counts = { requested: number; completed: number };
export interface TripDay {
  date: string;
  requested: number;
  completed: number;
  cancelled: number;
  /** requested that day and not ended yet */
  active: number;
  completionRate: number | null;
  avgSecondsToMatch: number | null;
  /** final fares of completed trips */
  fareMinor: number;
  cancelFeeMinor: number;
  /** fares + cancellation fees (an estimate: refunds and unpaid charges are payment-service's) */
  gmvMinor: number;
  cancellations: { bySide: Record<string, number>; byReason: Record<string, number> };
  byChannel: Record<string, Counts>;
  byVehicleType: Record<string, Counts>;
}
export interface TripDailyReport {
  cityId: string | null;
  from: string;
  to: string;
  days: TripDay[];
  totals: Omit<TripDay, "date">;
}

const emptyDay = (date: string): TripDay => ({
  date, requested: 0, completed: 0, cancelled: 0, active: 0, completionRate: null, avgSecondsToMatch: null,
  fareMinor: 0, cancelFeeMinor: 0, gmvMinor: 0, cancellations: { bySide: {}, byReason: {} }, byChannel: {}, byVehicleType: {},
});

function sumDays(days: TripDay[]): Omit<TripDay, "date"> {
  const t = emptyDay("");
  const add = (into: Record<string, number>, from: Record<string, number>) => {
    for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
  };
  const addCounts = (into: Record<string, Counts>, from: Record<string, Counts>) => {
    for (const [k, v] of Object.entries(from)) {
      const c = (into[k] ??= { requested: 0, completed: 0 });
      c.requested += v.requested;
      c.completed += v.completed;
    }
  };
  for (const d of days) {
    t.requested += d.requested;
    t.completed += d.completed;
    t.cancelled += d.cancelled;
    t.active += d.active;
    t.fareMinor += d.fareMinor;
    t.cancelFeeMinor += d.cancelFeeMinor;
    t.gmvMinor += d.gmvMinor;
    add(t.cancellations.bySide, d.cancellations.bySide);
    add(t.cancellations.byReason, d.cancellations.byReason);
    addCounts(t.byChannel, d.byChannel);
    addCounts(t.byVehicleType, d.byVehicleType);
  }
  const ended = t.completed + t.cancelled;
  t.completionRate = ended ? t.completed / ended : null;
  const { date: _date, ...rest } = t;
  return rest;
}

// ── CSV ──────────────────────────────────────────────────────────────────────

const SIDES = ["RIDER", "DRIVER", "SYSTEM", "STAFF"];
const CHANNELS = ["APP", "PHONE", "CORPORATE_PORTAL"];

const cell = (v: string | number | null) => {
  if (v === null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per day plus a `total` row; dynamic columns for the reasons and vehicle types seen. */
export function tripReportCsv(r: TripDailyReport): string {
  const reasons = Object.keys(r.totals.cancellations.byReason).sort();
  const sides = [...new Set([...SIDES, ...Object.keys(r.totals.cancellations.bySide)])];
  const channels = [...new Set([...CHANNELS, ...Object.keys(r.totals.byChannel)])];
  const types = Object.keys(r.totals.byVehicleType).sort();
  const header = [
    "date", "requested", "completed", "cancelled", "active", "completion_rate", "avg_seconds_to_match", "fare_minor", "cancel_fee_minor", "gmv_minor",
    ...sides.map((s) => `cancelled_by_${s.toLowerCase()}`), ...reasons.map((x) => `reason_${x.toLowerCase()}`),
    ...channels.flatMap((c) => [`channel_${c.toLowerCase()}_requested`, `channel_${c.toLowerCase()}_completed`]),
    ...types.flatMap((v) => [`vehicle_${v}_requested`, `vehicle_${v}_completed`]),
  ];
  const row = (date: string, d: Omit<TripDay, "date">) => [
    date, d.requested, d.completed, d.cancelled, d.active, d.completionRate === null ? null : d.completionRate.toFixed(4), d.avgSecondsToMatch,
    d.fareMinor, d.cancelFeeMinor, d.gmvMinor,
    ...sides.map((s) => d.cancellations.bySide[s] ?? 0), ...reasons.map((x) => d.cancellations.byReason[x] ?? 0),
    ...channels.flatMap((c) => [d.byChannel[c]?.requested ?? 0, d.byChannel[c]?.completed ?? 0]),
    ...types.flatMap((v) => [d.byVehicleType[v]?.requested ?? 0, d.byVehicleType[v]?.completed ?? 0]),
  ].map(cell).join(",");
  return [header.join(","), ...r.days.map((d) => row(d.date, d)), row("total", r.totals)].join("\r\n") + "\r\n";
}
