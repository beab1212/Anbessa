// Share my trip (workflow 06): the rider (or whoever booked) makes a link; anyone with it sees the
// trip's progress, the driver's first name, the car and its live position, without signing in.
// A link works while the trip is on and for 30 minutes after it ends, until the rider stops
// sharing. The token is the only secret: 128 random bits.

import { randomBytes } from "node:crypto";
import type { Principal } from "@ride-app/shared-authz";
import type { Db } from "../db.js";
import type { Trip } from "../generated/prisma/client.js";
import type { LocationClient } from "../lib/clients.js";
import { conflict, notFound } from "../lib/errors.js";
import type { PartiesService } from "./parties.js";
import { ACTIVE } from "./service.js";

/** how long a link outlives the trip */
export const AFTER_END_MS = 30 * 60_000;
/** an upper bound while the trip is still on; reading re-checks the trip itself */
const WHILE_ACTIVE_MS = 12 * 3600_000;
/** positions older than this aren't shown as live */
const POSITION_MAX_AGE_MS = 60_000;

const endedAt = (t: Trip) => t.completedAt ?? t.cancelledAt;
const isActive = (t: Trip) => (ACTIVE as readonly string[]).includes(t.status);

export function createShares(deps: { db: Db; parties: PartiesService; location: LocationClient; baseUrl: string; now: () => Date }) {
  const { db } = deps;
  const link = (token: string) => `${deps.baseUrl.replace(/\/$/, "")}/t/${token}`;

  async function sharable(p: Principal, tripId: string) {
    const t = await db.trip.findUnique({ where: { id: tripId } });
    // only the rider or the booker; anyone else gets the same 404 as a missing trip
    if (!t || (t.riderUserId !== p.userId && t.bookedByUserId !== p.userId)) throw notFound("trip");
    return t;
  }

  return {
    /** POST /api/trips/:id/share — one live link per person and trip; asking again returns it. */
    async create(p: Principal, tripId: string) {
      const t = await sharable(p, tripId);
      const now = deps.now();
      const end = endedAt(t);
      if (!isActive(t) && (!end || now.getTime() - end.getTime() > AFTER_END_MS)) throw conflict("the trip is over", "trip_ended");
      const existing = await db.tripShare.findFirst({ where: { tripId, createdByUserId: p.userId, revokedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" } });
      const row = existing ?? await db.tripShare.create({
        data: {
          token: randomBytes(16).toString("base64url"), tripId, createdByUserId: p.userId,
          expiresAt: new Date((end ? end.getTime() + AFTER_END_MS : now.getTime() + WHILE_ACTIVE_MS)),
        },
      });
      return { token: row.token, url: link(row.token), expiresAt: row.expiresAt.toISOString() };
    },

    /** DELETE /api/trips/:id/share — stop sharing: every link this person made for the trip dies. */
    async revoke(p: Principal, tripId: string) {
      await sharable(p, tripId);
      await db.tripShare.updateMany({ where: { tripId, createdByUserId: p.userId, revokedAt: null }, data: { revokedAt: deps.now() } });
    },

    /** GET /api/trips/shared/:token — the public view. Unknown, revoked and expired all read as 404. */
    async view(token: string) {
      const now = deps.now();
      const s = await db.tripShare.findUnique({ where: { token }, include: { trip: true } });
      if (!s || s.revokedAt || s.expiresAt <= now) throw notFound("share");
      const t = s.trip;
      const end = endedAt(t);
      if (end && now.getTime() - end.getTime() > AFTER_END_MS) throw notFound("share");
      const { driver, vehicle } = await deps.parties.forShare(t);
      let position: { lat: number; lng: number; heading: number | null; at: string } | null = null;
      if (t.driverUserId && isActive(t)) {
        const live = await deps.location.driver(t.driverUserId).catch(() => null);
        // only while the driver is on this trip, and only a recent fix
        if (live && live.tripId === t.id && !live.stale && live.lat !== undefined && live.lng !== undefined && live.at !== undefined && now.getTime() - live.at < POSITION_MAX_AGE_MS) {
          position = { lat: live.lat, lng: live.lng, heading: live.heading ?? null, at: new Date(live.at).toISOString() };
        }
      }
      return {
        status: t.status,
        pickup: { name: t.pickupAddress, lat: t.pickupLat, lng: t.pickupLng },
        dropoff: { name: t.dropoffAddress, lat: t.dropoffLat, lng: t.dropoffLng },
        driver, vehicle, position,
        routePolyline: t.routePolyline,
        times: { matchedAt: t.matchedAt, arrivedAt: t.arrivedAt, startedAt: t.startedAt, endedAt: end },
        estDurationSeconds: t.estDurationS,
        expiresAt: (end ? new Date(Math.min(s.expiresAt.getTime(), end.getTime() + AFTER_END_MS)) : s.expiresAt).toISOString(),
      };
    },
  };
}

export type SharesService = ReturnType<typeof createShares>;
