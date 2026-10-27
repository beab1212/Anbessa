// Incidents (workflow 14 §3C): opened from an SOS, a SAFETY ticket or by hand; investigated with
// notes; resolved with an outcome. Suspensions are carried out in auth-service (the web calls it)
// and recorded here as actions. Permission: incident:manage in the incident's city.

import { authorize, can, type Principal } from "@ride-app/shared-authz";
import type { IncidentCategory, IncidentOutcome, IncidentSeverity, IncidentStatus, IncidentActionKind, Prisma } from "../generated/prisma/client.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { audit, compact, writeOutbox } from "../outbox/outbox.js";
import { cityFilter, invalidTransition, isStaff, nextCursor, pageAfter, raced, unique, type SupportDeps } from "./common.js";
import { canMoveIncident } from "./policy.js";
import { actionView, incidentView, noteView, sosView, ticketView } from "./views.js";

export interface NewIncident {
  cityId: string;
  category: IncidentCategory;
  severity: IncidentSeverity;
  summary: string;
  tripId: string | null;
  subjectUserIds: string[];
  source: "SOS" | "TICKET" | "MANUAL";
  openedBy: string | null;
  sosAlertId?: string;
  ticketId?: string;
  at: Date;
}

/** Insert an incident and its `incident.opened` event (inside the caller's transaction). */
export async function insertIncident(tx: Prisma.TransactionClient, n: NewIncident) {
  const incident = await tx.incident.create({
    data: {
      cityId: n.cityId, category: n.category, severity: n.severity, summary: n.summary, tripId: n.tripId,
      subjectUserIds: n.subjectUserIds, source: n.source, openedBy: n.openedBy, createdAt: n.at, updatedAt: n.at,
    },
  });
  await writeOutbox(tx, {
    topic: "incident.opened",
    key: incident.id,
    payload: compact({
      incidentId: incident.id, ref: incident.ref, cityId: incident.cityId, category: incident.category, severity: incident.severity,
      source: incident.source, tripId: incident.tripId ?? undefined, subjectUserIds: incident.subjectUserIds,
      sosAlertId: n.sosAlertId, ticketId: n.ticketId, byUserId: n.openedBy,
    }),
  });
  return incident;
}

export interface IncidentQuery {
  cityId?: string;
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  category?: IncidentCategory;
  cursor?: string;
  limit: number;
}

export function createIncidentService(deps: SupportDeps) {
  const { db, now } = deps;

  /** An incident the caller may manage, else 404 (incident:manage is also the read permission). */
  async function managed(p: Principal, id: string) {
    const i = await db.incident.findUnique({ where: { id } });
    if (!i || !isStaff(p) || !can(p, "incident:manage", { cityId: i.cityId })) throw notFound("incident");
    return i;
  }

  async function update(i: { id: string; version: number }, data: Prisma.IncidentUpdateManyMutationInput, extra?: (tx: Prisma.TransactionClient) => Promise<void>) {
    return db.$transaction(async (tx) => {
      const { count } = await tx.incident.updateMany({ where: { id: i.id, version: i.version }, data: { ...data, version: { increment: 1 }, updatedAt: now() } });
      if (count === 0) throw raced();
      await extra?.(tx);
      return tx.incident.findUniqueOrThrow({ where: { id: i.id } });
    });
  }

  return {
    async open(p: Principal, body: { category: IncidentCategory; severity: IncidentSeverity; summary: string; cityId?: string; tripId?: string; subjectUserIds?: string[]; sosAlertId?: string; ticketId?: string }) {
      if (!isStaff(p)) throw notFound("incident");
      if (body.sosAlertId && body.ticketId) throw badRequest("open from an SOS alert or a ticket, not both");
      const at = now();
      const extraUsers = body.subjectUserIds ?? [];

      if (body.sosAlertId) {
        const alert = await db.sosAlert.findUnique({ where: { id: body.sosAlertId } });
        if (!alert || !(can(p, "incident:manage", { cityId: alert.cityId }) || can(p, "sos:respond", { cityId: alert.cityId }))) throw notFound("SOS alert");
        authorize(p, "incident:manage", { cityId: alert.cityId });
        if (alert.incidentId) throw conflict("this SOS alert already has an incident", "already_linked");
        return db.$transaction(async (tx) => {
          const incident = await insertIncident(tx, {
            cityId: alert.cityId, category: body.category, severity: body.severity, summary: body.summary, tripId: alert.tripId,
            subjectUserIds: unique([alert.riderUserId, alert.driverUserId, alert.userId, ...extraUsers]), source: "SOS", openedBy: p.userId, sosAlertId: alert.id, at,
          });
          const { count } = await tx.sosAlert.updateMany({ where: { id: alert.id, incidentId: null }, data: { incidentId: incident.id } });
          if (count === 0) throw conflict("this SOS alert already has an incident", "already_linked");
          await writeOutbox(tx, audit({ actorId: p.userId, action: "incident:manage", resource: { type: "incident", id: incident.id }, outcome: "EXECUTED", reason: `opened from SOS ${alert.id}` }));
          return incidentView(incident);
        });
      }

      if (body.ticketId) {
        const ticket = await db.ticket.findUnique({ where: { id: body.ticketId } });
        if (!ticket || !(can(p, "incident:manage", { cityId: ticket.cityId }) || can(p, "ticket:read", { cityId: ticket.cityId }))) throw notFound("ticket");
        authorize(p, "incident:manage", { cityId: ticket.cityId });
        if (ticket.incidentId) throw conflict("this ticket already has an incident", "already_linked");
        return db.$transaction(async (tx) => {
          const incident = await insertIncident(tx, {
            cityId: ticket.cityId, category: body.category, severity: body.severity, summary: body.summary, tripId: ticket.tripId,
            subjectUserIds: unique([ticket.requesterUserId, ...extraUsers]), source: "TICKET", openedBy: p.userId, ticketId: ticket.id, at,
          });
          const { count } = await tx.ticket.updateMany({ where: { id: ticket.id, incidentId: null }, data: { incidentId: incident.id, updatedAt: at } });
          if (count === 0) throw conflict("this ticket already has an incident", "already_linked");
          await writeOutbox(tx, audit({ actorId: p.userId, action: "incident:manage", resource: { type: "incident", id: incident.id }, outcome: "EXECUTED", reason: `opened from ticket #${ticket.ref}` }));
          return incidentView(incident);
        });
      }

      if (!body.cityId) throw badRequest("cityId is required for an incident opened by hand");
      authorize(p, "incident:manage", { cityId: body.cityId });
      return db.$transaction(async (tx) => {
        const incident = await insertIncident(tx, {
          cityId: body.cityId!, category: body.category, severity: body.severity, summary: body.summary, tripId: body.tripId ?? null,
          subjectUserIds: unique(extraUsers), source: "MANUAL", openedBy: p.userId, at,
        });
        await writeOutbox(tx, audit({ actorId: p.userId, action: "incident:manage", resource: { type: "incident", id: incident.id }, outcome: "EXECUTED", reason: "opened" }));
        return incidentView(incident);
      });
    },

    async list(p: Principal, q: IncidentQuery) {
      const where: Prisma.IncidentWhereInput = {
        ...cityFilter(p, "incident:manage", q.cityId),
        ...(q.status ? { status: q.status } : {}),
        ...(q.severity ? { severity: q.severity } : {}),
        ...(q.category ? { category: q.category } : {}),
        ...pageAfter(q.cursor, "createdAt"),
      };
      const rows = await db.incident.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: q.limit });
      return { incidents: rows.map(incidentView), next: nextCursor(rows, q.limit, (r) => r.createdAt) };
    },

    async get(p: Principal, id: string) {
      const i = await managed(p, id);
      const [notes, actions, sosAlerts, tickets] = await Promise.all([
        db.incidentNote.findMany({ where: { incidentId: id }, orderBy: { createdAt: "asc" } }),
        db.incidentAction.findMany({ where: { incidentId: id }, orderBy: { createdAt: "asc" } }),
        db.sosAlert.findMany({ where: { incidentId: id }, orderBy: { triggeredAt: "asc" } }),
        db.ticket.findMany({ where: { incidentId: id }, include: { lostItem: { select: { id: true } } }, orderBy: { createdAt: "asc" } }),
      ]);
      const at = now();
      return {
        incident: incidentView(i), notes: notes.map(noteView), actions: actions.map(actionView),
        sosAlerts: sosAlerts.map((a) => sosView(a, at)), tickets: tickets.map((t) => ticketView(t, at)),
      };
    },

    async patch(p: Principal, id: string, body: { severity?: IncidentSeverity; category?: IncidentCategory; summary?: string; status?: "OPEN" | "INVESTIGATING"; ownerUserId?: string | null }) {
      const i = await managed(p, id);
      if (i.status === "RESOLVED") throw conflict("the incident is resolved", "incident_resolved");
      if (body.status && body.status !== i.status && !canMoveIncident(i.status, body.status)) throw invalidTransition(i.status, body.status);
      const data = compact({ severity: body.severity, category: body.category, summary: body.summary, status: body.status, ownerUserId: body.ownerUserId });
      const changed = Object.entries(data).map(([k, v]) => `${k}=${v ?? "none"}`).join(", ");
      return incidentView(await update(i, data, (tx) => writeOutbox(tx, audit({ actorId: p.userId, action: "incident:manage", resource: { type: "incident", id }, outcome: "EXECUTED", reason: changed || "no change" }))));
    },

    async note(p: Principal, id: string, body: string) {
      await managed(p, id);
      const n = await db.$transaction(async (tx) => {
        const note = await tx.incidentNote.create({ data: { incidentId: id, authorUserId: p.userId, body, createdAt: now() } });
        await tx.incident.update({ where: { id }, data: { updatedAt: now() } });
        return note;
      });
      return noteView(n);
    },

    /** Record a decision carried out elsewhere (auth-service suspends; trip-service pair blocks later). */
    async action(p: Principal, id: string, body: { userId: string; kind: IncidentActionKind; until?: Date; reference?: string; note?: string }) {
      await managed(p, id);
      const a = await db.$transaction(async (tx) => {
        const row = await tx.incidentAction.create({
          data: { incidentId: id, userId: body.userId, kind: body.kind, until: body.until ?? null, reference: body.reference ?? null, note: body.note ?? null, recordedBy: p.userId, createdAt: now() },
        });
        const current = await tx.incident.findUniqueOrThrow({ where: { id } });
        if (!current.subjectUserIds.includes(body.userId)) await tx.incident.update({ where: { id }, data: { subjectUserIds: [...current.subjectUserIds, body.userId] } });
        await writeOutbox(tx, audit({
          actorId: p.userId, action: "incident:manage", resource: { type: "incident", id }, outcome: "EXECUTED",
          reason: `${body.kind} ${body.userId}${body.until ? ` until ${body.until.toISOString()}` : ""}${body.reference ? ` (${body.reference})` : ""}`,
        }));
        return row;
      });
      return actionView(a);
    },

    async resolve(p: Principal, id: string, body: { outcome: IncidentOutcome; note: string }) {
      const i = await managed(p, id);
      if (!canMoveIncident(i.status, "RESOLVED")) throw invalidTransition(i.status, "RESOLVED");
      const at = now();
      const updated = await update(i, { status: "RESOLVED", outcome: body.outcome, outcomeNote: body.note, resolvedAt: at, resolvedBy: p.userId }, async (tx) => {
        await writeOutbox(tx,
          { topic: "incident.resolved", key: id, payload: { incidentId: id, cityId: i.cityId, outcome: body.outcome, subjectUserIds: i.subjectUserIds, byUserId: p.userId } },
          audit({ actorId: p.userId, action: "incident:manage", resource: { type: "incident", id }, outcome: "EXECUTED", reason: `resolved ${body.outcome}: ${body.note}` }),
        );
      });
      return incidentView(updated);
    },
  };
}

export type IncidentService = ReturnType<typeof createIncidentService>;
