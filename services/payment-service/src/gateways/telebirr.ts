// telebirr (Ethio telecom) — mobile money, simulated.
//
// The real integration (H5 / in-app "preOrder" C2B, B2C disbursement, refund):
//   - POST {base}/payment/v1/merchant/preOrder with merch_order_id = our reference and
//     total_amount in birr ("400.00"); the response's prepay_id builds the checkout (toPayUrl)
//   - the result arrives at notify_url as JSON signed with SHA256WithRSA over the sorted
//     `key=value&…` string (excluding sign and sign_type), verified with telebirr's public key
//   - POST {base}/payment/v1/merchant/queryOrder for reconciliation
// Here the signature is an HMAC-SHA256 (base64) with TELEBIRR_WEBHOOK_SECRET; swap `verify` for
// the RSA check and the request methods in simulated.ts for HTTP calls when going live.

import { createHmac, timingSafeEqual } from "node:crypto";
import { providerId, type SimCodec } from "./simulator.js";
import type { ProviderSpec } from "./simulated.js";
import { toBirr, toMinor, WebhookRejected, type OperationKind, type ProviderStatus } from "./types.js";

const BIZ: Record<OperationKind, string> = { charge: "C2B", payout: "B2C", refund: "REFUND" };
const KIND: Record<string, OperationKind> = { C2B: "charge", B2C: "payout", REFUND: "refund" };

/** The sorted `key=value&…` string telebirr signs. */
function canonical(fields: Record<string, string>): string {
  return Object.keys(fields).filter((k) => k !== "sign" && k !== "sign_type").sort().map((k) => `${k}=${fields[k]}`).join("&");
}
const sign = (fields: Record<string, string>, secret: string) => createHmac("sha256", secret).update(canonical(fields)).digest("base64");

export const telebirrCodec: SimCodec = {
  provider: "telebirr",
  newRef: () => providerId("TBPRE", 18),
  newTxnId: () => providerId("TBL", 10),
  notice(op, secret) {
    const fields: Record<string, string> = {
      appid: "anbessa-sim",
      biz_type: BIZ[op.kind],
      merch_code: "245445",
      merch_order_id: op.reference,
      notify_time: String(Math.floor(Date.now() / 1000)),
      payment_order_id: op.ref,
      total_amount: toBirr(op.amountMinor),
      trans_currency: "ETB",
      trade_status: op.status === "SUCCEEDED" ? "Completed" : op.status === "FAILED" ? "Failure" : "Pending",
      trans_end_time: String(Math.floor((op.decidedAt ?? Date.now()) / 1000)),
      ...(op.txnId ? { trans_id: op.txnId } : {}),
      ...(op.failure ? { error_msg: op.failure } : {}),
    };
    return { body: JSON.stringify({ ...fields, sign_type: "HMAC-SHA256", sign: sign(fields, secret) }), headers: {} };
  },
};

export const telebirrSpec: ProviderSpec = {
  provider: "telebirr",
  label: "telebirr",
  methods: ["MOBILE_MONEY"],
  instructions: (birr) => `Approve ${birr} ETB to Anbessa in your telebirr app or on the payment page.`,
  parse(rawBody, _headers, secret) {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new WebhookRejected("not JSON");
    }
    const fields = Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    const given = Buffer.from(fields.sign ?? "", "base64");
    const expected = Buffer.from(sign(fields, secret), "base64");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new WebhookRejected("bad telebirr signature");
    const kind = KIND[fields.biz_type ?? ""];
    if (!kind || !fields.merch_order_id || !fields.payment_order_id) throw new WebhookRejected("incomplete telebirr notification");
    const status: ProviderStatus = fields.trade_status === "Completed" ? "SUCCEEDED" : fields.trade_status === "Failure" ? "FAILED" : "PENDING";
    return {
      kind, reference: fields.merch_order_id, providerRef: fields.payment_order_id, providerTxnId: fields.trans_id ?? null, status,
      amountMinor: toMinor(fields.total_amount ?? "0"), ...(fields.error_msg ? { failure: fields.error_msg } : {}),
      eventKey: `${fields.payment_order_id}:${fields.trade_status}`,
    };
  },
};
