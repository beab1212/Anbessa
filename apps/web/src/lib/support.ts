// support-service (/api/support): tickets, lost items, SOS alerts and incidents (workflows 13 and 14).
// Types mirror services/support-service/docs/api.md. Staff consoles poll: realtime-gateway only admits
// ride-app tokens, so the web can't receive socket pushes.

import { api } from "./api";

type Tone = "amber" | "blue" | "green" | "red" | "grey";

// ── enums ─────────────────────────────────────────────────────────────────────

export const TICKET_CATEGORIES = ["SAFETY", "PAYMENT", "TRIP", "LOST_ITEM", "ACCOUNT", "FEEDBACK"] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export const PRIORITIES = ["P1", "P2", "P3", "P4"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const TICKET_STATUSES = ["OPEN", "IN_PROGRESS", "WAITING_REQUESTER", "RESOLVED", "CLOSED"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketSource = "APP" | "PHONE" | "STAFF" | "SYSTEM";
export type RequesterKind = "RIDER" | "DRIVER" | "FLEET" | "CORPORATE";
export const RESOLUTIONS = ["NO_ACTION", "EXPLAINED", "REFUND", "ADJUSTMENT", "DRIVER_WARNING", "ESCALATE_SAFETY"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const LOST_ITEM_STATUSES = ["REPORTED", "FOUND", "NOT_FOUND", "RETURNED", "CLOSED"] as const;
export type LostItemStatus = (typeof LOST_ITEM_STATUSES)[number];

export type SosStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
export const SOS_OUTCOMES = ["FALSE_ALARM", "ASSISTED", "ESCALATED"] as const;
export type SosOutcome = (typeof SOS_OUTCOMES)[number];
export type SosRole = "RIDER" | "DRIVER";
export type SosSource = "APP" | "SYSTEM";

export const INCIDENT_CATEGORIES = ["HARASSMENT", "ASSAULT", "ACCIDENT", "DANGEROUS_DRIVING", "THEFT", "OTHER"] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];
export const INCIDENT_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export const INCIDENT_STATUSES = ["OPEN", "INVESTIGATING", "RESOLVED"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export type IncidentSource = "SOS" | "TICKET" | "MANUAL";
export const INCIDENT_OUTCOMES = ["CLEARED", "WARNING", "SUSPENDED_TEMPORARY", "REMOVED_PERMANENTLY"] as const;
export type IncidentOutcome = (typeof INCIDENT_OUTCOMES)[number];
export const INCIDENT_ACTION_KINDS = ["WARNING", "SUSPENDED", "BANNED", "REINSTATED", "PAIR_BLOCK"] as const;
export type IncidentActionKind = (typeof INCIDENT_ACTION_KINDS)[number];

// ── objects ───────────────────────────────────────────────────────────────────

export interface Ticket {
  id: string;
  ref: number;
  cityId: string;
  category: TicketCategory;
  priority: Priority;
  status: TicketStatus;
  source: TicketSource;
  subject: string;
  description: string;
  requester: { userId: string; kind: RequesterKind; orgId: string | null };
  createdByUserId: string;
  tripId: string | null;
  assigneeUserId: string | null;
  firstResponseDueAt: string;
  firstRespondedAt: string | null;
  overdue: boolean;
  resolution: Resolution | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  reopenCount: number;
  incidentId: string | null;
  lostItemId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TicketMessage {
  id: string;
  authorUserId: string | null;
  authorKind: "REQUESTER" | "STAFF" | "SYSTEM";
  internal: boolean;
  body: string;
  createdAt: string;
}

export interface TicketRefund {
  refundId: string;
  amountMinor: number | null;
  status: "REQUESTED" | "SUCCEEDED" | "FAILED";
  note: string | null;
  linkedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface LostItem {
  id: string;
  ticketId: string;
  tripId: string;
  cityId: string;
  description: string;
  status: LostItemStatus;
  driverNote: string | null;
  respondedAt: string | null;
  returnedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  riderUserId: string;
  driverUserId: string | null;
  fleetOrgId: string | null;
  driverNotFoundCount: number;
}

export interface LostItemMessage {
  id: string;
  authorKind: "RIDER" | "DRIVER" | "FLEET" | "STAFF";
  body: string;
  createdAt: string;
}

export interface SosAlert {
  id: string;
  cityId: string;
  tripId: string;
  userId: string;
  role: SosRole;
  source: SosSource;
  status: SosStatus;
  outcome: SosOutcome | null;
  location: { lat: number; lng: number; accuracy: number | null; at: string };
  triggeredAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  emergencyReference: string | null;
  incidentId: string | null;
  riderUserId: string | null;
  driverUserId: string | null;
  tripVerified: boolean;
  ackOverdue: boolean;
}

export interface Note {
  id: string;
  authorUserId: string;
  body: string;
  createdAt: string;
}

export interface Incident {
  id: string;
  ref: number;
  cityId: string;
  category: IncidentCategory;
  severity: IncidentSeverity;
  status: IncidentStatus;
  summary: string;
  tripId: string | null;
  subjectUserIds: string[];
  source: IncidentSource;
  ownerUserId: string | null;
  openedBy: string;
  outcome: IncidentOutcome | null;
  outcomeNote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentAction {
  id: string;
  userId: string;
  kind: IncidentActionKind;
  until: string | null;
  reference: string | null;
  note: string | null;
  recordedBy: string;
  createdAt: string;
}

export interface TicketDetail { ticket: Ticket; messages: TicketMessage[]; refunds: TicketRefund[]; lostItem: LostItem | null }
export interface LostItemDetail { lostItem: LostItem; messages: LostItemMessage[] }
export interface SosDetail { alert: SosAlert; notes: Note[] }
export interface IncidentDetail { incident: Incident; notes: Note[]; actions: IncidentAction[]; sosAlerts: SosAlert[]; tickets: Ticket[] }

// ── words and tones ───────────────────────────────────────────────────────────

export const CATEGORY_LABEL: Record<TicketCategory, string> = {
  SAFETY: "Safety", PAYMENT: "Payment", TRIP: "Trip", LOST_ITEM: "Lost item", ACCOUNT: "Account", FEEDBACK: "Feedback",
};
export const PRIORITY_TONE: Record<Priority, Tone> = { P1: "red", P2: "amber", P3: "blue", P4: "grey" };
export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  OPEN: "Open", IN_PROGRESS: "In progress", WAITING_REQUESTER: "Waiting for the person", RESOLVED: "Resolved", CLOSED: "Closed",
};
export const TICKET_STATUS_TONE: Record<TicketStatus, Tone> = { OPEN: "amber", IN_PROGRESS: "blue", WAITING_REQUESTER: "grey", RESOLVED: "green", CLOSED: "grey" };
export const SOURCE_LABEL: Record<TicketSource, string> = { APP: "in the app", PHONE: "by phone", STAFF: "by staff", SYSTEM: "automatic" };
export const REQUESTER_LABEL: Record<RequesterKind, string> = { RIDER: "Rider", DRIVER: "Driver", FLEET: "Fleet", CORPORATE: "Company" };
export const RESOLUTION_LABEL: Record<Resolution, string> = {
  NO_ACTION: "No action", EXPLAINED: "Explained", REFUND: "Refund", ADJUSTMENT: "Adjustment", DRIVER_WARNING: "Driver warned", ESCALATE_SAFETY: "Escalated to safety",
};
export const REFUND_STATUS_TONE: Record<TicketRefund["status"], Tone> = { REQUESTED: "amber", SUCCEEDED: "green", FAILED: "red" };

export const LOST_LABEL: Record<LostItemStatus, string> = { REPORTED: "Reported", FOUND: "Found", NOT_FOUND: "Not found", RETURNED: "Returned", CLOSED: "Closed" };
export const LOST_TONE: Record<LostItemStatus, Tone> = { REPORTED: "amber", FOUND: "blue", NOT_FOUND: "red", RETURNED: "green", CLOSED: "grey" };
/** Status changes support may make from each lost-item status (the service checks again). */
export const LOST_NEXT: Record<LostItemStatus, LostItemStatus[]> = {
  REPORTED: ["FOUND", "NOT_FOUND", "CLOSED"],
  FOUND: ["RETURNED", "CLOSED"],
  NOT_FOUND: ["FOUND", "CLOSED"],
  RETURNED: ["CLOSED"],
  CLOSED: [],
};

export const SOS_STATUS_LABEL: Record<SosStatus, string> = { OPEN: "Needs answer", ACKNOWLEDGED: "Acknowledged", RESOLVED: "Resolved" };
export const SOS_STATUS_TONE: Record<SosStatus, Tone> = { OPEN: "red", ACKNOWLEDGED: "amber", RESOLVED: "grey" };
export const SOS_OUTCOME_LABEL: Record<SosOutcome, string> = { FALSE_ALARM: "False alarm", ASSISTED: "Assisted", ESCALATED: "Escalated to emergency services" };

export const INCIDENT_CATEGORY_LABEL: Record<IncidentCategory, string> = {
  HARASSMENT: "Harassment", ASSAULT: "Assault", ACCIDENT: "Accident", DANGEROUS_DRIVING: "Dangerous driving", THEFT: "Theft", OTHER: "Other",
};
export const SEVERITY_TONE: Record<IncidentSeverity, Tone> = { LOW: "grey", MEDIUM: "blue", HIGH: "amber", CRITICAL: "red" };
export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = { OPEN: "Open", INVESTIGATING: "Investigating", RESOLVED: "Resolved" };
export const INCIDENT_STATUS_TONE: Record<IncidentStatus, Tone> = { OPEN: "amber", INVESTIGATING: "blue", RESOLVED: "green" };
export const INCIDENT_OUTCOME_LABEL: Record<IncidentOutcome, string> = {
  CLEARED: "Cleared", WARNING: "Warning", SUSPENDED_TEMPORARY: "Suspended for a time", REMOVED_PERMANENTLY: "Removed for good",
};
export const ACTION_LABEL: Record<IncidentActionKind, string> = {
  WARNING: "Warning", SUSPENDED: "Suspended", BANNED: "Banned", REINSTATED: "Reinstated", PAIR_BLOCK: "Never match this pair again",
};

export const words = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

// ── SLA display (workflow 13 §2) ─────────────────────────────────────────────

/** First-response SLA per category, in minutes (the service computes the real due time). */
export const SLA_MINUTES: Record<TicketCategory, number> = { SAFETY: 5, PAYMENT: 240, TRIP: 480, LOST_ITEM: 120, ACCOUNT: 1440, FEEDBACK: 4320 };
export const DEFAULT_PRIORITY: Record<TicketCategory, Priority> = { SAFETY: "P1", PAYMENT: "P2", TRIP: "P3", LOST_ITEM: "P2", ACCOUNT: "P3", FEEDBACK: "P4" };

export function minutesWords(min: number): string {
  if (min < 60) return `${min} min`;
  if (min < 1440 || min % 1440) return `${Math.round(min / 60)} h`;
  return `${min / 1440} d`;
}

/** "due in 12 min" / "overdue by 1 h 05" / "answered" for a ticket's first response. */
export function slaWords(t: Pick<Ticket, "firstResponseDueAt" | "firstRespondedAt" | "status">, now = Date.now()): { text: string; late: boolean } {
  if (t.firstRespondedAt) return { text: "answered", late: false };
  if (t.status === "RESOLVED" || t.status === "CLOSED") return { text: "—", late: false };
  const diff = Math.round((new Date(t.firstResponseDueAt).getTime() - now) / 60_000);
  const span = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`);
  return diff >= 0 ? { text: `due in ${span(diff)}`, late: false } : { text: `overdue by ${span(-diff)}`, late: true };
}

/** Seconds since `iso` (for the SOS "waiting" counter). */
export const secondsSince = (iso: string, now = Date.now()) => Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
export const waitingWords = (s: number) => (s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s` : `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`);

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== "" && v !== null && v !== undefined && v !== false) q.set(k, String(v));
  return q.toString();
}

// ── API ───────────────────────────────────────────────────────────────────────

const S = "/api/support";
const post = <T>(path: string, body: unknown = {}, idempotencyKey?: string) => api<T>("staff", `${S}${path}`, { method: "POST", body, idempotencyKey });
const patch = <T>(path: string, body: unknown) => api<T>("staff", `${S}${path}`, { method: "PATCH", body });
const get = <T>(path: string) => api<T>("staff", `${S}${path}`);

export interface TicketFilters {
  cityId?: string | null;
  status?: string;
  category?: string;
  priority?: string;
  assignee?: string;
  overdue?: boolean;
  q?: string;
  tripId?: string;
  requesterUserId?: string;
}

export const supportApi = {
  // tickets
  tickets: (f: TicketFilters, cursor?: string, limit = 50) => get<{ tickets: Ticket[]; next: string | null }>(`/tickets?${qs({ ...f, overdue: f.overdue ? "true" : "", cursor, limit })}`),
  ticket: (id: string) => get<TicketDetail>(`/tickets/${id}`),
  createTicket: (body: { requesterUserId: string; category: TicketCategory; subject: string; description: string; cityId?: string; tripId?: string; source?: "PHONE" | "STAFF"; priority?: Priority }, key?: string) =>
    post<{ ticket: Ticket }>("/tickets", body, key),
  updateTicket: (id: string, body: { priority?: Priority; category?: TicketCategory }) => patch<{ ticket: Ticket }>(`/tickets/${id}`, body),
  claim: (id: string) => post<{ ticket: Ticket }>(`/tickets/${id}/claim`),
  assign: (id: string, assigneeUserId: string | null) => post<{ ticket: Ticket }>(`/tickets/${id}/assign`, { assigneeUserId }),
  setStatus: (id: string, status: "OPEN" | "IN_PROGRESS" | "WAITING_REQUESTER" | "CLOSED", note?: string) => post<{ ticket: Ticket }>(`/tickets/${id}/status`, { status, ...(note ? { note } : {}) }),
  resolve: (id: string, resolution: Resolution, note: string) => post<{ ticket: Ticket }>(`/tickets/${id}/resolve`, { resolution, note }),
  reopen: (id: string, reason: string) => post<{ ticket: Ticket }>(`/tickets/${id}/reopen`, { reason }),
  message: (id: string, body: string, internal: boolean) => post<{ message: TicketMessage }>(`/tickets/${id}/messages`, { body, internal }),
  linkRefund: (id: string, body: { refundId: string; amountMinor?: number; note?: string }) => post<{ refund: TicketRefund }>(`/tickets/${id}/refunds`, body),

  // lost items
  lostItems: (f: { cityId?: string | null; status?: string; tripId?: string }, cursor?: string, limit = 50) => get<{ lostItems: LostItem[]; next: string | null }>(`/lost-items?${qs({ ...f, cursor, limit })}`),
  lostItem: (id: string) => get<LostItemDetail>(`/lost-items/${id}`),
  lostItemStatus: (id: string, status: LostItemStatus, note?: string) => post<{ lostItem: LostItem }>(`/lost-items/${id}/status`, { status, ...(note ? { note } : {}) }),
  lostItemMessage: (id: string, body: string) => post<{ message: LostItemMessage }>(`/lost-items/${id}/messages`, { body }),

  // SOS
  sosQueue: (cityId: string, status: "active" | "resolved" | "all" = "active") => get<{ alerts: SosAlert[] }>(`/sos?${qs({ cityId, status })}`),
  sos: (id: string) => get<SosDetail>(`/sos/${id}`),
  acknowledge: (id: string, note?: string) => post<{ alert: SosAlert }>(`/sos/${id}/acknowledge`, note ? { note } : {}),
  sosNote: (id: string, body: string) => post<{ note: Note }>(`/sos/${id}/notes`, { body }),
  resolveSos: (id: string, body: { outcome: SosOutcome; note: string; emergencyReference?: string }) => post<{ alert: SosAlert }>(`/sos/${id}/resolve`, body),

  // incidents
  incidents: (f: { cityId?: string | null; status?: string; severity?: string; category?: string }, cursor?: string, limit = 50) =>
    get<{ incidents: Incident[]; next: string | null }>(`/incidents?${qs({ ...f, cursor, limit })}`),
  incident: (id: string) => get<IncidentDetail>(`/incidents/${id}`),
  openIncident: (body: { category: IncidentCategory; severity: IncidentSeverity; summary: string; cityId?: string; tripId?: string; subjectUserIds?: string[]; sosAlertId?: string; ticketId?: string }, key?: string) =>
    post<{ incident: Incident }>("/incidents", body, key),
  updateIncident: (id: string, body: { severity?: IncidentSeverity; category?: IncidentCategory; summary?: string; status?: "OPEN" | "INVESTIGATING"; ownerUserId?: string | null }) =>
    patch<{ incident: Incident }>(`/incidents/${id}`, body),
  incidentNote: (id: string, body: string) => post<{ note: Note }>(`/incidents/${id}/notes`, { body }),
  incidentAction: (id: string, body: { userId: string; kind: IncidentActionKind; until?: string; reference?: string; note?: string }) => post<{ action: IncidentAction }>(`/incidents/${id}/actions`, body),
  resolveIncident: (id: string, outcome: IncidentOutcome, note: string) => post<{ incident: Incident }>(`/incidents/${id}/resolve`, { outcome, note }),
};
