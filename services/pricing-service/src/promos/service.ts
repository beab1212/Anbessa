// Promotions (workflow 15 part D). Marketing creates a code (promo:manage, per city); it starts as
// DRAFT. Activation above PROMO_APPROVAL_THRESHOLD_MINOR needs someone else holding
// incentive:approve (finance). Riders apply a code at estimate time: every discounted quote holds a
// reservation; trip-service reading the quote to book makes it BOOKED; trip.completed redeems it
// (promo.redeemed), trip.cancelled releases it. One promo per trip (a quote has at most one).

import { can, type Permission, type Principal } from "@ride-app/shared-authz";
import type { Logger } from "@ride-app/shared-utils";
import type { Db } from "../db.js";
import { Prisma, type Promo, type PromoReservation } from "../generated/prisma/client.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { cityScope, citiesWithAny, invalidTransition, isStaff, raced } from "../lib/staff.js";
import { audit, writeOutbox, type PricingEvent } from "../outbox/outbox.js";
import { discountFor, type PromoRejection } from "./discount.js";

const READERS: Permission[] = ["promo:manage", "incentive:approve"];
/** a booked discount not completed within this is given back (no trip lasts this long) */
const BOOKED_TTL_MS = 24 * 3_600_000;

export interface PromoDeps {
  db: Db;
  logger: Logger;
  now: () => Date;
  approvalThresholdMinor: number;
}

export interface PromoInput {
  code: string;
  name: string;
  description?: string | null;
  type: "PERCENT_OFF" | "AMOUNT_OFF";
  percentOff?: number | null;
  amountOffMinor?: number | null;
  maxDiscountMinor?: number | null;
  cityIds: string[];
  vehicleTypes: string[];
  startsAt: string;
  endsAt: string;
  perUserLimit: number;
  maxRedemptions?: number | null;
  budgetMinor: number;
  fundedBy: "PLATFORM" | "PARTNER";
}

/** A promo as staff see it, with what is promised but not yet redeemed. */
export function promoView(x: Promo, bookedMinor = 0, bookedCount = 0, threshold?: number) {
  return {
    id: x.id, code: x.code, name: x.name, description: x.description, type: x.type,
    percentOff: x.percentOff, amountOffMinor: x.amountOffMinor, maxDiscountMinor: x.maxDiscountMinor,
    cityIds: x.cityIds, vehicleTypes: x.vehicleTypes, startsAt: x.startsAt.toISOString(), endsAt: x.endsAt.toISOString(),
    perUserLimit: x.perUserLimit, maxRedemptions: x.maxRedemptions, budgetMinor: x.budgetMinor, spentMinor: x.spentMinor,
    redemptionCount: x.redemptionCount, bookedMinor, bookedCount, fundedBy: x.fundedBy, status: x.status,
    ...(threshold !== undefined ? { needsFinanceApproval: x.budgetMinor > threshold } : {}),
    createdBy: x.createdBy, activatedBy: x.activatedBy, activatedAt: x.activatedAt?.toISOString() ?? null,
    createdAt: x.createdAt.toISOString(), updatedAt: x.updatedAt.toISOString(),
  };
}
export type PromoView = ReturnType<typeof promoView>;

/** What the rider sees about a code (no budget, no counters). */
export function publicPromo(x: Promo) {
  return {
    code: x.code, name: x.name, description: x.description, type: x.type, percentOff: x.percentOff, amountOffMinor: x.amountOffMinor,
    maxDiscountMinor: x.maxDiscountMinor, vehicleTypes: x.vehicleTypes, endsAt: x.endsAt.toISOString(),
  };
}

export const normalizeCode = (code: string) => code.trim().toUpperCase();

export function createPromoService(deps: PromoDeps) {
  const { db, now } = deps;

  /** May change it: promo:manage in every city of the promo (a promo for every city needs a global role). */
  function canManage(p: Principal, cityIds: string[]) {
    if (!isStaff(p)) return false;
    return cityIds.length === 0 ? can(p, "promo:manage") : cityIds.every((cityId) => can(p, "promo:manage", { cityId }));
  }
  /** A promo for every city is visible to anyone holding a reader permission somewhere. */
  function visible(p: Principal, cityIds: string[]) {
    if (!isStaff(p)) return false;
    if (cityIds.length === 0) {
      const cities = citiesWithAny(p, READERS);
      return cities === "*" || cities.length > 0;
    }
    return READERS.some((perm) => cityIds.some((cityId) => can(p, perm, { cityId })));
  }

  async function load(p: Principal, id: string) {
    const x = await db.promo.findUnique({ where: { id } });
    if (!x || !visible(p, x.cityIds)) throw notFound("promo");
    return x;
  }

  async function open(promoIds: string[]) {
    if (promoIds.length === 0) return new Map<string, { minor: number; count: number }>();
    const rows = await db.promoReservation.groupBy({ by: ["promoId"], where: { promoId: { in: promoIds }, status: "BOOKED" }, _sum: { discountMinor: true }, _count: true });
    return new Map(rows.map((r) => [r.promoId, { minor: r._sum.discountMinor ?? 0, count: r._count }]));
  }

  async function view(x: Promo) {
    const b = (await open([x.id])).get(x.id);
    return promoView(x, b?.minor ?? 0, b?.count ?? 0, deps.approvalThresholdMinor);
  }

  function checkInput(input: PromoInput) {
    if (input.type === "PERCENT_OFF" && !input.percentOff) throw badRequest("percentOff is required for PERCENT_OFF");
    if (input.type === "AMOUNT_OFF" && !input.amountOffMinor) throw badRequest("amountOffMinor is required for AMOUNT_OFF");
    if (new Date(input.endsAt).getTime() <= new Date(input.startsAt).getTime()) throw badRequest("endsAt must be after startsAt", "invalid_window");
  }

  const data = (input: PromoInput) => ({
    code: normalizeCode(input.code), name: input.name.trim(), description: input.description?.trim() || null, type: input.type,
    percentOff: input.type === "PERCENT_OFF" ? (input.percentOff ?? null) : null,
    amountOffMinor: input.type === "AMOUNT_OFF" ? (input.amountOffMinor ?? null) : null,
    maxDiscountMinor: input.maxDiscountMinor ?? null, cityIds: [...new Set(input.cityIds)], vehicleTypes: [...new Set(input.vehicleTypes)],
    startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt), perUserLimit: input.perUserLimit,
    maxRedemptions: input.maxRedemptions ?? null, budgetMinor: input.budgetMinor, fundedBy: input.fundedBy,
  });

  const duplicate = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

  async function transition(p: Principal, id: string, from: Promo["status"][], to: Promo["status"], action: string, extra: (x: Promo) => { data?: Prisma.PromoUpdateManyMutationInput; events?: PricingEvent[] } = () => ({})) {
    const x = await load(p, id);
    if (!canManage(p, x.cityIds)) throw forbidden("missing permission promo:manage for every city of this promo");
    if (!from.includes(x.status)) throw invalidTransition(x.status, to);
    const more = extra(x);
    return db.$transaction(async (tx) => {
      const n = await tx.promo.updateMany({ where: { id, status: x.status }, data: { status: to, ...more.data } });
      if (n.count !== 1) throw raced();
      await writeOutbox(tx, ...(more.events ?? []), audit({ actorId: p.userId, action, resource: { type: "promo", id }, outcome: "EXECUTED", reason: `${x.code}: ${x.status} → ${to}` }));
      return view(await tx.promo.findUniqueOrThrow({ where: { id } }));
    });
  }

  return {
    canManage,

    async list(p: Principal, q: { cityId?: string; status?: Promo["status"]; limit: number }) {
      const cities = cityScope(p, READERS, q.cityId);
      const rows = await db.promo.findMany({
        where: {
          ...(q.status ? { status: q.status } : {}),
          ...(cities === "*" ? {} : { OR: [{ cityIds: { hasSome: cities } }, { cityIds: { isEmpty: true } }] }),
        },
        orderBy: { createdAt: "desc" }, take: q.limit,
      });
      const booked = await open(rows.map((r) => r.id));
      return { promos: rows.map((x) => promoView(x, booked.get(x.id)?.minor ?? 0, booked.get(x.id)?.count ?? 0, deps.approvalThresholdMinor)), approvalThresholdMinor: deps.approvalThresholdMinor };
    },

    async get(p: Principal, id: string) {
      return view(await load(p, id));
    },

    async create(p: Principal, input: PromoInput) {
      if (!canManage(p, input.cityIds)) throw forbidden(input.cityIds.length ? "missing permission promo:manage in every city of this promo" : "a promo for every city needs promo:manage in every city");
      checkInput(input);
      try {
        return await db.$transaction(async (tx) => {
          const x = await tx.promo.create({ data: { ...data(input), createdBy: p.userId } });
          await writeOutbox(tx, audit({ actorId: p.userId, action: "promo:manage", resource: { type: "promo", id: x.id }, outcome: "EXECUTED", reason: `created ${x.code} (draft)` }));
          return promoView(x, 0, 0, deps.approvalThresholdMinor);
        });
      } catch (err) {
        if (duplicate(err)) throw conflict("this code is already used by another promo", "code_taken");
        throw err;
      }
    },

    /** Drafts only: an active promo is paused, archived and replaced instead. */
    async update(p: Principal, id: string, input: PromoInput) {
      const x = await load(p, id);
      if (!canManage(p, x.cityIds) || !canManage(p, input.cityIds)) throw forbidden("missing permission promo:manage for every city of this promo");
      if (x.status !== "DRAFT") throw conflict("only a draft can be edited", "not_draft");
      checkInput(input);
      try {
        return await db.$transaction(async (tx) => {
          const n = await tx.promo.updateMany({ where: { id, status: "DRAFT" }, data: data(input) });
          if (n.count !== 1) throw raced();
          await writeOutbox(tx, audit({ actorId: p.userId, action: "promo:manage", resource: { type: "promo", id }, outcome: "EXECUTED", reason: `edited ${normalizeCode(input.code)}` }));
          return promoView(await tx.promo.findUniqueOrThrow({ where: { id } }), 0, 0, deps.approvalThresholdMinor);
        });
      } catch (err) {
        if (duplicate(err)) throw conflict("this code is already used by another promo", "code_taken");
        throw err;
      }
    },

    /** DRAFT → ACTIVE. A budget above the threshold needs a finance approver who isn't the creator. */
    async activate(p: Principal, id: string) {
      const x = await load(p, id);
      if (x.status !== "DRAFT") throw invalidTransition(x.status, "ACTIVE");
      if (x.endsAt.getTime() <= now().getTime()) throw conflict("this promo has already ended; change its dates first", "promo_ended");
      const big = x.budgetMinor > deps.approvalThresholdMinor;
      if (big) {
        const approver = x.cityIds.length === 0 ? can(p, "incentive:approve") : x.cityIds.every((cityId) => can(p, "incentive:approve", { cityId }));
        if (!approver) throw forbidden("a budget this large is activated by a finance manager (incentive:approve)", "approval_required");
        if (x.createdBy === p.userId) throw forbidden("maker and checker must be different people", "maker_is_checker");
      } else if (!canManage(p, x.cityIds)) {
        throw forbidden("missing permission promo:manage for every city of this promo");
      }
      const at = now();
      return db.$transaction(async (tx) => {
        const n = await tx.promo.updateMany({ where: { id, status: "DRAFT" }, data: { status: "ACTIVE", activatedBy: p.userId, activatedAt: at } });
        if (n.count !== 1) throw raced();
        await writeOutbox(tx,
          {
            topic: "promo.activated", key: id,
            payload: { promoId: id, code: x.code, cityIds: x.cityIds, budgetMinor: x.budgetMinor, startsAt: x.startsAt.toISOString(), endsAt: x.endsAt.toISOString(), fundedBy: x.fundedBy, byUserId: p.userId },
          },
          audit({ actorId: p.userId, action: big ? "incentive:approve" : "promo:manage", resource: { type: "promo", id }, outcome: "EXECUTED", reason: `activated ${x.code} (budget ${x.budgetMinor})` }),
        );
        return view(await tx.promo.findUniqueOrThrow({ where: { id } }));
      });
    },

    pause: (p: Principal, id: string) => transition(p, id, ["ACTIVE"], "PAUSED", "promo:manage"),
    resume: (p: Principal, id: string) => transition(p, id, ["PAUSED"], "ACTIVE", "promo:manage", (x) => {
      if (x.endsAt.getTime() <= now().getTime()) throw conflict("this promo has ended", "promo_ended");
      return {};
    }),
    archive: (p: Principal, id: string) => transition(p, id, ["DRAFT", "PAUSED", "EXPIRED", "EXHAUSTED"], "ARCHIVED", "promo:manage"),

    async redemptions(p: Principal, id: string, q: { limit: number; before?: string }) {
      await load(p, id);
      const rows = await db.promoRedemption.findMany({
        where: { promoId: id, ...(q.before ? { redeemedAt: { lt: new Date(q.before) } } : {}) },
        orderBy: { redeemedAt: "desc" }, take: q.limit,
      });
      return {
        redemptions: rows.map((r) => ({ id: r.id, tripId: r.tripId, userId: r.userId, cityId: r.cityId, fareMinor: r.fareMinor, discountMinor: r.discountMinor, redeemedAt: r.redeemedAt.toISOString() })),
        next: rows.length === q.limit ? rows.at(-1)!.redeemedAt.toISOString() : null,
      };
    },

    // ── riders ────────────────────────────────────────────────────────────────

    /**
     * Can `userId` use `code` in `cityId` now? Returns the promo and how much budget is left,
     * or why not. Vehicle types are checked per quote by the caller.
     */
    async offer(code: string, userId: string, cityId: string | undefined): Promise<{ promo: Promo; availableMinor: number } | { rejected: PromoRejection; promo?: Promo }> {
      const x = await db.promo.findUnique({ where: { code: normalizeCode(code) } });
      if (!x || x.status === "DRAFT" || x.status === "ARCHIVED") return { rejected: "unknown_code" };
      const t = now().getTime();
      if (x.status === "EXHAUSTED") return { rejected: "exhausted", promo: x };
      if (x.status === "EXPIRED" || x.endsAt.getTime() <= t) return { rejected: "expired", promo: x };
      if (x.status !== "ACTIVE") return { rejected: "not_active", promo: x };
      if (x.startsAt.getTime() > t) return { rejected: "not_started", promo: x };
      if (cityId && x.cityIds.length && !x.cityIds.includes(cityId)) return { rejected: "not_in_city", promo: x };
      const [mine, booked] = await Promise.all([
        db.promoReservation.count({ where: { promoId: x.id, userId, status: { in: ["BOOKED", "REDEEMED"] } } }),
        db.promoReservation.aggregate({ where: { promoId: x.id, status: "BOOKED" }, _sum: { discountMinor: true }, _count: true }),
      ]);
      if (mine >= x.perUserLimit) return { rejected: "limit_reached", promo: x };
      if (x.maxRedemptions !== null && x.redemptionCount + booked._count >= x.maxRedemptions) return { rejected: "exhausted", promo: x };
      const availableMinor = x.budgetMinor - x.spentMinor - (booked._sum.discountMinor ?? 0);
      if (availableMinor <= 0) return { rejected: "exhausted", promo: x };
      return { promo: x, availableMinor };
    },

    /** The discount on one quote's fare, within what's left of the budget; 0 when the type isn't eligible. */
    discount(x: Promo, availableMinor: number, vehicleType: string, fareMinor: number) {
      if (x.vehicleTypes.length && !x.vehicleTypes.includes(vehicleType)) return 0;
      return Math.min(discountFor(x, fareMinor), availableMinor);
    },

    /** Hold the discounts of one estimate (one row per discounted quote). */
    async hold(rows: { promoId: string; quoteId: string; userId: string; cityId: string; vehicleType: string; fareMinor: number; discountMinor: number; expiresAt: Date }[]) {
      if (rows.length) await db.promoReservation.createMany({ data: rows });
    },

    /**
     * trip-service is reading the quote to book a trip: HELD → BOOKED. Returns false when the
     * discount can no longer be given (the rider booked their last allowed use with another quote,
     * the promo was paused, ran out, or the reservation expired); the quote is then served without it.
     */
    async book(quoteId: string): Promise<boolean> {
      const r = await db.promoReservation.findUnique({ where: { quoteId }, include: { promo: true } });
      if (!r) return false;
      if (r.status === "BOOKED") return true;
      if (r.status !== "HELD" || r.expiresAt.getTime() <= now().getTime() || r.promo.status !== "ACTIVE") return false;
      return db.$transaction(async (tx) => {
        // the promo row is the lock for its counters
        await tx.$queryRaw`SELECT id FROM promo WHERE id = ${r.promoId}::uuid FOR UPDATE`;
        const mine = await tx.promoReservation.count({ where: { promoId: r.promoId, userId: r.userId, status: { in: ["BOOKED", "REDEEMED"] } } });
        if (mine >= r.promo.perUserLimit) {
          await tx.promoReservation.updateMany({ where: { id: r.id, status: "HELD" }, data: { status: "RELEASED" } });
          return false;
        }
        const t = now();
        const n = await tx.promoReservation.updateMany({ where: { id: r.id, status: "HELD" }, data: { status: "BOOKED", bookedAt: t, expiresAt: new Date(t.getTime() + BOOKED_TTL_MS) } });
        return n.count === 1;
      });
    },

    /** trip.completed: redeem the trip's booked discount (idempotent per trip). */
    async redeem(e: { tripId: string; riderId: string; cityId: string; vehicleType: string; fareMinor: number; currency: string; completedAt?: string; quoteId?: string; promoDiscountMinor?: number }) {
      return db.$transaction(async (tx) => {
        if (await tx.promoRedemption.findUnique({ where: { tripId: e.tripId } })) return null;
        const r = await findBooked(tx, e);
        if (!r) return null;
        await tx.$queryRaw`SELECT id FROM promo WHERE id = ${r.promoId}::uuid FOR UPDATE`;
        const x = await tx.promo.findUniqueOrThrow({ where: { id: r.promoId } });
        const discountMinor = Math.max(0, Math.min(e.promoDiscountMinor ?? r.discountMinor, e.fareMinor));
        const red = await tx.promoRedemption.create({
          data: { promoId: x.id, reservationId: r.id, tripId: e.tripId, userId: e.riderId, cityId: e.cityId, fareMinor: e.fareMinor, discountMinor },
        });
        await tx.promoReservation.update({ where: { id: r.id }, data: { status: "REDEEMED", tripId: e.tripId } });
        const spentMinor = x.spentMinor + discountMinor;
        const redemptionCount = x.redemptionCount + 1;
        const exhausted = (x.status === "ACTIVE" || x.status === "PAUSED") && (spentMinor >= x.budgetMinor || (x.maxRedemptions !== null && redemptionCount >= x.maxRedemptions));
        await tx.promo.update({ where: { id: x.id }, data: { spentMinor, redemptionCount, ...(exhausted ? { status: "EXHAUSTED" } : {}) } });
        const events: PricingEvent[] = [{
          topic: "promo.redeemed", key: e.tripId,
          payload: {
            promoId: x.id, code: x.code, redemptionId: red.id, tripId: e.tripId, riderId: e.riderId, cityId: e.cityId, quoteId: r.quoteId,
            fareMinor: e.fareMinor, discountMinor, currency: e.currency, fundedBy: x.fundedBy,
          },
        }];
        if (exhausted) {
          events.push({ topic: "promo.exhausted", key: x.id, payload: { promoId: x.id, code: x.code, spentMinor, budgetMinor: x.budgetMinor, redemptionCount } });
          deps.logger.info({ promoId: x.id, code: x.code }, "promo exhausted");
        }
        await writeOutbox(tx, ...events);
        return { redemptionId: red.id, discountMinor };
      });
    },

    /** trip.cancelled: give the booked discount back. */
    async release(e: { tripId: string; riderId: string; cityId: string; quoteId?: string }) {
      const r = await findBooked(db, e);
      if (!r) return false;
      const n = await db.promoReservation.updateMany({ where: { id: r.id, status: { in: ["HELD", "BOOKED"] } }, data: { status: "RELEASED", tripId: e.tripId } });
      return n.count === 1;
    },

    /** Promos past their end → EXPIRED; reservations past their time → EXPIRED. */
    async sweep() {
      const t = now();
      const ended = await db.promo.findMany({ where: { status: { in: ["ACTIVE", "PAUSED"] }, endsAt: { lte: t } }, select: { id: true, code: true, status: true } });
      for (const x of ended) {
        await db.$transaction(async (tx) => {
          const n = await tx.promo.updateMany({ where: { id: x.id, status: x.status }, data: { status: "EXPIRED" } });
          if (n.count) await writeOutbox(tx, audit({ actorId: null, action: "promo:expire", resource: { type: "promo", id: x.id }, outcome: "EXECUTED", reason: `${x.code} ended` }));
        });
      }
      const expired = await db.promoReservation.updateMany({ where: { status: { in: ["HELD", "BOOKED"] }, expiresAt: { lte: t } }, data: { status: "EXPIRED" } });
      return { promosExpired: ended.length, reservationsExpired: expired.count };
    },
  };

  /**
   * The rider's booked reservation for this trip: by quote id when the event carries it, else the
   * most recent one booked in that city (and vehicle type, when known) before the trip ended.
   */
  async function findBooked(tx: Prisma.TransactionClient | Db, e: { riderId: string; cityId: string; vehicleType?: string; quoteId?: string; completedAt?: string }): Promise<PromoReservation | null> {
    if (e.quoteId) {
      const r = await tx.promoReservation.findUnique({ where: { quoteId: e.quoteId } });
      return r && (r.status === "BOOKED" || r.status === "HELD") && r.userId === e.riderId ? r : null;
    }
    return tx.promoReservation.findFirst({
      where: {
        userId: e.riderId, cityId: e.cityId, status: "BOOKED",
        ...(e.vehicleType ? { vehicleType: e.vehicleType } : {}),
        ...(e.completedAt ? { bookedAt: { lte: new Date(e.completedAt) } } : {}),
      },
      orderBy: { bookedAt: "desc" },
    });
  }
}

export type PromoService = ReturnType<typeof createPromoService>;
