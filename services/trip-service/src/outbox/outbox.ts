import { v7 as uuidv7 } from "uuid";
import type {
  CorporatePolicyUpdatedEvent, EventEnvelope, TripCancelledEvent, TripCompletedEvent, TripDispatchEscalatedEvent, TripMatchedEvent,
  TripProgressEvent, TripReassignedEvent, TripRequestedEvent, TripScheduleCancelledEvent, TripScheduledEvent, TripScheduleFailedEvent,
} from "@ride-app/shared-types";
import type { Prisma } from "../generated/prisma/client.js";

// Events published by trip-service (architecture §6). Written in the caller's transaction,
// so an event exists exactly when its state change committed.

type Body<T> = Omit<T, keyof EventEnvelope>;

/** What every service writes on `audit.recorded` (audit-service's schema in services/audit-service/src/store.ts). */
export interface AuditPayload {
  actorId: string | null;
  action: string;
  resource: { type: string; id: string };
  outcome: "ALLOWED" | "EXECUTED";
  reason?: string;
  onBehalfOf?: string;
}

export type TripEvent =
  | { topic: "trip.requested"; payload: Body<TripRequestedEvent> }
  | { topic: "trip.matched"; payload: Body<TripMatchedEvent> }
  | { topic: "trip.driver_en_route" | "trip.driver_arrived" | "trip.started"; payload: Body<TripProgressEvent> }
  | { topic: "trip.completed"; payload: Body<TripCompletedEvent> }
  | { topic: "trip.cancelled"; payload: Body<TripCancelledEvent> }
  | { topic: "trip.dispatch_escalated"; payload: Body<TripDispatchEscalatedEvent> }
  | { topic: "trip.reassigned"; payload: Body<TripReassignedEvent> };

/** Events keyed by something other than a trip id. */
export type OtherEvent =
  | { topic: "trip.scheduled"; payload: Body<TripScheduledEvent> }
  | { topic: "trip.schedule_cancelled"; payload: Body<TripScheduleCancelledEvent> }
  | { topic: "trip.schedule_failed"; payload: Body<TripScheduleFailedEvent> }
  | { topic: "corporate.policy_updated"; payload: Body<CorporatePolicyUpdatedEvent> }
  | { topic: "audit.recorded"; payload: AuditPayload };

function keyOf(event: TripEvent | OtherEvent): string {
  switch (event.topic) {
    case "trip.scheduled":
    case "trip.schedule_cancelled":
    case "trip.schedule_failed":
      return event.payload.scheduledTripId;
    case "corporate.policy_updated":
      return event.payload.orgId;
    case "audit.recorded":
      return event.payload.actorId ?? "system";
    default:
      return event.payload.tripId;
  }
}

export async function writeOutbox(tx: Prisma.TransactionClient, event: TripEvent | OtherEvent): Promise<void> {
  const body = event.topic === "audit.recorded" ? { ...event.payload, service: "trip-service" } : event.payload;
  const payload = { eventId: uuidv7(), version: 1, at: new Date().toISOString(), ...body };
  await tx.outbox.create({ data: { topic: event.topic, key: keyOf(event), payload: payload as Prisma.InputJsonValue } });
}

export const audit = (payload: AuditPayload): OtherEvent => ({ topic: "audit.recorded", payload });
