import { v7 as uuidv7 } from "uuid";
import type {
  IncidentOpenedEvent, IncidentResolvedEvent, LostItemReturnedEvent, SosAcknowledgedEvent, SosResolvedEvent, SosTriggeredEvent,
  TicketClosedEvent, TicketCreatedEvent, TicketResolvedEvent,
} from "@ride-app/shared-types";
import type { Prisma } from "../generated/prisma/client.js";

// Events published by support-service, written in the caller's transaction so an event exists
// exactly when its change committed. Payload types are in libs/shared-types (minus the envelope).

type Body<T> = Omit<T, "eventId" | "version" | "at">;

export interface AuditPayload {
  actorId: string | null;
  action: string;
  resource: { type: string; id: string };
  outcome: "ALLOWED" | "EXECUTED";
  reason?: string;
  onBehalfOf?: string;
  service?: string;
}

export type SupportEvent =
  | { topic: "ticket.created"; key: string; payload: Body<TicketCreatedEvent> }
  | { topic: "ticket.resolved"; key: string; payload: Body<TicketResolvedEvent> }
  | { topic: "ticket.closed"; key: string; payload: Body<TicketClosedEvent> }
  | { topic: "lost_item.returned"; key: string; payload: Body<LostItemReturnedEvent> }
  | { topic: "sos.triggered"; key: string; payload: Body<SosTriggeredEvent> }
  | { topic: "sos.acknowledged"; key: string; payload: Body<SosAcknowledgedEvent> }
  | { topic: "sos.resolved"; key: string; payload: Body<SosResolvedEvent> }
  | { topic: "incident.opened"; key: string; payload: Body<IncidentOpenedEvent> }
  | { topic: "incident.resolved"; key: string; payload: Body<IncidentResolvedEvent> }
  | { topic: "audit.recorded"; key: string; payload: AuditPayload };

export async function writeOutbox(tx: Prisma.TransactionClient, ...events: SupportEvent[]): Promise<void> {
  if (events.length === 0) return;
  await tx.outbox.createMany({
    data: events.map((e) => ({
      topic: e.topic,
      key: e.key,
      payload: { eventId: uuidv7(), version: 1, at: new Date().toISOString(), ...e.payload } as Prisma.InputJsonValue,
    })),
  });
}

export const audit = (payload: AuditPayload): SupportEvent => ({ topic: "audit.recorded", key: payload.actorId ?? "system", payload: { ...payload, service: "support-service" } });

/** Drop undefined fields (optional event fields are omitted, never null). */
export function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
