// What callers see. Staff get the full record; requesters (ride-app) never see staff user ids,
// internal notes, assignees or incident links. Lost items never carry phone numbers (none are stored).

import type {
  Incident, IncidentAction, IncidentNote, LostItem, LostItemMessage, SosAlert, SosNote, Ticket, TicketMessage, TicketRefund,
} from "../generated/prisma/client.js";
import { isOverdue, sosAckOverdue } from "./policy.js";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function ticketView(t: Ticket & { lostItem?: { id: string } | null }, now: Date) {
  return {
    id: t.id,
    ref: t.ref,
    cityId: t.cityId,
    category: t.category,
    priority: t.priority,
    status: t.status,
    source: t.source,
    subject: t.subject,
    description: t.description,
    requester: { userId: t.requesterUserId, kind: t.requesterKind, orgId: t.requesterOrgId },
    createdByUserId: t.createdByUserId,
    tripId: t.tripId,
    assigneeUserId: t.assigneeUserId,
    firstResponseDueAt: t.firstResponseDueAt.toISOString(),
    firstRespondedAt: iso(t.firstRespondedAt),
    overdue: isOverdue(t, now),
    resolution: t.resolution,
    resolutionNote: t.resolutionNote,
    resolvedAt: iso(t.resolvedAt),
    closedAt: iso(t.closedAt),
    reopenCount: t.reopenCount,
    incidentId: t.incidentId,
    lostItemId: t.lostItem?.id ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** The requester's view: their ticket, its status and the resolution, nothing about who works on it. */
export function requesterTicketView(t: Ticket & { lostItem?: { id: string } | null }) {
  return {
    id: t.id,
    ref: t.ref,
    cityId: t.cityId,
    category: t.category,
    status: t.status,
    subject: t.subject,
    description: t.description,
    tripId: t.tripId,
    resolution: t.resolution,
    resolutionNote: t.resolutionNote,
    resolvedAt: iso(t.resolvedAt),
    closedAt: iso(t.closedAt),
    lostItemId: t.lostItem?.id ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function messageView(m: TicketMessage, staff: boolean) {
  return {
    id: m.id,
    authorUserId: staff || m.authorKind === "REQUESTER" ? m.authorUserId : null,
    authorKind: m.authorKind,
    internal: m.internal,
    body: m.body,
    createdAt: m.createdAt.toISOString(),
  };
}

export function refundView(r: TicketRefund) {
  return {
    refundId: r.refundId,
    amountMinor: r.amountMinor === null ? null : Number(r.amountMinor),
    status: r.status,
    note: r.note,
    linkedByUserId: r.linkedByUserId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export type LostItemViewer = "RIDER" | "DRIVER" | "FLEET" | "STAFF";

export function lostItemView(l: LostItem, viewer: LostItemViewer, driverNotFoundCount = 0) {
  const base = {
    id: l.id,
    ticketId: l.ticketId,
    tripId: l.tripId,
    cityId: l.cityId,
    description: l.description,
    status: l.status,
    driverNote: l.driverNote,
    respondedAt: iso(l.respondedAt),
    returnedAt: iso(l.returnedAt),
    closedAt: iso(l.closedAt),
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
    viewerRole: viewer,
  };
  if (viewer !== "STAFF") return base;
  return { ...base, riderUserId: l.riderUserId, driverUserId: l.driverUserId, fleetOrgId: l.fleetOrgId, driverNotFoundCount };
}

export const lostItemMessageView = (m: LostItemMessage) => ({ id: m.id, authorKind: m.authorKind, body: m.body, createdAt: m.createdAt.toISOString() });

export function sosView(a: SosAlert, now: Date) {
  return {
    id: a.id,
    cityId: a.cityId,
    tripId: a.tripId,
    userId: a.userId,
    role: a.role,
    source: a.source,
    status: a.status,
    outcome: a.outcome,
    location: { lat: a.lat, lng: a.lng, accuracy: a.accuracy, at: a.locationAt.toISOString() },
    triggeredAt: a.triggeredAt.toISOString(),
    acknowledgedAt: iso(a.acknowledgedAt),
    acknowledgedBy: a.acknowledgedBy,
    resolvedAt: iso(a.resolvedAt),
    resolvedBy: a.resolvedBy,
    resolutionNote: a.resolutionNote,
    emergencyReference: a.emergencyReference,
    incidentId: a.incidentId,
    riderUserId: a.riderUserId,
    driverUserId: a.driverUserId,
    tripVerified: a.tripVerified,
    ackOverdue: sosAckOverdue(a, now),
  };
}

/** What the person who pressed SOS sees: that help is coming, not who handles it. */
export const ownSosView = (a: SosAlert) => ({
  id: a.id,
  tripId: a.tripId,
  status: a.status,
  outcome: a.outcome,
  triggeredAt: a.triggeredAt.toISOString(),
  acknowledgedAt: iso(a.acknowledgedAt),
  resolvedAt: iso(a.resolvedAt),
});

export const noteView = (n: SosNote | IncidentNote) => ({ id: n.id, authorUserId: n.authorUserId, body: n.body, createdAt: n.createdAt.toISOString() });

export function incidentView(i: Incident) {
  return {
    id: i.id,
    ref: i.ref,
    cityId: i.cityId,
    category: i.category,
    severity: i.severity,
    status: i.status,
    summary: i.summary,
    tripId: i.tripId,
    subjectUserIds: i.subjectUserIds,
    source: i.source,
    ownerUserId: i.ownerUserId,
    openedBy: i.openedBy,
    outcome: i.outcome,
    outcomeNote: i.outcomeNote,
    resolvedAt: iso(i.resolvedAt),
    resolvedBy: i.resolvedBy,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}

export const actionView = (a: IncidentAction) => ({
  id: a.id, userId: a.userId, kind: a.kind, until: iso(a.until), reference: a.reference, note: a.note, recordedBy: a.recordedBy, createdAt: a.createdAt.toISOString(),
});
