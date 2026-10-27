// Reports, trip search and partner money/trip lists: types for trip-service's and payment-service's
// report endpoints, plus small date, query-string, CSV and chart helpers.

import type { Trip } from "@ride-app/shared-types";
import { http, type Surface } from "./api";
import { download } from "./admin";

// ── trip-service ────────────────────────────────────────────────────────────

export interface TripDay {
  date: string;
  requested: number;
  completed: number;
  cancelled: number;
  active: number;
  completionRate: number | null;
  avgSecondsToMatch: number | null;
  fareMinor: number;
  cancelFeeMinor: number;
  gmvMinor: number;
  cancellations: { bySide: Record<string, number>; byReason: Record<string, number> };
  byChannel: Record<string, { requested: number; completed: number }>;
  byVehicleType: Record<string, { requested: number; completed: number }>;
}

export interface TripDailyReport {
  cityId: string | null;
  from: string;
  to: string;
  days: TripDay[];
  totals: Omit<TripDay, "date">;
}

export interface TripPage {
  trips: Trip[];
  next: string | null;
}

export const TRIP_STATUSES = ["requested", "matched", "en_route", "in_progress", "completed", "cancelled"] as const;
export const CHANNELS = ["APP", "PHONE", "CORPORATE_PORTAL"] as const;
export const PAYMENT_METHODS = ["CASH", "MOBILE_MONEY", "CARD", "CORPORATE"] as const;

export const CHANNEL_WORD: Record<string, string> = { APP: "app", PHONE: "phone", CORPORATE_PORTAL: "company portal" };
export const METHOD_WORD: Record<string, string> = { CASH: "cash", MOBILE_MONEY: "mobile money", CARD: "card", CORPORATE: "company", OFFICE_CASH: "office cash", BANK_TRANSFER: "bank transfer" };
export const SIDE_WORD: Record<string, string> = { RIDER: "rider", DRIVER: "driver", SYSTEM: "system", STAFF: "staff" };

/** Filters of GET /api/trips/search (empty strings are dropped from the query). */
export interface TripSearchFilters {
  cityId: string;
  status: string;
  from: string;
  to: string;
  channel: string;
  paymentMethod: string;
  riderUserId: string;
  driverUserId: string;
  vehicleId: string;
  billingOrgId: string;
  q: string;
}

export const EMPTY_SEARCH: TripSearchFilters = {
  cityId: "", status: "", from: "", to: "", channel: "", paymentMethod: "", riderUserId: "", driverUserId: "", vehicleId: "", billingOrgId: "", q: "",
};

// ── payment-service ─────────────────────────────────────────────────────────

export interface FinanceDay {
  date: string;
  trips: number;
  fareMinor: number;
  commissionMinor: number;
  vatMinor: number;
  earningsMinor: number;
  byMethod: Record<string, { trips: number; fareMinor: number; commissionMinor: number; vatMinor: number }>;
  cancellationFees: { count: number; feeMinor: number; commissionMinor: number };
  collections: Record<string, { count: number; amountMinor: number }>;
  refunds: { count: number; amountMinor: number };
  payouts: { count: number; amountMinor: number };
  topUps: Record<string, { count: number; amountMinor: number }>;
}

export interface FinanceDailyReport {
  cityId: string | null;
  from: string;
  to: string;
  days: FinanceDay[];
  totals: Omit<FinanceDay, "date">;
}

export type EarningsPeriod = "today" | "week" | "month" | "custom";

export interface FleetEarnings {
  from: string;
  to: string;
  trips: number;
  cancellations: number;
  grossMinor: number;
  commissionMinor: number;
  vatMinor: number;
  netMinor: number;
  balanceChangeMinor: number;
  cashCollectedMinor: number;
  byDay: { day: string; trips: number; grossMinor: number; netMinor: number }[];
  byDriver: { driverId: string; trips: number; grossMinor: number; netMinor: number }[];
}

export interface OrgCharge {
  id: string;
  at: string;
  kind: string;
  tripId: string | null;
  purpose: "TRIP_FARE" | "CANCELLATION_FEE" | null;
  /** positive = charged to the company */
  amountMinor: number;
  riderId: string | null;
  cityId: string | null;
  vehicleType: string | null;
  memo: string | null;
}

export interface OrgCharges {
  orgId: string;
  owedMinor: number;
  charges: OrgCharge[];
  next: string | null;
}

// ── dates (Addis Ababa days, UTC+3, no daylight saving) ─────────────────────

const ADDIS_OFFSET_MS = 3 * 3600_000;
const DAY_MS = 86_400_000;
export const MAX_RANGE_DAYS = 92;

/** Today's date in Addis Ababa, YYYY-MM-DD. */
export const addisToday = (now = Date.now()) => new Date(now + ADDIS_OFFSET_MS).toISOString().slice(0, 10);

/** `day` moved by `n` days (YYYY-MM-DD). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The reports' default: the last seven days, today included. */
export function defaultRange(now = Date.now()): { from: string; to: string } {
  const to = addisToday(now);
  return { from: addDays(to, -6), to };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Number of days in an inclusive range, or null when a date is malformed. */
export function rangeDays(from: string, to: string): number | null {
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / DAY_MS) + 1;
}

/** Why a range can't be asked for, or null when it's fine (1–92 days, from ≤ to). */
export function rangeProblem(from: string, to: string): string | null {
  const n = rangeDays(from, to);
  if (n === null) return "Pick both dates.";
  if (n < 1) return "The start date is after the end date.";
  if (n > MAX_RANGE_DAYS) return `Pick at most ${MAX_RANGE_DAYS} days.`;
  return null;
}

/** "Mon 27" style label for a chart axis. */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", timeZone: "UTC" });
}

// ── query strings and CSV ───────────────────────────────────────────────────

/** `?a=1&b=2` from an object; empty, null and undefined values are left out. */
export function qs(params: Record<string, string | number | null | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== "" && v !== null && v !== undefined) s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
}

/** Fetch a CSV with the surface's token and hand it to the browser as a file. */
export async function downloadCsv(surface: Surface, path: string, filename: string) {
  const res = await http.get<string>(path, { surface, responseType: "text" });
  download(filename, res.data);
}

// ── charts ──────────────────────────────────────────────────────────────────

/** A "nice" axis maximum (1, 2, 2.5, 5 × 10ⁿ) at or above `max`; 1 when there is nothing. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

/** Bar height in px for `value` on a 0..`max` axis drawn `height` px tall. */
export const barHeight = (value: number, max: number, height: number) => (max > 0 ? Math.max(0, Math.round((value / max) * height)) : 0);

export const percentOf = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v * 1000) / 10}%`);

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? `${m} min ${s} s` : `${m} min`;
}

/** Sum a record's `amountMinor`/`count` style entries. */
export const sumOf = <T>(rec: Record<string, T> | undefined, pick: (v: T) => number) => Object.values(rec ?? {}).reduce((n, v) => n + pick(v), 0);
