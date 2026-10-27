// Fare changes (workflow 15 part A). An operations manager proposes a new fare card for a city and
// vehicle type with a future `validFrom` (pricing:propose); another person with pricing:approve
// (operations manager of the city, or the finance manager) approves it. Approval inserts a
// `fare_rule` version; new quotes use it from `validFrom` (quotes already issued keep their price).
//
// Until a city and vehicle type has an approved rule, the live `fares.*` settings (platform-service,
// Settings → Fares) keep applying exactly as before; once it has one, the rules take over for it.
//
// Limits: validFrom at least 24 h after approval (drivers get notice), except an emergency change,
// which takes effect on approval (still maker–checker). A proposal not decided in 7 days expires.

import { can, type Permission, type Principal } from "@ride-app/shared-authz";
import type { SettingsReader } from "@ride-app/shared-settings";
import type { Db } from "../db.js";
import { Prisma, type FareChangeRequest, type FareRule } from "../generated/prisma/client.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { cityScope, raced, visibleOr404 } from "../lib/staff.js";
import { audit, writeOutbox } from "../outbox/outbox.js";
import { fareCard, price, type FareCard } from "../fares.js";

export const MIN_NOTICE_MS = 24 * 3_600_000;
export const APPROVAL_TTL_MS = 7 * 24 * 3_600_000;
const READERS: Permission[] = ["pricing:propose", "pricing:approve"];

/** Typical trips the impact preview prices with the old and the new card. */
export const SAMPLE_TRIPS = [
  { label: "3 km, 10 min", distanceMeters: 3_000, durationSeconds: 600 },
  { label: "8 km, 20 min", distanceMeters: 8_000, durationSeconds: 1_200 },
  { label: "15 km, 35 min", distanceMeters: 15_000, durationSeconds: 2_100 },
  { label: "25 km, 50 min", distanceMeters: 25_000, durationSeconds: 3_000 },
];

export interface FareProposal extends FareCard {
  cityId: string;
  vehicleType: string;
  validFrom?: string | null;
  emergency: boolean;
  reason: string;
}

const cardOf = (x: FareCard): FareCard => ({
  baseMinor: x.baseMinor, perKmMinor: x.perKmMinor, perMinMinor: x.perMinMinor, minFareMinor: x.minFareMinor, waitingPerMinMinor: x.waitingPerMinMinor,
});

export function impactOf(current: FareCard, next: FareCard) {
  const samples = SAMPLE_TRIPS.map((t) => {
    const before = price(current, t).fareMinor;
    const after = price(next, t).fareMinor;
    return { label: t.label, distanceMeters: t.distanceMeters, durationSeconds: t.durationSeconds, beforeMinor: before, afterMinor: after, deltaMinor: after - before, deltaPct: before ? Math.round(((after - before) / before) * 1000) / 10 : 0 };
  });
  const avg = samples.reduce((s, x) => s + x.deltaPct, 0) / samples.length;
  return { current, proposed: next, samples, averageChangePct: Math.round(avg * 10) / 10 };
}
export type Impact = ReturnType<typeof impactOf>;

export function changeView(c: FareChangeRequest & { rule?: FareRule | null }, now: Date) {
  const rule = c.rule ?? null;
  // the request's life after approval follows its rule
  const phase = c.status !== "APPROVED" || !rule ? c.status : rule.validFrom.getTime() > now.getTime() ? "SCHEDULED" : "APPROVED";
  return {
    id: c.id, cityId: c.cityId, vehicleType: c.vehicleType, card: cardOf(c), validFrom: (rule?.validFrom ?? c.validFrom)?.toISOString() ?? null,
    emergency: c.emergency, reason: c.reason, impact: c.impact as unknown as Impact, status: c.status, phase, makerId: c.makerId, checkerId: c.checkerId,
    decisionReason: c.decisionReason, createdAt: c.createdAt.toISOString(), decidedAt: c.decidedAt?.toISOString() ?? null,
    expiresAt: c.expiresAt.toISOString(), ruleId: rule?.id ?? null,
  };
}
export type FareChangeView = ReturnType<typeof changeView>;

export const ruleView = (r: FareRule) => ({
  id: r.id, cityId: r.cityId, vehicleType: r.vehicleType, card: cardOf(r), validFrom: r.validFrom.toISOString(),
  changeRequestId: r.changeRequestId, proposedBy: r.proposedBy, approvedBy: r.approvedBy, activatedAt: r.activatedAt?.toISOString() ?? null,
});

export function createRuleService(deps: { db: Db; settings: SettingsReader; now: () => Date; onChange: () => void }) {
  const { db, now } = deps;

  /** The card in force now: the latest approved rule, else the live settings; null = no fares for this type. */
  async function currentCard(cityId: string, vehicleType: string): Promise<{ card: FareCard; source: "RULE" | "SETTINGS"; rule: FareRule | null } | null> {
    const rule = await db.fareRule.findFirst({ where: { cityId, vehicleType, validFrom: { lte: now() } }, orderBy: { validFrom: "desc" } });
    if (rule) return { card: cardOf(rule), source: "RULE", rule };
    const card = fareCard(deps.settings, vehicleType, cityId);
    return card ? { card, source: "SETTINGS", rule: null } : null;
  }

  async function load(p: Principal, id: string) {
    const c = await db.fareChangeRequest.findUnique({ where: { id }, include: { rule: true } });
    if (!c) throw notFound("fare change");
    visibleOr404(p, READERS, c.cityId, "fare change");
    return c;
  }

  return {
    currentCard,

    /** Every vehicle type's card in the city, where it comes from, and the scheduled and past versions. */
    async overview(p: Principal, cityId: string, vehicleTypes: string[]) {
      cityScope(p, READERS, cityId);
      const [rules, pending] = await Promise.all([
        db.fareRule.findMany({ where: { cityId }, orderBy: { validFrom: "desc" } }),
        db.fareChangeRequest.count({ where: { cityId, status: "PENDING" } }),
      ]);
      const t = now().getTime();
      const types = [...new Set([...vehicleTypes, ...rules.map((r) => r.vehicleType)])];
      const fares = await Promise.all(types.map(async (vehicleType) => {
        const cur = await currentCard(cityId, vehicleType);
        const mine = rules.filter((r) => r.vehicleType === vehicleType);
        return {
          vehicleType, offered: vehicleTypes.includes(vehicleType),
          current: cur ? { ...cur.card, source: cur.source, ruleId: cur.rule?.id ?? null, validFrom: cur.rule?.validFrom.toISOString() ?? null } : null,
          scheduled: mine.filter((r) => r.validFrom.getTime() > t).reverse().map(ruleView),
          past: mine.filter((r) => r.validFrom.getTime() <= t && r.id !== cur?.rule?.id).map(ruleView),
        };
      }));
      return { cityId, fares, pendingChanges: pending, minNoticeHours: MIN_NOTICE_MS / 3_600_000 };
    },

    async list(p: Principal, q: { cityId?: string; status?: FareChangeRequest["status"]; vehicleType?: string; limit: number; before?: string }) {
      const cities = cityScope(p, READERS, q.cityId);
      const rows = await db.fareChangeRequest.findMany({
        where: {
          ...(cities === "*" ? {} : { cityId: { in: cities } }), ...(q.status ? { status: q.status } : {}), ...(q.vehicleType ? { vehicleType: q.vehicleType } : {}),
          ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}),
        },
        include: { rule: true }, orderBy: { createdAt: "desc" }, take: q.limit,
      });
      return { changes: rows.map((c) => changeView(c, now())), next: rows.length === q.limit ? rows.at(-1)!.createdAt.toISOString() : null };
    },

    async get(p: Principal, id: string) {
      return changeView(await load(p, id), now());
    },

    /** The impact of a card without proposing it (the propose form's preview). */
    async preview(p: Principal, cityId: string, vehicleType: string, next: FareCard) {
      if (!can(p, "pricing:propose", { cityId })) throw forbidden(`missing permission pricing:propose in ${cityId}`);
      const cur = await currentCard(cityId, vehicleType);
      if (!cur) throw badRequest(`no fares for vehicle type ${vehicleType}`, "unknown_vehicle_type");
      return { source: cur.source, impact: impactOf(cur.card, cardOf(next)) };
    },

    async propose(p: Principal, input: FareProposal) {
      if (!can(p, "pricing:propose", { cityId: input.cityId })) throw forbidden(`missing permission pricing:propose in ${input.cityId}`);
      const t = now();
      const validFrom = input.validFrom ? new Date(input.validFrom) : null;
      if (!input.emergency) {
        if (!validFrom) throw badRequest("validFrom is required (at least 24 h ahead)", "valid_from_required");
        if (validFrom.getTime() < t.getTime() + MIN_NOTICE_MS) throw badRequest("new fares start at least 24 hours after approval; use an emergency change to fix a wrong fare now", "valid_from_too_soon");
      } else if (validFrom && validFrom.getTime() < t.getTime()) {
        throw badRequest("validFrom is in the past", "valid_from_in_past");
      }
      const cur = await currentCard(input.cityId, input.vehicleType);
      if (!cur) throw badRequest(`no fares for vehicle type ${input.vehicleType}`, "unknown_vehicle_type");
      const next = cardOf(input);
      const impact = impactOf(cur.card, next);
      try {
        return await db.$transaction(async (tx) => {
          const c = await tx.fareChangeRequest.create({
            data: {
              cityId: input.cityId, vehicleType: input.vehicleType, ...next, validFrom, emergency: input.emergency, reason: input.reason.trim(),
              impact: impact as unknown as Prisma.InputJsonValue, makerId: p.userId, expiresAt: new Date(t.getTime() + APPROVAL_TTL_MS),
            },
          });
          await writeOutbox(tx, audit({
            actorId: p.userId, action: "pricing:propose", resource: { type: "fare_change", id: c.id }, outcome: "PENDING_APPROVAL",
            reason: `${input.vehicleType}@${input.cityId}${input.emergency ? " (emergency)" : ""}: ${input.reason.trim()}`,
          }));
          return changeView({ ...c, rule: null }, t);
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw conflict("a change for this vehicle type is already waiting for approval", "already_pending");
        throw err;
      }
    },

    async approve(p: Principal, id: string, note?: string) {
      const c = await load(p, id);
      if (!can(p, "pricing:approve", { cityId: c.cityId })) throw forbidden(`missing permission pricing:approve in ${c.cityId}`);
      if (c.makerId === p.userId) throw forbidden("maker and checker must be different people", "maker_is_checker");
      if (c.status !== "PENDING") throw conflict(`this change is ${c.status.toLowerCase()}`, "not_pending");
      const t = now();
      if (c.expiresAt <= t) throw conflict("this change expired", "expired");
      let validFrom = c.validFrom ?? t;
      if (c.emergency) {
        if (validFrom.getTime() < t.getTime()) validFrom = t;
      } else if (validFrom.getTime() < t.getTime() + MIN_NOTICE_MS) {
        throw conflict("new fares start at least 24 hours after approval; propose a later time", "valid_from_too_soon");
      }
      const activeNow = validFrom.getTime() <= t.getTime();
      try {
        const out = await db.$transaction(async (tx) => {
          const n = await tx.fareChangeRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: "APPROVED", checkerId: p.userId, decidedAt: t, decisionReason: note?.trim() || null } });
          if (n.count !== 1) throw raced();
          const rule = await tx.fareRule.create({
            data: {
              cityId: c.cityId, vehicleType: c.vehicleType, ...cardOf(c), validFrom, changeRequestId: c.id, proposedBy: c.makerId, approvedBy: p.userId,
              ...(activeNow ? { activatedAt: t } : {}),
            },
          });
          await writeOutbox(tx,
            {
              topic: "pricing.rule_scheduled", key: c.cityId,
              payload: { ruleId: rule.id, changeRequestId: c.id, cityId: c.cityId, vehicleType: c.vehicleType, validFrom: validFrom.toISOString(), ...cardOf(c), proposedBy: c.makerId, approvedBy: p.userId, emergency: c.emergency },
            },
            ...(activeNow ? [{ topic: "pricing.rule_activated" as const, key: c.cityId, payload: { ruleId: rule.id, cityId: c.cityId, vehicleType: c.vehicleType, validFrom: validFrom.toISOString() } }] : []),
            audit({ actorId: p.userId, action: "pricing:approve", resource: { type: "fare_change", id }, outcome: "EXECUTED", reason: `${c.vehicleType}@${c.cityId} from ${validFrom.toISOString()}${note ? ` · ${note.trim()}` : ""}` }),
          );
          return changeView({ ...(await tx.fareChangeRequest.findUniqueOrThrow({ where: { id } })), rule }, t);
        });
        deps.onChange();
        return out;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw conflict("another version already starts at exactly this time", "version_exists");
        throw err;
      }
    },

    async reject(p: Principal, id: string, reason: string) {
      const c = await load(p, id);
      if (!can(p, "pricing:approve", { cityId: c.cityId })) throw forbidden(`missing permission pricing:approve in ${c.cityId}`);
      if (c.makerId === p.userId) throw forbidden("maker and checker must be different people; withdraw your own proposal instead", "maker_is_checker");
      return decide(p, c, "REJECTED", reason, "pricing:approve");
    },

    async cancel(p: Principal, id: string) {
      const c = await load(p, id);
      if (c.makerId !== p.userId) throw forbidden("only the person who proposed it can withdraw it");
      return decide(p, c, "CANCELLED", null, "pricing:propose");
    },

    /** Expire undecided proposals; mark rules whose time came as active (pricing.rule_activated). */
    async sweep() {
      const t = now();
      const expired = await db.$transaction(async (tx) => {
        const rows = await tx.fareChangeRequest.findMany({ where: { status: "PENDING", expiresAt: { lte: t } }, select: { id: true } });
        if (!rows.length) return 0;
        const n = await tx.fareChangeRequest.updateMany({ where: { id: { in: rows.map((r) => r.id) }, status: "PENDING" }, data: { status: "EXPIRED", decidedAt: t } });
        await writeOutbox(tx, ...rows.map((r) => audit({ actorId: null, action: "pricing:expire", resource: { type: "fare_change", id: r.id }, outcome: "EXECUTED", reason: "not decided in 7 days" })));
        return n.count;
      });
      const due = await db.fareRule.findMany({ where: { activatedAt: null, validFrom: { lte: t } }, orderBy: { validFrom: "asc" } });
      let activated = 0;
      for (const r of due) {
        await db.$transaction(async (tx) => {
          const n = await tx.fareRule.updateMany({ where: { id: r.id, activatedAt: null }, data: { activatedAt: t } });
          if (n.count !== 1) return;
          activated++;
          await writeOutbox(tx, { topic: "pricing.rule_activated", key: r.cityId, payload: { ruleId: r.id, cityId: r.cityId, vehicleType: r.vehicleType, validFrom: r.validFrom.toISOString() } });
        });
      }
      if (activated) deps.onChange();
      return { expired, activated };
    },
  };

  async function decide(p: Principal, c: FareChangeRequest, status: "REJECTED" | "CANCELLED", reason: string | null, action: string) {
    if (c.status !== "PENDING") throw conflict(`this change is ${c.status.toLowerCase()}`, "not_pending");
    const t = now();
    return db.$transaction(async (tx) => {
      const n = await tx.fareChangeRequest.updateMany({ where: { id: c.id, status: "PENDING" }, data: { status, checkerId: status === "REJECTED" ? p.userId : null, decidedAt: t, decisionReason: reason?.trim() || null } });
      if (n.count !== 1) throw raced();
      await writeOutbox(tx, audit({ actorId: p.userId, action, resource: { type: "fare_change", id: c.id }, outcome: status === "REJECTED" ? "REJECTED" : "EXECUTED", reason: `${status.toLowerCase()}${reason ? `: ${reason.trim()}` : ""}` }));
      return changeView({ ...(await tx.fareChangeRequest.findUniqueOrThrow({ where: { id: c.id } })), rule: null }, t);
    });
  }
}

export type RuleService = ReturnType<typeof createRuleService>;
