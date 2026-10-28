// Promotions (workflow 15 part D). Marketing creates a code (promo:manage, per city); it starts as
// DRAFT. Activation above PROMO_APPROVAL_THRESHOLD_MINOR needs someone else holding
// incentive:approve (finance); the threshold is checked against everything the creator and the
// promo's cities already have live, so a large budget can't be split into small promos.
// Riders apply a code at estimate time: every discounted quote holds a reservation; trip-service
// reading the quote to book a trip makes it BOOKED for that one trip id (within the promo's budget
// and redemption limit, counting what is already booked); trip.completed of that trip redeems it
// (promo.redeemed), trip.cancelled of that trip releases it for good. One promo per trip.

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

/** What is already live (ACTIVE or PAUSED, full budgets) next to a promo being activated. */
export interface LiveBudgets {
  /** promos of the same creator */
  creatorMinor: number;
  /** per city of the promo ("*" for a promo in every city: everything live); a promo in every city counts in each */
  byCity: Record<string, number>;
}

/** Sum the live promos that share a creator or a city with `x`. */
export function sumLiveBudgets(x: Pick<Promo, "createdBy" | "cityIds">, live: Pick<Promo, "createdBy" | "cityIds" | "budgetMinor">[]): LiveBudgets {
  const cities = x.cityIds.length ? x.cityIds : ["*"];
  const byCity: Record<string, number> = Object.fromEntries(cities.map((c) => [c, 0]));
  let creatorMinor = 0;
  for (const o of live) {
    if (o.createdBy === x.createdBy) creatorMinor += o.budgetMinor;
    for (const c of cities) {
      if (c === "*" || o.cityIds.length === 0 || o.cityIds.includes(c)) byCity[c]! += o.budgetMinor;
    }
  }
  return { creatorMinor, byCity };
}

/** Finance must approve when this budget plus the creator's, or any of its cities', live budgets passes the threshold. */
export function approvalNeeded(budgetMinor: number, totals: LiveBudgets, thresholdMinor: number): boolean {
  if (budgetMinor > thresholdMinor) return true;
  if (budgetMinor + totals.creatorMinor > thresholdMinor) return true;
  return Object.values(totals.byCity).some((m) => budgetMinor + m > thresholdMinor);
}

/** Can one more booking of `discountMinor` fit the promo's budget and redemption limit? Booked = not yet redeemed. */
export function fitsPromo(x: Pick<Promo, "budgetMinor" | "spentMinor" | "maxRedemptions" | "redemptionCount">, booked: { minor: number; count: number }, discountMinor: number): boolean {
  if (x.maxRedemptions !== null && x.redemptionCount + booked.count + 1 > x.maxRedemptions) return false;
  return x.spentMinor + booked.minor + discountMinor <= x.budgetMinor;
}

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

  async function liveBudgets(tx: Prisma.TransactionClient, x: Promo) {
    const live = await tx.promo.findMany({ where: { status: { in: ["ACTIVE", "PAUSED"] }, id: { not: x.id } }, select: { createdBy: true, cityIds: true, budgetMinor: true } });
    return sumLiveBudgets(x, live);
  }

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

    /**
     * DRAFT → ACTIVE. Finance approval (incentive:approve, not the creator) is needed when this
     * budget, added to the live (ACTIVE or PAUSED) promos of the same creator or of any of its
     * cities, would pass the threshold: ten small promos are judged like one big one. Activations
     * are serialised (advisory lock) so two can't each miss the other.
     */
    async activate(p: Principal, id: string) {
      const x = await load(p, id);
      if (x.status !== "DRAFT") throw invalidTransition(x.status, "ACTIVE");
      if (x.endsAt.getTime() <= now().getTime()) throw conflict("this promo has already ended; change its dates first", "promo_ended");
      const at = now();
      return db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('pricing:promo-activation'))`;
        const totals = await liveBudgets(tx, x);
        const big = approvalNeeded(x.budgetMinor, totals, deps.approvalThresholdMinor);
        if (big) {
          const approver = x.cityIds.length === 0 ? can(p, "incentive:approve") : x.cityIds.every((cityId) => can(p, "incentive:approve", { cityId }));
          if (!approver) throw forbidden("with the promos already live, this budget is activated by a finance manager (incentive:approve)", "approval_required");
          if (x.createdBy === p.userId) throw forbidden("maker and checker must be different people", "maker_is_checker");
        } else if (!canManage(p, x.cityIds)) {
          throw forbidden("missing permission promo:manage for every city of this promo");
        }
        const n = await tx.promo.updateMany({ where: { id, status: "DRAFT" }, data: { status: "ACTIVE", activatedBy: p.userId, activatedAt: at } });
        if (n.count !== 1) throw raced();
        await writeOutbox(tx,
          {
            topic: "promo.activated", key: id,
            payload: { promoId: id, code: x.code, cityIds: x.cityIds, budgetMinor: x.budgetMinor, startsAt: x.startsAt.toISOString(), endsAt: x.endsAt.toISOString(), fundedBy: x.fundedBy, byUserId: p.userId },
          },
          audit({ actorId: p.userId, action: big ? "incentive:approve" : "promo:manage", resource: { type: "promo", id }, outcome: "EXECUTED", reason: `activated ${x.code} (budget ${x.budgetMinor}; live with it: creator ${totals.creatorMinor + x.budgetMinor}, largest city ${Math.max(0, ...Object.values(totals.byCity)) + x.budgetMinor})` }),
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
     * trip-service is reading the quote to book trip `tripId` for `userId`: HELD → BOOKED, bound to
     * that trip. Returns false when the discount can't be given (someone else's quote, already
     * booked for another trip, released by a cancelled trip, expired, the promo paused, or the
     * rider's limit, the redemption limit or the budget would be passed counting what is already
     * booked); the quote is then served without it. Asking again for the same trip is true.
     */
    async book(quoteId: string, booking: { tripId: string; userId: string }): Promise<boolean> {
      const r = await db.promoReservation.findUnique({ where: { quoteId } });
      if (!r || r.userId !== booking.userId) return false;
      if (r.status === "BOOKED") return r.tripId === booking.tripId;
      // RELEASED (a cancelled trip, or refused before), EXPIRED, REDEEMED: never again
      if (r.status !== "HELD" || r.tripId !== null || r.expiresAt.getTime() <= now().getTime()) return false;
      return db.$transaction(async (tx) => {
        // the promo row is the lock for its counters; read it again under the lock
        await tx.$queryRaw`SELECT id FROM promo WHERE id = ${r.promoId}::uuid FOR UPDATE`;
        const x = await tx.promo.findUniqueOrThrow({ where: { id: r.promoId } });
        if (x.status !== "ACTIVE" || x.endsAt.getTime() <= now().getTime()) return false;
        const mine = await tx.promoReservation.count({ where: { promoId: x.id, userId: r.userId, status: { in: ["BOOKED", "REDEEMED"] } } });
        const open = await tx.promoReservation.aggregate({ where: { promoId: x.id, status: "BOOKED" }, _sum: { discountMinor: true }, _count: true });
        if (mine >= x.perUserLimit || !fitsPromo(x, { minor: open._sum.discountMinor ?? 0, count: open._count }, r.discountMinor)) {
          await tx.promoReservation.updateMany({ where: { id: r.id, status: "HELD" }, data: { status: "RELEASED" } });
          return false;
        }
        const t = now();
        const n = await tx.promoReservation.updateMany({
          where: { id: r.id, status: "HELD", tripId: null },
          data: { status: "BOOKED", tripId: booking.tripId, bookedAt: t, expiresAt: new Date(t.getTime() + BOOKED_TTL_MS) },
        });
        return n.count === 1;
      });
    },

    /**
     * trip-service booked the discount for `tripId` but the trip was never created (a policy
     * refusal, an active trip already, a lost race): BOOKED → HELD again until `heldUntil`, so the
     * rider's retry can book it. Only for that trip; a no-op otherwise.
     */
    async unbook(quoteId: string, tripId: string, heldUntil: Date): Promise<boolean> {
      const n = await db.promoReservation.updateMany({
        where: { quoteId, tripId, status: "BOOKED" },
        data: { status: "HELD", tripId: null, bookedAt: null, expiresAt: heldUntil },
      });
      return n.count === 1;
    },

    /**
     * trip.completed: redeem the discount booked for this trip (idempotent per trip). The discount
     * counted is what the trip gave (payment-service charged fare − it); a trip whose event
     * carries a discount pricing never booked for it, more than was booked, or spending past the
     * budget is recorded as a promo anomaly and logged, never skipped silently.
     */
    async redeem(e: { tripId: string; riderId: string; cityId: string; vehicleType: string; fareMinor: number; currency: string; completedAt?: string; quoteId?: string; promoDiscountMinor?: number }) {
      return db.$transaction(async (tx) => {
        if (await tx.promoRedemption.findUnique({ where: { tripId: e.tripId } })) return null;
        const r = await reservationFor(tx, e);
        if (!r) {
          if ((e.promoDiscountMinor ?? 0) > 0) {
            await anomaly(tx, { kind: "DISCOUNT_WITHOUT_RESERVATION", tripId: e.tripId, quoteId: e.quoteId ?? null, riderId: e.riderId, discountMinor: e.promoDiscountMinor!, details: { fareMinor: e.fareMinor, cityId: e.cityId } });
          }
          return null;
        }
        if (e.promoDiscountMinor === 0) {
          // the trip gave no discount: nothing was spent, the booking is given back
          await tx.promoReservation.updateMany({ where: { id: r.id, status: "BOOKED" }, data: { status: "RELEASED" } });
          return null;
        }
        await tx.$queryRaw`SELECT id FROM promo WHERE id = ${r.promoId}::uuid FOR UPDATE`;
        const x = await tx.promo.findUniqueOrThrow({ where: { id: r.promoId } });
        const discountMinor = Math.max(0, Math.min(e.promoDiscountMinor ?? r.discountMinor, e.fareMinor));
        if (discountMinor > r.discountMinor) {
          await anomaly(tx, { kind: "DISCOUNT_ABOVE_RESERVATION", tripId: e.tripId, promoId: x.id, quoteId: r.quoteId, riderId: e.riderId, discountMinor, details: { reservedMinor: r.discountMinor } });
        }
        const red = await tx.promoRedemption.create({
          data: { promoId: x.id, reservationId: r.id, tripId: e.tripId, userId: e.riderId, cityId: e.cityId, fareMinor: e.fareMinor, discountMinor },
        });
        await tx.promoReservation.update({ where: { id: r.id }, data: { status: "REDEEMED" } });
        let spentMinor = x.spentMinor + discountMinor;
        if (spentMinor > x.budgetMinor) {
          // booking keeps within the budget, so this is an older booking or a discount above the reservation
          await anomaly(tx, { kind: "OVER_BUDGET", tripId: e.tripId, promoId: x.id, quoteId: r.quoteId, riderId: e.riderId, discountMinor, details: { overMinor: spentMinor - x.budgetMinor, budgetMinor: x.budgetMinor } });
          spentMinor = x.budgetMinor;
        }
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

    /**
     * trip.cancelled: the discount booked for this trip is released for good (the quote can be
     * booked again, but without the discount).
     */
    async release(e: { tripId: string; riderId: string; cityId: string; quoteId?: string }) {
      const r = await reservationFor(db, e);
      if (!r) return false;
      const n = await db.promoReservation.updateMany({ where: { id: r.id, status: "BOOKED" }, data: { status: "RELEASED", tripId: e.tripId } });
      return n.count === 1;
    },

    /** Promo anomalies, newest first (finance). */
    async anomalies(p: Principal, q: { limit: number }) {
      if (citiesWithAny(p, ["incentive:approve"]) !== "*") throw forbidden("missing permission incentive:approve (every city)");
      const rows = await db.promoAnomaly.findMany({ orderBy: { createdAt: "desc" }, take: q.limit });
      return { anomalies: rows.map((a) => ({ id: a.id, kind: a.kind, tripId: a.tripId, promoId: a.promoId, quoteId: a.quoteId, riderId: a.riderId, discountMinor: a.discountMinor, details: a.details, createdAt: a.createdAt.toISOString() })) };
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
   * The reservation booked for this trip: the one bound to its trip id. Bookings made before
   * reservations were bound to trips (trip id empty) are found by the event's quote id; events
   * without a quote id never match a reservation (a trip's discount can't be guessed).
   */
  async function reservationFor(tx: Prisma.TransactionClient | Db, e: { tripId: string; riderId: string; quoteId?: string }): Promise<PromoReservation | null> {
    const r = await tx.promoReservation.findFirst({ where: { tripId: e.tripId, status: "BOOKED" } });
    if (r) return r.userId === e.riderId ? r : null;
    if (!e.quoteId) return null;
    const legacy = await tx.promoReservation.findUnique({ where: { quoteId: e.quoteId } });
    return legacy && legacy.status === "BOOKED" && legacy.tripId === null && legacy.userId === e.riderId ? legacy : null;
  }

  /** Record (once per trip and kind), log loudly, and tell audit. */
  async function anomaly(tx: Prisma.TransactionClient, a: { kind: "DISCOUNT_WITHOUT_RESERVATION" | "DISCOUNT_ABOVE_RESERVATION" | "OVER_BUDGET"; tripId: string; promoId?: string | null; quoteId?: string | null; riderId?: string | null; discountMinor: number; details?: Record<string, unknown> }) {
    const created = await tx.promoAnomaly.createMany({
      data: [{ kind: a.kind, tripId: a.tripId, promoId: a.promoId ?? null, quoteId: a.quoteId ?? null, riderId: a.riderId ?? null, discountMinor: a.discountMinor, details: (a.details ?? {}) as Prisma.InputJsonValue }],
      skipDuplicates: true,
    });
    if (created.count === 0) return;
    deps.logger.error({ ...a }, "PROMO ANOMALY: a discount the promo books can't explain; recorded for finance review");
    await writeOutbox(tx, audit({ actorId: null, action: "promo:anomaly", resource: { type: "trip", id: a.tripId }, outcome: "EXECUTED", reason: `${a.kind}: ${a.discountMinor} santim${a.promoId ? ` (promo ${a.promoId})` : ""}` }));
  }
}

export type PromoService = ReturnType<typeof createPromoService>;
