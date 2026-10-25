// OTP delivery (Auth.md §9.7, AU11): the code goes to notification-service over an
// authenticated internal HTTP call, never through Kafka or logs. notification-service
// sends it with the Telegram Gateway API and falls back to SMS.

import type { Logger } from "@ride-app/shared-utils";

export interface OtpRequest {
  phoneNumber: string;
  code: string;
  ttlSeconds: number;
  purpose: "sign_in" | "phone_change" | "claim_guest";
}

export interface OtpSender {
  send(req: OtpRequest): Promise<void>;
  /** Best effort: the code was verified, so notification-service can close the delivery (Auth.md §9.7, step 8). */
  verified(phoneNumber: string): Promise<void>;
}

export function notificationOtpSender(baseUrl: string, internalToken: string, logger: Logger): OtpSender {
  const post = async (path: string, body: unknown, phone: string) => {
    try {
      const res = await fetch(new URL(path, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${internalToken}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) logger.error({ status: res.status, path }, "request rejected by notification-service");
    } catch (err) {
      // never log the code or the full number
      logger.error({ err: (err as Error).message, path, phone: maskPhone(phone) }, "notification-service request failed");
    }
  };
  return {
    send: (req) => post("/internal/otp-deliveries", req, req.phoneNumber),
    verified: (phoneNumber) => post("/internal/otp-deliveries/verified", { phoneNumber }, phoneNumber),
  };
}

/** Development/test only (refused in production by config): prints the code. */
export function consoleOtpSender(logger: Logger, sink?: (req: OtpRequest) => void): OtpSender {
  return {
    async send(req) {
      sink?.(req);
      logger.warn({ phone: maskPhone(req.phoneNumber), code: req.code }, "DEV OTP (console delivery, never enabled in production)");
    },
    async verified() {},
  };
}

export function maskPhone(phone: string): string {
  return phone.length > 7 ? `${phone.slice(0, 5)}••••${phone.slice(-3)}` : "•••";
}
