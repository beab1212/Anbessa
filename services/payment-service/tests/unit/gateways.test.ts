import { describe, expect, it } from "vitest";
import pino from "pino";
import { createGateways, makeReference, parseReference, WebhookRejected, type Provider } from "../../src/gateways/index.js";
import { simStore } from "../../src/gateways/simulator.js";

const SECRETS: Record<Provider, string> = { telebirr: "t".repeat(40), cbebirr: "c".repeat(40), chapa: "h".repeat(40) };

function setup(autoApproveMs = 0) {
  const delivered: { url: string; body: string; headers: Record<string, string> }[] = [];
  const g = createGateways(
    { providers: ["telebirr", "cbebirr", "chapa"], secrets: SECRETS, checkoutBaseUrl: "http://pay.test", autoApproveMs, payoutDelayMs: 5, dropRate: 0 },
    { store: simStore(), deliver: async (url, body, headers) => (delivered.push({ url, body, headers }), 200), logger: pino({ level: "silent" }) },
  );
  return { g, delivered };
}

describe("references", () => {
  it("round-trip, with the attempt for retried charges", () => {
    const id = "0199a3c4-1111-7222-8333-444455556666";
    expect(parseReference(makeReference("payment", id))).toEqual({ kind: "payment", id, attempt: 1 });
    expect(parseReference(makeReference("payment", id, 3))).toEqual({ kind: "payment", id, attempt: 3 });
    expect(parseReference(makeReference("payout", id))?.kind).toBe("payout");
    expect(parseReference("ANBX123")).toBeNull();
  });
});

describe.each(["telebirr", "cbebirr", "chapa"] as const)("%s (simulated)", (provider) => {
  it("a decided charge calls back in the provider's format, and the adapter reads it", async () => {
    const { g, delivered } = setup();
    const gw = g.get(provider);
    const reference = makeReference("payment", crypto.randomUUID());
    const started = await gw.charge({ reference, amountMinor: 40_000, currency: "ETB", description: "trip", notifyUrl: `http://pay.test/hook/${provider}` });
    expect(started.checkoutUrl).toBe(`http://pay.test/api/payments/sim/checkout/${started.providerRef}`);

    await g.simulator.decide(started.providerRef, "SUCCEEDED");
    expect(delivered).toHaveLength(1);
    const notice = gw.parseWebhook(delivered[0]!.body, delivered[0]!.headers);
    expect(notice).toMatchObject({ kind: "charge", reference, providerRef: started.providerRef, status: "SUCCEEDED", amountMinor: 40_000 });
    expect(notice.providerTxnId).toBeTruthy();

    // reconciliation sees the same outcome
    expect(await gw.query("charge", reference)).toMatchObject({ status: "SUCCEEDED", amountMinor: 40_000 });
    // deciding again changes nothing and sends nothing
    await g.simulator.decide(started.providerRef, "FAILED");
    expect(delivered).toHaveLength(1);
  });

  it("refuses a tampered callback and one signed with another secret", async () => {
    const { g, delivered } = setup();
    const gw = g.get(provider);
    const started = await gw.charge({ reference: makeReference("payment", crypto.randomUUID()), amountMinor: 12_300, currency: "ETB", description: "trip", notifyUrl: "http://x" });
    await g.simulator.decide(started.providerRef, "FAILED", "insufficient funds");
    const { body, headers } = delivered[0]!;
    expect(gw.parseWebhook(body, headers)).toMatchObject({ status: "FAILED", amountMinor: 12_300 });
    const tampered = body.replace("123.00", "1.00");
    expect(() => gw.parseWebhook(tampered, headers)).toThrow(WebhookRejected);
    const other = createGateways(
      { providers: [provider], secrets: { telebirr: "x".repeat(40), cbebirr: "y".repeat(40), chapa: "z".repeat(40) }, checkoutBaseUrl: "http://x", autoApproveMs: 0, payoutDelayMs: 0, dropRate: 0 },
      { store: simStore(), deliver: async () => 200, logger: pino({ level: "silent" }) },
    );
    expect(() => other.get(provider).parseWebhook(body, headers)).toThrow(WebhookRejected);
  });
});

describe("simulator behaviour", () => {
  it("approves charges on its own when asked to (the rider approving on their phone)", async () => {
    const { g, delivered } = setup(10);
    await g.get("telebirr").charge({ reference: makeReference("topup", crypto.randomUUID()), amountMinor: 5000, currency: "ETB", description: "top-up", notifyUrl: "http://x" });
    await new Promise((r) => setTimeout(r, 40));
    expect(g.get("telebirr").parseWebhook(delivered[0]!.body, {})).toMatchObject({ status: "SUCCEEDED", kind: "charge" });
  });

  it("pays out after a delay; an account ending in 0000 fails", async () => {
    const { g, delivered } = setup();
    await g.get("cbebirr").payout({ reference: makeReference("payout", crypto.randomUUID()), amountMinor: 50_000, currency: "ETB", destination: "+251911223344", description: "earnings", notifyUrl: "http://x" });
    await g.get("cbebirr").payout({ reference: makeReference("payout", crypto.randomUUID()), amountMinor: 50_000, currency: "ETB", destination: "+251911220000", description: "earnings", notifyUrl: "http://x" });
    await new Promise((r) => setTimeout(r, 40));
    const results = delivered.map((d) => g.get("cbebirr").parseWebhook(d.body, d.headers)).map((n) => [n.kind, n.status]);
    expect(results).toEqual(expect.arrayContaining([["payout", "SUCCEEDED"], ["payout", "FAILED"]]));
  });
});
