// The trip lifecycle (architecture §6, workflows 05–08). Only trip-service changes a trip's status.
//
//   requested → matched → en_route → in_progress → completed
//        ↘──────────↘─────────↘ cancelled
//
// Every transition is ONE transaction: a conditional UPDATE (… WHERE status IN (allowed) AND
// version = v), a trip_event row and an outbox row. Zero rows updated means someone else changed
// the trip first: the caller gets 409 with the current status (Database.md §9, race 2).

import { randomInt } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { Redis } from "ioredis";
import { authorize, can, type Principal } from "@ride-app/shared-authz";
import { getDriverState, haversineMeters, keys as locationKeys } from "@ride-app/shared-location";
import { RATING_TAGS, type Beneficiary, type PaymentMethod } from "@ride-app/shared-types";
import type { Logger } from "@ride-app/shared-utils";
import { Prisma, type ScheduledTrip, type Trip } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import type { DriverLive, LocationClient, OrgMembersClient } from "../lib/clients.js";
import { AppError, badRequest, conflict, notFound } from "../lib/errors.js";
import type { Realtime } from "../lib/realtime.js";
import { audit, writeOutbox, type TripEvent } from "../outbox/outbox.js";
import { quoteDiscount, type QuoteProvider } from "../quotes.js";
import { cancellationFee, policyFor, waitingFee, type CancelledBy } from "./policy.js";
import type { SettingsReader } from "@ride-app/shared-settings";
import type { CorporatePolicies } from "./corporate.js";
import type { TraceReader } from "./trace.js";

export const ACTIVE = ["requested", "matched", "en_route", "in_progress"] as const;
type Status = "requested" | "matched" | "en_route" | "in_progress" | "completed" | "cancelled";

/** stops or (re)starts the matcher for a trip (see matching/matcher.ts) */
export interface MatchingControl {
  start(tripId: string): Promise<void>;
  stop(tripId: string): Promise<void>;
  poke(tripId: string): Promise<void>;
}

export interface TripServiceDeps {
  db: Db;
  redis: Redis;
  quotes: QuoteProvider;
  location: LocationClient;
  realtime: Realtime;
  matching: MatchingControl;
  logger: Logger;
  /** live settings (platform-service): PIN, trip rules, maintenance, feature flags */
  settings: SettingsReader;
  /** company ride policies, checked on trips billed to a company */
  policies: CorporatePolicies;
  /** the GPS trace: the ride's driven distance on completion */
  trace?: TraceReader;
  /** auth-service memberships: a company booking for someone else needs the rider in the company */
  orgs: OrgMembersClient;
  now?: () => Date;
}

export type Channel = "APP" | "PHONE" | "CORPORATE_PORTAL";

/** What a booking (now or scheduled) asks for. */
export interface BookingInput {
  paymentMethod: PaymentMethod;
  riderUserId?: string;
  billingOrgId?: string;
  purpose?: string;
}

/** Scheduled trips still searching this long after the pickup time are cancelled (NO_DRIVER_FOUND). */
export const SCHEDULED_SEARCH_GRACE_MS = 10 * 60_000;

/**
 * Anti-fraud (workflow 06 step 8): wrong trip PINs allowed per trip before the PIN check locks;
 * the rider (a new PIN from their app) or support unlocks it.
 */
export const PIN_MAX_ATTEMPTS = 5;
const pinFailsKey = (tripId: string) => `trip:${tripId}:pin_fails`;
const PIN_FAILS_TTL_SECONDS = 12 * 3600;
const newPin = () => String(randomInt(0, 10_000)).padStart(4, "0");

/**
 * Fake rides (workflow 06 step 13): a ride "completed" this soon after the start, with the car still
 * this close to the pickup and far from the drop-off, didn't happen and is refused. Other rides
 * this short are completed but flagged SHORT_TRIP for review.
 */
export const MIN_RIDE_SECONDS = 60;
export const STILL_AT_PICKUP_METERS = 300;

const unavailable = (what: string) => new AppError(503, `${what} is temporarily unavailable`, "dependency_unavailable");
const invalidState = (status: string) => new AppError(409, `the trip is ${status}`, "invalid_state");
const isP2002 = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
const quoteUsed = () => badRequest("this quote was already used, get a new one", "quote_used");
/** A unique violation on booking: the live-trip-per-quote index (quote_used), else one active trip per rider. */
export function uniqueViolation(err: unknown): AppError {
  const e = err as { message?: string; meta?: unknown };
  const text = `${e.message ?? ""} ${JSON.stringify(e.meta ?? {})}`;
  if (text.includes("ux_trip_quote_live") || text.includes("quote_id")) return quoteUsed();
  return conflict("the rider already has an active trip", "active_trip_exists");
}

function beneficiaryOf(t: Pick<Trip, "vehicleOwnerType" | "beneficiaryId">): Beneficiary | undefined {
  if (!t.beneficiaryId || !t.vehicleOwnerType) return undefined;
  return { type: t.vehicleOwnerType as Beneficiary["type"], id: t.beneficiaryId };
}

/** The promo discount on this trip's fare (final fare once completed, else the estimate), never above it. */
export function payableDiscount(t: Pick<Trip, "promoDiscountMinor" | "fareEstimateMinor" | "fareFinalMinor">): bigint {
  const fare = t.fareFinalMinor ?? t.fareEstimateMinor;
  const d = t.promoDiscountMinor < 0n ? 0n : t.promoDiscountMinor;
  return d > fare ? fare : d;
}

/** What a caller sees. The PIN only goes to the rider's side; review flags only to staff. */
export function tripView(t: Trip, viewer?: Pick<Principal, "userId" | "audience">) {
  const riderSide = viewer && (viewer.userId === t.riderUserId || viewer.userId === t.bookedByUserId);
  const staff = viewer?.audience === "ride-admin";
  // the driver works with the rider's name (GET /:id/parties), never their account id
  const driverOnly = !!viewer && !riderSide && !staff && viewer.userId === t.driverUserId;
  const n = (v: bigint | null) => (v === null ? null : Number(v));
  return {
    id: t.id,
    status: t.status,
    cityId: t.cityId,
    channel: t.channel,
    vehicleType: t.vehicleType,
    paymentMethod: t.paymentMethod,
    billing: { type: t.billingType, orgId: t.billingOrgId },
    riderUserId: driverOnly ? null : t.riderUserId,
    pickup: { lat: t.pickupLat, lng: t.pickupLng, address: t.pickupAddress },
    dropoff: { lat: t.dropoffLat, lng: t.dropoffLng, address: t.dropoffAddress },
    driver: t.driverUserId ? { userId: t.driverUserId, vehicleId: t.vehicleId } : null,
    fare: {
      estimateMinor: Number(t.fareEstimateMinor), finalMinor: n(t.fareFinalMinor),
      waitingFeeMinor: n(t.waitingFeeMinor), currency: t.currency,
      // promo (workflow 15): the rider pays the fare minus the discount; the driver earns on the full fare
      promoDiscountMinor: Number(payableDiscount(t)), promoCode: t.promoCode,
      payableMinor: Number((t.fareFinalMinor ?? t.fareEstimateMinor) - payableDiscount(t)),
    },
    route: { estDistanceMeters: t.estDistanceM, estDurationSeconds: t.estDurationS, distanceMeters: t.distanceM, durationSeconds: t.durationS, polyline: t.routePolyline },
    times: { requestedAt: t.createdAt, matchedAt: t.matchedAt, arrivedAt: t.arrivedAt, startedAt: t.startedAt, completedAt: t.completedAt, cancelledAt: t.cancelledAt },
    purpose: viewer && viewer.userId === t.driverUserId ? null : t.purpose,
    cancellation: t.cancelledAt
      ? { by: t.cancelledBy, reason: t.cancelReason, feeMinor: n(t.cancelFeeMinor), driverCompensationMinor: n(t.driverCompensationMinor) }
      : null,
    ...(riderSide ? { pin: t.pin } : {}),
    ...(staff ? { flags: t.flags } : {}),
  };
}

export type TripView = ReturnType<typeof tripView>;

export function createTripService(deps: TripServiceDeps) {
  const { db, redis, quotes, location, realtime, matching, logger } = deps;
  const now = deps.now ?? (() => new Date());

  async function load(tripId: string) {
    const t = await db.trip.findUnique({ where: { id: tripId } });
    if (!t) throw notFound("trip");
    return t;
  }

  /** A quote already carries a live or finished trip, or an upcoming scheduled ride. */
  async function quoteInUse(quoteId: string) {
    const [trip, scheduled] = await Promise.all([
      db.trip.findFirst({ where: { quoteId, status: { not: "cancelled" } }, select: { id: true } }),
      db.scheduledTrip.findFirst({ where: { quoteId, status: { not: "CANCELLED" } }, select: { id: true } }),
    ]);
    return !!(trip || scheduled);
  }

  /** Trip readers: its rider, booker and driver; staff in its city; the billing org; the vehicle's fleet. */
  function mayRead(p: Principal, t: Trip): boolean {
    const owners = [t.riderUserId, t.bookedByUserId, ...(t.driverUserId ? [t.driverUserId] : [])];
    if (can(p, "trip:read", { ownerUserIds: owners, cityId: t.cityId, ...(t.billingOrgId ? { orgId: t.billingOrgId } : {}) })) return true;
    return t.vehicleOwnerType === "ORGANIZATION" && !!t.beneficiaryId && can(p, "trip:read", { orgId: t.beneficiaryId });
  }

  /** The trip's history (status changes, who made them), oldest first: staff only (the timeline in the console). */
  async function events(p: Principal, tripId: string) {
    const t = await load(tripId);
    if (p.audience !== "ride-admin" || !can(p, "trip:read", { cityId: t.cityId })) throw notFound("trip");
    const rows = await db.tripEvent.findMany({ where: { tripId }, orderBy: [{ at: "asc" }, { id: "asc" }] });
    return { tripId, events: rows.map((e) => ({ at: e.at, from: e.fromStatus, to: e.toStatus, actorId: e.actorId, data: e.data })) };
  }

  /** Readable trip, or 404 (never confirm that someone else's trip exists). */
  async function readable(p: Principal, tripId: string) {
    const t = await load(tripId);
    if (!mayRead(p, t)) throw notFound("trip");
    return t;
  }

  /** The conditional transition + history + outbox, in one transaction. */
  async function transition(
    t: Trip,
    from: readonly Status[],
    to: Status,
    data: Prisma.TripUpdateManyMutationInput,
    actorId: string | null,
    event?: (updated: Trip) => TripEvent,
    extra?: (tx: Prisma.TransactionClient, updated: Trip) => Promise<void>,
    history?: Record<string, unknown>,
  ): Promise<Trip> {
    return db.$transaction(async (tx) => {
      const { count } = await tx.trip.updateMany({
        where: { id: t.id, status: { in: [...from] }, version: t.version },
        data: { ...data, status: to, version: { increment: 1 } },
      });
      if (count === 0) {
        const current = await tx.trip.findUniqueOrThrow({ where: { id: t.id }, select: { status: true } });
        throw invalidState(current.status);
      }
      const updated = await tx.trip.findUniqueOrThrow({ where: { id: t.id } });
      await tx.tripEvent.create({
        data: { tripId: t.id, fromStatus: t.status, toStatus: to, actorId, at: now(), ...(history ? { data: history as Prisma.InputJsonValue } : {}) },
      });
      await extra?.(tx, updated);
      if (event) await writeOutbox(tx, event(updated));
      return updated;
    });
  }

  const ratingKey = (userId: string) => `rating:user:${userId}`;
  async function ratingOfUser(userId: string): Promise<{ average: number | null; count: number }> {
    const cached = await redis.get(ratingKey(userId));
    if (cached) return JSON.parse(cached) as { average: number | null; count: number };
    const agg = await db.tripRating.aggregate({ where: { rateeUserId: userId }, _avg: { stars: true }, _count: { stars: true } });
    const out = { average: agg._avg.stars === null ? null : Math.round(agg._avg.stars * 10) / 10, count: agg._count.stars };
    await redis.set(ratingKey(userId), JSON.stringify(out), "EX", 300);
    return out;
  }

  function notify(t: Trip, event = "trip:status") {
    // each person gets their own view (the driver without the rider's account id; never the PIN)
    for (const userId of new Set([t.riderUserId, t.bookedByUserId, ...(t.driverUserId ? [t.driverUserId] : [])])) {
      const { pin: _pin, ...trip } = tripView(t, { userId, audience: "ride-app" });
      realtime.toUser(userId, event, { tripId: t.id, status: t.status, trip });
    }
  }

  const progressEvent = (topic: "trip.driver_en_route" | "trip.driver_arrived" | "trip.started") => (u: Trip): TripEvent => ({
    topic, payload: { tripId: u.id, riderId: u.riderUserId, driverId: u.driverUserId!, cityId: u.cityId },
  });

  async function livePosition(driverId: string) {
    let live: DriverLive | null;
    try {
      live = await location.driver(driverId);
    } catch {
      throw unavailable("driver location");
    }
    // fresh by when the server received the ping, not the phone's own clock (`at`)
    const seenAt = live?.receivedAt ?? live?.at;
    if (!live || live.lat === undefined || live.lng === undefined || seenAt === undefined || now().getTime() - seenAt > 60_000) return null;
    return { lat: live.lat, lng: live.lng };
  }

  /** The assigned driver (trip:update_status @ SELF). */
  function assertDriver(p: Principal, t: Trip) {
    if (!t.driverUserId || p.userId !== t.driverUserId) throw notFound("trip");
    authorize(p, "trip:update_status", { ownerUserIds: [t.driverUserId] });
  }

  /**
   * Accept and dispatcher assignment share this: snapshot the driver's vehicle and beneficiary,
   * claim driver_active_trip (one active trip per driver, enforced by its primary key), and move
   * requested → matched, all in one transaction.
   */
  async function matchDriver(t: Trip, driverId: string, actorId: string, offerId?: string) {
    const live = await assertAssignable(t, driverId);

    const ownerType = live.fleetOrgId ? "ORGANIZATION" : "INDIVIDUAL";
    try {
      const updated = await transition(
        t, ["requested"], "matched",
        {
          driverUserId: driverId, vehicleId: live.vehicleId, vehicleOwnerType: ownerType,
          beneficiaryId: live.fleetOrgId ?? driverId, matchedAt: now(),
        },
        actorId,
        matchedEvent(driverId),
        async (tx) => {
          await tx.driverActiveTrip.create({ data: { driverUserId: driverId, tripId: t.id, since: now() } });
          if (offerId) await tx.tripOffer.updateMany({ where: { id: offerId }, data: { status: "ACCEPTED", answeredAt: now() } });
          await tx.tripOffer.updateMany({ where: { tripId: t.id, status: "OFFERED" }, data: { status: "EXPIRED", answeredAt: now() } });
        },
        offerId ? undefined : { assignedBy: actorId },
      );
      await matching.stop(t.id);
      await redis.del(locationKeys.offer(driverId));
      notify(updated);
      return updated;
    } catch (err) {
      if (isP2002(err)) throw conflict("the driver already has an active trip", "driver_busy");
      throw err;
    }
  }

  const matchedEvent = (driverId: string) => (u: Trip): TripEvent => ({
    topic: "trip.matched",
    payload: { tripId: u.id, riderId: u.riderUserId, driverId, cityId: u.cityId, vehicleType: u.vehicleType, ...(u.bookedByUserId !== u.riderUserId ? { bookedById: u.bookedByUserId } : {}), ...(u.billingOrgId ? { billingOrgId: u.billingOrgId } : {}) },
  });

  async function finishCancel(t: Trip, by: CancelledBy, actorId: string | null, reason: string, fee: { feeMinor: bigint; compensationMinor: bigint }, reviewFlags: string[] = []) {
    const offered = await db.tripOffer.findMany({ where: { tripId: t.id, status: "OFFERED" }, select: { driverUserId: true } });
    const flags = reviewFlags.filter((f) => !t.flags.includes(f));
    const updated = await transition(
      t, ["requested", "matched", "en_route"], "cancelled",
      {
        cancelledAt: now(), cancelledBy: by, cancelledByUserId: actorId, cancelReason: reason,
        cancelFeeMinor: fee.feeMinor, driverCompensationMinor: fee.compensationMinor,
        ...(flags.length ? { flags: [...t.flags, ...flags] } : {}),
      },
      actorId,
      (u) => ({
        topic: "trip.cancelled",
        payload: {
          tripId: u.id, riderId: u.riderUserId, ...(u.driverUserId ? { driverId: u.driverUserId } : {}), cityId: u.cityId,
          by, reason, paymentMethod: u.paymentMethod as PaymentMethod, feeMinor: Number(fee.feeMinor),
          driverCompensationMinor: Number(fee.compensationMinor), ...(beneficiaryOf(u) ? { beneficiary: beneficiaryOf(u)! } : {}), currency: u.currency,
          ...(u.billingOrgId ? { billingOrgId: u.billingOrgId } : {}), ...(u.quoteId ? { quoteId: u.quoteId } : {}),
        },
      }),
      async (tx) => {
        if (t.driverUserId) await tx.driverActiveTrip.deleteMany({ where: { driverUserId: t.driverUserId, tripId: t.id } });
        await tx.tripOffer.updateMany({ where: { tripId: t.id, status: "OFFERED" }, data: { status: "EXPIRED", answeredAt: now() } });
      },
    );
    await matching.stop(t.id);
    for (const o of offered) {
      await redis.del(locationKeys.offer(o.driverUserId));
      realtime.toUser(o.driverUserId, "trip:offer_cancelled", { tripId: t.id });
    }
    // the driver of a cancelled trip stops watching its live position
    if (t.driverUserId) realtime.leaveTrip?.(t.driverUserId, t.id);
    notify(updated);
    return updated;
  }

  function requestedEvent(t: Trip): TripEvent {
    return {
      topic: "trip.requested",
      payload: {
        tripId: t.id, riderId: t.riderUserId, bookedById: t.bookedByUserId, cityId: t.cityId, vehicleType: t.vehicleType, channel: t.channel as Channel,
        paymentMethod: t.paymentMethod as PaymentMethod, fareEstimateMinor: Number(t.fareEstimateMinor),
      },
    };
  }

  /**
   * Who may book this, and through which channel (workflows 05, 10, 11, 12); the platform switches
   * (maintenance, booking channels, payment methods of the city). Shared by on-demand and scheduled
   * bookings.
   */
  async function authorizeBooking(p: Principal, input: BookingInput, cityId: string): Promise<{ riderId: string; channel: Channel; corporate: boolean }> {
    const riderId = input.riderUserId ?? p.userId;
    const onBehalf = riderId !== p.userId;
    const corporate = input.paymentMethod === "CORPORATE";
    if (corporate !== !!input.billingOrgId) throw badRequest("CORPORATE payment needs billingOrgId, and billingOrgId needs CORPORATE payment");

    let channel: Channel;
    if (p.audience === "ride-admin") {
      // call center books for a caller (workflow 10)
      if (!onBehalf) throw badRequest("staff book on behalf of a rider: riderUserId is required");
      authorize(p, "trip:create_on_behalf", { cityId });
      channel = "PHONE";
    } else if (onBehalf) {
      // corporate coordinator books for an employee or guest (workflow 11)
      if (!input.billingOrgId) throw badRequest("booking for someone else needs a corporate account (billingOrgId)");
      authorize(p, "trip:create_on_behalf", { orgId: input.billingOrgId });
      channel = "CORPORATE_PORTAL";
    } else {
      authorize(p, "trip:create", { ownerUserIds: [riderId], ...(input.billingOrgId ? { orgId: input.billingOrgId } : {}) });
      channel = "APP";
    }
    if (input.billingOrgId) authorize(p, "trip:bill_corporate", { orgId: input.billingOrgId });
    // platform switches (admin settings): maintenance pauses new trips; booking channels can be turned off
    if (deps.settings.get<boolean>("maintenance.newTrips")) throw new AppError(503, deps.settings.get<string>("maintenance.message"), "maintenance");
    if (channel === "PHONE" && !deps.settings.get<boolean>("features.phoneBooking")) throw new AppError(403, "phone booking is turned off", "feature_disabled");
    if (input.billingOrgId && !deps.settings.get<boolean>("features.corporateBooking")) throw new AppError(403, "company account bookings are turned off", "feature_disabled");
    // payment methods offered in the city (admin settings → Payments); company accounts are always billed
    if (!corporate && !deps.settings.get<string[]>("payments.methods", cityId).includes(input.paymentMethod)) {
      throw new AppError(403, `${input.paymentMethod.toLowerCase().replace("_", " ")} payments aren't available in this city right now`, "payment_method_unavailable");
    }
    // a coordinator books only for people in the company (auth-service membership), never any account
    if (channel === "CORPORATE_PORTAL") {
      let member: boolean;
      try {
        member = await deps.orgs.isMember(input.billingOrgId!, riderId);
      } catch {
        throw unavailable("company membership");
      }
      if (!member) throw new AppError(403, "the rider isn't a member of this company account", "rider_not_in_org");
    }
    return { riderId, channel, corporate };
  }

  /**
   * The old driver of a reassigned trip leaves it in the shared live state (what location-service
   * does on trip.completed / trip.cancelled, without ending the trip for the rider): back to
   * available if still online, and no longer allowed to watch the trip.
   */
  async function releaseDriver(driverId: string, tripId: string) {
    const state = await getDriverState(redis, driverId);
    // the rider's map shouldn't keep showing the old car
    const p = redis.multi().srem(locationKeys.tripMembers(tripId), driverId).del(locationKeys.tripLast(tripId));
    if (state && state.status === "on_trip" && state.tripId === tripId) {
      p.hset(locationKeys.driver(driverId), { status: "available", tripId: "" });
      if (state.lat !== undefined && state.lng !== undefined && !state.stale) {
        p.zrem(locationKeys.geo(state.cityId, state.vehicleType, "busy"), driverId)
          .geoadd(locationKeys.geo(state.cityId, state.vehicleType, "available"), state.lng, state.lat, driverId);
      }
    }
    await p.exec();
  }

  /** A driver's live state, checked before a dispatcher puts them on a trip. */
  async function assertAssignable(t: Trip, driverId: string) {
    let live: DriverLive | null;
    try {
      live = await location.driver(driverId);
    } catch {
      throw unavailable("driver state");
    }
    if (!live || live.status !== "available" || live.stale) throw conflict("the driver is not available", "driver_unavailable");
    if (live.cityId !== t.cityId || live.vehicleType !== t.vehicleType) throw conflict("the driver's vehicle doesn't match this trip", "driver_unavailable");
    if (live.balanceState === "BLOCKED") throw conflict("the driver's balance is blocked", "driver_unavailable");
    if (t.paymentMethod === "CASH" && !live.cashAllowed) throw conflict("the driver can't take cash trips right now", "driver_unavailable");
    return live;
  }

  /**
   * The trip PIN, with at most PIN_MAX_ATTEMPTS wrong tries per trip. Every try takes a slot first
   * (INCR), so parallel guesses can't get past the limit; the right PIN clears the count.
   */
  async function checkPin(t: Trip, pin: string | undefined) {
    const key = pinFailsKey(t.id);
    const locked = () => new AppError(423, "too many wrong PINs: ask the rider to share a new PIN from their app, or call support", "pin_locked");
    const wrong = (left: number) => badRequest(`wrong trip PIN: ask the rider for the 4-digit code (${left} ${left === 1 ? "try" : "tries"} left)`, "wrong_pin");
    if (pin === undefined) {
      // no guess: nothing to count, but say so if it's locked
      const used = Number((await redis.get(key)) ?? 0);
      throw used >= PIN_MAX_ATTEMPTS ? locked() : wrong(PIN_MAX_ATTEMPTS - used);
    }
    const tries = await redis.incr(key);
    if (tries === 1) await redis.expire(key, PIN_FAILS_TTL_SECONDS);
    if (tries > PIN_MAX_ATTEMPTS) throw locked();
    if (pin !== t.pin) {
      if (tries < PIN_MAX_ATTEMPTS) throw wrong(PIN_MAX_ATTEMPTS - tries);
      logger.warn({ tripId: t.id, driverId: t.driverUserId }, "trip PIN locked after too many wrong tries");
      for (const userId of new Set([t.riderUserId, t.bookedByUserId])) realtime.toUser(userId, "trip:pin_locked", { tripId: t.id });
      throw locked();
    }
    await redis.del(key);
  }

  async function systemCancel(tripId: string, reason: string) {
    const t = await load(tripId);
    if (!["requested", "matched", "en_route"].includes(t.status)) return t;
    return finishCancel(t, "SYSTEM", null, reason, { feeMinor: 0n, compensationMinor: 0n });
  }

  return {
    load,

    // ── workflow 05: request ──────────────────────────────────────────────────
    authorizeBooking,

    async request(p: Principal, input: BookingInput & { quoteId: string }) {
      // one trip per quote: re-booking after a cancellation is fine (without its promo discount:
      // pricing released that for good with the cancelled trip), a second live or finished trip
      // isn't. The partial unique index ux_trip_quote_live is the guarantee; this answers early.
      if (await quoteInUse(input.quoteId)) throw quoteUsed();
      // the trip id is chosen first so pricing books the promo discount for exactly this trip
      const tripId = uuidv7();
      let quote;
      try {
        quote = await quotes.get(input.quoteId, { tripId, userId: p.userId });
      } catch {
        throw unavailable("pricing");
      }
      if (!quote || quote.requestedBy !== p.userId) throw badRequest("unknown quote", "invalid_quote");
      // pricing-service booked the quote's promo discount for this trip when we read it (absent = none)
      const discount = quoteDiscount(quote);

      let trip: Trip;
      try {
        if (new Date(quote.expiresAt).getTime() <= now().getTime()) throw badRequest("the quote has expired, get a new one", "quote_expired");
        const { riderId, channel, corporate } = await authorizeBooking(p, input, quote.cityId);
        if (input.billingOrgId) {
          await deps.policies.check(input.billingOrgId, { vehicleType: quote.vehicleType, fareMinor: quote.fareMinor, at: now(), purpose: input.purpose });
        }
        trip = await db.$transaction(async (tx) => {
          const t = await tx.trip.create({
            data: {
              id: tripId, cityId: quote.cityId, riderUserId: riderId, bookedByUserId: p.userId, channel,
              billingType: corporate ? "CORPORATE" : "PERSONAL", billingOrgId: input.billingOrgId ?? null,
              paymentMethod: input.paymentMethod, vehicleType: quote.vehicleType, quoteId: quote.id,
              pickupLat: quote.pickup.lat, pickupLng: quote.pickup.lng, dropoffLat: quote.dropoff.lat, dropoffLng: quote.dropoff.lng,
              pickupAddress: quote.pickupAddress ?? null, dropoffAddress: quote.dropoffAddress ?? null,
              fareEstimateMinor: BigInt(quote.fareMinor), waitingPerMinMinor: BigInt(quote.waitingPerMinMinor), currency: quote.currency,
              promoDiscountMinor: BigInt(discount), promoCode: discount > 0 ? (quote.promo?.code ?? null) : null,
              estDistanceM: quote.distanceMeters, estDurationS: quote.durationSeconds, routePolyline: quote.routePolyline6 ?? null,
              purpose: input.purpose?.trim() || null,
              pin: String(randomInt(0, 10_000)).padStart(4, "0"), createdAt: now(),
            },
          });
          await tx.tripEvent.create({ data: { tripId: t.id, toStatus: "requested", actorId: p.userId, at: now(), data: { quoteId: quote.id, approximate: quote.approximate, ...(discount > 0 ? { promoDiscountMinor: discount, promoCode: quote.promo?.code ?? null } : {}) } } });
          await writeOutbox(tx, requestedEvent(t));
          return t;
        });
      } catch (err) {
        // no trip was created: give the booked discount back so the rider's retry can have it
        if (discount > 0 && quotes.unbook) {
          const q = quote;
          await quotes.unbook(q.id, tripId).catch((e: Error) => logger.warn({ err: e.message, quoteId: q.id, tripId }, "promo discount not unbooked; it expires with the booking"));
        }
        if (isP2002(err)) throw uniqueViolation(err);
        throw err;
      }
      await matching.start(trip.id);
      notify(trip);
      return trip;
    },

    /**
     * The scheduler's half of a scheduled ride (workflow 12 step 7b): the booking becomes a
     * requested trip and enters normal matching. `priced` is the fresh quote near dispatch (the
     * rider never pays more than the booked fare). The booking row moves DISPATCHING → DISPATCHED in
     * the same transaction. Returns null when someone else dispatched or cancelled it meanwhile.
     */
    async createFromSchedule(s: ScheduledTrip, priced: { fareMinor: bigint; waitingPerMinMinor: bigint; distanceMeters: number; durationSeconds: number; routePolyline6: string | null; quoteId: string }) {
      const trip = await db.$transaction(async (tx) => {
        const t = await tx.trip.create({
          data: {
            cityId: s.cityId, riderUserId: s.riderUserId, bookedByUserId: s.bookedByUserId, channel: s.channel,
            billingType: s.billingType, billingOrgId: s.billingOrgId, paymentMethod: s.paymentMethod, vehicleType: s.vehicleType,
            quoteId: priced.quoteId,
            pickupLat: s.pickupLat, pickupLng: s.pickupLng, dropoffLat: s.dropoffLat, dropoffLng: s.dropoffLng,
            pickupAddress: s.pickupAddress, dropoffAddress: s.dropoffAddress,
            fareEstimateMinor: priced.fareMinor, waitingPerMinMinor: priced.waitingPerMinMinor, currency: s.currency,
            estDistanceM: priced.distanceMeters, estDurationS: priced.durationSeconds, routePolyline: priced.routePolyline6,
            purpose: s.purpose, pin: String(randomInt(0, 10_000)).padStart(4, "0"), createdAt: now(),
          },
        });
        const { count } = await tx.scheduledTrip.updateMany({
          where: { id: s.id, status: "DISPATCHING", version: s.version },
          data: { status: "DISPATCHED", tripId: t.id, dispatchedAt: now(), version: { increment: 1 } },
        });
        if (count === 0) throw new Error("scheduled trip changed during dispatch");
        await tx.tripEvent.create({ data: { tripId: t.id, toStatus: "requested", actorId: null, at: now(), data: { scheduledTripId: s.id, scheduledFor: s.scheduledFor.toISOString(), quoteId: priced.quoteId } } });
        await writeOutbox(tx, requestedEvent(t));
        return t;
      });
      await matching.start(trip.id);
      notify(trip);
      return trip;
    },

    // ── workflow 05: offers ───────────────────────────────────────────────────
    async accept(p: Principal, tripId: string, offerId: string) {
      const offer = await db.tripOffer.findUnique({ where: { id: offerId } });
      if (!offer || offer.tripId !== tripId || offer.driverUserId !== p.userId) throw notFound("offer");
      authorize(p, "trip:accept", { ownerUserIds: [offer.driverUserId] });
      if (offer.status === "DECLINED" || offer.status === "ACCEPTED") throw conflict(`the offer was ${offer.status.toLowerCase()}`, "offer_closed");
      if (offer.status === "EXPIRED") {
        // a late accept is fine while nobody else holds an open offer (workflow 05 §7)
        const other = await db.tripOffer.findFirst({ where: { tripId, status: "OFFERED" } });
        if (other) throw conflict("this trip is no longer available", "offer_closed");
      }
      const t = await load(tripId);
      if (t.status !== "requested") throw conflict("this trip is no longer available", "invalid_state");
      return matchDriver(t, p.userId, p.userId, offerId);
    },

    async decline(p: Principal, tripId: string, offerId: string) {
      const offer = await db.tripOffer.findUnique({ where: { id: offerId } });
      if (!offer || offer.tripId !== tripId || offer.driverUserId !== p.userId) throw notFound("offer");
      authorize(p, "trip:accept", { ownerUserIds: [offer.driverUserId] });
      const { count } = await db.tripOffer.updateMany({ where: { id: offerId, status: "OFFERED" }, data: { status: "DECLINED", answeredAt: now() } });
      if (count === 0) return { declined: false };
      await redis.sadd(`match:${tripId}:declined`, p.userId);
      await redis.del(locationKeys.offer(p.userId));
      await matching.poke(tripId);
      return { declined: true };
    },

    /** Dispatcher fallback (trip:assign @ CITY). */
    async assign(p: Principal, tripId: string, driverId: string) {
      const t = await load(tripId);
      authorize(p, "trip:assign", { cityId: t.cityId });
      if (driverId === t.riderUserId) throw badRequest("a rider can't drive their own trip");
      return matchDriver(t, driverId, p.userId);
    },

    /**
     * Dispatcher takes a matched trip from its driver (trip:reassign @ CITY): to a named driver
     * (→ matched with them), or back to matching (→ requested, the old driver skipped). Only before
     * pickup (matched / en route). Audited; the old driver gets `trip:reassigned`, everyone on the
     * trip a `trip:status`.
     */
    async reassign(p: Principal, tripId: string, input: { driverId?: string; reason?: string }) {
      const t = await load(tripId);
      authorize(p, "trip:reassign", { cityId: t.cityId });
      if (t.status !== "matched" && t.status !== "en_route") throw invalidState(t.status);
      const from = t.driverUserId!;
      const to = input.driverId;
      if (to === from) throw badRequest("that driver already has this trip", "same_driver");
      if (to && (to === t.riderUserId || to === t.bookedByUserId)) throw badRequest("a rider can't drive their own trip");
      const reason = input.reason?.trim() || undefined;
      const reassigned = (u: Trip) => ({
        topic: "trip.reassigned" as const,
        payload: { tripId: u.id, riderId: u.riderUserId, cityId: u.cityId, fromDriverId: from, ...(to ? { toDriverId: to } : {}), byUserId: p.userId, ...(reason ? { reason } : {}) },
      });
      const flags = t.flags.includes("REASSIGNED") ? t.flags : [...t.flags, "REASSIGNED"];
      const history = { reassignedFrom: from, ...(to ? { reassignedTo: to } : {}), by: p.userId, ...(reason ? { reason } : {}) };
      const auditEvent = audit({
        actorId: p.userId, action: "trip:reassign", resource: { type: "trip", id: t.id }, outcome: "EXECUTED",
        reason: `${from} → ${to ?? "matching"}${reason ? ` · ${reason}` : ""}`,
      });

      let updated: Trip;
      try {
        if (to) {
          const live = await assertAssignable(t, to);
          const ownerType = live.fleetOrgId ? "ORGANIZATION" : "INDIVIDUAL";
          updated = await transition(
            t, ["matched", "en_route"], "matched",
            { driverUserId: to, vehicleId: live.vehicleId, vehicleOwnerType: ownerType, beneficiaryId: live.fleetOrgId ?? to, matchedAt: now(), arrivedAt: null, flags },
            p.userId, matchedEvent(to),
            async (tx, u) => {
              await tx.driverActiveTrip.deleteMany({ where: { driverUserId: from, tripId: t.id } });
              await tx.driverActiveTrip.create({ data: { driverUserId: to, tripId: t.id, since: now() } });
              await writeOutbox(tx, reassigned(u));
              await writeOutbox(tx, auditEvent);
            },
            history,
          );
          await redis.del(locationKeys.offer(to));
        } else {
          updated = await transition(
            t, ["matched", "en_route"], "requested",
            { driverUserId: null, vehicleId: null, vehicleOwnerType: null, beneficiaryId: null, matchedAt: null, arrivedAt: null, flags },
            p.userId, reassigned,
            async (tx) => {
              await tx.driverActiveTrip.deleteMany({ where: { driverUserId: from, tripId: t.id } });
              await writeOutbox(tx, auditEvent);
            },
            history,
          );
          await matching.start(t.id);
          // the old driver isn't offered it again
          await redis.sadd(`match:${t.id}:declined`, from);
        }
      } catch (err) {
        if (isP2002(err)) throw conflict("the driver already has an active trip", "driver_busy");
        throw err;
      }
      await releaseDriver(from, t.id);
      // and stops receiving the car's live positions now, not at their next subscribe
      realtime.leaveTrip?.(from, t.id);
      realtime.toUser(from, "trip:reassigned", { tripId: t.id, reason: reason ?? null });
      notify(updated);
      return updated;
    },

    /**
     * Matching ran out of time. A scheduled ride keeps searching until shortly after its pickup
     * time and is escalated to dispatch once (workflow 12 step 8); any other trip is cancelled with
     * NO_DRIVER_FOUND. Returns true when matching should go on.
     */
    async matchTimedOut(tripId: string): Promise<boolean> {
      const t = await load(tripId);
      if (t.status !== "requested") return false;
      const s = await db.scheduledTrip.findUnique({ where: { tripId } });
      if (s && now().getTime() < s.scheduledFor.getTime() + SCHEDULED_SEARCH_GRACE_MS) {
        if (!t.flags.includes("DISPATCH_ESCALATED")) {
          try {
            const u = await transition(
              t, ["requested"], "requested", { flags: [...t.flags, "DISPATCH_ESCALATED"] }, null,
              (x) => ({ topic: "trip.dispatch_escalated", payload: { tripId: x.id, scheduledTripId: s.id, riderId: x.riderUserId, cityId: x.cityId, vehicleType: x.vehicleType, scheduledFor: s.scheduledFor.toISOString() } }),
              async (tx) => void (await tx.scheduledTrip.update({ where: { id: s.id }, data: { escalatedAt: now() } })),
              { escalated: true, scheduledTripId: s.id },
            );
            logger.warn({ tripId, scheduledTripId: s.id }, "scheduled trip still unmatched: escalated to dispatch");
            notify(u);
          } catch (err) {
            if (!(err instanceof AppError)) throw err;
            return false; // matched or cancelled meanwhile
          }
        }
        return true;
      }
      await systemCancel(tripId, "NO_DRIVER_FOUND");
      return false;
    },

    // ── workflow 06: execution ────────────────────────────────────────────────
    async enRoute(p: Principal, tripId: string) {
      const t = await load(tripId);
      assertDriver(p, t);
      const u = await transition(t, ["matched"], "en_route", {}, p.userId, progressEvent("trip.driver_en_route"));
      notify(u);
      return u;
    },

    /** "Arrived": only within the arrival radius of the pickup, by the last ping (workflow 06 step 5). */
    async arrive(p: Principal, tripId: string) {
      const t = await load(tripId);
      assertDriver(p, t);
      if (t.status === "matched") throw invalidState("not en route yet: tap \"On my way\" first");
      if (t.arrivedAt) return t;
      const policy = policyFor(deps.settings, t.cityId);
      const pos = await livePosition(p.userId);
      if (!pos) throw conflict("your position is unknown: check that location is on", "position_unknown");
      const meters = haversineMeters(pos, { lat: t.pickupLat, lng: t.pickupLng });
      if (meters > policy.arrivalRadiusMeters) throw conflict(`you're ${Math.round(meters)} m from the pickup`, "too_far_from_pickup");
      // a timestamp inside en_route, not a status (workflow conventions)
      const u = await transition(t, ["en_route"], "en_route", { arrivedAt: now() }, p.userId, progressEvent("trip.driver_arrived"), undefined, { arrived: true, metersFromPickup: Math.round(meters) });
      notify(u);
      return u;
    },

    async start(p: Principal, tripId: string, pin?: string) {
      const t = await load(tripId);
      assertDriver(p, t);
      if (!t.arrivedAt) throw conflict("tap \"Arrived\" at the pickup first", "not_arrived");
      if (t.status !== "en_route") throw invalidState(t.status);
      if (deps.settings.get<boolean>("trip.pinRequired")) await checkPin(t, pin);
      const u = await transition(t, ["en_route"], "in_progress", { startedAt: now() }, p.userId, progressEvent("trip.started"));
      notify(u);
      return u;
    },

    /**
     * A new trip PIN, and the PIN check unlocked (after PIN_MAX_ATTEMPTS wrong tries): the rider or
     * whoever booked the ride (they read the new PIN in their app), or support (trip:cancel @ CITY).
     * Only before the ride starts.
     */
    async resetPin(p: Principal, tripId: string) {
      const t = await readable(p, tripId);
      const riderSide = p.userId === t.riderUserId || p.userId === t.bookedByUserId;
      if (!riderSide) {
        if (p.audience !== "ride-admin") throw new AppError(403, "only the rider or support can reset the trip PIN", "forbidden");
        authorize(p, "trip:cancel", { cityId: t.cityId });
      }
      if (t.status !== "matched" && t.status !== "en_route") throw invalidState(t.status);
      const status = t.status as Status;
      const u = await transition(t, [status], status, { pin: newPin() }, p.userId, undefined, undefined, { pinReset: true, by: riderSide ? "rider" : "staff" });
      await redis.del(pinFailsKey(t.id));
      notify(u);
      return u;
    },

    /**
     * Drop-off (workflow 06 step 13–16). Final fare = the quote + paid waiting; the rider pays it
     * minus the booked promo discount (never below 0), the event carries both. Completing far
     * from the drop-off is flagged for review. The trip's actual distance is the driven distance
     * of the GPS trace (straight lines between thinned points; OSRM /match isn't used yet), else
     * the planned route.
     */
    async complete(p: Principal, tripId: string) {
      const t = await load(tripId);
      assertDriver(p, t);
      if (t.status !== "in_progress") throw invalidState(t.status);
      const policy = policyFor(deps.settings, t.cityId);
      const at = now();
      const waiting = waitingFee(policy, t.arrivedAt, t.startedAt ?? at, t.waitingPerMinMinor);
      const fare = t.fareEstimateMinor + waiting;
      const discount = payableDiscount({ ...t, fareFinalMinor: fare });
      const durationS = t.startedAt ? Math.max(0, Math.round((at.getTime() - t.startedAt.getTime()) / 1000)) : t.estDurationS;
      // the driven distance from the GPS trace when there is one, else the planned route
      const traced = t.startedAt ? await deps.trace?.rideDistance(t.id, t.startedAt, at).catch(() => null) : null;
      const distanceM = traced && traced > 0 ? traced : t.estDistanceM;

      const flags = [...t.flags];
      const flag = (f: string) => void (flags.includes(f) || flags.push(f));
      const pos = await livePosition(p.userId).catch(() => null);
      const fromDropoff = pos ? haversineMeters(pos, { lat: t.dropoffLat, lng: t.dropoffLng }) : undefined;
      const fromPickup = pos ? haversineMeters(pos, { lat: t.pickupLat, lng: t.pickupLng }) : undefined;
      const farFromDropoff = fromDropoff !== undefined && fromDropoff > policy.completeFarFromDropoffMeters;
      const rideSeconds = t.startedAt ? (at.getTime() - t.startedAt.getTime()) / 1000 : 0;
      const early = rideSeconds < MIN_RIDE_SECONDS;
      // a ride that obviously didn't happen: ended right after the start, the car still at the pickup
      if (early && farFromDropoff && fromPickup !== undefined && fromPickup < STILL_AT_PICKUP_METERS) {
        logger.warn({ tripId: t.id, driverId: t.driverUserId, rideSeconds: Math.round(rideSeconds), metersFromPickup: Math.round(fromPickup) }, "completion refused: the car hasn't left the pickup");
        throw conflict("the car is still at the pickup: complete the trip at the drop-off", "trip_not_driven");
      }
      if (farFromDropoff) flag("FAR_FROM_DROPOFF");
      if (early) flag("SHORT_TRIP");

      const u = await transition(
        t, ["in_progress"], "completed",
        { completedAt: at, fareFinalMinor: fare, waitingFeeMinor: waiting, distanceM, durationS, flags },
        p.userId,
        (x) => ({
          topic: "trip.completed",
          payload: {
            tripId: x.id, riderId: x.riderUserId, driverId: x.driverUserId!, cityId: x.cityId, vehicleType: x.vehicleType,
            vehicleId: x.vehicleId!, beneficiary: beneficiaryOf(x)!, paymentMethod: x.paymentMethod as PaymentMethod,
            billingType: x.billingType as "PERSONAL" | "CORPORATE", ...(x.billingOrgId ? { billingOrgId: x.billingOrgId } : {}),
            fareMinor: Number(fare), waitingFeeMinor: Number(waiting), currency: x.currency,
            ...(x.quoteId ? { quoteId: x.quoteId } : {}), promoDiscountMinor: Number(discount),
            distanceMeters: x.distanceM ?? x.estDistanceM, durationSeconds: durationS, completedAt: at.toISOString(),
          },
        }),
        async (tx) => {
          await tx.driverActiveTrip.deleteMany({ where: { driverUserId: t.driverUserId!, tripId: t.id } });
        },
        fromDropoff !== undefined ? { metersFromDropoff: Math.round(fromDropoff) } : undefined,
      );
      notify(u);
      return u;
    },

    // ── workflow 07: cancellations ────────────────────────────────────────────
    async cancel(p: Principal, tripId: string, reason: string) {
      const t = await readable(p, tripId);
      authorize(p, "trip:cancel", {
        ownerUserIds: [t.riderUserId, ...(t.driverUserId ? [t.driverUserId] : [])],
        cityId: t.cityId,
        ...(t.billingOrgId ? { orgId: t.billingOrgId } : {}),
      });
      if (!["requested", "matched", "en_route"].includes(t.status)) throw invalidState(t.status);
      const by: CancelledBy = p.audience === "ride-admin" ? "STAFF" : p.userId === t.driverUserId ? "DRIVER" : "RIDER";
      const policy = policyFor(deps.settings, t.cityId);

      if (by === "DRIVER" && reason === "NO_SHOW") {
        // workflow 07: only after waiting the full no-show time, still at the pickup
        if (!t.arrivedAt || now().getTime() - t.arrivedAt.getTime() < policy.noShowAfterSeconds * 1000) {
          throw conflict(`a no-show can be reported ${policy.noShowAfterSeconds / 60} minutes after arriving`, "too_early_for_no_show");
        }
        const pos = await livePosition(p.userId);
        if (!pos || haversineMeters(pos, { lat: t.pickupLat, lng: t.pickupLng }) > policy.arrivalRadiusMeters) {
          throw conflict("you must still be at the pickup to report a no-show", "too_far_from_pickup");
        }
      } else if (reason === "NO_SHOW") {
        throw badRequest("only the driver reports a no-show");
      }

      const fee = cancellationFee(policy, {
        by, reason, status: t.status, matchedAt: t.matchedAt, arrivedAt: t.arrivedAt, waitingPerMinMinor: t.waitingPerMinMinor, now: now(),
      });
      // the rider's word alone doesn't waive the fee: the usual rules apply and support reviews it
      // (a refund when the driver did ask; drivers who keep asking show up in the flags)
      const review = by === "RIDER" && reason === "DRIVER_ASKED_TO_CANCEL" ? ["RIDER_SAYS_DRIVER_ASKED"] : [];
      return finishCancel(t, by, p.userId, reason, fee, review);
    },

    /** Matching timed out, or another system rule. Always free. */
    systemCancel,

    // ── workflow 08: rating ───────────────────────────────────────────────────
    async rate(p: Principal, tripId: string, input: { stars: number; comment?: string; tags?: string[] }) {
      const t = await load(tripId);
      const byRole = p.userId === t.riderUserId ? "RIDER" : p.userId === t.driverUserId ? "DRIVER" : undefined;
      if (!byRole) throw notFound("trip");
      if (t.status !== "completed" || !t.completedAt) throw invalidState(t.status);
      if (now().getTime() - t.completedAt.getTime() > 7 * 86_400_000) throw conflict("ratings close 7 days after the trip", "rating_closed");
      const allowed: readonly string[] = RATING_TAGS[byRole];
      const tags = [...new Set(input.tags ?? [])];
      const unknown = tags.filter((x) => !allowed.includes(x));
      if (unknown.length) throw badRequest(`unknown tags: ${unknown.join(", ")}`, "invalid_tags");
      const rateeUserId = byRole === "RIDER" ? t.driverUserId : t.riderUserId;
      try {
        await db.tripRating.create({ data: { tripId, byRole, byUserId: p.userId, rateeUserId, stars: input.stars, tags, comment: input.comment?.trim() || null } });
      } catch (err) {
        if (isP2002(err)) throw conflict("you already rated this trip", "already_rated");
        throw err;
      }
      if (rateeUserId) await redis.del(ratingKey(rateeUserId));
      return { tripId, byRole, stars: input.stars, tags };
    },

    /** My rating of a trip (null when I haven't rated it). */
    async ratingOf(p: Principal, tripId: string) {
      const t = await readable(p, tripId);
      const byRole = p.userId === t.riderUserId ? "RIDER" : p.userId === t.driverUserId ? "DRIVER" : undefined;
      if (!byRole) return { mine: null };
      const r = await db.tripRating.findUnique({ where: { tripId_byRole: { tripId: t.id, byRole } } });
      return { mine: r ? { stars: r.stars, tags: r.tags, comment: r.comment } : null };
    },

    /** The average a person has received (cached 5 min; rate() clears it). */
    ratingOfUser: (userId: string) => ratingOfUser(userId),

    // ── reads ─────────────────────────────────────────────────────────────────
    readable,
    events,

    /** My trips, newest first (keyset pagination on created_at). */
    async mine(p: Principal, as: "rider" | "driver", before?: Date, limit = 20) {
      const where = as === "rider" ? { riderUserId: p.userId } : { driverUserId: p.userId };
      return db.trip.findMany({
        where: { ...where, ...(before ? { createdAt: { lt: before } } : {}) },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
    },

    async active(p: Principal) {
      return db.trip.findFirst({
        where: { status: { in: [...ACTIVE] }, OR: [{ riderUserId: p.userId }, { driverUserId: p.userId }] },
        orderBy: { createdAt: "desc" },
      });
    },

    /** Dispatcher live board (trip:read @ CITY). */
    async board(p: Principal, cityId: string) {
      authorize(p, "trip:read", { cityId });
      return db.trip.findMany({ where: { cityId, status: { in: [...ACTIVE] } }, orderBy: { createdAt: "asc" }, take: 500 });
    },

    logger,
  };
}

export type TripService = ReturnType<typeof createTripService>;
