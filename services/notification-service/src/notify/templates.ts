// Message templates (English for v1). Pure functions, so they're easy to test and review.
// Keep them short: SMS over 160 GSM characters costs two messages.

import type { PushMessage } from "../channels/push.js";

const ROLE_INVITE: Record<string, string> = {
  fleet_driver: "to drive with them",
  employee: "to ride on their company account",
  corporate_coordinator: "as a booking coordinator",
  corporate_admin: "as an account admin",
};

/** org.member_invited → SMS to the invited phone (workflow 03, step 10). */
export function inviteSms(orgName: string | undefined, role: string): string {
  const who = orgName?.trim() ? orgName.trim().slice(0, 60) : "A company";
  return `${who} invites you ${ROLE_INVITE[role] ?? "to join them"} on Anbessa. Open the Anbessa app to accept.`;
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
export function approvePaymentPush(amountMinor: number, provider: string, purpose: string, checkoutUrl: string | null): PushMessage {
  return {
    title: purpose === "CANCELLATION_FEE" ? "Approve the cancellation fee" : "Approve your trip payment",
    body: `Approve ${etb(amountMinor)} to Anbessa in ${PROVIDER[provider] ?? provider}.`,
    data: { type: "payment.action_required", ...(checkoutUrl ? { checkoutUrl } : {}) },
  };
}

/** trip.settled → push to the rider: the receipt (every payment method). */
export function receiptPush(fareMinor: number, method: string, purpose: string, tripId: string): PushMessage {
  return {
    title: purpose === "CANCELLATION_FEE" ? "Cancellation fee" : "Trip receipt",
    body: `${etb(fareMinor)} paid by ${METHOD[method] ?? method.toLowerCase()}. Thanks for riding with Anbessa.`,
    data: { type: "trip.receipt", tripId },
  };
}

/** payment.failed → push to the rider. */
export function paymentFailedPush(amountMinor: number, final: boolean): PushMessage {
  return {
    title: "Payment didn't go through",
    body: final
      ? `${etb(amountMinor)} is still owed for your trip. Pay it from your trips in the app.`
      : `We couldn't collect ${etb(amountMinor)}. We'll ask again shortly, or pay now from the app.`,
    data: { type: "payment.failed" },
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

/** refund.succeeded → push to the rider. */
export function refundPush(amountMinor: number): PushMessage {
  return { title: "Refund sent", body: `${etb(amountMinor)} is on its way back to you.`, data: { type: "refund.succeeded" } };
}
