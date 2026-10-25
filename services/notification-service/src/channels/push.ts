// Push notifications: Firebase Cloud Messaging HTTP v1 (Android, iOS through APNs, web).
// The OAuth token comes from the service account (JWT bearer grant), cached until expiry.

import { importPKCS8, SignJWT } from "jose";
import type { Logger } from "@ride-app/shared-utils";

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export type PushResult = "sent" | "unregistered";

export interface PushSender {
  /** "unregistered" means the token is dead and should be deleted. Other failures reject. */
  send(token: string, message: PushMessage): Promise<PushResult>;
}

export function fcmPush(opts: { projectId: string; clientEmail: string; privateKey: string }): PushSender {
  let cached: { token: string; expiresAt: number } | undefined;

  async function accessToken(): Promise<string> {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    const key = await importPKCS8(opts.privateKey, "RS256");
    const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(opts.clientEmail)
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key);
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!res.ok || !json.access_token) throw new Error(`fcm oauth ${res.status}`);
    cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  return {
    async send(token, message) {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${opts.projectId}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
        body: JSON.stringify({ message: { token, notification: { title: message.title, body: message.body }, data: message.data } }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return "sent";
      const json = (await res.json().catch(() => ({}))) as { error?: { status?: string; details?: { errorCode?: string }[] } };
      const code = json.error?.details?.find((d) => d.errorCode)?.errorCode ?? json.error?.status;
      if (res.status === 404 || code === "UNREGISTERED") return "unregistered";
      throw new Error(`fcm ${res.status}${code ? ` ${code}` : ""}`);
    },
  };
}

/** Development only (refused in production by config). */
export function consolePush(logger: Logger, sink?: (token: string, message: PushMessage) => void): PushSender {
  return {
    async send(token, message) {
      sink?.(token, message);
      logger.info({ token: `${token.slice(0, 8)}…`, ...message }, "DEV PUSH (console provider)");
      return "sent";
    },
  };
}
