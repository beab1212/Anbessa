// Kafka event → notification. One handler per topic; events use the shared envelope
// { eventId, version, at, ...payload } (architecture §8).
//
// Trip and payment notifications (workflows 05, 07, 08, 10) get handlers here when
// trip-service and payment-service start publishing those events.

import type { Notifier } from "./notifier.js";
import { driverActivatedPush, inviteSms } from "./templates.js";

export interface EventEnvelope {
  eventId: string;
  version: number;
  at: string;
  [key: string]: unknown;
}

export type Handler = (event: EventEnvelope) => Promise<unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

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
  };
}
