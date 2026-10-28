// Lost items (workflow 13 §3D): the rider reports within 7 days of the trip; the driver (or the
// fleet that owns the car) answers found / not found; the return is arranged in the item's thread
// and closed by staff or the rider. No phone numbers are stored or shown. Each report also opens a
// LOST_ITEM ticket (P2, 2 h SLA) so it sits in the city's support queue.

import { authorize, can, type Principal } from "@ride-app/shared-authz";
import { Prisma, type LostItem, type LostItemStatus } from "../generated/prisma/client.js";
import { conflict, forbidden, notFound } from "../lib/errors.js";
import { audit, compact, writeOutbox, type SupportEvent } from "../outbox/outbox.js";
import { cityFilter, invalidTransition, isStaff, nextCursor, pageAfter, raced, type SupportDeps } from "./common.js";
import { canMoveLostItem, LIMITS, lostItemReportable } from "./policy.js";
import { insertTicket, resolveTicket } from "./tickets.js";
import { lostItemMessageView, lostItemView, type LostItemViewer } from "./views.js";

export interface LostItemQuery {
  cityId?: string;
  status?: LostItemStatus;
  tripId?: string;
  cursor?: string;
  limit: number;
}

/** Organisations whose trips the caller may read (fleet owners). */
/** Fleets whose cars' reports this user may see. A role in an organisation that isn't verified
 *  yet (`pending`) never counts, whatever the matrix says. */
export const fleetOrgs = (p: Principal) =>
  p.roles.filter((a) => a.scope === "ORG" && a.orgId && !a.pending && can(p, "trip:read", { orgId: a.orgId })).map((a) => a.orgId!);

export function createLostItemService(deps: SupportDeps) {
  const { db, trips, realtime, now } = deps;

  function viewerOf(p: Principal, l: LostItem): LostItemViewer | null {
    if (isStaff(p)) return can(p, "lost_item:manage", { cityId: l.cityId }) ? "STAFF" : null;
    if (l.riderUserId === p.userId) return "RIDER";
    if (l.driverUserId === p.userId) return "DRIVER";
    if (l.fleetOrgId && can(p, "trip:read", { orgId: l.fleetOrgId })) return "FLEET";
    return null;
  }

  async function readable(p: Principal, id: string) {
    const l = await db.lostItem.findUnique({ where: { id } });
    const viewer = l ? viewerOf(p, l) : null;
    if (!l || !viewer) throw notFound("lost item");
    return { l, viewer };
  }

  const notFoundCount = (driverUserId: string | null) =>
    driverUserId
      ? db.lostItem.count({ where: { driverUserId, found: false, createdAt: { gt: new Date(now().getTime() - LIMITS.notFoundLookbackMs) } } })
      : Promise.resolve(0);

  async function view(l: LostItem, viewer: LostItemViewer) {
    return lostItemView(l, viewer, viewer === "STAFF" ? await notFoundCount(l.driverUserId) : 0);
  }

  /** Tell the other parties something changed (best effort, phone app only). */
  function notify(l: LostItem, except: string | null, payload: object) {
    for (const userId of [l.riderUserId, l.driverUserId]) if (userId && userId !== except) realtime.toUser(userId, "support:lost_item", { lostItemId: l.id, tripId: l.tripId, ...payload });
  }

  /** A status change: conditional on the version; RETURNED / CLOSED also resolve the ticket. */
  async function move(l: LostItem, to: LostItemStatus, byUserId: string, data: Prisma.LostItemUncheckedUpdateManyInput, extra: SupportEvent[] = [], note?: string) {
    if (!canMoveLostItem(l.status, to)) throw invalidTransition(l.status, to);
    const at = now();
    const updated = await db.$transaction(async (tx) => {
      const { count } = await tx.lostItem.updateMany({
        where: { id: l.id, version: l.version },
        data: {
          ...data, status: to, version: { increment: 1 }, updatedAt: at,
          ...(to === "RETURNED" ? { returnedAt: at } : {}), ...(to === "CLOSED" ? { closedAt: at } : {}),
        },
      });
      if (count === 0) throw raced();
      const events = [...extra];
      if (to === "RETURNED") {
        events.push({
          topic: "lost_item.returned", key: l.id,
          payload: compact({ lostItemId: l.id, ticketId: l.ticketId, tripId: l.tripId, cityId: l.cityId, riderUserId: l.riderUserId, driverUserId: l.driverUserId ?? undefined, byUserId }),
        });
      }
      await writeOutbox(tx, ...events);
      if (to === "RETURNED" || to === "CLOSED") {
        const ticket = await tx.ticket.findUniqueOrThrow({ where: { id: l.ticketId } });
        if (ticket.status !== "RESOLVED" && ticket.status !== "CLOSED") {
          await resolveTicket(tx, ticket, to === "RETURNED" ? "EXPLAINED" : "NO_ACTION", note ?? (to === "RETURNED" ? "Item returned" : "Lost-item report closed"), byUserId, at);
        }
      }
      return tx.lostItem.findUniqueOrThrow({ where: { id: l.id } });
    });
    notify(updated, byUserId, { status: to });
    return updated;
  }

  return {
    async report(p: Principal, body: { tripId: string; description: string }) {
      if (isStaff(p)) throw forbidden("riders report lost items from the app; staff log a LOST_ITEM ticket");
      authorize(p, "ticket:create", { ownerUserIds: [p.userId] });
      const trip = await trips.get(body.tripId);
      if (!trip || ![trip.riderUserId, trip.bookedByUserId].includes(p.userId)) throw notFound("trip");
      const at = now();
      if (!lostItemReportable(trip, at)) throw conflict("lost items can be reported within 7 days of a completed trip", "report_window_closed");
      try {
        const l = await db.$transaction(async (tx) => {
          const ticket = await insertTicket(tx, {
            cityId: trip.cityId, category: "LOST_ITEM", source: "APP", subject: "Lost item", description: body.description,
            requesterUserId: p.userId, requesterKind: "RIDER", requesterOrgId: null, createdByUserId: p.userId, tripId: trip.id, at,
          });
          return tx.lostItem.create({
            data: {
              ticketId: ticket.id, tripId: trip.id, cityId: trip.cityId, riderUserId: p.userId, driverUserId: trip.driverUserId,
              fleetOrgId: trip.fleetOrgId, description: body.description, createdAt: at, updatedAt: at,
            },
          });
        });
        notify(l, p.userId, { status: l.status });
        return view(l, "RIDER");
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw conflict("this trip already has an open lost-item report", "already_reported");
        throw err;
      }
    },

    /** The app: reports I made, reports about trips I drove, reports about my fleet's cars. */
    async mine(p: Principal, q: { cursor?: string; limit: number }) {
      const orgs = fleetOrgs(p);
      const rows = await db.lostItem.findMany({
        where: {
          AND: [
            { OR: [{ riderUserId: p.userId }, { driverUserId: p.userId }, ...(orgs.length ? [{ fleetOrgId: { in: orgs } }] : [])] },
            pageAfter(q.cursor, "createdAt"),
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: q.limit,
      });
      const items = await Promise.all(rows.map((l) => view(l, viewerOf(p, l) ?? "RIDER")));
      return { lostItems: items, next: nextCursor(rows, q.limit, (r) => r.createdAt) };
    },

    async list(p: Principal, q: LostItemQuery) {
      const rows = await db.lostItem.findMany({
        where: {
          ...cityFilter(p, "lost_item:manage", q.cityId),
          ...(q.status ? { status: q.status } : {}),
          ...(q.tripId ? { tripId: q.tripId } : {}),
          ...pageAfter(q.cursor, "createdAt"),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: q.limit,
      });
      return { lostItems: await Promise.all(rows.map((l) => view(l, "STAFF"))), next: nextCursor(rows, q.limit, (r) => r.createdAt) };
    },

    async get(p: Principal, id: string) {
      const { l, viewer } = await readable(p, id);
      // internal staff notes stay with staff
      const messages = await db.lostItemMessage.findMany({ where: { lostItemId: id, ...(viewer === "STAFF" ? {} : { internal: false }) }, orderBy: { createdAt: "asc" } });
      return { lostItem: await view(l, viewer), messages: messages.map(lostItemMessageView) };
    },

    /** The driver or their fleet answers: found / not found (a later "found" is allowed). */
    async respond(p: Principal, id: string, body: { found: boolean; note?: string }) {
      const { l, viewer } = await readable(p, id);
      if (viewer === "RIDER") throw forbidden("only the driver or their fleet answers");
      const to: LostItemStatus = body.found ? "FOUND" : "NOT_FOUND";
      const staff = viewer === "STAFF";
      // driverNote is the driver's (or fleet's) own words; a staff answer never replaces it and stays internal
      const updated = await move(l, to, p.userId, { found: body.found, ...(staff ? {} : { driverNote: body.note ?? null }), respondedAt: now() },
        staff ? [audit({ actorId: p.userId, action: "lost_item:manage", resource: { type: "lost_item", id }, outcome: "EXECUTED", reason: to })] : []);
      if (body.note) await db.lostItemMessage.create({ data: { lostItemId: id, authorUserId: p.userId, authorKind: viewer, internal: staff, body: body.note, createdAt: now() } });
      return view(updated, viewer);
    },

    async message(p: Principal, id: string, body: string) {
      const { l, viewer } = await readable(p, id);
      if (l.status === "CLOSED") throw conflict("the report is closed", "lost_item_closed");
      const m = await db.$transaction(async (tx) => {
        const msg = await tx.lostItemMessage.create({ data: { lostItemId: id, authorUserId: p.userId, authorKind: viewer, body, createdAt: now() } });
        await tx.lostItem.update({ where: { id }, data: { updatedAt: now() } });
        return msg;
      });
      notify(l, p.userId, { message: true });
      return lostItemMessageView(m);
    },

    /** Staff move it anywhere the rules allow; the rider may confirm the return.
     *  A staff note is internal (staff only, like a ticket's status-change note) unless `share: true`;
     *  it never replaces the driver's own note. */
    async setStatus(p: Principal, id: string, body: { status: LostItemStatus; note?: string; share?: boolean }) {
      const { l, viewer } = await readable(p, id);
      if (viewer !== "STAFF" && !(viewer === "RIDER" && body.status === "RETURNED")) throw forbidden("missing permission lost_item:manage");
      const internal = viewer === "STAFF" && body.share !== true;
      const data: Prisma.LostItemUncheckedUpdateManyInput =
        body.status === "FOUND" || body.status === "NOT_FOUND" ? { found: body.status === "FOUND", respondedAt: now() } : {};
      const extra = viewer === "STAFF" ? [audit({ actorId: p.userId, action: "lost_item:manage", resource: { type: "lost_item", id }, outcome: "EXECUTED", reason: `${l.status} → ${body.status}${body.note ? `: ${body.note}` : ""}` })] : [];
      // the ticket's resolution note is shown to the rider, so only a shared note goes there
      const updated = await move(l, body.status, p.userId, data, extra, internal ? undefined : body.note);
      if (body.note) await db.lostItemMessage.create({ data: { lostItemId: id, authorUserId: p.userId, authorKind: viewer, internal, body: body.note, createdAt: now() } });
      return view(updated, viewer);
    },

    /** Timer (hourly): a report still not found 48 h after it was made is closed. */
    async sweep() {
      const at = now();
      const stale = await db.lostItem.findMany({ where: { status: { in: ["REPORTED", "NOT_FOUND"] }, createdAt: { lt: new Date(at.getTime() - LIMITS.lostItemNotFoundCloseMs) } }, take: 500 });
      let closed = 0;
      for (const l of stale) {
        await db.$transaction(async (tx) => {
          const { count } = await tx.lostItem.updateMany({ where: { id: l.id, version: l.version }, data: { status: "CLOSED", closedAt: at, version: { increment: 1 }, updatedAt: at } });
          if (count === 0) return;
          const ticket = await tx.ticket.findUniqueOrThrow({ where: { id: l.ticketId } });
          if (ticket.status !== "RESOLVED" && ticket.status !== "CLOSED") await resolveTicket(tx, ticket, "NO_ACTION", "The item was not found within 48 hours", null, at);
          closed++;
        }).catch((err) => deps.logger.warn({ err, lostItemId: l.id }, "lost-item sweep failed for one report"));
      }
      return { closed };
    },
  };
}

export type LostItemService = ReturnType<typeof createLostItemService>;
