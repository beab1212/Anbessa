// Trip, pricing and map API helpers for the staff dispatch pages (Board, TripDetail, PhoneBooking,
// Live map). Pure helpers are exported for tests; hooks follow the query-key style in hooks.ts.

import { useQuery } from "@tanstack/react-query";
import type { LatLng } from "@ride-app/shared-location";
import { api } from "./api";
import type { ClientConfig } from "./platform";
import type { LiveDriver } from "./hooks";

// ── cancelling ──────────────────────────────────────────────────────────────

/**
 * Reasons trip-service accepts (CANCEL_REASONS in services/trip-service/src/http/routes.ts), in the
 * order staff usually need them. NO_SHOW is left out: only the driver may report one.
 * Staff cancellations are always free for the rider (trips/policy.ts `cancellationFee`).
 */
export const STAFF_CANCEL_REASONS = [
  ["STAFF_DECISION", "Staff decision"],
  ["SAFETY", "Safety concern"],
  ["CHANGED_PLANS", "Rider changed plans"],
  ["WRONG_PICKUP", "Wrong pickup"],
  ["DRIVER_TOO_FAR", "Driver too far"],
  ["DRIVER_ASKED_TO_CANCEL", "Driver asked to cancel"],
  ["OTHER", "Other"],
] as const;

export type StaffCancelReason = (typeof STAFF_CANCEL_REASONS)[number][0];

const REASON_LABEL: Record<string, string> = Object.fromEntries([...STAFF_CANCEL_REASONS, ["NO_SHOW", "Rider didn't show"], ["NO_DRIVER_FOUND", "No driver found"]]);

/** "SAFETY" → "Safety concern"; unknown codes become lower-case words. */
export const cancelReasonLabel = (reason: string | null | undefined) =>
  !reason ? "—" : (REASON_LABEL[reason] ?? reason.toLowerCase().replace(/_/g, " "));

export const CANCELLABLE = ["requested", "matched", "en_route"] as const;
export const isCancellable = (status: string) => (CANCELLABLE as readonly string[]).includes(status);

// ── parties ─────────────────────────────────────────────────────────────────

export interface TripParties {
  tripId: string;
  driver: { name: string | null; photo: string | null; rating: number | null; ratingCount: number } | null;
  vehicle: { plateNumber: string; vehicleType: string; make: string | null; model: string | null; color: string | null } | null;
  rider: { name: string | null; photo: string | null } | null;
}

/** The people and car on a trip (names, photos, plate). Cached 60 s by trip-service. */
export function useTripParties(tripId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["trip", tripId, "parties"],
    enabled: !!tripId && enabled,
    staleTime: 30_000,
    retry: false,
    queryFn: () => api<TripParties>("staff", `/api/trips/${tripId}/parties`),
  });
}

/** "White Toyota Vitz" from what fleet-service knows (any part may be missing). */
export function carLine(v: TripParties["vehicle"]): string {
  if (!v) return "";
  const words = [v.color, v.make, v.model].filter((w): w is string => !!w && !!w.trim()).map((w) => w.trim());
  if (!words.length) return v.vehicleType;
  const s = words.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** First letter for an avatar placeholder. */
export const initial = (name: string | null | undefined) => (name?.trim()?.charAt(0) || "?").toUpperCase();

// ── recent trips (this browser only) ────────────────────────────────────────

const RECENT_KEY = "anbessa.staff.recentTrips";
export const RECENT_MAX = 8;

export const looksLikeTripId = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());

/** Most recent first, no duplicates, at most `max`. */
export function pushRecent(list: string[], id: string, max = RECENT_MAX): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, max);
}

/** Read the list; storage may be blocked or hold junk, so anything odd becomes []. */
export function loadRecentTrips(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && looksLikeTripId(x)).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function saveRecentTrips(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    // private window or blocked storage: the list just isn't kept
  }
}

// ── routes ──────────────────────────────────────────────────────────────────

export interface RoutePreview {
  polyline6: string;
  distanceMeters: number;
  durationSeconds: number;
  approximate: boolean;
}

/** "3.2 km · 12 min" */
export function routeSummary(distanceMeters: number | null | undefined, durationSeconds: number | null | undefined): string {
  const parts: string[] = [];
  if (distanceMeters !== null && distanceMeters !== undefined) parts.push(`${(distanceMeters / 1000).toFixed(1)} km`);
  if (durationSeconds !== null && durationSeconds !== undefined) parts.push(`${Math.max(1, Math.round(durationSeconds / 60))} min`);
  return parts.join(" · ");
}

const pair = (p: LatLng) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

/** The road line between two places, from mapping-service (OSRM; straight line when it's offline). */
export function useRoutePreview(from: LatLng | null, to: LatLng | null) {
  return useQuery({
    queryKey: ["maps", "route", from ? pair(from) : null, to ? pair(to) : null],
    enabled: !!from && !!to,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => api<RoutePreview>("staff", `/api/maps/route?${new URLSearchParams({ from: pair(from!), to: pair(to!) })}`),
  });
}

// ── what the city offers ────────────────────────────────────────────────────

export interface VehicleOption {
  code: string;
  name: string;
  seats: string;
}

/** pricing-service's fallback when platform-service has no catalogue. */
const BUILT_IN_VEHICLES: VehicleOption[] = [
  { code: "economy", name: "Economy", seats: "4 seats" },
  { code: "comfort", name: "Comfort", seats: "4 seats" },
  { code: "minivan", name: "Minivan", seats: "7 seats" },
];

const seatsText = (min: number, max: number) => (min === max || !min ? `${max} seats` : `${min}–${max} seats`);

/** Enabled vehicle types offered in the city (an empty `cities` list means every city). */
export function vehicleOptions(cfg: Pick<ClientConfig, "vehicleTypes"> | null, cityId: string): VehicleOption[] {
  const types = cfg?.vehicleTypes ?? [];
  if (types.length === 0) return BUILT_IN_VEHICLES;
  return types
    .filter((v) => v.cities.length === 0 || v.cities.includes(cityId))
    .map((v) => ({ code: v.code, name: v.name, seats: seatsText(v.seatsMin, v.seatsMax) }));
}

export interface FareCard {
  vehicleType: string;
  baseMinor: number;
  perKmMinor: number;
  perMinMinor: number;
  minFareMinor: number;
  waitingPerMinMinor: number;
  currency: string;
}

export function useFares(cityId: string | null) {
  return useQuery({
    queryKey: ["pricing", "fares", cityId],
    enabled: !!cityId,
    staleTime: 60_000,
    queryFn: () => api<{ cityId: string; fares: FareCard[] }>("staff", `/api/pricing/fares?cityId=${cityId}`).then((r) => r.fares),
  });
}

export interface PaymentProvider {
  provider: string;
  label: string;
  methods: string[];
  mode: string;
}

export function usePaymentMethods(cityId: string | null) {
  return useQuery({
    queryKey: ["money", "methods", cityId],
    enabled: !!cityId,
    staleTime: 60_000,
    queryFn: () => api<{ methods: string[]; providers: PaymentProvider[] }>("staff", `/api/payments/methods?cityId=${cityId}`),
  });
}

/**
 * Methods a caller without the app can use. Card checkout happens in the rider app, so a phone
 * booking offers cash and mobile money only, and only those the city has switched on.
 */
export const PHONE_METHODS = ["CASH", "MOBILE_MONEY"] as const;
export type PhoneMethod = (typeof PHONE_METHODS)[number];

export function phoneMethods(cityMethods: string[] | undefined): PhoneMethod[] {
  if (!cityMethods) return [...PHONE_METHODS];
  return PHONE_METHODS.filter((m) => cityMethods.includes(m));
}

/** "Telebirr, M-Pesa" for a method, from the gateways that take it. */
export function providersFor(method: string, providers: PaymentProvider[] | undefined): string {
  return (providers ?? []).filter((p) => p.methods.includes(method)).map((p) => p.label).join(", ");
}

// ── live map ────────────────────────────────────────────────────────────────

export type DriverState = "all" | "free" | "trip" | "silent";

export const driverState = (d: LiveDriver): Exclude<DriverState, "all"> => (d.stale ? "silent" : d.status === "on_trip" ? "trip" : "free");

/** Client-side filters: location-service returns every online driver in the city. */
export function filterDrivers(list: LiveDriver[], f: { state: DriverState; vehicleType: string }): LiveDriver[] {
  return list.filter((d) => (f.state === "all" || driverState(d) === f.state) && (f.vehicleType === "all" || d.vehicleType === f.vehicleType));
}

/** Distinct vehicle types among drivers, sorted. */
export const vehicleTypesOf = (list: LiveDriver[]) => [...new Set(list.map((d) => d.vehicleType))].sort();
