import { v7 as uuidv7 } from "uuid";
import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";

// Domain events published by auth-service (docs/design/Auth.md §13).
// Payloads carry ids and facts only, never PII or secrets (OTP codes never go here).
export type IdentityEvent =
  | { topic: "user.created"; key: string; payload: { userId: string; guest: boolean } }
  | { topic: "user.claimed"; key: string; payload: { userId: string } }
  | { topic: "user.suspended"; key: string; payload: { userId: string; until: string | null; byUserId: string } }
  | { topic: "user.reinstated"; key: string; payload: { userId: string; byUserId: string } }
  | { topic: "role.granted"; key: string; payload: { userId: string; role: string; orgId?: string; cityId?: string; byUserId: string | null } }
  | { topic: "role.revoked"; key: string; payload: { userId: string; role: string; orgId?: string; cityId?: string; byUserId: string | null } }
  | { topic: "org.created"; key: string; payload: { orgId: string; kind: string; cityId: string } }
  | { topic: "org.verified"; key: string; payload: { orgId: string; kind: string; cityId: string; byUserId: string } }
  | { topic: "org.suspended"; key: string; payload: { orgId: string; kind: string; byUserId: string } }
  | { topic: "org.member_invited"; key: string; payload: { invitationId: string; orgId: string; role: string; phoneNumber?: string } }
  | { topic: "audit.recorded"; key: string; payload: AuditPayload };

export interface AuditPayload {
  actorId: string | null;
  action: string;
  resource: { type: string; id: string };
  outcome: "ALLOWED" | "DENIED" | "PENDING_APPROVAL" | "EXECUTED";
  reason?: string;
  onBehalfOf?: string;
}

type TxClient = Prisma.TransactionClient | Db;

function envelope(e: IdentityEvent) {
  // eventId + version + at, as every consumer expects (architecture §8)
  return { eventId: uuidv7(), version: 1, at: new Date().toISOString(), ...e.payload };
}

/** Write events in the caller's transaction, so they commit atomically with the state change. */
export async function writeOutbox(tx: TxClient, ...events: IdentityEvent[]): Promise<void> {
  if (events.length === 0) return;
  await tx.outbox.createMany({
    data: events.map((e) => ({ topic: e.topic, key: e.key, payload: envelope(e) })),
  });
}

export const audit = (payload: AuditPayload): IdentityEvent => ({
  topic: "audit.recorded",
  key: payload.actorId ?? "system",
  payload,
});
