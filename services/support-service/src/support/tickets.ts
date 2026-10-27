// Tickets (workflow 13): created by the requester (app) or by staff on their behalf, routed to the
// city queue with an SLA, worked through a thread, resolved with a recorded decision. SAFETY tickets
// are P1 and open an incident at once. Refunds stay in payment-service; we keep the ids.

import { authorize, can, hasRole, type Principal } from "@ride-app/shared-authz";
import { Prisma, type Priority, type RequesterKind, type Resolution, type Ticket, type TicketCategory, type TicketStatus } from "../generated/prisma/client.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import type { TripFacts } from "../lib/trips.js";
import { audit, compact, writeOutbox, type SupportEvent } from "../outbox/outbox.js";
import { cityFilter, invalidTransition, isStaff, nextCursor, pageAfter, raced, type SupportDeps } from "./common.js";
import { insertIncident } from "./incidents.js";
import { CATEGORY_POLICY, canMoveTicket, canReopen, LIMITS, ticketSla } from "./policy.js";
import { lostItemView, messageView, refundView, requesterTicketView, ticketView } from "./views.js";

export interface NewTicket {
  cityId: string;
  category: TicketCategory;
  priority?: Priority;
  source: "APP" | "PHONE" | "STAFF" | "SYSTEM";
  subject: string;
  description: string;
  requesterUserId: string;
  requesterKind: RequesterKind;
  requesterOrgId: string | null;
  createdByUserId: string;
  tripId: string | null;
  at: Date;
}

/** Insert a ticket with its SLA and `ticket.created`; a SAFETY ticket also opens an incident. */
export async function insertTicket(tx: Prisma.TransactionClient, n: NewTicket): Promise<Ticket> {
  const sla = ticketSla(n.category, n.at, n.priority);
  let ticket = await tx.ticket.create({
    data: {
      cityId: n.cityId, category: n.category, priority: sla.priority, source: n.source, subject: n.subject, description: n.description,
      requesterUserId: n.requesterUserId, requesterKind: n.requesterKind, requesterOrgId: n.requesterOrgId, createdByUserId: n.createdByUserId,
      tripId: n.tripId, firstResponseDueAt: sla.firstResponseDueAt, createdAt: n.at, updatedAt: n.at,
    },
  });
  await writeOutbox(tx, {
    topic: "ticket.created",
    key: ticket.id,
    payload: compact({
      ticketId: ticket.id, ref: ticket.ref, cityId: ticket.cityId, category: ticket.category, priority: ticket.priority, source: ticket.source,
      requesterUserId: ticket.requesterUserId, tripId: ticket.tripId ?? undefined, firstResponseDueAt: ticket.firstResponseDueAt.toISOString(),
    }),
  });
  if (n.category === "SAFETY") ticket = await escalate(tx, ticket, null, n.at);
  return ticket;
}

/** Route a ticket to safety: an incident linked to it (once). */
async function escalate(tx: Prisma.TransactionClient, t: Ticket, byUserId: string | null, at: Date): Promise<Ticket> {
  if (t.incidentId) return t;
  const incident = await insertIncident(tx, {
    cityId: t.cityId, category: "OTHER", severity: "HIGH", summary: `Ticket #${t.ref}: ${t.subject}`, tripId: t.tripId,
    subjectUserIds: [t.requesterUserId], source: "TICKET", openedBy: byUserId, ticketId: t.id, at,
  });
  return tx.ticket.update({ where: { id: t.id }, data: { incidentId: incident.id } });
}

/**
 * The one way a ticket changes: a conditional update on (id, version), so two agents can't both win.
 * Also used by lost items and the sweep.
 */
export async function changeTicket(
  tx: Prisma.TransactionClient,
  t: Ticket,
  data: Prisma.TicketUncheckedUpdateManyInput,
  events: SupportEvent[] = [],
): Promise<Ticket> {
  const { count } = await tx.ticket.updateMany({ where: { id: t.id, version: t.version }, data: { ...data, version: { increment: 1 } } });
  if (count === 0) throw raced();
  await writeOutbox(tx, ...events);
  return tx.ticket.findUniqueOrThrow({ where: { id: t.id } });
}

/** Resolve inside a transaction (agents, the lost-item flow, the 72 h sweep). */
export async function resolveTicket(tx: Prisma.TransactionClient, t: Ticket, resolution: Resolution, note: string, byUserId: string | null, at: Date): Promise<Ticket> {
  if (!canMoveTicket(t.status, "RESOLVED")) throw invalidTransition(t.status, "RESOLVED");
  let updated = await changeTicket(tx, t, { status: "RESOLVED", resolution, resolutionNote: note, resolvedAt: at, resolvedBy: byUserId, waitingSince: null, updatedAt: at }, [
    {
      topic: "ticket.resolved", key: t.id,
      payload: compact({ ticketId: t.id, cityId: t.cityId, category: t.category, requesterUserId: t.requesterUserId, tripId: t.tripId ?? undefined, resolution, byUserId }),
    },
  ]);
  if (resolution === "ESCALATE_SAFETY") updated = await escalate(tx, updated, byUserId, at);
  return updated;
}

export interface TicketQuery {
  cityId?: string;
  status?: TicketStatus[];
  category?: TicketCategory;
  priority?: Priority;
  assignee?: string;
  overdue?: boolean;
  q?: string;
  tripId?: string;
  requesterUserId?: string;
  cursor?: string;
  limit: number;
}

const LIVE: TicketStatus[] = ["OPEN", "IN_PROGRESS", "WAITING_REQUESTER"];

export function createTicketService(deps: SupportDeps) {
  const { db, trips, realtime, now } = deps;
  const withLost = { lostItem: { select: { id: true } } } as const;

  async function load(id: string) {
    const t = await db.ticket.findUnique({ where: { id }, include: withLost });
    if (!t) throw notFound("ticket");
    return t;
  }

  /** Requester side: the requester themself, or their organisation's admins for org tickets. */
  const isRequesterSide = (p: Principal, t: Ticket) =>
    !isStaff(p) && (t.requesterUserId === p.userId || (!!t.requesterOrgId && can(p, "ticket:create", { orgId: t.requesterOrgId })));

  /** A ticket the caller may see, and how; 404 otherwise (never confirm someone else's ticket). */
  async function readable(p: Principal, id: string) {
    const t = await load(id);
    if (isStaff(p) && can(p, "ticket:read", { cityId: t.cityId })) return { t, staff: true as const };
    if (isRequesterSide(p, t)) return { t, staff: false as const };
    throw notFound("ticket");
  }

  /** Staff who may change the ticket (readable first, so others get 404, readers 403). */
  async function workable(p: Principal, id: string) {
    const { t, staff } = await readable(p, id);
    if (!staff) throw forbidden("missing permission ticket:update");
    authorize(p, "ticket:update", { cityId: t.cityId });
    return t;
  }

  const view = (t: Ticket & { lostItem?: { id: string } | null }, staff: boolean) => (staff ? ticketView(t, now()) : requesterTicketView(t));
  const reload = async (id: string, staff: boolean) => view(await load(id), staff);

  async function tripOf(tripId: string): Promise<TripFacts> {
    const trip = await trips.get(tripId);
    if (!trip) throw notFound("trip");
    return trip;
  }

  const staffAudit = (p: Principal, t: Ticket, reason: string, onBehalfOf?: string) =>
    audit({ actorId: p.userId, action: "ticket:update", resource: { type: "ticket", id: t.id }, outcome: "EXECUTED", reason, ...(onBehalfOf ? { onBehalfOf } : {}) });

  return {
    readable,

    async create(p: Principal, body: {
      category: TicketCategory; subject: string; description: string; tripId?: string; cityId?: string;
      requesterUserId?: string; source?: "PHONE" | "STAFF"; priority?: Priority; orgId?: string; as?: "RIDER" | "DRIVER";
    }) {
      const at = now();
      if (isStaff(p)) {
        // call center / support logging a ticket for someone (workflow 13 step 3)
        if (!body.requesterUserId) throw badRequest("requesterUserId is required when staff log a ticket");
        const trip = body.tripId ? await tripOf(body.tripId) : null;
        const cityId = trip?.cityId ?? body.cityId;
        if (!cityId) throw badRequest("cityId is required without a trip");
        authorize(p, "ticket:create", { cityId });
        const kind: RequesterKind = trip?.driverUserId === body.requesterUserId ? "DRIVER" : "RIDER";
        const t = await db.$transaction(async (tx) => {
          const ticket = await insertTicket(tx, {
            cityId, category: body.category, ...(body.priority ? { priority: body.priority } : {}), source: body.source ?? "PHONE",
            subject: body.subject, description: body.description, requesterUserId: body.requesterUserId!, requesterKind: kind, requesterOrgId: null,
            createdByUserId: p.userId, tripId: trip?.id ?? null, at,
          });
          await writeOutbox(tx, audit({ actorId: p.userId, action: "ticket:create", resource: { type: "ticket", id: ticket.id }, outcome: "EXECUTED", reason: `${body.category} for ${body.requesterUserId}`, onBehalfOf: body.requesterUserId }));
          return ticket;
        });
        return reload(t.id, true);
      }

      // the requester (rider, driver, fleet or company admin) about themself or their trip
      if (body.category === "LOST_ITEM") throw badRequest("report lost items with POST /api/support/lost-items", "use_lost_items");
      let kind: RequesterKind;
      if (body.orgId) {
        authorize(p, "ticket:create", { orgId: body.orgId });
        kind = p.roles.some((a) => a.role === "FLEET_OWNER" && a.orgId === body.orgId) ? "FLEET" : "CORPORATE";
      } else {
        authorize(p, "ticket:create", { ownerUserIds: [p.userId] });
        kind = "RIDER";
      }
      const trip = body.tripId ? await tripOf(body.tripId) : null;
      if (trip) {
        const party = body.orgId
          ? trip.billingOrgId === body.orgId || trip.fleetOrgId === body.orgId
          : [trip.riderUserId, trip.bookedByUserId, trip.driverUserId].includes(p.userId);
        if (!party) throw notFound("trip");
        if (!body.orgId && trip.driverUserId === p.userId) kind = "DRIVER";
      } else if (!body.orgId && (body.as === "DRIVER" || (!body.as && hasRole(p, "DRIVER") && !hasRole(p, "RIDER")))) {
        if (!hasRole(p, "DRIVER")) throw forbidden("not a driver");
        kind = "DRIVER";
      }
      const cityId = trip?.cityId ?? body.cityId;
      if (!cityId) throw badRequest("cityId is required without a trip");
      const t = await db.$transaction((tx) =>
        insertTicket(tx, {
          cityId, category: body.category, source: "APP", subject: body.subject, description: body.description,
          requesterUserId: p.userId, requesterKind: kind, requesterOrgId: body.orgId ?? null, createdByUserId: p.userId, tripId: trip?.id ?? null, at,
        }),
      );
      return reload(t.id, false);
    },

    async list(p: Principal, q: TicketQuery) {
      const at = now();
      const ref = q.q && /^#?\d{1,9}$/.test(q.q.trim()) ? Number(q.q.trim().replace("#", "")) : undefined;
      const where: Prisma.TicketWhereInput = {
        ...cityFilter(p, "ticket:read", q.cityId),
        ...(q.status?.length ? { status: { in: q.status } } : {}),
        ...(q.category ? { category: q.category } : {}),
        ...(q.priority ? { priority: q.priority } : {}),
        ...(q.assignee === "me" ? { assigneeUserId: p.userId } : q.assignee === "none" ? { assigneeUserId: null } : q.assignee ? { assigneeUserId: q.assignee } : {}),
        ...(q.tripId ? { tripId: q.tripId } : {}),
        ...(q.requesterUserId ? { requesterUserId: q.requesterUserId } : {}),
        AND: [
          ...(q.overdue ? [{ firstRespondedAt: null, firstResponseDueAt: { lt: at }, status: { in: LIVE } }] : []),
          ...(q.q ? [{ OR: [
            { subject: { contains: q.q, mode: "insensitive" as const } },
            { description: { contains: q.q, mode: "insensitive" as const } },
            ...(ref !== undefined ? [{ ref }] : []),
          ] }] : []),
          pageAfter(q.cursor, "createdAt"),
        ],
      };
      const rows = await db.ticket.findMany({ where, include: withLost, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: q.limit });
      return { tickets: rows.map((t) => ticketView(t, at)), next: nextCursor(rows, q.limit, (r) => r.createdAt) };
    },

    async mine(p: Principal, q: { cursor?: string; limit: number }) {
      const rows = await db.ticket.findMany({
        where: { requesterUserId: p.userId, ...pageAfter(q.cursor, "createdAt") }, include: withLost,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: q.limit,
      });
      return { tickets: rows.map((t) => requesterTicketView(t)), next: nextCursor(rows, q.limit, (r) => r.createdAt) };
    },

    async detail(p: Principal, id: string) {
      const { t, staff } = await readable(p, id);
      const messages = await db.ticketMessage.findMany({ where: { ticketId: id, ...(staff ? {} : { internal: false }) }, orderBy: { createdAt: "asc" } });
      if (!staff) return { ticket: requesterTicketView(t), messages: messages.map((m) => messageView(m, false)) };
      const [refunds, lost] = await Promise.all([
        db.ticketRefund.findMany({ where: { ticketId: id }, orderBy: { createdAt: "asc" } }),
        db.lostItem.findUnique({ where: { ticketId: id } }),
      ]);
      const notFoundCount = lost?.driverUserId
        ? await db.lostItem.count({ where: { driverUserId: lost.driverUserId, found: false, createdAt: { gt: new Date(now().getTime() - LIMITS.notFoundLookbackMs) } } })
        : 0;
      return {
        ticket: ticketView(t, now()), messages: messages.map((m) => messageView(m, true)), refunds: refunds.map(refundView),
        lostItem: lost ? lostItemView(lost, "STAFF", notFoundCount) : null,
      };
    },

    async message(p: Principal, id: string, body: { body: string; internal?: boolean }) {
      const { t, staff } = await readable(p, id);
      const at = now();
      if (t.status === "CLOSED") throw conflict("the ticket is closed", "ticket_closed");
      if (staff) {
        authorize(p, "ticket:update", { cityId: t.cityId });
        const internal = body.internal ?? false;
        const m = await db.$transaction(async (tx) => {
          const msg = await tx.ticketMessage.create({ data: { ticketId: id, authorUserId: p.userId, authorKind: "STAFF", internal, body: body.body, createdAt: at } });
          // the first public answer meets the first-response SLA
          if (!internal) await tx.ticket.updateMany({ where: { id, firstRespondedAt: null }, data: { firstRespondedAt: at } });
          await tx.ticket.update({ where: { id }, data: { updatedAt: at } });
          return msg;
        });
        if (!internal) realtime.toUser(t.requesterUserId, "support:ticket_message", { ticketId: id, ref: t.ref });
        return messageView(m, true);
      }
      if (t.status === "RESOLVED") throw conflict("the ticket is resolved; reopen it to reply", "ticket_resolved");
      const m = await db.$transaction(async (tx) => {
        const msg = await tx.ticketMessage.create({ data: { ticketId: id, authorUserId: p.userId, authorKind: "REQUESTER", internal: false, body: body.body, createdAt: at } });
        // a reply to "waiting for you" puts the ticket back in the agent's hands
        if (t.status === "WAITING_REQUESTER") await changeTicket(tx, t, { status: "IN_PROGRESS", waitingSince: null, updatedAt: at });
        else await tx.ticket.update({ where: { id }, data: { updatedAt: at } });
        return msg;
      });
      return messageView(m, false);
    },

    async claim(p: Principal, id: string) {
      const t = await workable(p, id);
      if (t.status === "RESOLVED" || t.status === "CLOSED") throw invalidTransition(t.status, "IN_PROGRESS");
      const at = now();
      await db.$transaction((tx) => changeTicket(tx, t, { assigneeUserId: p.userId, ...(t.status === "OPEN" ? { status: "IN_PROGRESS" } : {}), updatedAt: at }, [staffAudit(p, t, "claimed")]));
      return reload(id, true);
    },

    async assign(p: Principal, id: string, assigneeUserId: string | null) {
      const t = await workable(p, id);
      if (t.status === "CLOSED") throw conflict("the ticket is closed", "ticket_closed");
      const at = now();
      const status: TicketStatus | undefined = assigneeUserId && t.status === "OPEN" ? "IN_PROGRESS" : !assigneeUserId && t.status === "IN_PROGRESS" ? "OPEN" : undefined;
      await db.$transaction((tx) => changeTicket(tx, t, { assigneeUserId, ...(status ? { status } : {}), updatedAt: at }, [staffAudit(p, t, `assigned to ${assigneeUserId ?? "nobody"}`)]));
      return reload(id, true);
    },

    async setStatus(p: Principal, id: string, to: "OPEN" | "IN_PROGRESS" | "WAITING_REQUESTER" | "CLOSED", note?: string) {
      const t = await workable(p, id);
      // RESOLVED → OPEN/IN_PROGRESS is a reopen (window, counter); resolving needs a decision
      if (!canMoveTicket(t.status, to) || (t.status === "RESOLVED" && to !== "CLOSED")) throw invalidTransition(t.status, to);
      const at = now();
      await db.$transaction(async (tx) => {
        await changeTicket(tx, t, {
          status: to, updatedAt: at,
          waitingSince: to === "WAITING_REQUESTER" ? at : null,
          ...(to === "CLOSED" ? { closedAt: at } : {}),
        }, [
          ...(to === "CLOSED" ? [{ topic: "ticket.closed" as const, key: id, payload: { ticketId: id, cityId: t.cityId, requesterUserId: t.requesterUserId, automatic: false, byUserId: p.userId } }] : []),
          staffAudit(p, t, `${t.status} → ${to}${note ? `: ${note}` : ""}`),
        ]);
        if (note) await tx.ticketMessage.create({ data: { ticketId: id, authorUserId: p.userId, authorKind: "STAFF", internal: true, body: `${t.status} → ${to}: ${note}`, createdAt: at } });
      });
      return reload(id, true);
    },

    async resolve(p: Principal, id: string, body: { resolution: Resolution; note: string }) {
      const t = await workable(p, id);
      const at = now();
      await db.$transaction(async (tx) => {
        const updated = await resolveTicket(tx, t, body.resolution, body.note, p.userId, at);
        await writeOutbox(tx, staffAudit(p, updated, `resolved ${body.resolution}: ${body.note}`));
      });
      realtime.toUser(t.requesterUserId, "support:ticket_resolved", { ticketId: id, ref: t.ref, resolution: body.resolution });
      return reload(id, true);
    },

    async reopen(p: Principal, id: string, reason: string) {
      const { t, staff } = await readable(p, id);
      if (staff) authorize(p, "ticket:update", { cityId: t.cityId });
      const at = now();
      if (!canReopen(t, at)) {
        if (t.status === "RESOLVED") throw conflict(`tickets can be reopened within ${LIMITS.reopenWindowMs / 86_400_000} days of the resolution`, "reopen_window_closed");
        throw invalidTransition(t.status, "OPEN");
      }
      await db.$transaction(async (tx) => {
        await changeTicket(tx, t, {
          status: t.assigneeUserId ? "IN_PROGRESS" : "OPEN", reopenCount: { increment: 1 }, resolution: null, resolutionNote: null, resolvedAt: null, resolvedBy: null, updatedAt: at,
        }, staff ? [staffAudit(p, t, `reopened: ${reason}`)] : []);
        await tx.ticketMessage.create({
          data: { ticketId: id, authorUserId: p.userId, authorKind: staff ? "STAFF" : "REQUESTER", internal: staff, body: `Reopened: ${reason}`, createdAt: at },
        });
      });
      return reload(id, staff);
    },

    async patch(p: Principal, id: string, body: { priority?: Priority; category?: TicketCategory }) {
      const t = await workable(p, id);
      if (t.status === "CLOSED") throw conflict("the ticket is closed", "ticket_closed");
      const at = now();
      const category = body.category ?? t.category;
      const priority: Priority = category === "SAFETY" ? "P1" : (body.priority ?? (body.category ? CATEGORY_POLICY[category].priority : t.priority));
      // a new category moves the first-response deadline while nobody has answered yet
      const due = body.category && !t.firstRespondedAt ? ticketSla(category, t.createdAt).firstResponseDueAt : undefined;
      await db.$transaction(async (tx) => {
        const updated = await changeTicket(tx, t, { category, priority, ...(due ? { firstResponseDueAt: due } : {}), updatedAt: at }, [
          staffAudit(p, t, `category ${t.category} → ${category}, priority ${t.priority} → ${priority}`),
        ]);
        if (category === "SAFETY") await escalate(tx, updated, p.userId, at);
      });
      return reload(id, true);
    },

    async linkRefund(p: Principal, id: string, body: { refundId: string; amountMinor?: number; note?: string }) {
      const t = await workable(p, id);
      try {
        const r = await db.$transaction(async (tx) => {
          const row = await tx.ticketRefund.create({
            data: { ticketId: id, refundId: body.refundId, amountMinor: body.amountMinor === undefined ? null : BigInt(body.amountMinor), note: body.note ?? null, linkedByUserId: p.userId, createdAt: now(), updatedAt: now() },
          });
          await writeOutbox(tx, staffAudit(p, t, `linked refund ${body.refundId}`));
          return row;
        });
        return refundView(r);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw conflict("this refund is already linked to the ticket", "already_linked");
        throw err;
      }
    },

    /** refund.succeeded / refund.failed from payment-service: update linked refunds (idempotent). */
    async onRefundOutcome(refundId: string, status: "SUCCEEDED" | "FAILED") {
      const links = await db.ticketRefund.findMany({ where: { refundId, status: "REQUESTED" } });
      for (const link of links) {
        await db.$transaction(async (tx) => {
          const { count } = await tx.ticketRefund.updateMany({ where: { ticketId: link.ticketId, refundId, status: "REQUESTED" }, data: { status, updatedAt: now() } });
          if (count === 0) return;
          await tx.ticketMessage.create({
            data: { ticketId: link.ticketId, authorUserId: null, authorKind: "SYSTEM", internal: true, body: `Refund ${refundId} ${status === "SUCCEEDED" ? "succeeded" : "failed"}`, createdAt: now() },
          });
        });
      }
      return links.length;
    },

    /** Timers (hourly): no reply in 72 h → RESOLVED; RESOLVED for 7 days → CLOSED. */
    async sweep() {
      const at = now();
      let resolved = 0;
      let closed = 0;
      const waiting = await db.ticket.findMany({ where: { status: "WAITING_REQUESTER", waitingSince: { lt: new Date(at.getTime() - LIMITS.waitingTimeoutMs) } }, take: 500 });
      for (const t of waiting) {
        await db.$transaction((tx) => resolveTicket(tx, t, "NO_ACTION", "No reply from the requester in 72 hours", null, at)).then(() => resolved++, () => undefined);
      }
      const old = await db.ticket.findMany({ where: { status: "RESOLVED", resolvedAt: { lt: new Date(at.getTime() - LIMITS.autoCloseMs) } }, take: 500 });
      for (const t of old) {
        await db.$transaction((tx) =>
          changeTicket(tx, t, { status: "CLOSED", closedAt: at, updatedAt: at }, [
            { topic: "ticket.closed", key: t.id, payload: { ticketId: t.id, cityId: t.cityId, requesterUserId: t.requesterUserId, automatic: true, byUserId: null } },
          ]),
        ).then(() => closed++, () => undefined);
      }
      return { resolved, closed };
    },
  };
}

export type TicketService = ReturnType<typeof createTicketService>;
