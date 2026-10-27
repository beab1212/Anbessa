// Kafka event → notification. One handler per topic; events use the shared envelope
// { eventId, version, at, ...payload } (architecture §8).
//
// Payment notifications (workflows 08–09) go to the rider or the owner-driver by push; a fleet
// company's balance messages are for the fleet portal, not a phone. Scheduled rides (workflow 12),
// reassignment and SOS (workflow 14) push to the people concerned. Other trip notifications
// (workflows 05, 07, 10) get handlers here when trip-service starts publishing them.
//
// The notifier dedupes on eventId:channel, so an event that tells several people uses
// `<eventId>:<userId>` per recipient (still stable across redeliveries).

import type { Notifier } from "./notifier.js";
import type { PushMessage } from "../channels/push.js";
import {
  approvePaymentPush, balanceStatePush, dispatchEscalatedPush, driverActivatedPush, inviteSms, paymentDuePush, paymentFailedPush, payoutPush,
  reassignedDriverPush, reassignedRiderPush, receiptPush, refundPush, scheduleCancelledPush, scheduledPush, scheduleFailedPush,
  sosAcknowledgedPush, sosResolvedPush, sosTriggeredPush, toppedUpPush,
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
  /** One push per distinct user, each deduped on its own key. */
  async function pushEach(e: EventEnvelope, template: string, messages: [string | undefined, PushMessage][]) {
    const seen = new Set<string>();
    const out = [];
    for (const [userId, message] of messages) {
      if (!userId || seen.has(userId)) continue;
      seen.add(userId);
      out.push(await notifier.push(`${e.eventId}:${userId}`, template, userId, message));
    }
    return out;
  }

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
      return notifier.push(e.eventId, "trip_receipt", rider, receiptPush(num(e.fareMinor), str(e.paymentMethod) ?? "", str(e.purpose) ?? "", str(e.tripId) ?? "", num(e.promoDiscountMinor)));
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

    // trip-service (workflow 12): scheduled rides. The rider and, for phone / company bookings, the booker.
    "trip.scheduled": async (e) => {
      const id = str(e.scheduledTripId);
      const at = str(e.scheduledFor);
      const rider = str(e.riderId);
      const booker = str(e.bookedById);
      if (!id || !at) return;
      const updated = e.updated === true;
      return pushEach(e, updated ? "scheduled_updated" : "scheduled_booked", [
        [rider, scheduledPush(id, at, { updated, for: booker && booker !== rider ? "rider" : "self" })],
        [booker, scheduledPush(id, at, { updated, for: "booker" })],
      ]);
    },
    "trip.schedule_cancelled": async (e) => {
      const id = str(e.scheduledTripId);
      const at = str(e.scheduledFor);
      if (!id || !at) return;
      const msg = scheduleCancelledPush(id, at, str(e.by) ?? "");
      // whoever cancelled it already knows
      const to = [str(e.riderId), str(e.bookedById)].filter((u) => u !== str(e.byUserId));
      return pushEach(e, "scheduled_cancelled", to.map((u) => [u, msg]));
    },
    "trip.schedule_failed": async (e) => {
      const id = str(e.scheduledTripId);
      const at = str(e.scheduledFor);
      if (!id || !at) return;
      const msg = scheduleFailedPush(id, at, str(e.reason) ?? "");
      return pushEach(e, "scheduled_failed", [[str(e.riderId), msg], [str(e.bookedById), msg]]);
    },
    "trip.dispatch_escalated": async (e) => {
      const rider = str(e.riderId);
      const tripId = str(e.tripId);
      if (!rider || !tripId) return;
      return notifier.push(e.eventId, "scheduled_escalated", rider, dispatchEscalatedPush(tripId, str(e.scheduledFor) ?? ""));
    },

    // trip-service: a dispatcher took a matched trip from its driver (to another driver, or back to matching)
    "trip.reassigned": async (e) => {
      const tripId = str(e.tripId);
      if (!tripId) return;
      return pushEach(e, "trip_reassigned", [
        [str(e.riderId), reassignedRiderPush(tripId, !!str(e.toDriverId))],
        [str(e.fromDriverId), reassignedDriverPush(tripId)],
      ]);
    },

    // support-service (workflow 14): only the person who pressed SOS; app alerts only (SYSTEM alerts have no presser to reassure)
    "sos.triggered": async (e) => {
      const user = str(e.userId);
      const alertId = str(e.alertId);
      if (!user || !alertId || e.source === "SYSTEM") return;
      return notifier.push(e.eventId, "sos_triggered", user, sosTriggeredPush(alertId, str(e.tripId) ?? ""));
    },
    "sos.acknowledged": async (e) => {
      const user = str(e.userId);
      const alertId = str(e.alertId);
      if (!user || !alertId) return;
      return notifier.push(e.eventId, "sos_acknowledged", user, sosAcknowledgedPush(alertId, str(e.tripId) ?? ""));
    },
    "sos.resolved": async (e) => {
      const user = str(e.userId);
      const alertId = str(e.alertId);
      if (!user || !alertId) return;
      return notifier.push(e.eventId, "sos_resolved", user, sosResolvedPush(alertId, str(e.tripId) ?? "", str(e.outcome) ?? ""));
    },
  };
}
