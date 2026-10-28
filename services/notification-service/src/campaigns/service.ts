// Campaigns (workflow 15 step 13): marketing sends a push or an SMS to a segment of riders or
// drivers in one city (campaign:send, CITY scope). Segment = city + role + optional "active in
// the last N days", taken from campaign_audience (kept from trip and driver events, see
// audience.ts). Opt-outs are honoured; nothing is sent during quiet hours (21:00–08:00 Addis Ababa).
//
//   DRAFT ──schedule──▶ SCHEDULED ──(time comes)──▶ SENDING ──(nothing left)──▶ SENT
//     │        └─(large)─▶ AWAITING_APPROVAL ──approve (a different staff member)──▶ SCHEDULED
//     └──────────────────┴────────cancel──────────────┴──▶ CANCELLED
//
// Maker-checker: a campaign whose audience is larger than CAMPAIGN_APPROVAL_THRESHOLD (default
// 1000) waits in AWAITING_APPROVAL until another staff member with campaign:send in that city
// approves it; neither its creator nor whoever scheduled it can. The sender checks again when
// sending starts (the segment can grow after scheduling) and sends it back for approval if the
// fixed recipient list is over the threshold and nobody approved it.
//
// When sending starts the recipients are fixed (campaign_delivery rows); the sender then works
// through them at CAMPAIGN_SEND_PER_SECOND, claiming rows with FOR UPDATE SKIP LOCKED so several
// replicas share the work. A delivery is retried 3 times, then FAILED. A row left IN_FLIGHT by a
// crash goes back to PENDING after 5 minutes (at-least-once, like the event notifications).

import { can, citiesWith, type Principal } from "@ride-app/shared-authz";
import type { Logger } from "@ride-app/shared-utils";
import type { PushSender } from "../channels/push.js";
import type { SmsSender } from "../channels/sms.js";
import type { Db } from "../db.js";
import { Prisma, type Campaign } from "../generated/prisma/client.js";
import { AppError, badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { maskPhone } from "../lib/crypto.js";
import type { ContactLookup } from "./contacts.js";
import { writeAudit } from "./outbox.js";

export const MAX_DELIVERY_ATTEMPTS = 3;
const STALE_IN_FLIGHT_MS = 5 * 60_000;
const MAX_SCHEDULE_AHEAD_MS = 90 * 24 * 3_600_000;
const DAY = 24 * 3_600_000;

export type Audience = "RIDER" | "DRIVER";
export type Channel = "PUSH" | "SMS";
export type CampaignStatus = "DRAFT" | "AWAITING_APPROVAL" | "SCHEDULED" | "SENDING" | "SENT" | "CANCELLED";

/** Does a campaign reaching `recipients` people need a second approver? */
export function needsSecondApprover(recipients: number, threshold: number): boolean {
  return recipients > threshold;
}

/** The maker (creator or scheduler) may not approve their own campaign. */
export function canApprove(approverId: string, c: { createdBy: string; updatedBy: string }): boolean {
  return approverId !== c.createdBy && approverId !== c.updatedBy;
}

export interface CampaignInput {
  cityId: string;
  audience: Audience;
  lastActiveDays?: number | null;
  channel: Channel;
  title?: string | null;
  body: string;
}

export interface CampaignDeps {
  db: Db;
  push: PushSender;
  sms: SmsSender;
  contacts: ContactLookup;
  logger: Logger;
  now: () => Date;
  /** recipients per second, all campaigns together */
  sendPerSecond: number;
  /** local hours [from, to) when nothing is sent; Africa/Addis_Ababa (UTC+3, no DST) */
  quietHours: { from: number; to: number };
  /** recipients above which a second staff member must approve (default 1000) */
  approvalThreshold?: number;
}

/** Addis Ababa is UTC+3 all year. */
export function inQuietHours(at: Date, q: { from: number; to: number }): boolean {
  if (q.from === q.to) return false;
  const h = (at.getUTCHours() + 3) % 24;
  return q.from < q.to ? h >= q.from && h < q.to : h >= q.from || h < q.to;
}

const SMS_MAX = 300;

export function createCampaignService(deps: CampaignDeps) {
  const { db, now } = deps;
  const approvalThreshold = deps.approvalThreshold ?? 1000;

  const view = (c: Campaign, counts?: Record<string, number>) => ({
    id: c.id, cityId: c.cityId, audience: c.audience as Audience, lastActiveDays: c.lastActiveDays, channel: c.channel as Channel,
    title: c.title, body: c.body, status: c.status as CampaignStatus, scheduledAt: c.scheduledAt?.toISOString() ?? null,
    startedAt: c.startedAt?.toISOString() ?? null, finishedAt: c.finishedAt?.toISOString() ?? null, targeted: c.targeted,
    approvedBy: c.approvedBy, approvedAt: c.approvedAt?.toISOString() ?? null, approvalThreshold,
    counts: {
      pending: (counts?.PENDING ?? 0) + (counts?.IN_FLIGHT ?? 0), sent: counts?.SENT ?? 0, skipped: counts?.SKIPPED ?? 0, failed: counts?.FAILED ?? 0,
    },
    createdBy: c.createdBy, updatedBy: c.updatedBy, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
  });

  async function countsOf(ids: string[]) {
    const out = new Map<string, Record<string, number>>();
    if (!ids.length) return out;
    const rows = await db.campaignDelivery.groupBy({ by: ["campaignId", "status"], where: { campaignId: { in: ids } }, _count: true });
    for (const r of rows) out.set(r.campaignId, { ...(out.get(r.campaignId) ?? {}), [r.status]: r._count });
    return out;
  }

  function staffOnly(p: Principal) {
    if (p.audience !== "ride-admin") throw forbidden("staff only");
  }
  function authorizeCity(p: Principal, cityId: string) {
    staffOnly(p);
    if (!can(p, "campaign:send", { cityId })) throw forbidden(`missing permission campaign:send in ${cityId}`);
  }

  async function load(p: Principal, id: string) {
    staffOnly(p);
    const c = await db.campaign.findUnique({ where: { id } });
    // a campaign of a city you don't cover doesn't exist for you
    if (!c || !can(p, "campaign:send", { cityId: c.cityId })) throw notFound("campaign");
    return c;
  }

  function check(input: CampaignInput) {
    if (input.channel === "SMS" && input.body.length > SMS_MAX) throw badRequest(`an SMS campaign is at most ${SMS_MAX} characters`, "body_too_long");
    if (input.channel === "PUSH" && !input.title?.trim()) throw badRequest("a push campaign needs a title", "title_required");
  }

  /** Who the segment reaches now (opt-outs excluded). */
  function segment(c: { cityId: string; audience: string; lastActiveDays: number | null; channel: string }) {
    const since = c.lastActiveDays ? new Date(now().getTime() - c.lastActiveDays * DAY) : null;
    return Prisma.sql`
      FROM campaign_audience a
      WHERE a.city_id = ${c.cityId} AND a.role = ${c.audience}
        ${since ? Prisma.sql`AND a.last_active_at >= ${since}::timestamptz` : Prisma.empty}
        AND NOT EXISTS (SELECT 1 FROM marketing_opt_out o WHERE o.user_id = a.user_id AND o.channel = ${c.channel})`;
  }

  async function audienceSize(c: { cityId: string; audience: string; lastActiveDays: number | null; channel: string }) {
    const [row] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(DISTINCT a.user_id) AS n ${segment(c)}`;
    return Number(row?.n ?? 0);
  }

  async function change(p: Principal, c: Campaign, from: CampaignStatus[], data: Prisma.CampaignUpdateManyMutationInput, action: string, reason: string) {
    if (!from.includes(c.status as CampaignStatus)) throw new AppError(409, `can't do that to a ${c.status.toLowerCase()} campaign`, "invalid_transition");
    return db.$transaction(async (tx) => {
      const n = await tx.campaign.updateMany({ where: { id: c.id, status: c.status }, data: { ...data, updatedBy: p.userId } });
      if (n.count !== 1) throw conflict("someone else changed this first; reload and try again", "invalid_state");
      if (data.status === "CANCELLED") {
        await tx.campaignDelivery.updateMany({ where: { campaignId: c.id, status: { in: ["PENDING", "IN_FLIGHT"] } }, data: { status: "SKIPPED", error: "cancelled" } });
      }
      await writeAudit(tx, { actorId: p.userId, action, resource: { type: "campaign", id: c.id }, outcome: "EXECUTED", reason });
      const next = await tx.campaign.findUniqueOrThrow({ where: { id: c.id } });
      return view(next, (await countsOf([c.id])).get(c.id));
    });
  }

  /** Send one delivery. Returns the final status, or throws to retry. */
  async function deliver(c: Campaign, userId: string): Promise<{ status: "SENT" | "SKIPPED"; error?: string }> {
    if (c.channel === "PUSH") {
      const devices = await db.deviceToken.findMany({ where: { userId }, select: { id: true, token: true } });
      if (!devices.length) return { status: "SKIPPED", error: "no_device" };
      let sent = 0;
      let lastError: unknown;
      for (const d of devices) {
        try {
          const r = await deps.push.send(d.token, { title: c.title ?? "Anbessa", body: c.body, data: { type: "campaign", campaignId: c.id } });
          if (r === "unregistered") await db.deviceToken.delete({ where: { id: d.id } }).catch(() => undefined);
          else sent++;
        } catch (err) {
          lastError = err;
        }
      }
      if (sent === 0 && lastError) throw lastError;
      return sent ? { status: "SENT" } : { status: "SKIPPED", error: "no_device" };
    }
    const phone = await deps.contacts.phoneOf(userId);
    if (!phone) return { status: "SKIPPED", error: "no_phone" };
    try {
      await deps.sms.send(phone, `Anbessa: ${c.body}`);
    } catch (err) {
      deps.logger.warn({ to: maskPhone(phone), campaignId: c.id, err: (err as Error).message }, "campaign SMS failed");
      throw err;
    }
    return { status: "SENT" };
  }

  return {
    async list(p: Principal, q: { cityId?: string; status?: CampaignStatus; limit: number }) {
      staffOnly(p);
      const cities = citiesWith(p, "campaign:send");
      if (cities !== "*" && cities.length === 0) throw forbidden("missing permission campaign:send");
      if (q.cityId) authorizeCity(p, q.cityId);
      const rows = await db.campaign.findMany({
        where: {
          ...(q.cityId ? { cityId: q.cityId } : cities === "*" ? {} : { cityId: { in: cities } }),
          ...(q.status ? { status: q.status } : {}),
        },
        orderBy: { createdAt: "desc" }, take: q.limit,
      });
      const counts = await countsOf(rows.map((c) => c.id));
      return { campaigns: rows.map((c) => view(c, counts.get(c.id))), quietHours: deps.quietHours };
    },

    async get(p: Principal, id: string) {
      const c = await load(p, id);
      const counts = (await countsOf([id])).get(id);
      const estimate = c.status === "DRAFT" || c.status === "SCHEDULED" || c.status === "AWAITING_APPROVAL" ? await audienceSize(c) : null;
      return { ...view(c, counts), audienceEstimate: estimate, quietNow: inQuietHours(now(), deps.quietHours) };
    },

    async audience(p: Principal, q: { cityId: string; audience: Audience; lastActiveDays?: number | null; channel: Channel }) {
      authorizeCity(p, q.cityId);
      return { count: await audienceSize({ ...q, lastActiveDays: q.lastActiveDays ?? null }) };
    },

    async create(p: Principal, input: CampaignInput) {
      authorizeCity(p, input.cityId);
      check(input);
      return db.$transaction(async (tx) => {
        const c = await tx.campaign.create({
          data: { cityId: input.cityId, audience: input.audience, lastActiveDays: input.lastActiveDays ?? null, channel: input.channel, title: input.title?.trim() || null, body: input.body.trim(), createdBy: p.userId, updatedBy: p.userId },
        });
        await writeAudit(tx, { actorId: p.userId, action: "campaign:send", resource: { type: "campaign", id: c.id }, outcome: "EXECUTED", reason: `draft ${c.channel} to ${c.audience.toLowerCase()}s in ${c.cityId}` });
        return view(c);
      });
    },

    async update(p: Principal, id: string, input: CampaignInput) {
      const c = await load(p, id);
      authorizeCity(p, input.cityId);
      check(input);
      if (c.status !== "DRAFT") throw new AppError(409, "only a draft can be edited", "not_draft");
      return change(p, c, ["DRAFT"], {
        cityId: input.cityId, audience: input.audience, lastActiveDays: input.lastActiveDays ?? null, channel: input.channel,
        title: input.title?.trim() || null, body: input.body.trim(),
      }, "campaign:send", "edited");
    },

    /** DRAFT → SCHEDULED; without `at`, now (the sender starts within a second, quiet hours permitting). */
    async schedule(p: Principal, id: string, at?: string) {
      const c = await load(p, id);
      const t = now().getTime();
      const when = at ? new Date(at) : new Date(t);
      if (when.getTime() < t - 60_000) throw badRequest("that time has passed", "in_past");
      if (when.getTime() > t + MAX_SCHEDULE_AHEAD_MS) throw badRequest("schedule at most 90 days ahead", "too_far");
      if (c.channel === "SMS" && !c.body) throw badRequest("empty message");
      const size = await audienceSize(c);
      if (needsSecondApprover(size, approvalThreshold)) {
        return change(p, c, ["DRAFT"], { status: "AWAITING_APPROVAL", scheduledAt: when, approvedBy: null, approvedAt: null }, "campaign:send",
          `scheduled for ${when.toISOString()}; ${size} recipients > ${approvalThreshold}, waiting for a second approver`);
      }
      return change(p, c, ["DRAFT"], { status: "SCHEDULED", scheduledAt: when }, "campaign:send", `scheduled for ${when.toISOString()}`);
    },

    /** AWAITING_APPROVAL → SCHEDULED, by a staff member other than the campaign's maker. */
    async approve(p: Principal, id: string) {
      const c = await load(p, id);
      if (c.status !== "AWAITING_APPROVAL") throw new AppError(409, "this campaign isn't waiting for approval", "invalid_transition");
      if (!canApprove(p.userId, c)) throw forbidden("a second staff member must approve this campaign", "second_approver_required");
      return change(p, c, ["AWAITING_APPROVAL"], { status: "SCHEDULED", approvedBy: p.userId, approvedAt: now() }, "campaign:send",
        `approved by a second staff member (created by ${c.createdBy}, scheduled by ${c.updatedBy})`);
    },

    async cancel(p: Principal, id: string) {
      const c = await load(p, id);
      return change(p, c, ["DRAFT", "AWAITING_APPROVAL", "SCHEDULED", "SENDING"], { status: "CANCELLED", finishedAt: now() }, "campaign:send", "cancelled");
    },

    /** The sender: start due campaigns, send one rate-limited batch, finish what's done. */
    async tick(intervalMs = 1000) {
      const t = now();
      let started = 0;
      const due = await db.campaign.findMany({ where: { status: "SCHEDULED", scheduledAt: { lte: t } }, orderBy: { scheduledAt: "asc" }, take: 10 });
      for (const c of due) {
        await db.$transaction(async (tx) => {
          const n = await tx.campaign.updateMany({ where: { id: c.id, status: "SCHEDULED" }, data: { status: "SENDING", startedAt: t } });
          if (n.count !== 1) return;
          const targeted = await tx.$executeRaw`
            INSERT INTO campaign_delivery (campaign_id, user_id, status, updated_at)
            SELECT DISTINCT ${c.id}::uuid, a.user_id, 'PENDING', ${t}::timestamptz ${segment(c)}
            ON CONFLICT DO NOTHING`;
          if (!c.approvedBy && needsSecondApprover(targeted, approvalThreshold)) {
            // the segment grew past the threshold since it was scheduled: back for approval
            await tx.campaignDelivery.deleteMany({ where: { campaignId: c.id } });
            await tx.campaign.update({ where: { id: c.id }, data: { status: "AWAITING_APPROVAL", startedAt: null, targeted: 0 } });
            await writeAudit(tx, { actorId: null, action: "campaign:send", resource: { type: "campaign", id: c.id }, outcome: "EXECUTED", reason: `${targeted} recipients > ${approvalThreshold}: waiting for a second approver` });
            return;
          }
          await tx.campaign.update({ where: { id: c.id }, data: { targeted } });
          started++;
        });
      }

      await db.campaignDelivery.updateMany({ where: { status: "IN_FLIGHT", updatedAt: { lt: new Date(t.getTime() - STALE_IN_FLIGHT_MS) } }, data: { status: "PENDING" } });

      let sent = 0;
      let failed = 0;
      if (!inQuietHours(t, deps.quietHours)) {
        const batch = Math.max(1, Math.floor((deps.sendPerSecond * intervalMs) / 1000));
        const claimed = await db.$queryRaw<{ campaign_id: string; user_id: string; attempts: number }[]>`
          UPDATE campaign_delivery d SET status = 'IN_FLIGHT', attempts = d.attempts + 1, updated_at = ${t}::timestamptz
          FROM (
            SELECT d2.campaign_id, d2.user_id FROM campaign_delivery d2 JOIN campaign c ON c.id = d2.campaign_id
            WHERE d2.status = 'PENDING' AND c.status = 'SENDING'
            ORDER BY c.started_at, d2.campaign_id, d2.user_id
            LIMIT ${batch}
            FOR UPDATE OF d2 SKIP LOCKED
          ) pick
          WHERE d.campaign_id = pick.campaign_id AND d.user_id = pick.user_id
          RETURNING d.campaign_id, d.user_id, d.attempts`;
        const campaigns = new Map<string, Campaign>();
        for (const row of claimed) {
          let c = campaigns.get(row.campaign_id);
          if (!c) {
            c = await db.campaign.findUniqueOrThrow({ where: { id: row.campaign_id } });
            campaigns.set(c.id, c);
          }
          const key = { campaignId_userId: { campaignId: row.campaign_id, userId: row.user_id } };
          try {
            const r = await deliver(c, row.user_id);
            await db.campaignDelivery.update({ where: key, data: { status: r.status, error: r.error ?? null, ...(r.status === "SENT" ? { sentAt: now() } : {}) } });
            if (r.status === "SENT") sent++;
          } catch (err) {
            const final = row.attempts >= MAX_DELIVERY_ATTEMPTS;
            if (final) failed++;
            await db.campaignDelivery.update({ where: key, data: { status: final ? "FAILED" : "PENDING", error: (err as Error).message.slice(0, 200) } });
          }
        }
      }

      // done: nothing left to send
      const sending = await db.campaign.findMany({ where: { status: "SENDING" }, select: { id: true } });
      let finished = 0;
      for (const { id } of sending) {
        const left = await db.campaignDelivery.count({ where: { campaignId: id, status: { in: ["PENDING", "IN_FLIGHT"] } } });
        if (left === 0) {
          const n = await db.campaign.updateMany({ where: { id, status: "SENDING" }, data: { status: "SENT", finishedAt: now() } });
          finished += n.count;
        }
      }
      if (started || finished || failed) deps.logger.info({ started, sent, failed, finished }, "campaigns");
      return { started, sent, failed, finished };
    },

    // ── the audience directory and opt-outs ─────────────────────────────────────

    /** A rider or driver was active in a city (from events); keeps the latest time. */
    async seen(userId: string, role: Audience, cityId: string, at: Date) {
      await db.$executeRaw`
        INSERT INTO campaign_audience (user_id, role, city_id, last_active_at) VALUES (${userId}::uuid, ${role}, ${cityId}, ${at}::timestamptz)
        ON CONFLICT (user_id, role, city_id) DO UPDATE SET last_active_at = GREATEST(campaign_audience.last_active_at, EXCLUDED.last_active_at)`;
    },

    async optOuts(userId: string) {
      const rows = await db.marketingOptOut.findMany({ where: { userId } });
      const off = new Set(rows.map((r) => r.channel));
      return { push: !off.has("PUSH"), sms: !off.has("SMS") };
    },

    async setOptOuts(userId: string, prefs: { push?: boolean; sms?: boolean }) {
      for (const [channel, on] of [["PUSH", prefs.push], ["SMS", prefs.sms]] as const) {
        if (on === undefined) continue;
        if (on) await db.marketingOptOut.deleteMany({ where: { userId, channel } });
        else await db.marketingOptOut.upsert({ where: { userId_channel: { userId, channel } }, create: { userId, channel }, update: {} });
      }
      return this.optOuts(userId);
    },
  };
}

export type CampaignService = ReturnType<typeof createCampaignService>;
