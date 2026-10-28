// Partner-portal helpers (company edit, members, fleet drivers, company trips, the partner's
// own account). Pure functions here are unit-tested in tests/partner.test.ts.

import type { Trip } from "@ride-app/shared-types";
import type { ClientConfig } from "./platform";
import { VEHICLE_TYPES } from "./fleet";

// ── Better Auth shapes (organization plugin, sessions) ──────────────────────

export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "rejected" | "canceled" | string;
  expiresAt: string;
  createdAt?: string;
  inviterId?: string;
}

/** `GET /organization/list-user-invitations`: pending invitations addressed to me. */
export interface UserInvitation extends Invitation {
  organizationName?: string;
}

export interface AuthSession {
  id: string;
  token: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface SessionInfo {
  session: AuthSession;
  user: { id: string; name: string; email: string; image?: string | null; phoneNumber?: string | null };
}

// ── members and invitations ─────────────────────────────────────────────────

export const roleList = (role: string) => role.split(",").map((r) => r.trim()).filter(Boolean);

/** Company accounts move people between employee and travel desk (coordinator). */
export const SWAPPABLE: Record<string, string> = { employee: "corporate_coordinator", corporate_coordinator: "employee" };

/**
 * The role field after switching employee ↔ coordinator, or null when this member can't be switched
 * (admins, owners, drivers, or someone holding both).
 */
export function switchedRole(role: string): string | null {
  const roles = roleList(role);
  if (roles.length !== 1) return null;
  return SWAPPABLE[roles[0]!] ?? null;
}

/** An invitation still waiting for an answer (not withdrawn, not expired). */
export const invitationOpen = (i: Pick<Invitation, "status" | "expiresAt">, now = Date.now()) =>
  i.status === "pending" && new Date(i.expiresAt).getTime() > now;

// ── trips ───────────────────────────────────────────────────────────────────

/** Statuses a booker (rider side) may cancel from. */
export const CANCELLABLE = ["requested", "matched", "en_route"] as const;
export const isCancellable = (status: string) => (CANCELLABLE as readonly string[]).includes(status);

/** Where the car is worth polling for. */
export const isOnRoad = (status: string) => status === "matched" || status === "en_route" || status === "in_progress";

/** Reasons a company booker can give (NO_SHOW is the driver's, STAFF_DECISION staff's). */
export const BOOKER_CANCEL_REASONS: { code: string; label: string }[] = [
  { code: "CHANGED_PLANS", label: "Plans changed" },
  { code: "DRIVER_TOO_FAR", label: "The driver is too far away" },
  { code: "DRIVER_ASKED_TO_CANCEL", label: "The driver asked us to cancel" },
  { code: "WRONG_PICKUP", label: "Wrong pickup point" },
  { code: "SAFETY", label: "Safety concern" },
  { code: "OTHER", label: "Something else" },
];

/**
 * What cancelling now would cost, in words (trip-service `cancellationFee()` for a rider-side
 * cancel). Amounts and the free window are live per-city settings the web app doesn't read, so
 * this says when a fee applies, not how much; the result shows the actual fee.
 */
export function cancelFeeNote(t: Pick<Trip, "status" | "times">, reason: string): { free: boolean; text: string } {
  if (t.status === "requested" || !t.times.matchedAt) return { free: true, text: "Free: no driver has been assigned yet." };
  // the booker's word alone doesn't waive the fee: support reviews the trip and refunds it
  const review = reason === "DRIVER_ASKED_TO_CANCEL" ? " If the driver asked you to cancel, support reviews the trip and refunds the fee." : "";
  if (t.times.arrivedAt) {
    return { free: false, text: `The driver is already at the pickup: the cancellation fee plus paid waiting so far is charged to the company account, and most of it goes to the driver.${review}` };
  }
  return { free: false, text: `Free within the first couple of minutes after a driver is assigned. After that a cancellation fee is charged to the company account, and most of it goes to the driver.${review}` };
}

export const CANCELLED_BY: Record<string, string> = { RIDER: "the rider side", DRIVER: "the driver", SYSTEM: "Anbessa (no driver found)", STAFF: "Anbessa staff" };
export const reasonWord = (code: string) => BOOKER_CANCEL_REASONS.find((r) => r.code === code)?.label ?? code.toLowerCase().replace(/_/g, " ");

/** A quote can be booked until it expires; give a few seconds of slack for the request itself. */
export const quoteUsable = (q: { expiresAt?: string } | null, now = Date.now()) => !!q && (!q.expiresAt || new Date(q.expiresAt).getTime() - now > 5_000);

// ── trips booked in this browser (there is no company trip list on the server) ──

export interface BookedTrip {
  id: string;
  orgId: string;
  rider: string;
  from: string;
  to: string;
  vehicleType: string;
  fareMinor: number;
  at: string;
}

const BOOKED_KEY = "anbessa.partner.booked";
const MAX_BOOKED = 30;

/** sessionStorage-like: only what this tab booked, gone when it closes. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const browserStore = (): KeyValueStore | null => {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
};

function readBooked(store: KeyValueStore | null): BookedTrip[] {
  try {
    const raw = store?.getItem(BOOKED_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as BookedTrip[]).filter((x) => x && typeof x.id === "string" && typeof x.orgId === "string") : [];
  } catch {
    return [];
  }
}

export function rememberBookedTrip(trip: BookedTrip, store: KeyValueStore | null = browserStore()) {
  const list = [trip, ...readBooked(store).filter((x) => x.id !== trip.id)].slice(0, MAX_BOOKED);
  try {
    store?.setItem(BOOKED_KEY, JSON.stringify(list));
  } catch {
    // storage full or blocked: the trip page link from the booking still works
  }
}

export const bookedTrips = (orgId: string, store: KeyValueStore | null = browserStore()) => readBooked(store).filter((x) => x.orgId === orgId);

// ── booking choices ─────────────────────────────────────────────────────────

export interface VehicleChoice {
  code: string;
  name: string;
  seats: string;
}

/** Vehicle types offered in the city (Administration → Cities and vehicles); the built-in three until the config loads. */
export function vehicleChoices(config: Pick<ClientConfig, "vehicleTypes"> | null, cityId: string): VehicleChoice[] {
  if (!config) return VEHICLE_TYPES.map((t) => ({ code: t.id, name: t.name, seats: `${t.seats[0]}–${t.seats[1]}` }));
  return config.vehicleTypes
    .filter((t) => t.cities.includes(cityId))
    .map((t) => ({ code: t.code, name: t.name, seats: t.seatsMin === t.seatsMax ? String(t.seatsMax) : `${t.seatsMin}–${t.seatsMax}` }));
}

export interface Fare {
  vehicleType: string;
  baseMinor: number;
  perKmMinor: number;
  perMinMinor: number;
  minFareMinor: number;
  waitingPerMinMinor: number;
  currency: string;
}

// ── the partner's own account ───────────────────────────────────────────────

/** "Chrome on Android" from a user agent, for the sessions list. */
export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  if (/dart|okhttp|anbessa/i.test(ua)) return "Anbessa app";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}

/** Phone-only accounts start with the phone number as their name: that's not a name to show. */
export const looksLikePhone = (name: string) => /^\+?\d[\d\s]{6,}$/.test(name.trim());

/** Downscale an image file to a small JPEG data URL (company logos). Browser only. */
export async function imageToDataUrl(file: File, maxSide = 160, quality = 0.85): Promise<string> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Use a JPEG, PNG or WebP image.");
  if (file.size > 5 * 1024 * 1024) throw new Error("Images must be under 5 MB.");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That image can't be read."));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("That image can't be read.");
    ctx.fillStyle = "#ffffff"; // transparent PNGs become white, not black, as JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}
