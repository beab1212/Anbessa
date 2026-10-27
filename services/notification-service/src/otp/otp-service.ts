// Login-code delivery (Auth.md §9.7): Telegram Gateway first, SMS fallback.
// auth-service generates and verifies the code; this service only delivers it.
//
//   deliver()        row REQUESTED → (Telegram) checkSendAbility → sendVerificationMessage → SENT
//                    can't receive → NOT_REACHABLE → SMS row (fallback_of)
//   delivery report  SENT → DELIVERED → READ (signed webhook), cancels the fallback
//   fallback due     no DELIVERED within OTP_FALLBACK_SECONDS → SMS row + revoke on Telegram
//   verified()       auth-service reports success → checkVerificationStatus, rows VERIFIED, code deleted
//
// The code is never logged and never written to Postgres.

import type { Logger } from "@ride-app/shared-utils";
import type { Db } from "../db.js";
import { maskPhone } from "../lib/crypto.js";
import { badRequest } from "../lib/errors.js";
import type { SmsSender } from "../channels/sms.js";
import type { ActiveCode, OtpStore } from "./otp-store.js";
import { TelegramGatewayError, type RequestStatus, type TelegramGateway } from "./telegram-gateway.js";

export type Channel = "telegram" | "sms";
export type Purpose = "sign_in" | "phone_change" | "claim_guest";

export interface OtpRequest {
  phoneNumber: string;
  code: string;
  ttlSeconds: number;
  purpose: Purpose;
}

export interface OtpServiceDeps {
  db: Db;
  store: OtpStore;
  sms: SmsSender;
  telegram?: TelegramGateway;
  hashPhone: (phone: string) => Uint8Array<ArrayBuffer>;
  logger: Logger;
  config: {
    channels: Channel[];
    fallbackSeconds: number;
    callbackUrl?: string;
    senderUsername?: string;
    balanceAlertUsd: number;
  };
  /** live settings (admin dashboard) override channels and fallbackSeconds per send */
  live?: { channels(): Channel[]; fallbackSeconds(): number };
  now?: () => Date;
}

const E164 = /^\+[1-9]\d{7,14}$/;
const RETENTION_DAYS = 30;

// forward-only status order; EXPIRED / REVOKED only replace an undelivered attempt
const RANK: Record<string, number> = { REQUESTED: 0, SENT: 1, DELIVERED: 2, READ: 3, VERIFIED: 4 };
const FROM_TELEGRAM: Record<string, string> = { sent: "SENT", delivered: "DELIVERED", read: "READ", expired: "EXPIRED", revoked: "REVOKED" };
const DELIVERED = new Set(["DELIVERED", "READ", "VERIFIED"]);

export function smsText(code: string, ttlSeconds: number): string {
  return `Anbessa: your code is ${code}. It expires in ${Math.max(1, Math.round(ttlSeconds / 60))} minutes. Never share it with anyone.`;
}

export function createOtpService(deps: OtpServiceDeps) {
  const { db, store, sms, telegram, logger, config } = deps;
  const now = deps.now ?? (() => new Date());
  const channels = () => deps.live?.channels() ?? config.channels;
  const fallbackSeconds = () => deps.live?.fallbackSeconds() ?? config.fallbackSeconds;
  const telegramFirst = () => !!telegram && channels()[0] === "telegram";
  const smsOn = () => channels().includes("sms");
  // last Telegram balance seen in a response, for the admin system page
  let lastBalance: { usd: number; at: string } | null = null;
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

  const update = (id: string, data: Record<string, unknown>) => db.otpDelivery.update({ where: { id }, data });

  function noteBalance(s: RequestStatus) {
    if (s.remaining_balance === undefined) return;
    lastBalance = { usd: s.remaining_balance, at: now().toISOString() };
    if (s.remaining_balance < config.balanceAlertUsd) {
      logger.warn({ remainingBalanceUsd: s.remaining_balance }, "telegram gateway balance is low: top up the account");
    }
  }

  async function sendSms(deliveryId: string, active: ActiveCode) {
    try {
      await sms.send(active.phoneNumber, smsText(active.code, active.ttlSeconds));
      await update(deliveryId, { status: "SENT" });
    } catch (err) {
      await update(deliveryId, { status: "FAILED", error: (err as Error).message.slice(0, 200) });
      logger.error({ deliveryId, phone: maskPhone(active.phoneNumber), err: (err as Error).message }, "otp sms failed");
    }
  }

  /** SMS with the same code, replacing attempt `ofId`, if that attempt still belongs to the active code. */
  async function smsFallback(phoneHash: Uint8Array<ArrayBuffer>, ofId: string, reason: string) {
    const active = await store.getCode(hex(phoneHash));
    if (!active || !active.deliveryIds.includes(ofId)) return; // expired, verified, or a newer code exists
    if (!smsOn()) {
      logger.warn({ deliveryId: ofId, reason }, "otp not delivered and SMS fallback is disabled");
      return;
    }
    const row = await db.otpDelivery.create({
      data: { phoneHash, purpose: active.purpose, channel: "SMS", fallbackOfId: ofId, createdAt: now() },
    });
    active.deliveryIds.push(row.id);
    await store.updateCode(hex(phoneHash), active);
    logger.info({ deliveryId: row.id, fallbackOf: ofId, reason }, "otp sms fallback");
    await sendSms(row.id, active);
  }

  async function revokeTelegram(requestId: string) {
    try {
      await telegram?.revokeVerificationMessage(requestId);
    } catch {
      // best effort: a delivered message isn't removed anyway
    }
  }

  async function runTelegram(deliveryId: string, phoneHash: Uint8Array<ArrayBuffer>, active: ActiveCode) {
    let ability: RequestStatus;
    try {
      ability = await telegram!.checkSendAbility(active.phoneNumber);
    } catch (err) {
      // the number can't receive Telegram codes (no account, privacy settings): the check is free
      const reason = err instanceof TelegramGatewayError ? err.reason : "error";
      await update(deliveryId, { status: "NOT_REACHABLE", error: reason.slice(0, 200) });
      await store.cancelFallback(deliveryId);
      await smsFallback(phoneHash, deliveryId, `not_reachable:${reason}`);
      return;
    }
    try {
      const sent = await telegram!.sendVerificationMessage({
        phone_number: active.phoneNumber,
        request_id: ability.request_id, // so the ability check isn't charged separately
        code: active.code,
        ttl: active.ttlSeconds,
        payload: deliveryId, // only our row id: no phone, no code
        ...(config.callbackUrl ? { callback_url: config.callbackUrl } : {}),
        ...(config.senderUsername ? { sender_username: config.senderUsername } : {}),
      });
      await update(deliveryId, {
        status: "SENT",
        telegramRequestId: sent.request_id,
        ...(sent.request_cost !== undefined ? { costUsd: sent.request_cost } : {}),
      });
      const current = await store.getCode(hex(phoneHash));
      if (current?.deliveryIds.includes(deliveryId)) {
        current.telegram = { deliveryId, requestId: sent.request_id };
        await store.updateCode(hex(phoneHash), current);
      }
      noteBalance(sent);
    } catch (err) {
      await update(deliveryId, { status: "FAILED", error: (err as Error).message.slice(0, 200) });
      await store.cancelFallback(deliveryId);
      await smsFallback(phoneHash, deliveryId, "telegram_send_failed");
    }
  }

  return {
    /** For the admin system page: channel setup and delivery over the last hour. */
    async status() {
      const since = new Date(now().getTime() - 3_600_000);
      const rows = await db.otpDelivery.groupBy({ by: ["channel", "status"], where: { createdAt: { gte: since } }, _count: true });
      const fallbacks = await db.otpDelivery.count({ where: { createdAt: { gte: since }, fallbackOfId: { not: null } } });
      // the column holds "TELEGRAM" / "SMS" (comparing with "telegram" left the rate always null)
      const telegramSent = rows.filter((r) => r.channel === "TELEGRAM").reduce((n, r) => n + r._count, 0);
      return {
        channels: channels(), fallbackSeconds: fallbackSeconds(), telegramConfigured: !!telegram, telegramBalance: lastBalance,
        lastHour: rows.map((r) => ({ channel: r.channel, status: r.status, count: r._count })),
        smsFallbackRate: telegramSent ? fallbacks / telegramSent : null,
      };
    },

    /**
     * Accepts a code from auth-service and starts delivery. Returns once the attempt is
     * recorded and the fallback is scheduled; `done` settles when the first send finishes.
     */
    async deliver(req: OtpRequest) {
      if (!E164.test(req.phoneNumber)) throw badRequest("phoneNumber must be E.164");
      if (!/^\d{4,8}$/.test(req.code)) throw badRequest("code must be 4–8 digits");
      const ttl = Math.min(Math.max(req.ttlSeconds, 60), 1800);
      const phoneHash = deps.hashPhone(req.phoneNumber);
      const since = new Date(now().getTime() - ttl * 1000);

      // Manual resend (step 7): a recent Telegram attempt that wasn't delivered → go straight to SMS.
      const useTelegram = telegramFirst();
      const smsAllowed = smsOn();
      const recent = useTelegram
        ? await db.otpDelivery.findFirst({
            where: { phoneHash, channel: "TELEGRAM", createdAt: { gt: since }, status: { in: ["REQUESTED", "SENT"] } },
            orderBy: { createdAt: "desc" },
          })
        : null;
      const channel: Channel = useTelegram && !recent ? "telegram" : "sms";
      if (channel === "sms" && !smsAllowed) throw badRequest("no delivery channel available");

      const row = await db.otpDelivery.create({
        data: {
          phoneHash,
          purpose: req.purpose,
          channel: channel === "telegram" ? "TELEGRAM" : "SMS",
          createdAt: now(), // same clock as the resend window and the fallback schedule
          ...(recent ? { fallbackOfId: recent.id } : {}),
        },
      });
      const active: ActiveCode = { phoneNumber: req.phoneNumber, code: req.code, purpose: req.purpose, ttlSeconds: ttl, deliveryIds: [row.id] };
      await store.putCode(hex(phoneHash), active, ttl);

      let done: Promise<void>;
      if (channel === "telegram") {
        // scheduled before the first Telegram call, so even a crash right now still ends in an SMS
        if (smsAllowed) await store.scheduleFallback(row.id, new Date(now().getTime() + fallbackSeconds() * 1000));
        done = runTelegram(row.id, phoneHash, active);
      } else {
        if (recent) {
          await store.cancelFallback(recent.id);
          if (recent.telegramRequestId) void revokeTelegram(recent.telegramRequestId);
        }
        done = sendSms(row.id, active);
      }
      done = done.catch((err) => logger.error({ deliveryId: row.id, err: (err as Error).message }, "otp delivery failed"));
      return { deliveryId: row.id, channel, done };
    },

    /** A signed delivery report from Telegram (already verified by the webhook). */
    async onReport(report: RequestStatus): Promise<boolean> {
      const byPayload = report.payload && /^[0-9a-f-]{36}$/i.test(report.payload)
        ? await db.otpDelivery.findUnique({ where: { id: report.payload } })
        : null;
      const row = byPayload ?? (report.request_id ? await db.otpDelivery.findUnique({ where: { telegramRequestId: report.request_id } }) : null);
      if (!row || row.channel !== "TELEGRAM") return false;
      noteBalance(report);

      const next = report.delivery_status ? FROM_TELEGRAM[report.delivery_status.status] : undefined;
      const data: Record<string, unknown> = {};
      if (report.is_refunded !== undefined) data.isRefunded = report.is_refunded;
      if (report.request_cost !== undefined) data.costUsd = report.request_cost;
      if (!row.telegramRequestId && report.request_id) data.telegramRequestId = report.request_id;
      if (next) {
        const forward = next in RANK ? (RANK[next] ?? 0) > (RANK[row.status] ?? 0) : row.status === "REQUESTED" || row.status === "SENT";
        if (forward) data.status = next;
      }
      if (Object.keys(data).length) await update(row.id, data);
      if (next && DELIVERED.has(next)) await store.cancelFallback(row.id);
      return true;
    },

    /** Fallback timer fired for a Telegram attempt. */
    async onFallbackDue(deliveryId: string) {
      const row = await db.otpDelivery.findUnique({ where: { id: deliveryId } });
      if (!row || row.channel !== "TELEGRAM" || DELIVERED.has(row.status)) return;
      await smsFallback(row.phoneHash, row.id, "not_delivered_in_time");
      if (row.telegramRequestId) await revokeTelegram(row.telegramRequestId);
    },

    async pollFallbacks() {
      for (const id of await store.claimDueFallbacks(now())) {
        await this.onFallbackDue(id).catch((err) => logger.error({ deliveryId: id, err: (err as Error).message }, "otp fallback failed"));
      }
    },

    /** auth-service verified the code (best effort, step 8). */
    async verified(phoneNumber: string) {
      if (!E164.test(phoneNumber)) throw badRequest("phoneNumber must be E.164");
      const phoneHash = deps.hashPhone(phoneNumber);
      const active = await store.getCode(hex(phoneHash));
      if (!active) return { closed: false };
      if (active.telegram) {
        // tells Telegram the code was used (its analytics and refunds); never blocks
        await telegram?.checkVerificationStatus(active.telegram.requestId, active.code).catch(() => undefined);
        await store.cancelFallback(active.telegram.deliveryId);
      }
      await db.otpDelivery.updateMany({
        where: { id: { in: active.deliveryIds }, status: { notIn: ["FAILED", "NOT_REACHABLE"] } },
        data: { status: "VERIFIED" },
      });
      await store.deleteCode(hex(phoneHash));
      return { closed: true };
    },

    /** Rows are kept 30 days for cost reconciliation and fraud analysis. */
    async purgeOld() {
      const { count } = await db.otpDelivery.deleteMany({
        where: { createdAt: { lt: new Date(now().getTime() - RETENTION_DAYS * 86_400_000) } },
      });
      return count;
    },
  };
}

export type OtpService = ReturnType<typeof createOtpService>;
