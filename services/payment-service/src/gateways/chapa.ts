// Chapa — card payments (and bank transfers for payouts), simulated.
//
// The real integration:
//   - POST https://api.chapa.co/v1/transaction/initialize { amount, currency, tx_ref, callback_url,
//     return_url } → data.checkout_url (hosted page: cards, telebirr, CBE Birr, M-Pesa)
//   - the webhook is JSON with headers `Chapa-Signature` / `x-chapa-signature`: HMAC-SHA256 (hex)
//     of the body with the webhook secret set in the Chapa dashboard
//   - GET /v1/transaction/verify/{tx_ref} for reconciliation; POST /v1/refund/{tx_ref};
//     POST /v1/transfers for payouts
// The callback here has the same shape and signature (CHAPA_WEBHOOK_SECRET).

import { createHmac, timingSafeEqual } from "node:crypto";
import { providerId, type SimCodec } from "./simulator.js";
import type { ProviderSpec } from "./simulated.js";
import { header, toBirr, toMinor, WebhookRejected, type OperationKind, type ProviderStatus } from "./types.js";

const EVENT: Record<OperationKind, string> = { charge: "charge", payout: "payout", refund: "refund" };
const KIND: Record<string, OperationKind> = { charge: "charge", payout: "payout", refund: "refund" };
const hmac = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("hex");

export const chapaCodec: SimCodec = {
  provider: "chapa",
  newRef: () => providerId("CHK", 12),
  newTxnId: () => providerId("AP", 12),
  notice(op, secret) {
    const ok = op.status === "SUCCEEDED";
    const body = JSON.stringify({
      event: `${EVENT[op.kind]}.${ok ? "success" : "failed"}`,
      type: op.kind === "charge" ? "API" : op.kind === "payout" ? "Payout" : "Refund",
      tx_ref: op.reference,
      reference: op.txnId ?? op.ref,
      checkout_id: op.ref,
      status: ok ? "success" : "failed",
      amount: toBirr(op.amountMinor),
      currency: "ETB",
      mode: "test",
      ...(op.failure ? { failure_reason: op.failure } : {}),
      created_at: new Date(op.createdAt).toISOString(),
      updated_at: new Date(op.decidedAt ?? Date.now()).toISOString(),
    });
    const sig = hmac(body, secret);
    return { body, headers: { "chapa-signature": sig, "x-chapa-signature": sig } };
  },
};

export const chapaSpec: ProviderSpec = {
  provider: "chapa",
  label: "Chapa (cards)",
  methods: ["CARD"],
  instructions: (birr) => `Pay ${birr} ETB to Anbessa on the Chapa checkout page.`,
  parse(rawBody, headers, secret) {
    const given = Buffer.from(header(headers, "chapa-signature") ?? header(headers, "x-chapa-signature") ?? "");
    const expected = Buffer.from(hmac(rawBody, secret));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new WebhookRejected("bad Chapa signature");
    let b: Record<string, string>;
    try {
      b = JSON.parse(rawBody) as Record<string, string>;
    } catch {
      throw new WebhookRejected("not JSON");
    }
    const kind = KIND[String(b.event ?? "").split(".")[0] ?? ""];
    if (!kind || !b.tx_ref) throw new WebhookRejected("incomplete Chapa notification");
    const status: ProviderStatus = b.status === "success" ? "SUCCEEDED" : b.status === "failed" ? "FAILED" : "PENDING";
    return {
      kind, reference: b.tx_ref, providerRef: b.checkout_id ?? null, providerTxnId: status === "SUCCEEDED" ? (b.reference ?? null) : null, status,
      amountMinor: toMinor(b.amount ?? "0"), ...(b.failure_reason ? { failure: b.failure_reason } : {}),
      eventKey: `${b.tx_ref}:${b.event}`,
    };
  },
};
