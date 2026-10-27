// Workflow 15 on the web: pricing-service zones, fare changes and promos (/api/pricing), and
// notification-service campaigns (/api/notifications). Types mirror services/pricing-service/docs/api.md
// and services/notification-service/docs/api.md. Every call is checked again by the service.

import type { Permission, Principal } from "@ride-app/shared-authz";
import type { LatLng } from "@ride-app/shared-location";
import { api, newIdempotencyKey } from "./api";
import { CITIES } from "./format";
import { inAnyCity } from "./money";

type Tone = "amber" | "blue" | "green" | "red" | "grey";

// ── zones ─────────────────────────────────────────────────────────────────────

export const ZONE_KINDS = ["SERVICE_AREA", "NO_PICKUP", "AIRPORT", "SURGE"] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];
export const ZONE_LABEL: Record<ZoneKind, string> = { SERVICE_AREA: "Service area", NO_PICKUP: "No pickups", AIRPORT: "Airport fee", SURGE: "Surge" };
export const ZONE_HINT: Record<ZoneKind, string> = {
  SERVICE_AREA: "When a city has service areas, pickups outside all of them are refused.",
  NO_PICKUP: "Pickups inside are refused; the app asks the rider to move the pin.",
  AIRPORT: "A fixed fee is added when the pickup or the drop-off is inside.",
  SURGE: "Fares of pickups inside are multiplied (at most 3×).",
};
/** Map colours per kind (fill and outline). */
export const ZONE_COLOR: Record<ZoneKind, string> = { SERVICE_AREA: "#16a34a", NO_PICKUP: "#dc2626", AIRPORT: "#2563eb", SURGE: "#d97706" };

/** One closed ring of [lng, lat] (GeoJSON order). */
export type Ring = [number, number][];

export interface Zone {
  id: string;
  cityId: string;
  name: string;
  kind: ZoneKind;
  polygon: Ring;
  feeMinor: number;
  surgeMultiplier: number;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ZoneInput {
  name: string;
  kind: ZoneKind;
  polygon: Ring;
  feeMinor?: number;
  surgeMultiplier?: number;
}

export const toRing = (points: LatLng[]): Ring => points.map((p) => [p.lng, p.lat]);
/** The editable points of a stored ring (without the closing point). */
export const fromRing = (ring: Ring): LatLng[] => {
  const pts = ring.map(([lng, lat]) => ({ lat, lng }));
  const first = pts[0];
  const last = pts.at(-1);
  return first && last && pts.length > 1 && first.lat === last.lat && first.lng === last.lng ? pts.slice(0, -1) : pts;
};

export const zonesApi = {
  list: (cityId: string, includeArchived = false) => api<{ zones: Zone[] }>("staff", `/api/pricing/zones?cityId=${cityId}${includeArchived ? "&includeArchived=true" : ""}`).then((r) => r.zones),
  check: (cityId: string, polygon: Ring) => api<{ valid: true; points: number } | { valid: false; problem: string; message: string }>("staff", "/api/pricing/zones/check", { body: { cityId, polygon } }),
  create: (cityId: string, input: ZoneInput) => api<{ zone: Zone }>("staff", "/api/pricing/zones", { body: { cityId, ...input }, idempotencyKey: newIdempotencyKey() }).then((r) => r.zone),
  update: (id: string, version: number, input: ZoneInput) => api<{ zone: Zone }>("staff", `/api/pricing/zones/${id}`, { method: "PUT", body: { ...input, version } }).then((r) => r.zone),
  archive: (id: string) => api<{ zone: Zone }>("staff", `/api/pricing/zones/${id}`, { method: "DELETE" }).then((r) => r.zone),
};

// ── fares ─────────────────────────────────────────────────────────────────────

export interface FareCard {
  baseMinor: number;
  perKmMinor: number;
  perMinMinor: number;
  minFareMinor: number;
  waitingPerMinMinor: number;
}
export const FARE_PARTS: [keyof FareCard, string][] = [
  ["baseMinor", "Base fare"], ["perKmMinor", "Per km"], ["perMinMinor", "Per minute"], ["minFareMinor", "Minimum fare"], ["waitingPerMinMinor", "Waiting, per minute"],
];

export interface FareRuleVersion {
  id: string;
  cityId: string;
  vehicleType: string;
  card: FareCard;
  validFrom: string;
  changeRequestId: string;
  proposedBy: string;
  approvedBy: string;
  activatedAt: string | null;
}

export interface FareOverview {
  cityId: string;
  minNoticeHours: number;
  pendingChanges: number;
  fares: {
    vehicleType: string;
    offered: boolean;
    current: (FareCard & { source: "RULE" | "SETTINGS"; ruleId: string | null; validFrom: string | null }) | null;
    scheduled: FareRuleVersion[];
    past: FareRuleVersion[];
  }[];
}

export interface Impact {
  current: FareCard;
  proposed: FareCard;
  averageChangePct: number;
  samples: { label: string; beforeMinor: number; afterMinor: number; deltaMinor: number; deltaPct: number }[];
}

export type FareChangeStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "EXPIRED";
export interface FareChange {
  id: string;
  cityId: string;
  vehicleType: string;
  card: FareCard;
  validFrom: string | null;
  emergency: boolean;
  reason: string;
  impact: Impact;
  status: FareChangeStatus;
  /** APPROVED splits into SCHEDULED (not yet in force) and APPROVED */
  phase: FareChangeStatus | "SCHEDULED";
  makerId: string;
  checkerId: string | null;
  decisionReason: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
  ruleId: string | null;
}

export const FARE_CHANGE_LABEL: Record<FareChange["phase"], string> = {
  PENDING: "waiting for approval", SCHEDULED: "approved, scheduled", APPROVED: "in force or replaced", REJECTED: "rejected", CANCELLED: "withdrawn", EXPIRED: "expired",
};
export const fareChangeTone = (phase: FareChange["phase"]): Tone =>
  phase === "PENDING" ? "amber" : phase === "SCHEDULED" ? "blue" : phase === "APPROVED" ? "green" : phase === "REJECTED" ? "red" : "grey";

export const faresApi = {
  overview: (cityId: string) => api<FareOverview>("staff", `/api/pricing/fare-rules?cityId=${cityId}`),
  changes: (cityId: string, status?: FareChangeStatus) => api<{ changes: FareChange[]; next: string | null }>("staff", `/api/pricing/fare-changes?cityId=${cityId}${status ? `&status=${status}` : ""}&limit=50`).then((r) => r.changes),
  preview: (cityId: string, vehicleType: string, card: FareCard) => api<{ source: "RULE" | "SETTINGS"; impact: Impact }>("staff", "/api/pricing/fare-changes/preview", { body: { cityId, vehicleType, ...card } }),
  propose: (input: { cityId: string; vehicleType: string; card: FareCard; validFrom: string | null; emergency: boolean; reason: string }) =>
    api<{ change: FareChange }>("staff", "/api/pricing/fare-changes", {
      body: { cityId: input.cityId, vehicleType: input.vehicleType, ...input.card, validFrom: input.validFrom, emergency: input.emergency, reason: input.reason },
      idempotencyKey: newIdempotencyKey(),
    }).then((r) => r.change),
  approve: (id: string, reason?: string) => api<{ change: FareChange }>("staff", `/api/pricing/fare-changes/${id}/approve`, { body: reason ? { reason } : {} }).then((r) => r.change),
  reject: (id: string, reason: string) => api<{ change: FareChange }>("staff", `/api/pricing/fare-changes/${id}/reject`, { body: { reason } }).then((r) => r.change),
  cancel: (id: string) => api<{ change: FareChange }>("staff", `/api/pricing/fare-changes/${id}/cancel`, { body: {} }).then((r) => r.change),
};

/** Earliest non-emergency start: 24 h from now, as a datetime-local value (Addis time is the browser's here). */
export function earliestValidFrom(hours: number, now = Date.now()): string {
  const d = new Date(now + hours * 3_600_000 + 5 * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── promos ────────────────────────────────────────────────────────────────────

export type PromoStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "EXHAUSTED" | "EXPIRED" | "ARCHIVED";
export const PROMO_STATUSES: PromoStatus[] = ["DRAFT", "ACTIVE", "PAUSED", "EXHAUSTED", "EXPIRED", "ARCHIVED"];
export const PROMO_LABEL: Record<PromoStatus, string> = { DRAFT: "draft", ACTIVE: "active", PAUSED: "paused", EXHAUSTED: "used up", EXPIRED: "ended", ARCHIVED: "archived" };
export const promoTone = (s: PromoStatus): Tone => (s === "ACTIVE" ? "green" : s === "DRAFT" ? "amber" : s === "PAUSED" ? "blue" : s === "EXHAUSTED" ? "red" : "grey");

export interface Promo {
  id: string;
  code: string;
  name: string;
  description: string | null;
  type: "PERCENT_OFF" | "AMOUNT_OFF";
  percentOff: number | null;
  amountOffMinor: number | null;
  maxDiscountMinor: number | null;
  cityIds: string[];
  vehicleTypes: string[];
  startsAt: string;
  endsAt: string;
  perUserLimit: number;
  maxRedemptions: number | null;
  budgetMinor: number;
  spentMinor: number;
  redemptionCount: number;
  /** promised on booked trips, not yet redeemed */
  bookedMinor: number;
  bookedCount: number;
  fundedBy: "PLATFORM" | "PARTNER";
  status: PromoStatus;
  needsFinanceApproval?: boolean;
  createdBy: string;
  activatedBy: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PromoInput = Pick<Promo, "code" | "name" | "description" | "type" | "percentOff" | "amountOffMinor" | "maxDiscountMinor" | "cityIds" | "vehicleTypes" | "startsAt" | "endsAt" | "perUserLimit" | "maxRedemptions" | "budgetMinor" | "fundedBy">;

export interface Redemption { id: string; tripId: string; userId: string; cityId: string; fareMinor: number; discountMinor: number; redeemedAt: string }

export const promosApi = {
  list: (q: { cityId?: string; status?: PromoStatus }) =>
    api<{ promos: Promo[]; approvalThresholdMinor: number }>("staff", `/api/pricing/promos?limit=200${q.cityId ? `&cityId=${q.cityId}` : ""}${q.status ? `&status=${q.status}` : ""}`),
  get: (id: string) => api<{ promo: Promo }>("staff", `/api/pricing/promos/${id}`).then((r) => r.promo),
  create: (input: PromoInput) => api<{ promo: Promo }>("staff", "/api/pricing/promos", { body: input, idempotencyKey: newIdempotencyKey() }).then((r) => r.promo),
  update: (id: string, input: PromoInput) => api<{ promo: Promo }>("staff", `/api/pricing/promos/${id}`, { method: "PUT", body: input }).then((r) => r.promo),
  act: (id: string, action: "activate" | "pause" | "resume" | "archive") => api<{ promo: Promo }>("staff", `/api/pricing/promos/${id}/${action}`, { body: {} }).then((r) => r.promo),
  redemptions: (id: string) => api<{ redemptions: Redemption[]; next: string | null }>("staff", `/api/pricing/promos/${id}/redemptions?limit=50`),
};

export function describePromo(p: Pick<Promo, "type" | "percentOff" | "amountOffMinor" | "maxDiscountMinor">, birr: (m: number) => string): string {
  if (p.type === "PERCENT_OFF") return `${p.percentOff}% off${p.maxDiscountMinor ? `, at most ${birr(p.maxDiscountMinor)}` : ""}`;
  return `${birr(p.amountOffMinor ?? 0)} off`;
}

/** Budget used, including discounts promised on trips not yet completed (0–1). */
export const budgetUse = (p: Pick<Promo, "budgetMinor" | "spentMinor" | "bookedMinor">) => (p.budgetMinor > 0 ? Math.min(1, (p.spentMinor + p.bookedMinor) / p.budgetMinor) : 0);

export const PROMO_CODE = /^[A-Za-z0-9_-]{3,32}$/;

// ── campaigns ─────────────────────────────────────────────────────────────────

export type CampaignStatus = "DRAFT" | "SCHEDULED" | "SENDING" | "SENT" | "CANCELLED";
export const CAMPAIGN_LABEL: Record<CampaignStatus, string> = { DRAFT: "draft", SCHEDULED: "scheduled", SENDING: "sending", SENT: "sent", CANCELLED: "cancelled" };
export const campaignTone = (s: CampaignStatus): Tone => (s === "SENT" ? "green" : s === "SENDING" ? "blue" : s === "SCHEDULED" || s === "DRAFT" ? "amber" : "grey");

export interface Campaign {
  id: string;
  cityId: string;
  audience: "RIDER" | "DRIVER";
  lastActiveDays: number | null;
  channel: "PUSH" | "SMS";
  title: string | null;
  body: string;
  status: CampaignStatus;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  targeted: number;
  counts: { pending: number; sent: number; skipped: number; failed: number };
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  /** detail only, before sending starts */
  audienceEstimate?: number | null;
  quietNow?: boolean;
}

export type CampaignInput = Pick<Campaign, "cityId" | "audience" | "lastActiveDays" | "channel" | "title" | "body">;
export const SMS_MAX = 300;

export const campaignsApi = {
  list: (cityId?: string) => api<{ campaigns: Campaign[]; quietHours: { from: number; to: number } }>("staff", `/api/notifications/campaigns?limit=100${cityId ? `&cityId=${cityId}` : ""}`),
  get: (id: string) => api<{ campaign: Campaign }>("staff", `/api/notifications/campaigns/${id}`).then((r) => r.campaign),
  audience: (q: { cityId: string; audience: "RIDER" | "DRIVER"; channel: "PUSH" | "SMS"; lastActiveDays: number | null }) =>
    api<{ count: number }>("staff", `/api/notifications/campaigns/audience?cityId=${q.cityId}&audience=${q.audience}&channel=${q.channel}${q.lastActiveDays ? `&lastActiveDays=${q.lastActiveDays}` : ""}`).then((r) => r.count),
  create: (input: CampaignInput) => api<{ campaign: Campaign }>("staff", "/api/notifications/campaigns", { body: input, idempotencyKey: newIdempotencyKey() }).then((r) => r.campaign),
  update: (id: string, input: CampaignInput) => api<{ campaign: Campaign }>("staff", `/api/notifications/campaigns/${id}`, { method: "PUT", body: input }).then((r) => r.campaign),
  schedule: (id: string, at?: string) => api<{ campaign: Campaign }>("staff", `/api/notifications/campaigns/${id}/schedule`, { body: at ? { at } : {} }).then((r) => r.campaign),
  cancel: (id: string) => api<{ campaign: Campaign }>("staff", `/api/notifications/campaigns/${id}/cancel`, { body: {} }).then((r) => r.campaign),
};

// ── who sees what (UI only; the services check again) ────────────────────────

export const PRICING_VIEWERS: Permission[] = ["pricing:propose", "pricing:approve"];
export const PROMO_VIEWERS: Permission[] = ["promo:manage", "incentive:approve"];

export const canSeeZones = (p: Principal | null) => inAnyCity(p, "zone:manage");
export const canSeePricing = (p: Principal | null) => PRICING_VIEWERS.some((perm) => inAnyCity(p, perm));
export const canSeePromos = (p: Principal | null) => PROMO_VIEWERS.some((perm) => inAnyCity(p, perm));
export const canSeeCampaigns = (p: Principal | null) => inAnyCity(p, "campaign:send");

export { CITIES };
