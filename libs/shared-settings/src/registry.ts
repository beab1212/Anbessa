// The platform's live settings (platform-service stores them; every service reads them through
// client.ts). Each definition says what the value is, its bounds and default, whether it can be
// set per city, and whether a change needs a second super admin (sensitive). The default here is
// what the platform did before the setting existed.

export type SettingType = "int" | "number" | "bool" | "string" | "enum" | "intList" | "enumList" | "money";

export interface SettingDef {
  key: string;
  group: SettingGroup;
  label: string;
  description: string;
  type: SettingType;
  default: unknown;
  min?: number;
  max?: number;
  /** for enum / enumList */
  options?: readonly string[];
  unit?: string;
  /** "city": a city may override the global value */
  scope: "global" | "city";
  /** changes need a second super admin (maker–checker) */
  sensitive?: boolean;
  /** the service that acts on it */
  owner: string;
}

export const SETTING_GROUPS = [
  "Matching",
  "Trip rules",
  "Cancellations and fees",
  "Fares",
  "Payments",
  "Sign-in and OTP",
  "Documents",
  "Apps and maintenance",
  "Feature flags",
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

const fare = (type: string, label: string, d: { base: number; perKm: number; perMin: number; min: number; waiting: number }): SettingDef[] => [
  { key: `fares.${type}.baseMinor`, label: `${label}: base fare`, default: d.base },
  { key: `fares.${type}.perKmMinor`, label: `${label}: per km`, default: d.perKm },
  { key: `fares.${type}.perMinMinor`, label: `${label}: per minute`, default: d.perMin },
  { key: `fares.${type}.minFareMinor`, label: `${label}: minimum fare`, default: d.min },
  { key: `fares.${type}.waitingPerMinMinor`, label: `${label}: waiting, per minute`, default: d.waiting },
].map((f) => ({
  ...f, group: "Fares" as const, type: "money" as const, min: 0, max: 1_000_000, scope: "city" as const, sensitive: true, owner: "pricing-service",
  description: "In santim (1 birr = 100). Quotes use the fares in force when they're made; a quote keeps its fare.",
}));

export const SETTINGS: readonly SettingDef[] = [
  // ── matching (workflow 05) ─────────────────────────────────────────────────
  { key: "match.timeoutSeconds", group: "Matching", label: "Give up finding a driver after", description: "The rider's request is cancelled (free) if no driver accepts in time.", type: "int", default: 120, min: 10, max: 600, unit: "s", scope: "global", owner: "trip-service" },
  { key: "match.offerSeconds", group: "Matching", label: "Time a driver has to accept", description: "Then the offer goes to the next driver.", type: "int", default: 15, min: 5, max: 60, unit: "s", scope: "global", owner: "trip-service" },
  { key: "match.radiiMeters", group: "Matching", label: "Search radius steps", description: "Drivers are searched within each radius in turn.", type: "intList", default: [2000, 4000, 6000], min: 100, max: 20_000, unit: "m", scope: "global", owner: "trip-service" },

  // ── trip rules (workflow 06) ────────────────────────────────────────────────
  { key: "trip.pinRequired", group: "Trip rules", label: "Driver must enter the rider's PIN to start", description: "Anti-fraud: the rider reads a 4-digit code to the driver.", type: "bool", default: true, scope: "global", sensitive: true, owner: "trip-service" },
  { key: "trip.arrivalRadiusMeters", group: "Trip rules", label: "Arrival radius", description: "The driver must be this close to the pickup to tap Arrived or start.", type: "int", default: 150, min: 30, max: 1000, unit: "m", scope: "city", owner: "trip-service" },
  { key: "trip.freeWaitingSeconds", group: "Trip rules", label: "Free waiting at the pickup", description: "Waiting after this is charged per started minute.", type: "int", default: 180, min: 0, max: 1800, unit: "s", scope: "city", owner: "trip-service" },
  { key: "trip.noShowAfterSeconds", group: "Trip rules", label: "Driver may report a no-show after", description: "Counted from arrival at the pickup.", type: "int", default: 300, min: 60, max: 3600, unit: "s", scope: "city", owner: "trip-service" },
  { key: "trip.completeFarFromDropoffMeters", group: "Trip rules", label: "Flag trips completed this far from the drop-off", description: "For review by support.", type: "int", default: 300, min: 50, max: 5000, unit: "m", scope: "city", owner: "trip-service" },
  { key: "quote.ttlSeconds", group: "Trip rules", label: "A quoted fare is valid for", description: "The rider must request within this time.", type: "int", default: 600, min: 60, max: 3600, unit: "s", scope: "global", owner: "trip-service" },

  // ── cancellations (workflow 07) ─────────────────────────────────────────────
  { key: "cancel.freeSeconds", group: "Cancellations and fees", label: "Free cancellation window", description: "After a driver accepts, the rider can cancel free for this long.", type: "int", default: 120, min: 0, max: 1800, unit: "s", scope: "city", owner: "trip-service" },
  { key: "cancel.feeMinor", group: "Cancellations and fees", label: "Cancellation fee", description: "In santim. Charged after the free window, or for a no-show.", type: "money", default: 3000, min: 0, max: 100_000, scope: "city", sensitive: true, owner: "trip-service" },
  { key: "cancel.driverShare", group: "Cancellations and fees", label: "Driver's share of the fee", description: "0 to 1. The rest stays with the platform.", type: "number", default: 0.8, min: 0, max: 1, scope: "city", sensitive: true, owner: "trip-service" },

  // ── fares (built-in quotes) ─────────────────────────────────────────────────
  ...fare("economy", "Economy", { base: 5000, perKm: 1500, perMin: 200, min: 8000, waiting: 300 }),
  ...fare("comfort", "Comfort", { base: 7000, perKm: 2000, perMin: 300, min: 11000, waiting: 400 }),
  ...fare("minivan", "Minivan", { base: 9000, perKm: 2500, perMin: 350, min: 14000, waiting: 500 }),

  // ── payments (workflow 08; commission and balance limits are finance's, in payment-service) ──
  { key: "payments.methods", group: "Payments", label: "Payment methods riders can choose", description: "Turning one off refuses new trip requests with it; trips already booked keep theirs.", type: "enumList", options: ["CASH", "MOBILE_MONEY", "CARD"], default: ["CASH", "MOBILE_MONEY", "CARD"], scope: "city", sensitive: true, owner: "trip-service" },
  { key: "payments.mobileMoneyProviders", group: "Payments", label: "Mobile money providers, in order", description: "The first one asks riders who haven't picked a provider. Only providers enabled in payment-service are used.", type: "enumList", options: ["telebirr", "cbebirr"], default: ["telebirr", "cbebirr"], scope: "global", owner: "payment-service" },
  { key: "payments.cardProvider", group: "Payments", label: "Card payments go through", description: "The card provider (hosted checkout).", type: "enum", options: ["chapa"], default: "chapa", scope: "global", owner: "payment-service" },

  // ── sign-in (Auth.md §9.7) ──────────────────────────────────────────────────
  { key: "otp.channels", group: "Sign-in and OTP", label: "Login code channels, in order", description: "Telegram first is cheaper; SMS reaches everyone.", type: "enumList", options: ["telegram", "sms"], default: ["telegram", "sms"], scope: "global", sensitive: true, owner: "notification-service" },
  { key: "otp.fallbackSeconds", group: "Sign-in and OTP", label: "Send by SMS if Telegram hasn't delivered after", description: "Shorter costs more SMS; longer keeps people waiting.", type: "int", default: 20, min: 5, max: 120, unit: "s", scope: "global", sensitive: true, owner: "notification-service" },

  // ── documents (workflow 02) ─────────────────────────────────────────────────
  { key: "documents.expiryWarningDays", group: "Documents", label: "Expiring soon means within", description: "Shown in the review queue and on vehicles.", type: "int", default: 30, min: 1, max: 90, unit: "days", scope: "global", owner: "fleet-service" },
  { key: "documents.reminderDays", group: "Documents", label: "Remind owners this many days before expiry", description: "One reminder per number.", type: "intList", default: [30, 7, 1], min: 1, max: 90, unit: "days", scope: "global", owner: "fleet-service" },

  // ── apps and maintenance ────────────────────────────────────────────────────
  { key: "maintenance.newTrips", group: "Apps and maintenance", label: "Pause new trip requests", description: "Trips in progress continue. Riders and the call center see the maintenance message.", type: "bool", default: false, scope: "global", sensitive: true, owner: "trip-service" },
  { key: "maintenance.message", group: "Apps and maintenance", label: "Maintenance message", description: "Shown in the apps and the web while new trips are paused.", type: "string", default: "Anbessa is briefly unavailable for maintenance. Please try again in a few minutes.", max: 300, scope: "global", sensitive: true, owner: "platform-service" },
  ...(["rider", "driver"] as const).flatMap((app) => (["android", "ios"] as const).map((os): SettingDef => ({
    key: `apps.minVersion.${app}.${os}`, group: "Apps and maintenance", label: `Minimum ${app} app version (${os === "ios" ? "iOS" : "Android"})`,
    description: "Older apps are asked to update before they can continue.", type: "string", default: "1.0.0", max: 20, scope: "global", sensitive: true, owner: "platform-service",
  }))),

  // ── feature flags ───────────────────────────────────────────────────────────
  { key: "features.phoneBooking", group: "Feature flags", label: "Call center can book by phone", description: "Off: trip-service refuses phone bookings and the page is hidden.", type: "bool", default: true, scope: "global", owner: "trip-service" },
  { key: "features.corporateBooking", group: "Feature flags", label: "Company accounts can book rides", description: "Off: company coordinators can't book; existing trips continue.", type: "bool", default: true, scope: "global", owner: "trip-service" },
  // phone-app modules built ahead of their services: the app hides them while these are off
  { key: "features.scheduledRides", group: "Feature flags", label: "Riders can schedule rides", description: "Phone app: the Scheduled rides screens. Turn on once trip scheduling is live.", type: "bool", default: false, scope: "global", owner: "platform-service" },
  { key: "features.sos", group: "Feature flags", label: "SOS button during trips", description: "Phone app: call the police and alert the safety team from an active trip.", type: "bool", default: false, scope: "global", sensitive: true, owner: "platform-service" },
  { key: "features.support", group: "Feature flags", label: "In-app support tickets", description: "Phone app: open and follow support tickets.", type: "bool", default: false, scope: "global", owner: "platform-service" },
  { key: "features.promos", group: "Feature flags", label: "Promo codes", description: "Phone app: redeem promo codes and apply them at the quote.", type: "bool", default: false, scope: "global", owner: "platform-service" },
  { key: "features.accountDeletion", group: "Feature flags", label: "Self-service account deletion", description: "Phone app: people can ask to delete their account from Account settings.", type: "bool", default: false, scope: "global", owner: "platform-service" },
];

const byKey = new Map(SETTINGS.map((d) => [d.key, d]));
export const settingDef = (key: string): SettingDef | undefined => byKey.get(key);

const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** The value, checked against its definition; or the reason it's refused. */
export function validateSetting(key: string, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const d = byKey.get(key);
  if (!d) return { ok: false, error: `unknown setting ${key}` };
  const inRange = (n: number) => (d.min === undefined || n >= d.min) && (d.max === undefined || n <= d.max);
  const range = `${d.min ?? "−∞"}–${d.max ?? "∞"}${d.unit ? ` ${d.unit}` : ""}`;
  switch (d.type) {
    case "int":
    case "money":
      if (!Number.isInteger(value) || !inRange(value as number)) return { ok: false, error: `${d.label}: a whole number, ${range}` };
      return { ok: true, value };
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || !inRange(value)) return { ok: false, error: `${d.label}: a number, ${range}` };
      return { ok: true, value };
    case "bool":
      if (typeof value !== "boolean") return { ok: false, error: `${d.label}: on or off` };
      return { ok: true, value };
    case "string":
      if (typeof value !== "string" || value.length > (d.max ?? 500)) return { ok: false, error: `${d.label}: text up to ${d.max ?? 500} characters` };
      if (d.key.startsWith("apps.minVersion.") && !SEMVER.test(value)) return { ok: false, error: `${d.label}: a version like 1.4.0` };
      return { ok: true, value: value.trim() };
    case "enum":
      if (typeof value !== "string" || !d.options?.includes(value)) return { ok: false, error: `${d.label}: one of ${d.options?.join(", ")}` };
      return { ok: true, value };
    case "intList":
      if (!Array.isArray(value) || value.length === 0 || value.length > 10 || !value.every((n) => Number.isInteger(n) && inRange(n))) return { ok: false, error: `${d.label}: 1–10 whole numbers, each ${range}` };
      return { ok: true, value };
    case "enumList":
      if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length || !value.every((v) => d.options?.includes(v))) return { ok: false, error: `${d.label}: one or more of ${d.options?.join(", ")}, no repeats` };
      return { ok: true, value };
  }
}
