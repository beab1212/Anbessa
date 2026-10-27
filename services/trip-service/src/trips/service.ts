// The trip lifecycle (architecture §6, workflows 05–08). Only trip-service changes a trip's status.
//
//   requested → matched → en_route → in_progress → completed
//        ↘──────────↘─────────↘ cancelled
//
// Every transition is ONE transaction: a conditional UPDATE (… WHERE status IN (allowed) AND
// version = v), a trip_event row and an outbox row. Zero rows updated means someone else changed
// the trip first: the caller gets 409 with the current status (Database.md §9, race 2).

import { randomInt } from "node:crypto";
import type { Redis } from "ioredis";
import { authorize, can, type Principal } from "@ride-app/shared-authz";
import { haversineMeters, keys as locationKeys } from "@ride-app/shared-location";
import { RATING_TAGS, type Beneficiary, type PaymentMethod } from "@ride-app/shared-types";
import type { Logger } from "@ride-app/shared-utils";
import { Prisma, type Trip } from "../generated/prisma/client.js";
import type { Db } from "../db.js";
import type { DriverLive, LocationClient } from "../lib/clients.js";
import { AppError, badRequest, conflict, notFound } from "../lib/errors.js";
import type { Realtime } from "../lib/realtime.js";
import { writeOutbox, type TripEvent } from "../outbox/outbox.js";
import type { QuoteProvider } from "../quotes.js";
import { cancellationFee, policyFor, waitingFee, type CancelledBy } from "./policy.js";
import type { SettingsReader } from "@ride-app/shared-settings";

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
  now?: () => Date;
}

const unavailable = (what: string) => new AppError(503, `${what} is temporarily unavailable`, "dependency_unavailable");
const invalidState = (status: string) => new AppError(409, `the trip is ${status}`, "invalid_state");
const isP2002 = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

function beneficiaryOf(t: Pick<Trip, "vehicleOwnerType" | "beneficiaryId">): Beneficiary | undefined {
  if (!t.beneficiaryId || !t.vehicleOwnerType) return undefined;
  return { type: t.vehicleOwnerType as Beneficiary["type"], id: t.beneficiaryId };
}

/** What a caller sees. The PIN only goes to the rider's side; review flags only to staff. */
export function tripView(t: Trip, viewer?: Principal) {
  const riderSide = viewer && (viewer.userId === t.riderUserId || viewer.userId === t.bookedByUserId);
  const staff = viewer?.audience === "ride-admin";
  const n = (v: bigint | null) => (v === null ? null : Number(v));
  return {
    id: t.id,
    status: t.status,
    cityId: t.cityId,
    channel: t.channel,
    vehicleType: t.vehicleType,
    paymentMethod: t.paymentMethod,
    billing: { type: t.billingType, orgId: t.billingOrgId },
    riderUserId: t.riderUserId,
    pickup: { lat: t.pickupLat, lng: t.pickupLng, address: t.pickupAddress },
    dropoff: { lat: t.dropoffLat, lng: t.dropoffLng, address: t.dropoffAddress },
    driver: t.driverUserId ? { userId: t.driverUserId, vehicleId: t.vehicleId } : null,
    fare: {
      estimateMinor: Number(t.fareEstimateMinor), finalMinor: n(t.fareFinalMinor),
      waitingFeeMinor: n(t.waitingFeeMinor), currency: t.currency,
    },
    route: { estDistanceMeters: t.estDistanceM, estDurationSeconds: t.estDurationS, distanceMeters: t.distanceM, durationSeconds: t.durationS, polyline: t.routePolyline },
    times: { requestedAt: t.createdAt, matchedAt: t.matchedAt, arrivedAt: t.arrivedAt, startedAt: t.startedAt, completedAt: t.completedAt, cancelledAt: t.cancelledAt },
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

  /** Trip readers: its rider, booker and driver; staff in its city; the billing org; the vehicle's fleet. */
  function mayRead(p: Principal, t: Trip): boolean {
    const owners = [t.riderUserId, t.bookedByUserId, ...(t.driverUserId ? [t.driverUserId] : [])];
    if (can(p, "trip:read", { ownerUserIds: owners, cityId: t.cityId, ...(t.billingOrgId ? { orgId: t.billingOrgId } : {}) })) return true;
    return t.vehicleOwnerType === "ORGANIZATION" && !!t.beneficiaryId && can(p, "trip:read", { orgId: t.beneficiaryId });
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
    const payload = { tripId: t.id, status: t.status, trip: tripView(t) };
    for (const userId of new Set([t.riderUserId, t.bookedByUserId, ...(t.driverUserId ? [t.driverUserId] : [])])) {
      realtime.toUser(userId, event, payload);
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
    if (!live || live.lat === undefined || live.lng === undefined || live.at === undefined || now().getTime() - live.at > 60_000) return null;
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

    const ownerType = live.fleetOrgId ? "ORGANIZATION" : "INDIVIDUAL";
    try {
      const updated = await transition(
        t, ["requested"], "matched",
        {
          driverUserId: driverId, vehicleId: live.vehicleId, vehicleOwnerType: ownerType,
          beneficiaryId: live.fleetOrgId ?? driverId, matchedAt: now(),
        },
        actorId,
        (u) => ({ topic: "trip.matched", payload: { tripId: u.id, riderId: u.riderUserId, driverId, cityId: u.cityId, vehicleType: u.vehicleType } }),
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

  async function finishCancel(t: Trip, by: CancelledBy, actorId: string | null, reason: string, fee: { feeMinor: bigint; compensationMinor: bigint }) {
    const offered = await db.tripOffer.findMany({ where: { tripId: t.id, status: "OFFERED" }, select: { driverUserId: true } });
    const updated = await transition(
      t, ["requested", "matched", "en_route"], "cancelled",
      {
        cancelledAt: now(), cancelledBy: by, cancelledByUserId: actorId, cancelReason: reason,
        cancelFeeMinor: fee.feeMinor, driverCompensationMinor: fee.compensationMinor,
      },
      actorId,
      (u) => ({
        topic: "trip.cancelled",
        payload: {
          tripId: u.id, riderId: u.riderUserId, ...(u.driverUserId ? { driverId: u.driverUserId } : {}), cityId: u.cityId,
          by, reason, paymentMethod: u.paymentMethod as PaymentMethod, feeMinor: Number(fee.feeMinor),
          driverCompensationMinor: Number(fee.compensationMinor), ...(beneficiaryOf(u) ? { beneficiary: beneficiaryOf(u)! } : {}), currency: u.currency,
          ...(u.billingOrgId ? { billingOrgId: u.billingOrgId } : {}),
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
    notify(updated);
    return updated;
  }

  return {
    load,

    // ── workflow 05: request ──────────────────────────────────────────────────
    async request(p: Principal, input: { quoteId: string; paymentMethod: PaymentMethod; riderUserId?: string; billingOrgId?: string }) {
      let quote;
      try {
        quote = await quotes.get(input.quoteId);
      } catch {
        throw unavailable("pricing");
      }
      if (!quote || quote.requestedBy !== p.userId) throw badRequest("unknown quote", "invalid_quote");
      if (new Date(quote.expiresAt).getTime() <= now().getTime()) throw badRequest("the quote has expired, get a new one", "quote_expired");

      const riderId = input.riderUserId ?? p.userId;
      const onBehalf = riderId !== p.userId;
      const corporate = input.paymentMethod === "CORPORATE";
      if (corporate !== !!input.billingOrgId) throw badRequest("CORPORATE payment needs billingOrgId, and billingOrgId needs CORPORATE payment");

      let channel: "APP" | "PHONE" | "CORPORATE_PORTAL";
      if (p.audience === "ride-admin") {
        // call center books for a caller (workflow 10)
        if (!onBehalf) throw badRequest("staff book on behalf of a rider: riderUserId is required");
        authorize(p, "trip:create_on_behalf", { cityId: quote.cityId });
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
      if (!corporate && !deps.settings.get<string[]>("payments.methods", quote.cityId).includes(input.paymentMethod)) {
        throw new AppError(403, `${input.paymentMethod.toLowerCase().replace("_", " ")} payments aren't available in this city right now`, "payment_method_unavailable");
      }

      try {
        const trip = await db.$transaction(async (tx) => {
          const t = await tx.trip.create({
            data: {
              cityId: quote.cityId, riderUserId: riderId, bookedByUserId: p.userId, channel,
              billingType: corporate ? "CORPORATE" : "PERSONAL", billingOrgId: input.billingOrgId ?? null,
              paymentMethod: input.paymentMethod, vehicleType: quote.vehicleType, quoteId: quote.id,
              pickupLat: quote.pickup.lat, pickupLng: quote.pickup.lng, dropoffLat: quote.dropoff.lat, dropoffLng: quote.dropoff.lng,
              pickupAddress: quote.pickupAddress ?? null, dropoffAddress: quote.dropoffAddress ?? null,
              fareEstimateMinor: BigInt(quote.fareMinor), waitingPerMinMinor: BigInt(quote.waitingPerMinMinor), currency: quote.currency,
              estDistanceM: quote.distanceMeters, estDurationS: quote.durationSeconds, routePolyline: quote.routePolyline6 ?? null,
              pin: String(randomInt(0, 10_000)).padStart(4, "0"), createdAt: now(),
            },
          });
          await tx.tripEvent.create({ data: { tripId: t.id, toStatus: "requested", actorId: p.userId, at: now(), data: { quoteId: quote.id, approximate: quote.approximate } } });
          await writeOutbox(tx, {
            topic: "trip.requested",
            payload: {
              tripId: t.id, riderId, bookedById: p.userId, cityId: t.cityId, vehicleType: t.vehicleType, channel,
              paymentMethod: input.paymentMethod, fareEstimateMinor: quote.fareMinor,
            },
          });
          return t;
        });
        await matching.start(trip.id);
        notify(trip);
        return trip;
      } catch (err) {
        if (isP2002(err)) throw conflict("the rider already has an active trip", "active_trip_exists");
        throw err;
      }
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
      if (deps.settings.get<boolean>("trip.pinRequired") && pin !== t.pin) throw badRequest("wrong trip PIN: ask the rider for the 4-digit code", "wrong_pin");
      const u = await transition(t, ["en_route"], "in_progress", { startedAt: now() }, p.userId, progressEvent("trip.started"));
      notify(u);
      return u;
    },

    /**
     * Drop-off (workflow 06 step 13–16). Final fare = the quote + paid waiting. Completing far
     * from the drop-off is flagged for review. The trip's actual distance is the planned route
     * until GPS-trace matching (OSRM /match) is added.
     */
    async complete(p: Principal, tripId: string) {
      const t = await load(tripId);
      assertDriver(p, t);
      if (t.status !== "in_progress") throw invalidState(t.status);
      const policy = policyFor(deps.settings, t.cityId);
      const at = now();
      const waiting = waitingFee(policy, t.arrivedAt, t.startedAt ?? at, t.waitingPerMinMinor);
      const fare = t.fareEstimateMinor + waiting;
      const durationS = t.startedAt ? Math.max(0, Math.round((at.getTime() - t.startedAt.getTime()) / 1000)) : t.estDurationS;

      const flags = [...t.flags];
      const pos = await livePosition(p.userId).catch(() => null);
      const fromDropoff = pos ? haversineMeters(pos, { lat: t.dropoffLat, lng: t.dropoffLng }) : undefined;
      if (fromDropoff !== undefined && fromDropoff > policy.completeFarFromDropoffMeters) flags.push("FAR_FROM_DROPOFF");

      const u = await transition(
        t, ["in_progress"], "completed",
        { completedAt: at, fareFinalMinor: fare, waitingFeeMinor: waiting, distanceM: t.estDistanceM, durationS, flags },
        p.userId,
        (x) => ({
          topic: "trip.completed",
          payload: {
            tripId: x.id, riderId: x.riderUserId, driverId: x.driverUserId!, cityId: x.cityId, vehicleType: x.vehicleType,
            vehicleId: x.vehicleId!, beneficiary: beneficiaryOf(x)!, paymentMethod: x.paymentMethod as PaymentMethod,
            billingType: x.billingType as "PERSONAL" | "CORPORATE", ...(x.billingOrgId ? { billingOrgId: x.billingOrgId } : {}),
            fareMinor: Number(fare), waitingFeeMinor: Number(waiting), currency: x.currency,
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
      return finishCancel(t, by, p.userId, reason, fee);
    },

    /** Matching timed out, or another system rule. Always free. */
    async systemCancel(tripId: string, reason: string) {
      const t = await load(tripId);
      if (!["requested", "matched", "en_route"].includes(t.status)) return t;
      return finishCancel(t, "SYSTEM", null, reason, { feeMinor: 0n, compensationMinor: 0n });
    },

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
