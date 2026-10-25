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
