// Scheduled rides (workflow 12): book now, ride later.
//
//   book ──► SCHEDULED ──(match_at reached, scheduler)──► DISPATCHING ──► DISPATCHED (trip_id set)
//               │  ▲                                          │
//               │  └──────── retry next tick (rider still on a trip, pricing down …) ┘
//               ├──► CANCELLED (rider, booker, company or staff; free before dispatch)
//               └──► FAILED    (couldn't create the trip by the pickup time)
//
// A booking isn't a trip: it has its own table (`scheduled_trip`), so the trip state machine and
// TripStatus stay as they are. At match_at = pickup − lead time the scheduler creates a normal
// `requested` trip and matching starts (workflow 05). A scheduled trip that matching can't serve
// is escalated to dispatch once (trip.dispatch_escalated, flag DISPATCH_ESCALATED) and keeps
// searching until 10 min after the pickup time (see TripService.matchTimedOut).
//
// The scheduler runs in every replica: claiming is `FOR UPDATE SKIP LOCKED`, and a claim older
// than 2 minutes (a replica died mid-dispatch) is taken over.
//
// Price: the quote shown at booking is kept as a ceiling. Shortly before dispatch the ride is
// re-priced (QuoteProvider.reprice); the rider pays the lower of the two.

import { authorize, can, type Principal } from "@ride-app/shared-authz";
import type { PaymentMethod } from "@ride-app/shared-types";
import type { Logger } from "@ride-app/shared-utils";
import type { SettingsReader } from "@ride-app/shared-settings";
import { Prisma, type ScheduledTrip } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import { AppError, badRequest, conflict, notFound } from "../lib/errors.js";
import type { Realtime } from "../lib/realtime.js";
import { writeOutbox } from "../outbox/outbox.js";
import type { QuoteProvider } from "../quotes.js";
import { addisClock, type CorporatePolicies } from "./corporate.js";
import type { BookingInput, TripService } from "./service.js";

export interface ScheduleConfig {
  /** matching starts this long before the pickup (workflow 12 §3, "Lead time") */
  leadMinutes: number;
  /** … at night (22:00–06:00 Addis time) */
  nightLeadMinutes: number;
  /** booking window */
  minAheadMinutes: number;
  maxAheadDays: number;
  /** upcoming bookings one rider may hold */
  maxUpcomingPerRider: number;
}

export const DEFAULT_SCHEDULE: ScheduleConfig = { leadMinutes: 15, nightLeadMinutes: 30, minAheadMinutes: 30, maxAheadDays: 7, maxUpcomingPerRider: 5 };

const CLAIM_STALE_MS = 2 * 60_000;
/** two bookings of one rider must be this far apart (one active trip per rider) */
const RIDER_GAP_MS = 60 * 60_000;
const UPCOMING = ["SCHEDULED", "DISPATCHING"];
const isP2002 = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/** Minutes before the pickup when matching starts. */
export function leadMinutes(scheduledFor: Date, cfg: ScheduleConfig): number {
  const { minute } = addisClock(scheduledFor);
  return minute >= 22 * 60 || minute < 6 * 60 ? cfg.nightLeadMinutes : cfg.leadMinutes;
}

export function scheduledView(s: ScheduledTrip & { trip?: { status: string } | null }, at: Date) {
  return {
    id: s.id,
    status: s.status,
    cityId: s.cityId,
    channel: s.channel,
    vehicleType: s.vehicleType,
    paymentMethod: s.paymentMethod,
    billing: { type: s.billingType, orgId: s.billingOrgId },
    riderUserId: s.riderUserId,
    bookedByUserId: s.bookedByUserId,
    purpose: s.purpose,
    pickup: { lat: s.pickupLat, lng: s.pickupLng, address: s.pickupAddress },
    dropoff: { lat: s.dropoffLat, lng: s.dropoffLng, address: s.dropoffAddress },
    fare: { estimateMinor: Number(s.fareEstimateMinor), currency: s.currency },
    route: { estDistanceMeters: s.estDistanceM, estDurationSeconds: s.estDurationS, polyline: s.routePolyline },
    scheduledFor: s.scheduledFor,
    matchAt: s.matchAt,
    tripId: s.tripId,
    tripStatus: s.trip?.status ?? null,
    dispatchedAt: s.dispatchedAt,
    cancelledAt: s.cancelledAt,
    failReason: s.failReason,
    escalatedAt: s.escalatedAt,
    createdAt: s.createdAt,
    /** time, route and purpose can change until matching starts */
    editable: s.status === "SCHEDULED" && at < s.matchAt,
  };
}

export type ScheduledView = ReturnType<typeof scheduledView>;

export interface SchedulerDeps {
  db: Db;
  quotes: QuoteProvider;
  trips: TripService;
  policies: CorporatePolicies;
  settings: SettingsReader;
  realtime: Realtime;
  logger: Logger;
  config?: () => ScheduleConfig;
  now?: () => Date;
}

export function createScheduler(deps: SchedulerDeps) {
  const { db, quotes, trips, logger, realtime } = deps;
  const now = deps.now ?? (() => new Date());
  const cfg = deps.config ?? (() => DEFAULT_SCHEDULE);
  let timer: NodeJS.Timeout | undefined;
  let busy = false;

  const unavailable = () => new AppError(503, "pricing is temporarily unavailable", "dependency_unavailable");

  function push(s: ScheduledTrip) {
    const payload = { scheduledTripId: s.id, status: s.status, tripId: s.tripId, scheduledFor: s.scheduledFor.toISOString(), failReason: s.failReason };
    for (const userId of new Set([s.riderUserId, s.bookedByUserId])) realtime.toUser(userId, "scheduled:status", payload);
  }

  /** Riders and bookers (SELF), the billed company (ORG), staff of the city. */
  function mayRead(p: Principal, s: ScheduledTrip) {
    return can(p, "trip:read", { ownerUserIds: [s.riderUserId, s.bookedByUserId], cityId: s.cityId, ...(s.billingOrgId ? { orgId: s.billingOrgId } : {}) });
  }

  async function readable(p: Principal, id: string) {
    const s = await db.scheduledTrip.findUnique({ where: { id }, include: { trip: { select: { status: true } } } });
    if (!s || !mayRead(p, s)) throw notFound("scheduled trip");
    return s;
  }

  async function manageable(p: Principal, id: string) {
    const s = await readable(p, id);
    authorize(p, "trip:cancel", { ownerUserIds: [s.riderUserId, s.bookedByUserId], cityId: s.cityId, ...(s.billingOrgId ? { orgId: s.billingOrgId } : {}) });
    return s;
  }

  function checkWindow(at: Date) {
    const c = cfg();
    const ahead = at.getTime() - now().getTime();
    if (ahead < c.minAheadMinutes * 60_000) throw badRequest(`book at least ${c.minAheadMinutes} minutes ahead (or request a ride now)`, "too_soon");
    if (ahead > c.maxAheadDays * 86_400_000) throw badRequest(`book at most ${c.maxAheadDays} days ahead`, "too_far_ahead");
  }

  async function freshQuote(p: Principal, quoteId: string) {
    let quote;
    try {
      quote = await quotes.get(quoteId);
    } catch {
      throw unavailable();
    }
    if (!quote || quote.requestedBy !== p.userId) throw badRequest("unknown quote", "invalid_quote");
    if (new Date(quote.expiresAt).getTime() <= now().getTime()) throw badRequest("the quote has expired, get a new one", "quote_expired");
    const [usedByTrip, usedBySchedule] = await Promise.all([
      db.trip.findFirst({ where: { quoteId, status: { not: "cancelled" } }, select: { id: true } }),
      db.scheduledTrip.findFirst({ where: { quoteId, status: { not: "CANCELLED" } }, select: { id: true } }),
    ]);
    if (usedByTrip || usedBySchedule) throw badRequest("this quote was already used, get a new one", "quote_used");
    return quote;
  }

  /** One rider, one ride at a time: no other upcoming booking within an hour, and at most N upcoming. */
  async function checkRiderSlots(riderId: string, at: Date, exceptId?: string) {
    const others = await db.scheduledTrip.findMany({
      where: { riderUserId: riderId, status: { in: UPCOMING }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { scheduledFor: true },
    });
    if (others.length >= cfg().maxUpcomingPerRider) throw conflict(`a rider can have at most ${cfg().maxUpcomingPerRider} upcoming rides`, "too_many_scheduled");
    if (others.some((o) => Math.abs(o.scheduledFor.getTime() - at.getTime()) < RIDER_GAP_MS)) {
      throw conflict("the rider already has a ride booked within an hour of that time", "schedule_conflict");
    }
  }

  /** Back to SCHEDULED for the next tick, or FAILED once the pickup time has passed. */
  async function giveUp(s: ScheduledTrip, reason: string) {
    if (now() < s.scheduledFor) {
      await db.scheduledTrip.updateMany({ where: { id: s.id, status: "DISPATCHING" }, data: { status: "SCHEDULED", claimedAt: null } });
      return;
    }
    const failed = await db.$transaction(async (tx) => {
      const { count } = await tx.scheduledTrip.updateMany({ where: { id: s.id, status: "DISPATCHING" }, data: { status: "FAILED", failReason: reason, version: { increment: 1 } } });
      if (count === 0) return null;
      await writeOutbox(tx, {
        topic: "trip.schedule_failed",
        payload: { scheduledTripId: s.id, riderId: s.riderUserId, bookedById: s.bookedByUserId, cityId: s.cityId, reason, scheduledFor: s.scheduledFor.toISOString() },
      });
      return tx.scheduledTrip.findUniqueOrThrow({ where: { id: s.id } });
    });
    if (failed) {
      logger.warn({ scheduledTripId: s.id, reason }, "scheduled trip failed");
      push(failed);
    }
  }

  async function dispatchOne(id: string) {
    const s = await db.scheduledTrip.findUnique({ where: { id } });
    if (!s || s.status !== "DISPATCHING") return;
    // re-price near dispatch; the booked fare stays the ceiling
    let fresh = null;
    if (quotes.reprice) {
      try {
        fresh = await quotes.reprice({
          requestedBy: s.bookedByUserId, cityId: s.cityId, vehicleType: s.vehicleType,
          pickup: { lat: s.pickupLat, lng: s.pickupLng }, dropoff: { lat: s.dropoffLat, lng: s.dropoffLng },
          ...(s.pickupAddress ? { pickupAddress: s.pickupAddress } : {}), ...(s.dropoffAddress ? { dropoffAddress: s.dropoffAddress } : {}),
        });
      } catch (err) {
        logger.warn({ scheduledTripId: s.id, err: (err as Error).message }, "re-pricing failed, keeping the booked quote");
      }
    }
    const priced = fresh && fresh.cityId === s.cityId && fresh.vehicleType === s.vehicleType
      ? {
          fareMinor: BigInt(fresh.fareMinor) < s.fareEstimateMinor ? BigInt(fresh.fareMinor) : s.fareEstimateMinor,
          waitingPerMinMinor: BigInt(fresh.waitingPerMinMinor), distanceMeters: fresh.distanceMeters, durationSeconds: fresh.durationSeconds,
          routePolyline6: fresh.routePolyline6 ?? s.routePolyline, quoteId: fresh.id,
        }
      : {
          fareMinor: s.fareEstimateMinor, waitingPerMinMinor: s.waitingPerMinMinor, distanceMeters: s.estDistanceM,
          durationSeconds: s.estDurationS, routePolyline6: s.routePolyline, quoteId: s.quoteId,
        };
    try {
      await trips.createFromSchedule(s, priced);
      const done = await db.scheduledTrip.findUniqueOrThrow({ where: { id: s.id } });
      logger.info({ scheduledTripId: s.id, tripId: done.tripId }, "scheduled trip dispatched");
      push(done);
    } catch (err) {
      const reason = isP2002(err) ? "RIDER_HAS_ACTIVE_TRIP" : "DISPATCH_FAILED";
      if (reason === "DISPATCH_FAILED") logger.error({ scheduledTripId: s.id, err: (err as Error).message }, "scheduled trip dispatch failed");
      await giveUp(s, reason);
    }
  }

  async function tick(): Promise<number> {
    if (busy) return 0;
    busy = true;
    try {
      const at = now();
      const claimed = await db.$queryRaw<{ id: string }[]>`
        UPDATE scheduled_trip SET status = 'DISPATCHING', claimed_at = ${at}, version = version + 1, updated_at = ${at}
        WHERE id IN (
          SELECT id FROM scheduled_trip
          WHERE (status = 'SCHEDULED' AND match_at <= ${at}) OR (status = 'DISPATCHING' AND claimed_at < ${new Date(at.getTime() - CLAIM_STALE_MS)})
          ORDER BY match_at
          LIMIT 20
          FOR UPDATE SKIP LOCKED)
        RETURNING id::text AS id`;
      for (const { id } of claimed) await dispatchOne(id);
      return claimed.length;
    } finally {
      busy = false;
    }
  }

  return {
    tick,

    start(intervalMs = 15_000) {
      timer = setInterval(() => void tick().catch((err) => logger.error({ err: (err as Error).message }, "scheduler tick failed")), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
    },

    /** Book a ride for later (same permissions as booking now: trip:create / trip:create_on_behalf). */
    async book(p: Principal, input: BookingInput & { quoteId: string; scheduledFor: Date }) {
      if (!deps.settings.get<boolean>("features.scheduledRides")) throw new AppError(403, "scheduled rides are turned off", "feature_disabled");
      checkWindow(input.scheduledFor);
      const quote = await freshQuote(p, input.quoteId);
      const { riderId, channel, corporate } = trips.authorizeBooking(p, input, quote.cityId);
      if (input.billingOrgId) {
        await deps.policies.check(input.billingOrgId, { vehicleType: quote.vehicleType, fareMinor: quote.fareMinor, at: input.scheduledFor, purpose: input.purpose });
      }
      await checkRiderSlots(riderId, input.scheduledFor);
      const matchAt = new Date(input.scheduledFor.getTime() - leadMinutes(input.scheduledFor, cfg()) * 60_000);

      const s = await db.$transaction(async (tx) => {
        const row = await tx.scheduledTrip.create({
          data: {
            cityId: quote.cityId, riderUserId: riderId, bookedByUserId: p.userId, channel,
            billingType: corporate ? "CORPORATE" : "PERSONAL", billingOrgId: input.billingOrgId ?? null,
            paymentMethod: input.paymentMethod, vehicleType: quote.vehicleType, purpose: input.purpose?.trim() || null, quoteId: quote.id,
            pickupLat: quote.pickup.lat, pickupLng: quote.pickup.lng, dropoffLat: quote.dropoff.lat, dropoffLng: quote.dropoff.lng,
            pickupAddress: quote.pickupAddress ?? null, dropoffAddress: quote.dropoffAddress ?? null,
            fareEstimateMinor: BigInt(quote.fareMinor), waitingPerMinMinor: BigInt(quote.waitingPerMinMinor), currency: quote.currency,
            estDistanceM: quote.distanceMeters, estDurationS: quote.durationSeconds, routePolyline: quote.routePolyline6 ?? null,
            scheduledFor: input.scheduledFor, matchAt, createdAt: now(), updatedAt: now(),
          },
        });
        await writeOutbox(tx, scheduledEvent(row));
        return row;
      });
      push(s);
      return scheduledView(s, now());
    },

    async get(p: Principal, id: string) {
      return scheduledView(await readable(p, id), now());
    },

    /**
     * Mine (as rider or booker), a company's (trip:read @ ORG) or a city's (staff, trip:read @ CITY).
     * `upcoming` (default): not dispatched yet, soonest first; `all`: newest pickup first.
     */
    async list(p: Principal, q: { orgId?: string; cityId?: string; status?: string; from?: Date; to?: Date; limit: number }) {
      let where: Prisma.ScheduledTripWhereInput;
      if (q.orgId) {
        authorize(p, "trip:read", { orgId: q.orgId });
        where = { billingOrgId: q.orgId };
      } else if (q.cityId) {
        if (p.audience !== "ride-admin") throw badRequest("cityId is for staff; use orgId or nothing");
        authorize(p, "trip:read", { cityId: q.cityId });
        where = { cityId: q.cityId };
      } else {
        where = { OR: [{ riderUserId: p.userId }, { bookedByUserId: p.userId }] };
      }
      const status = q.status ?? "upcoming";
      if (status === "upcoming") where = { ...where, status: { in: UPCOMING } };
      else if (status !== "all") where = { ...where, status };
      if (q.from || q.to) where = { ...where, scheduledFor: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } };
      const rows = await db.scheduledTrip.findMany({
        where, include: { trip: { select: { status: true } } },
        orderBy: { scheduledFor: status === "upcoming" ? "asc" : "desc" }, take: q.limit,
      });
      const at = now();
      return rows.map((s) => scheduledView(s, at));
    },

    /** Move the pickup time, change the route (a new quote) or the purpose, until matching starts. */
    async update(p: Principal, id: string, input: { scheduledFor?: Date; quoteId?: string; purpose?: string | null }) {
      const s = await manageable(p, id);
      if (s.status !== "SCHEDULED" || now() >= s.matchAt) throw conflict("this ride is already being dispatched: change or cancel the trip instead", "invalid_state");
      const scheduledFor = input.scheduledFor ?? s.scheduledFor;
      if (input.scheduledFor) checkWindow(scheduledFor);
      const quote = input.quoteId ? await freshQuote(p, input.quoteId) : null;
      if (quote && quote.cityId !== s.cityId) throw badRequest("the new pickup is in another city: cancel and book again");
      const purpose = input.purpose === undefined ? s.purpose : input.purpose?.trim() || null;
      const vehicleType = quote?.vehicleType ?? s.vehicleType;
      const fare = quote ? BigInt(quote.fareMinor) : s.fareEstimateMinor;
      if (s.billingOrgId) {
        // the booking's own fare is already in the month's spend
        await deps.policies.check(s.billingOrgId, { vehicleType, fareMinor: fare, at: scheduledFor, purpose, ignoreScheduledFareMinor: s.fareEstimateMinor });
      }
      if (input.scheduledFor) await checkRiderSlots(s.riderUserId, scheduledFor, s.id);
      const matchAt = new Date(scheduledFor.getTime() - leadMinutes(scheduledFor, cfg()) * 60_000);

      const updated = await db.$transaction(async (tx) => {
        const { count } = await tx.scheduledTrip.updateMany({
          where: { id: s.id, status: "SCHEDULED", version: s.version },
          data: {
            scheduledFor, matchAt, purpose, version: { increment: 1 }, updatedAt: now(),
            ...(quote ? {
              quoteId: quote.id, vehicleType: quote.vehicleType,
              pickupLat: quote.pickup.lat, pickupLng: quote.pickup.lng, dropoffLat: quote.dropoff.lat, dropoffLng: quote.dropoff.lng,
              pickupAddress: quote.pickupAddress ?? null, dropoffAddress: quote.dropoffAddress ?? null,
              fareEstimateMinor: BigInt(quote.fareMinor), waitingPerMinMinor: BigInt(quote.waitingPerMinMinor), currency: quote.currency,
              estDistanceM: quote.distanceMeters, estDurationS: quote.durationSeconds, routePolyline: quote.routePolyline6 ?? null,
            } : {}),
          },
        });
        if (count === 0) throw conflict("the booking changed meanwhile, reload it", "invalid_state");
        const row = await tx.scheduledTrip.findUniqueOrThrow({ where: { id: s.id } });
        await writeOutbox(tx, scheduledEvent(row, true));
        return row;
      });
      push(updated);
      return scheduledView(updated, now());
    },

    /** Cancel before dispatch: always free (no trip exists yet). After dispatch, cancel the trip. */
    async cancel(p: Principal, id: string) {
      const s = await manageable(p, id);
      if (s.status === "CANCELLED") return scheduledView(s, now());
      if (s.status !== "SCHEDULED") {
        throw conflict(s.tripId ? "this ride has started matching: cancel the trip instead" : `the booking is ${s.status.toLowerCase()}`, "invalid_state");
      }
      const by = p.audience === "ride-admin" ? "STAFF" : p.userId === s.riderUserId ? "RIDER" : "BOOKER";
      const cancelled = await db.$transaction(async (tx) => {
        const { count } = await tx.scheduledTrip.updateMany({
          where: { id: s.id, status: "SCHEDULED" },
          data: { status: "CANCELLED", cancelledAt: now(), cancelledByUserId: p.userId, version: { increment: 1 }, updatedAt: now() },
        });
        if (count === 0) throw conflict("this ride has started matching: cancel the trip instead", "invalid_state");
        await writeOutbox(tx, {
          topic: "trip.schedule_cancelled",
          payload: { scheduledTripId: s.id, riderId: s.riderUserId, bookedById: s.bookedByUserId, cityId: s.cityId, by, byUserId: p.userId, scheduledFor: s.scheduledFor.toISOString() },
        });
        return tx.scheduledTrip.findUniqueOrThrow({ where: { id: s.id } });
      });
      push(cancelled);
      return scheduledView(cancelled, now());
    },
  };

  function scheduledEvent(s: ScheduledTrip, updated = false) {
    return {
      topic: "trip.scheduled" as const,
      payload: {
        scheduledTripId: s.id, riderId: s.riderUserId, bookedById: s.bookedByUserId, cityId: s.cityId, vehicleType: s.vehicleType,
        channel: s.channel as "APP" | "PHONE" | "CORPORATE_PORTAL", paymentMethod: s.paymentMethod as PaymentMethod,
        ...(s.billingOrgId ? { billingOrgId: s.billingOrgId } : {}), fareEstimateMinor: Number(s.fareEstimateMinor), currency: s.currency,
        scheduledFor: s.scheduledFor.toISOString(), matchAt: s.matchAt.toISOString(), ...(updated ? { updated: true } : {}),
      },
    };
  }
}

export type Scheduler = ReturnType<typeof createScheduler>;
