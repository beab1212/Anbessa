// Telegram Gateway API client (https://core.telegram.org/gateway/api) and
// delivery-report verification (Auth.md §9.7). The token never leaves this service.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type DeliveryStatus = "sent" | "delivered" | "read" | "expired" | "revoked";

export interface RequestStatus {
  request_id: string;
  phone_number?: string;
  request_cost?: number;
  is_refunded?: boolean;
  remaining_balance?: number;
  delivery_status?: { status: DeliveryStatus; updated_at: number };
  verification_status?: { status: string; updated_at: number; code_entered?: string };
  payload?: string;
}

export class TelegramGatewayError extends Error {
  constructor(readonly method: string, readonly reason: string) {
    super(`telegram gateway ${method} failed: ${reason}`);
  }
}

export interface TelegramGateway {
  checkSendAbility(phoneNumber: string): Promise<RequestStatus>;
  sendVerificationMessage(params: {
    phone_number: string;
    request_id?: string;
    code: string;
    ttl: number;
    callback_url?: string;
    payload?: string;
    sender_username?: string;
  }): Promise<RequestStatus>;
  checkVerificationStatus(requestId: string, code?: string): Promise<RequestStatus>;
  revokeVerificationMessage(requestId: string): Promise<boolean>;
}

export function telegramGateway(opts: { token: string; baseUrl: string; timeoutMs?: number }): TelegramGateway {
  async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
    } catch (err) {
      throw new TelegramGatewayError(method, (err as Error).name === "TimeoutError" ? "timeout" : "network error");
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; error?: string };
    if (!body.ok) throw new TelegramGatewayError(method, body.error ?? `http ${res.status}`);
    return body.result as T;
  }

  return {
    checkSendAbility: (phone_number) => call("checkSendAbility", { phone_number }),
    sendVerificationMessage: (params) => call("sendVerificationMessage", params),
    checkVerificationStatus: (request_id, code) => call("checkVerificationStatus", code ? { request_id, code } : { request_id }),
    revokeVerificationMessage: (request_id) => call("revokeVerificationMessage", { request_id }),
  };
}

/**
 * Delivery reports are signed: HMAC-SHA256(key = SHA256(token), `${timestamp}\n${rawBody}`), hex.
 * Reports older than 5 minutes are refused (replays).
 */
export function reportVerifier(token: string, now: () => number = Date.now) {
  const secretKey = createHash("sha256").update(token).digest();
  return function verify(rawBody: string, timestamp: string | undefined, signature: string | undefined): boolean {
    if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
    if (Math.abs(now() / 1000 - Number(timestamp)) > 300) return false;
    const expected = createHmac("sha256", secretKey).update(`${timestamp}\n${rawBody}`).digest("hex");
    return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  };
}
