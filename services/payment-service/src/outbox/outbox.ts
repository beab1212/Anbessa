import { v7 as uuidv7 } from "uuid";
import type {
  BalanceAdjustedEvent, BalanceMoneyEvent, BalanceStateChangedEvent, BalanceWrittenOffEvent, EventEnvelope, IncentiveAwardedEvent, InvoiceEvent,
  PaymentActionRequiredEvent, PaymentOutcomeEvent, RefundOutcomeEvent, TripSettledEvent,
} from "@ride-app/shared-types";
import type { Prisma } from "../generated/prisma/client.js";

// Events published by payment-service (Payment.md, workflows 08–09; contracts in
// libs/shared-types). Written in the caller's transaction, so an event exists exactly when the
// money movement committed. Ids and amounts only: never payout destinations.

type Body<T> = Omit<T, keyof EventEnvelope>;

export interface AuditPayload {
  actorId: string | null;
  action: string;
  resource: { type: string; id: string };
  outcome: "ALLOWED" | "DENIED" | "EXECUTED";
  reason?: string;
  service?: string;
}

export type PaymentEvent =
  | { topic: "balance.state_changed"; key: string; payload: Body<BalanceStateChangedEvent> }
  | { topic: "balance.topped_up" | "balance.payment_due" | "payout.sent" | "payout.failed"; key: string; payload: Body<BalanceMoneyEvent> }
  | { topic: "payment.action_required"; key: string; payload: Body<PaymentActionRequiredEvent> }
  | { topic: "payment.captured" | "payment.failed"; key: string; payload: Body<PaymentOutcomeEvent> }
  | { topic: "trip.settled"; key: string; payload: Body<TripSettledEvent> }
  | { topic: "refund.succeeded" | "refund.failed"; key: string; payload: Body<RefundOutcomeEvent> }
  | { topic: "balance.adjusted"; key: string; payload: Body<BalanceAdjustedEvent> }
  | { topic: "balance.written_off"; key: string; payload: Body<BalanceWrittenOffEvent> }
  | { topic: "incentive.awarded"; key: string; payload: Body<IncentiveAwardedEvent> }
  | { topic: "invoice.issued" | "invoice.paid"; key: string; payload: Body<InvoiceEvent> }
  | { topic: "audit.recorded"; key: string; payload: AuditPayload };

/** Write events in the caller's transaction, so they commit atomically with the money movement. */
export async function writeOutbox(tx: Prisma.TransactionClient, ...events: PaymentEvent[]): Promise<void> {
  if (events.length === 0) return;
  await tx.outbox.createMany({
    data: events.map((e) => ({
      topic: e.topic,
      key: e.key,
      payload: { eventId: uuidv7(), version: 1, at: new Date().toISOString(), ...e.payload } as Prisma.InputJsonValue,
    })),
  });
}

export const audit = (payload: AuditPayload): PaymentEvent => ({ topic: "audit.recorded", key: payload.actorId ?? "system", payload: { ...payload, service: "payment-service" } });
