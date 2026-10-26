// CBE Birr (Commercial Bank of Ethiopia) — mobile money, simulated.
//
// The real integration (C2B payment request with a USSD push, B2C disbursement, reversal) answers
// asynchronously at the result URL with { TransactionType, TransID, BillRefNumber, ConversationID,
// TransAmount, TransTime, ResultCode, ResultDesc, Signature }. ResultCode "0" is success.
// Here Signature is HMAC-SHA256 (uppercase hex) with CBEBIRR_WEBHOOK_SECRET over
// ConversationID|BillRefNumber|TransID|TransAmount|ResultCode; use the bank's documented scheme
// and credentials when going live.

import { createHmac, timingSafeEqual } from "node:crypto";
import { providerId, type SimCodec } from "./simulator.js";
import type { ProviderSpec } from "./simulated.js";
import { toBirr, toMinor, WebhookRejected, type OperationKind, type ProviderStatus } from "./types.js";

const TYPE: Record<OperationKind, string> = { charge: "Payment", payout: "Disbursement", refund: "Reversal" };
const KIND: Record<string, OperationKind> = { Payment: "charge", Disbursement: "payout", Reversal: "refund" };

const signature = (f: { ConversationID: string; BillRefNumber: string; TransID: string; TransAmount: string; ResultCode: string }, secret: string) =>
  createHmac("sha256", secret).update([f.ConversationID, f.BillRefNumber, f.TransID, f.TransAmount, f.ResultCode].join("|")).digest("hex").toUpperCase();

const timestamp = (ms: number) => new Date(ms + 3 * 3600_000).toISOString().replace(/\D/g, "").slice(0, 14); // EAT, yyyyMMddHHmmss

export const cbebirrCodec: SimCodec = {
  provider: "cbebirr",
  newRef: () => providerId("CBE-", 16),
  newTxnId: () => providerId("CB", 10),
  notice(op, secret) {
    const fields = {
      TransactionType: TYPE[op.kind],
      ConversationID: op.ref,
      BillRefNumber: op.reference,
      TransID: op.txnId ?? "",
      TransAmount: toBirr(op.amountMinor),
      TransTime: timestamp(op.decidedAt ?? Date.now()),
      ResultCode: op.status === "SUCCEEDED" ? "0" : "2001",
      ResultDesc: op.status === "SUCCEEDED" ? "The service request is processed successfully." : (op.failure ?? "Declined"),
    };
    return { body: JSON.stringify({ ...fields, Signature: signature(fields, secret) }), headers: {} };
  },
};

export const cbebirrSpec: ProviderSpec = {
  provider: "cbebirr",
  label: "CBE Birr",
  methods: ["MOBILE_MONEY"],
  instructions: (birr) => `Approve ${birr} ETB to Anbessa when CBE Birr asks on your phone (or on the payment page).`,
  parse(rawBody, _headers, secret) {
    let b: Record<string, string>;
    try {
      b = JSON.parse(rawBody) as Record<string, string>;
    } catch {
      throw new WebhookRejected("not JSON");
    }
    const fields = {
      ConversationID: String(b.ConversationID ?? ""), BillRefNumber: String(b.BillRefNumber ?? ""), TransID: String(b.TransID ?? ""),
      TransAmount: String(b.TransAmount ?? ""), ResultCode: String(b.ResultCode ?? ""),
    };
    const given = Buffer.from(String(b.Signature ?? ""));
    const expected = Buffer.from(signature(fields, secret));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new WebhookRejected("bad CBE Birr signature");
    const kind = KIND[b.TransactionType ?? ""];
    if (!kind || !fields.BillRefNumber || !fields.ConversationID) throw new WebhookRejected("incomplete CBE Birr notification");
    const status: ProviderStatus = fields.ResultCode === "0" ? "SUCCEEDED" : "FAILED";
    return {
      kind, reference: fields.BillRefNumber, providerRef: fields.ConversationID, providerTxnId: fields.TransID || null, status,
      amountMinor: toMinor(fields.TransAmount || "0"), ...(status === "FAILED" ? { failure: String(b.ResultDesc ?? "declined") } : {}),
      eventKey: `${fields.ConversationID}:${fields.ResultCode}`,
    };
  },
};
