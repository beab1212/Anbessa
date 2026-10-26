// Kafka event → notification. One handler per topic; events use the shared envelope
// { eventId, version, at, ...payload } (architecture §8).
//
// Payment notifications (workflows 08–09) go to the rider or the owner-driver by push; a fleet
// company's balance messages are for the fleet portal, not a phone. Trip notifications
// (workflows 05, 07, 10) get handlers here when trip-service starts publishing them.

import type { Notifier } from "./notifier.js";
import {
  approvePaymentPush, balanceStatePush, driverActivatedPush, inviteSms, paymentDuePush, paymentFailedPush, payoutPush,
  receiptPush, refundPush, toppedUpPush,
} from "./templates.js";

export interface EventEnvelope {
  eventId: string;
  version: number;
  at: string;
  [key: string]: unknown;
}

export type Handler = (event: EventEnvelope) => Promise<unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : 0);

/** The person to tell about a balance: the owner-driver (fleet balances have no single phone). */
function balanceOwner(e: EventEnvelope): string | undefined {
  const b = e.beneficiary as { type?: string; id?: string } | undefined;
  return b?.type === "INDIVIDUAL" ? str(b.id) : undefined;
}

export function createHandlers(notifier: Notifier): Record<string, Handler> {
  return {
    // auth-service, Auth.md §17 I4: invitations by phone number
    "org.member_invited": async (e) => {
      const phone = str(e.phoneNumber);
      if (!phone) return; // invited by a real email address: nothing to send by SMS
      return notifier.sms(e.eventId, "org_invite", phone, inviteSms(str(e.orgName), str(e.role) ?? ""));
    },

    // auth-service: the driver role is granted when onboarding activates the driver
    "role.granted": async (e) => {
      const userId = str(e.userId);
      if (e.role !== "DRIVER" || !userId) return;
      return notifier.push(e.eventId, "driver_activated", userId, driverActivatedPush());
    },

    // payment-service (workflow 08): ask the rider to approve, receipts, failures, refunds
    "payment.action_required": async (e) => {
      const rider = str(e.riderId);
      if (!rider) return;
      return notifier.push(e.eventId, "payment_approve", rider, approvePaymentPush(num(e.amountMinor), str(e.provider) ?? "", str(e.purpose) ?? "", str(e.checkoutUrl) ?? null, str(e.tripId)));
    },
    "trip.settled": async (e) => {
      const rider = str(e.riderId);
      if (!rider) return;
      return notifier.push(e.eventId, "trip_receipt", rider, receiptPush(num(e.fareMinor), str(e.paymentMethod) ?? "", str(e.purpose) ?? "", str(e.tripId) ?? ""));
    },
    "payment.failed": async (e) => {
      const rider = str(e.riderId);
      if (!rider) return;
      return notifier.push(e.eventId, "payment_failed", rider, paymentFailedPush(num(e.amountMinor), e.final === true, str(e.tripId)));
    },
    "refund.succeeded": async (e) => {
      const rider = str(e.riderId);
      if (!rider) return;
      return notifier.push(e.eventId, "refund_sent", rider, refundPush(num(e.amountMinor)));
    },

    // payment-service (workflow 09): the owner-driver's balance
    "balance.state_changed": async (e) => {
      const owner = balanceOwner(e);
      if (!owner) return;
      return notifier.push(e.eventId, "balance_state", owner, balanceStatePush(str(e.state) ?? "", num(e.balanceMinor)));
    },
    "balance.topped_up": async (e) => {
      const owner = balanceOwner(e);
      if (!owner) return;
      return notifier.push(e.eventId, "balance_topped_up", owner, toppedUpPush(num(e.amountMinor), num(e.balanceMinor)));
    },
    "balance.payment_due": async (e) => {
      const owner = balanceOwner(e);
      if (!owner || !str(e.dueAt)) return;
      return notifier.push(e.eventId, "payment_due", owner, paymentDuePush(num(e.amountMinor), num(e.minimumMinor), str(e.dueAt)!));
    },
    "payout.sent": async (e) => {
      const owner = balanceOwner(e);
      if (!owner) return;
      return notifier.push(e.eventId, "payout_sent", owner, payoutPush(true, num(e.amountMinor), str(e.provider) ?? ""));
    },
    "payout.failed": async (e) => {
      const owner = balanceOwner(e);
      if (!owner) return;
      return notifier.push(e.eventId, "payout_failed", owner, payoutPush(false, num(e.amountMinor), str(e.provider) ?? ""));
    },
  };
}
