import { v7 as uuidv7 } from "uuid";
import type {
  EventEnvelope, TripCancelledEvent, TripCompletedEvent, TripMatchedEvent, TripProgressEvent, TripRequestedEvent,
} from "@ride-app/shared-types";
import type { Prisma } from "../generated/prisma/client.js";

// Events published by trip-service (architecture §6). Written in the caller's transaction,
// so an event exists exactly when its state change committed.

type Body<T> = Omit<T, keyof EventEnvelope>;

export type TripEvent =
  | { topic: "trip.requested"; payload: Body<TripRequestedEvent> }
  | { topic: "trip.matched"; payload: Body<TripMatchedEvent> }
  | { topic: "trip.driver_en_route" | "trip.driver_arrived" | "trip.started"; payload: Body<TripProgressEvent> }
  | { topic: "trip.completed"; payload: Body<TripCompletedEvent> }
  | { topic: "trip.cancelled"; payload: Body<TripCancelledEvent> };

export async function writeOutbox(tx: Prisma.TransactionClient, event: TripEvent): Promise<void> {
  const payload = { eventId: uuidv7(), version: 1, at: new Date().toISOString(), ...event.payload };
  await tx.outbox.create({ data: { topic: event.topic, key: event.payload.tripId, payload: payload as Prisma.InputJsonValue } });
}
