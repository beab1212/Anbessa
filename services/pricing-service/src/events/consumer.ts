// Kafka in (group "pricing-service"): trip-service's trip.completed redeems the trip's promo
// discount (promo.redeemed), trip.cancelled gives it back. Both are idempotent. Invalid messages are
// logged and skipped so one bad message can't block a partition; database errors are rethrown so
// kafkajs retries.
//
// trip-service sends `quoteId` on both events and `promoDiscountMinor` (the discount it actually
// applied) on trip.completed; the reservation is found by quote id. Events without a quote id
// (older ones) fall back to the rider's most recent BOOKED reservation in that city and vehicle type.

import { Kafka, logLevel } from "kafkajs";
import { z, ZodError } from "zod";
import type { Logger } from "@ride-app/shared-utils";
import type { PromoService } from "../promos/service.js";

export const TOPICS = ["trip.completed", "trip.cancelled"] as const;

const completed = z.object({
  tripId: z.string().uuid(), riderId: z.string().uuid(), cityId: z.string().min(1).max(40), vehicleType: z.string().min(1).max(30),
  fareMinor: z.number().int().min(0), currency: z.string().default("ETB"), completedAt: z.string().optional(),
  quoteId: z.string().max(100).optional(), promoDiscountMinor: z.number().int().min(0).optional(),
});
const cancelled = z.object({
  tripId: z.string().uuid(), riderId: z.string().uuid(), cityId: z.string().min(1).max(40), quoteId: z.string().max(100).optional(),
});

export function createConsumer(opts: { brokers: string[]; promos: PromoService; logger: Logger; createTopics: boolean }) {
  const kafka = new Kafka({ clientId: "pricing-service", brokers: opts.brokers, logLevel: logLevel.WARN });
  const consumer = kafka.consumer({ groupId: "pricing-service" });

  /** One message (also used by the tests). */
  async function handle(topic: string, value: string | undefined) {
    try {
      const raw = JSON.parse(value ?? "");
      if (topic === "trip.completed") {
        const r = await opts.promos.redeem(completed.parse(raw));
        if (r) opts.logger.info({ tripId: raw.tripId, ...r }, "promo redeemed");
      } else if (topic === "trip.cancelled") {
        await opts.promos.release(cancelled.parse(raw));
      }
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof ZodError) {
        opts.logger.error({ topic, err: err.message.slice(0, 300) }, "skipping invalid event");
        return;
      }
      throw err;
    }
  }

  return {
    handle,
    async start() {
      if (opts.createTopics) {
        const admin = kafka.admin();
        await admin.connect();
        const existing = await admin.listTopics();
        const missing = TOPICS.filter((t) => !existing.includes(t));
        if (missing.length) await admin.createTopics({ topics: missing.map((topic) => ({ topic })), waitForLeaders: true });
        await admin.disconnect();
      }
      await consumer.connect();
      await consumer.subscribe({ topics: [...TOPICS] });
      await consumer.run({ eachMessage: async ({ topic, message }) => handle(topic, message.value?.toString()) });
      opts.logger.info({ topics: TOPICS }, "consuming");
    },
    stop: () => consumer.disconnect(),
  };
}
