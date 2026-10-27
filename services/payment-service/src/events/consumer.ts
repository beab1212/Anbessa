// Kafka in (group "payment-service"): trip.completed settles a trip, trip.cancelled settles a
// cancellation fee. The inbox makes a redelivered event a no-op. A handler error leaves the offset
// uncommitted so kafkajs retries; malformed events are logged and skipped, so one bad message
// can't block a partition.

import { Kafka, logLevel } from "kafkajs";
import { z, ZodError } from "zod";
import type { TripCancelledEvent, TripCompletedEvent } from "@ride-app/shared-types";
import type { Logger } from "@ride-app/shared-utils";
import type { Payments } from "../money/payments.js";

const id = z.string().uuid();
const method = z.enum(["CASH", "MOBILE_MONEY", "CARD", "CORPORATE"]);
const beneficiary = z.object({ type: z.enum(["INDIVIDUAL", "ORGANIZATION"]), id });
const minor = z.number().int().min(0);
/** A company-billed trip must name the company: settling it as cash would charge the driver
 *  commission on money they never collected. Such an event is invalid (logged and skipped). */
const corporateNamesOrg: [(e: { paymentMethod: string; billingOrgId?: string }) => boolean, { message: string; path: string[] }] = [
  (e) => e.paymentMethod !== "CORPORATE" || !!e.billingOrgId,
  { message: "CORPORATE payment without billingOrgId", path: ["billingOrgId"] },
];

export const schemas = {
  "trip.completed": z.object({
    eventId: z.string().min(1), version: z.number(), at: z.string(),
    tripId: id, riderId: id, driverId: id, cityId: z.string().min(1).max(40), vehicleType: z.string().min(1).max(30), vehicleId: z.string().min(1),
    beneficiary, paymentMethod: method, billingType: z.enum(["PERSONAL", "CORPORATE"]), billingOrgId: id.optional(),
    fareMinor: minor, waitingFeeMinor: minor, currency: z.string().length(3), distanceMeters: z.number(), durationSeconds: z.number(), completedAt: z.string(),
    quoteId: z.string().max(100).optional(), promoDiscountMinor: minor.optional(),
  }).refine(...corporateNamesOrg),
  "trip.cancelled": z.object({
    eventId: z.string().min(1), version: z.number(), at: z.string(),
    tripId: id, riderId: id, driverId: id.optional(), cityId: z.string().min(1).max(40), by: z.enum(["RIDER", "DRIVER", "SYSTEM", "STAFF"]),
    reason: z.string(), paymentMethod: method, feeMinor: minor, driverCompensationMinor: minor, beneficiary: beneficiary.optional(),
    currency: z.string().length(3), billingOrgId: id.optional(), quoteId: z.string().max(100).optional(),
  }).refine(...corporateNamesOrg),
};

export const TOPICS = Object.keys(schemas) as (keyof typeof schemas)[];

export function createHandlers(payments: Payments) {
  return {
    "trip.completed": async (raw: unknown) => payments.onTripCompleted(schemas["trip.completed"].parse(raw) as TripCompletedEvent),
    "trip.cancelled": async (raw: unknown) => payments.onTripCancelled(schemas["trip.cancelled"].parse(raw) as TripCancelledEvent),
  };
}

export function createConsumer(opts: { brokers: string[]; payments: Payments; logger: Logger; createTopics: boolean }) {
  const kafka = new Kafka({ clientId: "payment-service", brokers: opts.brokers, logLevel: logLevel.WARN });
  const consumer = kafka.consumer({ groupId: "payment-service" });
  const handlers = createHandlers(opts.payments);
  return {
    async start() {
      if (opts.createTopics) {
        const admin = kafka.admin();
        await admin.connect();
        const existing = new Set(await admin.listTopics());
        const missing = TOPICS.filter((t) => !existing.has(t));
        if (missing.length) await admin.createTopics({ topics: missing.map((topic) => ({ topic })), waitForLeaders: true });
        await admin.disconnect();
      }
      await consumer.connect();
      await consumer.subscribe({ topics: TOPICS });
      await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          try {
            await handlers[topic as keyof typeof handlers](JSON.parse(message.value?.toString() ?? ""));
          } catch (err) {
            if (err instanceof SyntaxError || err instanceof ZodError) {
              opts.logger.error({ topic, partition, offset: message.offset, err: err.message }, "skipping invalid event");
              return;
            }
            throw err; // database trouble: let kafkajs retry
          }
        },
      });
      opts.logger.info({ topics: TOPICS }, "consuming events");
    },
    stop: () => consumer.disconnect(),
  };
}
