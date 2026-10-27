// Pure rules from workflows 13 and 14: priorities, SLAs, the ticket / lost-item / SOS / incident
// state machines and the time windows. No I/O, so the unit tests cover them directly.

export type TicketCategory = "SAFETY" | "PAYMENT" | "TRIP" | "LOST_ITEM" | "ACCOUNT" | "FEEDBACK";
export type Priority = "P1" | "P2" | "P3" | "P4";
export type TicketStatus = "OPEN" | "IN_PROGRESS" | "WAITING_REQUESTER" | "RESOLVED" | "CLOSED";
export type LostItemStatus = "REPORTED" | "FOUND" | "NOT_FOUND" | "RETURNED" | "CLOSED";
export type SosStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
export type IncidentStatus = "OPEN" | "INVESTIGATING" | "RESOLVED";

export const CATEGORIES: readonly TicketCategory[] = ["SAFETY", "PAYMENT", "TRIP", "LOST_ITEM", "ACCOUNT", "FEEDBACK"];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Workflow 13 §2: default priority and first-response SLA per category. */
export const CATEGORY_POLICY: Record<TicketCategory, { priority: Priority; firstResponseMs: number }> = {
  SAFETY: { priority: "P1", firstResponseMs: 5 * MIN },
  PAYMENT: { priority: "P2", firstResponseMs: 4 * HOUR },
  TRIP: { priority: "P3", firstResponseMs: 8 * HOUR },
  LOST_ITEM: { priority: "P2", firstResponseMs: 2 * HOUR },
  ACCOUNT: { priority: "P3", firstResponseMs: 24 * HOUR },
  FEEDBACK: { priority: "P4", firstResponseMs: 72 * HOUR },
};

/** Time limits (workflow 13 §6, workflow 14 §6). */
export const LIMITS = {
  reopenWindowMs: 7 * DAY,
  /** RESOLVED → CLOSED automatically after this */
  autoCloseMs: 7 * DAY,
  /** WAITING_REQUESTER with no reply → RESOLVED */
  waitingTimeoutMs: 72 * HOUR,
  lostItemReportWindowMs: 7 * DAY,
  /** a report nobody found is closed after this */
  lostItemNotFoundCloseMs: 48 * HOUR,
  sosAfterDropoffMs: 30 * MIN,
  /** a second SOS press within this window returns the same alert */
  sosDedupeMs: 2 * MIN,
  sosAckMs: 60_000,
  /** window for "repeat not-found reports against the same driver" */
  notFoundLookbackMs: 90 * DAY,
} as const;

/** The SLA a new ticket gets. SAFETY is always P1, whatever the caller asked for. */
export function ticketSla(category: TicketCategory, createdAt: Date, requested?: Priority): { priority: Priority; firstResponseDueAt: Date } {
  const policy = CATEGORY_POLICY[category];
  const priority = category === "SAFETY" ? "P1" : (requested ?? policy.priority);
  return { priority, firstResponseDueAt: new Date(createdAt.getTime() + policy.firstResponseMs) };
}

/** Overdue = no first staff response yet and the SLA time has passed, while the ticket is still open. */
export function isOverdue(t: { status: TicketStatus; firstRespondedAt: Date | null; firstResponseDueAt: Date }, now: Date): boolean {
  return t.firstRespondedAt === null && (t.status === "OPEN" || t.status === "IN_PROGRESS" || t.status === "WAITING_REQUESTER") && t.firstResponseDueAt.getTime() < now.getTime();
}

/** Ticket state machine (workflow 13 §5, simplified: approvals live in payment-service). RESOLVED → IN_PROGRESS/OPEN is a reopen. */
const TICKET_MOVES: Record<TicketStatus, readonly TicketStatus[]> = {
  OPEN: ["IN_PROGRESS", "WAITING_REQUESTER", "RESOLVED", "CLOSED"],
  IN_PROGRESS: ["OPEN", "WAITING_REQUESTER", "RESOLVED", "CLOSED"],
  WAITING_REQUESTER: ["IN_PROGRESS", "RESOLVED", "CLOSED"],
  RESOLVED: ["CLOSED", "IN_PROGRESS", "OPEN"],
  CLOSED: [],
};

export function canMoveTicket(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_MOVES[from].includes(to);
}

/** Statuses a ticket may come from to reach `to` (for the conditional update). */
export function ticketSourcesFor(to: TicketStatus): TicketStatus[] {
  return (Object.keys(TICKET_MOVES) as TicketStatus[]).filter((from) => TICKET_MOVES[from].includes(to));
}

/** Reopen only a RESOLVED ticket, within the window after it was resolved. */
export function canReopen(t: { status: TicketStatus; resolvedAt: Date | null }, now: Date): boolean {
  return t.status === "RESOLVED" && t.resolvedAt !== null && now.getTime() - t.resolvedAt.getTime() <= LIMITS.reopenWindowMs;
}

/** Lost item: the driver answers found / not found (and may find it later); staff or the rider confirm the return. */
const LOST_MOVES: Record<LostItemStatus, readonly LostItemStatus[]> = {
  REPORTED: ["FOUND", "NOT_FOUND", "CLOSED"],
  NOT_FOUND: ["FOUND", "CLOSED"],
  FOUND: ["RETURNED", "NOT_FOUND", "CLOSED"],
  RETURNED: ["CLOSED"],
  CLOSED: [],
};

export function canMoveLostItem(from: LostItemStatus, to: LostItemStatus): boolean {
  return LOST_MOVES[from].includes(to);
}

export function lostItemSourcesFor(to: LostItemStatus): LostItemStatus[] {
  return (Object.keys(LOST_MOVES) as LostItemStatus[]).filter((from) => LOST_MOVES[from].includes(to));
}

/** Lost items may be reported up to 7 days after the trip ended. */
export function lostItemReportable(trip: { status: string; completedAt: Date | null }, now: Date): boolean {
  return trip.status === "completed" && trip.completedAt !== null && now.getTime() - trip.completedAt.getTime() <= LIMITS.lostItemReportWindowMs;
}

const ACTIVE_TRIP = new Set(["matched", "en_route", "in_progress"]);

/** SOS is available on an active trip and for 30 minutes after drop-off (workflow 14 §2). */
export function sosAvailable(trip: { status: string; completedAt: Date | null }, now: Date): boolean {
  if (ACTIVE_TRIP.has(trip.status)) return true;
  return trip.status === "completed" && trip.completedAt !== null && now.getTime() - trip.completedAt.getTime() <= LIMITS.sosAfterDropoffMs;
}

export function sosAckOverdue(a: { status: SosStatus; triggeredAt: Date }, now: Date): boolean {
  return a.status === "OPEN" && now.getTime() - a.triggeredAt.getTime() > LIMITS.sosAckMs;
}

const SOS_MOVES: Record<SosStatus, readonly SosStatus[]> = {
  OPEN: ["ACKNOWLEDGED", "RESOLVED"],
  ACKNOWLEDGED: ["RESOLVED"],
  RESOLVED: [],
};

export function canMoveSos(from: SosStatus, to: SosStatus): boolean {
  return SOS_MOVES[from].includes(to);
}

const INCIDENT_MOVES: Record<IncidentStatus, readonly IncidentStatus[]> = {
  OPEN: ["INVESTIGATING", "RESOLVED"],
  INVESTIGATING: ["OPEN", "RESOLVED"],
  RESOLVED: [],
};

export function canMoveIncident(from: IncidentStatus, to: IncidentStatus): boolean {
  return INCIDENT_MOVES[from].includes(to);
}
