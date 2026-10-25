// Sends a notification at most once per (event, channel) — Database.md §7.5:
// dedupe_key = eventId:channel, so a replayed or redelivered Kafka event never re-sends.
// Failures are retried by Kafka redelivery up to MAX_ATTEMPTS, then recorded as FAILED.

import { Prisma } from "../generated/prisma/client.js";
import type { Logger } from "@ride-app/shared-utils";
import type { Db } from "../db.js";
import type { PushMessage, PushSender } from "../channels/push.js";
import type { SmsSender } from "../channels/sms.js";

export const MAX_ATTEMPTS = 5;

type Outcome = "SENT" | "SKIPPED";

export function createNotifier(deps: { db: Db; sms: SmsSender; push: PushSender; logger: Logger }) {
  const { db, logger } = deps;

  async function once(key: { eventId: string; channel: "PUSH" | "SMS"; template: string; userId?: string }, send: () => Promise<Outcome>) {
    const dedupeKey = `${key.eventId}:${key.channel}`;
    let row = await db.notification.findUnique({ where: { dedupeKey } });
    if (!row) {
      try {
        row = await db.notification.create({
          data: { dedupeKey, channel: key.channel, template: key.template, userId: key.userId ?? null },
        });
      } catch (err) {
        // a concurrent consumer created it first
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
        row = await db.notification.findUniqueOrThrow({ where: { dedupeKey } });
      }
    }
    if (row.status !== "PENDING") return row.status;

    const attempt = row.attempts + 1;
    try {
      const outcome = await send();
      await db.notification.update({ where: { id: row.id }, data: { status: outcome, attempts: attempt, error: null } });
      return outcome;
    } catch (err) {
      const message = (err as Error).message.slice(0, 200);
      const final = attempt >= MAX_ATTEMPTS;
      await db.notification.update({ where: { id: row.id }, data: { attempts: attempt, error: message, ...(final ? { status: "FAILED" } : {}) } });
      logger.error({ dedupeKey, attempt, err: message }, final ? "notification failed permanently" : "notification failed, will retry");
      if (!final) throw err; // Kafka redelivers the event
      return "FAILED";
    }
  }

  return {
    sms(eventId: string, template: string, to: string, body: string) {
      return once({ eventId, channel: "SMS", template }, async () => {
        await deps.sms.send(to, body);
        return "SENT";
      });
    },

    /** Push to every registered device of the user. No devices → SKIPPED. Dead tokens are removed. */
    push(eventId: string, template: string, userId: string, message: PushMessage) {
      return once({ eventId, channel: "PUSH", template, userId }, async () => {
        const devices = await db.deviceToken.findMany({ where: { userId }, select: { id: true, token: true } });
        if (devices.length === 0) return "SKIPPED";
        let sent = 0;
        let lastError: unknown;
        for (const d of devices) {
          try {
            if ((await deps.push.send(d.token, message)) === "unregistered") {
              await db.deviceToken.delete({ where: { id: d.id } }).catch(() => undefined);
            } else sent++;
          } catch (err) {
            lastError = err;
          }
        }
        if (sent === 0 && lastError) throw lastError;
        return sent > 0 ? "SENT" : "SKIPPED";
      });
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
