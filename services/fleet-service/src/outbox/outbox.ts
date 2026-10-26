import { v7 as uuidv7 } from "uuid";
import type { DriverOfflineEvent, DriverOnlineEvent, EventEnvelope } from "@ride-app/shared-types";
import type { Prisma } from "../generated/prisma/client.js";

// Events published by fleet-service (Role.md §15, workflows 02–04). Written in the caller's
// transaction, so an event exists exactly when its state change committed. Ids and facts only:
// never licence numbers or document contents.

type Body<T> = Omit<T, keyof EventEnvelope>;

export interface AuditPayload {
  actorId: string | null;
  action: string;
  resource: { type: string; id: string };
  outcome: "ALLOWED" | "DENIED" | "EXECUTED";
  reason?: string;
}

export type FleetEvent =
  | { topic: "driver.applied" | "driver.submitted"; key: string; payload: { driverId: string; cityId: string } }
  | { topic: "driver.activated" | "driver.reinstated"; key: string; payload: { driverId: string; cityId: string; byUserId: string } }
  | { topic: "driver.changes_requested" | "driver.suspended"; key: string; payload: { driverId: string; cityId: string; reason: string; byUserId: string | null } }
  | { topic: "vehicle.submitted"; key: string; payload: { vehicleId: string; cityId: string; ownerType: string } }
  | { topic: "vehicle.verified"; key: string; payload: { vehicleId: string; cityId: string; vehicleType: string; ownerType: string; ownerId: string; byUserId: string } }
  | { topic: "vehicle.rejected" | "vehicle.suspended" | "vehicle.retired"; key: string; payload: { vehicleId: string; cityId: string; reason: string; byUserId: string | null } }
  | { topic: "vehicle.driver_authorized" | "vehicle.driver_unauthorized"; key: string; payload: { vehicleId: string; driverId: string; orgId: string; byUserId: string } }
  | { topic: "document.expiring"; key: string; payload: { documentId: string; subjectType: string; subjectId: string; kind: string; expiresAt: string } }
  | { topic: "driver.online"; key: string; payload: Body<DriverOnlineEvent> }
  | { topic: "driver.offline"; key: string; payload: Body<DriverOfflineEvent> }
  | { topic: "audit.recorded"; key: string; payload: AuditPayload };

/** Write events in the caller's transaction, so they commit atomically with the state change. */
export async function writeOutbox(tx: Prisma.TransactionClient, ...events: FleetEvent[]): Promise<void> {
  if (events.length === 0) return;
  await tx.outbox.createMany({
    data: events.map((e) => ({
      topic: e.topic,
      key: e.key,
      payload: { eventId: uuidv7(), version: 1, at: new Date().toISOString(), ...e.payload } as Prisma.InputJsonValue,
    })),
  });
}

export const audit = (payload: AuditPayload): FleetEvent => ({ topic: "audit.recorded", key: payload.actorId ?? "system", payload });
