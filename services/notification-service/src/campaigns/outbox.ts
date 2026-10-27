import { v7 as uuidv7 } from "uuid";
import type { Prisma } from "../generated/prisma/client.js";

// notification-service's transactional outbox (Database.md §8), used for audit.recorded on staff
// campaign actions. Written in the caller's transaction; published by relay.ts.

export interface AuditPayload {
  actorId: string | null;
  action: string;
  resource: { type: string; id: string };
  outcome: "ALLOWED" | "EXECUTED";
  reason?: string;
  service?: string;
}

export async function writeAudit(tx: Prisma.TransactionClient, ...entries: AuditPayload[]): Promise<void> {
  if (entries.length === 0) return;
  await tx.outbox.createMany({
    data: entries.map((a) => ({
      topic: "audit.recorded",
      key: a.actorId ?? "system",
      payload: { eventId: uuidv7(), version: 1, at: new Date().toISOString(), ...a, service: "notification-service" } as Prisma.InputJsonValue,
    })),
  });
}
