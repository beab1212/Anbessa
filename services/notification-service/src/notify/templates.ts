// Message templates (English for v1). Pure functions, so they're easy to test and review.
// Keep them short: SMS over 160 GSM characters costs two messages.

import type { PushMessage } from "../channels/push.js";

const ROLE_INVITE: Record<string, string> = {
  fleet_driver: "to drive with them",
  employee: "to ride on their company account",
  corporate_coordinator: "as a booking coordinator",
  corporate_admin: "as an account admin",
};

const ORG_NAME_MAX = 40;

/**
 * An organisation name made safe to quote inside an SMS. Org names are chosen by
 * whoever registers the org, so they must not be able to pass for Anbessa's own
 * words or carry a phishing payload: links, domains and phone/account numbers are
 * stripped, quotes and control characters removed, and the result truncated.
 */
export function safeOrgName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .normalize("NFKC")
    // control / bidi characters (Unicode Cc, plus zero-width and direction overrides)
    .replace(/[\p{Cc}\u200b-\u200f\u2028-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S*/gi, " ") // URLs
    .replace(/\S+\.[a-z]{2,}(?:\/\S*)?/gi, " ") // bare domains: evil.com, bit.ly/x
    .replace(/\+?\d[\d\s().-]{2,}\d/g, " ") // digit runs of 4+ (phone, account and code numbers)
    .replace(/["'`\u2018-\u201f<>]/g, "") // quotes, so the name can't close ours
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > ORG_NAME_MAX ? `${cleaned.slice(0, ORG_NAME_MAX - 1).trimEnd()}…` : cleaned;
}

/** org.member_invited → SMS to the invited phone (workflow 03, step 10). Anbessa's fixed text
 *  comes first and the org name is only ever quoted, never the opening words. */
export function inviteSms(orgName: string | undefined, role: string): string {
  const name = safeOrgName(orgName);
  const who = name ? `"${name}"` : "a company";
  return `Anbessa: ${who} invited you ${ROLE_INVITE[role] ?? "to join them"}. Accept in the Anbessa app. Ignore if unexpected.`;
}

/** role.granted DRIVER → push (workflow 02, driver activated). */
export function driverActivatedPush(): PushMessage {
  return {
    title: "You're approved to drive",
    body: "Your Anbessa driver account is active. Go online whenever you're ready.",
    data: { type: "driver.activated" },
  };
}

// ── payments (workflows 08–09) ────────────────────────────────────────────────

const etb = (minor: number) => `${(minor / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })} ETB`;
const PROVIDER: Record<string, string> = { telebirr: "telebirr", cbebirr: "CBE Birr", chapa: "the payment page" };
const METHOD: Record<string, string> = { CASH: "cash", MOBILE_MONEY: "mobile money", CARD: "card", CORPORATE: "company account" };

/** payment.action_required → push to the rider: approve with the provider. */
export function approvePaymentPush(amountMinor: number, provider: string, purpose: string, checkoutUrl: string | null, tripId?: string): PushMessage {
  return {
    title: purpose === "CANCELLATION_FEE" ? "Approve the cancellation fee" : "Approve your trip payment",
    body: `Approve ${etb(amountMinor)} to Anbessa in ${PROVIDER[provider] ?? provider}.`,
    // tripId: the app opens that trip's pay screen when the notification is tapped
    data: { type: "payment.action_required", ...(tripId ? { tripId } : {}), ...(checkoutUrl ? { checkoutUrl } : {}) },
  };
}

/** trip.settled → push to the rider: the receipt (every payment method). fareMinor is the full fare;
 *  a promo discount comes off what the rider paid. */
export function receiptPush(fareMinor: number, method: string, purpose: string, tripId: string, promoDiscountMinor = 0): PushMessage {
  const discount = Math.min(Math.max(promoDiscountMinor, 0), fareMinor);
  const promo = discount > 0 ? ` (${etb(discount)} off with a promo code)` : "";
  return {
    title: purpose === "CANCELLATION_FEE" ? "Cancellation fee" : "Trip receipt",
    body: `${etb(fareMinor - discount)} paid by ${METHOD[method] ?? method.toLowerCase()}${promo}. Thanks for riding with Anbessa.`,
    data: { type: "trip.receipt", tripId },
  };
}

/** payment.failed → push to the rider. */
export function paymentFailedPush(amountMinor: number, final: boolean, tripId?: string): PushMessage {
  return {
    title: "Payment didn't go through",
    body: final
      ? `${etb(amountMinor)} is still owed for your trip. Pay it from your trips in the app.`
      : `We couldn't collect ${etb(amountMinor)}. We'll ask again shortly, or pay now from the app.`,
    data: { type: "payment.failed", ...(tripId ? { tripId } : {}) },
  };
}

/** balance.state_changed → push to an owner-driver (Payment.md §12.1–12.2). */
export function balanceStatePush(state: string, balanceMinor: number): PushMessage {
  const owe = balanceMinor < 0 ? `You owe ${etb(-balanceMinor)}.` : `Balance ${etb(balanceMinor)}.`;
  const body: Record<string, string> = {
    OK: `${owe} You can take every trip.`,
    WARNING: `${owe} Pay soon to keep receiving cash trips.`,
    CASH_BLOCKED: `${owe} Cash trips are paused; card and mobile money trips continue and repay it.`,
    BLOCKED: `${owe} You can't go online until you pay. Top up in the app.`,
  };
  return { title: state === "OK" ? "You're all set" : "Your Anbessa balance", body: body[state] ?? owe, data: { type: "balance.state_changed", state } };
}

/** balance.topped_up → push. */
export function toppedUpPush(amountMinor: number, balanceMinor: number): PushMessage {
  return { title: "Payment received", body: `${etb(amountMinor)} added. Balance ${balanceMinor < 0 ? "−" : ""}${etb(Math.abs(balanceMinor))}.`, data: { type: "balance.topped_up" } };
}

/** balance.payment_due → push (Payment.md §12.4). */
export function paymentDuePush(amountMinor: number, minimumMinor: number, dueAt: string): PushMessage {
  const day = new Date(dueAt).toLocaleDateString("en-US", { weekday: "long", timeZone: "Africa/Addis_Ababa" });
  return { title: "Payment due", body: `You owe ${etb(amountMinor)}. Pay at least ${etb(minimumMinor)} by ${day} to keep driving.`, data: { type: "balance.payment_due" } };
}

/** payout.sent / payout.failed → push. */
export function payoutPush(sent: boolean, amountMinor: number, provider: string): PushMessage {
  return sent
    ? { title: "Earnings sent", body: `${etb(amountMinor)} is on its way to your ${PROVIDER[provider] ?? provider} account.`, data: { type: "payout.sent" } }
    : { title: "Payout failed", body: `We couldn't send ${etb(amountMinor)}. Check your payout details in the app; the money stays in your balance.`, data: { type: "payout.failed" } };
}

// ── payout method changed (account-takeover warning) ───────────────────────────

export type Lang = "en" | "am";

/** Only the last digits of the masked destination ("•••1234") ever go into the message; the
 *  English text says "ending 1234" so the SMS stays in the GSM alphabet (one segment). */
export function last4(destinationMasked: string | undefined): string | undefined {
  return destinationMasked?.match(/(\d{2,4})\s*$/)?.[1];
}
const accountEn = (masked: string | undefined) => (last4(masked) ? `the account ending ${last4(masked)}` : "a new account");
const accountAm = (masked: string | undefined) => (last4(masked) ? `በ${last4(masked)} የሚያልቅ ሂሳብ` : "አዲስ ሂሳብ");

/** "3 Nov, 14:30" in Addis Ababa time. */
function resumeTime(iso: string, lang: Lang): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return lang === "am" ? "ከጥቂት ጊዜ በኋላ" : "shortly";
  return d.toLocaleString(lang === "am" ? "am-ET" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Africa/Addis_Ababa" });
}

/** payout_method.changed → SMS to the balance owner. Fixed Anbessa text first; fits one SMS in English. */
export function payoutMethodChangedSms(destinationMasked: string | undefined, payoutsResumeAt: string, lang: Lang = "en"): string {
  const when = resumeTime(payoutsResumeAt, lang);
  return lang === "am"
    ? `አንበሳ: የክፍያ መቀበያ ሂሳብዎ ወደ ${accountAm(destinationMasked)} ተቀይሯል። ክፍያዎች ከ${when} ጀምሮ ይቀጥላሉ። ይህን ያላደረጉት እርስዎ ካልሆኑ ድጋፍን ያግኙ።`
    : `Anbessa: Your payout account was changed to ${accountEn(destinationMasked)}. Payouts resume ${when}. If this wasn't you, contact support.`;
}

/** payout_method.changed → push to the balance owner. */
export function payoutMethodChangedPush(destinationMasked: string | undefined, payoutsResumeAt: string, lang: Lang = "en"): PushMessage {
  const when = resumeTime(payoutsResumeAt, lang);
  return lang === "am"
    ? { title: "የክፍያ መቀበያ ሂሳብ ተቀይሯል", body: `የክፍያ መቀበያ ሂሳብዎ ወደ ${accountAm(destinationMasked)} ተቀይሯል። ክፍያዎች ከ${when} ጀምሮ ይቀጥላሉ። ይህን ያላደረጉት እርስዎ ካልሆኑ ድጋፍን ያግኙ።`, data: { type: "payout_method.changed" } }
    : { title: "Payout account changed", body: `Your payout account was changed to ${accountEn(destinationMasked)}. Payouts resume ${when}. If this wasn't you, contact support.`, data: { type: "payout_method.changed" } };
}

/** refund.succeeded → push to the rider. */
export function refundPush(amountMinor: number): PushMessage {
  return { title: "Refund sent", body: `${etb(amountMinor)} is on its way back to you.`, data: { type: "refund.succeeded" } };
}

// ── scheduled rides (workflow 12) ─────────────────────────────────────────────

/** "Tue 3 Nov, 14:30" in Addis Ababa time. */
export function addisTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "your booked time";
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Africa/Addis_Ababa" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Africa/Addis_Ababa" });
  return `${day}, ${time}`;
}

/** trip.scheduled → push to the rider and, when someone else booked it, the booker. */
export function scheduledPush(scheduledTripId: string, scheduledFor: string, opts: { updated: boolean; for: "self" | "rider" | "booker" }): PushMessage {
  const when = addisTime(scheduledFor);
  const body = opts.for === "booker"
    ? `The ride you booked is ${opts.updated ? "now " : ""}set for ${when}. We'll find a driver shortly before.`
    : opts.updated
      ? `Your ride is now booked for ${when}.`
      : opts.for === "rider"
        ? `A ride has been booked for you for ${when}. We'll find your driver shortly before.`
        : `Your ride is booked for ${when}. We'll find your driver shortly before.`;
  return { title: opts.updated ? "Scheduled ride updated" : "Ride booked", body, data: { type: "trip.scheduled", scheduledTripId } };
}

/** trip.schedule_cancelled → push to the rider and booker who didn't cancel it themselves. */
export function scheduleCancelledPush(scheduledTripId: string, scheduledFor: string, by: string): PushMessage {
  const who = by === "STAFF" ? " by Anbessa support" : "";
  return { title: "Scheduled ride cancelled", body: `Your ride for ${addisTime(scheduledFor)} was cancelled${who}. You haven't been charged.`, data: { type: "trip.schedule_cancelled", scheduledTripId } };
}

/** trip.schedule_failed → push to the rider and booker: the trip couldn't be created by the pickup time. */
export function scheduleFailedPush(scheduledTripId: string, scheduledFor: string, reason: string): PushMessage {
  const why = reason === "RIDER_HAS_ACTIVE_TRIP" ? " because you were still on another trip" : "";
  return {
    title: "Your scheduled ride couldn't start",
    body: `Your ride for ${addisTime(scheduledFor)} couldn't start${why}. Request a ride now if you still need one.`,
    data: { type: "trip.schedule_failed", scheduledTripId },
  };
}

/** trip.dispatch_escalated → push to the rider: the scheduled trip is still unmatched near pickup. */
export function dispatchEscalatedPush(tripId: string, scheduledFor: string): PushMessage {
  return {
    title: "Still finding your driver",
    body: `Drivers are busy near your pickup for your ${addisTime(scheduledFor)} ride. Our dispatch team is on it.`,
    data: { type: "trip.dispatch_escalated", tripId },
  };
}

// ── reassignment (trip:reassign) ──────────────────────────────────────────────

/** trip.reassigned → push to the rider. */
export function reassignedRiderPush(tripId: string, newDriver: boolean): PushMessage {
  return newDriver
    ? { title: "Your driver changed", body: "A new driver is on the way. Check the app for their car and arrival time.", data: { type: "trip.reassigned", tripId } }
    : { title: "Finding you a new driver", body: "Your driver can no longer make it. We're finding you another one.", data: { type: "trip.reassigned", tripId } };
}

/** trip.reassigned → push to the driver the trip was taken from. */
export function reassignedDriverPush(tripId: string): PushMessage {
  return { title: "Trip reassigned", body: "Dispatch moved this trip to another driver. You can take new requests.", data: { type: "trip.reassigned_away", tripId } };
}

// ── SOS (workflow 14) ─────────────────────────────────────────────────────────
// Only the person who pressed SOS is told: never the other party on the trip (it could put them
// at risk). SMS to emergency contacts needs a contact store that doesn't exist yet.

/** sos.triggered → push to whoever pressed SOS (not for SYSTEM alerts). */
export function sosTriggeredPush(alertId: string, tripId: string): PushMessage {
  return { title: "SOS received", body: "Our safety team has your alert and location. If you are in danger, call 991 now.", data: { type: "sos.triggered", alertId, tripId } };
}

/** sos.acknowledged → push to whoever pressed SOS. */
export function sosAcknowledgedPush(alertId: string, tripId: string): PushMessage {
  return { title: "Safety team responding", body: "An Anbessa safety agent is handling your alert and may call you. Call 991 if you are in danger.", data: { type: "sos.acknowledged", alertId, tripId } };
}

/** sos.resolved → push to whoever pressed SOS. */
export function sosResolvedPush(alertId: string, tripId: string, outcome: string): PushMessage {
  const body = outcome === "ESCALATED"
    ? "Your alert was passed to our safety investigations team. We'll follow up with you."
    : "Your alert is closed. If you still need help, contact support in the app or call 991.";
  return { title: "SOS alert closed", body, data: { type: "sos.resolved", alertId, tripId } };
}
