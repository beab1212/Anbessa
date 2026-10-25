// SMS providers. The provider for Ethiopia is still open (Auth.md Q3); Twilio is wired
// because it's the one configured today. Adding another means implementing SmsSender.

import type { Logger } from "@ride-app/shared-utils";
import { maskPhone } from "../lib/crypto.js";

export interface SmsSender {
  /** Resolves with the provider's message id; rejects when the provider refused it. */
  send(to: string, body: string): Promise<{ providerId?: string }>;
}

export function twilioSms(opts: { accountSid: string; authToken: string; from: string }): SmsSender {
  const auth = Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString("base64");
  return {
    async send(to, body) {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${opts.accountSid}/Messages.json`, {
        method: "POST",
        headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: to, From: opts.from, Body: body }),
        signal: AbortSignal.timeout(5000),
      });
      const json = (await res.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
      if (!res.ok) throw new Error(`twilio ${res.status}${json.code ? ` (${json.code})` : ""}`);
      return { providerId: json.sid };
    },
  };
}

/** Development only (refused in production by config): logs the message, including any code. */
export function consoleSms(logger: Logger, sink?: (to: string, body: string) => void): SmsSender {
  return {
    async send(to, body) {
      sink?.(to, body);
      logger.warn({ to: maskPhone(to), body }, "DEV SMS (console provider, never enabled in production)");
      return {};
    },
  };
}
