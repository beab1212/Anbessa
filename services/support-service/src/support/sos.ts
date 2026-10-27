// SOS (workflow 14): the highest-priority path. A rider or driver on an active trip (or up to 30
// min after drop-off) presses SOS; the alert lands in the city's queue for safety officers and
// dispatchers (they poll: realtime-gateway admits only ride-app tokens). One live alert per user
// and trip: a second press returns it. If trip-service can't answer, the alert is still accepted
// when the app sends its city (safety first), marked tripVerified=false.

import { authorize, can, type Principal } from "@ride-app/shared-authz";
import { Prisma, type SosAlert, type SosOutcome } from "../generated/prisma/client.js";
import { conflict, forbidden, notFound } from "../lib/errors.js";
import { TripServiceUnavailable, type TripFacts } from "../lib/trips.js";
import { audit, compact, writeOutbox } from "../outbox/outbox.js";
import { cityFilter, invalidTransition, isStaff, raced, type SupportDeps } from "./common.js";
import { canMoveSos, LIMITS, sosAvailable } from "./policy.js";
import { noteView, ownSosView, sosView } from "./views.js";

export interface Position {
  lat: number;
  lng: number;
  accuracy?: number;
}

export function createSosService(deps: SupportDeps) {
  const { db, trips, realtime, logger, now } = deps;

  const live = (userId: string, tripId: string) => db.sosAlert.findFirst({ where: { userId, tripId, status: { in: ["OPEN", "ACKNOWLEDGED"] } }, orderBy: { triggeredAt: "desc" } });

  async function moveLocation(a: SosAlert, pos: Position) {
    return db.sosAlert.update({ where: { id: a.id }, data: { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy ?? null, locationAt: now() } });
  }

  /** Staff with sos:respond in the alert's city, else 404. */
  async function responded(p: Principal, id: string) {
    const a = await db.sosAlert.findUnique({ where: { id } });
    if (!a || !isStaff(p) || !can(p, "sos:respond", { cityId: a.cityId })) throw notFound("SOS alert");
    return a;
  }

  async function update(a: SosAlert, data: Prisma.SosAlertUncheckedUpdateManyInput, events: Parameters<typeof writeOutbox>[1][]) {
    return db.$transaction(async (tx) => {
      const { count } = await tx.sosAlert.updateMany({ where: { id: a.id, version: a.version }, data: { ...data, version: { increment: 1 } } });
      if (count === 0) throw raced();
      await writeOutbox(tx, ...events);
      return tx.sosAlert.findUniqueOrThrow({ where: { id: a.id } });
    });
  }

  return {
    async trigger(p: Principal, body: { tripId: string; location: Position; cityId?: string }) {
      if (isStaff(p)) throw forbidden("SOS is pressed in the app");
      authorize(p, "sos:trigger", { ownerUserIds: [p.userId] });
      const at = now();

      // a second press (or a retry after a lost response) returns the live alert
      const existing = await live(p.userId, body.tripId);
      if (existing) return { alert: ownSosView(await moveLocation(existing, body.location)), duplicate: true, statusCode: 200 };
      const recent = await db.sosAlert.findFirst({ where: { userId: p.userId, tripId: body.tripId, triggeredAt: { gt: new Date(at.getTime() - LIMITS.sosDedupeMs) } }, orderBy: { triggeredAt: "desc" } });
      if (recent) return { alert: ownSosView(recent), duplicate: true, statusCode: 200 };

      let trip: TripFacts | null = null;
      let verified = true;
      try {
        trip = await trips.get(body.tripId);
      } catch (err) {
        if (!(err instanceof TripServiceUnavailable) || !body.cityId) throw err;
        verified = false;
        logger.warn({ tripId: body.tripId, userId: p.userId }, "SOS accepted without trip-service (unverified)");
      }
      let role: "RIDER" | "DRIVER" = "RIDER";
      if (trip) {
        if (trip.driverUserId === p.userId) role = "DRIVER";
        else if (![trip.riderUserId, trip.bookedByUserId].includes(p.userId)) throw notFound("trip");
        if (!sosAvailable(trip, at)) throw conflict("SOS is available during a trip and for 30 minutes after drop-off", "sos_unavailable");
      } else if (verified) {
        throw notFound("trip");
      }

      try {
        const alert = await db.$transaction(async (tx) => {
          const a = await tx.sosAlert.create({
            data: {
              cityId: trip?.cityId ?? body.cityId!, tripId: body.tripId, userId: p.userId, role, source: "APP",
              lat: body.location.lat, lng: body.location.lng, accuracy: body.location.accuracy ?? null, locationAt: at,
              tripVerified: verified, riderUserId: trip?.riderUserId ?? (role === "RIDER" ? p.userId : null), driverUserId: trip?.driverUserId ?? null, triggeredAt: at,
            },
          });
          await writeOutbox(tx, {
            topic: "sos.triggered", key: a.id,
            payload: compact({
              alertId: a.id, cityId: a.cityId, tripId: a.tripId, userId: a.userId, role: a.role, source: a.source, lat: a.lat, lng: a.lng,
              triggeredAt: a.triggeredAt.toISOString(), riderUserId: a.riderUserId ?? undefined, driverUserId: a.driverUserId ?? undefined, tripVerified: a.tripVerified,
            }),
          });
          return a;
        });
        logger.warn({ alertId: alert.id, cityId: alert.cityId }, "SOS triggered");
        return { alert: ownSosView(alert), duplicate: false, statusCode: 201 };
      } catch (err) {
        // two presses at once: the partial unique index lets one in
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          const winner = await live(p.userId, body.tripId);
          if (winner) return { alert: ownSosView(winner), duplicate: true, statusCode: 200 };
        }
        throw err;
      }
    },

    /** The phone keeps the position fresh while the alert is live. */
    async location(p: Principal, id: string, pos: Position) {
      const a = await db.sosAlert.findUnique({ where: { id } });
      if (!a || a.userId !== p.userId || isStaff(p)) throw notFound("SOS alert");
      if (a.status === "RESOLVED") throw conflict("the alert is resolved", "sos_resolved");
      return ownSosView(await moveLocation(a, pos));
    },

    async get(p: Principal, id: string) {
      const a = await db.sosAlert.findUnique({ where: { id } });
      if (a && !isStaff(p) && a.userId === p.userId) return { alert: ownSosView(a) };
      const alert = await responded(p, id);
      const notes = await db.sosNote.findMany({ where: { alertId: id }, orderBy: { createdAt: "asc" } });
      return { alert: sosView(alert, now()), notes: notes.map(noteView) };
    },

    /** The city queue: live alerts, unacknowledged first, oldest first. */
    async list(p: Principal, q: { cityId?: string; status: "active" | "resolved" | "all" }) {
      const where: Prisma.SosAlertWhereInput = {
        ...cityFilter(p, "sos:respond", q.cityId),
        ...(q.status === "active" ? { status: { in: ["OPEN", "ACKNOWLEDGED"] } } : q.status === "resolved" ? { status: "RESOLVED" } : {}),
      };
      const rows = await db.sosAlert.findMany({
        where, take: 200,
        orderBy: q.status === "active" ? [{ status: "asc" }, { triggeredAt: "asc" }] : [{ triggeredAt: "desc" }],
      });
      const at = now();
      return { alerts: rows.map((a) => sosView(a, at)) };
    },

    async acknowledge(p: Principal, id: string, note?: string) {
      const a = await responded(p, id);
      if (!canMoveSos(a.status, "ACKNOWLEDGED")) throw invalidTransition(a.status, "ACKNOWLEDGED");
      const at = now();
      const updated = await update(a, { status: "ACKNOWLEDGED", acknowledgedAt: at, acknowledgedBy: p.userId }, [
        { topic: "sos.acknowledged", key: id, payload: { alertId: id, cityId: a.cityId, tripId: a.tripId, userId: a.userId, byUserId: p.userId, acknowledgedAt: at.toISOString() } },
        audit({ actorId: p.userId, action: "sos:respond", resource: { type: "sos_alert", id }, outcome: "EXECUTED", reason: `acknowledged after ${Math.round((at.getTime() - a.triggeredAt.getTime()) / 1000)} s` }),
      ]);
      if (note) await db.sosNote.create({ data: { alertId: id, authorUserId: p.userId, body: note, createdAt: at } });
      realtime.toUser(a.userId, "support:sos", { alertId: id, status: "ACKNOWLEDGED" });
      return sosView(updated, now());
    },

    async note(p: Principal, id: string, body: string) {
      await responded(p, id);
      return noteView(await db.sosNote.create({ data: { alertId: id, authorUserId: p.userId, body, createdAt: now() } }));
    },

    /** Closing the alert is a safety decision: sos:respond and incident:manage (dispatchers only acknowledge). */
    async resolve(p: Principal, id: string, body: { outcome: SosOutcome; note: string; emergencyReference?: string }) {
      const a = await responded(p, id);
      authorize(p, "incident:manage", { cityId: a.cityId });
      if (!canMoveSos(a.status, "RESOLVED")) throw invalidTransition(a.status, "RESOLVED");
      const at = now();
      const updated = await update(a, {
        status: "RESOLVED", outcome: body.outcome, resolutionNote: body.note, emergencyReference: body.emergencyReference ?? null,
        resolvedAt: at, resolvedBy: p.userId, ...(a.acknowledgedAt ? {} : { acknowledgedAt: at, acknowledgedBy: p.userId }),
      }, [
        {
          topic: "sos.resolved", key: id,
          payload: compact({ alertId: id, cityId: a.cityId, tripId: a.tripId, userId: a.userId, outcome: body.outcome, byUserId: p.userId, resolvedAt: at.toISOString(), incidentId: a.incidentId ?? undefined }),
        },
        audit({ actorId: p.userId, action: "sos:respond", resource: { type: "sos_alert", id }, outcome: "EXECUTED", reason: `resolved ${body.outcome}: ${body.note}${body.emergencyReference ? ` (ref ${body.emergencyReference})` : ""}` }),
      ]);
      realtime.toUser(a.userId, "support:sos", { alertId: id, status: "RESOLVED" });
      return sosView(updated, now());
    },
  };
}

export type SosService = ReturnType<typeof createSosService>;
