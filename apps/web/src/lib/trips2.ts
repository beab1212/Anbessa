// trip-service API helpers for scheduled rides (workflow 12), dispatcher reassignment, the GPS
// trace, company ride policies (workflow 11) and the regulatory report. Pure helpers are exported
// for tests; hooks follow the query-key style of hooks.ts.

import { useQuery } from "@tanstack/react-query";
import { haversineMeters, type LatLng } from "@ride-app/shared-location";
import { api, type Surface } from "./api";
import type { LiveDriver } from "./hooks";
import { qs } from "./reports";

const ADDIS_OFFSET_MS = 3 * 3600_000;

// ── scheduled rides ─────────────────────────────────────────────────────────

export type ScheduledStatus = "SCHEDULED" | "DISPATCHING" | "DISPATCHED" | "CANCELLED" | "FAILED";

/** trip-service `scheduledView` (src/trips/scheduled.ts). */
export interface ScheduledRide {
  id: string;
  status: ScheduledStatus;
  cityId: string;
  channel: string;
  vehicleType: string;
  paymentMethod: string;
  billing: { type: string; orgId: string | null };
  riderUserId: string;
  bookedByUserId: string;
  purpose: string | null;
  pickup: { lat: number; lng: number; address: string | null };
  dropoff: { lat: number; lng: number; address: string | null };
  fare: { estimateMinor: number; currency: string };
  route: { estDistanceMeters: number; estDurationSeconds: number; polyline: string | null };
  scheduledFor: string;
  matchAt: string;
  tripId: string | null;
  tripStatus: string | null;
  dispatchedAt: string | null;
  cancelledAt: string | null;
  failReason: string | null;
  escalatedAt: string | null;
  createdAt: string;
  editable: boolean;
}

export const SCHEDULED_LABEL: Record<ScheduledStatus, string> = {
  SCHEDULED: "Booked", DISPATCHING: "Starting", DISPATCHED: "Sent to matching", CANCELLED: "Cancelled", FAILED: "Couldn't start",
};
export const scheduledTone = (s: string) =>
  (s === "SCHEDULED" ? "blue" : s === "DISPATCHING" || s === "DISPATCHED" ? "green" : s === "FAILED" ? "red" : "grey") as "blue" | "green" | "red" | "grey";

const FAIL_WORD: Record<string, string> = { RIDER_HAS_ACTIVE_TRIP: "the rider was still on another ride", DISPATCH_FAILED: "the trip couldn't be created" };
export const failReasonLabel = (r: string | null | undefined) => (!r ? "" : (FAIL_WORD[r] ?? r.toLowerCase().replace(/_/g, " ")));

/** Booking window (trip-service DEFAULT_SCHEDULE): 30 min to 7 days ahead. */
export const SCHEDULE_MIN_AHEAD_MS = 30 * 60_000;
export const SCHEDULE_MAX_AHEAD_MS = 7 * 86_400_000;

/** "2026-11-04T10:00" (a datetime-local value, Addis time) → ISO instant; null when malformed. */
export function addisInputToIso(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  const t = Date.UTC(y, mo - 1, d, h, mi) - ADDIS_OFFSET_MS;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** ISO instant → "2026-11-04T10:00" in Addis time (for a datetime-local input). */
export function isoToAddisInput(iso: string | number): string {
  return new Date(new Date(iso).getTime() + ADDIS_OFFSET_MS).toISOString().slice(0, 16);
}

/** Why a pickup time can't be booked, or null. */
export function scheduleProblem(iso: string | null, now = Date.now()): string | null {
  if (!iso) return "Pick a date and time.";
  const ahead = Date.parse(iso) - now;
  if (ahead < SCHEDULE_MIN_AHEAD_MS) return "Book at least 30 minutes ahead, or request a ride now.";
  if (ahead > SCHEDULE_MAX_AHEAD_MS) return "Book at most 7 days ahead.";
  return null;
}

export function useScheduled(surface: Surface, query: { orgId?: string; cityId?: string; status?: string }, enabled = true) {
  const q = qs({ orgId: query.orgId, cityId: query.cityId, status: query.status, limit: 200 });
  return useQuery({
    queryKey: ["scheduled", surface, q],
    enabled,
    refetchInterval: 30_000,
    queryFn: () => api<{ scheduled: ScheduledRide[] }>(surface, `/api/trips/scheduled${q}`).then((r) => r.scheduled),
  });
}

export const cancelScheduled = (surface: Surface, id: string) => api<ScheduledRide>(surface, `/api/trips/scheduled/${id}/cancel`, { method: "POST", body: {} });

// ── reassignment ────────────────────────────────────────────────────────────

/** Free drivers who could take the trip instead, nearest to the pickup first. */
export function reassignCandidates(drivers: LiveDriver[] | undefined, trip: { vehicleType: string; pickup: LatLng; driver: { userId: string } | null }, max = 8) {
  return (drivers ?? [])
    .filter((d) => d.status === "available" && !d.stale && d.vehicleType === trip.vehicleType && d.driverId !== trip.driver?.userId && d.lat !== undefined && d.lng !== undefined)
    .map((d) => ({ ...d, meters: Math.round(haversineMeters({ lat: d.lat!, lng: d.lng! }, trip.pickup)) }))
    .sort((a, b) => a.meters - b.meters)
    .slice(0, max);
}

export const REASSIGNABLE = ["matched", "en_route"] as const;
export const isReassignable = (status: string) => (REASSIGNABLE as readonly string[]).includes(status);

// ── GPS trace ───────────────────────────────────────────────────────────────

/** trip-service GET /api/trips/:id/trace. */
export interface TripTraceData {
  tripId: string;
  cityId: string;
  status: string;
  driverUserId: string | null;
  count: number;
  polyline6: string;
  points: { at: string; phase: "to_pickup" | "ride" | "after"; speed: number | null; accuracy: number | null }[];
  from: string | null;
  to: string | null;
  startedAt: string | null;
  completedAt: string | null;
  totalDistanceMeters: number;
  rideDistanceMeters: number | null;
  thinning: { minSeconds: number; minMeters: number; heartbeatSeconds: number };
}

/** Split decoded points into the pickup leg and the ride, by the per-point phase. */
export function splitTrace(points: LatLng[], meta: TripTraceData["points"]): { toPickup: LatLng[]; ride: LatLng[] } {
  const toPickup: LatLng[] = [];
  const ride: LatLng[] = [];
  points.forEach((p, i) => {
    const phase = meta[i]?.phase;
    if (phase === "ride") ride.push(p);
    else if (phase === "to_pickup") toPickup.push(p);
  });
  // join the legs so the line has no gap at the pickup
  if (toPickup.length && ride.length) toPickup.push(ride[0]!);
  return { toPickup, ride };
}

/** Every read is audited by trip-service, so the trace is fetched on demand, never polled. */
export function useTripTrace(tripId: string, reason: string, enabled: boolean) {
  return useQuery({
    queryKey: ["trip", tripId, "trace"],
    enabled,
    staleTime: Infinity,
    retry: false,
    queryFn: () => api<TripTraceData>("staff", `/api/trips/${tripId}/trace${qs({ reason })}`),
  });
}

// ── company ride policies ───────────────────────────────────────────────────

export interface CorporatePolicy {
  orgId: string;
  allowedVehicleTypes: string[];
  /** 0 = Sunday … 6 = Saturday */
  allowedDays: number[];
  startMinute: number | null;
  endMinute: number | null;
  maxFareMinor: number | null;
  monthlyBudgetMinor: number | null;
  requirePurpose: boolean;
  updatedAt: string | null;
  updatedByUserId: string | null;
  configured: boolean;
  month: string;
  spentThisMonthMinor: number;
}

export type PolicyInput = Pick<CorporatePolicy, "allowedVehicleTypes" | "allowedDays" | "startMinute" | "endMinute" | "maxFareMinor" | "monthlyBudgetMinor" | "requirePurpose">;

/** Monday first, the way people read a week. */
export const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 390 → "06:30"; 1440 → "24:00". */
export const minutesToHhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** "06:30" → 390; "24:00" → 1440; null when malformed. */
export function hhmmToMinutes(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (mi > 59 || h > 24 || (h === 24 && mi > 0)) return null;
  return h * 60 + mi;
}

/** The rules in short sentences, for people booking under them. */
export function policySummary(p: Pick<CorporatePolicy, "allowedVehicleTypes" | "allowedDays" | "startMinute" | "endMinute" | "maxFareMinor" | "monthlyBudgetMinor" | "requirePurpose">, money: (minor: number) => string): string[] {
  const out: string[] = [];
  if (p.allowedVehicleTypes.length) out.push(`Cars: ${p.allowedVehicleTypes.join(", ")}`);
  if (p.allowedDays.length && p.allowedDays.length < 7) out.push(`Days: ${WEEK.filter((d) => p.allowedDays.includes(d)).map((d) => DAY_SHORT[d]).join(", ")}`);
  if (p.startMinute !== null && p.endMinute !== null) out.push(`Hours: ${minutesToHhmm(p.startMinute)}–${minutesToHhmm(p.endMinute)}${p.startMinute > p.endMinute ? " (past midnight)" : ""}`);
  if (p.maxFareMinor !== null) out.push(`Up to ${money(p.maxFareMinor)} a ride`);
  if (p.monthlyBudgetMinor !== null) out.push(`${money(p.monthlyBudgetMinor)} a month in total`);
  if (p.requirePurpose) out.push("A trip purpose is required");
  return out.length ? out : ["No limits: any car, any time"];
}

export function useCorporatePolicy(orgId: string, enabled = true) {
  return useQuery({
    queryKey: ["corporate-policy", orgId],
    enabled: !!orgId && enabled,
    queryFn: () => api<CorporatePolicy>("partner", `/api/trips/corporate/${orgId}/policy`),
  });
}

export const savePolicy = (orgId: string, body: PolicyInput) =>
  api<CorporatePolicy>("partner", `/api/trips/corporate/${orgId}/policy`, { method: "PUT", body });

// ── regulatory report ───────────────────────────────────────────────────────

export interface RegulatoryRow {
  month: string;
  cityId: string;
  tripsRequested: number;
  tripsCompleted: number;
  tripsCancelled: number;
  tripsNoDriver: number;
  activeDrivers: number;
  activeVehicles: number;
  distanceKm: number;
  safetyIncidents: number;
  seriousIncidents: number;
}

export interface RegulatoryReport {
  cityId: string | null;
  from: string;
  to: string;
  rows: RegulatoryRow[];
}

/** The Addis calendar month before `now`, "YYYY-MM". */
export function lastMonth(now = Date.now()): string {
  const d = new Date(now + ADDIS_OFFSET_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

/** Why a month range can't be asked for (trip-service allows 1–12 months), or null. */
export function monthRangeProblem(from: string, to: string): string | null {
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) return "Pick a first and last month.";
  if (from > to) return "The first month must not be after the last.";
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  if ((ty - fy) * 12 + (tm - fm) + 1 > 12) return "At most 12 months at a time.";
  return null;
}

/** "2026-10" → "Oct 2026". */
export const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

/** Totals over rows. Active drivers and vehicles are distinct per month and city, so they are not summed. */
export function regulatoryTotals(rows: RegulatoryRow[]) {
  const t = { tripsRequested: 0, tripsCompleted: 0, tripsCancelled: 0, tripsNoDriver: 0, distanceKm: 0, safetyIncidents: 0, seriousIncidents: 0 };
  for (const r of rows) {
    t.tripsRequested += r.tripsRequested;
    t.tripsCompleted += r.tripsCompleted;
    t.tripsCancelled += r.tripsCancelled;
    t.tripsNoDriver += r.tripsNoDriver;
    t.distanceKm += r.distanceKm;
    t.safetyIncidents += r.safetyIncidents;
    t.seriousIncidents += r.seriousIncidents;
  }
  t.distanceKm = Math.round(t.distanceKm * 10) / 10;
  return t;
}

export function useRegulatory(cityId: string, from: string, to: string, enabled = true) {
  const q = qs({ cityId, from, to });
  return useQuery({
    queryKey: ["reports", "regulatory", q],
    enabled,
    queryFn: () => api<RegulatoryReport>("staff", `/api/trips/reports/regulatory${q}`),
  });
}
