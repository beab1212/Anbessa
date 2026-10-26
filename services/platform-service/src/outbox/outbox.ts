import { v7 as uuidv7 } from "uuid";
import type { Prisma } from "../generated/prisma/client.js";

// Events published by platform-service. Written in the caller's transaction, so an event exists
// exactly when its change committed. Live reloads go through Redis (`settings:changed`), not Kafka.

export interface AuditPayload {
  actorId: string | null;
  action: string;
  resource: { type: string; id: string };
  outcome: "ALLOWED" | "PENDING_APPROVAL" | "EXECUTED";
  reason?: string;
  service?: string;
}

export type PlatformEvent =
  | { topic: "platform.settings_changed"; key: string; payload: { version: number; keys: string[]; cityId: string | null; byUserId: string } }
  | { topic: "audit.recorded"; key: string; payload: AuditPayload };

export async function writeOutbox(tx: Prisma.TransactionClient, ...events: PlatformEvent[]): Promise<void> {
  if (events.length === 0) return;
  await tx.outbox.createMany({
    data: events.map((e) => ({
      topic: e.topic,
      key: e.key,
      payload: { eventId: uuidv7(), version: 1, at: new Date().toISOString(), ...e.payload } as Prisma.InputJsonValue,
    })),
  });
}

export const audit = (payload: AuditPayload): PlatformEvent => ({ topic: "audit.recorded", key: payload.actorId ?? "system", payload: { ...payload, service: "platform-service" } });
