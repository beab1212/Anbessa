import { v7 as uuidv7 } from "uuid";
import type {
  FareRuleActivatedEvent, FareRuleScheduledEvent, PromoActivatedEvent, PromoExhaustedEvent, PromoRedeemedEvent, ZoneChangedEvent,
} from "@ride-app/shared-types";
import type { Prisma } from "../generated/prisma/client.js";

// Events published by pricing-service, written in the caller's transaction so an event exists
// exactly when its change committed. Payload types are in libs/shared-types (minus the envelope).

type Body<T> = Omit<T, "eventId" | "version" | "at">;

export interface AuditPayload {
  actorId: string | null;
  action: string;
  resource: { type: string; id: string };
  outcome: "ALLOWED" | "EXECUTED" | "PENDING_APPROVAL" | "REJECTED";
  reason?: string;
  service?: string;
}

export type PricingEvent =
  | { topic: "pricing.rule_scheduled"; key: string; payload: Body<FareRuleScheduledEvent> }
  | { topic: "pricing.rule_activated"; key: string; payload: Body<FareRuleActivatedEvent> }
  | { topic: "pricing.zone_changed"; key: string; payload: Body<ZoneChangedEvent> }
  | { topic: "promo.activated"; key: string; payload: Body<PromoActivatedEvent> }
  | { topic: "promo.redeemed"; key: string; payload: Body<PromoRedeemedEvent> }
  | { topic: "promo.exhausted"; key: string; payload: Body<PromoExhaustedEvent> }
  | { topic: "audit.recorded"; key: string; payload: AuditPayload };

export async function writeOutbox(tx: Prisma.TransactionClient, ...events: PricingEvent[]): Promise<void> {
  if (events.length === 0) return;
  await tx.outbox.createMany({
    data: events.map((e) => ({
      topic: e.topic,
      key: e.key,
      payload: { eventId: uuidv7(), version: 1, at: new Date().toISOString(), ...e.payload } as Prisma.InputJsonValue,
    })),
  });
}

export const audit = (payload: AuditPayload): PricingEvent => ({ topic: "audit.recorded", key: payload.actorId ?? "system", payload: { ...payload, service: "pricing-service" } });

/** Drop undefined fields (optional event fields are omitted, never null). */
export function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
