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
}

export function notificationOtpSender(baseUrl: string, internalToken: string, logger: Logger): OtpSender {
  return {
    async send(req) {
      try {
        const res = await fetch(new URL("/internal/otp-deliveries", baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${internalToken}` },
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(2000),
        });
        if (!res.ok) logger.error({ status: res.status }, "otp delivery request rejected by notification-service");
      } catch (err) {
        // never log the code or the full number
        logger.error({ err: (err as Error).message, phone: maskPhone(req.phoneNumber) }, "otp delivery request failed");
      }
    },
  };
}

/** Development/test only (refused in production by config): prints the code. */
export function consoleOtpSender(logger: Logger, sink?: (req: OtpRequest) => void): OtpSender {
  return {
    async send(req) {
      sink?.(req);
      logger.warn({ phone: maskPhone(req.phoneNumber), code: req.code }, "DEV OTP (console delivery, never enabled in production)");
    },
  };
}

export function maskPhone(phone: string): string {
  return phone.length > 7 ? `${phone.slice(0, 5)}••••${phone.slice(-3)}` : "•••";
}
