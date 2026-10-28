import { describe, expect, it } from "vitest";
import { createHandlers } from "../../src/notify/handlers.js";
import type { Notifier } from "../../src/notify/notifier.js";
import { payoutMethodChangedPush, payoutMethodChangedSms } from "../../src/notify/templates.js";

const RESUME = "2026-11-03T11:30:00.000Z"; // 14:30 in Addis Ababa

/** A notifier that dedupes on eventId:channel like the real one. */
function fakeNotifier() {
  const seen = new Set<string>();
  const sms: { to: string; body: string }[] = [];
  const pushes: { userId: string; body: string }[] = [];
  const n = {
    async sms(eventId: string, _t: string, to: string, body: string) {
      if (seen.has(`${eventId}:SMS`)) return "SENT";
      seen.add(`${eventId}:SMS`);
      sms.push({ to, body });
      return "SENT";
    },
    async push(eventId: string, _t: string, userId: string, m: { body: string }) {
      if (seen.has(`${eventId}:PUSH`)) return "SENT";
      seen.add(`${eventId}:PUSH`);
      pushes.push({ userId, body: m.body });
      return "SENT";
    },
  } as unknown as Notifier;
  return { n, sms, pushes };
}

const event = (over: object = {}) => ({
  eventId: "e1", version: 1, at: "2026-11-02T11:30:00.000Z",
  accountId: "a1", beneficiary: { type: "INDIVIDUAL", id: "u1" }, provider: "telebirr",
  destinationMasked: "•••1234", previousProvider: "telebirr", previousDestinationMasked: "•••9876",
  changedBy: "u1", changedAt: "2026-11-02T11:30:00.000Z", payoutsResumeAt: RESUME, ...over,
});

describe("payout_method.changed", () => {
  it("texts and pushes the owner once per event, with only the masked destination", async () => {
    const { n, sms, pushes } = fakeNotifier();
    const h = createHandlers(n, { contacts: { phoneOf: async (id) => (id === "u1" ? "+251911223344" : null) } });
    await h["payout_method.changed"]!(event());
    await h["payout_method.changed"]!(event()); // redelivery
    expect(sms).toEqual([{ to: "+251911223344", body: "Anbessa: Your payout account was changed to the account ending 1234. Payouts resume 3 Nov, 14:30. If this wasn't you, contact support." }]);
    expect(sms[0]!.body.length).toBeLessThanOrEqual(160);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ userId: "u1" });
    expect(pushes[0]!.body).toContain("ending 1234");
    expect(JSON.stringify([sms, pushes])).not.toContain("9876");
  });

  it("skips organisation balances and push-only without a phone", async () => {
    const { n, sms, pushes } = fakeNotifier();
    const h = createHandlers(n, { contacts: { phoneOf: async () => null } });
    await h["payout_method.changed"]!(event({ eventId: "e2", beneficiary: { type: "ORGANIZATION", id: "o1" } }));
    expect(pushes).toHaveLength(0);
    await h["payout_method.changed"]!(event({ eventId: "e3" }));
    expect(pushes).toHaveLength(1);
    expect(sms).toHaveLength(0);
  });

  it("has an Amharic version and never echoes a full number", () => {
    expect(payoutMethodChangedSms("•••1234", RESUME, "am")).toMatch(/^አንበሳ: .*1234/);
    expect(payoutMethodChangedPush("•••1234", RESUME, "am").title).toBe("የክፍያ መቀበያ ሂሳብ ተቀይሯል");
    expect(payoutMethodChangedSms("0911223344", RESUME)).not.toContain("0911223344");
    expect(payoutMethodChangedSms(undefined, "not a date")).toBe("Anbessa: Your payout account was changed to a new account. Payouts resume shortly. If this wasn't you, contact support.");
  });
});
