// The GPS trace of a trip (workflow 06 step 14, workflow 14 step 12).
//
// realtime-gateway publishes every accepted driver ping on `driver.location`, with the tripId from
// location state (set on trip.matched, cleared when the trip ends). trip-service consumes that
// topic and keeps a thinned copy per trip in `trip_trace`: a point when the car moved ≥ 20 m and
// ≥ 5 s passed since the last kept point, plus one every 60 s while it stands still. Only pings of
// the trip's current driver while it is matched / en route / in progress are kept (the trip's
// status is cached 10 s per trip). Whether a point is on the way to the pickup or part of the ride
// is decided from the trip's started_at / completed_at, not from the recorded status.
//
// Staff with trip:read_gps_trace (dispatch and safety, CITY) read it as an encoded polyline
// (precision 6) with a timestamp per point; every read is audited (Role.md §10). The driven
// distance of the ride (started_at → drop-off) becomes the trip's actual distance on completion.

import { authorize, type Principal } from "@ride-app/shared-authz";
import { haversineMeters, type LatLng } from "@ride-app/shared-location";
import type { DriverLocationEvent } from "@ride-app/shared-types";
import type { Logger } from "@ride-app/shared-utils";
import type { Db } from "../db.js";
import { notFound } from "../lib/errors.js";
import { audit, writeOutbox } from "../outbox/outbox.js";

export const TRACE_MIN_SECONDS = 5;
export const TRACE_MIN_METERS = 20;
export const TRACE_HEARTBEAT_SECONDS = 60;
/** faster than this between two points is a GPS jump, left out of the distance */
const MAX_SPEED_MPS = 200 / 3.6;
const TRACED = new Set(["matched", "en_route", "in_progress"]);

/** Google's encoded polyline format at precision 6 (what OSRM and the trip's route use). */
export function encodePolyline6(points: LatLng[]): string {
  let out = "";
  let pLat = 0;
  let pLng = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e6);
    const lng = Math.round(p.lng * 1e6);
    out += enc(lat - pLat) + enc(lng - pLng);
    pLat = lat;
    pLng = lng;
  }
  return out;
}

/** Metres driven along the points, skipping implausible jumps. */
export function tracedDistance(points: { lat: number; lng: number; at: Date }[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const d = haversineMeters(a, b);
    const dt = (b.at.getTime() - a.at.getTime()) / 1000;
    if (dt > 0 && d / dt <= MAX_SPEED_MPS) total += d;
  }
  return Math.round(total);
}

interface Kept { lat: number; lng: number; at: number }

export function createTraceRecorder(deps: { db: Db; logger: Logger; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const last = new Map<string, Kept>();
  const trips = new Map<string, { status: string; driverId: string | null; until: number }>();

  async function tripState(tripId: string) {
    const hit = trips.get(tripId);
    if (hit && hit.until > now().getTime()) return hit;
    const t = await db.trip.findUnique({ where: { id: tripId }, select: { status: true, driverUserId: true } });
    if (trips.size > 20_000) trips.clear();
    // short cache: a status change shows within 10 s (then points of a finished trip are dropped)
    const state = { status: t?.status ?? "unknown", driverId: t?.driverUserId ?? null, until: now().getTime() + 10_000 };
    trips.set(tripId, state);
    return state;
  }

  return {
    /** One driver.location event. Returns true when a point was kept. */
    async record(e: DriverLocationEvent): Promise<boolean> {
      if (!e.tripId || !/^[0-9a-f-]{36}$/i.test(e.tripId)) return false;
      if (![e.lat, e.lng, e.at].every(Number.isFinite) || Math.abs(e.lat) > 90 || Math.abs(e.lng) > 180) return false;
      // device time; a clock far in the future is not trusted
      if (e.at > now().getTime() + 5 * 60_000) return false;
      const state = await tripState(e.tripId);
      if (!TRACED.has(state.status) || state.driverId !== e.driverId) return false;

      let prev = last.get(e.tripId);
      if (!prev) {
        const row = await db.tripTracePoint.findFirst({ where: { tripId: e.tripId }, orderBy: { at: "desc" } });
        if (row) prev = { lat: row.lat, lng: row.lng, at: row.at.getTime() };
      }
      if (prev) {
        const dt = (e.at - prev.at) / 1000;
        if (dt <= 0) return false;
        const moved = haversineMeters(prev, e);
        const keep = (dt >= TRACE_MIN_SECONDS && moved >= TRACE_MIN_METERS) || dt >= TRACE_HEARTBEAT_SECONDS;
        if (!keep) return false;
      }
      await db.tripTracePoint.createMany({
        data: [{
          tripId: e.tripId, at: new Date(e.at), lat: e.lat, lng: e.lng, status: state.status,
          speed: Number.isFinite(e.speed) ? e.speed! : null, accuracy: Number.isFinite(e.accuracy) ? e.accuracy! : null,
        }],
        skipDuplicates: true,
      });
      if (last.size > 20_000) last.clear();
      last.set(e.tripId, { lat: e.lat, lng: e.lng, at: e.at });
      return true;
    },

    /** Forget a trip's cached state (tests; after a reassignment). */
    forget(tripId: string) {
      last.delete(tripId);
      trips.delete(tripId);
    },
  };
}

export type TraceRecorder = ReturnType<typeof createTraceRecorder>;

export function createTraceReader(deps: { db: Db }) {
  const { db } = deps;

  /** The driven distance between pickup and drop-off, or null when there are too few points. */
  async function rideDistance(tripId: string, from: Date, to: Date): Promise<number | null> {
    const points = await db.tripTracePoint.findMany({ where: { tripId, at: { gte: from, lte: to } }, orderBy: { at: "asc" } });
    return points.length >= 2 ? tracedDistance(points) : null;
  }

  return {
    rideDistance,

    /** trip:read_gps_trace @ the trip's city; audited. */
    async read(p: Principal, tripId: string, reason?: string) {
      const t = await db.trip.findUnique({ where: { id: tripId } });
      if (!t) throw notFound("trip");
      authorize(p, "trip:read_gps_trace", { cityId: t.cityId });
      const points = await db.tripTracePoint.findMany({ where: { tripId }, orderBy: { at: "asc" } });
      await writeOutbox(db, audit({
        actorId: p.userId, action: "trip:read_gps_trace", resource: { type: "trip", id: tripId }, outcome: "ALLOWED",
        ...(reason ? { reason: reason.slice(0, 500) } : {}),
      }));
      // the phase comes from the trip's own timestamps (the recorded status can lag a few seconds)
      const started = t.startedAt?.getTime() ?? Infinity;
      const ended = t.completedAt?.getTime() ?? t.cancelledAt?.getTime() ?? Infinity;
      const phase = (at: Date) => (at.getTime() < started ? "to_pickup" : at.getTime() <= ended ? "ride" : "after");
      const ride = points.filter((x) => phase(x.at) === "ride");
      return {
        tripId,
        cityId: t.cityId,
        status: t.status,
        driverUserId: t.driverUserId,
        count: points.length,
        polyline6: encodePolyline6(points),
        /** one per point, same order as the polyline */
        points: points.map((x) => ({ at: x.at.toISOString(), phase: phase(x.at), speed: x.speed, accuracy: x.accuracy })),
        from: points[0]?.at.toISOString() ?? null,
        to: points.at(-1)?.at.toISOString() ?? null,
        /** everything recorded, pickup leg included */
        totalDistanceMeters: tracedDistance(points),
        startedAt: t.startedAt?.toISOString() ?? null,
        completedAt: t.completedAt?.toISOString() ?? null,
        /** the ride itself (rider in the car) */
        rideDistanceMeters: ride.length >= 2 ? tracedDistance(ride) : null,
        thinning: { minSeconds: TRACE_MIN_SECONDS, minMeters: TRACE_MIN_METERS, heartbeatSeconds: TRACE_HEARTBEAT_SECONDS },
        raw: points,
      };
    },
  };
}

export type TraceReader = ReturnType<typeof createTraceReader>;

/** The trace as CSV (for police exports). */
export function traceCsv(points: { at: Date; lat: number; lng: number; status: string; speed: number | null; accuracy: number | null }[]): string {
  const lines = ["at,lat,lng,status,speed_mps,accuracy_m"];
  for (const x of points) lines.push([x.at.toISOString(), x.lat.toFixed(6), x.lng.toFixed(6), x.status, x.speed ?? "", x.accuracy ?? ""].join(","));
  return `${lines.join("\n")}\n`;
}
