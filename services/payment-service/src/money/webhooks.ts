// Provider callbacks (POST /api/payments/webhooks/:provider). Each is verified with that
// provider's signature scheme, kept in webhook_event (including rejected ones), deduplicated by the
// provider's notification id, and routed by our reference to the payment, top-up, payout or refund
// it's about. A handler error answers 500, so the provider retries; the dedupe row stays
// unprocessed until a delivery succeeds.

import { createHash } from "node:crypto";
import type { Logger } from "@ride-app/shared-utils";
import type { Prisma } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import { parseReference, WebhookRejected, type Gateways, type ProviderNotice } from "../gateways/index.js";
import type { Payments } from "./payments.js";
import type { Payouts } from "./payouts.js";
import type { TopUps } from "./topups.js";

export type WebhookResult = { status: 200 | 401 | 404; body: { received: boolean; outcome?: string; duplicate?: boolean; error?: string } };

export function createWebhooks(deps: { db: Db; gateways: Gateways; payments: Payments; topUps: TopUps; payouts: Payouts; logger: Logger; now?: () => Date }) {
  const { db, gateways, logger } = deps;
  const now = deps.now ?? (() => new Date());

  /** Route a provider's notice (webhook or reconciliation query) to what it's about. */
  async function apply(notice: ProviderNotice): Promise<string> {
    const ref = parseReference(notice.reference);
    if (!ref) return "unknown_reference";
    switch (ref.kind) {
      case "payment":
        return deps.payments.applyCharge(notice);
      case "topup":
        return deps.topUps.applyNotice(notice);
      case "payout":
        return deps.payouts.applyNotice(notice);
      case "refund":
        return deps.payments.applyRefund(notice);
    }
  }

  return {
    apply,

    async receive(provider: string, rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<WebhookResult> {
      if (!gateways.has(provider)) return { status: 404, body: { received: false, error: "unknown provider" } };
      let notice: ProviderNotice;
      try {
        notice = gateways.get(provider).parseWebhook(rawBody, headers);
      } catch (err) {
        if (!(err instanceof WebhookRejected)) throw err;
        logger.warn({ provider, reason: err.message }, "webhook rejected");
        const eventKey = `rejected:${createHash("sha256").update(rawBody).digest("hex").slice(0, 32)}`;
        let payload: Prisma.InputJsonValue;
        try {
          payload = JSON.parse(rawBody) as Prisma.InputJsonValue;
        } catch {
          payload = { raw: rawBody.slice(0, 2000) };
        }
        await db.webhookEvent.upsert({
          where: { provider_eventKey: { provider, eventKey } },
          create: { provider, eventKey, signatureOk: false, payload, outcome: err.message, processedAt: now() },
          update: {},
        });
        return { status: 401, body: { received: false, error: "invalid signature" } };
      }

      const row = await db.webhookEvent.upsert({
        where: { provider_eventKey: { provider, eventKey: notice.eventKey } },
        create: { provider, eventKey: notice.eventKey, signatureOk: true, payload: JSON.parse(rawBody) as Prisma.InputJsonValue },
        update: {},
      });
      if (row.processedAt) return { status: 200, body: { received: true, duplicate: true, ...(row.outcome ? { outcome: row.outcome } : {}) } };

      const outcome = await apply(notice);
      await db.webhookEvent.update({ where: { id: row.id }, data: { processedAt: now(), outcome } });
      return { status: 200, body: { received: true, outcome } };
    },

    async recent(limit: number) {
      const rows = await db.webhookEvent.findMany({ orderBy: { receivedAt: "desc" }, take: limit });
      return rows.map((r) => ({ id: r.id, provider: r.provider, eventKey: r.eventKey, signatureOk: r.signatureOk, outcome: r.outcome, receivedAt: r.receivedAt, processedAt: r.processedAt }));
    },

    /** System page: callbacks per provider in the last 24 h, and failures. */
    async stats() {
      const since = new Date(now().getTime() - 86_400_000);
      const rows = await db.webhookEvent.groupBy({ by: ["provider", "signatureOk"], where: { receivedAt: { gte: since } }, _count: true });
      const stuck = await db.webhookEvent.count({ where: { processedAt: null, receivedAt: { lt: new Date(now().getTime() - 60_000) } } });
      return { last24h: rows.map((r) => ({ provider: r.provider, signatureOk: r.signatureOk, count: r._count })), unprocessed: stuck };
    },
  };
}

export type Webhooks = ReturnType<typeof createWebhooks>;
